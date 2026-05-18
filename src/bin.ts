#!/usr/bin/env node

import { spawn } from "node:child_process";

import { runFreeAuthCommand } from "./auth-bin.js";
import { runFreeBridgeCommand } from "./client/relay-bridge.js";
import { runFreeHostCommand } from "./host/bin.js";
import {
  connectAcpRuntimeServiceClient,
  type AcpRuntimeServiceManagedSession,
} from "./host/runtime-service.js";
import { resolveCurrentFreeExecutablePath } from "./launcher.js";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "login") {
    await runFreeAuthCommand(["login", ...rest]);
    return;
  }
  if (command === "logout") {
    await runFreeAuthCommand(["logout", ...rest]);
    return;
  }
  if (command === "auth") {
    await runFreeAuthCommand(rest);
    return;
  }
  if (command === "status") {
    await runFreeStatusCommand(rest);
    return;
  }
  if (command === "bridge") {
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      await runFreeBridgeCommand(["--help"]);
      return;
    }
    if (rest[0] === "config") {
      await runFreeBridgeCommand(rest);
      return;
    }
    if (rest[0] === "run-internal") {
      await runFreeBridgeCommand(rest.slice(1));
      return;
    }
    const bridgeArgs = rest[0] === "run" ? rest.slice(1) : rest;
    await runSupervisedBridge(bridgeArgs);
    return;
  }
  if (command === "host") {
    await runFreeHostCommand(rest);
    return;
  }
  if (command === "session" || command === "sessions") {
    await runFreeSessionCommand(rest);
    return;
  }
  throw new Error(`Unknown free command: ${command}`);
}

async function runFreeStatusCommand(argv: readonly string[]): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    printStatusHelp();
    return;
  }
  await runFreeAuthCommand(["status", ...argv]);
  try {
    const client = await connectAcpRuntimeServiceClient({});
    try {
      const status = await client.management.status();
      process.stdout.write(
        [
          `runtimeService: ${status.instanceId}`,
          `sessions: ${status.sessionCount}`,
          `active turns: ${status.activeTurns}`,
          `attached clients: ${status.peerCount}`,
        ].join("\n") + "\n",
      );
    } finally {
      client.close();
    }
  } catch (error) {
    process.stdout.write(
      `runtimeService: unavailable (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
}

function printStatusHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free status [--relay-env online|local]",
      "  free status [--relay-url <ws-url>]",
    ].join("\n") + "\n",
  );
}

async function runFreeSessionCommand(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printSessionHelp();
    return;
  }
  const client = await connectAcpRuntimeServiceClient({});
  try {
    if (command === "list") {
      printManagedSessions(await client.management.listSessions());
      return;
    }
    if (command === "close") {
      if (rest[0] === "--all") {
        const sessions = await client.management.listSessions();
        for (const session of sessions) {
          await client.management.closeSession(session.id);
        }
        process.stdout.write(`Closed ${sessions.length} session(s).\n`);
        return;
      }
      const sessionId = rest[0];
      if (!sessionId) {
        throw new Error("Missing session id.");
      }
      await client.management.closeSession(sessionId);
      process.stdout.write(`Closed session ${sessionId}.\n`);
      return;
    }
  } finally {
    client.close();
  }
  throw new Error(`Unknown session command: ${command}`);
}

function printManagedSessions(sessions: readonly AcpRuntimeServiceManagedSession[]): void {
  if (sessions.length === 0) {
    process.stdout.write("No managed Free sessions.\n");
    return;
  }
  const rows = sessions.map((session) => [
    session.id,
    session.status,
    String(session.activeTurns),
    session.updatedAt ?? "-",
    session.title ?? "-",
  ]);
  const headers = ["SESSION", "STATUS", "ACTIVE_TURNS", "UPDATED", "TITLE"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  process.stdout.write(`${formatRuntimeRow(headers, widths)}\n`);
  for (const row of rows) {
    process.stdout.write(`${formatRuntimeRow(row, widths)}\n`);
  }
}

function formatRuntimeRow(row: readonly string[], widths: readonly number[]): string {
  return row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ");
}

function printSessionHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free session list",
      "  free session close <session-id>",
      "  free session close --all",
    ].join("\n") + "\n",
  );
}

function runSupervisedBridge(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const launcher = resolveCurrentFreeLauncher();
    let child: ReturnType<typeof spawn> | undefined;
    let stopping = false;
    let restartCount = 0;
    let restartWindowStartedAt = 0;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const stop = (signal: NodeJS.Signals) => {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
      }
      child?.kill(signal);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    const start = () => {
      child = spawn(launcher.command, [...launcher.args, "bridge", "run-internal", ...args], {
        stdio: "inherit",
      });
      const startedAt = Date.now();
      child.on("error", (error) => {
        cleanup();
        reject(error);
      });
      child.on("exit", (code, signal) => {
        if (stopping) {
          cleanup();
          if (signal) {
            process.kill(process.pid, signal);
            return;
          }
          process.exitCode = code ?? 0;
          resolve();
          return;
        }
        const now = Date.now();
        if (now - restartWindowStartedAt > 60_000) {
          restartWindowStartedAt = now;
          restartCount = 0;
        }
        restartCount += 1;
        if (restartCount > 5) {
          cleanup();
          process.stderr.write(
            "[bridge-supervisor] bridge exited too many times; giving up.\n",
          );
          process.exitCode = code ?? (signal ? 1 : 0);
          resolve();
          return;
        }
        const ranLongEnough = now - startedAt > 5_000;
        const delayMs = ranLongEnough ? 250 : Math.min(1000 * restartCount, 5000);
        process.stderr.write(
          `[bridge-supervisor] bridge exited${signal ? ` by ${signal}` : ` with code ${code ?? 0}`}; restarting in ${delayMs}ms.\n`,
        );
        restartTimer = setTimeout(() => {
          restartTimer = undefined;
          start();
        }, delayMs);
      });
    };

    start();
  });
}

function resolveCurrentFreeLauncher(): { args: string[]; command: string } {
  return { args: [], command: resolveCurrentFreeExecutablePath() };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free login",
      "  free logout",
      "  free status",
      "  free session list",
      "  free session close <session-id>",
      "  free session close --all",
      "",
      "free login signs in and enables this machine.",
      "Default relay environment is online. Use --relay-env local for ws://127.0.0.1:8791.",
      "",
      "Run a subcommand with --help for details.",
    ].join("\n") + "\n",
  );
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
