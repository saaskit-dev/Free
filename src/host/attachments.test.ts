import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFreeAttachmentUri } from "../protocol/index.js";
import { createAcpRemoteHostAttachmentStore } from "./attachments.js";

describe("createAcpRemoteHostAttachmentStore", () => {
  it("stores relay-uploaded images under the host-managed attachment tree", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "free-attachments-"));
    const store = createAcpRemoteHostAttachmentStore({ rootDir });
    const body = new TextEncoder().encode("image-bytes");
    const uri = createFreeAttachmentUri({
      attachmentId: "att-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
    });

    try {
      const record = await store.writeUpload({
        body,
        header: {
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
      });

      expect(record.contentPath).toBe(join(
        rootDir,
        "accounts",
        "acct-1",
        "hosts",
        "host-1",
        "connections",
        "conn-1",
        "messages",
        "msg-1",
        "attachments",
        "att-1",
        "content",
      ));
      expect(await readFile(record.contentPath, "utf8")).toBe("image-bytes");

      const image = await store.readImage(uri, {
        accountId: "acct-1",
        hostId: "host-1",
      });

      expect(image).toMatchObject({
        data: Buffer.from(body).toString("base64"),
        mimeType: "image/png",
      });
      expect(image.record.lastAccessedAt).toBeTruthy();
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("rejects uploads with mismatched checksums", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "free-attachments-"));
    const store = createAcpRemoteHostAttachmentStore({ rootDir });
    const body = new TextEncoder().encode("image-bytes");
    const uri = createFreeAttachmentUri({
      attachmentId: "att-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
    });

    try {
      await expect(store.writeUpload({
        body,
        header: {
          accountId: "acct-1",
          attachmentId: "att-1",
          connectionId: "conn-1",
          createdAt: "2026-05-12T00:00:00.000Z",
          hostId: "host-1",
          kind: "attachment/upload",
          messageId: "msg-1",
          mimeType: "image/png",
          requestId: "request-1",
          sha256: "0".repeat(64),
          size: body.byteLength,
          uri,
          version: 1,
        },
      })).rejects.toThrow("Attachment checksum mismatch.");
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
