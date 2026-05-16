import { spawn } from "node:child_process";
import { createServer, createConnection, type Socket, type Server } from "node:net";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AcpRuntime,
  createStdioAcpConnectionFactory,
  type AcpRuntimeAgentInput,
  type AcpRuntimeAuthorityHandlers,
  type AcpRuntimeConfigValue,
  type AcpRuntimeListSessionsOptions,
  type AcpRuntimeMcpServer,
  type AcpRuntimePrompt,
  type AcpRuntimeSession,
  type AcpRuntimeSessionList,
  type AcpRuntimeStartSessionOptions,
  type AcpRuntimeTerminalStartRequest,
  type AcpRuntimeTurnCompletion,
  type AcpRuntimeTurnEvent,
} from "@saaskit-dev/acp-runtime";

import { resolveCurrentFreeExecutablePath } from "../launcher.js";
import { formatError, isRecord } from "../shared/fs-utils.js";

type JsonRpcId = string | number;

type RuntimeServiceRequest = {
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type RuntimeServiceResponse = {
  error?: { message: string };
  id: JsonRpcId;
  result?: unknown;
};

type RuntimeServiceNotification = {
  method: string;
  params?: unknown;
};

type RuntimeServiceMessage =
  | RuntimeServiceRequest
  | RuntimeServiceResponse
  | RuntimeServiceNotification;

type RuntimeSessionDescriptor = {
  capabilities: AcpRuntimeSession["capabilities"];
  diagnostics: AcpRuntimeSession["diagnostics"];
  history: ReturnType<AcpRuntimeSession["state"]["history"]["drain"]>;
  initialConfigReport?: AcpRuntimeSession["initialConfigReport"];
  metadata: AcpRuntimeSession["metadata"];
  snapshot: ReturnType<AcpRuntimeSession["snapshot"]>;
  status: AcpRuntimeSession["status"];
  thread: ReturnType<AcpRuntimeSession["state"]["thread"]["entries"]>;
};

type RuntimeTurnRecord = {
  completion?: AcpRuntimeTurnCompletion;
  completedAt?: string;
  events: AcpRuntimeTurnEvent[];
  requestKey: string;
  sessionId: string;
  startedAt: string;
  subscribers: Set<RuntimeServicePeer>;
  turnId: string;
};

type RuntimeServicePeer = {
  pending: Map<JsonRpcId, {
    reject(error: Error): void;
    resolve(value: unknown): void;
  }>;
  send(message: RuntimeServiceMessage): void;
  socket: Socket;
};

const RUNTIME_SERVICE_SOCKET_PATH = join(
  homedir(),
  ".free",
  "runtime-service.sock",
);
const RUNTIME_SERVICE_SOCKET_PATH_ENV_VAR = "FREE_RUNTIME_SERVICE_SOCKET_PATH";
const RUNTIME_SERVICE_START_TIMEOUT_MS = 10_000;

export type AcpRuntimeServiceClient = {
  close(): void;
  instanceId(): string;
  isClosed(): boolean;
  management: {
    closeSession(sessionId: string): Promise<void>;
    listSessions(): Promise<AcpRuntimeServiceManagedSession[]>;
    status(): Promise<AcpRuntimeServiceStatus>;
  };
  sessions: {
    list(options?: AcpRuntimeListSessionsOptions): Promise<AcpRuntimeSessionList>;
    load(options: RuntimeOpenOptions): Promise<AcpRuntimeSession>;
    resume(options: RuntimeOpenOptions): Promise<AcpRuntimeSession>;
    start(options: AcpRuntimeStartSessionOptions): Promise<AcpRuntimeSession>;
  };
};

export type AcpRuntimeServiceManagedSession = {
  activeTurns: number;
  id: string;
  status: AcpRuntimeSession["status"];
  title?: string;
  updatedAt?: string;
};

export type AcpRuntimeServiceStatus = {
  activeTurns: number;
  instanceId: string;
  peerCount: number;
  sessionCount: number;
};

type RuntimeOpenOptions = {
  agent?: AcpRuntimeAgentInput;
  cwd?: string;
  handlers?: AcpRuntimeAuthorityHandlers;
  mcpServers?: readonly AcpRuntimeMcpServer[];
  sessionId: string;
  _traceContext?: import("@opentelemetry/api").Context;
};

export async function ensureAcpRuntimeService(): Promise<AcpRuntimeServiceClient> {
  const existing = await tryConnectRuntimeService();
  if (existing) {
    return existing;
  }

  await mkdir(dirname(runtimeServiceSocketPath()), { recursive: true });
  const launcher = resolveCurrentFreeExecutablePath();
  const child = spawn(launcher ?? process.argv[1] ?? "free", [
    "runtime-service",
    "run",
  ], {
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < RUNTIME_SERVICE_START_TIMEOUT_MS) {
    await delay(100);
    const client = await tryConnectRuntimeService();
    if (client) {
      return client;
    }
  }
  throw new Error("ACP runtime service did not become ready.");
}

export function createRestartingAcpRuntimeServiceClient(): AcpRuntimeServiceClient {
  let client: AcpRuntimeServiceClient | undefined;

  const getClient = async (): Promise<AcpRuntimeServiceClient> => {
    if (!client || client.isClosed()) {
      client = await ensureAcpRuntimeService();
    }
    return client;
  };

  const run = async <T>(
    operation: (runtime: AcpRuntimeServiceClient) => Promise<T>,
  ): Promise<T> => {
    const runtime = await getClient();
    try {
      return await operation(runtime);
    } catch (error) {
      if (isRuntimeServiceConnectionClosedError(error)) {
        client = undefined;
      }
      throw error;
    }
  };

  return {
    close() {
      client?.close();
      client = undefined;
    },
    instanceId() {
      return client?.instanceId() ?? "pending";
    },
    isClosed() {
      return !client || client.isClosed();
    },
    management: {
      closeSession: (sessionId) =>
        run((runtime) => runtime.management.closeSession(sessionId)),
      listSessions: () =>
        run((runtime) => runtime.management.listSessions()),
      status: () =>
        run((runtime) => runtime.management.status()),
    },
    sessions: {
      list: (options) =>
        run((runtime) => runtime.sessions.list(options)),
      load: (options) =>
        run((runtime) => runtime.sessions.load(options)),
      resume: (options) =>
        run((runtime) => runtime.sessions.resume(options)),
      start: (options) =>
        run((runtime) => runtime.sessions.start(options)),
    },
  };
}

export async function runAcpRuntimeService(): Promise<void> {
  const socketPath = runtimeServiceSocketPath();
  await mkdir(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) {
    await rm(socketPath, { force: true });
  }
  const service = new RuntimeService();
  const server = createServer((socket) => service.accept(socket));
  await listen(server, socketPath);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    service.disconnectPeers("ACP runtime service is shutting down.");
    server.close(() => process.exit(0));
    const forceExit = setTimeout(() => process.exit(0), 3_000);
    forceExit.unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>((resolve) => server.once("close", resolve));
}

class RuntimeService {
  private readonly instanceId = randomUUID();
  private readonly peers = new Set<RuntimeServicePeer>();
  private readonly runtime = new AcpRuntime(createStdioAcpConnectionFactory());
  private readonly sessions = new Map<string, AcpRuntimeSession>();
  private readonly turnsByRequestKey = new Map<string, RuntimeTurnRecord>();

  accept(socket: Socket): void {
    const peer: RuntimeServicePeer = {
      pending: new Map(),
      send(message) {
        socket.write(`${JSON.stringify(message)}\n`);
      },
      socket,
    };
    this.peers.add(peer);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) {
          break;
        }
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void this.handleLine(peer, line);
      }
    });
    socket.once("close", () => {
      this.peers.delete(peer);
      for (const pending of peer.pending.values()) {
        pending.reject(new Error("Runtime service peer disconnected."));
      }
      peer.pending.clear();
      for (const turn of this.turnsByRequestKey.values()) {
        turn.subscribers.delete(peer);
      }
    });
  }

  private async handleLine(peer: RuntimeServicePeer, line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line) as RuntimeServiceMessage;
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = peer.pending.get(message.id);
      if (!pending) {
        return;
      }
      peer.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!("id" in message) || !("method" in message)) {
      return;
    }
    try {
      const result = await this.handleRequest(peer, message);
      peer.send({ id: message.id, result });
    } catch (error) {
      peer.send({
        error: { message: formatError(error) },
        id: message.id,
      });
    }
  }

  private async handleRequest(
    peer: RuntimeServicePeer,
    request: RuntimeServiceRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case "hello":
        return { instanceId: this.instanceId };
      case "runtime/status":
        return this.runtimeStatus();
      case "runtime/sessions/list":
        return this.managedSessions();
      case "runtime/sessions/close": {
        const params = asRecord(request.params);
        await this.closeSession(String(params.sessionId));
        return {};
      }
      case "sessions/list": {
        const params = asRecord(request.params);
        return this.runtime.sessions.list(params as AcpRuntimeListSessionsOptions);
      }
      case "sessions/start": {
        const params = asRecord(request.params);
        const session = await this.runtime.sessions.start({
          ...(params as Omit<AcpRuntimeStartSessionOptions, "handlers">),
          handlers: this.createAuthorityHandlers(peer),
        } as AcpRuntimeStartSessionOptions);
        this.sessions.set(session.metadata.id, session);
        return describeRuntimeSession(session);
      }
      case "sessions/load":
      case "sessions/resume": {
        const params = asRecord(request.params);
        const opener =
          request.method === "sessions/load"
            ? this.runtime.sessions.load
            : this.runtime.sessions.resume;
        const session = await opener({
          ...(params as Omit<RuntimeOpenOptions, "handlers">),
          handlers: this.createAuthorityHandlers(peer),
        } as Parameters<typeof opener>[0]);
        this.sessions.set(session.metadata.id, session);
        this.sessions.set(String(params.sessionId), session);
        return describeRuntimeSession(session);
      }
      case "session/close": {
        const params = asRecord(request.params);
        await this.closeSession(String(params.sessionId));
        return {};
      }
      case "session/setMode": {
        const params = asRecord(request.params);
        await this.requireSession(params.sessionId).agent.setMode(String(params.modeId));
        return {};
      }
      case "session/setConfigOption": {
        const params = asRecord(request.params);
        await this.requireSession(params.sessionId).agent.setConfigOption(
          String(params.configId),
          params.value as AcpRuntimeConfigValue,
        );
        return {};
      }
      case "session/drainHistory": {
        const params = asRecord(request.params);
        return this.requireSession(params.sessionId).state.history.drain();
      }
      case "session/threadEntries": {
        const params = asRecord(request.params);
        return this.requireSession(params.sessionId).state.thread.entries();
      }
      case "turn/start":
        return this.startOrAttachTurn(peer, asRecord(request.params));
      case "turn/cancel": {
        const params = asRecord(request.params);
        return this.requireSession(params.sessionId).turn.cancel(String(params.turnId));
      }
      default:
        throw new Error(`Unknown runtime service method: ${request.method}`);
    }
  }

  private startOrAttachTurn(
    peer: RuntimeServicePeer,
    params: Record<string, unknown>,
  ): { replayed: boolean; turnId: string } {
    const sessionId = String(params.sessionId);
    const requestKey = readOptionalString(params.requestKey) ?? randomUUID();
    const existing = this.turnsByRequestKey.get(requestKey);
    if (existing) {
      existing.subscribers.add(peer);
      for (const event of existing.events) {
        peer.send({
          method: "turn/event",
          params: { event, requestKey, turnId: existing.turnId },
        });
      }
      if (existing.completion) {
        peer.send({
          method: "turn/completion",
          params: {
            completion: existing.completion,
            requestKey,
            turnId: existing.turnId,
          },
        });
      }
      return { replayed: true, turnId: existing.turnId };
    }

    const session = this.requireSession(sessionId);
    const turn = session.turn.start(params.prompt as AcpRuntimePrompt);
    const record: RuntimeTurnRecord = {
      events: [],
      requestKey,
      sessionId,
      startedAt: new Date().toISOString(),
      subscribers: new Set([peer]),
      turnId: turn.turnId,
    };
    this.turnsByRequestKey.set(requestKey, record);
    void this.pumpTurn(record, turn.events, turn.completion);
    return { replayed: false, turnId: turn.turnId };
  }

  private async pumpTurn(
    record: RuntimeTurnRecord,
    events: AsyncIterable<AcpRuntimeTurnEvent>,
    completion: Promise<AcpRuntimeTurnCompletion>,
  ): Promise<void> {
    try {
      for await (const event of events) {
        record.events.push(event);
        this.broadcast(record, "turn/event", { event });
      }
      record.completion = await completion;
      record.completedAt = new Date().toISOString();
      this.broadcast(record, "turn/completion", {
        completion: record.completion,
      });
    } catch (error) {
      this.broadcast(record, "turn/error", { message: formatError(error) });
    }
  }

  private broadcast(
    record: RuntimeTurnRecord,
    method: string,
    params: Record<string, unknown>,
  ): void {
    for (const subscriber of record.subscribers) {
      subscriber.send({
        method,
        params: {
          ...params,
          requestKey: record.requestKey,
          turnId: record.turnId,
        },
      });
    }
  }

  private requireSession(sessionId: unknown): AcpRuntimeSession {
    const session = this.sessions.get(String(sessionId));
    if (!session) {
      throw new Error(`Unknown runtime service session: ${String(sessionId)}`);
    }
    return session;
  }

  private runtimeStatus(): AcpRuntimeServiceStatus {
    return {
      activeTurns: [...this.turnsByRequestKey.values()].filter(
        (turn) => !turn.completedAt,
      ).length,
      instanceId: this.instanceId,
      peerCount: this.peers.size,
      sessionCount: new Set(this.sessions.values()).size,
    };
  }

  private managedSessions(): AcpRuntimeServiceManagedSession[] {
    const unique = [...new Set(this.sessions.values())];
    return unique.map((session) => ({
      activeTurns: [...this.turnsByRequestKey.values()].filter(
        (turn) => turn.sessionId === session.metadata.id && !turn.completedAt,
      ).length,
      id: session.metadata.id,
      status: session.status,
      title: session.metadata.title,
      updatedAt: session.metadata.updatedAt,
    }));
  }

  private async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await session.close();
    for (const [alias, candidate] of [...this.sessions.entries()]) {
      if (candidate === session) {
        this.sessions.delete(alias);
      }
    }
    for (const [requestKey, turn] of [...this.turnsByRequestKey.entries()]) {
      if (turn.sessionId === session.metadata.id) {
        this.turnsByRequestKey.delete(requestKey);
      }
    }
  }

  disconnectPeers(reason: string): void {
    this.turnsByRequestKey.clear();
    for (const peer of [...this.peers]) {
      for (const pending of peer.pending.values()) {
        pending.reject(new Error(reason));
      }
      peer.pending.clear();
      peer.socket.destroy();
    }
    this.peers.clear();
  }

  private createAuthorityHandlers(peer: RuntimeServicePeer): AcpRuntimeAuthorityHandlers {
    return {
      filesystem: {
        readTextFile: async (path) => {
          const result = await this.requestAuthority(peer, "authority/fsRead", { path });
          return String(asRecord(result).content ?? "");
        },
        writeTextFile: async (input) => {
          await this.requestAuthority(peer, "authority/fsWrite", input);
        },
      },
      permission: async (request) =>
        this.requestAuthority(peer, "authority/permission", request) as ReturnType<
          NonNullable<AcpRuntimeAuthorityHandlers["permission"]>
        >,
      terminal: {
        kill: async (terminalId) => {
          await this.requestAuthority(peer, "authority/terminalKill", { terminalId });
        },
        output: async (terminalId) =>
          this.requestAuthority(peer, "authority/terminalOutput", {
            terminalId,
          }) as ReturnType<
            NonNullable<AcpRuntimeAuthorityHandlers["terminal"]>["output"]
          >,
        release: async (terminalId) => {
          await this.requestAuthority(peer, "authority/terminalRelease", {
            terminalId,
          });
        },
        start: async (request: AcpRuntimeTerminalStartRequest) =>
          this.requestAuthority(peer, "authority/terminalStart", request) as ReturnType<
            NonNullable<AcpRuntimeAuthorityHandlers["terminal"]>["start"]
          >,
        wait: async (terminalId) =>
          this.requestAuthority(peer, "authority/terminalWait", {
            terminalId,
          }) as ReturnType<
            NonNullable<AcpRuntimeAuthorityHandlers["terminal"]>["wait"]
          >,
      },
    };
  }

  private requestAuthority(
    preferredPeer: RuntimeServicePeer,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const peer = this.peers.has(preferredPeer)
      ? preferredPeer
      : this.peers.values().next().value;
    if (!peer) {
      return Promise.reject(new Error("No host is attached to the runtime service."));
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      peer.pending.set(id, { reject, resolve });
      peer.send({ id, method, params });
    });
  }
}

class RuntimeServiceClientSession {
  readonly agent = {
    listConfigOptions: () => [],
    listModes: () => [],
    setConfigOption: (id: string, value: AcpRuntimeConfigValue) =>
      this.client.request("session/setConfigOption", {
        configId: id,
        sessionId: this.metadata.id,
        value,
      }).then(() => {}),
    setMode: (modeId: string) =>
      this.client.request("session/setMode", {
        modeId,
        sessionId: this.metadata.id,
      }).then(() => {}),
  };

  readonly queue = {
    policy: () => ({ delivery: "sequential" as const }),
    setPolicy: () => ({ delivery: "sequential" as const }),
  };

  readonly state = {
    diffs: emptyStateCollection,
    history: {
      drain: () => this.history,
    },
    operations: emptyStateCollection,
    permissions: emptyStateCollection,
    terminals: emptyStateCollection,
    thread: {
      entries: () => this.threadEntries,
    },
    toolCalls: emptyStateCollection,
    metadata: () => this.metadata,
    usage: () => undefined,
    watch: () => () => {},
  };

  readonly turn = {
    cancel: (turnId: string) =>
      this.client.request("turn/cancel", {
        sessionId: this.metadata.id,
        turnId,
      }) as Promise<boolean>,
    queue: {
      clear: () => 0,
      get: () => undefined,
      list: () => [],
      remove: () => false,
      sendNow: async () => false,
    },
    run: async (prompt: AcpRuntimePrompt) => {
      const completion = await this.turn.send(prompt);
      return completion.outputText;
    },
    send: async (prompt: AcpRuntimePrompt) => this.turn.start(prompt).completion,
    start: (prompt: AcpRuntimePrompt, options?: { _traceContext?: unknown }) =>
      this.client.startTurn(this.metadata.id, prompt, options),
    stream: (prompt: AcpRuntimePrompt, options?: { _traceContext?: unknown }) =>
      this.turn.start(prompt, options).events,
  };

  constructor(
    private readonly client: RuntimeServiceClient,
    descriptor: RuntimeSessionDescriptor,
  ) {
    this.capabilities = descriptor.capabilities;
    this.diagnostics = descriptor.diagnostics;
    this.history = [...descriptor.history];
    this.initialConfigReport = descriptor.initialConfigReport;
    this.metadata = descriptor.metadata;
    this.snapshotValue = descriptor.snapshot;
    this.threadEntries = [...descriptor.thread];
  }

  readonly capabilities: AcpRuntimeSession["capabilities"];
  readonly diagnostics: AcpRuntimeSession["diagnostics"];
  private readonly history: ReturnType<AcpRuntimeSession["state"]["history"]["drain"]>;
  readonly initialConfigReport: AcpRuntimeSession["initialConfigReport"];
  readonly metadata: AcpRuntimeSession["metadata"];
  private readonly snapshotValue: ReturnType<AcpRuntimeSession["snapshot"]>;
  private readonly threadEntries: ReturnType<AcpRuntimeSession["state"]["thread"]["entries"]>;

  get status(): AcpRuntimeSession["status"] {
    return "ready";
  }

  close(): Promise<void> {
    return this.client.request("session/close", { sessionId: this.metadata.id }).then(
      () => {},
    );
  }

  snapshot(): ReturnType<AcpRuntimeSession["snapshot"]> {
    return this.snapshotValue;
  }
}

class RuntimeServiceClient implements AcpRuntimeServiceClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    reject(error: Error): void;
    resolve(value: unknown): void;
  }>();
  private readonly turns = new Map<string, RuntimeClientTurn>();
  private instanceIdValue = "";
  private closed = false;
  private closing = false;

  readonly management = {
    closeSession: (sessionId: string) =>
      this.request("runtime/sessions/close", { sessionId }).then(() => {}),
    listSessions: () =>
      this.request("runtime/sessions/list", {}) as Promise<
        AcpRuntimeServiceManagedSession[]
      >,
    status: () =>
      this.request("runtime/status", {}) as Promise<AcpRuntimeServiceStatus>,
  };

  readonly sessions = {
    list: (options: AcpRuntimeListSessionsOptions = {}) =>
      this.request("sessions/list", options) as Promise<AcpRuntimeSessionList>,
    load: async (options: RuntimeOpenOptions) =>
      new RuntimeServiceClientSession(
        this,
        await this.request("sessions/load", withRuntimeHandlers(this, options)) as RuntimeSessionDescriptor,
      ) as unknown as AcpRuntimeSession,
    resume: async (options: RuntimeOpenOptions) =>
      new RuntimeServiceClientSession(
        this,
        await this.request("sessions/resume", withRuntimeHandlers(this, options)) as RuntimeSessionDescriptor,
      ) as unknown as AcpRuntimeSession,
    start: async (options: AcpRuntimeStartSessionOptions) =>
      new RuntimeServiceClientSession(
        this,
        await this.request("sessions/start", withRuntimeHandlers(this, options)) as RuntimeSessionDescriptor,
      ) as unknown as AcpRuntimeSession,
  };

  constructor(
    private readonly socket: Socket,
    private handlers: AcpRuntimeAuthorityHandlers,
  ) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) {
          break;
        }
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        void this.handleLine(line);
      }
    });
    socket.once("close", () => {
      this.closed = true;
      if (this.closing) {
        return;
      }
      const error = new Error(
        "ACP runtime service connection closed. The current ACP turn did not complete; resend the message after the service restarts.",
      );
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      for (const turn of this.turns.values()) {
        turn.fail(error);
      }
      this.turns.clear();
    });
  }

  async initialize(): Promise<void> {
    const hello = asRecord(await this.request("hello", {}));
    this.instanceIdValue = String(hello.instanceId);
  }

  instanceId(): string {
    return this.instanceIdValue;
  }

  close(): void {
    this.closing = true;
    this.closed = true;
    this.socket.destroy();
  }

  isClosed(): boolean {
    return this.closed || this.socket.destroyed;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.isClosed()) {
      return Promise.reject(
        new Error(
          "ACP runtime service connection closed. The service will be restarted for the next request.",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  setHandlers(handlers: AcpRuntimeAuthorityHandlers | undefined): void {
    this.handlers = handlers ?? {};
  }

  startTurn(
    sessionId: string,
    prompt: AcpRuntimePrompt,
    options?: { _traceContext?: unknown },
  ): AcpRuntimeSession["turn"]["start"] extends (...args: never[]) => infer T ? T : never {
    const requestKey = readRuntimeRequestKey(options?._traceContext) ?? randomUUID();
    const turn = new RuntimeClientTurn(requestKey);
    this.turns.set(requestKey, turn);
    void this.request("turn/start", {
      prompt,
      requestKey,
      sessionId,
    }).then((result) => {
      turn.setTurnId(String(asRecord(result).turnId));
    }, (error) => {
      turn.fail(error);
    });
    return turn.handle() as never;
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line) as RuntimeServiceMessage;
    if ("id" in message && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("id" in message && "method" in message) {
      await this.handleAuthorityRequest(message);
      return;
    }
    if (!("method" in message)) {
      return;
    }
    const params = asRecord(message.params);
    const turn = this.turns.get(String(params.requestKey));
    if (!turn) {
      return;
    }
    if (message.method === "turn/event") {
      turn.push(params.event as AcpRuntimeTurnEvent);
    } else if (message.method === "turn/completion") {
      turn.complete(params.completion as AcpRuntimeTurnCompletion);
    } else if (message.method === "turn/error") {
      turn.fail(new Error(String(params.message)));
    }
  }

  private async handleAuthorityRequest(request: RuntimeServiceRequest): Promise<void> {
    try {
      let result: unknown;
      switch (request.method) {
        case "authority/permission":
          result = await this.handlers.permission?.(request.params as never);
          break;
        case "authority/fsRead":
          result = {
            content: await this.handlers.filesystem?.readTextFile(
              String(asRecord(request.params).path),
            ),
          };
          break;
        case "authority/fsWrite":
          await this.handlers.filesystem?.writeTextFile(request.params as never);
          result = {};
          break;
        case "authority/terminalStart":
          result = await this.handlers.terminal?.start(request.params as never);
          break;
        case "authority/terminalKill":
          await this.handlers.terminal?.kill(String(asRecord(request.params).terminalId));
          result = {};
          break;
        case "authority/terminalOutput":
          result = await this.handlers.terminal?.output(
            String(asRecord(request.params).terminalId),
          );
          break;
        case "authority/terminalRelease":
          await this.handlers.terminal?.release(
            String(asRecord(request.params).terminalId),
          );
          result = {};
          break;
        case "authority/terminalWait":
          result = await this.handlers.terminal?.wait(
            String(asRecord(request.params).terminalId),
          );
          break;
        default:
          throw new Error(`Unknown authority method: ${request.method}`);
      }
      this.socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
    } catch (error) {
      this.socket.write(
        `${JSON.stringify({
          error: { message: formatError(error) },
          id: request.id,
        })}\n`,
      );
    }
  }
}

class RuntimeClientTurn {
  private completionResolve:
    | ((completion: AcpRuntimeTurnCompletion) => void)
    | undefined;
  private completionReject: ((error: Error) => void) | undefined;
  private eventsDone = false;
  private eventWaiters: (() => void)[] = [];
  private eventQueue: AcpRuntimeTurnEvent[] = [];
  private readonly completionPromise = new Promise<AcpRuntimeTurnCompletion>(
    (resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    },
  );

  private handleValue: {
    readonly completion: Promise<AcpRuntimeTurnCompletion>;
    readonly events: AsyncIterable<AcpRuntimeTurnEvent>;
    turnId: string;
  } | undefined;

  constructor(private readonly requestKey: string) {}

  handle() {
    this.handleValue ??= {
      completion: this.completionPromise,
      events: this.events(),
      turnId: this.requestKey,
    };
    return {
      completion: this.handleValue.completion,
      events: this.handleValue.events,
      turnId: this.handleValue.turnId,
    };
  }

  setTurnId(turnId: string): void {
    this.handleValue ??= {
      completion: this.completionPromise,
      events: this.events(),
      turnId,
    };
    this.handleValue.turnId = turnId;
  }

  push(event: AcpRuntimeTurnEvent): void {
    this.eventQueue.push(event);
    this.wake();
  }

  complete(completion: AcpRuntimeTurnCompletion): void {
    this.eventsDone = true;
    this.completionResolve?.(completion);
    this.wake();
  }

  fail(error: Error): void {
    this.eventsDone = true;
    this.completionReject?.(error);
    this.wake();
  }

  private async *events(): AsyncIterable<AcpRuntimeTurnEvent> {
    while (!this.eventsDone || this.eventQueue.length > 0) {
      const next = this.eventQueue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => this.eventWaiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.eventWaiters.splice(0)) {
      waiter();
    }
  }
}

const emptyStateCollection = {
  bundle: () => undefined,
  bundles: () => [],
  diffs: () => [],
  get: () => undefined,
  ids: () => [],
  keys: () => [],
  kill: async () => undefined,
  list: () => [],
  permissions: () => [],
  refresh: async () => undefined,
  release: async () => undefined,
  wait: async () => undefined,
  watch: () => () => {},
  watchBundle: () => () => {},
  watchObjects: () => () => {},
};

async function tryConnectRuntimeService(): Promise<AcpRuntimeServiceClient | undefined> {
  try {
    const socket = await connectSocket(runtimeServiceSocketPath());
    const client = new RuntimeServiceClient(socket, {});
    await client.initialize();
    return client;
  } catch {
    return undefined;
  }
}

export async function connectAcpRuntimeServiceClient(
  handlers: AcpRuntimeAuthorityHandlers,
): Promise<AcpRuntimeServiceClient> {
  const socket = await connectSocket(runtimeServiceSocketPath());
  const client = new RuntimeServiceClient(socket, handlers);
  await client.initialize();
  return client;
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function isRuntimeServiceConnectionClosedError(error: unknown): boolean {
  const message = formatError(error);
  return (
    message.includes("ACP runtime service connection closed") ||
    message.includes("Runtime service connection closed") ||
    message.includes("Runtime service peer disconnected") ||
    message.includes("EPIPE") ||
    message.includes("ECONNRESET")
  );
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function describeRuntimeSession(session: AcpRuntimeSession): RuntimeSessionDescriptor {
  return {
    capabilities: session.capabilities,
    diagnostics: session.diagnostics,
    history: session.state.history.drain(),
    initialConfigReport: session.initialConfigReport,
    metadata: session.metadata,
    snapshot: session.snapshot(),
    status: session.status,
    thread: session.state.thread.entries(),
  };
}

function withRuntimeHandlers<T extends { _traceContext?: unknown; handlers?: AcpRuntimeAuthorityHandlers }>(
  client: RuntimeServiceClient,
  options: T,
): Omit<T, "_traceContext" | "handlers"> {
  client.setHandlers(options.handlers);
  return stripRuntimeOptions(options);
}

function stripRuntimeOptions<T extends { _traceContext?: unknown; handlers?: unknown }>(
  options: T,
): Omit<T, "_traceContext" | "handlers"> {
  const { _traceContext: _traceContext, handlers: _handlers, ...rest } = options;
  return rest;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function readRuntimeRequestKey(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readOptionalString(value["acpRuntimeRequestKey"]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeServiceSocketPath(): string {
  return process.env[RUNTIME_SERVICE_SOCKET_PATH_ENV_VAR] ??
    RUNTIME_SERVICE_SOCKET_PATH;
}
