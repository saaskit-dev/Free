import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  assertAcpRemoteFrame,
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
  parseAcpRemoteFrameText,
  readAcpRemoteAccountSessionVerificationKeys,
  requiredScopeForAcpPayload,
  verifyAcpRemoteConnectionProof,
} from "./index.js";

describe("remote account sessions", () => {
  it("includes production and local development authority keys by default", () => {
    expect(readAcpRemoteAccountSessionVerificationKeys().map((key) => key.kid))
      .toEqual([
        "free-prod-2026-05-10",
        "free-default-2026-05-10",
      ]);
  });

  it("verifies an authority-signed account session and client-held connection proof", async () => {
    const { authority, client } = await createIdentityKeys();
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
        privateKey: client.privateKey,
      },
      hostId: "host-1",
      now: new Date("2026-05-10T00:00:01.000Z"),
    });

    await expect(
      verifyAcpRemoteConnectionProof(
        proof,
        [{ kid: "authority-1", publicKey: authority.publicKey }],
        {
          accountId: "acct-1",
          clientId: "client-1",
          connectionId: "conn-1",
          hostId: "host-1",
          now: new Date("2026-05-10T00:00:02.000Z"),
        },
      ),
    ).resolves.toMatchObject({
      accountId: "acct-1",
      clientId: "client-1",
      ok: true,
    });
  });

  it("rejects relay-forged proof when the bridge private key is missing", async () => {
    const { authority, client, attacker } = await createIdentityKeys();
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
    const forged = await createAcpRemoteConnectionProof({
      clientId: "client-1",
      connectionId: "conn-1",
      credential: {
        accountSession,
        privateKey: attacker.privateKey,
      },
      hostId: "host-1",
      now: new Date("2026-05-10T00:00:01.000Z"),
    });

    await expect(
      verifyAcpRemoteConnectionProof(
        forged,
        [{ kid: "authority-1", publicKey: authority.publicKey }],
        {
          connectionId: "conn-1",
          hostId: "host-1",
          now: new Date("2026-05-10T00:00:02.000Z"),
        },
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "Invalid connection proof signature.",
    });
  });

  it("validates hello frames carrying a connection proof", async () => {
    const { authority, client } = await createIdentityKeys();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-1",
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
      credential: { accountSession, privateKey: client.privateKey },
      hostId: "host-1",
    });

    expect(
      assertAcpRemoteFrame({
        connectionId: "conn-1",
        endpoint: AcpRemoteEndpointKind.Client,
        frameType: AcpRemoteFrameType.Hello,
        hostId: "host-1",
        proof,
        protocolVersion: ACP_REMOTE_PROTOCOL_VERSION,
      }),
    ).toMatchObject({
      frameType: AcpRemoteFrameType.Hello,
      proof,
    });
  });
});

describe("remote protocol helpers", () => {
  it("keeps ACP method scope mapping in the protocol package", () => {
    expect(
      requiredScopeForAcpPayload({
        id: 1,
        jsonrpc: "2.0",
        method: "session/prompt",
      }),
    ).toBe("acp:turn:send");
    expect(
      requiredScopeForAcpPayload({
        jsonrpc: "2.0",
        method: "session/cancel",
      }),
    ).toBe("acp:turn:cancel");
    expect(
      requiredScopeForAcpPayload({
        id: 1,
        jsonrpc: "2.0",
        result: {},
      }),
    ).toBeUndefined();
  });

  it("parses ACP remote frame text through the protocol package", () => {
    expect(
      parseAcpRemoteFrameText(JSON.stringify({
        connectionId: "conn-1",
        frameType: AcpRemoteFrameType.Ping,
        nonce: "nonce-1",
      })),
    ).toMatchObject({
      connectionId: "conn-1",
      frameType: AcpRemoteFrameType.Ping,
    });
    expect(parseAcpRemoteFrameText("{")).toBeUndefined();
  });
});

async function createIdentityKeys(): Promise<{
  attacker: { privateKey: string; publicKey: string };
  authority: { privateKey: string; publicKey: string };
  client: { privateKey: string; publicKey: string };
}> {
  const [authority, client, attacker] = await Promise.all([
    createEd25519KeyPair(),
    createEd25519KeyPair(),
    createEd25519KeyPair(),
  ]);
  return { attacker, authority, client };
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
