import type { AccountSession, HostRecord, LoginApproval } from "../types";

const configuredRelayUrl =
  process.env.EXPO_PUBLIC_RELAY_URL?.replace(/\/$/, "") || "";
const configuredWorkbenchOrigin =
  process.env.EXPO_PUBLIC_WORKBENCH_ORIGIN?.replace(/\/$/, "") || "";

function defaultRelayUrl(): string {
  if (configuredRelayUrl) return relayHttpUrl(configuredRelayUrl);
  return "http://127.0.0.1:8791";
}

async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(`${defaultRelayUrl()}${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
  const value = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value
      ? String((value as { error: unknown }).error)
      : `Request failed with ${response.status}.`;
    throw new Error(error);
  }
  if (!value) {
    throw new Error("Relay returned an empty response.");
  }
  return value;
}

async function readJsonResult<T>(
  path: string,
): Promise<
  | { ok: true; value: T }
  | { ok: false; status: number; message: string }
> {
  const response = await fetch(`${defaultRelayUrl()}${path}`, {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  });
  const value = (await response.json().catch(() => null)) as T | { error?: unknown } | null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        value && typeof value === "object" && "error" in value
          ? String(value.error)
          : `Request failed with ${response.status}.`,
    };
  }
  if (!value) {
    return { ok: false, status: response.status, message: "Relay returned an empty response." };
  }
  return { ok: true, value: value as T };
}

export function createLoginUrl(returnTo?: string): string {
  const url = new URL("/login/start", defaultWorkbenchOrigin());
  if (returnTo) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}

export function createLogoutUrl(): string {
  return `${defaultRelayUrl()}/logout`;
}

export async function startGitHubLogin(returnTo: string) {
  const redirectUri = new URL("/login/callback", defaultWorkbenchOrigin()).toString();
  const url = new URL(`${defaultRelayUrl()}/api/login/start`);
  url.searchParams.set("returnTo", returnTo);
  url.searchParams.set("redirectUri", redirectUri);
  const result = await readJson<{ authorizationUrl: string }>(
    `${url.pathname}${url.search}`,
  );
  return result.authorizationUrl;
}

export async function completeGitHubLogin(input: { code: string; state: string }) {
  const response = await fetch(`${defaultRelayUrl()}/api/login/callback`, {
    body: JSON.stringify(input),
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const value = (await response.json().catch(() => null)) as {
    approvalUrl?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(value?.error ? String(value.error) : `Request failed with ${response.status}.`);
  }
  if (!value || typeof value.approvalUrl !== "string") {
    throw new Error("GitHub login did not return an approval URL.");
  }
  return value.approvalUrl;
}

export async function loadLoginApproval(approvalId: string) {
  return readJsonResult<LoginApproval>(
    `/api/login/approvals/${encodeURIComponent(approvalId)}`,
  );
}

export async function confirmLoginApproval(approvalId: string) {
  const response = await fetch(`${defaultRelayUrl()}/api/login/confirm`, {
    body: JSON.stringify({ approvalId }),
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "POST",
  });
  const value = (await response.json().catch(() => null)) as {
    accountId?: unknown;
    callbackUrl?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(
      value?.error ? String(value.error) : `Request failed with ${response.status}.`,
    );
  }
  if (!value || typeof value.callbackUrl !== "string") {
    throw new Error("Login confirmation did not return a callback URL.");
  }
  return {
    accountId: typeof value.accountId === "string" ? value.accountId : "",
    callbackUrl: value.callbackUrl,
  };
}

export async function loadSession() {
  return readJsonResult<AccountSession>("/api/session");
}

export async function loadHosts() {
  return readJsonResult<{ hosts: HostRecord[] }>("/api/hosts");
}

export async function updateHostName(hostId: string, name: string) {
  const response = await fetch(`${defaultRelayUrl()}/api/hosts/${encodeURIComponent(hostId)}`, {
    body: JSON.stringify({ name }),
    credentials: "include",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    method: "PATCH",
  });
  const value = (await response.json().catch(() => null)) as HostRecord | { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(
      value && typeof value === "object" && "error" in value
        ? String(value.error)
        : `Request failed with ${response.status}.`,
    );
  }
  if (!value) {
    throw new Error("Relay returned an empty response.");
  }
  return value as HostRecord;
}

function defaultWorkbenchOrigin(): string {
  if (configuredWorkbenchOrigin) return configuredWorkbenchOrigin;
  if (typeof window !== "undefined" && window.location.origin.startsWith("http")) {
    const url = new URL(window.location.origin);
    if (url.hostname === "localhost" && url.port === "8790") {
      url.hostname = "127.0.0.1";
      return url.origin;
    }
    return url.origin;
  }
  return "http://127.0.0.1:8790";
}

function relayHttpUrl(value: string): string {
  return value.replace(/^ws(s?):\/\//, "http$1://");
}
