#!/usr/bin/env node

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import {
  createAcpRemoteWebSocketFactory,
  type AcpRemoteWebSocketConstructor,
} from "../shared/relay-socket.js";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../defaults.js";
import {
  createFreeBridgeStdioConfig,
  createFreeBridgeZedConfig,
  parseFreeBridgeConfigArgs,
  parseFreeBridgeRunArgs,
} from "./bridge-config.js";
import { createAcpRemoteStdioBridge } from "./stdio-bridge.js";
import type { AcpRemoteBridgeDebugContext } from "./stdio-bridge.js";
import {
  configureFreeTelemetry,
  createFreeLogUploaderFromEnv,
  type FreeTelemetry,
  type FreeLogUploader,
} from "../relay-log-upload.js";
import {
  createAcpRemoteConnectionProof,
  decodeAcpRemoteAccountCredential,
  encodeAcpRemoteAccountSession,
  type AcpRemoteAccountSessionCredential,
} from "../protocol/account-session.js";

const ACP_ACCOUNT_SESSION_ENV = "ACP_ACCOUNT_SESSION";

const LOG_DIR = join(homedir(), ".free");
const LOG_PATH = join(LOG_DIR, "bridge.log");
const TEXT_LOG_PATH = join(LOG_DIR, "bridge.log.text.jsonl");
const ERROR_LOG_PATH = join(LOG_DIR, "bridge.log.errors.jsonl");
const BRIDGE_BINARY_CHANGE_CHECK_INTERVAL_MS = 60_000;

let relayLogUploader: FreeLogUploader | undefined;
let relayTelemetry: FreeTelemetry | undefined;
let exiting = false;

function log(
  message: string,
  severityText: "ERROR" | "INFO" = "INFO",
  context?: AcpRemoteBridgeDebugContext,
): void {
  const formattedMessage = formatBridgeConsoleLogMessage(message, context);
  const line = `${new Date().toISOString()} ${formattedMessage}\n`;
  process.stderr.write(`[bridge] ${formattedMessage}\n`);
  relayLogUploader?.writeText(
    message,
    {
      "acp.jsonrpc.id": context?.jsonRpcId,
      "acp.jsonrpc.method": context?.method,
      "acp.remote.component": "bridge",
      "acp.remote.connection_id": context?.connectionId,
      "acp.remote.direction": context?.direction,
      "acp.remote.payload_bytes": context?.payloadBytes,
      "acp.remote.payload_hash": context?.payloadHash,
      "acp.remote.prompt_block_count": context?.promptBlockCount,
      "acp.remote.prompt_text_chars": context?.promptTextChars,
      "acp.remote.prompt_text_hash": context?.promptTextHash,
      "acp.remote.response_has_error": context?.responseHasError,
      "acp.remote.stop_reason": context?.stopReason,
      "acp.remote.update_kind": context?.updateKind,
      "acp.remote.update_text_chars": context?.updateTextChars,
      "acp.remote.update_text_hash": context?.updateTextHash,
      "acp.session.id": context?.sessionId,
      "free.message.id": context?.freeMessageId ??
        context?.promptMessageId ??
        context?.responseUserMessageId ??
        context?.updateMessageId,
      "free.message.prompt_text_chars": context?.promptTextChars,
      "free.message.prompt_text_hash": context?.promptTextHash,
      "free.phase": context?.freePhase,
    },
    {
      severityText,
      spanId: context?.spanId,
      traceId: context?.traceId,
    },
  );
  try {
    appendFileSync(LOG_PATH, line);
    appendClassifiedLog(message, severityText, context);
  } catch (error) {
    process.stderr.write(
      `[bridge] log write failed: ${formatError(error)}\n`,
    );
  }
}

function formatBridgeConsoleLogMessage(
  message: string,
  context?: AcpRemoteBridgeDebugContext,
): string {
  const suffix: string[] = [];
  appendLogSuffix(suffix, "traceId", context?.traceId, message);
  appendLogSuffix(suffix, "spanId", context?.spanId, message);
  return suffix.length > 0 ? `${message} ${suffix.join(" ")}` : message;
}

function appendLogSuffix(
  parts: string[],
  name: string,
  value: string | undefined,
  message: string,
): void {
  if (!value || message.includes(`${name}=`)) {
    return;
  }
  parts.push(`${name}=${value}`);
}

function loadCachedAccountCredential(): AcpRemoteAccountSessionCredential | undefined {
  try {
    const data = JSON.parse(
      readFileSync(join(homedir(), ".free", "account-session.json"), "utf8"),
    ) as unknown;
    if (
      typeof data === "object" &&
      data !== null &&
      "accountSession" in data &&
      "privateKey" in data &&
      typeof (data as { privateKey?: unknown }).privateKey === "string"
    ) {
      return data as AcpRemoteAccountSessionCredential;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readAccountCredentialFromEnv(): AcpRemoteAccountSessionCredential | undefined {
  const value = process.env[ACP_ACCOUNT_SESSION_ENV];
  if (!value) {
    return undefined;
  }
  return decodeAcpRemoteAccountCredential(value);
}

async function resolveBridgeHostId(input: {
  accountCredential: AcpRemoteAccountSessionCredential;
  relayUrl: string;
}): Promise<{
  hosts: HostDiscoveryEntry[];
  primaryHostId: string;
}> {
  const hostsUrl = new URL(
    "/api/hosts",
    input.relayUrl.replace(/^ws(s?):\/\//, "http$1://"),
  );
  const response = await fetch(hostsUrl, {
    headers: {
      Authorization: `Bearer ${
        encodeAcpRemoteAccountSession(input.accountCredential.accountSession)
      }`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Free host discovery failed: ${response.status} ${response.statusText}`,
    );
  }

  const body = await response.json().catch(() => undefined) as
    | { hosts?: unknown }
    | undefined;
  const hosts = Array.isArray(body?.hosts)
    ? body.hosts.filter(isHostDiscoveryEntry)
    : [];
  const onlineHosts = hosts.filter((host) => host.online !== false);
  if (onlineHosts.length === 0) {
    throw new Error("No online Free host found. Run `free auth login` or `free host run` first.");
  }
  if (onlineHosts.length === 1) {
    return {
      hosts,
      primaryHostId: onlineHosts[0].hostId,
    };
  }

  const localMachine = hostname();
  const localHosts = onlineHosts.filter(
    (host) => host.metadata?.machine === localMachine,
  );
  if (localHosts.length > 0) {
    return {
      hosts,
      primaryHostId: localHosts.sort(compareHostDiscoveryEntries)[0].hostId,
    };
  }
  return {
    hosts,
    primaryHostId: onlineHosts.sort(compareHostDiscoveryEntries)[0].hostId,
  };
}

type HostDiscoveryEntry = {
  hostId: string;
  metadata?: {
    machine?: string;
  };
  online?: boolean;
};

function isHostDiscoveryEntry(value: unknown): value is HostDiscoveryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { hostId?: unknown }).hostId === "string" &&
    (value as { hostId: string }).hostId.trim() !== ""
  );
}

function compareHostDiscoveryEntries(
  left: HostDiscoveryEntry,
  right: HostDiscoveryEntry,
): number {
  return left.hostId.localeCompare(right.hostId);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    printHelp();
    return;
  }
  if (argv[0] === "config") {
    const options = parseFreeBridgeConfigArgs(argv.slice(1));
    const stdioConfig = createFreeBridgeStdioConfig(options);
    const zedConfig = createFreeBridgeZedConfig(options);
    if (options.format === "generic") {
      process.stdout.write(`${JSON.stringify(stdioConfig, null, 2)}\n`);
      return;
    }
    if (options.format === "zed") {
      process.stdout.write(`${JSON.stringify(zedConfig, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      [
        "Free Bridge Config",
        "",
        `Command: ${stdioConfig.command}`,
        `Relay URL: ${options.relayUrl ?? ACP_REMOTE_DEFAULT_RELAY_URL}`,
        "",
        "Generic stdio ACP client:",
        JSON.stringify(stdioConfig, null, 2),
        "",
        "Zed custom agent config:",
        JSON.stringify(zedConfig, null, 2),
        "",
      ].join("\n"),
    );
    return;
  }

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(LOG_PATH, "");
    writeFileSync(TEXT_LOG_PATH, "");
    writeFileSync(ERROR_LOG_PATH, "");
  } catch (error) {
    process.stderr.write(
      `[bridge] log initialization failed: ${formatError(error)}\n`,
    );
  }

  const { relayUrl } = parseFreeBridgeRunArgs({
    argv,
    env: process.env,
  });
  const accountCredential =
    readAccountCredentialFromEnv() ?? loadCachedAccountCredential();
  if (!accountCredential) {
    throw new Error(
      `${ACP_ACCOUNT_SESSION_ENV} or ~/.free/account-session.json is required.`,
    );
  }
  const clientId = accountCredential.accountSession.principalId;
  const hostSelection = await resolveBridgeHostId({
    accountCredential,
    relayUrl,
  });
  const hostId = hostSelection.primaryHostId;
  const connectionId = crypto.randomUUID();
  const connectionProofs = await Promise.all(
    hostSelection.hosts.map((host) =>
      createAcpRemoteConnectionProof({
        connectionId,
        credential: accountCredential,
        hostId: host.hostId,
      }),
    ),
  );
  const connectionProof =
    connectionProofs.find((proof) => proof.hostId === hostId) ??
    connectionProofs[0];
  relayLogUploader = createFreeLogUploaderFromEnv({
    accountSession: encodeAcpRemoteAccountSession(
      accountCredential.accountSession,
    ),
    context: {
      "acp.remote.client_id": clientId,
      "acp.remote.host_id": hostId,
    },
    onError(error) {
      process.stderr.write(
        `[bridge] relay log upload failed: ${formatError(error)}\n`,
      );
    },
    relayUrl,
    source: "bridge",
  });
  relayTelemetry = relayLogUploader
    ? configureFreeTelemetry({ uploader: relayLogUploader })
    : undefined;
  const { WebSocket } = await import("ws");
  const debugLog = (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ): void => {
    log(message, context?.severityText ?? "INFO", context);
  };

  const bridge = createAcpRemoteStdioBridge({
    connectionId,
    connectionProof,
    connectionProofs,
    clientId,
    debugLog,
    onClose() {
      log("bridge closed.");
      exitAfterLogUpload(0);
    },
    onError(error) {
      log(`relay connection error: ${error.message}`, "ERROR");
    },
    reconnect: {
      maxDelayMs: 30_000,
      minDelayMs: 1_000,
    },
    relayUrl,
    socketFactory: createAcpRemoteWebSocketFactory(
      WebSocket as unknown as AcpRemoteWebSocketConstructor,
    ),
  });

  log("stdio ACP bridge connected to relay.");
  const stopWatchingBridgeBinary = watchBridgeBinaryForChanges({
    bridgeBinPath: process.argv[1],
    onChange() {
      log(
        "Bridge executable changed on disk. Exiting so the ACP client can restart with the updated code.",
        "INFO",
        {
          eventName: "acp.remote.bridge.executable_changed",
          freePhase: "install_update",
        },
      );
      bridge.close();
      exitAfterLogUpload(0);
    },
  });
  process.on("SIGINT", () => bridge.close());
  process.on("SIGTERM", () => bridge.close());
  process.on("exit", () => stopWatchingBridgeBinary?.());
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free bridge run [--relay-url <ws-url>]",
      "  free bridge config [--relay-url <ws-url>] [--command <path>] [--zed|--all]",
      "",
      "Runtime environment:",
      `  FREE_RELAY_URL              Relay WebSocket URL (default: ${ACP_REMOTE_DEFAULT_RELAY_URL})`,
      "  ACP_ACCOUNT_SESSION        Optional encoded account session credential",
      "",
      "Config options:",
      "  --command        Override the free command path in generated config.",
      "  --format         Output format: generic, zed, or all. Default: generic.",
      "  --legacy-command Generate a config where command contains the full launcher.",
      "  --zed            Shortcut for --format zed.",
      "  --all            Shortcut for --format all.",
      "",
      "The bridge is a generic stdio ACP adapter. Configure stdio-only ACP",
      "clients to launch `free bridge run`. FREE_RELAY_URL is optional for the default relay.",
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  log(error instanceof Error ? error.message : String(error), "ERROR");
  exitAfterLogUpload(1);
});

process.on("uncaughtException", (error) => {
  if (isBrokenPipeError(error)) {
    exitAfterLogUpload(0);
    return;
  }
  log(
    `Uncaught: ${error instanceof Error ? error.message : String(error)}`,
    "ERROR",
  );
  exitAfterLogUpload(1);
});

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EPIPE"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function watchBridgeBinaryForChanges(input: {
  bridgeBinPath: string | undefined;
  onChange(input: { currentMtimeMs: number; initialMtimeMs: number }): void;
}): (() => void) | undefined {
  const initialMtimeMs = readFileMtimeMs(input.bridgeBinPath);
  if (initialMtimeMs === undefined) {
    return undefined;
  }
  const timer = setInterval(() => {
    const currentMtimeMs = readFileMtimeMs(input.bridgeBinPath);
    if (currentMtimeMs === undefined || currentMtimeMs === initialMtimeMs) {
      return;
    }
    clearInterval(timer);
    input.onChange({ currentMtimeMs, initialMtimeMs });
  }, BRIDGE_BINARY_CHANGE_CHECK_INTERVAL_MS);
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

function appendClassifiedLog(
  message: string,
  severityText: "ERROR" | "INFO",
  context?: AcpRemoteBridgeDebugContext,
): void {
  const line = `${JSON.stringify({
    body: message,
    connectionId: context?.connectionId,
    direction: context?.direction,
    eventName: context?.eventName,
    jsonRpcId: context?.jsonRpcId,
    kind: "text",
    method: context?.method,
    observedAt: new Date().toISOString(),
    freeMessageId: context?.freeMessageId,
    freePhase: context?.freePhase,
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
    severityText,
    sessionId: context?.sessionId,
    spanId: context?.spanId,
    source: "bridge",
    stopReason: context?.stopReason,
    traceId: context?.traceId,
    traceparent: context?.traceparent,
    updateKind: context?.updateKind,
    updateTextChars: context?.updateTextChars,
    updateTextHash: context?.updateTextHash,
    updateTextPreview: context?.updateTextPreview,
    updateTextPreviewTruncated: context?.updateTextPreviewTruncated,
  })}\n`;
  appendFileSync(TEXT_LOG_PATH, line);
  if (severityText === "ERROR") {
    appendFileSync(ERROR_LOG_PATH, line);
  }
  if (!context?.sessionId) {
    return;
  }
  const sessionDir = bridgeSessionLogDir(context.sessionId);
  mkdirSync(sessionDir, { recursive: true });
  appendFileSync(join(sessionDir, "bridge.log.text.jsonl"), line);
  if (severityText === "ERROR") {
    appendFileSync(join(sessionDir, "bridge.log.errors.jsonl"), line);
  }
}

function bridgeSessionLogDir(sessionId: string): string {
  return join(
    LOG_DIR,
    "logs",
    "sessions",
    sessionId.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session",
  );
}

function exitAfterLogUpload(code: number): void {
  if (exiting) {
    return;
  }
  exiting = true;
  void (relayTelemetry?.close() ?? relayLogUploader?.close() ?? Promise.resolve())
    .catch((error) => {
      process.stderr.write(
        `[bridge] relay log shutdown failed: ${formatError(error)}\n`,
      );
    })
    .finally(() => {
      process.exit(code);
    });
}
