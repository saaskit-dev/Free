import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
  type AcpRemoteConnectionProof,
} from "../protocol/index.js";
import { createMemoryWebSocketPair, waitFor } from "../shared/test-helpers.js";
import { createAcpRemoteHostConnection } from "./relay-connection.js";

describe("createAcpRemoteHostConnection", () => {
  it("accepts hello frames with a valid bridge-held account proof", async () => {
    const identity = await createProofFixture();
    const [hostSocket, relaySocket] = createMemoryWebSocketPair();
    const outbound: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        outbound.push(JSON.parse(event.data));
      }
    });

    const handle = createAcpRemoteHostConnection({
      accountId: "acct-1",
      accountSessionVerificationKeys: [
        { kid: "authority-1", publicKey: identity.authorityPublicKey },
      ],
      hostId: "host-1",
      now: () => new Date("2026-05-10T00:00:02.000Z"),
      runtime: {} as never,
      socket: hostSocket,
    });
    relaySocket.send(createHello("conn-1", identity.proof));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(outbound).toEqual([]);
    handle.close();
  });

  it("rejects forged proofs that relay cannot sign for the bridge", async () => {
    const identity = await createProofFixture({ forgeBridgeSignature: true });
    const [hostSocket, relaySocket] = createMemoryWebSocketPair();
    const outbound: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        outbound.push(JSON.parse(event.data));
      }
    });

    createAcpRemoteHostConnection({
      accountId: "acct-1",
      accountSessionVerificationKeys: [
        { kid: "authority-1", publicKey: identity.authorityPublicKey },
      ],
      hostId: "host-1",
      now: () => new Date("2026-05-10T00:00:02.000Z"),
      runtime: {} as never,
      socket: hostSocket,
    });
    relaySocket.send(createHello("conn-1", identity.proof));

    await waitFor(() => outbound.length > 0);
    expect(outbound[0]).toMatchObject({
      code: "invalid_authorization",
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Close,
      reason: "Invalid connection proof signature.",
    });
  });
});

function createHello(connectionId: string, proof: AcpRemoteConnectionProof): string {
  return JSON.stringify({
    connectionId,
    endpoint: AcpRemoteEndpointKind.Client,
    frameType: AcpRemoteFrameType.Hello,
    hostId: "host-1",
    proof,
    protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
  });
}

async function createProofFixture(options: { forgeBridgeSignature?: boolean } = {}) {
  const authority = await createEd25519KeyPair();
  const client = await createEd25519KeyPair();
  const attacker = await createEd25519KeyPair();
  const accountSession = await createAcpRemoteAccountSession({
    accountId: "acct-1",
    now: new Date("2026-05-10T00:00:00.000Z"),
    principalId: "client-1",
    principalPublicKey: client.publicKey,
    principalType: "client",
    signingKey: {
      kid: "authority-1",
      privateKey: authority.privateKey,
    },
  });
  const proof = await createAcpRemoteConnectionProof({
    connectionId: "conn-1",
    credential: {
      accountSession,
      privateKey: options.forgeBridgeSignature
        ? attacker.privateKey
        : client.privateKey,
    },
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
