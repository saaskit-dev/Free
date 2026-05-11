import { describe, expect, it } from "vitest";

import {
  createHostRegistrationKeyPair,
  createHostRegistrationKeySignature,
  verifyHostRegistrationProof,
} from "./host-auth.js";

describe("host registration proof", () => {
  it("verifies per-host public key host registration payloads", async () => {
    const keyPair = await createHostRegistrationKeyPair();
    const input = {
      accountId: "acct-1",
      hostId: "host-1",
      nonce: "nonce-1",
      timestamp: "1777248000000",
    };

    const signature = await createHostRegistrationKeySignature({
      ...input,
      privateKey: keyPair.privateKey,
    });

    await expect(
      verifyHostRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature,
      }),
    ).resolves.toEqual({
      ok: true,
    });
    await expect(
      verifyHostRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature: "bad-signature",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Invalid host registration signature.",
    });
  });

  it("rejects stale or invalid host registration payloads", async () => {
    const keyPair = await createHostRegistrationKeyPair();
    const input = {
      accountId: "acct-1",
      hostId: "host-1",
      nonce: "nonce-1",
      timestamp: "1777248000000",
    };
    const signature = await createHostRegistrationKeySignature({
      ...input,
      privateKey: keyPair.privateKey,
    });

    await expect(
      verifyHostRegistrationProof({
        ...input,
        now: new Date(1777248600001),
        publicKey: keyPair.publicKey,
        signature,
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Host registration proof expired.",
    });
    await expect(
      verifyHostRegistrationProof({
        ...input,
        now: new Date(1777248000000),
        publicKey: keyPair.publicKey,
        signature: "bad-signature",
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "Invalid host registration signature.",
    });
  });
});
