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
  createRelayAuthorizationPage,
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
