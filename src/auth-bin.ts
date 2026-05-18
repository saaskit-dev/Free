#!/usr/bin/env node

import { ACP_REMOTE_DEFAULT_RELAY_URL } from "./defaults.js";
import {
  FREE_LOCAL_RELAY_URL,
  resolveFreeRelayUrl,
} from "./relay-environment.js";
import {
  clearCachedSession,
  getSessionPath,
  loadCachedSession,
  loginViaOAuth,
  saveSession,
  validateRelaySession,
} from "./host/host-login.js";
import {
  acpRemoteHostServiceMatchesConfig,
  getAcpRemoteHostUserServiceStatus,
  installAcpRemoteHostUserService,
  restartAcpRemoteHostUserService,
  resolveAcpRemoteHostLaunchdLabel,
  uninstallAcpRemoteHostUserService,
} from "./host/service.js";
import { resolveCurrentFreeExecutablePath } from "./launcher.js";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

type AuthCommand =
  | { name: "help" }
  | { force: boolean; name: "login"; relayUrl: string }
  | { name: "logout"; relayUrl: string }
  | { name: "status"; relayUrl: string };

export function parseFreeAuthCommand(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): AuthCommand {
  const [command = "help", ...rest] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    return { name: "help" };
  }

  switch (command) {
    case "login":
      return parseLoginCommand(rest, env);
    case "logout":
      return parseLogoutCommand(rest, env);
    case "status":
      return parseStatusCommand(rest, env);
    default:
      throw new Error(`Unknown free auth command: ${command}`);
  }
}

export async function runFreeAuthCommand(argv: readonly string[]): Promise<void> {
  const command = parseFreeAuthCommand(argv, process.env);
  switch (command.name) {
    case "help":
      printHelp();
      return;
    case "login":
      await login(command);
      return;
    case "logout":
      await logout(command);
      return;
    case "status":
      await status(command);
      return;
  }
}

function parseLoginCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AuthCommand {
  let force = false;
  let relayEnvironment: string | undefined;
  let relayUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--force":
      case "-f":
        force = true;
        break;
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--relay-env":
        relayEnvironment = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        return { name: "help" };
      default:
        throw new Error(`Unknown free login option: ${arg}`);
    }
  }
  return {
    force,
    name: "login",
    relayUrl: resolveFreeRelayUrl({
      env,
      explicitRelayEnvironment: relayEnvironment,
      explicitRelayUrl: relayUrl,
      envRelayEnvironmentName: "FREE_RELAY_ENV",
      envRelayUrlName: "FREE_RELAY_URL",
    }),
  };
}

function parseStatusCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AuthCommand {
  let relayEnvironment: string | undefined;
  let relayUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--relay-env":
        relayEnvironment = readArgValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown free status option: ${arg}`);
    }
  }
  return {
    name: "status",
    relayUrl: resolveFreeRelayUrl({
      env,
      explicitRelayEnvironment: relayEnvironment,
      explicitRelayUrl: relayUrl,
      envRelayEnvironmentName: "FREE_RELAY_ENV",
      envRelayUrlName: "FREE_RELAY_URL",
    }),
  };
}

function parseLogoutCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): AuthCommand {
  let relayEnvironment: string | undefined;
  let relayUrl: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--relay-url":
        relayUrl = readArgValue(argv, index, arg);
        index += 1;
        break;
      case "--relay-env":
        relayEnvironment = readArgValue(argv, index, arg);
        index += 1;
        break;
      default:
        throw new Error(`Unknown free logout option: ${arg}`);
    }
  }
  return {
    name: "logout",
    relayUrl: resolveFreeRelayUrl({
      env,
      envRelayEnvironmentName: "FREE_RELAY_ENV",
      envRelayUrlName: "FREE_RELAY_URL",
      explicitRelayEnvironment: relayEnvironment,
      explicitRelayUrl: relayUrl,
    }),
  };
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
  const sessionPath = getSessionPath(undefined, command.relayUrl);
  if (!command.force) {
    process.stderr.write(`Checking cached account session at ${sessionPath}...\n`);
    const cached = await loadCachedSession(undefined, command.relayUrl);
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
          await clearCachedSession(undefined, command.relayUrl);
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
        const hostMessage = await ensureDefaultHostInstalled(command.relayUrl);
        process.stdout.write(
          [
            "Already authenticated.",
            `relay: ${describeRelayTarget(command.relayUrl)}`,
            `account: ${validation.accountId}`,
            `session: ${sessionPath}`,
            `Use \`${loginCommandForRelay(command.relayUrl)} --force\` to refresh the session.`,
            hostMessage,
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
  process.stderr.write(`Saving account session at ${sessionPath}...\n`);
  await saveSession(session, undefined, command.relayUrl);
  process.stderr.write("Account session saved.\n");
  process.stderr.write("Preparing Free host service...\n");
  const hostMessage = await ensureDefaultHostInstalled(command.relayUrl, {
    reinstall: command.force,
  });
  process.stdout.write(
    [
      "Authentication successful.",
      `relay: ${describeRelayTarget(command.relayUrl)}`,
      `account: ${session.accountId}`,
      `session: ${sessionPath}`,
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
  const label = resolveAcpRemoteHostLaunchdLabel(relayUrl);
  const systemStatus = getAcpRemoteHostUserServiceStatus(label, "system", homeDir);
  const userStatus = getAcpRemoteHostUserServiceStatus(label, "user", homeDir);
  if (systemStatus.installed && !userStatus.installed) {
    return reinstallSystemHostService(relayUrl);
  }
  const hostBinPath = resolveCurrentFreeExecutablePath();
  const workspaceRoots = [homeDir];
  if (userStatus.installed && !options.reinstall) {
    const matchesCurrentConfig = await acpRemoteHostServiceMatchesConfig({
      homeDir,
      hostBinPath,
      label,
      relayUrl,
      scope: "user",
      workspaceRoots,
    });
    if (!matchesCurrentConfig) {
      const status = await installAcpRemoteHostUserService({
        hostBinPath,
        env: {
          ...process.env,
        },
        homeDir,
        label,
        relayUrl,
        scope: "user",
        workspaceRoots,
      });
      return `Host service updated for ${describeRelayTarget(relayUrl)}: ${status.running ? "running" : "not running"} (${status.plistPath})`;
    }
    if (userStatus.running) {
      return `Host service already installed: running (${userStatus.plistPath})`;
    }
    const started = await restartAcpRemoteHostUserService(
      label,
      "user",
      homeDir,
    );
    return `Host service already installed; started: ${started.running ? "running" : "not running"} (${started.plistPath})`;
  }
  const status = await installAcpRemoteHostUserService({
    hostBinPath,
    env: {
      ...process.env,
    },
    homeDir,
    label,
    relayUrl,
    scope: "user",
    workspaceRoots,
  });
  return `Host service ${options.reinstall ? "reinstalled" : "installed"}: ${status.running ? "running" : "not running"} (${status.plistPath})`;
}

function reinstallSystemHostService(relayUrl: string): string {
  const hostBinPath = resolveCurrentFreeExecutablePath();
  try {
    execFileSync(
      "sudo",
      [
        hostBinPath,
        "host",
        "start",
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

async function logout(command: Extract<AuthCommand, { name: "logout" }>): Promise<void> {
  const path = getSessionPath(undefined, command.relayUrl);
  const cached = await loadCachedSession(undefined, command.relayUrl);
  await clearCachedSession(undefined, command.relayUrl);
  const hostMessage = await stopDefaultHostService(command.relayUrl);
  if (!cached) {
    process.stdout.write(
      [`Not authenticated. No cached session at ${path}.`, hostMessage].join("\n") +
        "\n",
    );
    return;
  }
  process.stdout.write(
    [`Logged out. Removed cached session at ${path}.`, hostMessage].join("\n") +
      "\n",
  );
}

async function stopDefaultHostService(relayUrl: string): Promise<string> {
  if (process.platform !== "darwin") {
    return "Host service stop skipped: automatic service management currently supports macOS launchd only.";
  }
  const homeDir = homedir();
  const label = resolveAcpRemoteHostLaunchdLabel(relayUrl);
  const userStatus = getAcpRemoteHostUserServiceStatus(label, "user", homeDir);
  const systemStatus = getAcpRemoteHostUserServiceStatus(
    label,
    "system",
    homeDir,
  );
  if (userStatus.installed) {
    await uninstallAcpRemoteHostUserService(label, "user", homeDir);
    return "Host service stopped.";
  }
  if (systemStatus.installed) {
    if (process.getuid?.() === 0) {
      await uninstallAcpRemoteHostUserService(label, "system", homeDir);
      return "System host service stopped.";
    }
    return `System host service is still installed. Run \`sudo ${loginCommandForRelay(relayUrl).replace("login", "logout")}\` to stop it.`;
  }
  return "Host service already stopped.";
}

async function status(command: Extract<AuthCommand, { name: "status" }>): Promise<void> {
  const serviceLabel = resolveAcpRemoteHostLaunchdLabel(command.relayUrl);
  const serviceStatus = process.platform === "darwin"
    ? getAcpRemoteHostUserServiceStatus(serviceLabel)
    : undefined;
  const cached = await loadCachedSession(undefined, command.relayUrl);
  if (cached) {
    process.stderr.write("Validating cached account session with relay...\n");
  }
  const validation = cached
    ? await withWaitingStatus(
        validateRelaySession({
          relayUrl: command.relayUrl,
          session: cached,
        }),
        (elapsedSeconds) =>
          `Still validating cached account session with relay (${elapsedSeconds}s)...`,
      )
    : undefined;
  process.stdout.write(
    [
      `authenticated: ${validation?.ok ? "yes" : "no"}`,
      `relay: ${describeRelayTarget(command.relayUrl)}`,
      ...(validation?.ok && cached
        ? [
            `account: ${validation.accountId}`,
            `savedAt: ${new Date(cached.savedAt).toISOString()}`,
          ]
        : []),
      ...(!validation?.ok && cached
        ? [`reason: ${validation?.reason ?? "cached session missing"}`]
        : []),
      `session: ${getSessionPath(undefined, command.relayUrl)}`,
      ...(serviceStatus
        ? [
            `hostService: ${serviceStatus.running ? "running" : serviceStatus.installed ? "installed" : "not installed"}`,
            `hostServiceLabel: ${serviceStatus.label}`,
            `hostServicePlist: ${serviceStatus.plistPath}`,
          ]
        : []),
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
  const envRelayUrl = resolveFreeRelayUrl({
    env: process.env,
    envRelayEnvironmentName: "FREE_RELAY_ENV",
    envRelayUrlName: "FREE_RELAY_URL",
  });
  process.stdout.write(
    [
      "Usage:",
      "  free login [--relay-env online|local] [--force]",
      "  free login [--relay-url <ws-url>] [--force]",
      "  free logout [--relay-env online|local]",
      "  free logout [--relay-url <ws-url>]",
      "  free status [--relay-env online|local]",
      "  free status [--relay-url <ws-url>]",
      "",
      "Options:",
      `  --relay-url   Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  --relay-env   Relay environment name. online is the default, local uses ws://127.0.0.1:8791.",
      "  --force       Ignore any cached account session and open browser OAuth.",
      "",
      "The login command caches the account session and ensures the default",
      "user host service is installed, running, and pointed at the selected relay.",
      "--force refreshes login and reinstalls the default user host service.",
      "",
      `Current relay: ${describeRelayTarget(envRelayUrl)}`,
      `Current cached session: ${getSessionPath(undefined, envRelayUrl)}`,
      `Current login command: ${loginCommandForRelay(envRelayUrl)}`,
      `Local login command: ${loginCommandForRelay(FREE_LOCAL_RELAY_URL)}`,
    ].join("\n") + "\n",
  );
}

function describeRelayTarget(relayUrl: string): string {
  if (relayUrl === FREE_LOCAL_RELAY_URL) {
    return `local (${relayUrl})`;
  }
  if (relayUrl === ACP_REMOTE_DEFAULT_RELAY_URL) {
    return `online (${relayUrl})`;
  }
  return `custom (${relayUrl})`;
}

function loginCommandForRelay(relayUrl: string): string {
  if (relayUrl === FREE_LOCAL_RELAY_URL) {
    return "free login --relay-env local";
  }
  if (relayUrl === ACP_REMOTE_DEFAULT_RELAY_URL) {
    return "free login --relay-env online";
  }
  return `free login --relay-url ${relayUrl}`;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runFreeAuthCommand(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
