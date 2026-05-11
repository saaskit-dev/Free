export type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

export function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

export function html(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

export async function readJsonBody(
  request: Request,
): Promise<ParseResult<unknown>> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, reason: "Request body must be valid JSON." };
  }
}

export function parseError(reason: string): ParseResult<never> {
  return { ok: false, reason };
}

export function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string.`);
  }
  return { ok: true, value };
}

export function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string when provided.`);
  }
  return { ok: true, value };
}

export function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): ParseResult<boolean | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "boolean") {
    return parseError(`${key} must be a boolean when provided.`);
  }
  return { ok: true, value };
}

export function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): ParseResult<readonly string[] | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError(`${key} must be a non-empty string array when provided.`);
  }
  return { ok: true, value };
}

export function readRequiredPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number> {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return parseError(`${key} must be a positive integer.`);
  }
  return { ok: true, value: value as number };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
