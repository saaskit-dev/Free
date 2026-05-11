#!/usr/bin/env node

import {
  connectAcpRemoteHostRelayFromCliConfig,
  parseAcpRemoteHostCliConfig,
} from "./host-cli.js";
import {
  createAcpRemoteHostConnectionState,
  type AcpRemoteHostDebugContext,
} from "./relay-connection.js";
import {
  hasHostRestartBlockers,
  readHostRestartBlockers,
} from "./restart-blockers.js";
import type { HostMetadata } from "./relay-client.js";
import {
  createAcpRemoteWebSocketFactory,
  runAcpRemoteReconnectLoop,
} from "../shared/index.js";
import type { AcpRemoteWebSocketConstructor } from "../shared/index.js";
import { createStdioAcpConnectionFactory } from "@saaskit-dev/acp-runtime";
import { AcpRuntime } from "@saaskit-dev/acp-runtime";
import {
  CLAUDE_CODE_ACP_REGISTRY_ID,
  CODEX_ACP_REGISTRY_ID,
  CURSOR_ACP_REGISTRY_ID,
  GEMINI_CLI_ACP_REGISTRY_ID,
  GITHUB_COPILOT_ACP_REGISTRY_ID,
  OPENCODE_ACP_REGISTRY_ID,
  PI_ACP_REGISTRY_ID,
} from "@saaskit-dev/acp-runtime";
import {
  readAcpRemoteAccountSessionVerificationKeys,
} from "../protocol/account-session-authority.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";
import {
  clearCachedSession,
  decodeHostAccountSession,
  encodeHostAccountSession,
  loadCachedSession,
  saveSession,
  loginViaOAuth,
  validateRelaySession,
  type HostSession,
} from "./host-login.js";
import { createFileAcpRemoteHostRequestJournal } from "./request-journal.js";
import { configureFreeTelemetryFromEnv } from "../relay-log-upload.js";
import { execFileSync, execSync } from "node:child_process";
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import {
  type AcpRemoteHostServiceScope,
  getAcpRemoteHostUserServiceStatus,
  installAcpRemoteHostUserService,
  restartAcpRemoteHostUserService,
  stopAcpRemoteHostUserService,
  uninstallAcpRemoteHostUserService,
} from "./service.js";

const ACP_REMOTE_HOST_ACCOUNT_SESSION_ENV_VAR =
  "ACP_REMOTE_HOST_ACCOUNT_SESSION";
const HOST_BINARY_CHANGE_CHECK_INTERVAL_MS = 60_000;
const HOST_PENDING_RESTART_CHECK_INTERVAL_MS = 60_000;
const HOST_LOG_DIR = join(homedir(), ".free", "logs");
const HOST_TEXT_LOG_PATH = join(HOST_LOG_DIR, "host.log.text.jsonl");
const HOST_ERROR_LOG_PATH = join(HOST_LOG_DIR, "host.log.errors.jsonl");
const HOST_REQUEST_JOURNAL_PATH = join(
  homedir(),
  ".free",
  "host-request-journal.json",
);

type HostAgentMetadata = HostMetadata["agentTypes"][number];

const DEFAULT_REGISTRY_AGENTS: readonly HostAgentMetadata[] = [
  { id: CODEX_ACP_REGISTRY_ID, label: "Codex" },
  { id: CLAUDE_CODE_ACP_REGISTRY_ID, label: "Claude Code" },
  { id: OPENCODE_ACP_REGISTRY_ID, label: "OpenCode" },
  { id: GITHUB_COPILOT_ACP_REGISTRY_ID, label: "GitHub Copilot" },
  { id: CURSOR_ACP_REGISTRY_ID, label: "Cursor" },
  { id: GEMINI_CLI_ACP_REGISTRY_ID, label: "Gemini" },
  { id: PI_ACP_REGISTRY_ID, label: "Pi" },
  { id: "qwen-code", label: "Qwen Code" },
];

async function resolveWebSocket(): Promise<AcpRemoteWebSocketConstructor> {
  const ws = await import("ws");
  return ws.WebSocket as unknown as AcpRemoteWebSocketConstructor;
}

function readAccountSessionVerificationKeys() {
  return readAcpRemoteAccountSessionVerificationKeys();
}

function readWorkspaceRoots(argv: readonly string[], defaultHomeDir = homedir()): string[] {
  const roots: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (
      argv[index] === "--workspace-root" &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--")
    ) {
      roots.push(argv[index + 1]);
      index += 1;
    }
  }
  const envRoots = process.env["ACP_REMOTE_HOST_WORKSPACE_ROOTS"];
  if (envRoots) {
    roots.push(
      ...envRoots
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    );
  }
  return roots.length > 0 ? roots : [defaultHomeDir];
}

/**
 * Scan PATH for installed ACP agent binaries.
 * Returns entries like { command: "simulator-agent-acp", label: "Simulator Agent ACP" }.
 */
function discoverAgentsInPath(): {
  command: string;
  label: string;
  type?: string;
}[] {
  const knownAgents = [
    { command: "codex-acp", label: "Codex" },
    { command: "claude-acp", label: "Claude Code" },
    { command: "qwen-code", label: "Qwen Code" },
    { command: "opencode", label: "OpenCode" },
    { command: "pi-acp", label: "Pi" },
    { command: "cursor-acp", label: "Cursor" },
    { command: "gemini-acp", label: "Gemini" },
    { command: "github-copilot-cli", label: "GitHub Copilot" },
    {
      command: "simulator-agent-acp",
      label: "Simulator Agent",
      type: "simulator",
    },
  ];

  const discovered: { command: string; label: string; type?: string }[] = [];
  for (const agent of knownAgents) {
    try {
      // Resolve full path — `which` may return a shell shim that spawn() can't execute.
      // Use `node -e "require('child_process').execSync..."` or just check with shell.
      const fullPath = execSync(`command -v ${agent.command} 2>/dev/null || which ${agent.command} 2>/dev/null`, { encoding: "utf8" }).trim();
      if (fullPath) {
        discovered.push({ ...agent, command: fullPath });
      }
    } catch {
      // not in PATH, skip
    }
  }
  return discovered;
}

function buildHostMetadata(
  discoveredAgents: readonly HostAgentMetadata[],
  runtimeInstanceId: string,
  workspaceRoots: string[],
): HostMetadata | undefined {
  const agentTypes = dedupeHostAgents([
    ...DEFAULT_REGISTRY_AGENTS,
    ...discoveredAgents,
  ]);
  return {
    agentTypes,
    ...(agentTypes.length > 0 || workspaceRoots.length > 0
      ? { machine: hostname() }
      : {}),
    runtimeInstanceId,
    workspaceRoots: workspaceRoots.map((path) => ({ path })),
  };
}

function dedupeHostAgents(
  agents: readonly HostAgentMetadata[],
): HostAgentMetadata[] {
  const seen = new Set<string>();
  const result: HostAgentMetadata[] = [];
  for (const agent of agents) {
    const key = agent.id ? `id:${agent.id}` : `command:${agent.command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(agent);
  }
  return result;
}

async function resolveSession(
  argv: readonly string[],
  relayUrl: string,
  options: { forceLogin?: boolean; homeDir?: string } = {},
): Promise<HostSession> {
  // 1. CLI/env override
  const idx = argv.indexOf("--account-session");
  if (idx !== -1 && argv[idx + 1]) {
    return decodeHostAccountSession(argv[idx + 1]);
  }
  const envToken = process.env[ACP_REMOTE_HOST_ACCOUNT_SESSION_ENV_VAR];
  if (envToken) {
    return decodeHostAccountSession(envToken);
  }

  // 2. Cached session
  if (!options.forceLogin) {
    const cached = await loadCachedSession(options.homeDir);
    if (cached) {
      const validation = await validateRelaySession({ relayUrl, session: cached });
      if (validation.ok) {
        process.stderr.write(`Using cached session (${validation.accountId}).\n`);
        return { ...cached, accountId: validation.accountId };
      }
      if (!validation.retryable) {
        await clearCachedSession(options.homeDir);
      }
      throw new Error(
        [
          `Cached ACP relay session is no longer valid: ${validation.reason}`,
          validation.retryable
            ? "Keep the cached login and retry after the relay/network is reachable."
            : "Run `free auth login --force` to refresh login, then restart the host.",
        ].join("\n"),
      );
    }
  } else {
    process.stderr.write("Ignoring cached session because --force-login was set.\n");
  }

  // 3. Browser OAuth flow
  process.stderr.write(
    "No cached session. Opening browser for GitHub login...\n",
  );
  const session = await loginViaOAuth(relayUrl);
  await saveSession(session, options.homeDir);
  process.stderr.write(`Account session saved for account ${session.accountId} at ~/.free/account-session.json.\n`);
  return session;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

async function main(rawArgv: readonly string[]): Promise<void> {
  const command = readCommand(rawArgv);
  const argv = command.argv;

  if (argv.includes("--help")) {
    printHelp();
    return;
  }
  const serviceOptions = readServiceOptions(argv, command.name);
  if (serviceOptions.modeConflict) {
    if (command.name === "status") {
      process.stdout.write(
        "mode: conflict\nBoth user and system host services are installed. " +
        "Install one mode again to switch cleanly, or uninstall one mode explicitly.\n",
      );
      printServiceStatus(serviceOptions.modeConflict.userStatus, "user");
      printServiceStatus(serviceOptions.modeConflict.systemStatus, "system");
      return;
    }
    throw new Error(
      "Both user and system host services are installed. Pass --system to manage " +
      "the system host, or uninstall one mode before using automatic mode detection.",
    );
  }
  if (shouldRerunWithSudo(command.name, serviceOptions.scope)) {
    rerunWithSudo(rawArgv);
    return;
  }

  switch (command.name) {
    case "install":
      await installService(argv);
      return;
    case "uninstall":
      await uninstallAcpRemoteHostUserService(
        undefined,
        serviceOptions.scope,
        serviceOptions.homeDir,
      );
      process.stdout.write("ACP remote host service uninstalled.\n");
      return;
    case "restart": {
      const status = await restartAcpRemoteHostUserService(
        undefined,
        serviceOptions.scope,
        serviceOptions.homeDir,
      );
      printServiceStatus(status);
      return;
    }
    case "stop": {
      const status = stopAcpRemoteHostUserService(
        undefined,
        serviceOptions.scope,
        serviceOptions.homeDir,
      );
      printServiceStatus(status);
      return;
    }
    case "status": {
      const status = getAcpRemoteHostUserServiceStatus(
        undefined,
        serviceOptions.scope,
        serviceOptions.homeDir,
      );
      printServiceStatus(status);
      return;
    }
    case "run":
      await runHost(argv);
      return;
  }
}

async function installService(argv: readonly string[]): Promise<void> {
  const config = parseAcpRemoteHostCliConfig({ argv });
  const serviceOptions = readServiceOptions(argv, "install");
  const workspaceRoots = readWorkspaceRoots(argv, serviceOptions.homeDir);
  await resolveSession(argv, config.relayUrl, {
    forceLogin: config.forceLogin,
    homeDir: serviceOptions.homeDir,
  });
  const env = {
    ...process.env,
  };
  const status = await installAcpRemoteHostUserService({
    hostBinPath: process.argv[1],
    hostId: config.hostId,
    env,
    homeDir: serviceOptions.homeDir,
    identityPath: config.identityPath,
    nodePath: process.execPath,
    relayUrl: config.relayUrl,
    scope: serviceOptions.scope,
    userName: serviceOptions.userName,
    workspaceRoots,
  });
  printServiceStatus(status);
  process.stdout.write(
    `Installed ACP remote host service. Logs: ${serviceOptions.homeDir}/.free/logs/host.err.log\n`,
  );
}

async function runHost(argv: readonly string[]): Promise<void> {
  const config = parseAcpRemoteHostCliConfig({ argv });
  const workspaceRoots = readWorkspaceRoots(argv);
  const runtimeInstanceId = crypto.randomUUID();
  const discoveredAgents = discoverAgentsInPath();
  config.hostMetadata = buildHostMetadata(
    discoveredAgents,
    runtimeInstanceId,
    workspaceRoots,
  );
  const WebSocketConstructor = await resolveWebSocket();
  const accountSessionVerificationKeys =
    readAccountSessionVerificationKeys();
  const session = await resolveSession(argv, config.relayUrl, {
    forceLogin: config.forceLogin,
  });
  config.accountSession = encodeHostAccountSession(session);
  config.accountId = session.accountId;
  const relayTelemetry = configureFreeTelemetryFromEnv({
    accountSession: config.accountSession,
    context: {
      "acp.remote.account_id": config.accountId,
      "acp.remote.host_id": config.hostId,
      "acp.remote.machine": config.hostMetadata?.machine,
      "acp.remote.runtime_instance_id": runtimeInstanceId,
      "acp.remote.workspace_roots": workspaceRoots,
    },
    onError(error: unknown) {
      process.stderr.write(
        `Relay log upload failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
    relayUrl: config.relayUrl,
    source: "host",
  });
  const writeHostLog = (
    message: string,
    attributes?: Record<string, unknown>,
    severityText: "ERROR" | "INFO" = "INFO",
    context?: AcpRemoteHostDebugContext,
  ): void => {
    if (!shouldRecordHostLog(severityText, context)) {
      return;
    }
    process.stderr.write(`${message}\n`);
    appendHostClassifiedLog(message, severityText, context);
    relayTelemetry?.uploader.writeText(
      message,
      {
        "acp.jsonrpc.id": context?.jsonRpcId,
        "acp.jsonrpc.method": context?.method,
        "acp.remote.component": "host",
        "acp.remote.ack": context?.ack,
        "acp.remote.connection_id": context?.connectionId,
        "acp.remote.direction": context?.direction,
        "acp.remote.payload_bytes": context?.payloadBytes,
        "acp.remote.payload_hash": context?.payloadHash,
        "acp.remote.prompt_block_count": context?.promptBlockCount,
        "acp.remote.prompt_text_chars": context?.promptTextChars,
        "acp.remote.prompt_text_hash": context?.promptTextHash,
        "acp.remote.response_has_error": context?.responseHasError,
        "acp.remote.seq": context?.seq,
        "acp.remote.stop_reason": context?.stopReason,
        "acp.remote.update_kind": context?.updateKind,
        "acp.remote.update_text_chars": context?.updateTextChars,
        "acp.remote.update_text_hash": context?.updateTextHash,
        "acp.session.id": context?.sessionId,
        ...attributes,
      },
      {
        severityText,
        spanId: context?.spanId,
        traceId: context?.traceId,
      },
    );
  };
  const debugLog = (
    message: string,
    context?: AcpRemoteHostDebugContext,
  ): void => {
    writeHostLog(message, undefined, context?.severityText ?? "INFO", context);
  };

  const runtime = new AcpRuntime(createStdioAcpConnectionFactory());
  const hostConnectionState = createAcpRemoteHostConnectionState();
  const requestJournal = createFileAcpRemoteHostRequestJournal({
    path: HOST_REQUEST_JOURNAL_PATH,
  });
  const agentList =
    config.hostMetadata?.agentTypes.length
      ? config.hostMetadata.agentTypes
          .map((a) => a.id ?? a.command)
          .filter(Boolean)
          .join(", ")
      : "(none configured)";
  let stopping = false;
  let active: { close(): void } | undefined;
  let pendingHostRestart:
    | { currentMtimeMs: number; initialMtimeMs: number }
    | undefined;
  const stop = () => {
    stopping = true;
    active?.close();
  };
  const exitForHostBinaryChange = (change: {
    currentMtimeMs: number;
    initialMtimeMs: number;
  }) => {
    const blockers = readHostRestartBlockers(hostConnectionState);
    writeHostLog(
      "Host executable changed on disk. Exiting so launchd can restart with the updated code.",
      {
        "acp.remote.active_connections": blockers.activeConnections,
        "acp.remote.host_bin": process.argv[1],
        "acp.remote.host_bin_current_mtime_ms": change.currentMtimeMs,
        "acp.remote.host_bin_initial_mtime_ms": change.initialMtimeMs,
        "acp.remote.in_flight_runtime_requests": blockers.inFlightRuntimeRequests,
      },
    );
    process.exit(0);
  };
  const stopWatchingHostBinary = watchHostBinaryForChanges({
    hostBinPath: process.argv[1],
    onChange(change) {
      const blockers = readHostRestartBlockers(hostConnectionState);
      if (hasHostRestartBlockers(blockers)) {
        pendingHostRestart = change;
        writeHostLog(
          "Host executable changed on disk. Deferring restart until active remote work completes.",
          {
            "acp.remote.active_connections": blockers.activeConnections,
            "acp.remote.host_bin": process.argv[1],
            "acp.remote.host_bin_current_mtime_ms": change.currentMtimeMs,
            "acp.remote.host_bin_initial_mtime_ms": change.initialMtimeMs,
            "acp.remote.in_flight_runtime_requests": blockers.inFlightRuntimeRequests,
          },
        );
        return;
      }
      exitForHostBinaryChange(change);
    },
  });
  const pendingRestartTimer = setInterval(() => {
    if (
      !pendingHostRestart ||
      hasHostRestartBlockers(readHostRestartBlockers(hostConnectionState))
    ) {
      return;
    }
    exitForHostBinaryChange(pendingHostRestart);
  }, HOST_PENDING_RESTART_CHECK_INTERVAL_MS);
  pendingRestartTimer.unref?.();
  const stopPendingRestartTimer = () => clearInterval(pendingRestartTimer);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await runAcpRemoteReconnectLoop({
    connect: async () => {
      writeHostLog(
        `Connecting to ${config.relayUrl}${config.hostId ? ` (${config.hostId})` : ""} (agents: ${agentList})...`,
        { "acp.remote.relay_url": config.relayUrl },
      );
      return connectAcpRemoteHostRelayFromCliConfig({
        config,
        debugLog,
        runtime,
        requestJournal,
        socketFactory: createAcpRemoteWebSocketFactory(WebSocketConstructor),
        state: hostConnectionState,
        accountSessionVerificationKeys,
      });
    },
    isStopping: () => stopping,
    onConnected(connected) {
      active = connected;
      writeHostLog(
        `Host connected (${connected.hostId}). Waiting for clients...`,
        { "acp.remote.host_id": connected.hostId },
      );
    },
    onConnectError(error) {
      active = undefined;
      writeHostLog(
        `Relay connection failed: ${error instanceof Error ? error.message : error}`,
        { "acp.remote.error": error instanceof Error ? error.message : String(error) },
        "ERROR",
      );
    },
    onDisconnected() {
      active = undefined;
      writeHostLog("Relay connection closed. Reconnecting...");
    },
    onRetry(delayMs) {
      writeHostLog(`Retrying in ${Math.round(delayMs / 1000)}s...`);
    },
    waitForDisconnect: waitForHostDisconnect,
  });
  stopWatchingHostBinary?.();
  stopPendingRestartTimer();
  await relayTelemetry?.close();
}

function shouldRecordHostLog(
  severityText: "ERROR" | "INFO",
  context?: AcpRemoteHostDebugContext,
): boolean {
  if (severityText === "ERROR") {
    return true;
  }
  if (context?.method === "session/update") {
    return false;
  }
  return true;
}

function appendHostClassifiedLog(
  message: string,
  severityText: "ERROR" | "INFO",
  context?: AcpRemoteHostDebugContext,
): void {
  try {
    mkdirSync(HOST_LOG_DIR, { recursive: true });
    const line = `${JSON.stringify({
      body: message,
      ack: context?.ack,
      connectionId: context?.connectionId,
      direction: context?.direction,
      jsonRpcId: context?.jsonRpcId,
      kind: "text",
      method: context?.method,
      observedAt: new Date().toISOString(),
      payloadBytes: context?.payloadBytes,
      payloadHash: context?.payloadHash,
      payloadPreview: context?.payloadPreview,
      payloadPreviewTruncated: context?.payloadPreviewTruncated,
      promptBlockCount: context?.promptBlockCount,
      promptTextChars: context?.promptTextChars,
      promptTextHash: context?.promptTextHash,
      promptTextPreview: context?.promptTextPreview,
      promptTextPreviewTruncated: context?.promptTextPreviewTruncated,
      responseHasError: context?.responseHasError,
      seq: context?.seq,
      severityText,
      sessionId: context?.sessionId,
      spanId: context?.spanId,
      source: "host",
      stopReason: context?.stopReason,
      traceId: context?.traceId,
      traceparent: context?.traceparent,
      updateKind: context?.updateKind,
      updateTextChars: context?.updateTextChars,
      updateTextHash: context?.updateTextHash,
      updateTextPreview: context?.updateTextPreview,
      updateTextPreviewTruncated: context?.updateTextPreviewTruncated,
    })}\n`;
    appendFileSync(HOST_TEXT_LOG_PATH, line);
    if (severityText === "ERROR") {
      appendFileSync(HOST_ERROR_LOG_PATH, line);
    }
    if (!context?.sessionId) {
      return;
    }
    const sessionDir = hostSessionLogDir(context.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    appendFileSync(join(sessionDir, "host.log.text.jsonl"), line);
    if (severityText === "ERROR") {
      appendFileSync(join(sessionDir, "host.log.errors.jsonl"), line);
    }
  } catch (error) {
    process.stderr.write(
      `Host classified log write failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function hostSessionLogDir(sessionId: string): string {
  return join(
    HOST_LOG_DIR,
    "sessions",
    sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session",
  );
}

function waitForHostDisconnect(input: {
  close(): void;
  hostId: string;
  socket: {
    addEventListener(type: "close" | "error", listener: (event?: unknown) => void): void;
    send(data: string): void;
  };
}): Promise<void> {
  const heartbeat = setInterval(() => {
    try {
      input.socket.send(
        JSON.stringify({ frameType: "ping", nonce: crypto.randomUUID() }),
      );
    } catch (error) {
      process.stderr.write(
        `Host heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }, 15_000);
  return new Promise((resolve) => {
    const done = (event?: unknown) => {
      clearInterval(heartbeat);
      const details = normalizeHostSocketCloseEvent(event);
      const message = details
        ? `Relay connection closed (${details}).`
        : "Relay connection closed.";
      process.stderr.write(`${message}\n`);
      appendHostClassifiedLog(message, "INFO");
      resolve();
    };
    input.socket.addEventListener("close", done);
    input.socket.addEventListener("error", done);
  });
}

function normalizeHostSocketCloseEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { code?: unknown; reason?: unknown };
  const parts: string[] = [];
  if (typeof candidate.code === "number") {
    parts.push(`code=${candidate.code}`);
  }
  if (typeof candidate.reason === "string" && candidate.reason) {
    parts.push(`reason=${candidate.reason}`);
  } else if (candidate.reason instanceof Uint8Array && candidate.reason.length) {
    parts.push(`reason=${new TextDecoder().decode(candidate.reason)}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

type HostServiceCommand =
  | "install"
  | "restart"
  | "run"
  | "status"
  | "stop"
  | "uninstall";

function readCommand(argv: readonly string[]): {
  argv: readonly string[];
  name: HostServiceCommand;
} {
  const first = argv[0];
  if (
    first === "install" ||
    first === "run" ||
    first === "restart" ||
    first === "status" ||
    first === "stop" ||
    first === "uninstall"
  ) {
    return { argv: argv.slice(1), name: first };
  }
  if (first && !first.startsWith("--")) {
    throw new Error(`Unknown host command: ${first}`);
  }
  return { argv, name: "run" };
}

function readServiceOptions(
  argv: readonly string[],
  commandName: HostServiceCommand,
): {
  homeDir: string;
  modeConflict?: {
    systemStatus: ReturnType<typeof getAcpRemoteHostUserServiceStatus>;
    userStatus: ReturnType<typeof getAcpRemoteHostUserServiceStatus>;
  };
  scope: AcpRemoteHostServiceScope;
  userName?: string;
} {
  const system = argv.includes("--system");
  const userHomeDir = readOptionValue(argv, "--home-dir") ?? homedir();
  if (!system && commandName !== "install" && commandName !== "run") {
    const userStatus = getAcpRemoteHostUserServiceStatus(
      undefined,
      "user",
      userHomeDir,
    );
    const systemStatus = getAcpRemoteHostUserServiceStatus(
      undefined,
      "system",
      userHomeDir,
    );
    if (systemStatus.installed && !userStatus.installed) {
      return {
        homeDir: userHomeDir,
        scope: "system",
        userName: process.env.SUDO_USER ?? userInfo().username,
      };
    }
    if (systemStatus.installed && userStatus.installed) {
      return {
        homeDir: userHomeDir,
        modeConflict: { systemStatus, userStatus },
        scope: "user",
      };
    }
  }
  if (!system) {
    return {
      homeDir: userHomeDir,
      scope: "user",
    };
  }

  const userName = readOptionValue(argv, "--user") ??
    process.env.SUDO_USER ??
    userInfo().username;
  const homeDir = readOptionValue(argv, "--home-dir") ?? resolveUserHome(userName);
  return {
    homeDir,
    scope: "system",
    userName,
  };
}

function shouldRerunWithSudo(
  command: HostServiceCommand,
  scope: AcpRemoteHostServiceScope,
): boolean {
  return (
    scope === "system" &&
    command !== "run" &&
    command !== "status" &&
    process.getuid?.() !== 0
  );
}

function rerunWithSudo(argv: readonly string[]): void {
  execFileSync("sudo", [process.execPath, process.argv[1], ...argv], {
    stdio: "inherit",
  });
}

function readOptionValue(
  argv: readonly string[],
  option: string,
): string | undefined {
  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function resolveUserHome(userName: string): string {
  try {
    const output = execSync(`dscl . -read /Users/${shellEscape(userName)} NFSHomeDirectory`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(/NFSHomeDirectory:\s*(.+)\s*$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  } catch {
    // Fall through to the conventional macOS user home path.
  }
  return `/Users/${userName}`;
}

function watchHostBinaryForChanges(input: {
  hostBinPath: string | undefined;
  onChange(input: { currentMtimeMs: number; initialMtimeMs: number }): void;
}): (() => void) | undefined {
  const initialMtimeMs = readFileMtimeMs(input.hostBinPath);
  if (initialMtimeMs === undefined) {
    return undefined;
  }
  const timer = setInterval(() => {
    const currentMtimeMs = readFileMtimeMs(input.hostBinPath);
    if (currentMtimeMs === undefined || currentMtimeMs === initialMtimeMs) {
      return;
    }
    clearInterval(timer);
    input.onChange({ currentMtimeMs, initialMtimeMs });
  }, HOST_BINARY_CHANGE_CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function readFileMtimeMs(path: string | undefined): number | undefined {
  if (!path) {
    return undefined;
  }
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free host run [--relay-url <ws-url>]",
      "  free host install [--relay-url <ws-url>] [--workspace-root <path>...] [--system]",
      "  free host status [--system]",
      "  free host stop [--system]",
      "  free host restart [--system]",
      "  free host uninstall [--system]",
      "",
      "Options:",
      `  --relay-url          Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  --host-id            Host ID (optional; default: persistent machine ID)",
      "  --identity-path      Host identity path (optional)",
      "  --workspace-root     Workspace root path (repeatable; default: home directory)",
      "  --account-session    Encoded AccountSession (skip browser OAuth)",
      "  --force-login        Ignore cached session and open browser OAuth",
      "  --system             Install/manage a boot-time launchd service instead of a login-time LaunchAgent",
      "  --user               User for --system launchd service (default: SUDO_USER or current user)",
      "  --home-dir           Home directory for --system (default: detected user home)",
      "",
      "Environment variables:",
      "  ACP_REMOTE_HOST_RELAY_URL            Relay WebSocket URL",
      "  ACP_REMOTE_HOST_WORKSPACE_ROOTS      Comma-separated workspace roots",
      "  ACP_REMOTE_HOST_ACCOUNT_SESSION      Encoded AccountSession",
      "",
      "Service install:",
      "  install writes a macOS user LaunchAgent with RunAtLoad and KeepAlive.",
      "  install --system writes a root-owned launchd plist in /Library/LaunchDaemons",
      "  and runs the host as the invoking sudo user by default.",
      "  Installing one mode removes or rejects the other so only one service mode is active.",
      "  The host process also reconnects to the relay with exponential backoff.",
      "",
      "Agent discovery:",
      "  The host reports ACP registry ids to the relay by default.",
      "  PATH-discovered ACP agent binaries are also reported as compatibility entries.",
      "  The actual agent is selected during the authorize flow.",
      "",
      "Login flow:",
      "  If no --account-session or env var is set, the host checks",
      "  ~/.free/account-session.json, otherwise opens browser OAuth and saves it.",
      "  Use --force-login to refresh an expired or mismatched cached session.",
      "",
      "Defaults:",
      `  relay: ${ACP_REMOTE_DEFAULT_RELAY_URL}`,
      "  workspace root: home directory",
    ].join("\n") + "\n",
  );
}

function printServiceStatus(status: {
  installed: boolean;
  label: string;
  plistPath: string;
  running: boolean;
}, mode?: AcpRemoteHostServiceScope): void {
  process.stdout.write(
    [
      ...(mode ? [`mode: ${mode}`] : []),
      `label: ${status.label}`,
      `installed: ${status.installed ? "yes" : "no"}`,
      `running: ${status.running ? "yes" : "no"}`,
      `plist: ${status.plistPath}`,
    ].join("\n") + "\n",
  );
}
