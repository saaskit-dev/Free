import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

import type { AcpRemoteTraceContext } from "../shared/trace-context.js";

export type FreeSpanOptions = {
  attributes?: Record<string, unknown>;
  context?: Context;
  kind?: SpanKind;
  traceContext?: AcpRemoteTraceContext;
};

export type FreeSpanHandle = {
  context: Context;
  span: Span;
  spanId?: string;
  traceId?: string;
  traceparent?: string;
};

export { SpanKind, SpanStatusCode };

export function contextFromAcpRemoteTraceContext(
  traceContext: AcpRemoteTraceContext | undefined,
): Context {
  if (!traceContext) {
    return ROOT_CONTEXT;
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    isRemote: true,
    spanId: traceContext.spanId,
    traceFlags: Number.parseInt(traceContext.traceFlags, 16) || 1,
    traceId: traceContext.traceId,
  });
}

export function startFreeSpan(
  name: string,
  options: FreeSpanOptions = {},
): FreeSpanHandle {
  const parentContext =
    options.context ??
    contextFromAcpRemoteTraceContext(options.traceContext) ??
    otelContext.active();
  const span = trace.getTracer("free").startSpan(
    name,
    {
      attributes: toSpanAttributes(options.attributes),
      kind: options.kind,
    },
    parentContext,
  );
  const spanContext = span.spanContext();
  const childContext = trace.setSpan(parentContext, span);
  return {
    context: childContext,
    span,
    ...(isSpanContextValid(spanContext)
      ? {
          spanId: spanContext.spanId,
          traceId: spanContext.traceId,
          traceparent:
            `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags.toString(16).padStart(2, "0")}`,
        }
      : {}),
  };
}

export async function withFreeSpan<T>(
  name: string,
  options: FreeSpanOptions,
  work: (handle: FreeSpanHandle) => Promise<T>,
): Promise<T> {
  const handle = startFreeSpan(name, options);
  try {
    const result = await work(handle);
    handle.span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    recordFreeSpanError(handle.span, error);
    throw error;
  } finally {
    handle.span.end();
  }
}

export function recordFreeSpanError(span: Span, error: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof Error) {
    span.recordException(error);
  } else {
    span.recordException(String(error));
  }
}

export function toSpanAttributes(
  attributes: Record<string, unknown> | undefined,
): Attributes {
  if (!attributes) {
    return {};
  }
  const output: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = value;
      continue;
    }
  }
  return output;
}
