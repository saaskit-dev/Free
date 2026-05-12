import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createFreeAttachmentUri,
  decodeAcpRemoteAttachmentUpload,
  encodeAcpRemoteAttachmentUpload,
  isAcpRemoteAttachmentAckFrame,
  parseFreeAttachmentUri,
} from "./attachments.js";
import { AcpRemoteAttachmentFrameType } from "./types.js";

describe("remote attachment protocol", () => {
  it("round-trips Free attachment URIs", () => {
    const uri = createFreeAttachmentUri({
      attachmentId: "att 1",
      connectionId: "conn/1",
      hostId: "host-1",
      messageId: "msg:1",
    });

    expect(uri).toBe("free-attachment://host-1/conn%2F1/msg%3A1/att%201");
    expect(parseFreeAttachmentUri(uri)).toEqual({
      attachmentId: "att 1",
      connectionId: "conn/1",
      hostId: "host-1",
      messageId: "msg:1",
    });
    expect(parseFreeAttachmentUri("https://example.test/image.png")).toBeUndefined();
  });

  it("encodes upload metadata separately from raw bytes", () => {
    const body = new TextEncoder().encode("image-bytes");
    const uri = createFreeAttachmentUri({
      attachmentId: "att-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
    });

    const encoded = encodeAcpRemoteAttachmentUpload(
      {
        accountId: "acct-1",
        attachmentId: "att-1",
        connectionId: "conn-1",
        createdAt: "2026-05-12T00:00:00.000Z",
        hostId: "host-1",
        kind: "attachment/upload",
        messageId: "msg-1",
        mimeType: "image/png",
        requestId: "request-1",
        sha256: sha256Hex(body),
        size: body.byteLength,
        uri,
        version: 1,
      },
      body,
    );

    const decoded = decodeAcpRemoteAttachmentUpload(encoded);
    expect(decoded?.header).toMatchObject({
      attachmentId: "att-1",
      connectionId: "conn-1",
      kind: "attachment/upload",
      uri,
    });
    expect(new TextDecoder().decode(decoded?.body)).toBe("image-bytes");
  });

  it("validates attachment ack frames", () => {
    expect(isAcpRemoteAttachmentAckFrame({
      attachmentId: "att-1",
      connectionId: "conn-1",
      frameType: AcpRemoteAttachmentFrameType.Ack,
      mimeType: "image/png",
      ok: true,
      requestId: "request-1",
      sha256: "a".repeat(64),
      size: 11,
      uri: "free-attachment://host-1/conn-1/msg-1/att-1",
      version: 1,
    })).toBe(true);

    expect(isAcpRemoteAttachmentAckFrame({
      connectionId: "conn-1",
      frameType: AcpRemoteAttachmentFrameType.Ack,
      ok: false,
      requestId: "request-1",
      error: "checksum mismatch",
      version: 1,
    })).toBe(true);
  });
});

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
