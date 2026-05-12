import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Client,
} from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AcpRuntimePrompt,
  AcpRuntimeSession,
} from "@saaskit-dev/acp-runtime";
import { AcpRuntimeTurnEventType } from "@saaskit-dev/acp-runtime";
import { describe, expect, it } from "vitest";

import { AcpRelayInMemoryControlPlaneStore } from "../relay/src/control-plane-store.js";
import { AcpRelayBroker, type RelaySocket } from "../relay/src/relay-core.js";
import { createAcpRemoteHostConnection } from "./host/relay-connection.js";
import {
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  createAcpJsonRpcWebSocketStream,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
} from "./protocol/index.js";
import {
  MemoryWebSocket,
  createMemoryWebSocketPair,
} from "./shared/test-helpers.js";

describe("remote ACP end-to-end", () => {
  it("uses the ACP client SDK through relay and host without exposing remote auth churn", async () => {
    const identity = await createProofFixture();
    const attachmentRootDir = await mkdtemp(join(tmpdir(), "free-e2e-attachments-"));
    let receivedPrompt: AcpRuntimePrompt | undefined;
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
            scopes: [
              "acp:connect",
              "acp:session:create",
              "acp:turn:send",
              "acp:session:resume",
            ],
          },
        ],
        hosts: [{ accountId: "acct-1", hostId: "host-1" }],
      }),
    });

    const [hostSocket, relayHostSocket] = createMemoryWebSocketPair();
    bindBrokerHostSocket(broker, relayHostSocket);
    const host = createAcpRemoteHostConnection({
      accountId: "acct-1",
      accountSessionVerificationKeys: [
        { kid: "authority-1", publicKey: identity.authorityPublicKey },
      ],
      agent: "fake-agent",
      attachmentRootDir,
      hostId: "host-1",
      now: () => new Date("2026-05-10T00:00:02.000Z"),
      runtime: createFakeRuntime({
        onPrompt(prompt) {
          receivedPrompt = prompt;
        },
      }),
      socket: hostSocket,
      workspaceRoots: ["/workspace"],
    });
    await broker.registerHost({
      accountId: "acct-1",
      hostId: "host-1",
      metadata: {
        agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
        workspaceRoots: [{ path: "/workspace" }],
      },
      socket: relayHostSocket,
    });

    const [nativeClientSocket, relayClientSocket] = createMemoryWebSocketPair();
    bindBrokerClientSocket(broker, "conn-1", relayClientSocket);
    broker.registerClient({
      accountId: "acct-1",
      authUrl: "https://relay.test/authorize?connectionId=conn-1",
      clientId: "client-1",
      connectionId: "conn-1",
      connectionProof: identity.proof,
      hostId: "host-1",
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

    const notifications: unknown[] = [];
    const client = new ClientSideConnection(
      () =>
        ({
          async requestPermission() {
            return {
              outcome: { optionId: "allow_once", outcome: "selected" },
            };
          },
          async sessionUpdate(params) {
            notifications.push(params);
          },
        }) satisfies Client,
      createAcpJsonRpcWebSocketStream(nativeClientSocket),
    );
    void client.closed.catch(() => {});

    const initialize = await client.initialize({
      clientCapabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(initialize.agentInfo?.name).toBe("free");

    const session = await client.newSession({
      cwd: "/workspace/project",
      mcpServers: [],
    });
    expect(session.sessionId).toBe("runtime-session-1");

    const response = await client.prompt({
      prompt: [{ text: "hello", type: "text" }],
      sessionId: session.sessionId,
    });
    expect(response).toMatchObject({
      stopReason: "end_turn",
    });
    expect(JSON.stringify(notifications)).toContain("hello from runtime");

    const imageBody = new TextEncoder().encode("image-bytes");
    const attachment = await broker.forwardClientAttachment({
      accountId: "acct-1",
      attachmentId: "att-1",
      body: imageBody,
      clientId: "client-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "client-message-1",
      mimeType: "image/png",
      sha256: sha256Hex(imageBody),
    });
    expect(attachment).toMatchObject({ ok: true });
    if (!attachment.ok) {
      throw new Error(attachment.reason);
    }

    const imageResponse = await client.prompt({
      messageId: "client-message-1",
      prompt: [{
        mimeType: "image/png",
        type: "resource_link",
        uri: attachment.uri,
      } as never],
      sessionId: session.sessionId,
    });
    expect(imageResponse).toMatchObject({
      stopReason: "end_turn",
      userMessageId: "client-message-1",
    });
    expect(receivedPrompt).toEqual([
      {
        mediaType: "image/png",
        type: "image",
        uri: `data:image/png;base64,${Buffer.from(imageBody).toString("base64")}`,
      },
    ]);

    await client.closeSession({ sessionId: session.sessionId });
    host.close();
    nativeClientSocket.close();
    await rm(attachmentRootDir, { force: true, recursive: true });
  });
});

function bindBrokerClientSocket(
  broker: AcpRelayBroker,
  connectionId: string,
  socket: MemoryWebSocket,
): void {
  socket.addEventListener("message", (event) => {
    void broker.handleClientText(connectionId, String(event.data));
  });
  socket.addEventListener("close", (event) => {
    broker.removeClient(connectionId, socket as RelaySocket, {
      final:
        event?.code === 1000 &&
        event.reason === "ACP client connection closed.",
    });
  });
}

function bindBrokerHostSocket(
  broker: AcpRelayBroker,
  socket: MemoryWebSocket,
): void {
  socket.addEventListener("message", (event) => {
    broker.handleHostText(String(event.data));
  });
}

async function createProofFixture() {
  const authority = await createEd25519KeyPair();
  const client = await createEd25519KeyPair();
  const accountSession = await createAcpRemoteAccountSession({
    accountId: "acct-1",
    now: new Date("2026-05-10T00:00:00.000Z"),
    principalId: "client-1",
    principalPublicKey: client.publicKey,
    principalType: "client",
    signingKey: { kid: "authority-1", privateKey: authority.privateKey },
  });
  const proof = await createAcpRemoteConnectionProof({
    connectionId: "conn-1",
    credential: { accountSession, privateKey: client.privateKey },
    hostId: "host-1",
    now: new Date("2026-05-10T00:00:01.000Z"),
  });
  return {
    authorityPublicKey: authority.publicKey,
    proof,
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

function createFakeRuntime(options: {
  onPrompt?: (prompt: AcpRuntimePrompt) => void;
} = {}): {
  sessions: {
    list(): Promise<{ entries: [] }>;
    load(): Promise<AcpRuntimeSession>;
    resume(): Promise<AcpRuntimeSession>;
    start(): Promise<AcpRuntimeSession>;
  };
} {
  const session = createFakeRuntimeSession(options);
  return {
    sessions: {
      async list() {
        return { entries: [] };
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
}

function createFakeRuntimeSession(options: {
  onPrompt?: (prompt: AcpRuntimePrompt) => void;
} = {}): AcpRuntimeSession {
  const id = "runtime-session-1";
  return {
    agent: {
      listConfigOptions: () => [],
      listModes: () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
    },
    capabilities: {
      agent: { prompt: true },
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
      agent: "fake-agent",
      cwd: "/workspace/project",
      session: { id },
      version: 1,
    }),
    state: {
      history: { drain: () => [] },
      thread: { entries: () => [] },
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
      send: async (_prompt: AcpRuntimePrompt) => ({
        output: [{ text: "hello from runtime", type: "text" }],
        outputText: "hello from runtime",
        turnId: "turn-1",
      }),
      start: (prompt: AcpRuntimePrompt) => {
        options.onPrompt?.(prompt);
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
    stopReason: "end_turn",
    turnId: "turn-1",
    type: AcpRuntimeTurnEventType.Completed,
  };
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
