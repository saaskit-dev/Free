import {
  AgentSideConnection,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type Client,
  type Stream,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { AcpProcessError } from "@saaskit-dev/acp-runtime";
import {
  AcpRuntimeOperationKind,
  AcpRuntimeOperationPhase,
  AcpRuntimeThreadEntryKind,
  AcpRuntimeThreadEntryStatus,
  AcpRuntimeTurnEventType,
} from "@saaskit-dev/acp-runtime";
import type { AcpRuntimeSession } from "@saaskit-dev/acp-runtime";
import type {
  AcpRuntimeHistoryEntry,
  AcpRuntimeOperation,
  AcpRuntimePrompt,
  AcpRuntimeThreadEntry,
} from "@saaskit-dev/acp-runtime";
import { createAcpRemoteRuntimeAgent } from "./runtime-agent.js";

describe("AcpRemoteRuntimeAgent", () => {
  it("serves a native ACP client path through the runtime facade", async () => {
    const streams = createStreamPair();
    const notifications: unknown[] = [];
    let receivedPrompt: AcpRuntimePrompt | undefined;
    let receivedTurnOptions:
      | { _traceContext?: import("@opentelemetry/api").Context }
      | undefined;

    const session = createFakeRuntimeSession({
      onPrompt(prompt, options) {
        receivedPrompt = prompt;
        receivedTurnOptions = options;
      },
    });
    const runtime = {
      sessions: {
        async list() {
          return {
            sessions: [
              {
                cwd: "/workspace",
                id: "runtime-session-1",
                title: "Runtime Session",
              },
            ],
          };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            remoteHostId: "host-a",
            remoteMachineName: "dev-mac",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    const initialize = await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("free");

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(created.sessionId).toBe("runtime-session-1");
    expect(created._meta).toMatchObject({
      "acp-runtime/remote/hostId": "host-a",
      "acp-runtime/remote/sessionAgent": {
        command: "fake-agent",
        type: "fake",
      },
      "acp-runtime/remote/sessionMachine": "dev-mac",
      "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
    });
    expect(
      created.configOptions?.some((option) =>
        option.id.startsWith("acp-runtime.remote."),
      ) ?? false,
    ).toBe(false);

    const response = await clientConnection.prompt({
      messageId: "client-message-1",
      prompt: [
        { text: "hello", type: "text" },
        { data: "aGVsbG8=", mimeType: "image/png", type: "image" },
      ],
      sessionId: created.sessionId,
    });

    expect(response.stopReason).toBe("end_turn");
    expect(response.userMessageId).toBe("client-message-1");
    expect(receivedPrompt).toEqual([
      { text: "hello", type: "text" },
      {
        mediaType: "image/png",
        type: "image",
        uri: "data:image/png;base64,aGVsbG8=",
      },
    ]);
    expect(receivedTurnOptions?._traceContext).toBeDefined();
    expect(notifications).toEqual([
      {
        sessionId: "runtime-session-1",
        update: {
          content: {
            text: "hello",
            type: "text",
          },
          messageId: "client-message-1",
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "runtime-session-1",
        update: {
          content: {
            data: "aGVsbG8=",
            mimeType: "image/png",
            type: "image",
          },
          messageId: "client-message-1",
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "runtime-session-1",
        update: {
          content: {
            text: "hello from runtime",
            type: "text",
          },
          sessionUpdate: "agent_message_chunk",
        },
      },
    ]);
  });

  it("passes live runtime operation ids through as ACP tool call ids", async () => {
    const streams = createStreamPair();
    const notifications: Array<{
      update?: {
        rawInput?: unknown;
        rawOutput?: unknown;
        sessionUpdate?: string;
        status?: string;
        title?: string;
        toolCallId?: string;
      };
    }> = [];
    let promptCount = 0;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = () => {
      const turnId = promptCount === 0 ? "turn-a" : "turn-b";
      const title = promptCount === 0 ? "pwd" : "date";
      const operationId = promptCount === 0 ? "call_pwd" : "call_date";
      promptCount += 1;
      const runningOperation: AcpRuntimeOperation = {
        id: operationId,
        kind: AcpRuntimeOperationKind.ExecuteCommand,
        phase: AcpRuntimeOperationPhase.Running,
        rawInput: {
          command: title,
        },
        title,
        turnId,
      };
      const completedOperation: AcpRuntimeOperation = {
        ...runningOperation,
        phase: AcpRuntimeOperationPhase.Completed,
        rawOutput: `${title} raw output`,
        result: {
          outputText: `${title} output`,
        },
      };

      return {
        completion: Promise.resolve({
          output: [{ text: "done", type: "text" }],
          outputText: "done",
          turnId,
        }),
        events: (async function* () {
          yield { turnId, type: AcpRuntimeTurnEventType.Started };
          yield {
            operation: runningOperation,
            turnId,
            type: AcpRuntimeTurnEventType.OperationStarted,
          };
          yield {
            operation: completedOperation,
            turnId,
            type: AcpRuntimeTurnEventType.OperationCompleted,
          };
          yield {
            output: [{ text: "done", type: "text" }],
            outputText: "done",
            turnId,
            type: AcpRuntimeTurnEventType.Completed,
          };
        })(),
        turnId,
      };
    };
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await clientConnection.prompt({
      prompt: [{ text: "first", type: "text" }],
      sessionId: created.sessionId,
    });
    await clientConnection.prompt({
      prompt: [{ text: "second", type: "text" }],
      sessionId: created.sessionId,
    });

    const toolUpdates = notifications
      .map((params) => params.update)
      .filter((update) => update?.sessionUpdate?.startsWith("tool_call"))
      .map((update) => ({
        rawInput: update?.rawInput,
        rawOutput: update?.rawOutput,
        sessionUpdate: update?.sessionUpdate,
        status: update?.status,
        title: update?.title,
        toolCallId: update?.toolCallId,
      }));
    expect(toolUpdates).toEqual([
      {
        rawInput: { command: "pwd" },
        rawOutput: undefined,
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "pwd",
        toolCallId: "call_pwd",
      },
      {
        rawInput: { command: "pwd" },
        rawOutput: "pwd raw output",
        sessionUpdate: "tool_call_update",
        status: "completed",
        title: "pwd",
        toolCallId: "call_pwd",
      },
      {
        rawInput: { command: "date" },
        rawOutput: undefined,
        sessionUpdate: "tool_call",
        status: "in_progress",
        title: "date",
        toolCallId: "call_date",
      },
      {
        rawInput: { command: "date" },
        rawOutput: "date raw output",
        sessionUpdate: "tool_call_update",
        status: "completed",
        title: "date",
        toolCallId: "call_date",
      },
    ]);
  });

  it("restores missing active sessions before prompt and deduplicates concurrent restores", async () => {
    const streams = createStreamPair();
    const prompts: AcpRuntimePrompt[] = [];
    let loadCalls = 0;
    const session = createFakeRuntimeSession({
      id: "restored-session",
      onPrompt(prompt) {
        prompts.push(prompt);
      },
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return session;
        },
        async resume() {
          throw new Error("resume should not be called after load succeeds");
        },
        async start() {
          throw new Error("restore must not start a new session");
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const prompt = {
      _meta: {
        "acp-runtime/remote/sessionAgent": {
          command: "fake-agent",
          type: "fake",
        },
        "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
      },
      prompt: [{ text: "restore me", type: "text" }],
      sessionId: "restored-session",
    } satisfies Parameters<typeof clientConnection.prompt>[0];

    await expect(
      Promise.all([
        clientConnection.prompt(prompt),
        clientConnection.prompt(prompt),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ stopReason: "end_turn" }),
      expect.objectContaining({ stopReason: "end_turn" }),
    ]);
    expect(loadCalls).toBe(1);
    expect(prompts).toHaveLength(2);
  });

  it("replays runtime history before completing remote session load", async () => {
    const streams = createStreamPair();
    const notifications: unknown[] = [];
    let drained = false;
    const session = createFakeRuntimeSession({
      history: [
        { text: "previous user message", type: "user" },
        {
          content: [
            {
              mediaType: "image/png",
              type: "image",
              uri: "data:image/png;base64,aGVsbG8=",
            },
          ],
          text: "Image content (image/png)",
          type: "user",
        },
        {
          text: "previous assistant message",
          turnId: "turn-history",
          type: AcpRuntimeTurnEventType.Text,
        },
      ],
      id: "runtime-session-history",
      onPrompt() {},
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          drained = true;
          return session;
        },
        async resume() {
          throw new Error("load should restore history session");
        },
        async start() {
          throw new Error("load should not start a new session");
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            remoteHostId: "host-history",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const loaded = await clientConnection.loadSession({
      cwd: "/workspace",
      mcpServers: [],
      sessionId: "zed-history-session",
    });

    expect(loaded.sessionId).toBe("runtime-session-history");
    expect(drained).toBe(true);
    expect(notifications).toEqual([
      {
        sessionId: "zed-history-session",
        update: {
          content: { text: "previous user message", type: "text" },
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "zed-history-session",
        update: {
          content: {
            data: "aGVsbG8=",
            mimeType: "image/png",
            type: "image",
          },
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "zed-history-session",
        update: {
          content: { text: "previous assistant message", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      },
    ]);
  });

  it("replays active session thread entries when one-shot load history is drained", async () => {
    const streams = createStreamPair();
    const notifications: unknown[] = [];
    let loadCalls = 0;
    const session = createFakeRuntimeSession({
      id: "active-runtime-session",
      onPrompt() {},
      threadEntries: [
        {
          content: [
            { text: "active user message", type: "text" },
            {
              mediaType: "image/png",
              type: "image",
              uri: "data:image/png;base64,aGVsbG8=",
            },
          ],
          id: "user-1",
          kind: AcpRuntimeThreadEntryKind.UserMessage,
          text: "active user message\nImage content (image/png)",
          turnId: "turn-active",
        },
        {
          id: "assistant-1",
          kind: AcpRuntimeThreadEntryKind.AssistantMessage,
          status: AcpRuntimeThreadEntryStatus.Completed,
          text: "active assistant message",
          turnId: "turn-active",
        },
        {
          content: [
            {
              id: "content-1",
              kind: "content",
              text: "tool output",
            },
            {
              id: "content-2",
              kind: "content",
              part: {
                mediaType: "image/png",
                type: "image",
                uri: "data:image/png;base64,aGVsbG8=",
              },
            },
            {
              changeType: "update",
              id: "diff-1",
              kind: "diff",
              newText: "after",
              oldText: "before",
              path: "/workspace/file.txt",
            },
          ],
          id: "tool-1",
          kind: AcpRuntimeThreadEntryKind.ToolCall,
          status: AcpRuntimeThreadEntryStatus.Completed,
          title: "Read file",
          toolCallId: "tool-1",
          toolKind: "read",
          turnId: "turn-active",
        },
      ],
    });
    session.state.history.drain();
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalls += 1;
          return session;
        },
        async resume() {
          throw new Error("load should restore active session");
        },
        async start() {
          throw new Error("load should not start a new session");
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const loaded = await clientConnection.loadSession({
      cwd: "/workspace",
      mcpServers: [],
      sessionId: "zed-active-session",
    });

    expect(loaded.sessionId).toBe("active-runtime-session");
    expect(loadCalls).toBe(1);
    expect(notifications).toEqual([
      {
        sessionId: "zed-active-session",
        update: {
          content: { text: "active user message", type: "text" },
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "zed-active-session",
        update: {
          content: {
            data: "aGVsbG8=",
            mimeType: "image/png",
            type: "image",
          },
          sessionUpdate: "user_message_chunk",
        },
      },
      {
        sessionId: "zed-active-session",
        update: {
          content: { text: "active assistant message", type: "text" },
          sessionUpdate: "agent_message_chunk",
        },
      },
      {
        sessionId: "zed-active-session",
        update: {
          kind: "read",
          locations: undefined,
          rawInput: undefined,
          rawOutput: undefined,
          sessionUpdate: "tool_call",
          status: "in_progress",
          title: "Read file",
          toolCallId: "tool-1",
        },
      },
      {
        sessionId: "zed-active-session",
        update: {
          content: [
            {
              content: { text: "tool output", type: "text" },
              type: "content",
            },
            {
              content: {
                data: "aGVsbG8=",
                mimeType: "image/png",
                type: "image",
              },
              type: "content",
            },
            {
              newText: "after",
              oldText: "before",
              path: "/workspace/file.txt",
              type: "diff",
            },
          ],
          kind: "read",
          locations: undefined,
          rawInput: undefined,
          rawOutput: undefined,
          sessionUpdate: "tool_call_update",
          status: "completed",
          title: "Read file",
          toolCallId: "tool-1",
        },
      },
    ]);
  });

  it("enforces workspace roots before starting runtime sessions", async () => {
    const streams = createStreamPair();
    let startCalled = false;
    const session = createFakeRuntimeSession({
      onPrompt() {},
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          startCalled = true;
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: {
              command: "fake-agent",
              type: "fake",
            },
            runtime,
            workspaceRoots: ["/allowed"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: {
                optionId: "allow_once",
                outcome: "selected",
              },
            };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    await expect(
      clientConnection.newSession({
        cwd: "/blocked",
        mcpServers: [],
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: {
        cwd: "/blocked",
        method: "session/new",
      },
    });
    expect(startCalled).toBe(false);
  });

  it("handles session lifecycle: create, list, close", async () => {
    const streams = createStreamPair();
    const session = createFakeRuntimeSession({ onPrompt() {} });
    let listCalled = false;
    let closeCalled = false;
    const runtime = {
      sessions: {
        async list() {
          listCalled = true;
          return { sessions: [{ cwd: "/workspace", id: "s-1", title: "S1" }] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: { command: "fake", type: "fake" },
            remoteHostId: "host-list",
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });
    expect(created.sessionId).toBe("runtime-session-1");

    const listed = await clientConnection.listSessions({ cwd: "/workspace" });
    expect(listCalled).toBe(true);
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]?._meta).toMatchObject({
      "acp-runtime/remote/hostId": "host-list",
      "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
    });

    session.close = async () => {
      closeCalled = true;
    };
    await clientConnection.closeSession({ sessionId: created.sessionId });
    expect(closeCalled).toBe(true);
  });

  it("returns a clear error when remote load cannot restore the requested id", async () => {
    const streams = createStreamPair();
    let loadCalled = false;
    let resumeCalled = false;
    let startCalled = false;
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalled = true;
          throw new Error("missing local runtime snapshot");
        },
        async resume() {
          resumeCalled = true;
          throw new Error("missing active runtime snapshot");
        },
        async start() {
          startCalled = true;
          return createFakeRuntimeSession({
            id: "should-not-start",
            onPrompt() {},
          });
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    await expect(
      clientConnection.loadSession({
        cwd: "/workspace",
        mcpServers: [],
        sessionId: "stale-zed-session-id",
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining(
        "Remote runtime session could not be restored",
      ),
    });
    expect(loadCalled).toBe(true);
    expect(resumeCalled).toBe(true);
    expect(startCalled).toBe(false);
  });

  it("starts a replacement runtime session when a prompt targets a stale remote session", async () => {
    const streams = createStreamPair();
    const prompts: AcpRuntimePrompt[] = [];
    let loadCalled = false;
    let resumeCalled = false;
    let startCalled = 0;
    const replacementSession = createFakeRuntimeSession({
      id: "replacement-runtime-session",
      onPrompt(prompt) {
        prompts.push(prompt);
      },
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          loadCalled = true;
          throw new Error("missing local runtime snapshot");
        },
        async resume() {
          resumeCalled = true;
          throw new Error("missing active runtime snapshot");
        },
        async start() {
          startCalled += 1;
          return replacementSession;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const stalePrompt = {
      _meta: {
        "acp-runtime/remote/sessionAgent": {
          command: "fake",
          type: "fake",
        },
        "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
      },
      prompt: [{ text: "continue after host restart", type: "text" }],
      sessionId: "stale-zed-session-id",
    } satisfies Parameters<typeof clientConnection.prompt>[0];

    await expect(clientConnection.prompt(stalePrompt)).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    await expect(clientConnection.prompt(stalePrompt)).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    expect(loadCalled).toBe(true);
    expect(resumeCalled).toBe(true);
    expect(startCalled).toBe(1);
    expect(prompts).toHaveLength(2);
  });

  it("handles setSessionMode and setSessionConfigOption", async () => {
    const streams = createStreamPair();
    let modeSet: string | undefined;
    let configSet: { id: string; value: unknown } | undefined;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.agent.setMode = async (modeId: string) => {
      modeSet = modeId;
    };
    session.agent.setConfigOption = async (configId: string, value: unknown) => {
      configSet = { id: configId, value };
    };
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await clientConnection.setSessionMode({
      modeId: "plan",
      sessionId: created.sessionId,
    });
    expect(modeSet).toBe("plan");

    await clientConnection.setSessionConfigOption({
      configId: "auto_approve",
      sessionId: created.sessionId,
      type: "boolean",
      value: true,
    });
    expect(configSet).toEqual({ id: "auto_approve", value: true });
  });

  it("forwards permission prompts to the remote client", async () => {
    const streams = createStreamPair();
    let permissionRequested = false;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = (prompt) => ({
      completion: Promise.resolve({
        output: [{ text: "done", type: "text" }],
        outputText: "done",
        turnId: "turn-perm",
      }),
      events: (async function* () {
        yield { turnId: "turn-perm", type: AcpRuntimeTurnEventType.Started };
        yield {
          turnId: "turn-perm",
          type: AcpRuntimeTurnEventType.Completed,
          output: [{ text: "done", type: "text" }],
          outputText: "done",
        };
      })(),
      turnId: "turn-perm",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            permissionRequested = true;
            return { outcome: { optionId: "allow_session", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    const response = await clientConnection.prompt({
      prompt: [{ text: "do something risky", type: "text" }],
      sessionId: created.sessionId,
    });
    expect(response.stopReason).toBe("end_turn");
  });

  it("handles turn cancellation", async () => {
    const streams = createStreamPair();
    let cancelCalled = false;
    const session = createFakeRuntimeSession({ onPrompt() {} });
    let resolveCancel: () => void;
    const cancelPromise = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    session.turn.cancel = async () => {
      cancelCalled = true;
      resolveCancel();
      return true;
    };
    session.turn.start = () => ({
      completion: new Promise(() => {}),
      events: (async function* () {
        yield { turnId: "turn-cancel", type: AcpRuntimeTurnEventType.Started };
        await cancelPromise;
        yield { turnId: "turn-cancel", type: AcpRuntimeTurnEventType.Cancelled };
      })(),
      turnId: "turn-cancel",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    const promptPromise = clientConnection.prompt({
      prompt: [{ text: "long task", type: "text" }],
      sessionId: created.sessionId,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    clientConnection.cancel({
      sessionId: created.sessionId,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelCalled).toBe(true);
    void promptPromise.catch(() => {});
  });

  it("returns prompt failure causes to the ACP client", async () => {
    const streams = createStreamPair();
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = () => ({
      completion: Promise.resolve({
        output: [],
        outputText: "",
        turnId: "turn-failed",
      }),
      events: (async function* () {
        yield { turnId: "turn-failed", type: AcpRuntimeTurnEventType.Started };
        yield {
          error: new AcpProcessError(
            "ACP prompt request failed.",
            new Error("Failed to authenticate. API Error: 401"),
          ),
          turnId: "turn-failed",
          type: AcpRuntimeTurnEventType.Failed,
        };
      })(),
      turnId: "turn-failed",
    });
    const runtime = {
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await expect(
      clientConnection.prompt({
        prompt: [{ text: "hello", type: "text" }],
        sessionId: created.sessionId,
      }),
    ).rejects.toThrow(
      "ACP prompt request failed. Caused by: Failed to authenticate. API Error: 401",
    );
  });

  it("resumes an open idle session from the runtime snapshot after runtime service restart", async () => {
    const streams = createStreamPair();
    let runtimeClosed = false;
    const startedSession = createFakeRuntimeSession({
      id: "runtime-session-1",
      onPrompt() {},
    });
    const resumedSession = createFakeRuntimeSession({
      id: "runtime-session-1",
      onPrompt() {},
    });
    const resumeCalls: unknown[] = [];
    const runtime = {
      isClosed: () => runtimeClosed,
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          throw new Error("load should not run before resume");
        },
        async resume(options: unknown) {
          resumeCalls.push(options);
          runtimeClosed = false;
          return resumedSession;
        },
        async start() {
          return startedSession;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: { command: "default-agent", type: "default" },
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      _meta: {
        "acp-runtime/remote/sessionAgent": {
          command: "codex-acp",
          args: ["--fast"],
          env: { FREE_ENV: "test" },
          type: "codex",
        },
        "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
      },
      cwd: "/workspace",
      mcpServers: [],
    } as never);

    runtimeClosed = true;
    const response = await clientConnection.prompt({
      prompt: [{ text: "after restart", type: "text" }],
      sessionId: created.sessionId,
    });

    expect(response.stopReason).toBe("end_turn");
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toMatchObject({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      cwd: "/workspace",
      sessionId: "runtime-session-1",
    });
    expect(resumeCalls[0]).toHaveProperty("handlers");
  });

  it("falls back to loading the runtime snapshot when resume is unsupported after service restart", async () => {
    const streams = createStreamPair();
    let runtimeClosed = false;
    const startedSession = createFakeRuntimeSession({
      id: "runtime-session-1",
      onPrompt() {},
    });
    const loadedSession = createFakeRuntimeSession({
      id: "runtime-session-1",
      onPrompt() {},
    });
    const resumeCalls: unknown[] = [];
    const loadCalls: unknown[] = [];
    const runtime = {
      isClosed: () => runtimeClosed,
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load(options: unknown) {
          loadCalls.push(options);
          runtimeClosed = false;
          return loadedSession;
        },
        async resume(options: unknown) {
          resumeCalls.push(options);
          throw new Error('"Method not found": session/resume');
        },
        async start() {
          return startedSession;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: {
            agent: { command: "default-agent", type: "default" },
            runtime,
            workspaceRoots: ["/workspace"],
          },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    runtimeClosed = true;
    await expect(
      clientConnection.prompt({
        prompt: [{ text: "after restart", type: "text" }],
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(resumeCalls).toHaveLength(1);
    expect(loadCalls).toHaveLength(1);
    expect(loadCalls[0]).toMatchObject({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      cwd: "/workspace",
      sessionId: "runtime-session-1",
    });
    expect(loadCalls[0]).not.toHaveProperty("mcpServers");
    expect(loadCalls[0]).toHaveProperty("handlers");
  });

  it("fails an in-flight prompt with a resend message when runtime service disconnects", async () => {
    const streams = createStreamPair();
    const session = createFakeRuntimeSession({ onPrompt() {} });
    session.turn.start = () => ({
      completion: Promise.resolve({
        output: [],
        outputText: "",
        turnId: "turn-runtime-closed",
      }),
      events: (async function* () {
        yield { turnId: "turn-runtime-closed", type: AcpRuntimeTurnEventType.Started };
        throw new Error("ACP runtime service connection closed.");
      })(),
      turnId: "turn-runtime-closed",
    });
    const runtime = {
      isClosed: () => false,
      sessions: {
        async list() {
          return { sessions: [] };
        },
        async load() {
          return session;
        },
        async resume() {
          return session;
        },
        async start() {
          return session;
        },
      },
    };

    const agentConnection = new AgentSideConnection(
      (connection) =>
        createAcpRemoteRuntimeAgent({
          connection,
          options: { agent: { command: "fake", type: "fake" }, runtime },
        }),
      streams.server,
    );
    void agentConnection.closed.catch(() => {});

    const clientConnection = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return { outcome: { optionId: "allow_once", outcome: "selected" } };
          },
          async sessionUpdate() {},
        }) satisfies Client,
      streams.client,
    );
    void clientConnection.closed.catch(() => {});

    await clientConnection.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });

    const created = await clientConnection.newSession({
      cwd: "/workspace",
      mcpServers: [],
    });

    await expect(
      clientConnection.prompt({
        prompt: [{ text: "will fail", type: "text" }],
        sessionId: created.sessionId,
      }),
    ).rejects.toThrow(
      "ACP runtime service restarted before this request completed. The message was not completed; resend it to continue.",
    );
  });
});

function createStreamPair(): { client: Stream; server: Stream } {
  const clientToServer = new TransformStream<AnyMessage, AnyMessage>();
  const serverToClient = new TransformStream<AnyMessage, AnyMessage>();
  return {
    client: {
      readable: serverToClient.readable,
      writable: clientToServer.writable,
    },
    server: {
      readable: clientToServer.readable,
      writable: serverToClient.writable,
    },
  };
}

function createFakeRuntimeSession(input: {
  history?: readonly AcpRuntimeHistoryEntry[];
  id?: string;
  onPrompt(
    prompt: AcpRuntimePrompt,
    options?: { _traceContext?: import("@opentelemetry/api").Context },
  ): void;
  threadEntries?: readonly AcpRuntimeThreadEntry[];
}): AcpRuntimeSession {
  const id = input.id ?? "runtime-session-1";
  let historyDrained = false;
  return {
    agent: {
      listConfigOptions: () => [],
      listModes: () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
    },
    capabilities: {
      agent: {
        prompt: true,
      },
      client: {},
    },
    close: async () => {},
    diagnostics: {},
    initialConfigReport: undefined,
    metadata: {
      id,
      title: "Runtime Session",
    },
    queue: {
      policy: () => ({ delivery: "sequential" }),
      setPolicy: () => ({ delivery: "sequential" }),
    },
    snapshot: () => ({
      agent: {
        command: "fake-agent",
        type: "fake",
      },
      cwd: "/workspace",
      session: {
        id,
      },
      version: 1,
    }),
    state: {
      history: {
        drain: () => {
          if (historyDrained) {
            return [];
          }
          historyDrained = true;
          return input.history ?? [];
        },
      },
      thread: {
        entries: () => input.threadEntries ?? [],
      },
    } as AcpRuntimeSession["state"],
    status: "ready",
    turn: {
      cancel: async () => true,
      queue: {
        clear: () => 0,
        get: () => undefined,
        list: () => [],
        remove: () => false,
        sendNow: async () => false,
      },
      run: async () => "hello from runtime",
      send: async () => ({
        output: [{ text: "hello from runtime", type: "text" }],
        outputText: "hello from runtime",
        turnId: "turn-1",
      }),
      start: (prompt, options) => {
        input.onPrompt(prompt, options);
        return {
          completion: Promise.resolve({
            output: [{ text: "hello from runtime", type: "text" }],
            outputText: "hello from runtime",
            turnId: "turn-1",
          }),
          events: createTurnEvents(),
          turnId: "turn-1",
        };
      },
      stream: () => createTurnEvents(),
    },
  } as unknown as AcpRuntimeSession;
}

async function waitFor(
  predicate: () => boolean,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1_000;
  const intervalMs = options.intervalMs ?? 10;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function* createTurnEvents() {
  yield {
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Started,
  };
  yield {
    text: "hello from runtime",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Text,
  };
  yield {
    output: [{ text: "hello from runtime", type: "text" }],
    outputText: "hello from runtime",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Completed,
  };
}
