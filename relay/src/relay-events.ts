import type { AcpRemoteTraceContext } from "../../src/shared/trace-context.js";
import type { AcpRelayClientTransport } from "./relay-core.js";

export type RelayLifecycleEvent = {
  accountId?: string;
  bufferedClientPayloads?: number;
  clientId?: string;
  code?: string;
  connectionId?: string;
  hostId?: string;
  eventName: string;
  jsonRpcId?: string | number;
  method?: string;
  nativeClientAck?: boolean;
  pendingClientFrames?: number;
  pendingHostFrames?: number;
  pendingReconnect?: boolean;
  reason?: string;
  replaced?: boolean;
  seq?: number;
  sessionId?: string;
  severityText?: "ERROR" | "INFO";
  traceContext?: AcpRemoteTraceContext;
  transport?: AcpRelayClientTransport;
};

export function logRelayLifecycle(input: RelayLifecycleEvent): void {
  console.log(
    JSON.stringify({
      accountId: input.accountId,
      bufferedClientPayloads: input.bufferedClientPayloads,
      clientId: input.clientId,
      code: input.code,
      connectionId: input.connectionId,
      hostId: input.hostId,
      eventName: input.eventName,
      jsonRpcId: input.jsonRpcId,
      method: input.method,
      nativeClientAck: input.nativeClientAck,
      pendingClientFrames: input.pendingClientFrames,
      pendingHostFrames: input.pendingHostFrames,
      pendingReconnect: input.pendingReconnect,
      reason: input.reason,
      replaced: input.replaced,
      seq: input.seq,
      sessionId: input.sessionId,
      severityText: input.severityText ?? "INFO",
      source: "relay",
      spanId: input.traceContext?.spanId,
      traceId: input.traceContext?.traceId,
      traceparent: input.traceContext?.traceparent,
      transport: input.transport,
    }),
  );
}
