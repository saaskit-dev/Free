import type { AcpRemoteScope } from "./types.js";

export type AcpRemoteJsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type AcpRemoteJsonRpcRequest = AcpRemoteJsonRpcNotification & {
  id: number | string | null;
};

export type AcpRemoteJsonRpcMessage =
  | AcpRemoteJsonRpcNotification
  | AcpRemoteJsonRpcRequest;

export const ACP_METHOD_SCOPE_BY_METHOD = {
  "session/close": "acp:session:resume",
  "session/set_config_option": "acp:session:resume",
  "session/set_mode": "acp:session:resume",
  "session/fork": "acp:session:resume",
  "session/list": "acp:session:list",
  "session/load": "acp:session:resume",
  "session/new": "acp:session:create",
  "session/prompt": "acp:turn:send",
  "session/resume": "acp:session:resume",
} as const satisfies Record<string, AcpRemoteScope>;

export const ACP_NOTIFICATION_SCOPE_BY_METHOD = {
  "session/cancel": "acp:turn:cancel",
} as const satisfies Record<string, AcpRemoteScope>;

export function requiredScopeForAcpPayload(
  payload: unknown,
): AcpRemoteScope | undefined {
  if (!isAcpRemoteJsonRpcMessage(payload)) {
    return undefined;
  }
  if (isAcpRemoteJsonRpcRequest(payload)) {
    return readScope(ACP_METHOD_SCOPE_BY_METHOD, payload.method);
  }
  return readScope(ACP_NOTIFICATION_SCOPE_BY_METHOD, payload.method);
}

export function isAcpRemoteJsonRpcMessage(
  value: unknown,
): value is AcpRemoteJsonRpcMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "jsonrpc" in value &&
    value.jsonrpc === "2.0" &&
    "method" in value &&
    typeof value.method === "string"
  );
}

export function isAcpRemoteJsonRpcRequest(
  value: unknown,
): value is AcpRemoteJsonRpcRequest {
  return (
    isAcpRemoteJsonRpcMessage(value) &&
    "id" in value &&
    (typeof value.id === "string" ||
      typeof value.id === "number" ||
      value.id === null)
  );
}

function readScope<const T extends Record<string, AcpRemoteScope>>(
  scopes: T,
  method: string,
): AcpRemoteScope | undefined {
  return Object.hasOwn(scopes, method)
    ? scopes[method as keyof T]
    : undefined;
}
