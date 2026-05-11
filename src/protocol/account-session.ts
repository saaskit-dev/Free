import type { AcpRemoteId } from "./types.js";

type AcpRemoteCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export const ACP_REMOTE_ACCOUNT_SESSION_ALGORITHM = "Ed25519" as const;

export type AcpRemoteAccountSessionPrincipalType = "client" | "host";

export type AcpRemoteAccountSession = {
  accountId: AcpRemoteId;
  alg: typeof ACP_REMOTE_ACCOUNT_SESSION_ALGORITHM;
  expiresAt: string;
  issuedAt: string;
  kid: string;
  principalId: AcpRemoteId;
  principalType: AcpRemoteAccountSessionPrincipalType;
  publicKey: string;
  sessionId: AcpRemoteId;
  signature: string;
};

export type AcpRemoteAccountSessionSigningKey = {
  kid: string;
  privateKey: AcpRemoteCryptoKey | string;
};

export type AcpRemoteAccountSessionVerificationKey = {
  kid: string;
  publicKey: AcpRemoteCryptoKey | string;
};

export type AcpRemoteAccountSessionCredential = {
  accountSession: AcpRemoteAccountSession;
  privateKey: AcpRemoteCryptoKey | string;
};

export type CreateAcpRemoteAccountSessionOptions = {
  accountId: AcpRemoteId;
  expiresAt?: string;
  issuedAt?: string;
  now?: Date;
  principalId: AcpRemoteId;
  principalPublicKey: AcpRemoteCryptoKey | string;
  principalType: AcpRemoteAccountSessionPrincipalType;
  sessionId?: AcpRemoteId;
  signingKey: AcpRemoteAccountSessionSigningKey;
  ttlMs?: number;
};

export type AcpRemoteConnectionProof = {
  accountSession: AcpRemoteAccountSession;
  clientId: AcpRemoteId;
  connectionId: AcpRemoteId;
  hostId: AcpRemoteId;
  nonce: string;
  signature: string;
  timestamp: string;
};

export type CreateAcpRemoteConnectionProofOptions = {
  clientId?: AcpRemoteId;
  connectionId: AcpRemoteId;
  credential: AcpRemoteAccountSessionCredential;
  hostId: AcpRemoteId;
  nonce?: string;
  now?: Date;
};

export type VerifyAcpRemoteConnectionProofOptions = {
  accountId?: AcpRemoteId;
  clientId?: AcpRemoteId;
  connectionId?: AcpRemoteId;
  hostId?: AcpRemoteId;
  maxClockSkewMs?: number;
  now?: Date;
};

export type AcpRemoteConnectionProofVerificationResult =
  | {
      ok: true;
      accountId: AcpRemoteId;
      clientId: AcpRemoteId;
      session: AcpRemoteAccountSession;
    }
  | {
      ok: false;
      reason: string;
    };

const DEFAULT_ACCOUNT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_CONNECTION_PROOF_CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function createAcpRemoteAccountSession(
  options: CreateAcpRemoteAccountSessionOptions,
): Promise<AcpRemoteAccountSession> {
  const now = options.now ?? new Date();
  const session: Omit<AcpRemoteAccountSession, "signature"> = {
    accountId: options.accountId,
    alg: ACP_REMOTE_ACCOUNT_SESSION_ALGORITHM,
    expiresAt:
      options.expiresAt ??
      new Date(
        now.getTime() + (options.ttlMs ?? DEFAULT_ACCOUNT_SESSION_TTL_MS),
      ).toISOString(),
    issuedAt: options.issuedAt ?? now.toISOString(),
    kid: options.signingKey.kid,
    principalId: options.principalId,
    principalType: options.principalType,
    publicKey:
      typeof options.principalPublicKey === "string"
        ? options.principalPublicKey
        : await exportEd25519PublicKey(options.principalPublicKey),
    sessionId: options.sessionId ?? crypto.randomUUID(),
  };
  return {
    ...session,
    signature: await signCanonicalPayload(
      canonicalAccountSessionPayload(session),
      options.signingKey.privateKey,
    ),
  };
}

export async function verifyAcpRemoteAccountSession(
  session: AcpRemoteAccountSession,
  keys:
    | AcpRemoteAccountSessionVerificationKey
    | readonly AcpRemoteAccountSessionVerificationKey[],
  options: { now?: Date } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isAcpRemoteAccountSession(session)) {
    return { ok: false, reason: "Invalid account session." };
  }
  if (session.alg !== ACP_REMOTE_ACCOUNT_SESSION_ALGORITHM) {
    return { ok: false, reason: "Unsupported account session algorithm." };
  }
  const key = (Array.isArray(keys) ? keys : [keys]).find(
    (candidate) => candidate.kid === session.kid,
  );
  if (!key) {
    return { ok: false, reason: "Unknown account session authority key." };
  }
  const expiresAt = Date.parse(session.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= (options.now ?? new Date()).getTime()
  ) {
    return { ok: false, reason: "Account session expired." };
  }
  const valid = await verifyCanonicalPayload(
    canonicalAccountSessionPayload(session),
    session.signature,
    key.publicKey,
  );
  return valid
    ? { ok: true }
    : { ok: false, reason: "Invalid account session signature." };
}

export async function createAcpRemoteConnectionProof(
  options: CreateAcpRemoteConnectionProofOptions,
): Promise<AcpRemoteConnectionProof> {
  const clientId = options.clientId ?? options.credential.accountSession.principalId;
  const proof: Omit<AcpRemoteConnectionProof, "signature"> = {
    accountSession: options.credential.accountSession,
    clientId,
    connectionId: options.connectionId,
    hostId: options.hostId,
    nonce: options.nonce ?? crypto.randomUUID(),
    timestamp: (options.now ?? new Date()).toISOString(),
  };
  return {
    ...proof,
    signature: await signCanonicalPayload(
      canonicalConnectionProofPayload(proof),
      options.credential.privateKey,
    ),
  };
}

export async function verifyAcpRemoteConnectionProof(
  proof: AcpRemoteConnectionProof,
  authorityKeys:
    | AcpRemoteAccountSessionVerificationKey
    | readonly AcpRemoteAccountSessionVerificationKey[],
  options: VerifyAcpRemoteConnectionProofOptions = {},
): Promise<AcpRemoteConnectionProofVerificationResult> {
  if (!isAcpRemoteConnectionProof(proof)) {
    return { ok: false, reason: "Invalid connection proof." };
  }
  if (options.accountId && proof.accountSession.accountId !== options.accountId) {
    return { ok: false, reason: "Account session account mismatch." };
  }
  if (options.clientId && proof.clientId !== options.clientId) {
    return { ok: false, reason: "Connection proof client mismatch." };
  }
  if (options.connectionId && proof.connectionId !== options.connectionId) {
    return { ok: false, reason: "Connection proof connection mismatch." };
  }
  if (options.hostId && proof.hostId !== options.hostId) {
    return { ok: false, reason: "Connection proof host mismatch." };
  }
  if (proof.accountSession.principalType !== "client") {
    return { ok: false, reason: "Connection proof must use a client account session." };
  }
  if (proof.accountSession.principalId !== proof.clientId) {
    return { ok: false, reason: "Account session principal mismatch." };
  }
  const sessionResult = await verifyAcpRemoteAccountSession(
    proof.accountSession,
    authorityKeys,
    { now: options.now },
  );
  if (!sessionResult.ok) {
    return sessionResult;
  }
  const timestamp = Date.parse(proof.timestamp);
  const now = options.now ?? new Date();
  const maxClockSkewMs =
    options.maxClockSkewMs ?? DEFAULT_CONNECTION_PROOF_CLOCK_SKEW_MS;
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(now.getTime() - timestamp) > maxClockSkewMs
  ) {
    return { ok: false, reason: "Connection proof timestamp is outside the allowed window." };
  }
  const valid = await verifyCanonicalPayload(
    canonicalConnectionProofPayload(proof),
    proof.signature,
    proof.accountSession.publicKey,
  );
  if (!valid) {
    return { ok: false, reason: "Invalid connection proof signature." };
  }
  return {
    ok: true,
    accountId: proof.accountSession.accountId,
    clientId: proof.clientId,
    session: proof.accountSession,
  };
}

export function encodeAcpRemoteAccountCredential(
  credential: AcpRemoteAccountSessionCredential,
): string {
  return bytesToBase64Url(
    new TextEncoder().encode(stableStringify(credential)),
  );
}

export function encodeAcpRemoteAccountSession(
  session: AcpRemoteAccountSession,
): string {
  return bytesToBase64Url(new TextEncoder().encode(stableStringify(session)));
}

export function decodeAcpRemoteAccountSession(
  value: string,
): AcpRemoteAccountSession {
  const parsed = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(value)),
  ) as unknown;
  if (!isAcpRemoteAccountSession(parsed)) {
    throw new Error("Invalid account session.");
  }
  return parsed;
}

export function decodeAcpRemoteAccountCredential(
  value: string,
): AcpRemoteAccountSessionCredential {
  const parsed = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(value)),
  ) as unknown;
  if (!isAcpRemoteAccountSessionCredential(parsed)) {
    throw new Error("Invalid account session credential.");
  }
  return parsed;
}

export function encodeAcpRemoteConnectionProof(
  proof: AcpRemoteConnectionProof,
): string {
  return bytesToBase64Url(new TextEncoder().encode(stableStringify(proof)));
}

export function decodeAcpRemoteConnectionProof(
  value: string,
): AcpRemoteConnectionProof {
  const parsed = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(value)),
  ) as unknown;
  if (!isAcpRemoteConnectionProof(parsed)) {
    throw new Error("Invalid connection proof.");
  }
  return parsed;
}

export async function exportEd25519PublicKey(
  key: AcpRemoteCryptoKey,
): Promise<string> {
  const exported = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(exported));
}

export async function exportEd25519PrivateKey(
  key: AcpRemoteCryptoKey,
): Promise<string> {
  const exported = await crypto.subtle.exportKey("pkcs8", key);
  return bytesToBase64Url(new Uint8Array(exported));
}

function canonicalAccountSessionPayload(
  session: Omit<AcpRemoteAccountSession, "signature"> | AcpRemoteAccountSession,
): string {
  const { signature: _signature, ...payload } =
    session as AcpRemoteAccountSession;
  return stableStringify(payload);
}

function canonicalConnectionProofPayload(
  proof: Omit<AcpRemoteConnectionProof, "signature"> | AcpRemoteConnectionProof,
): string {
  const { signature: _signature, ...payload } =
    proof as AcpRemoteConnectionProof;
  return stableStringify(payload);
}

async function signCanonicalPayload(
  payload: string,
  privateKey: AcpRemoteCryptoKey | string,
): Promise<string> {
  const cryptoKey =
    typeof privateKey === "string"
      ? await importEd25519PrivateKey(privateKey)
      : privateKey;
  const signature = await crypto.subtle.sign(
    "Ed25519",
    cryptoKey,
    toArrayBuffer(new TextEncoder().encode(payload)),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

async function verifyCanonicalPayload(
  payload: string,
  signature: string,
  publicKey: AcpRemoteCryptoKey | string,
): Promise<boolean> {
  const cryptoKey =
    typeof publicKey === "string"
      ? await importEd25519PublicKey(publicKey)
      : publicKey;
  return crypto.subtle.verify(
    "Ed25519",
    cryptoKey,
    toArrayBuffer(base64UrlToBytes(signature)),
    toArrayBuffer(new TextEncoder().encode(payload)),
  );
}

async function importEd25519PrivateKey(
  privateKey: string,
): Promise<AcpRemoteCryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64UrlToBytes(privateKey)),
    "Ed25519",
    false,
    ["sign"],
  );
}

async function importEd25519PublicKey(
  publicKey: string,
): Promise<AcpRemoteCryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(base64UrlToBytes(publicKey)),
    "Ed25519",
    false,
    ["verify"],
  );
}

function isAcpRemoteAccountSessionCredential(
  value: unknown,
): value is AcpRemoteAccountSessionCredential {
  return (
    isRecord(value) &&
    isAcpRemoteAccountSession(value.accountSession) &&
    isNonEmptyString(value.privateKey)
  );
}

export function isAcpRemoteAccountSession(
  value: unknown,
): value is AcpRemoteAccountSession {
  return (
    isRecord(value) &&
    value.alg === ACP_REMOTE_ACCOUNT_SESSION_ALGORITHM &&
    isNonEmptyString(value.accountId) &&
    isNonEmptyString(value.expiresAt) &&
    isNonEmptyString(value.issuedAt) &&
    isNonEmptyString(value.kid) &&
    isNonEmptyString(value.principalId) &&
    (value.principalType === "client" || value.principalType === "host") &&
    isNonEmptyString(value.publicKey) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.signature)
  );
}

export function isAcpRemoteConnectionProof(
  value: unknown,
): value is AcpRemoteConnectionProof {
  return (
    isRecord(value) &&
    isAcpRemoteAccountSession(value.accountSession) &&
    isNonEmptyString(value.clientId) &&
    isNonEmptyString(value.connectionId) &&
    isNonEmptyString(value.hostId) &&
    isNonEmptyString(value.nonce) &&
    isNonEmptyString(value.signature) &&
    isNonEmptyString(value.timestamp)
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) => (entry === undefined ? "null" : stableStringify(entry)))
      .join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
