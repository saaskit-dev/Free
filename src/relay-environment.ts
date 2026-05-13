import { ACP_REMOTE_DEFAULT_RELAY_URL } from "./defaults.js";

export const FREE_LOCAL_RELAY_URL = "ws://127.0.0.1:8791";
export const FREE_LOCAL_WORKBENCH_ORIGIN = "http://127.0.0.1:8790";
export const FREE_ONLINE_WORKBENCH_ORIGIN = "https://free.saaskit.app";

export type FreeRelayEnvironmentName = "online" | "local";

export function resolveFreeRelayUrl(input: {
  env?: Record<string, string | undefined>;
  envRelayEnvironmentName?: string;
  envRelayUrlName?: string;
  explicitRelayEnvironment?: string;
  explicitRelayUrl?: string;
}): string {
  const env = input.env ?? process.env;
  if (input.explicitRelayUrl && input.explicitRelayEnvironment) {
    throw new Error("Use either --relay-url or --relay-env, not both.");
  }
  if (input.explicitRelayUrl) {
    return input.explicitRelayUrl;
  }
  if (input.explicitRelayEnvironment) {
    return relayUrlForEnvironment(readFreeRelayEnvironmentName(input.explicitRelayEnvironment));
  }

  const envRelayUrl = input.envRelayUrlName
    ? env[input.envRelayUrlName]
    : undefined;
  if (envRelayUrl) {
    return envRelayUrl;
  }

  const envRelayEnvironment = input.envRelayEnvironmentName
    ? env[input.envRelayEnvironmentName]
    : undefined;
  if (envRelayEnvironment) {
    return relayUrlForEnvironment(readFreeRelayEnvironmentName(envRelayEnvironment));
  }

  if (env.FREE_RELAY_URL) {
    return env.FREE_RELAY_URL;
  }
  if (env.FREE_RELAY_ENV) {
    return relayUrlForEnvironment(readFreeRelayEnvironmentName(env.FREE_RELAY_ENV));
  }
  return ACP_REMOTE_DEFAULT_RELAY_URL;
}

export function readFreeRelayEnvironmentName(
  value: string,
): FreeRelayEnvironmentName {
  if (value === "online" || value === "local") {
    return value;
  }
  throw new Error(`Invalid relay environment: ${value}. Expected online or local.`);
}

export function relayUrlForEnvironment(
  environmentName: FreeRelayEnvironmentName,
): string {
  return environmentName === "local"
    ? FREE_LOCAL_RELAY_URL
    : ACP_REMOTE_DEFAULT_RELAY_URL;
}

export function resolveFreeWorkbenchOriginForRelayUrl(input: {
  env?: Record<string, string | undefined>;
  relayUrl: string;
}): string | undefined {
  const env = input.env ?? process.env;
  const configured =
    env.FREE_WORKBENCH_ORIGIN ??
    env.FREE_WORKBENCH_URL ??
    env.ACP_RELAY_WORKBENCH_ORIGIN;
  if (configured) {
    return normalizeOrigin(configured);
  }

  const relayHttpUrl = input.relayUrl.replace(/^ws(s?):\/\//, "http$1://");
  try {
    const url = new URL(relayHttpUrl);
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "8791"
    ) {
      return FREE_LOCAL_WORKBENCH_ORIGIN;
    }
    if (url.hostname === "free-relay.saaskit.app") {
      return FREE_ONLINE_WORKBENCH_ORIGIN;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createFreeWorkbenchLoginStartUrl(input: {
  returnTo: string;
  workbenchOrigin: string;
}): string {
  const url = new URL("/login/start", normalizeOrigin(input.workbenchOrigin));
  url.searchParams.set("returnTo", input.returnTo);
  return url.toString();
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  return url.origin;
}
