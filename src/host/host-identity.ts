import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { platform } from "node:process";

import { emitFreeSuppressedError } from "../observability/logging.js";
import { resolveRuntimeHomePath } from "@saaskit-dev/acp-runtime";

export const ACP_REMOTE_HOST_IDENTITY_VERSION = 1 as const;

export type AcpRemoteHostIdentity = {
  createdAt: string;
  previousPublicKey?: string;
  privateKeyPkcs8: string;
  publicKey: string;
  updatedAt: string;
  version: typeof ACP_REMOTE_HOST_IDENTITY_VERSION;
};

export type AcpRemoteHostMachineIdentity = {
  hostId: string;
  identity: AcpRemoteHostIdentity;
  machine: string;
};

export type AcpRemoteHostIdentityRecord = {
  previousPublicKey?: string;
  publicKey: string;
};

export type AcpRemoteHostHostRegistrationRecord =
  AcpRemoteHostIdentityRecord & {
    accountId: string;
    hostId: string;
  };

type AcpRemoteHostPrivateKey = Awaited<
  ReturnType<typeof crypto.subtle.importKey>
>;

export async function createAcpRemoteHostIdentity(
  now: Date = new Date(),
): Promise<AcpRemoteHostIdentity> {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as {
    privateKey: AcpRemoteHostPrivateKey;
    publicKey: AcpRemoteHostPrivateKey;
  };
  const [privateKeyPkcs8, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    crypto.subtle.exportKey("raw", keyPair.publicKey),
  ]);
  const timestamp = now.toISOString();
  return {
    createdAt: timestamp,
    privateKeyPkcs8: bytesToBase64Url(new Uint8Array(privateKeyPkcs8)),
    publicKey: bytesToBase64Url(new Uint8Array(publicKey)),
    updatedAt: timestamp,
    version: ACP_REMOTE_HOST_IDENTITY_VERSION,
  };
}

export async function loadAcpRemoteHostIdentity(
  path: string,
): Promise<AcpRemoteHostIdentity | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return parseAcpRemoteHostIdentity(JSON.parse(raw));
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function loadOrCreateAcpRemoteHostIdentity(input: {
  now?: Date;
  path?: string;
  accountId: string;
  hostId: string;
}): Promise<AcpRemoteHostIdentity> {
  const path =
    input.path ??
    resolveAcpRemoteHostIdentityPath(input.accountId, input.hostId);
  const existing = await loadAcpRemoteHostIdentity(path);
  if (existing) {
    return existing;
  }
  const identity = await createAcpRemoteHostIdentity(input.now);
  await saveAcpRemoteHostIdentity(path, identity);
  return identity;
}

export async function rotateAcpRemoteHostIdentity(input: {
  now?: Date;
  path?: string;
  accountId: string;
  hostId: string;
}): Promise<AcpRemoteHostIdentity> {
  const path =
    input.path ??
    resolveAcpRemoteHostIdentityPath(input.accountId, input.hostId);
  const existing = await loadAcpRemoteHostIdentity(path);
  const next = await createAcpRemoteHostIdentity(input.now);
  const identity: AcpRemoteHostIdentity = {
    ...next,
    createdAt: existing?.createdAt ?? next.createdAt,
    previousPublicKey: existing?.publicKey,
  };
  await saveAcpRemoteHostIdentity(path, identity);
  return identity;
}

export async function saveAcpRemoteHostIdentity(
  path: string,
  identity: AcpRemoteHostIdentity,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
}

export async function loadOrCreateHostMachineIdentity(): Promise<AcpRemoteHostMachineIdentity> {
  const path = resolveRuntimeHomePath("host", "identity.json");
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (data.hostId) {
      const identity = parseAcpRemoteHostIdentity(data.identity);
      const machine = typeof data.machine === "string" && data.machine
        ? data.machine
        : hostname();
      return { hostId: data.hostId, identity, machine };
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      emitFreeSuppressedError({
        attributes: {
          "acp.remote.host.identity_path": path,
        },
        body: "Host machine identity could not be loaded; creating a new identity.",
        eventName: "acp.remote.host.identity.load.failed",
        exception: error,
      });
    }
  }

  const hostId = resolveStableHostId();
  const identity = await createAcpRemoteHostIdentity();
  const machine = hostname();
  const record: AcpRemoteHostMachineIdentity = { hostId, identity, machine };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

function resolveStableHostId(): string {
  const seed = readStableMachineSeed();
  const digest = createHash("sha256").update(seed).digest();
  const bytes = new Uint8Array(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function readStableMachineSeed(): string {
  if (process.env.FREE_HOST_MACHINE_ID?.trim()) {
    return `env:${process.env.FREE_HOST_MACHINE_ID.trim()}`;
  }
  if (platform === "darwin") {
    const value = runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const match = value.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match?.[1]) return `darwin:${match[1]}`;
  }
  if (platform === "linux") {
    const machineId = readFirstExistingFile(["/etc/machine-id", "/var/lib/dbus/machine-id"]);
    if (machineId) return `linux:${machineId}`;
  }
  if (platform === "win32") {
    const value = runCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    const match = value.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/);
    if (match?.[1]) return `win32:${match[1].trim()}`;
  }
  return `fallback:${hostname()}`;
}

function runCommand(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function readFirstExistingFile(paths: readonly string[]): string | undefined {
  for (const candidate of paths) {
    try {
      const value = readFileSync(candidate, "utf8").trim();
      if (value) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function createAcpRemoteHostIdentityRecord(
  identity: AcpRemoteHostIdentity,
): AcpRemoteHostIdentityRecord {
  return {
    previousPublicKey: identity.previousPublicKey,
    publicKey: identity.publicKey,
  };
}

export function createAcpRemoteHostHostRegistrationRecord(input: {
  accountId: string;
  hostId: string;
  identity: AcpRemoteHostIdentity;
}): AcpRemoteHostHostRegistrationRecord {
  return {
    accountId: input.accountId,
    hostId: input.hostId,
    ...createAcpRemoteHostIdentityRecord(input.identity),
  };
}

export function resolveAcpRemoteHostIdentityPath(
  accountId: string,
  hostId: string,
): string {
  return resolveRuntimeHomePath(
    "remote",
    "hosts",
    encodeURIComponent(accountId),
    `${encodeURIComponent(hostId)}.json`,
  );
}

export async function createAcpRemoteHostRegistrationHeaders(input: {
  now?: Date;
  nonce?: string;
  accountId: string;
  hostId: string;
  identity: AcpRemoteHostIdentity;
}): Promise<Record<string, string>> {
  const timestamp = String(input.now?.getTime() ?? Date.now());
  const nonce = input.nonce ?? crypto.randomUUID();
  const privateKey = await importAcpRemoteHostPrivateKey(
    input.identity.privateKeyPkcs8,
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    toArrayBuffer(
      new TextEncoder().encode(
        hostRegistrationPayload({
          accountId: input.accountId,
          hostId: input.hostId,
          nonce,
          timestamp,
        }),
      ),
    ),
  );
  return {
    "x-acp-account-id": input.accountId,
    "x-acp-host-public-key": input.identity.publicKey,
    "x-acp-host-nonce": nonce,
    "x-acp-host-signature": bytesToBase64Url(new Uint8Array(signature)),
    "x-acp-host-timestamp": timestamp,
    "x-acp-host-id": input.hostId,
  };
}

async function importAcpRemoteHostPrivateKey(
  privateKeyPkcs8: string,
): Promise<AcpRemoteHostPrivateKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64UrlToBytes(privateKeyPkcs8)),
    "Ed25519",
    false,
    ["sign"],
  );
}

function hostRegistrationPayload(input: {
  accountId: string;
  hostId: string;
  nonce: string;
  timestamp: string;
}): string {
  return [
    input.accountId,
    input.hostId,
    input.timestamp,
    input.nonce,
  ].join("\n");
}

function parseAcpRemoteHostIdentity(
  value: unknown,
): AcpRemoteHostIdentity {
  if (!isRecord(value)) {
    throw new Error("ACP remote host identity must be an object.");
  }
  if (value.version !== ACP_REMOTE_HOST_IDENTITY_VERSION) {
    throw new Error("Unsupported ACP remote host identity version.");
  }
  if (
    typeof value.createdAt !== "string" ||
    typeof value.privateKeyPkcs8 !== "string" ||
    typeof value.publicKey !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("ACP remote host identity is malformed.");
  }
  return {
    createdAt: value.createdAt,
    previousPublicKey:
      typeof value.previousPublicKey === "string"
        ? value.previousPublicKey
        : undefined,
    privateKeyPkcs8: value.privateKeyPkcs8,
    publicKey: value.publicKey,
    updatedAt: value.updatedAt,
    version: ACP_REMOTE_HOST_IDENTITY_VERSION,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return new Uint8Array(Buffer.from(padded, "base64"));
}
