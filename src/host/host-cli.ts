import type {
  AcpRemoteHostConnectionOptions,
} from "./relay-connection.js";
import {
  connectAcpRemoteHostRelay,
  type AcpRemoteHostSocketFactory,
  type ConnectedAcpRemoteHostRelay,
  type HostMetadata,
} from "./relay-client.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";

export type AcpRemoteHostCliEnvironment = Record<string, string | undefined>;

export const ACP_REMOTE_HOST_ACCOUNT_ID_ENV_VAR =
  "ACP_REMOTE_HOST_ACCOUNT_ID" as const;
export const ACP_REMOTE_HOST_ACCOUNT_SESSION_ENV_VAR =
  "ACP_REMOTE_HOST_ACCOUNT_SESSION" as const;
export const ACP_REMOTE_HOST_HOST_ID_ENV_VAR =
  "ACP_REMOTE_HOST_HOST_ID" as const;
export const ACP_REMOTE_HOST_IDENTITY_PATH_ENV_VAR =
  "ACP_REMOTE_HOST_IDENTITY_PATH" as const;
export const ACP_REMOTE_HOST_RELAY_URL_ENV_VAR =
  "ACP_REMOTE_HOST_RELAY_URL" as const;

export type AcpRemoteHostCliConfig = {
  accountId?: string;
  accountSession?: string;
  hostId?: string;
  forceLogin?: boolean;
  hostMetadata?: HostMetadata;
  identityPath?: string;
  relayUrl: string;
};

export type ConnectAcpRemoteHostCliOptions = Omit<
  AcpRemoteHostConnectionOptions,
  "hostId" | "socket"
> & {
  config: AcpRemoteHostCliConfig;
  socketFactory: AcpRemoteHostSocketFactory;
};

export async function connectAcpRemoteHostRelayFromCliConfig(
  options: ConnectAcpRemoteHostCliOptions,
): Promise<ConnectedAcpRemoteHostRelay> {
  const { config, socketFactory, ...connectionOptions } = options;
  return connectAcpRemoteHostRelay({
    ...connectionOptions,
    accountId: config.accountId,
    accountSession: config.accountSession,
    hostId: config.hostId as string | undefined,
    hostMetadata: config.hostMetadata,
    identityPath: config.identityPath,
    remoteMachineName: config.hostMetadata?.machine,
    relayUrl: config.relayUrl,
    socketFactory,
  } as Parameters<typeof connectAcpRemoteHostRelay>[0]);
}

export function parseAcpRemoteHostCliConfig(input: {
  argv: readonly string[];
  env?: AcpRemoteHostCliEnvironment;
}): AcpRemoteHostCliConfig {
  const values = parseNamedArgs(input.argv);
  const env = input.env ?? process.env;
  const accountId = values.accountId ?? env[ACP_REMOTE_HOST_ACCOUNT_ID_ENV_VAR];
  const accountSession =
    values.accountSession ?? env[ACP_REMOTE_HOST_ACCOUNT_SESSION_ENV_VAR];
  const hostId = values.hostId ?? env[ACP_REMOTE_HOST_HOST_ID_ENV_VAR];
  const relayUrl =
    values.relayUrl ??
    env[ACP_REMOTE_HOST_RELAY_URL_ENV_VAR] ??
    ACP_REMOTE_DEFAULT_RELAY_URL;
  const identityPath =
    values.identityPath ?? env[ACP_REMOTE_HOST_IDENTITY_PATH_ENV_VAR];

  return {
    accountId,
    accountSession,
    hostId,
    forceLogin: values.forceLogin,
    identityPath,
    relayUrl,
  };
}

const EXTRA_ARG_KEYS = new Set([
  "--agent-command",
  "--home-dir",
  "--system",
  "--user",
  "--workspace-root",
]);

function parseNamedArgs(argv: readonly string[]): Partial<AcpRemoteHostCliConfig> {
  const values: Partial<AcpRemoteHostCliConfig> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--system":
        break;
      case "--account-id":
        values.accountId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--account-session":
        values.accountSession = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--host-id":
        values.hostId = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--identity-path":
        values.identityPath = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--relay-url":
        values.relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--force-login":
        values.forceLogin = true;
        break;
      default:
        if (EXTRA_ARG_KEYS.has(arg)) {
          index += 1;
          break;
        }
        throw new Error(`Unknown remote host option: ${arg}`);
    }
  }
  return values;
}

function readArgValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}
