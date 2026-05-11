import type { AcpRelayAccountSession } from "./account-session.js";
import type { Env } from "./env.js";
import {
  asRecord,
  json,
  parseError,
  readJsonBody,
  readRequiredString,
  type ParseResult,
} from "./http-utils.js";

const MAX_LOG_UPLOAD_RECORDS = 100;
const MAX_LOG_UPLOAD_BYTES = 512 * 1024;

type VerifyAccountSessionRequest = (input: {
  env: Env;
  request: Request;
}) => Promise<
  | {
      ok: true;
      session: AcpRelayAccountSession;
    }
  | {
      ok: false;
      reason: string;
      status: number;
    }
>;

type RelayLogUploadBatch = {
  context?: Record<string, unknown>;
  records: readonly Record<string, unknown>[];
  source: string;
};

export async function handleRelayLogUploadRequest(
  request: Request,
  env: Env,
  verifyAccountSessionRequest: VerifyAccountSessionRequest,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOG_UPLOAD_BYTES) {
    return json({ error: "Log upload body is too large." }, { status: 413 });
  }

  const accountSession = await verifyAccountSessionRequest({
    env,
    request,
  });
  if (!accountSession.ok) {
    return json(
      { error: accountSession.reason },
      {
        status: accountSession.status,
      },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const batch = parseRelayLogUploadBatch(parsedBody.value);
  if (!batch.ok) {
    return json({ error: batch.reason }, { status: 400 });
  }

  const uploadId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  for (const [index, record] of batch.value.records.entries()) {
    console.log(
      JSON.stringify({
        accountId: accountSession.session.accountId,
        accountSessionId: accountSession.session.sessionId,
        context: batch.value.context,
        eventName: "acp.relay.log",
        index,
        receivedAt,
        record,
        spanId: typeof record.spanId === "string" ? record.spanId : undefined,
        source: batch.value.source,
        traceId:
          typeof record.traceId === "string" ? record.traceId : undefined,
        uploadId,
      }),
    );
  }

  return json({
    accepted: batch.value.records.length,
    ok: true,
    uploadId,
  });
}

export async function handleRelayOtlpProxyRequest(
  request: Request,
  env: Env,
  url: URL,
  verifyAccountSessionRequest: VerifyAccountSessionRequest,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOG_UPLOAD_BYTES) {
    return json({ error: "OTLP payload body is too large." }, { status: 413 });
  }

  const accountSession = await verifyAccountSessionRequest({
    env,
    request,
  });
  if (!accountSession.ok) {
    return json(
      { error: accountSession.reason },
      {
        status: accountSession.status,
      },
    );
  }

  if (!env.FREE_OTLP_ENDPOINT || !env.FREE_OTLP_TOKEN) {
    return json({
      accepted: true,
      configured: false,
      reason: "otel_export_disabled",
    });
  }

  const signal = url.pathname.endsWith("/traces") ? "traces" : "logs";
  const upstreamUrl = buildOtlpEndpoint(env.FREE_OTLP_ENDPOINT, signal);
  const response = await fetch(upstreamUrl, {
    body: request.body,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      [env.FREE_OTLP_HEADER || "X-OTLP-Token"]: env.FREE_OTLP_TOKEN,
    },
    method: "POST",
  });

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        accountId: accountSession.session.accountId,
        eventName: "acp.relay.otlp_proxy_failed",
        signal,
        status: response.status,
      }),
    );
  }

  return new Response(response.body, {
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
    status: response.status,
  });
}

function buildOtlpEndpoint(
  endpoint: string,
  signal: "logs" | "traces",
): string {
  const url = new URL(endpoint);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(`/v1/${signal}`)) {
    return url.toString();
  }
  url.pathname = `${pathname}/v1/${signal}`;
  return url.toString();
}

function parseRelayLogUploadBatch(
  value: unknown,
): ParseResult<RelayLogUploadBatch> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Log upload body must be an object.");
  }
  if (record.version !== 1) {
    return parseError("Log upload version must be 1.");
  }
  const source = readRequiredString(record, "source");
  if (!source.ok) {
    return source;
  }
  const records = record.records;
  if (!Array.isArray(records)) {
    return parseError("records must be an array.");
  }
  if (records.length > MAX_LOG_UPLOAD_RECORDS) {
    return parseError(
      `records must contain at most ${MAX_LOG_UPLOAD_RECORDS} entries.`,
    );
  }
  const parsedRecords: Record<string, unknown>[] = [];
  for (const entry of records) {
    const parsed = asRecord(entry);
    if (!parsed) {
      return parseError("records entries must be objects.");
    }
    parsedRecords.push(parsed);
  }
  const context =
    record.context === undefined || record.context === null
      ? undefined
      : asRecord(record.context);
  if (record.context !== undefined && record.context !== null && !context) {
    return parseError("context must be an object when provided.");
  }
  return {
    ok: true,
    value: {
      context,
      records: parsedRecords,
      source: source.value,
    },
  };
}
