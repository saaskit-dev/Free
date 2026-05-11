import {
  decodeAcpRemoteConnectionProof,
  type AcpRemoteConnectionProof,
} from "../../src/protocol/index.js";
import type { AcpRelayAccountSession } from "./account-session.js";
import { asRecord } from "./http-utils.js";
import type { HostMetadata } from "./relay-core.js";

export function waitUntil(
  state: DurableObjectState,
  promise: Promise<unknown>,
): void {
  const maybeState = state as DurableObjectState & {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
  if (typeof maybeState.waitUntil === "function") {
    maybeState.waitUntil(promise);
    return;
  }
  void promise;
}

export function resolveHostId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("hostId") ??
    request.headers.get("x-acp-host-id") ??
    undefined
  );
}

export function resolveClientId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("clientId") ??
    request.headers.get("x-acp-client-id") ??
    request.headers.get("x-acp-verified-client-id") ??
    undefined
  );
}

export function resolveAccountId(
  request: Request,
  url: URL,
  fallback?: string,
): string | undefined {
  return (
    url.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id") ??
    fallback
  );
}

export function resolveRequestedAccountId(
  request: Request,
  url: URL,
): string | undefined {
  return resolveAccountId(request, url);
}

export function resolveVerifiedAccountId(request: Request): string | undefined {
  return request.headers.get("x-acp-verified-account-id") ?? undefined;
}

export function readConnectionProof(
  request: Request,
  url: URL,
): AcpRemoteConnectionProof | undefined {
  const encoded =
    request.headers.get("x-acp-connection-proof") ??
    url.searchParams.get("connectionProof");
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeAcpRemoteConnectionProof(encoded);
  } catch {
    return undefined;
  }
}

export function parseHostMetadataHeaders(
  request: Request,
): HostMetadata | undefined {
  const raw = request.headers.get("x-acp-host-metadata");
  if (!raw) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    if (!asRecord(value)) {
      return undefined;
    }
    const agentTypes = Array.isArray(value.agentTypes)
      ? value.agentTypes.filter(
          (a: unknown) =>
            asRecord(a) &&
            (typeof (a as Record<string, unknown>).command === "string" ||
              typeof (a as Record<string, unknown>).id === "string") &&
            typeof (a as Record<string, unknown>).label === "string",
        )
      : [];
    const workspaceRoots = Array.isArray(value.workspaceRoots)
      ? value.workspaceRoots.filter(
          (w: unknown) =>
            asRecord(w) &&
            typeof (w as Record<string, unknown>).path === "string",
        )
      : [];
    const machine =
      typeof value.machine === "string" && value.machine.trim()
        ? value.machine
        : undefined;
    const runtimeInstanceId =
      typeof value.runtimeInstanceId === "string" &&
      value.runtimeInstanceId.trim()
        ? value.runtimeInstanceId
        : undefined;
    if (
      agentTypes.length === 0 &&
      workspaceRoots.length === 0 &&
      !runtimeInstanceId
    ) {
      return undefined;
    }
    return {
      agentTypes,
      ...(machine ? { machine } : {}),
      ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
      workspaceRoots,
    };
  } catch {
    return undefined;
  }
}

export function withVerifiedAccountSession(
  request: Request,
  session: AcpRelayAccountSession,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-acp-verified-account-id", session.accountId);
  headers.set("x-acp-account-session-id", session.sessionId);
  headers.set("x-acp-verified-principal-id", session.principalId);
  headers.set("x-acp-verified-principal-type", session.principalType);
  if (session.principalType === "client") {
    headers.set("x-acp-verified-client-id", session.principalId);
  }
  return new Request(request, {
    headers,
  });
}

export function createAuthorizationUrl(
  request: Request,
  connectionId: string,
): URL {
  const requestUrl = new URL(request.url);
  const authUrl = new URL("/authorize", request.url);
  const accountId =
    requestUrl.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id");
  if (accountId) {
    authUrl.searchParams.set("accountId", accountId);
  }
  authUrl.searchParams.set("connectionId", connectionId);
  return authUrl;
}

export function normalizeMessageData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return undefined;
}

export function readOptionalPositiveInteger(
  value: string | undefined,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
