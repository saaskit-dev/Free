import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
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
  type AcpRelayBrokerOptions,
  type AcpRelayTraceSpanInput,
} from "./relay-core.js";

describe("AcpRelayBroker", () => {
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
    await broker.registerHost("host-1", relayHostSocket, {
      agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
      workspaceRoots: [{ path: "/workspace" }],
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
    await broker.registerHost("host-1", firstRelayHostSocket, {
      agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
      workspaceRoots: [{ path: "/workspace" }],
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
    await broker.registerHost("host-1", secondRelayHostSocket, {
      agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
      workspaceRoots: [{ path: "/workspace" }],
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
    await broker.registerHost("host-1", relayHostSocket, {
      agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
      workspaceRoots: [{ path: "/workspace" }],
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
    await broker.registerHost("host-1", relayHostSocket, {
      agentTypes: [{ id: "fake-agent", label: "Fake Agent" }],
      workspaceRoots: [{ path: "/workspace" }],
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
          scopes: ["acp:connect", "acp:session:create"],
        },
      ],
      hosts: [{ accountId: "acct-1", hostId: "host-1" }],
    }),
  });
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
