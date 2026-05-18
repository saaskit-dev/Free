import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteAttachmentFrameType,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  decodeAcpRemoteAttachmentUpload,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
} from "../../src/protocol/index.js";
import {
  createMemoryWebSocketPair,
  waitFor,
} from "../../src/shared/test-helpers.js";
import { createAcpRemoteChildTraceContext } from "../../src/shared/trace-context.js";
import { AcpRelayInMemoryControlPlaneStore } from "./control-plane-store.js";
import {
  AcpRelayBroker,
  createRelayAuthorizationPage,
  type AcpRelayBrokerOptions,
  type AcpRelayClientStateSnapshot,
  type AcpRelayTraceSpanInput,
} from "./relay-core.js";

describe("AcpRelayBroker", () => {
  it("declares image prompt support in the bootstrap initialize response", async () => {
    const broker = createBroker();
    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const messages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        messages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      socket: relayClientSocket,
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: { clientCapabilities: {}, protocolVersion: 1 },
      }),
    );

    await waitFor(() => messages.length > 0);
    expect(messages[0]).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      result: {
        agentCapabilities: {
          promptCapabilities: {
            image: true,
          },
        },
      },
    });
  });

  it("forwards client image attachments to the authorized host as binary frames", async () => {
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      routeReady: true,
      socket: relayClientSocket,
    });

    const body = new TextEncoder().encode("image-bytes");
    let decodedUpload: ReturnType<typeof decodeAcpRemoteAttachmentUpload>;
    hostSocket.addEventListener("message", (event) => {
      decodedUpload = decodeAcpRemoteAttachmentUpload(event.data);
      if (!decodedUpload) {
        return;
      }
      hostSocket.send(JSON.stringify({
        attachmentId: decodedUpload.header.attachmentId,
        connectionId: decodedUpload.header.connectionId,
        frameType: AcpRemoteAttachmentFrameType.Ack,
        mimeType: decodedUpload.header.mimeType,
        ok: true,
        requestId: decodedUpload.header.requestId,
        sha256: decodedUpload.header.sha256,
        size: decodedUpload.body.byteLength,
        uri: decodedUpload.header.uri,
        version: 1,
      }));
    });

    const result = await broker.forwardClientAttachment({
      accountId: "acct-1",
      attachmentId: "att-1",
      body,
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
      mimeType: "image/png",
      sha256: sha256Hex(body),
    });

    expect(decodedUpload?.header).toMatchObject({
      attachmentId: "att-1",
      connectionId: "conn-1",
      hostId: "host-1",
      kind: "attachment/upload",
      mimeType: "image/png",
    });
    expect(new TextDecoder().decode(decodedUpload?.body)).toBe("image-bytes");
    expect(result).toEqual({
      attachmentId: "att-1",
      mimeType: "image/png",
      ok: true,
      sha256: sha256Hex(body),
      size: body.byteLength,
      uri: "free-attachment://host-1/conn-1/msg-1/att-1",
    });
  });

  it("forwards multiple client image attachments concurrently", async () => {
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      routeReady: true,
      socket: relayClientSocket,
    });

    const uploads: Array<NonNullable<ReturnType<typeof decodeAcpRemoteAttachmentUpload>>> = [];
    hostSocket.addEventListener("message", (event) => {
      const upload = decodeAcpRemoteAttachmentUpload(event.data);
      if (upload) {
        uploads.push(upload);
      }
    });

    const firstBody = new TextEncoder().encode("image-one");
    const secondBody = new TextEncoder().encode("image-two");
    const firstForward = broker.forwardClientAttachment({
      accountId: "acct-1",
      attachmentId: "att-1",
      body: firstBody,
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
      mimeType: "image/png",
      sha256: sha256Hex(firstBody),
    });
    const secondForward = broker.forwardClientAttachment({
      accountId: "acct-1",
      attachmentId: "att-2",
      body: secondBody,
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
      mimeType: "image/jpeg",
      sha256: sha256Hex(secondBody),
    });

    await waitFor(() => uploads.length === 2);
    expect(uploads.map((upload) => upload.header.attachmentId)).toEqual([
      "att-1",
      "att-2",
    ]);

    hostSocket.send(JSON.stringify(createAttachmentAck(uploads[1]!)));
    await expect(secondForward).resolves.toMatchObject({
      attachmentId: "att-2",
      ok: true,
      uri: "free-attachment://host-1/conn-1/msg-1/att-2",
    });

    hostSocket.send(JSON.stringify(createAttachmentAck(uploads[0]!)));
    await expect(firstForward).resolves.toMatchObject({
      attachmentId: "att-1",
      ok: true,
      uri: "free-attachment://host-1/conn-1/msg-1/att-1",
    });
  });

  it("authorizes a client route by forwarding the bridge proof to the host", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "fake-agent" },
        connectionId: "conn-1",
        hostId: "host-1",
        workspaceRoots: ["/workspace"],
      }),
    ).resolves.toEqual({
      connectionId: "conn-1",
      hostId: "host-1",
      ok: true,
    });

    await waitFor(() => hostFrames.length > 0);
    expect(hostFrames[0]).toMatchObject({
      agent: { id: "fake-agent" },
      connectionId: "conn-1",
      endpoint: AcpRemoteEndpointKind.Client,
      frameType: AcpRemoteFrameType.Hello,
      hostId: "host-1",
      proof: identity.proof,
      protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
      workspaceRoots: ["/workspace"],
    });
  });

  it("reopens authorized routes on host reconnect with a fresh hello", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [, firstRelayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: firstRelayHostSocket,
    });
    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      workspaceRoots: ["/workspace"],
    });
    broker.removeHost("host-1", firstRelayHostSocket);

    const [secondHostSocket, secondRelayHostSocket] = createMemoryWebSocketPair();
    const frames: unknown[] = [];
    secondHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        frames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: secondRelayHostSocket,
    });

    await waitFor(() =>
      frames.some(
        (frame) =>
          isRecord(frame) && frame.frameType === AcpRemoteFrameType.Hello,
      ),
    );
    expect(
      frames.some(
        (frame) =>
          isRecord(frame) && frame.frameType === "refresh",
      ),
    ).toBe(false);
  });

  it("keeps a prebound client open while its host route reconnects", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientCloses: Array<{ code?: number; reason?: string }> = [];
    clientSocket.addEventListener("close", (event) => {
      clientCloses.push(event ?? {});
    });

    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
      routeReady: true,
      socket: relayClientSocket,
    });

    expect(clientCloses).toEqual([]);
    expect(broker.hasPendingHostReconnects()).toBe(true);

    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    await waitFor(() =>
      hostFrames.some(
        (frame) =>
          isRecord(frame) && frame.frameType === AcpRemoteFrameType.Hello,
      ),
    );
    expect(clientCloses).toEqual([]);
    expect(broker.hasPendingHostReconnects()).toBe(false);
  });

  it("does not authorize a prebound host before explicit selection", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ authWaitMs: 5 });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
      socket: relayClientSocket,
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/workspace/project", mcpServers: [] },
      }),
    );

    expect(hostFrames).toEqual([]);
    expect(clientMessages).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          message: "Authentication required: host selection was not completed.",
        }),
        id: 1,
      }),
    ]);
  });

  it("lists registered offline hosts without making them online", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-2",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          { accountId: "acct-1", hostId: "host-1" },
          { accountId: "acct-1", hostId: "host-2" },
        ],
      }),
    });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        machine: "online-machine",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    await expect(
      broker.discoverableHosts({
        accountId: "acct-1",
        clientId: "client-1",
      }),
    ).resolves.toEqual({
      hosts: [
        {
          hostId: "host-1",
          metadata: {
            agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
            machine: "online-machine",
            workspaceRoots: [{ path: "/workspace" }],
          },
          online: true,
        },
        {
          hostId: "host-2",
          metadata: undefined,
          online: false,
        },
      ],
      ok: true,
    });
  });

  it("lists account hosts when an authorization request is expired", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        grants: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [],
              displayName: "Studio Mac",
              machine: "studio.local",
              workspaceRoots: [],
            },
          },
        ],
      }),
    });

    await expect(
      broker.discoverableHostsForConnection("missing-connection"),
    ).resolves.toMatchObject({
      hosts: [],
      ok: false,
    });
    await expect(
      broker.discoverableHostsForAccount({ accountId: "acct-1" }),
    ).resolves.toEqual({
      hosts: [{
        hostId: "host-1",
        metadata: {
          agentTypes: [],
          displayName: "Studio Mac",
          machine: "studio.local",
          workspaceRoots: [],
        },
        online: false,
      }],
      ok: true,
    });
  });

  it("lists unclosed stored session bindings as detached open sessions", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [{ id: "codex-acp", label: "Codex" }],
              displayName: "Studio Mac",
              machine: "studio.local",
              workspaceRoots: [{ path: "/Users/dev" }],
            },
          },
        ],
        sessionBindings: [
          {
            accountId: "acct-1",
            agent: { id: "codex-acp" },
            clientId: "zed-client",
            hostId: "host-1",
            sessionId: "session-1",
            updatedAt: "2026-05-14T01:00:00.000Z",
            workspaceRoots: ["/Users/dev"],
          },
        ],
      }),
    });

    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          agent: { id: "codex-acp" },
          bridgeConnected: false,
          hasActiveEvent: false,
          hostId: "host-1",
          hostName: "Studio Mac",
          hostOnline: false,
          latestEvent: "ACP session is open.",
          lifecycle: "live",
          sessionId: "session-1",
          status: "detached",
          title: "/dev · codex-acp · Studio Mac",
          updatedAt: "2026-05-14T01:00:00.000Z",
          workspaceRoots: ["/Users/dev"],
        }),
      ],
    });
  });

  it("marks a disconnected stored session as closed from the workbench", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
          },
        ],
        sessionBindings: [
          {
            accountId: "acct-1",
            clientId: "zed-client",
            hostId: "host-1",
            sessionId: "session-1",
            updatedAt: "2026-05-14T01:00:00.000Z",
            workspaceRoots: ["/Users/dev"],
          },
        ],
      }),
      now: () => new Date("2026-05-14T02:00:00.000Z"),
    });

    await expect(
      broker.closeDisconnectedSession({
        accountId: "acct-1",
        sessionId: "session-1",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          closedAt: "2026-05-14T02:00:00.000Z",
          lifecycle: "offline",
          sessionId: "session-1",
          status: "offline",
        }),
      ],
    });
  });

  it("lists closed stored session bindings as closed history", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [{ id: "codex-acp", label: "Codex" }],
              displayName: "Studio Mac",
              machine: "studio.local",
              workspaceRoots: [{ path: "/Users/dev" }],
            },
          },
        ],
        sessionBindings: [
          {
            accountId: "acct-1",
            agent: { id: "codex-acp" },
            clientId: "zed-client",
            closedAt: "2026-05-14T02:00:00.000Z",
            hostId: "host-1",
            sessionId: "session-1",
            updatedAt: "2026-05-14T01:00:00.000Z",
            workspaceRoots: ["/Users/dev"],
          },
        ],
      }),
    });

    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          bridgeConnected: false,
          closedAt: "2026-05-14T02:00:00.000Z",
          hasActiveEvent: false,
          hostId: "host-1",
          latestEvent: "ACP session was closed.",
          lifecycle: "offline",
          sessionId: "session-1",
          status: "offline",
          updatedAt: "2026-05-14T02:00:00.000Z",
        }),
      ],
    });
  });

  it("uses runtime session titles and falls back to the first user prompt", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame = JSON.parse(event.data);
      if (
        !isRecord(frame) ||
        frame.frameType !== AcpRemoteFrameType.Data ||
        !isRecord(frame.payload) ||
        frame.payload.method !== "session/new"
      ) {
        return;
      }
      hostSocket.send(JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId: "conn-1",
        frameType: AcpRemoteFrameType.Data,
        payload: {
          id: frame.payload.id,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        },
        seq: 1,
      }));
    });
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        displayName: "Studio Mac",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
      workspaceRoots: ["/workspace"],
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/workspace/project", mcpServers: [] },
      }),
    );
    await waitForSessionTitle(broker, "/workspace · fake-agent · Studio Mac");

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 2,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{
            text: "请分析登录失败原因。第二句不要进入标题。",
            type: "text",
          }],
          sessionId: "session-1",
        },
      }),
    );
    await waitForSessionTitle(broker, "请分析登录失败原因。");

    await broker.handleHostText(JSON.stringify({
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Data,
      payload: {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "session_info_update",
            title: "Runtime Session Title",
          },
        },
      },
      seq: 2,
    }));
    await waitForSessionTitle(broker, "Runtime Session Title");
  });

  it("lists active account sessions before the binding is persisted", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [{ id: "codex-acp", label: "Codex" }],
              displayName: "Studio Mac",
              machine: "studio.local",
              workspaceRoots: [{ path: "/Users/dev" }],
            },
          },
        ],
        sessionBindings: [
          {
            accountId: "acct-1",
            agent: { id: "codex-acp" },
            clientId: "zed-client",
            createdAt: "2026-05-14T00:00:00.000Z",
            hostId: "host-1",
            sessionId: "live-session",
            updatedAt: "2026-05-14T01:00:00.000Z",
            workspaceRoots: ["/Users/dev"],
          },
        ],
      }),
    });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "codex-acp", label: "Codex" }],
        displayName: "Studio Mac",
        machine: "studio.local",
        workspaceRoots: [{ path: "/Users/dev" }],
      },
      socket: relayHostSocket,
    });
    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "zed-client",
      connectionId: "conn-1",
      socket: relayClientSocket,
      stateSnapshot: {
        bufferedClientPayloads: [],
        clientPendingFrames: [],
        completedClientResponses: [
          {
            id: 1,
            jsonrpc: "2.0",
            result: {
              _meta: {
                "acp-runtime/remote/hostId": "host-1",
                "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
                "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev"],
              },
              sessionId: "live-session",
            },
          },
        ],
        connectionId: "conn-1",
        hostId: "host-1",
        hostPendingFrames: [],
        hostQueuedFrames: [],
        hostRequests: [],
        lastAuthorization: {
          agent: { id: "codex-acp" },
          hostId: "host-1",
          workspaceRoots: ["/Users/dev"],
        },
        routeReady: true,
        seq: 0,
        sessionControlRequests: [],
      },
    });

    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          agent: { id: "codex-acp" },
          bridgeConnected: true,
          connectionId: "conn-1",
          hasActiveEvent: false,
          hostId: "host-1",
          hostName: "Studio Mac",
          lifecycle: "live",
          createdAt: "2026-05-14T00:00:00.000Z",
          sessionId: "live-session",
          status: "active",
          title: "/dev · codex-acp · Studio Mac",
          updatedAt: "2026-05-14T01:00:00.000Z",
          workspaceRoots: ["/Users/dev"],
        }),
      ],
    });
  });

  it("lists remembered client sessions by ACP lifecycle even when the host is offline", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [{ id: "codex-acp", label: "Codex" }],
              displayName: "Studio Mac",
              machine: "studio.local",
              workspaceRoots: [{ path: "/Users/dev" }],
            },
          },
        ],
      }),
    });
    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "zed-client",
      connectionId: "conn-1",
      socket: relayClientSocket,
      stateSnapshot: {
        bufferedClientPayloads: [],
        clientPendingFrames: [],
        completedClientResponses: [
          {
            id: 1,
            jsonrpc: "2.0",
            result: {
              _meta: {
                "acp-runtime/remote/hostId": "host-1",
                "acp-runtime/remote/sessionAgent": { id: "codex-acp" },
                "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev"],
              },
              sessionId: "remembered-session",
            },
          },
        ],
        connectionId: "conn-1",
        hostId: "host-1",
        hostPendingFrames: [],
        hostQueuedFrames: [],
        hostRequests: [],
        lastAuthorization: {
          agent: { id: "codex-acp" },
          hostId: "host-1",
          workspaceRoots: ["/Users/dev"],
        },
        routeReady: true,
        seq: 0,
        sessionControlRequests: [],
      },
    });

    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          agent: { id: "codex-acp" },
          bridgeConnected: true,
          connectionId: "conn-1",
          hasActiveEvent: false,
          hostId: "host-1",
          hostOnline: false,
          lifecycle: "live",
          sessionId: "remembered-session",
          status: "active",
          workspaceRoots: ["/Users/dev"],
        }),
      ],
    });
  });

  it("reports session chain health with host and session status", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [
          { accountId: "acct-1", clientId: "browser-client" },
          { accountId: "acct-1", clientId: "zed-client" },
        ],
        grants: [
          {
            accountId: "acct-1",
            clientId: "browser-client",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [],
              displayName: "Studio Mac",
              workspaceRoots: [{ path: "/Users/dev" }],
            },
          },
        ],
        sessionBindings: [
          {
            accountId: "acct-1",
            agent: { id: "codex-acp" },
            clientId: "zed-client",
            hostId: "host-1",
            sessionId: "session-1",
            workspaceRoots: ["/Users/dev"],
          },
        ],
      }),
    });

    await expect(
      broker.checkSessionHealth({ accountId: "acct-1", clientId: "browser-client" }),
    ).resolves.toMatchObject({
      health: {
        detachedSessionCount: 1,
        liveSessionCount: 0,
        offlineSessionCount: 0,
        onlineHostCount: 0,
        status: "unhealthy",
      },
      ok: true,
    });
  });

  it("lists a session while the host runtime is starting it", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ sessionOpenTimeoutMs: 0 });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        displayName: "Studio Mac",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
      workspaceRoots: ["/workspace"],
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 41,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/workspace/project", mcpServers: [] },
      }),
    );

    await waitFor(() => hostFrames.length > 0);
    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "client-1" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          agent: { id: "fake-agent" },
          bridgeConnected: true,
          hasActiveEvent: true,
          hostId: "host-1",
          latestEvent: "Waiting for host runtime response.",
          requestId: 41,
          status: "starting",
          workspaceRoots: ["/workspace"],
        }),
      ],
    });
  });

  it("returns a product error when session start times out", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ sessionOpenTimeoutMs: 5 });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        displayName: "Studio Mac",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
      workspaceRoots: ["/workspace"],
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 42,
        jsonrpc: "2.0",
        method: "session/new",
        params: { cwd: "/workspace/project", mcpServers: [] },
      }),
    );

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32004,
        data: { reason: "host_session_open_timeout" },
        message:
          "Host runtime did not respond to session start in time. Restart the host or choose another host.",
      },
      id: 42,
      jsonrpc: "2.0",
    });
    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "client-1" }),
    ).resolves.toEqual({
      ok: true,
      sessions: [
        expect.objectContaining({
          error:
            "Host runtime did not respond to session start in time. Restart the host or choose another host.",
          hostId: "host-1",
          requestId: 42,
          status: "failed",
        }),
      ],
    });
  });

  it("does not time out a slow session load with the session start timeout", async () => {
    const identity = await createProofFixture();
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect", "acp:session:resume"],
          },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-1" }],
      }),
      sessionOpenTimeoutMs: 5,
    });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        displayName: "Studio Mac",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
      workspaceRoots: ["/workspace"],
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 44,
        jsonrpc: "2.0",
        method: "session/load",
        params: { sessionId: "session-1" },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(clientMessages).toEqual([]);
    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "client-1" }),
    ).resolves.toMatchObject({
      ok: true,
      sessions: expect.arrayContaining([
        expect.objectContaining({
          hostId: "host-1",
          requestId: 44,
          status: "starting",
        }),
      ]),
    });
  });

  it("returns a product error when a queued prompt waits too long for host reconnect", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ pendingHostRequestTimeoutMs: 5 });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        displayName: "Studio Mac",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
      workspaceRoots: ["/workspace"],
    });
    broker.removeHost("host-1", relayHostSocket);

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 43,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: "run", type: "text" }],
          sessionId: "session-1",
        },
      }),
    );

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32006,
        data: {
          reason: "host_reconnect_timeout",
          sessionId: "session-1",
        },
        message:
          "Host did not reconnect in time. The message was not sent; restart the host and retry.",
      },
      id: 43,
      jsonrpc: "2.0",
    });
    await expect(
      broker.listSessions({ accountId: "acct-1", clientId: "client-1" }),
    ).resolves.toMatchObject({
      ok: true,
      sessions: expect.arrayContaining([
        expect.objectContaining({
          error:
            "Host did not reconnect in time. The message was not sent; restart the host and retry.",
          hostId: "host-1",
          requestId: 43,
          status: "failed",
        }),
      ]),
    });
  });

  it("replays a completed prompt response after the native client reconnects", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 77,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
      }),
    );
    await waitFor(() => hostFrames.length > 0);

    broker.removeClient("conn-1", relayClientSocket);
    hostSocket.send(JSON.stringify({
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Data,
      payload: {
        id: 77,
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      },
      seq: 101,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clientMessages).toEqual([]);

    const [reconnectedClientSocket, reconnectedRelayClientSocket] =
      createMemoryWebSocketPair();
    const reconnectedMessages: unknown[] = [];
    reconnectedClientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        reconnectedMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: reconnectedRelayClientSocket,
    });

    await waitFor(() => reconnectedMessages.length > 0);
    expect(reconnectedMessages[0]).toEqual({
      id: 77,
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
  });

  it("persists completed prompt state before delivering the response to the client", async () => {
    const identity = await createProofFixture();
    const events: string[] = [];
    const broker = createBroker({
      onClientStateChanged(connectionId) {
        events.push(`persist:${connectionId}`);
      },
    });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    clientSocket.addEventListener("message", () => {
      events.push("deliver");
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 81,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
      }),
    );
    await waitFor(() =>
      hostFrames.some((frame) =>
        isRecord(frame) &&
        isRecord(frame.payload) &&
        frame.payload.id === 81
      )
    );

    hostSocket.send(JSON.stringify({
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Data,
      payload: {
        id: 81,
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      },
      seq: 102,
    }));

    await waitFor(() => events.includes("deliver"));
    expect(events.slice(-2)).toEqual(["persist:conn-1", "deliver"]);
  });

  it("persists host-bound prompt state before delivering it to the host", async () => {
    const identity = await createProofFixture();
    let broker: AcpRelayBroker;
    let snapshotBeforeHostDelivery: AcpRelayClientStateSnapshot | undefined;
    const events: string[] = [];
    broker = createBroker({
      onClientStateChanged(connectionId) {
        snapshotBeforeHostDelivery = broker.clientStateSnapshot(connectionId);
        events.push(`persist:${connectionId}`);
      },
    });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
        events.push("host-deliver");
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    await broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 82,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
      }),
    );

    await waitFor(() =>
      hostFrames.some((frame) =>
        isRecord(frame) &&
        isRecord(frame.payload) &&
        frame.payload.id === 82
      )
    );
    expect(events.slice(-2)).toEqual(["persist:conn-1", "host-deliver"]);
    expect(snapshotBeforeHostDelivery?.hostRequests).toEqual([
      expect.objectContaining({ id: 82, method: "session/prompt" }),
    ]);
    expect(snapshotBeforeHostDelivery?.hostPendingFrames).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ id: 82, method: "session/prompt" }),
      }),
    ]);

    const restoredBroker = createBroker();
    const [restoredClientSocket, restoredRelayClientSocket] = createMemoryWebSocketPair();
    const restoredClientMessages: unknown[] = [];
    restoredClientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        restoredClientMessages.push(JSON.parse(event.data));
      }
    });
    await restoredBroker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
      nativeClientAck: true,
      socket: restoredRelayClientSocket,
      stateSnapshot: snapshotBeforeHostDelivery,
    });
    await restoredBroker.handleClientText(
      "conn-1",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/recover_in_flight",
        params: { requests: [{ id: 82, method: "session/prompt" }] },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restoredClientMessages).toEqual([]);
  });

  it("uses native recovery to avoid replaying a prompt while the host is still running it", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 78,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
      }),
    );
    await waitFor(() =>
      hostFrames.some((frame) =>
        isRecord(frame) &&
        isRecord(frame.payload) &&
        frame.payload.id === 78
      )
    );
    const promptFrameCount = hostFrames.filter((frame) =>
      isRecord(frame) &&
      isRecord(frame.payload) &&
      frame.payload.id === 78
    ).length;

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/recover_in_flight",
        params: { requests: [{ id: 78, method: "session/prompt" }] },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hostFrames.filter((frame) =>
      isRecord(frame) &&
      isRecord(frame.payload) &&
      frame.payload.id === 78
    )).toHaveLength(promptFrameCount);
    expect(clientMessages).toEqual([]);
  });

  it("replays an acked in-flight prompt to the host after relay restart so host can return the journaled result", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const request = {
      id: 83,
      jsonrpc: "2.0",
      method: "session/prompt",
      params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
    } as const;
    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    await broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
      nativeClientAck: true,
      socket: relayClientSocket,
      stateSnapshot: {
        bufferedClientPayloads: [],
        clientPendingFrames: [],
        completedClientResponses: [],
        connectionId: "conn-1",
        connectionProof: identity.proof,
        connectionProofs: [identity.proof],
        hostId: "host-1",
        hostPendingFrames: [],
        hostQueuedFrames: [],
        hostRequests: [request],
        hostRuntimeInstanceId: "runtime-1",
        routeReady: true,
        seq: 3,
        sessionControlRequests: [],
      },
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/recover_in_flight",
        params: { requests: [{ id: 83, method: "session/prompt" }] },
      }),
    );

    await waitFor(() =>
      hostFrames.some((frame) =>
        isRecord(frame) &&
        isRecord(frame.payload) &&
        frame.payload.id === 83
      )
    );
    expect(clientMessages).toEqual([]);

    hostSocket.send(JSON.stringify({
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Data,
      payload: {
        id: 83,
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      },
      seq: 103,
    }));

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toEqual({
      id: 83,
      jsonrpc: "2.0",
      result: { stopReason: "end_turn" },
    });
  });

  it("returns an unknown-status error when native recovery cannot prove prompt state", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
      nativeClientAck: true,
      routeReady: true,
      socket: relayClientSocket,
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/recover_in_flight",
        params: { requests: [{ id: 79, method: "session/prompt" }] },
      }),
    );

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32005,
        data: { reason: "request_status_unknown_after_reconnect" },
      },
      id: 79,
      jsonrpc: "2.0",
    });
  });

  it("fails a prompt explicitly when the host runtime restarts after receiving it", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void broker.handleHostText(event.data);
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      nativeClientAck: true,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      connectionId: "conn-1",
      hostId: "host-1",
      skipHostBootstrapInitialize: true,
    });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 80,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: { prompt: [{ text: "run", type: "text" }], sessionId: "session-1" },
      }),
    );
    await waitFor(() =>
      hostFrames.some((frame) =>
        isRecord(frame) &&
        isRecord(frame.payload) &&
        frame.payload.id === 80
      )
    );
    const requestFrame = hostFrames.find((frame) =>
      isRecord(frame) &&
      isRecord(frame.payload) &&
      frame.payload.id === 80
    ) as { seq: number };
    hostSocket.send(JSON.stringify({
      ack: requestFrame.seq,
      channelId: "acp",
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Ack,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [, restartedRelayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        runtimeInstanceId: "runtime-2",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: restartedRelayHostSocket,
    });

    await waitFor(() => clientMessages.length > 0);
    expect(clientMessages[0]).toMatchObject({
      error: {
        code: -32003,
        data: { reason: "host_restarted" },
      },
      id: 80,
      jsonrpc: "2.0",
    });
  });

  it("keeps a custom host name while refreshing runtime metadata", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [],
              displayName: "Studio Mac",
              machine: "old-hostname",
              workspaceRoots: [],
            },
          },
        ],
      }),
    });
    const [, relayHostSocket] = createMemoryWebSocketPair();
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        machine: "dev-hostname",
        runtimeInstanceId: "runtime-1",
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    await expect(
      broker.discoverableHosts({
        accountId: "acct-1",
        clientId: "client-1",
      }),
    ).resolves.toEqual({
      hosts: [
        {
          hostId: "host-1",
          metadata: {
            agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
            displayName: "Studio Mac",
            machine: "dev-hostname",
            runtimeInstanceId: "runtime-1",
            workspaceRoots: [{ path: "/workspace" }],
          },
          online: true,
        },
      ],
      ok: true,
    });
  });

  it("updates the custom host display name", async () => {
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          {
            accountId: "acct-1",
            hostId: "host-1",
            metadata: {
              agentTypes: [],
              machine: "dev-hostname",
              workspaceRoots: [],
            },
          },
        ],
      }),
    });

    await expect(
      broker.setHostDisplayName({
        accountId: "acct-1",
        clientId: "client-1",
        hostId: "host-1",
        name: "Build Host",
      }),
    ).resolves.toMatchObject({
      host: {
        hostId: "host-1",
        metadata: {
          displayName: "Build Host",
          machine: "dev-hostname",
        },
      },
      ok: true,
    });
  });

  it("revokes and removes a host from discovery", async () => {
    const store = new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
      grants: [
        {
          accountId: "acct-1",
          clientId: "client-1",
          hostId: "host-1",
          policyVersion: 1,
          scopes: ["acp:connect"],
        },
      ],
      hosts: [{ accountId: "acct-1", hostId: "host-1" }],
    });
    const broker = new AcpRelayBroker({ controlPlaneStore: store });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostCloseEvents: { code?: number; reason?: string }[] = [];
    hostSocket.addEventListener("close", (event) => {
      hostCloseEvents.push(event ?? {});
    });
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      socket: relayHostSocket,
    });

    await expect(
      broker.revokeHost({
        accountId: "acct-1",
        clientId: "client-1",
        hostId: "host-1",
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      broker.discoverableHosts({
        accountId: "acct-1",
        clientId: "client-1",
      }),
    ).resolves.toEqual({ hosts: [], ok: true });
    await expect(
      store.resolveGrant({
        accountId: "acct-1",
        clientId: "client-1",
        hostId: "host-1",
        requiredScopes: ["acp:connect"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "Host is not registered for this account.",
    });
    expect(hostCloseEvents).toEqual([
      { code: 1008, reason: "Host authorization revoked." },
    ]);
  });

  it("lets authorization select any host with a matching bridge proof", async () => {
    const authority = await createEd25519KeyPair();
    const client = await createEd25519KeyPair();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-1",
      principalId: "client-1",
      principalPublicKey: client.publicKey,
      principalType: "client",
      signingKey: { kid: "authority-1", privateKey: authority.privateKey },
    });
    const credential = { accountSession, privateKey: client.privateKey };
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-2",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          { accountId: "acct-1", hostId: "host-1" },
          { accountId: "acct-1", hostId: "host-2" },
        ],
      }),
    });
    const [, relayHostSocket1] = createMemoryWebSocketPair();
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        machine: "first-machine",
        workspaceRoots: [{ path: "/workspace-1" }],
      },
      socket: relayHostSocket1,
    });
    const [hostSocket2, relayHostSocket2] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket2.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-2",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        machine: "second-machine",
        workspaceRoots: [{ path: "/workspace-2" }],
      },
      socket: relayHostSocket2,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    const proof1 = await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential,
      hostId: "host-1",
    });
    const proof2 = await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential,
      hostId: "host-2",
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: proof1,
      connectionProofs: [proof1, proof2],
      socket: relayClientSocket,
    });

    await expect(
      broker.discoverableHostsForConnection("conn-1"),
    ).resolves.toMatchObject({
      hosts: [
        { hostId: "host-1", online: true },
        { hostId: "host-2", online: true },
      ],
      ok: true,
    });
    await expect(
      broker.activeAuthorizableHostRouteIds("conn-1"),
    ).resolves.toEqual(["host-1", "host-2"]);
    await expect(
      broker.authorizeClient({
        connectionId: "conn-1",
        hostId: "host-2",
        workspaceRoots: ["/workspace-2"],
      }),
    ).resolves.toMatchObject({
      hostId: "host-2",
      ok: true,
    });

    await waitFor(() => hostFrames.length > 0);
    expect(hostFrames[0]).toMatchObject({
      hostId: "host-2",
      proof: proof2,
      workspaceRoots: ["/workspace-2"],
    });
  });

  it("merges fresh connection proofs when a client connection resumes", async () => {
    const authority = await createEd25519KeyPair();
    const client = await createEd25519KeyPair();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-1",
      principalId: "client-1",
      principalPublicKey: client.publicKey,
      principalType: "client",
      signingKey: { kid: "authority-1", privateKey: authority.privateKey },
    });
    const credential = { accountSession, privateKey: client.privateKey };
    const broker = new AcpRelayBroker({
      controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
        accounts: [{ accountId: "acct-1" }],
        clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
        grants: [
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-1",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
          {
            accountId: "acct-1",
            clientId: "client-1",
            hostId: "host-2",
            policyVersion: 1,
            scopes: ["acp:connect"],
          },
        ],
        hosts: [
          { accountId: "acct-1", hostId: "host-1" },
          { accountId: "acct-1", hostId: "host-2" },
        ],
      }),
    });
    const [, relayHostSocket1] = createMemoryWebSocketPair();
    await broker.registerHost({ hostId: "host-1", socket: relayHostSocket1 });
    const [, relayHostSocket2] = createMemoryWebSocketPair();
    await broker.registerHost({ hostId: "host-2", socket: relayHostSocket2 });

    const proof1 = await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential,
      hostId: "host-1",
    });
    const proof2 = await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential,
      hostId: "host-2",
    });
    const [, firstRelayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: proof1,
      socket: firstRelayClientSocket,
    });

    const [, secondRelayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: proof1,
      connectionProofs: [proof1, proof2],
      socket: secondRelayClientSocket,
    });

    await expect(
      broker.activeAuthorizableHostRouteIds("conn-1"),
    ).resolves.toEqual(["host-1", "host-2"]);
  });

  it("requires the matching authorization page selection for a new session on an authorized connection", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ authWaitMs: 5 });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "fake-agent" },
        connectionId: "conn-1",
        hostId: "host-1",
        skipHostBootstrapInitialize: true,
        workspaceRoots: ["/workspace"],
      }),
    ).resolves.toMatchObject({ ok: true });
    hostFrames.length = 0;

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          _meta: {
            "acp-runtime/remote/sessionSelectionId": "conn-1:1:selection-1",
          },
          cwd: "/workspace/project",
          mcpServers: [],
        },
      }),
    );

    expect(hostFrames).toEqual([]);
    expect(clientMessages).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          message:
            "Authentication required: session selection was not completed.",
        }),
        id: 1,
      }),
    ]);
  });

  it("does not let a generic authorization post satisfy an explicit session selection", async () => {
    const identity = await createProofFixture();
    const broker = createBroker({ authWaitMs: 5 });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "fake-agent" },
        connectionId: "conn-1",
        hostId: "host-1",
        skipHostBootstrapInitialize: true,
        workspaceRoots: ["/workspace"],
      }),
    ).resolves.toMatchObject({ ok: true });
    hostFrames.length = 0;

    const pendingSession = broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          _meta: {
            "acp-runtime/remote/sessionSelectionId": "conn-1:1:selection-1",
          },
          cwd: "/workspace/project",
          mcpServers: [],
        },
      }),
    );

    await expect(
      broker.authorizeClient({
        clientAgent: { id: "fake-agent" },
        connectionId: "conn-1",
        hostId: "host-1",
        workspaceRoots: ["/workspace"],
      }),
    ).resolves.toMatchObject({ ok: true });
    await pendingSession;

    expect(hostFrames).toEqual([]);
    expect(clientMessages).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          message:
            "Authentication required: session selection was not completed.",
        }),
        id: 1,
      }),
    ]);
  });

  it("treats a matching session selection id as an explicit default session choice", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        connectionId: "conn-1",
        hostId: "host-1",
        sessionSelectionId: "conn-1:1:selection-1",
      }),
    ).resolves.toMatchObject({ ok: true });
    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          _meta: {
            "acp-runtime/remote/sessionSelectionId": "conn-1:1:selection-1",
          },
          cwd: "/workspace/project",
          mcpServers: [],
        },
      }),
    );

    await waitFor(() =>
      hostFrames.some(
        (frame) =>
          isRecord(frame) &&
          isRecord(frame.payload) &&
          frame.payload.id === 1 &&
          frame.payload.method === "session/new",
      ),
    );
  });

  it("suppresses duplicate relay bootstrap responses and still opens the selected session", async () => {
    const identity = await createProofFixture();
    const broker = createBroker();
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    relayHostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        void broker.handleHostText(event.data);
      }
    });
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const frame = JSON.parse(event.data);
      hostFrames.push(frame);
      if (
        !isRecord(frame) ||
        frame.frameType !== AcpRemoteFrameType.Data ||
        !isRecord(frame.payload)
      ) {
        return;
      }
      if (frame.payload.method === "initialize") {
        const response = {
          channelId: "acp",
          channelKind: AcpRemoteChannelKind.Acp,
          connectionId: "conn-1",
          frameType: AcpRemoteFrameType.Data,
          payload: {
            id: frame.payload.id,
            jsonrpc: "2.0",
            result: {
              agentCapabilities: {},
              agentInfo: { name: "fake-agent", title: "Fake Agent" },
              protocolVersion: 1,
            },
          },
          seq: 100,
        };
        hostSocket.send(JSON.stringify(response));
        hostSocket.send(JSON.stringify({ ...response, seq: 101 }));
      }
      if (frame.payload.method === "session/new") {
        hostSocket.send(JSON.stringify({
          channelId: "acp",
          channelKind: AcpRemoteChannelKind.Acp,
          connectionId: "conn-1",
          frameType: AcpRemoteFrameType.Data,
          payload: {
            id: frame.payload.id,
            jsonrpc: "2.0",
            result: { sessionId: "session-1" },
          },
          seq: 102,
        }));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [clientSocket, relayClientSocket] = createMemoryWebSocketPair();
    const clientMessages: unknown[] = [];
    clientSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        clientMessages.push(JSON.parse(event.data));
      }
    });
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });

    await expect(
      broker.authorizeClient({
        connectionId: "conn-1",
        hostId: "host-1",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      broker.authorizeClient({
        clientAgent: { id: "fake-agent" },
        connectionId: "conn-1",
        hostId: "host-1",
        sessionSelectionId: "conn-1:1:selection-1",
        workspaceRoots: ["/workspace"],
      }),
    ).resolves.toMatchObject({ ok: true });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          _meta: {
            "acp-runtime/remote/sessionSelectionId": "conn-1:1:selection-1",
          },
          cwd: "/workspace/project",
          mcpServers: [],
        },
      }),
    );

    await waitFor(() =>
      clientMessages.some(
        (message) =>
          isRecord(message) &&
          message.id === 1 &&
          isRecord(message.result) &&
          message.result.sessionId === "session-1",
      ),
    );
    expect(
      clientMessages.some(
        (message) =>
          isRecord(message) &&
          message.id === "relay:conn-1:initialize",
      ),
    ).toBe(false);
    expect(
      hostFrames.some(
        (frame) =>
          isRecord(frame) &&
          isRecord(frame.payload) &&
          frame.payload.method === "session/new" &&
          frame.payload.id === 1,
      ),
    ).toBe(true);
  });

  it("renders offline hosts as disabled authorization choices", () => {
    const page = createRelayAuthorizationPage({
      accountId: "acct-1",
      connectionId: "conn-1",
      hosts: [
        {
          hostId: "host-1",
          metadata: {
            agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
            machine: "online-machine",
            workspaceRoots: [{ path: "/workspace" }],
          },
          online: true,
        },
        {
          hostId: "host-2",
          online: false,
        },
      ],
      requestUrl: "https://relay.test/authorize?connectionId=conn-1",
    });

    expect(page).toContain('"hostId":"host-2"');
    expect(page).toContain("button.disabled = !online");
    expect(page).toContain("Offline");
  });

  it("creates a relay business span and forwards its traceparent to the host", async () => {
    const identity = await createProofFixture();
    const traceSpans: AcpRelayTraceSpanInput[] = [];
    const broker = createBroker({
      onTraceSpan(input) {
        traceSpans.push(input);
        return createAcpRemoteChildTraceContext(input.parent);
      },
    });
    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    const hostFrames: unknown[] = [];
    hostSocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        hostFrames.push(JSON.parse(event.data));
      }
    });
    await broker.registerHost({
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [, relayClientSocket] = createMemoryWebSocketPair();
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      socket: relayClientSocket,
    });
    await broker.authorizeClient({
      clientAgent: { id: "fake-agent" },
      connectionId: "conn-1",
      hostId: "host-1",
      workspaceRoots: ["/workspace"],
    });

    await broker.handleClientText(
      "conn-1",
      JSON.stringify({
        id: 7,
        jsonrpc: "2.0",
        method: "session/new",
        params: {
          _meta: {
            traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
          },
          cwd: "/workspace/project",
          mcpServers: [],
        },
      }),
    );

    await waitFor(() =>
      hostFrames.some(
        (frame) =>
          isRecord(frame) &&
          frame.frameType === AcpRemoteFrameType.Data,
      ),
    );
    const dataFrame = hostFrames.find(
      (frame) =>
        isRecord(frame) &&
        frame.frameType === AcpRemoteFrameType.Data &&
        isRecord(frame.payload) &&
        frame.payload.id === 7,
    ) as { payload: { params?: { _meta?: { traceparent?: string } } } };
    const forwardedTraceparent = dataFrame.payload.params?._meta?.traceparent;

    expect(traceSpans[0]).toMatchObject({
      name: "free.relay.transport.client_to_host.session/new",
      parent: {
        spanId: "2222222222222222",
        traceId: "11111111111111111111111111111111",
      },
    });
    expect(forwardedTraceparent).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/,
    );
    expect(forwardedTraceparent).not.toBe(
      "00-11111111111111111111111111111111-2222222222222222-01",
    );
  });
});

function createBroker(options: AcpRelayBrokerOptions = {}): AcpRelayBroker {
  return new AcpRelayBroker({
    ...options,
    controlPlaneStore: new AcpRelayInMemoryControlPlaneStore({
      accounts: [{ accountId: "acct-1" }],
      clientDevices: [{ accountId: "acct-1", clientId: "client-1" }],
      grants: [
        {
          accountId: "acct-1",
          clientId: "client-1",
          hostId: "host-1",
          policyVersion: 1,
          scopes: ["acp:connect", "acp:session:create", "acp:turn:send"],
        },
      ],
      hosts: [{ accountId: "acct-1", hostId: "host-1" }],
    }),
  });
}

async function waitForSessionTitle(
  broker: AcpRelayBroker,
  expectedTitle: string,
): Promise<void> {
  let lastTitle: string | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await broker.listSessions({
      accountId: "acct-1",
      clientId: "client-1",
    });
    lastTitle = result.sessions[0]?.title;
    if (result.sessions[0]?.title === expectedTitle) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Timed out waiting for session title ${expectedTitle}; last title was ${lastTitle}.`,
  );
}

async function createProofFixture() {
  const authority = await createEd25519KeyPair();
  const client = await createEd25519KeyPair();
  const accountSession = await createAcpRemoteAccountSession({
    accountId: "acct-1",
    principalId: "client-1",
    principalPublicKey: client.publicKey,
    principalType: "client",
    signingKey: { kid: "authority-1", privateKey: authority.privateKey },
  });
  return {
    proof: await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential: { accountSession, privateKey: client.privateKey },
      hostId: "host-1",
    }),
  };
}

async function createEd25519KeyPair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  return {
    privateKey: await exportEd25519PrivateKey(pair.privateKey),
    publicKey: await exportEd25519PublicKey(pair.publicKey),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createAttachmentAck(
  upload: NonNullable<ReturnType<typeof decodeAcpRemoteAttachmentUpload>>,
) {
  return {
    attachmentId: upload.header.attachmentId,
    connectionId: upload.header.connectionId,
    frameType: AcpRemoteAttachmentFrameType.Ack,
    mimeType: upload.header.mimeType,
    ok: true,
    requestId: upload.header.requestId,
    sha256: upload.header.sha256,
    size: upload.body.byteLength,
    uri: upload.header.uri,
    version: 1,
  };
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
