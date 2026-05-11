import { ROOT_CONTEXT, trace, type Context } from "@opentelemetry/api";

import { parseAcpRemoteTraceparent } from "../shared/trace-context.js";

export function traceContextFromMeta(
  meta: Record<string, unknown> | null | undefined,
): Context {
  const traceparent = typeof meta?.traceparent === "string" ? meta.traceparent : undefined;
  if (!traceparent) {
    return ROOT_CONTEXT;
  }
  const parsed = parseAcpRemoteTraceparent(traceparent);
  if (!parsed) {
    return ROOT_CONTEXT;
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    isRemote: true,
    spanId: parsed.spanId,
    traceFlags: Number.parseInt(parsed.traceFlags, 16) || 1,
    traceId: parsed.traceId,
  });
}
