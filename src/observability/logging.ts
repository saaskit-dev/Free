import { logs, SeverityNumber } from "@opentelemetry/api-logs";

export type FreeLogRecord = {
  attributes?: Record<string, unknown>;
  body?: unknown;
  context?: import("@opentelemetry/api").Context;
  eventName?: string;
  exception?: unknown;
  severityNumber?: SeverityNumber;
};

export function emitFreeLog(record: FreeLogRecord): void {
  const logger = logs.getLogger("free");
  logger.emit({
    attributes: {
      ...(record.eventName ? { eventName: record.eventName } : {}),
      ...record.attributes,
    },
    body: record.body as never,
    context: record.context,
    severityNumber: record.severityNumber,
  });
}

export function emitFreeSuppressedError(record: FreeLogRecord): void {
  emitFreeLog({
    ...record,
    severityNumber: record.severityNumber ?? SeverityNumber.WARN,
  });
}
