#!/usr/bin/env node

import { ACP_REMOTE_DEFAULT_RELAY_URL } from "./defaults.js";
import {
  clearCachedSession,
  getSessionPath,
  loadCachedSession,
  loginViaOAuth,
  saveSession,
  validateRelaySession,
} from "./host/host-login.js";
import {
  getAcpRemoteHostUserServiceStatus,
  installAcpRemoteHostUserService,
  restartAcpRemoteHostUserService,
} from "./host/service.js";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type AuthCommand =
  | { name: "help" }
  | { ensureHost: boolean; force: boolean; name: "login"; relayUrl: string }
  | { name: "logout" }
  | { name: "status" };

export function parseFreeAuthCommand(argv: readonly string[]): AuthCommand {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  switch (command) {
    case "login":
      return parseLoginCommand(rest);
    case "logout":
      assertNoArgs(rest, "logout");
      return { name: "logout" };
    case "status":
      assertNoArgs(rest, "status");
      return { name: "status" };
    default:
      throw new Error(`Unknown free auth command: ${command}`);
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const command = parseFreeAuthCommand(argv);
  switch (command.name) {
    case "help":
      printHelp();
      return;
    case "login":
      await login(command);
      return;
    case "logout":
      await logout();
      return;
    case "status":
      await status();
      return;
  }
}

function parseLoginCommand(argv: readonly string[]): AuthCommand {
  let ensureHost = true;
  let force = false;
  let relayUrl = ACP_REMOTE_DEFAULT_RELAY_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--force":
      case "-f":
        force = true;
        break;
      case "--no-host":
        ensureHost = false;
        break;
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        return { name: "help" };
      default:
        throw new Error(`Unknown free auth login option: ${arg}`);
    }
  }
  return { ensureHost, force, name: "login", relayUrl };
}

function assertNoArgs(argv: readonly string[], command: string): void {
  if (argv.length > 0) {
    throw new Error(`Unexpected arguments for free auth ${command}: ${argv.join(" ")}`);
  }
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

async function login(command: Extract<AuthCommand, { name: "login" }>): Promise<void> {
  if (!command.force) {
    process.stderr.write(`Checking cached account session at ${getSessionPath()}...\n`);
    const cached = await loadCachedSession();
    if (cached) {
      process.stderr.write("Validating cached account session with relay...\n");
      const validation = await withWaitingStatus(
        validateRelaySession({
          relayUrl: command.relayUrl,
          session: cached,
        }),
        (elapsedSeconds) =>
          `Still validating cached account session with relay (${elapsedSeconds}s)...`,
      );
      if (!validation.ok) {
        if (!validation.retryable) {
          await clearCachedSession();
        }
        process.stdout.write(
          [
            validation.retryable
              ? `Cached session could not be validated right now: ${validation.reason}`
              : `Cached session is no longer valid: ${validation.reason}`,
            validation.retryable
              ? "Keeping the cached session. Retry when the relay/network is reachable, or use `--force` to refresh login now."
              : "Opening browser to refresh login...",
          ].join("\n") + "\n",
        );
        if (validation.retryable) {
          return;
        }
      } else {
        process.stdout.write(
          [
            "Already authenticated.",
            `account: ${validation.accountId}`,
            `session: ${getSessionPath()}`,
            "Use `free auth login --force` to refresh the session.",
          ].join("\n") + "\n",
        );
        return;
      }
    } else {
      process.stderr.write("No cached account session found.\n");
    }
  } else {
    process.stderr.write("Ignoring cached account session because --force was set.\n");
  }

  process.stderr.write("Starting Free browser sign in...\n");
  const session = await loginViaOAuth(command.relayUrl);
  process.stderr.write(`Saving account session at ${getSessionPath()}...\n`);
  await saveSession(session);
  process.stderr.write("Account session saved.\n");
  if (command.ensureHost) {
    process.stderr.write("Preparing Free host service...\n");
  }
  const hostMessage = command.ensureHost
    ? await ensureDefaultHostInstalled(command.relayUrl, {
        reinstall: command.force,
      })
    : "Host install skipped because --no-host was set.";
  process.stdout.write(
    [
      "Authentication successful.",
      `account: ${session.accountId}`,
      `session: ${getSessionPath()}`,
      hostMessage,
    ].join("\n") + "\n",
  );
}

async function ensureDefaultHostInstalled(
  relayUrl: string,
  options: { reinstall?: boolean } = {},
): Promise<string> {
  if (process.platform !== "darwin") {
    return "Host service install skipped: automatic service install currently supports macOS launchd only.";
  }
  const homeDir = homedir();
  const systemStatus = getAcpRemoteHostUserServiceStatus(
    undefined,
    "system",
    homeDir,
  );
  const userStatus = getAcpRemoteHostUserServiceStatus(
    undefined,
    "user",
    homeDir,
  );
  if (systemStatus.installed && !userStatus.installed) {
    return reinstallSystemHostService(relayUrl);
  }
  if (userStatus.installed && !options.reinstall) {
    if (userStatus.running) {
      return `Host service already installed: running (${userStatus.plistPath})`;
    }
    const started = await restartAcpRemoteHostUserService(
      undefined,
      "user",
      homeDir,
    );
    return `Host service already installed; started: ${started.running ? "running" : "not running"} (${started.plistPath})`;
  }
  const status = await installAcpRemoteHostUserService({
    hostBinPath: join(dirname(fileURLToPath(import.meta.url)), "host", "bin.js"),
    env: {
      ...process.env,
    },
    homeDir,
    nodePath: process.execPath,
    relayUrl,
    scope: "user",
    workspaceRoots: [homeDir],
  });
  return `Host service ${options.reinstall ? "reinstalled" : "installed"}: ${status.running ? "running" : "not running"} (${status.plistPath})`;
}

function reinstallSystemHostService(relayUrl: string): string {
  const hostBinPath = join(dirname(fileURLToPath(import.meta.url)), "host", "bin.js");
  try {
    execFileSync(
      "sudo",
      [
        process.execPath,
        hostBinPath,
        "install",
        "--system",
        "--relay-url",
        relayUrl,
      ],
      { stdio: "inherit" },
    );
    return "System host service reinstalled.";
  } catch (error) {
    return `System host reinstall failed after login: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function logout(): Promise<void> {
  const path = getSessionPath();
  const cached = await loadCachedSession();
  await clearCachedSession();
  if (!cached) {
    process.stdout.write(`Not authenticated. No cached session at ${path}.\n`);
    return;
  }
  process.stdout.write(`Logged out. Removed cached session at ${path}.\n`);
}

async function status(): Promise<void> {
  const cached = await loadCachedSession();
  if (cached) {
    process.stderr.write("Validating cached account session with relay...\n");
  }
  const validation = cached
    ? await withWaitingStatus(
        validateRelaySession({
          relayUrl: ACP_REMOTE_DEFAULT_RELAY_URL,
          session: cached,
        }),
        (elapsedSeconds) =>
          `Still validating cached account session with relay (${elapsedSeconds}s)...`,
      )
    : undefined;
  process.stdout.write(
    [
      `authenticated: ${validation?.ok ? "yes" : "no"}`,
      ...(validation?.ok && cached
        ? [
            `account: ${validation.accountId}`,
            `savedAt: ${new Date(cached.savedAt).toISOString()}`,
          ]
        : []),
      ...(!validation?.ok && cached
        ? [`reason: ${validation?.reason ?? "cached session missing"}`]
        : []),
      `session: ${getSessionPath()}`,
    ].join("\n") + "\n",
  );
}

async function withWaitingStatus<T>(
  promise: Promise<T>,
  createMessage: (elapsedSeconds: number) => string,
): Promise<T> {
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    process.stderr.write(`${createMessage(elapsedSeconds)}\n`);
  }, 5_000);
  try {
    return await promise;
  } finally {
    clearInterval(interval);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free auth login [--relay-url <ws-url>] [--force] [--no-host]",
      "  free auth status",
      "  free auth logout",
      "",
      "Options:",
      `  --relay-url   Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  --force       Ignore any cached account session and open browser OAuth.",
      "  --no-host   Only cache the login session; do not install the default user host.",
      "",
      "The auth login command caches the account session. After a fresh login,",
      "it installs the default user host service on macOS if no service exists.",
      "--force refreshes login and reinstalls the default user host service.",
      `Cached session: ${getSessionPath()}`,
    ].join("\n") + "\n",
  );
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
