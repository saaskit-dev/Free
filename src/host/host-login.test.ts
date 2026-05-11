import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
} from "../protocol/account-session.js";
import {
  getSessionPath,
  loadCachedSession,
  loginViaOAuth,
  saveSession,
} from "./host-login.js";

describe("remote host login cache", () => {
  it("stores account session credentials under the Free home", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "free-session-"));
    const authority = await createEd25519KeyPair();
    const principal = await createEd25519KeyPair();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-1",
      principalId: "client-1",
      principalPublicKey: principal.publicKey,
      principalType: "client",
      signingKey: { kid: "authority-1", privateKey: authority.privateKey },
    });
    await saveSession({
      accountId: "acct-1",
      accountSession,
      privateKey: principal.privateKey,
      savedAt: 123,
    }, homeDir);

    expect(getSessionPath(homeDir)).toBe(
      join(homeDir, ".free", "account-session.json"),
    );
    await expect(loadCachedSession(homeDir)).resolves.toMatchObject({
      accountId: "acct-1",
      privateKey: principal.privateKey,
    });
  });

  it("does not read account sessions from unrelated homes", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "free-session-"));

    await expect(loadCachedSession(homeDir)).resolves.toBeUndefined();
  });

  it("clears the OAuth timeout after successful callback", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let loginUrl: string | undefined;
    const statuses: string[] = [];
    const login = loginViaOAuth("ws://relay.example", {
      onStatus: (message) => statuses.push(message),
      openBrowser: async (url) => {
        loginUrl = url;
      },
      timeoutMs: 5 * 60 * 1000,
    });

    await vi.waitFor(() => {
      expect(loginUrl).toBeDefined();
    });

    const returnTo = new URL(loginUrl ?? "").searchParams.get("returnTo");
    expect(returnTo).toBeTruthy();
    const returnToUrl = new URL(returnTo ?? "");
    expect(returnToUrl.hostname).toBe("127.0.0.1");
    expect(returnToUrl.searchParams.get("accountSessionReturn")).toBe("query");
    expect(statuses).toContainEqual(
      expect.stringContaining("Local sign-in listener ready: http://127.0.0.1:"),
    );
    expect(statuses).toContainEqual(
      expect.stringContaining("Waiting for GitHub sign in and device authorization"),
    );
    const authority = await createEd25519KeyPair();
    const accountSession = await createAcpRemoteAccountSession({
      accountId: "acct-2",
      principalId: returnToUrl.searchParams.get("accountSessionPrincipalId") ?? "",
      principalPublicKey:
        returnToUrl.searchParams.get("accountSessionPublicKey") ?? "",
      principalType: "client",
      signingKey: { kid: "authority-1", privateKey: authority.privateKey },
    });
    const encoded = encodeURIComponent(
      encodeAcpRemoteAccountSession(accountSession),
    );

    const response = await fetch(
      `${returnTo}&accountSession=${encoded}&accountId=acct-2`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("content-length")).toBeTruthy();
    const body = await response.text();
    expect(body).toContain("free:login-complete");
    expect(statuses).toContain(
      "Browser authorization received. Verifying account credential...",
    );
    expect(statuses).toContain(
      "Account credential verified. Completing CLI login...",
    );
    await expect(login).resolves.toMatchObject({
      accountId: "acct-2",
      accountSession: {
        accountId: "acct-2",
      },
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });

  it("renders a product login failure page when relay callback omits the account session", async () => {
    let loginUrl: string | undefined;
    const login = loginViaOAuth("ws://relay.example", {
      openBrowser: async (url) => {
        loginUrl = url;
      },
      timeoutMs: 5 * 60 * 1000,
    });
    const rejected = expect(login).rejects.toThrow(
      "OAuth callback missing account session.",
    );

    await vi.waitFor(() => {
      expect(loginUrl).toBeDefined();
    });

    const returnTo = new URL(loginUrl ?? "").searchParams.get("returnTo");
    expect(returnTo).toBeTruthy();
    const response = await fetch(`${returnTo}&accountId=acct-2`);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("Free sign in failed");
    expect(body).toContain("account credential");
    await rejected;
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
