import type { Env } from "./index.js";
import {
  createAcpRemoteChildTraceContext,
  type AcpRemoteTraceContext,
} from "../../src/shared/trace-context.js";

export type RelayTraceSpanInput = {
  attributes?: Record<string, unknown>;
  endTimeMs?: number;
  name: string;
  parent: AcpRemoteTraceContext;
  serviceName?: string;
  startTimeMs?: number;
};

export type RelayTraceSpan = {
  context: AcpRemoteTraceContext;
  exportPromise: Promise<void>;
};

export function createRelayTraceSpan(
  env: Pick<Env, "FREE_OTLP_ENDPOINT" | "FREE_OTLP_HEADER" | "FREE_OTLP_TOKEN">,
  input: RelayTraceSpanInput,
): RelayTraceSpan {
  const context = createAcpRemoteChildTraceContext(input.parent);
  return {
    context,
    exportPromise: exportRelayTraceSpan(env, {
      ...input,
      context,
    }),
  };
}

async function exportRelayTraceSpan(
  env: Pick<Env, "FREE_OTLP_ENDPOINT" | "FREE_OTLP_HEADER" | "FREE_OTLP_TOKEN">,
  input: RelayTraceSpanInput & { context: AcpRemoteTraceContext },
): Promise<void> {
  if (!env.FREE_OTLP_ENDPOINT || !env.FREE_OTLP_TOKEN) {
    return;
  }
  const startTimeMs = input.startTimeMs ?? Date.now();
  const endTimeMs = input.endTimeMs ?? Date.now();
  const response = await fetch(buildOtlpEndpoint(env.FREE_OTLP_ENDPOINT), {
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: otlpAttributes({
              "free.source": "relay",
              "service.name": input.serviceName ?? "free-relay",
            }),
          },
          scopeSpans: [
            {
              scope: {
                name: "free",
              },
              spans: [
                {
                  attributes: otlpAttributes({
                    ...input.attributes,
                    "free.record.kind": "otel_span",
                  }),
                  endTimeUnixNano: millisToUnixNano(endTimeMs),
                  kind: 2,
                  name: input.name,
                  parentSpanId: input.parent.spanId,
                  spanId: input.context.spanId,
                  startTimeUnixNano: millisToUnixNano(startTimeMs),
                  status: {
                    code: 1,
                  },
                  traceId: input.context.traceId,
                },
              ],
            },
          ],
        },
      ],
    }),
    headers: {
      "content-type": "application/json",
      [env.FREE_OTLP_HEADER || "X-OTLP-Token"]: env.FREE_OTLP_TOKEN,
    },
    method: "POST",
  });
  if (!response.ok) {
    console.warn(
      JSON.stringify({
        eventName: "acp.relay.business_trace_export_failed",
        spanName: input.name,
        status: response.status,
      }),
    );
  }
}

function buildOtlpEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1/traces")) {
    return url.toString();
  }
  url.pathname = `${pathname}/v1/traces`;
  return url.toString();
}

function otlpAttributes(attributes: Record<string, unknown>): unknown[] {
  return Object.entries(attributes)
    .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
    .map(([key, value]) => ({
      key,
      value: otlpAnyValue(value),
    }));
}

function otlpAnyValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: value === undefined || value === null ? "" : String(value) };
}

function millisToUnixNano(value: number): string {
  return String(Math.trunc(value) * 1_000_000);
}
