import { describe, expect, it } from "vitest";

import {
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  encodeAcpRemoteConnectionProof,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
} from "../../src/protocol/index.js";

describe("native ACP worker auth shape", () => {
  it("encodes the bridge connection proof as the only client route credential", async () => {
    const authority = await createEd25519KeyPair();
    const client = await createEd25519KeyPair();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-1",
      principalId: "client-1",
      principalPublicKey: client.publicKey,
      principalType: "client",
      signingKey: { kid: "authority-1", privateKey: authority.privateKey },
    });
    const proof = await createAcpRemoteConnectionProof({
      connectionId: "conn-1",
      credential: { accountSession, privateKey: client.privateKey },
      hostId: "host-1",
    });

    expect(encodeAcpRemoteConnectionProof(proof)).toEqual(expect.any(String));
    expect(proof.accountSession.accountId).toBe("acct-1");
    expect(proof.clientId).toBe("client-1");
    expect(proof.hostId).toBe("host-1");
  });
});

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
