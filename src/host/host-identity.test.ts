import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { verifyHostRegistrationProof } from "../../relay/src/host-auth.js";
import { resolveRuntimeHomePath } from "@saaskit-dev/acp-runtime";
import {
  createAcpRemoteHostIdentity,
  createAcpRemoteHostHostRegistrationRecord,
  createAcpRemoteHostIdentityRecord,
  createAcpRemoteHostRegistrationHeaders,
  loadAcpRemoteHostIdentity,
  loadOrCreateAcpRemoteHostIdentity,
  resolveAcpRemoteHostIdentityPath,
  rotateAcpRemoteHostIdentity,
  saveAcpRemoteHostIdentity,
} from "./host-identity.js";

describe("ACP remote host host identity", () => {
  it("creates, saves, and reloads a host identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");
    const identity = await createAcpRemoteHostIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );

    await saveAcpRemoteHostIdentity(path, identity);

    await expect(loadAcpRemoteHostIdentity(path)).resolves.toEqual(identity);
  });

  it("reuses an existing identity via loadOrCreate", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");

    const first = await loadOrCreateAcpRemoteHostIdentity({
      accountId: "acct-1",
      hostId: "host-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
      path,
    });
    const second = await loadOrCreateAcpRemoteHostIdentity({
      accountId: "acct-1",
      hostId: "host-1",
      now: new Date("2026-04-27T00:01:00.000Z"),
      path,
    });

    expect(second).toEqual(first);
  });

  it("rotates identity keys and preserves previous public key", async () => {
    const root = await mkdtemp(join(tmpdir(), "acp-remote-host-identity-"));
    const path = join(root, "host.json");
    const first = await loadOrCreateAcpRemoteHostIdentity({
      accountId: "acct-1",
      hostId: "host-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
      path,
    });

    const rotated = await rotateAcpRemoteHostIdentity({
      accountId: "acct-1",
      hostId: "host-1",
      now: new Date("2026-04-27T00:05:00.000Z"),
      path,
    });

    expect(rotated.publicKey).not.toBe(first.publicKey);
    expect(rotated.previousPublicKey).toBe(first.publicKey);
    expect(rotated.createdAt).toBe(first.createdAt);
    expect(rotated.updatedAt).toBe("2026-04-27T00:05:00.000Z");
    await expect(loadAcpRemoteHostIdentity(path)).resolves.toEqual(rotated);
  });

  it("creates relay registration headers that verify against the host public key", async () => {
    const identity = await createAcpRemoteHostIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );
    const headers = await createAcpRemoteHostRegistrationHeaders({
      accountId: "acct-1",
      hostId: "host-1",
      identity,
      nonce: "nonce-1",
      now: new Date("2026-04-27T00:00:00.000Z"),
    });

    await expect(
      verifyHostRegistrationProof({
        accountId: "acct-1",
        hostId: "host-1",
        nonce: headers["x-acp-host-nonce"],
        now: new Date("2026-04-27T00:00:00.000Z"),
        publicKey: identity.publicKey,
        signature: headers["x-acp-host-signature"],
        timestamp: headers["x-acp-host-timestamp"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(headers["x-acp-host-public-key"]).toBe(identity.publicKey);
  });

  it("derives a host registration record from stored identity", async () => {
    const identity = await createAcpRemoteHostIdentity(
      new Date("2026-04-27T00:00:00.000Z"),
    );

    expect(createAcpRemoteHostIdentityRecord(identity)).toEqual({
      previousPublicKey: undefined,
      publicKey: identity.publicKey,
    });
    expect(
      createAcpRemoteHostHostRegistrationRecord({
        accountId: "acct-1",
        hostId: "host-1",
        identity,
      }),
    ).toEqual({
      accountId: "acct-1",
      hostId: "host-1",
      previousPublicKey: undefined,
      publicKey: identity.publicKey,
    });
  });

  it("encodes account and host ids in the default runtime-home path", async () => {
    expect(resolveAcpRemoteHostIdentityPath("acct/a", "host b")).toBe(
      resolveRuntimeHomePath("remote", "hosts", "acct%2Fa", "host%20b.json"),
    );
  });
});
