import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  createFreeAttachmentUri,
  parseFreeAttachmentUri,
  type AcpRemoteAttachmentUploadHeader,
} from "../protocol/index.js";

export type AcpRemoteHostAttachmentRecord = {
  accountId: string;
  attachmentId: string;
  connectionId: string;
  contentPath: string;
  createdAt: string;
  hostId: string;
  lastAccessedAt?: string;
  messageId: string;
  mimeType: string;
  sha256: string;
  size: number;
  source: "relay-upload";
  uri: string;
  version: 1;
};

export type AcpRemoteHostAttachmentStore = {
  readImage(uri: string, scope: {
    accountId: string;
    hostId: string;
  }): Promise<{ data: string; mimeType: string; record: AcpRemoteHostAttachmentRecord }>;
  writeUpload(input: {
    body: Uint8Array;
    header: AcpRemoteAttachmentUploadHeader;
  }): Promise<AcpRemoteHostAttachmentRecord>;
};

export function createAcpRemoteHostAttachmentStore(input: {
  rootDir?: string;
} = {}): AcpRemoteHostAttachmentStore {
  const rootDir = input.rootDir ?? defaultAcpRemoteHostAttachmentRootDir();

  const recordPath = (record: {
    accountId: string;
    attachmentId: string;
    connectionId: string;
    hostId: string;
    messageId: string;
  }) =>
    join(
      rootDir,
      "accounts",
      safePathSegment(record.accountId),
      "hosts",
      safePathSegment(record.hostId),
      "connections",
      safePathSegment(record.connectionId),
      "messages",
      safePathSegment(record.messageId),
      "attachments",
      safePathSegment(record.attachmentId),
      "manifest.json",
    );

  return {
    async writeUpload({ body, header }) {
      if (!header.mimeType.startsWith("image/")) {
        throw new Error("Only image attachments are supported.");
      }
      const sha256 = sha256Hex(body);
      if (sha256 !== header.sha256) {
        throw new Error("Attachment checksum mismatch.");
      }
      const manifestPath = recordPath(header);
      const attachmentDir = dirname(manifestPath);
      const contentPath = join(attachmentDir, "content");
      await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
      const tempPath = join(attachmentDir, `.content.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tempPath, body, { mode: 0o600 });
      await rename(tempPath, contentPath);
      const record: AcpRemoteHostAttachmentRecord = {
        accountId: header.accountId,
        attachmentId: header.attachmentId,
        connectionId: header.connectionId,
        contentPath,
        createdAt: header.createdAt,
        hostId: header.hostId,
        messageId: header.messageId,
        mimeType: header.mimeType,
        sha256,
        size: body.byteLength,
        source: "relay-upload",
        uri: header.uri,
        version: 1,
      };
      await writeFile(manifestPath, `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
      return record;
    },
    async readImage(uri, scope) {
      const ref = parseFreeAttachmentUri(uri);
      if (!ref) {
        throw new Error("Invalid Free attachment URI.");
      }
      if (ref.hostId !== scope.hostId) {
        throw new Error("Attachment host mismatch.");
      }
      const manifestPath = recordPath({
        accountId: scope.accountId,
        attachmentId: ref.attachmentId,
        connectionId: ref.connectionId,
        hostId: ref.hostId,
        messageId: ref.messageId,
      });
      const record = readAttachmentRecord(await readFile(manifestPath, "utf8"));
      if (!record || record.uri !== uri || record.accountId !== scope.accountId) {
        throw new Error("Attachment manifest is invalid.");
      }
      const content = await readFile(record.contentPath);
      const sha256 = sha256Hex(content);
      if (sha256 !== record.sha256) {
        throw new Error("Attachment checksum mismatch.");
      }
      const accessed: AcpRemoteHostAttachmentRecord = {
        ...record,
        lastAccessedAt: new Date().toISOString(),
      };
      await writeFile(manifestPath, `${JSON.stringify(accessed, null, 2)}\n`, {
        mode: 0o600,
      });
      return {
        data: content.toString("base64"),
        mimeType: record.mimeType,
        record: accessed,
      };
    },
  };
}

export function defaultAcpRemoteHostAttachmentRootDir(): string {
  return join(homedir(), ".free", "attachments");
}

export function createAcpRemoteHostAttachmentUri(input: {
  attachmentId: string;
  connectionId: string;
  hostId: string;
  messageId: string;
}): string {
  return createFreeAttachmentUri(input);
}

function readAttachmentRecord(
  value: string,
): AcpRemoteHostAttachmentRecord | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) {
      return undefined;
    }
    if (
      parsed.version !== 1 ||
      parsed.source !== "relay-upload" ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.attachmentId !== "string" ||
      typeof parsed.connectionId !== "string" ||
      typeof parsed.contentPath !== "string" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.hostId !== "string" ||
      typeof parsed.messageId !== "string" ||
      typeof parsed.mimeType !== "string" ||
      typeof parsed.sha256 !== "string" ||
      typeof parsed.size !== "number" ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size < 0 ||
      typeof parsed.uri !== "string"
    ) {
      return undefined;
    }
    return parsed as AcpRemoteHostAttachmentRecord;
  } catch {
    return undefined;
  }
}

function safePathSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return normalized.length > 0 ? normalized : "unknown";
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
