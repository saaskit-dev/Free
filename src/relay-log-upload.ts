import { isSpanContextValid, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

export const FREE_LOG_UPLOAD_ENV_VAR = "FREE_LOG_UPLOAD" as const;
export const FREE_LOG_UPLOAD_URL_ENV_VAR =
  "FREE_LOG_UPLOAD_URL" as const;
export const FREE_LOG_UPLOAD_TOKEN_ENV_VAR =
  "FREE_LOG_UPLOAD_TOKEN" as const;
export const FREE_LOG_UPLOAD_BATCH_SIZE_ENV_VAR =
  "FREE_LOG_UPLOAD_BATCH_SIZE" as const;
export const FREE_LOG_UPLOAD_FLUSH_INTERVAL_MS_ENV_VAR =
  "FREE_LOG_UPLOAD_FLUSH_INTERVAL_MS" as const;
export const FREE_OTLP_ENDPOINT_ENV_VAR = "FREE_OTLP_ENDPOINT" as const;
export const FREE_OTLP_LOGS_ENDPOINT_ENV_VAR =
  "FREE_OTLP_LOGS_ENDPOINT" as const;
export const FREE_OTLP_TRACES_ENDPOINT_ENV_VAR =
  "FREE_OTLP_TRACES_ENDPOINT" as const;
export const FREE_OTLP_SERVICE_NAME_ENV_VAR =
  "FREE_OTLP_SERVICE_NAME" as const;

const DEFAULT_MAX_BATCH_SIZE = 50;
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const MAX_SAFE_JSON_DEPTH = 8;
const MAX_SAFE_STRING_LENGTH = 16 * 1024;

export type FreeLogUploadRecordKind =
  | "otel_log"
  | "otel_span"
  | "text";

export type FreeLogUploadRecord = {
  attributes?: Record<string, unknown>;
  body?: unknown;
  eventName?: string;
  kind: FreeLogUploadRecordKind;
  observedAt: string;
  record?: unknown;
  severityNumber?: number;
  severityText?: string;
  spanId?: string;
  spanContext?: unknown;
  traceId?: string;
};

export type FreeLogUploadPayload = {
  context?: Record<string, unknown>;
  records: readonly FreeLogUploadRecord[];
  source: string;
  version: 1;
};

export type FreeLogUploader = {
  close(): Promise<void>;
  emit(record: FreeLogUploadRecord): void;
  flush(): Promise<void>;
  writeText(
    message: string,
    attributes?: Record<string, unknown>,
    options?: FreeLogTextOptions,
  ): void;
};

export type FreeLogTextOptions = {
  severityText?: string;
  spanId?: string;
  traceId?: string;
};

export type FreeLogUploaderOptions = {
  accountSession: string;
  batchSize?: number;
  context?: Record<string, unknown>;
  endpointUrl: string | URL;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  onError?: (error: unknown) => void;
  source: string;
};

export type FreeOtlpUploaderOptions = {
  batchSize?: number;
  context?: Record<string, unknown>;
  fetch?: typeof fetch;
  flushIntervalMs?: number;
  headerName?: string;
  logsEndpointUrl: string | URL;
  onError?: (error: unknown) => void;
  serviceName?: string;
  source: string;
  token: string;
  tracesEndpointUrl: string | URL;
};

export type FreeLogUploaderEnvOptions = {
  accountSession?: string;
  context?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
  relayUrl?: string;
  source: string;
};

export type FreeTelemetry = {
  close(): Promise<void>;
  loggerProvider: LoggerProvider;
  tracerProvider: BasicTracerProvider;
  uploader: FreeLogUploader;
};

export function createFreeLogUploadUrl(relayUrl: string | URL): string {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "/api/logs";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function createFreeOtlpProxyUrls(relayUrl: string | URL): {
  logsEndpointUrl: string;
  tracesEndpointUrl: string;
} {
  return {
    logsEndpointUrl: createFreeRelayHttpEndpoint(relayUrl, "/api/otel/logs"),
    tracesEndpointUrl: createFreeRelayHttpEndpoint(relayUrl, "/api/otel/traces"),
  };
}

export function createFreeLogUploader(
  options: FreeLogUploaderOptions,
): FreeLogUploader {
  return new RelayLogUploader(options);
}

export function createFreeOtlpUploader(
  options: FreeOtlpUploaderOptions,
): FreeLogUploader {
  return new OtlpHttpUploader(options);
}

export function createFreeLogUploaderFromEnv(
  options: FreeLogUploaderEnvOptions,
): FreeLogUploader | undefined {
  const env = options.env ?? process.env;
  if (isDisabled(env[FREE_LOG_UPLOAD_ENV_VAR])) {
    return undefined;
  }

  const relayUrl =
    options.relayUrl ??
    env.FREE_RELAY_URL ??
    env.ACP_REMOTE_HOST_RELAY_URL;
  const accountSession =
    options.accountSession ??
    env[FREE_LOG_UPLOAD_TOKEN_ENV_VAR] ??
    env.ACP_ACCOUNT_SESSION ??
    env.ACP_REMOTE_HOST_ACCOUNT_SESSION;

  if (relayUrl && accountSession) {
    const proxyUrls = createFreeOtlpProxyUrls(relayUrl);
    return createFreeOtlpUploader({
      batchSize: readPositiveInteger(
        env[FREE_LOG_UPLOAD_BATCH_SIZE_ENV_VAR],
      ),
      context: options.context,
      fetch: options.fetch,
      flushIntervalMs: readPositiveInteger(
        env[FREE_LOG_UPLOAD_FLUSH_INTERVAL_MS_ENV_VAR],
      ),
      headerName: "Authorization",
      logsEndpointUrl: env[FREE_OTLP_LOGS_ENDPOINT_ENV_VAR] ??
        proxyUrls.logsEndpointUrl,
      onError: options.onError,
      serviceName: env[FREE_OTLP_SERVICE_NAME_ENV_VAR],
      source: options.source,
      token: `Bearer ${accountSession}`,
      tracesEndpointUrl: env[FREE_OTLP_TRACES_ENDPOINT_ENV_VAR] ??
        proxyUrls.tracesEndpointUrl,
    });
  }

  const endpointUrl = env[FREE_LOG_UPLOAD_URL_ENV_VAR];
  if (!endpointUrl || !accountSession) {
    return undefined;
  }

  return createFreeLogUploader({
    accountSession,
    batchSize: readPositiveInteger(
      env[FREE_LOG_UPLOAD_BATCH_SIZE_ENV_VAR],
    ),
    context: options.context,
    endpointUrl,
    flushIntervalMs: readPositiveInteger(
      env[FREE_LOG_UPLOAD_FLUSH_INTERVAL_MS_ENV_VAR],
    ),
    onError: options.onError,
    source: options.source,
  });
}

export function configureFreeTelemetryFromEnv(
  options: FreeLogUploaderEnvOptions,
): FreeTelemetry | undefined {
  const uploader = createFreeLogUploaderFromEnv(options);
  if (!uploader) {
    return undefined;
  }
  return configureFreeTelemetry({ uploader });
}

export function configureFreeTelemetry(input: {
  uploader: FreeLogUploader;
}): FreeTelemetry {
  const loggerProvider = new LoggerProvider({
    processors: [
      new SimpleLogRecordProcessor(
        createFreeLogRecordExporter(input.uploader),
      ),
    ],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const tracerProvider = new BasicTracerProvider();
  tracerProvider.addSpanProcessor(
    new SimpleSpanProcessor(createFreeSpanExporter(input.uploader)),
  );
  trace.setGlobalTracerProvider(tracerProvider);

  return {
    async close() {
      await Promise.allSettled([
        loggerProvider.forceFlush(),
        tracerProvider.forceFlush(),
      ]);
      await Promise.allSettled([
        loggerProvider.shutdown(),
        tracerProvider.shutdown(),
      ]);
      await input.uploader.close();
    },
    loggerProvider,
    tracerProvider,
    uploader: input.uploader,
  };
}

export function createFreeLogRecordExporter(
  uploader: FreeLogUploader,
): LogRecordExporter {
  return {
    export(logRecords, callback) {
      for (const record of logRecords) {
        uploader.emit(serializeLogRecord(record));
      }
      callback({ code: 0 } as never);
    },
    async forceFlush() {
      await uploader.flush();
    },
    async shutdown() {
      await uploader.flush();
    },
  };
}

export function createFreeSpanExporter(
  uploader: FreeLogUploader,
): SpanExporter {
  return {
    export(spans, callback) {
      for (const span of spans) {
        uploader.emit(serializeSpan(span));
      }
      callback({ code: 0 } as never);
    },
    async forceFlush() {
      await uploader.flush();
    },
    async shutdown() {
      await uploader.flush();
    },
  };
}

class RelayLogUploader implements FreeLogUploader {
  private readonly accountSession: string;
  private readonly batchSize: number;
  private readonly context: Record<string, unknown> | undefined;
  private readonly endpointUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES;
  private readonly onError: (error: unknown) => void;
  private readonly source: string;
  private accepting = true;
  private flushPromise: Promise<void> | undefined;
  private queue: FreeLogUploadRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FreeLogUploaderOptions) {
    this.accountSession = options.accountSession;
    this.batchSize = positiveOrDefault(options.batchSize, DEFAULT_MAX_BATCH_SIZE);
    this.context = options.context;
    this.endpointUrl = String(options.endpointUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.flushIntervalMs = positiveOrDefault(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.onError = options.onError ?? (() => {});
    this.source = options.source;
  }

  emit(record: FreeLogUploadRecord): void {
    if (!this.accepting) {
      return;
    }
    this.queue.push(sanitizeRecord(record));
    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  writeText(
    message: string,
    attributes?: Record<string, unknown>,
    options?: FreeLogTextOptions,
  ): void {
    const spanContext = trace.getActiveSpan()?.spanContext();
    this.emit({
      attributes,
      body: message,
      eventName: "acp.relay.local_log",
      kind: "text",
      observedAt: new Date().toISOString(),
      severityText: options?.severityText ?? "INFO",
      ...(spanContext && isSpanContextValid(spanContext)
        ? {
            spanContext,
            spanId: options?.spanId ?? spanContext.spanId,
            traceId: options?.traceId ?? spanContext.traceId,
          }
        : {
            spanId: options?.spanId,
            traceId: options?.traceId,
          }),
    });
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.clearTimer();
    this.flushPromise = this.flushLoop().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.clearTimer();
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer || !this.accepting) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async flushLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const records = this.queue.splice(0, this.batchSize);
      try {
        await this.post(records);
      } catch (error) {
        this.queue.unshift(...records);
        this.onError(error);
        if (this.accepting) {
          this.scheduleFlush();
        }
        return;
      }
    }
  }

  private async post(records: readonly FreeLogUploadRecord[]): Promise<void> {
    if (records.length > 1 && this.payloadByteLength(records) > this.maxPayloadBytes) {
      const midpoint = Math.ceil(records.length / 2);
      await this.post(records.slice(0, midpoint));
      await this.post(records.slice(midpoint));
      return;
    }
    const payload: FreeLogUploadPayload = {
      context: this.context ? toJsonSafe(this.context) as Record<string, unknown> : undefined,
      records,
      source: this.source,
      version: 1,
    };
    const response = await this.fetchImpl(this.endpointUrl, {
      body: JSON.stringify(payload),
      headers: {
        authorization: `Bearer ${this.accountSession}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `ACP relay log upload failed: ${response.status} ${response.statusText}`,
      );
    }
  }

  private payloadByteLength(
    records: readonly FreeLogUploadRecord[],
  ): number {
    return Buffer.byteLength(
      JSON.stringify({
        context: this.context
          ? toJsonSafe(this.context) as Record<string, unknown>
          : undefined,
        records,
        source: this.source,
        version: 1,
      } satisfies FreeLogUploadPayload),
      "utf8",
    );
  }
}

class OtlpHttpUploader implements FreeLogUploader {
  private readonly batchSize: number;
  private readonly context: Record<string, unknown> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly flushIntervalMs: number;
  private readonly headerName: string;
  private readonly logsEndpointUrl: string;
  private readonly onError: (error: unknown) => void;
  private readonly serviceName: string;
  private readonly source: string;
  private readonly token: string;
  private readonly tracesEndpointUrl: string;
  private accepting = true;
  private flushPromise: Promise<void> | undefined;
  private queue: FreeLogUploadRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: FreeOtlpUploaderOptions) {
    this.batchSize = positiveOrDefault(options.batchSize, DEFAULT_MAX_BATCH_SIZE);
    this.context = options.context;
    this.fetchImpl = options.fetch ?? fetch;
    this.flushIntervalMs = positiveOrDefault(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.headerName = options.headerName?.trim() || "X-OTLP-Token";
    this.logsEndpointUrl = String(options.logsEndpointUrl);
    this.onError = options.onError ?? (() => {});
    this.serviceName = options.serviceName?.trim() || `free-${options.source}`;
    this.source = options.source;
    this.token = options.token;
    this.tracesEndpointUrl = String(options.tracesEndpointUrl);
  }

  emit(record: FreeLogUploadRecord): void {
    if (!this.accepting) {
      return;
    }
    this.queue.push(sanitizeRecord(record));
    if (this.queue.length >= this.batchSize) {
      void this.flush();
      return;
    }
    this.scheduleFlush();
  }

  writeText(
    message: string,
    attributes?: Record<string, unknown>,
    options?: FreeLogTextOptions,
  ): void {
    const spanContext = trace.getActiveSpan()?.spanContext();
    this.emit({
      attributes,
      body: message,
      eventName: "acp.relay.local_log",
      kind: "text",
      observedAt: new Date().toISOString(),
      severityText: options?.severityText ?? "INFO",
      ...(spanContext && isSpanContextValid(spanContext)
        ? {
            spanContext,
            spanId: options?.spanId ?? spanContext.spanId,
            traceId: options?.traceId ?? spanContext.traceId,
          }
        : {
            spanId: options?.spanId,
            traceId: options?.traceId,
          }),
    });
  }

  flush(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.clearTimer();
    this.flushPromise = this.flushLoop().finally(() => {
      this.flushPromise = undefined;
    });
    return this.flushPromise;
  }

  async close(): Promise<void> {
    this.accepting = false;
    this.clearTimer();
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer || !this.accepting) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async flushLoop(): Promise<void> {
    while (this.queue.length > 0) {
      const records = this.queue.splice(0, this.batchSize);
      try {
        await this.post(records);
      } catch (error) {
        this.queue.unshift(...records);
        this.onError(error);
        if (this.accepting) {
          this.scheduleFlush();
        }
        return;
      }
    }
  }

  private async post(records: readonly FreeLogUploadRecord[]): Promise<void> {
    const logsPayload = createOtlpLogsPayload(records, {
      context: this.context,
      serviceName: this.serviceName,
      source: this.source,
    });
    const tracesPayload = createOtlpTracesPayload(records, {
      context: this.context,
      serviceName: this.serviceName,
      source: this.source,
    });
    if (logsPayload.resourceLogs.length > 0) {
      await this.postJson(this.logsEndpointUrl, logsPayload, "logs");
    }
    if (tracesPayload.resourceSpans.length > 0) {
      await this.postJson(this.tracesEndpointUrl, tracesPayload, "traces");
    }
  }

  private async postJson(
    endpointUrl: string,
    payload: unknown,
    signalName: string,
  ): Promise<void> {
    const response = await this.fetchImpl(endpointUrl, {
      body: JSON.stringify(payload),
      headers: {
        [this.headerName]: this.token,
        "content-type": "application/json",
      },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Free OTLP ${signalName} export failed: ${response.status} ${response.statusText}`,
      );
    }
  }
}

function createOtlpLogsPayload(
  records: readonly FreeLogUploadRecord[],
  options: {
    context?: Record<string, unknown>;
    serviceName: string;
    source: string;
  },
): { resourceLogs: unknown[] } {
  const logRecords = records
    .filter((record) => record.kind !== "otel_span")
    .map((record) => ({
      attributes: otlpAttributes({
        ...record.attributes,
        "event.name": record.eventName,
        "free.record.kind": record.kind,
        "free.source": options.source,
      }),
      body: otlpAnyValue(record.body),
      observedTimeUnixNano: isoToUnixNano(record.observedAt),
      severityNumber: record.severityNumber,
      severityText: record.severityText,
      spanId: validHex(record.spanId, 16) ? record.spanId : undefined,
      timeUnixNano: isoToUnixNano(record.observedAt),
      traceId: validHex(record.traceId, 32) ? record.traceId : undefined,
    }));
  if (logRecords.length === 0) {
    return { resourceLogs: [] };
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: otlpResourceAttributes(options),
        },
        scopeLogs: [
          {
            logRecords,
            scope: {
              name: "free",
            },
          },
        ],
      },
    ],
  };
}

function createOtlpTracesPayload(
  records: readonly FreeLogUploadRecord[],
  options: {
    context?: Record<string, unknown>;
    serviceName: string;
    source: string;
  },
): { resourceSpans: unknown[] } {
  const spans = records
    .filter((record) => record.kind === "otel_span")
    .map(recordToOtlpSpan)
    .filter((span): span is Record<string, unknown> => Boolean(span));
  if (spans.length === 0) {
    return { resourceSpans: [] };
  }
  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpResourceAttributes(options),
        },
        scopeSpans: [
          {
            scope: {
              name: "free",
            },
            spans,
          },
        ],
      },
    ],
  };
}

function recordToOtlpSpan(
  record: FreeLogUploadRecord,
): Record<string, unknown> | undefined {
  if (!validHex(record.traceId, 32) || !validHex(record.spanId, 16)) {
    return undefined;
  }
  const details = isRecord(record.record) ? record.record : {};
  const parentSpanId = typeof details.parentSpanId === "string" &&
      validHex(details.parentSpanId, 16)
    ? details.parentSpanId
    : undefined;
  const status = isRecord(details.status)
    ? {
        code: typeof details.status.code === "number"
          ? details.status.code
          : undefined,
        message: typeof details.status.message === "string"
          ? details.status.message
          : undefined,
      }
    : undefined;
  return {
    attributes: otlpAttributes({
      ...record.attributes,
      "event.name": record.eventName,
      "free.record.kind": record.kind,
    }),
    endTimeUnixNano: hrTimeOrIsoToUnixNano(details.endTime, record.observedAt),
    kind: typeof details.kind === "number" ? details.kind : undefined,
    name: record.eventName || "free.span",
    parentSpanId,
    spanId: record.spanId,
    startTimeUnixNano: hrTimeOrIsoToUnixNano(
      details.startTime,
      record.observedAt,
    ),
    status,
    traceId: record.traceId,
  };
}

function otlpResourceAttributes(options: {
  context?: Record<string, unknown>;
  serviceName: string;
  source: string;
}): unknown[] {
  return otlpAttributes({
    ...options.context,
    "free.source": options.source,
    "service.name": options.serviceName,
  });
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
  if (value === undefined || value === null) {
    return { stringValue: "" };
  }
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
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((item) => otlpAnyValue(item)),
      },
    };
  }
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value as Record<string, unknown>).map((
          [key, item],
        ) => ({
          key,
          value: otlpAnyValue(item),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

function createFreeRelayHttpEndpoint(
  relayUrl: string | URL,
  pathname: string,
): string {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function hrTimeOrIsoToUnixNano(value: unknown, fallbackIso: string): string {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  ) {
    return String(Math.trunc(value[0]) * 1_000_000_000 + Math.trunc(value[1]));
  }
  return isoToUnixNano(fallbackIso);
}

function isoToUnixNano(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return String(Date.now() * 1_000_000);
  }
  return String(millis * 1_000_000);
}

function validHex(value: unknown, length: number): value is string {
  return typeof value === "string" &&
    value.length === length &&
    /^[0-9a-f]+$/i.test(value) &&
    !/^0+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeLogRecord(record: ReadableLogRecord): FreeLogUploadRecord {
  const traceFields = extractTraceFields(record.spanContext);
  return sanitizeRecord({
    attributes: toJsonSafe(record.attributes) as Record<string, unknown> | undefined,
    body: toJsonSafe(record.body),
    eventName: record.eventName,
    kind: "otel_log",
    observedAt: hrTimeToIso(record.hrTimeObserved ?? record.hrTime),
    record: toJsonSafe({
      hrTime: record.hrTime,
      hrTimeObserved: record.hrTimeObserved,
      instrumentationScope: record.instrumentationScope,
    }),
    severityNumber: record.severityNumber,
    severityText: record.severityText,
    ...traceFields,
    spanContext: toJsonSafe(record.spanContext),
  });
}

function serializeSpan(span: ReadableSpan): FreeLogUploadRecord {
  const spanContext = span.spanContext();
  return sanitizeRecord({
    attributes: toJsonSafe(span.attributes) as Record<string, unknown> | undefined,
    eventName: span.name,
    kind: "otel_span",
    observedAt: hrTimeToIso(span.endTime),
    record: toJsonSafe({
      droppedAttributesCount: span.droppedAttributesCount,
      droppedEventsCount: span.droppedEventsCount,
      droppedLinksCount: span.droppedLinksCount,
      duration: span.duration,
      ended: span.ended,
      events: span.events,
      instrumentationLibrary: span.instrumentationLibrary,
      kind: span.kind,
      links: span.links,
      name: span.name,
      parentSpanId: span.parentSpanId,
      resource: span.resource?.attributes,
      startTime: span.startTime,
      status: span.status,
    }),
    spanContext: toJsonSafe(spanContext),
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
  });
}

function sanitizeRecord(
  record: FreeLogUploadRecord,
): FreeLogUploadRecord {
  const traceFields = extractTraceFields(record.spanContext);
  const sanitized = {
    ...record,
    attributes: record.attributes
      ? toJsonSafe(record.attributes) as Record<string, unknown>
      : undefined,
    body: toJsonSafe(record.body),
    record: toJsonSafe(record.record),
    spanContext: toJsonSafe(record.spanContext),
    spanId: record.spanId ?? traceFields.spanId,
    traceId: record.traceId ?? traceFields.traceId,
  };
  if (recordByteLength(sanitized) <= DEFAULT_MAX_RECORD_BYTES) {
    return sanitized;
  }
  return {
    attributes: sanitized.attributes,
    body: truncateJsonValue(sanitized.body, DEFAULT_MAX_RECORD_BYTES / 2),
    eventName: sanitized.eventName,
    kind: sanitized.kind,
    observedAt: sanitized.observedAt,
    record: "[Truncated]",
    severityNumber: sanitized.severityNumber,
    severityText: sanitized.severityText,
    spanId: sanitized.spanId,
    traceId: sanitized.traceId,
  };
}

function recordByteLength(record: FreeLogUploadRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function truncateJsonValue(value: unknown, maxLength: number): unknown {
  if (typeof value === "string") {
    return truncateString(value, maxLength);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) {
    return value;
  }
  return `${serialized.slice(0, Math.max(0, maxLength - 15))}[Truncated]`;
}

function extractTraceFields(value: unknown): {
  spanId?: string;
  traceId?: string;
} {
  if (typeof value !== "object" || value === null) {
    return {};
  }
  const record = value as Record<string, unknown>;
  return {
    spanId: typeof record.spanId === "string" ? record.spanId : undefined,
    traceId: typeof record.traceId === "string" ? record.traceId : undefined,
  };
}

function hrTimeToIso(hrTime: readonly [number, number] | undefined): string {
  if (!hrTime) {
    return new Date().toISOString();
  }
  const millis = hrTime[0] * 1000 + Math.floor(hrTime[1] / 1_000_000);
  return new Date(millis).toISOString();
}

function isDisabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "off";
}

function readPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "string") {
    return truncateString(value, MAX_SAFE_STRING_LENGTH);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }
  if (depth >= MAX_SAFE_JSON_DEPTH) {
    return "[MaxDepth]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonSafe(entry, depth + 1));
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toJsonSafe(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 15))}[Truncated]`;
}
