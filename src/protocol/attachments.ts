import {
  AcpRemoteAttachmentFrameType,
  type AcpRemoteAttachmentAckFrame,
  type AcpRemoteAttachmentUploadHeader,
} from "./types.js";

const ATTACHMENT_BINARY_MAGIC = "FREEATT1";
const ATTACHMENT_BINARY_MAGIC_BYTES = new TextEncoder().encode(
  ATTACHMENT_BINARY_MAGIC,
);
const HEADER_LENGTH_BYTES = 4;
const FREE_ATTACHMENT_URI_PREFIX = "free-attachment://";

export type DecodedAcpRemoteAttachmentUpload = {
  body: Uint8Array;
  header: AcpRemoteAttachmentUploadHeader;
};

export function createFreeAttachmentUri(input: {
  attachmentId: string;
  connectionId: string;
  hostId: string;
  messageId: string;
}): string {
  return `${FREE_ATTACHMENT_URI_PREFIX}${[
    input.hostId,
    input.connectionId,
    input.messageId,
    input.attachmentId,
  ].map(encodeURIComponent).join("/")}`;
}

export function parseFreeAttachmentUri(value: string):
  | {
      attachmentId: string;
      connectionId: string;
      hostId: string;
      messageId: string;
    }
  | undefined {
  if (!value.startsWith(FREE_ATTACHMENT_URI_PREFIX)) {
    return undefined;
  }
  const parts = value.slice(FREE_ATTACHMENT_URI_PREFIX.length).split("/");
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    return undefined;
  }
  try {
    const [hostId, connectionId, messageId, attachmentId] = parts.map(
      decodeURIComponent,
    );
    return { attachmentId, connectionId, hostId, messageId };
  } catch {
    return undefined;
  }
}

export function encodeAcpRemoteAttachmentUpload(
  header: AcpRemoteAttachmentUploadHeader,
  body: Uint8Array,
): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const bytes = new Uint8Array(
    ATTACHMENT_BINARY_MAGIC_BYTES.length +
      HEADER_LENGTH_BYTES +
      headerBytes.length +
      body.byteLength,
  );
  bytes.set(ATTACHMENT_BINARY_MAGIC_BYTES, 0);
  new DataView(bytes.buffer).setUint32(
    ATTACHMENT_BINARY_MAGIC_BYTES.length,
    headerBytes.length,
    false,
  );
  const headerOffset = ATTACHMENT_BINARY_MAGIC_BYTES.length + HEADER_LENGTH_BYTES;
  bytes.set(headerBytes, headerOffset);
  bytes.set(body, headerOffset + headerBytes.length);
  return bytes.buffer;
}

export function decodeAcpRemoteAttachmentUpload(
  data: unknown,
): DecodedAcpRemoteAttachmentUpload | undefined {
  const bytes = toUint8Array(data);
  if (!bytes) {
    return undefined;
  }
  if (bytes.byteLength < ATTACHMENT_BINARY_MAGIC_BYTES.length + HEADER_LENGTH_BYTES) {
    return undefined;
  }
  for (let index = 0; index < ATTACHMENT_BINARY_MAGIC_BYTES.length; index += 1) {
    if (bytes[index] !== ATTACHMENT_BINARY_MAGIC_BYTES[index]) {
      return undefined;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(ATTACHMENT_BINARY_MAGIC_BYTES.length, false);
  const headerOffset = ATTACHMENT_BINARY_MAGIC_BYTES.length + HEADER_LENGTH_BYTES;
  const bodyOffset = headerOffset + headerLength;
  if (headerLength <= 0 || bodyOffset > bytes.byteLength) {
    return undefined;
  }
  try {
    const rawHeader = new TextDecoder().decode(bytes.slice(headerOffset, bodyOffset));
    const header = JSON.parse(rawHeader) as unknown;
    const body = bytes.slice(bodyOffset);
    if (!isAcpRemoteAttachmentUploadHeader(header)) {
      return undefined;
    }
    if (body.byteLength !== header.size) {
      return undefined;
    }
    return { body, header };
  } catch {
    return undefined;
  }
}

export function isAcpRemoteAttachmentAckFrame(
  value: unknown,
): value is AcpRemoteAttachmentAckFrame {
  if (!isRecord(value)) {
    return false;
  }
  if (
    value.frameType !== AcpRemoteAttachmentFrameType.Ack ||
    value.version !== 1 ||
    typeof value.connectionId !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.ok !== "boolean"
  ) {
    return false;
  }
  if (value.ok) {
    return (
      typeof value.attachmentId === "string" &&
      typeof value.mimeType === "string" &&
      typeof value.sha256 === "string" &&
      typeof value.size === "number" &&
      Number.isSafeInteger(value.size) &&
      value.size >= 0 &&
      typeof value.uri === "string"
    );
  }
  return typeof value.error === "string";
}

function isAcpRemoteAttachmentUploadHeader(
  value: unknown,
): value is AcpRemoteAttachmentUploadHeader {
  return (
    isRecord(value) &&
    value.version === 1 &&
    value.kind === "attachment/upload" &&
    typeof value.accountId === "string" &&
    typeof value.attachmentId === "string" &&
    typeof value.connectionId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.hostId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.requestId === "string" &&
    typeof value.sha256 === "string" &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    typeof value.uri === "string"
  );
}

function toUint8Array(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
