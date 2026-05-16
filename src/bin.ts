#!/usr/bin/env node

import { spawn } from "node:child_process";

import { runFreeAuthCommand } from "./auth-bin.js";
import { runFreeBridgeCommand } from "./client/relay-bridge.js";
import { runFreeHostCommand } from "./host/bin.js";
import {
  connectAcpRuntimeServiceClient,
  runAcpRuntimeService,
  type AcpRuntimeServiceManagedSession,
} from "./host/runtime-service.js";
import { resolveCurrentFreeExecutablePath } from "./launcher.js";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "auth") {
    await runFreeAuthCommand(rest);
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
  if (command === "runtime") {
    await runFreeRuntimeCommand(rest);
    return;
  }
  if (command === "runtime-service") {
    if (rest[0] && rest[0] !== "run") {
      throw new Error(`Unknown runtime-service command: ${rest[0]}`);
    }
    await runAcpRuntimeService();
    return;
  }
  throw new Error(`Unknown free command: ${command}`);
}

async function runFreeRuntimeCommand(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printRuntimeHelp();
    return;
  }
  if (command === "status") {
    const client = await connectAcpRuntimeServiceClient({});
    try {
      const status = await client.management.status();
      process.stdout.write(
        [
          `runtime: ${status.instanceId}`,
          `sessions: ${status.sessionCount}`,
          `active turns: ${status.activeTurns}`,
          `attached clients: ${status.peerCount}`,
        ].join("\n") + "\n",
      );
    } finally {
      client.close();
    }
    return;
  }
  if (command === "sessions") {
    await runFreeRuntimeSessionsCommand(rest);
    return;
  }
  throw new Error(`Unknown runtime command: ${command}`);
}

async function runFreeRuntimeSessionsCommand(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printRuntimeSessionsHelp();
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
        process.stdout.write(`Closed ${sessions.length} runtime session(s).\n`);
        return;
      }
      const sessionId = rest[0];
      if (!sessionId) {
        throw new Error("Missing runtime session id.");
      }
      await client.management.closeSession(sessionId);
      process.stdout.write(`Closed runtime session ${sessionId}.\n`);
      return;
    }
  } finally {
    client.close();
  }
  throw new Error(`Unknown runtime sessions command: ${command}`);
}

function printManagedSessions(sessions: readonly AcpRuntimeServiceManagedSession[]): void {
  if (sessions.length === 0) {
    process.stdout.write("No managed ACP runtime sessions.\n");
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

function printRuntimeHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free runtime status",
      "  free runtime sessions list",
      "  free runtime sessions close <session-id>",
      "  free runtime sessions close --all",
      "",
      "Lifecycle:",
      "  Runtime sessions are owned by the local ACP runtime service.",
      "  Host restarts do not close managed ACP sessions.",
      "  ACP session/close and runtime sessions close release the underlying ACP agent process.",
    ].join("\n") + "\n",
  );
}

function printRuntimeSessionsHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  free runtime sessions list",
      "  free runtime sessions close <session-id>",
      "  free runtime sessions close --all",
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
      "  free auth login",
      "  free auth status",
      "  free auth logout",
      "  free bridge run",
      "  free bridge config",
      "  free host run",
      "  free host install",
      "",
      "free auth login signs in and starts the local Free host service.",
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
