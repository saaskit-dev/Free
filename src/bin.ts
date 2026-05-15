#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "auth") {
    await runInternalBin("auth-bin.js", rest);
    return;
  }
  if (command === "bridge") {
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      await runInternalBin("client/relay-bridge.js", ["--help"]);
      return;
    }
    if (rest[0] === "config") {
      await runInternalBin("client/relay-bridge.js", rest);
      return;
    }
    const bridgeArgs = rest[0] === "run" ? rest.slice(1) : rest;
    await runSupervisedBridgeBin(bridgeArgs);
    return;
  }
  if (command === "host") {
    await runInternalBin("host/bin.js", rest);
    return;
  }
  throw new Error(`Unknown free command: ${command}`);
}

function runInternalBin(relativePath: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const binPath = join(dirname(fileURLToPath(import.meta.url)), relativePath);
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

function runSupervisedBridgeBin(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const binPath = join(dirname(fileURLToPath(import.meta.url)), "client/relay-bridge.js");
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
      child = spawn(process.execPath, [binPath, ...args], {
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
