import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ci = Boolean(process.env.CI);

import { connectAcpRuntimeServiceClient } from "./runtime-service.js";

const children: ChildProcess[] = [];
const tempDirs: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));
const previousSocketPath = process.env.FREE_RUNTIME_SERVICE_SOCKET_PATH;
const cliRuntime = (process.versions as { bun?: string }).bun
  ? process.execPath
  : "bun";

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true,
  })));
  if (previousSocketPath === undefined) {
    delete process.env.FREE_RUNTIME_SERVICE_SOCKET_PATH;
  } else {
    process.env.FREE_RUNTIME_SERVICE_SOCKET_PATH = previousSocketPath;
  }
});

describe.skipIf(ci)("ACP runtime service", () => {
  it("keeps an in-flight turn alive after the host client disconnects and reattaches", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "free-runtime-service-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "runtime.sock");
    const child = spawn(cliRuntime, ["src/bin.ts", "host", "runtime-service"], {
      cwd: resolve(testDir, "../.."),
      env: {
        ...process.env,
        FREE_RUNTIME_SERVICE_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForRuntimeService(socketPath);

    const client1 = await connectAcpRuntimeServiceClient({});
    const session = await client1.sessions.start({
      agent: {
        args: [resolve(testDir, "../../../acp-runtime/packages/simulator-agent/dist/cli.js")],
        command: process.execPath,
        type: "simulator",
      },
      cwd: tempDir,
    });
    await session.turn.send("/simulate timeout-next-prompt");

    const requestKey = "conn-1:prompt-1";
    const firstTurn = session.turn.start("continue after host restart", {
      acpRuntimeRequestKey: requestKey,
    } as never);
    await waitForFirstEvent(firstTurn.events);
    client1.close();

    const client2 = await connectAcpRuntimeServiceClient({});
    const reattached = await client2.sessions.load({
      agent: {
        args: [resolve(testDir, "../../../acp-runtime/packages/simulator-agent/dist/cli.js")],
        command: process.execPath,
        type: "simulator",
      },
      cwd: tempDir,
      sessionId: session.metadata.id,
    });
    const secondTurn = reattached.turn.start("continue after host restart", {
      acpRuntimeRequestKey: requestKey,
    } as never);

    await expect(secondTurn.completion).resolves.toMatchObject({
      outputText: expect.stringContaining("continue after host restart"),
    });
    const managedBeforeClose = await client2.management.listSessions();
    expect(managedBeforeClose).toEqual([
      expect.objectContaining({
        activeTurns: 0,
        id: session.metadata.id,
      }),
    ]);
    await client2.management.closeSession(session.metadata.id);
    await expect(client2.management.listSessions()).resolves.toEqual([]);
    client2.close();
  }, 15_000);

  it("exits on SIGTERM when it owns an open ACP runtime session", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "free-runtime-service-term-"));
    tempDirs.push(tempDir);
    const socketPath = join(tempDir, "runtime.sock");
    const child = spawn(cliRuntime, ["src/bin.ts", "host", "runtime-service"], {
      cwd: resolve(testDir, "../.."),
      env: {
        ...process.env,
        FREE_RUNTIME_SERVICE_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForRuntimeService(socketPath);

    const client = await connectAcpRuntimeServiceClient({});
    await client.sessions.start({
      agent: {
        args: [resolve(testDir, "../../../acp-runtime/packages/simulator-agent/dist/cli.js")],
        command: process.execPath,
        type: "simulator",
      },
      cwd: tempDir,
    });
    await expect(client.management.listSessions()).resolves.toHaveLength(1);
    client.close();

    child.kill("SIGTERM");
    await expect(waitForChildExit(child, 5_000)).resolves.toBeUndefined();
  }, 10_000);
});

async function waitForRuntimeService(socketPath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    process.env.FREE_RUNTIME_SERVICE_SOCKET_PATH = socketPath;
    try {
      const client = await connectAcpRuntimeServiceClient({});
      client.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Runtime service did not start.");
}

async function waitForFirstEvent(
  events: AsyncIterable<unknown>,
): Promise<void> {
  for await (const _event of events) {
    return;
  }
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      once(child, "exit"),
      new Promise((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Runtime service did not exit.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
