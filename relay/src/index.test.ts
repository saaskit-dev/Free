import { describe, expect, it, vi } from "vitest";

import {
  createAcpRemoteAccountSession,
  decodeAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
  type AcpRemoteAccountSessionSigningKey,
} from "../../src/protocol/index.js";
import worker, { type Env } from "./index.js";

describe("relay worker", () => {
  it("serves health without auth", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/health"),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("does not expose a separate refresh endpoint", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/refresh", { method: "POST" }),
      createEnv(),
    );

    expect(response.status).toBe(404);
  });

  it("serves a product authorization page when sign in is required", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/authorize?connectionId=conn-1"),
      createEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Free Authorization");
    expect(body).toContain("Authorize Free");
    expect(body).toContain("Sign in required");
  });

  it("requires explicit confirmation before issuing CLI account session credentials", async () => {
    const db = new FakeAuthD1Database();
    const env = createEnv({
      ACP_RELAY_DB: db as unknown as D1Database,
      ACP_RELAY_GITHUB_CLIENT_ID: "github-client",
      ACP_RELAY_GITHUB_CLIENT_SECRET: "github-secret",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "github-token" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: 42, login: "octocat" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    try {
      const returnTo = new URL("http://127.0.0.1:52700/callback");
      returnTo.searchParams.set("accountSessionPrincipalId", "client-1");
      returnTo.searchParams.set("accountSessionPrincipalType", "client");
      returnTo.searchParams.set(
        "accountSessionPublicKey",
        "D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA",
      );
      returnTo.searchParams.set("accountSessionReturn", "query");

      const login = await worker.fetch(
        new Request(`https://relay.test/login?returnTo=${encodeURIComponent(returnTo.toString())}`),
        env,
      );
      expect(login.status).toBe(302);
      const githubUrl = new URL(login.headers.get("location") ?? "");
      const state = githubUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      const callback = await worker.fetch(
        new Request(`https://relay.test/login/callback?code=ok&state=${state}`),
        env,
      );
      expect(callback.status).toBe(200);
      const callbackBody = await callback.text();
      expect(callbackBody).toContain("Authorize Free");
      expect(callbackBody).toContain("Authorize this device");
      expect(callbackBody).toContain("Waiting for Free to finish sign in.");
      expect(callbackBody).toContain("fetch(form.action");
      expect(callbackBody).toContain("free:login-complete");
      expect(callbackBody).not.toContain("accountSession=");
      expect(db.loginApprovals.size).toBe(1);

      const approvalId = Array.from(db.loginApprovals.keys())[0];
      const confirmed = await worker.fetch(
        new Request("https://relay.test/login/confirm", {
          body: new URLSearchParams({ approvalId }).toString(),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          method: "POST",
        }),
        env,
      );
      expect(confirmed.status).toBe(302);
      expect(db.loginApprovals.size).toBe(0);
      const redirect = new URL(confirmed.headers.get("location") ?? "");
      expect(redirect.origin).toBe("http://127.0.0.1:52700");
      expect(redirect.searchParams.get("accountSessionReturn")).toBeNull();
      expect(redirect.searchParams.get("accountId")).toBeTruthy();
      const encodedSession = redirect.searchParams.get("accountSession");
      expect(encodedSession).toBeTruthy();
      const session = decodeAcpRemoteAccountSession(encodedSession ?? "");
      expect(session.accountId).toBe(redirect.searchParams.get("accountId"));
      expect(session.principalId).toBe("client-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns a local callback URL for browser-driven login confirmation", async () => {
    const db = new FakeAuthD1Database();
    const env = createEnv({
      ACP_RELAY_DB: db as unknown as D1Database,
      ACP_RELAY_GITHUB_CLIENT_ID: "github-client",
      ACP_RELAY_GITHUB_CLIENT_SECRET: "github-secret",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
        if (url === "https://github.com/login/oauth/access_token") {
          return Response.json({ access_token: "github-token" });
        }
        if (url === "https://api.github.com/user") {
          return Response.json({ id: 42, login: "octocat" });
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    );

    try {
      const returnTo = new URL("http://127.0.0.1:52700/callback");
      returnTo.searchParams.set("accountSessionPrincipalId", "client-1");
      returnTo.searchParams.set("accountSessionPrincipalType", "client");
      returnTo.searchParams.set(
        "accountSessionPublicKey",
        "D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA",
      );
      returnTo.searchParams.set("accountSessionReturn", "query");

      const login = await worker.fetch(
        new Request(`https://relay.test/login?returnTo=${encodeURIComponent(returnTo.toString())}`),
        env,
      );
      const githubUrl = new URL(login.headers.get("location") ?? "");
      const state = githubUrl.searchParams.get("state");

      await worker.fetch(
        new Request(`https://relay.test/login/callback?code=ok&state=${state}`),
        env,
      );
      const approvalId = Array.from(db.loginApprovals.keys())[0];
      const confirmationForm = new FormData();
      confirmationForm.set("approvalId", approvalId);
      const confirmed = await worker.fetch(
        new Request("https://relay.test/login/confirm", {
          body: confirmationForm,
          headers: {
            "Accept": "application/json",
          },
          method: "POST",
        }),
        env,
      );

      expect(confirmed.status).toBe(200);
      expect(confirmed.headers.get("set-cookie")).toContain("acp_relay_session=");
      const body = await confirmed.json() as {
        accountId?: string;
        callbackUrl?: string;
      };
      expect(body.accountId).toBeTruthy();
      const callbackUrl = new URL(body.callbackUrl ?? "");
      expect(callbackUrl.origin).toBe("http://127.0.0.1:52700");
      expect(callbackUrl.searchParams.get("accountId")).toBe(body.accountId);
      expect(callbackUrl.searchParams.get("accountSessionReturn")).toBeNull();
      expect(callbackUrl.searchParams.get("accountSession")).toBeTruthy();
      expect(db.loginApprovals.size).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts OTLP proxy uploads when export is not configured", async () => {
    const accountSession = await createTestAccountSession();
    const response = await worker.fetch(
      new Request("https://relay.test/api/otel/logs", {
        body: JSON.stringify({ resourceLogs: [] }),
        headers: {
          authorization: `Bearer ${accountSession}`,
          "content-type": "application/json",
        },
        method: "POST",
      }),
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      configured: false,
      reason: "otel_export_disabled",
    });
  });
});

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    ACP_RELAY_ACCOUNT_SESSION_KEY_ID: "free-default-2026-05-10",
    ACP_RELAY_ACCOUNT_SESSION_PRIVATE_KEY:
      "MC4CAQAwBQYDK2VwBCIEIE3QzRbUWyHMh9gdhq_2qUXX_NzCJpJFhxtndaTTRvb3",
    ACP_RELAY_ACCOUNT_SESSION_PUBLIC_KEYS:
      '[{"kid":"free-default-2026-05-10","publicKey":"D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA"}]',
    ACP_RELAY_SHARDS: {
      idFromName(name: string) {
        return { name } as DurableObjectId;
      },
      get() {
        throw new Error("Shard should not be used.");
      },
    } as unknown as DurableObjectNamespace,
    ...overrides,
  };
}

async function createTestAccountSession(): Promise<string> {
  const session = await createAcpRemoteAccountSession({
    accountId: "acct-1",
    now: new Date("2026-05-10T00:00:00.000Z"),
    principalId: "host-1",
    principalPublicKey: TEST_PUBLIC_KEY,
    principalType: "host",
    signingKey: TEST_SIGNING_KEY,
  });
  return encodeAcpRemoteAccountSession(session);
}

const TEST_SIGNING_KEY: AcpRemoteAccountSessionSigningKey = {
  kid: "free-default-2026-05-10",
  privateKey:
    "MC4CAQAwBQYDK2VwBCIEIE3QzRbUWyHMh9gdhq_2qUXX_NzCJpJFhxtndaTTRvb3",
};

const TEST_PUBLIC_KEY = "D9wpO03lAtMNl2FFXCCuGpm64weG7IbRH8ZDFtEs0wA";

class FakeAuthD1Database {
  readonly accounts = new Set<string>();
  readonly githubAccounts = new Map<number, {
    account_id: string;
    created_at: number;
    github_id: number;
    github_login: string;
  }>();
  readonly loginApprovals = new Map<string, {
    account_id: string;
    approval_id: string;
    created_at: number;
    github_login: string;
    principal_id: string;
    principal_public_key: string | null;
    principal_type: string;
    return_to: string;
  }>();
  readonly oauthStates = new Map<string, {
    created_at: number;
    return_to: string;
    state: string;
  }>();

  prepare(query: string): FakeAuthD1Statement {
    return new FakeAuthD1Statement(this, query);
  }
}

class FakeAuthD1Statement {
  private bindings: readonly unknown[] = [];

  constructor(
    private readonly db: FakeAuthD1Database,
    private readonly query: string,
  ) {}

  bind(...values: readonly unknown[]): FakeAuthD1Statement {
    this.bindings = values;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const query = this.query.toLowerCase();
    if (query.includes("from acp_oauth_states")) {
      const state = String(this.bindings[0]);
      return (this.db.oauthStates.get(state) as T | undefined) ?? null;
    }
    if (query.includes("from acp_github_accounts")) {
      const githubId = Number(this.bindings[0]);
      return (this.db.githubAccounts.get(githubId) as T | undefined) ?? null;
    }
    if (query.includes("from acp_login_approvals")) {
      const approvalId = String(this.bindings[0]);
      return (this.db.loginApprovals.get(approvalId) as T | undefined) ?? null;
    }
    return null;
  }

  async run(): Promise<{ success: boolean }> {
    const query = this.query.toLowerCase();
    if (query.includes("insert into acp_oauth_states")) {
      const state = String(this.bindings[0]);
      this.db.oauthStates.set(state, {
        created_at: Number(this.bindings[2]),
        return_to: String(this.bindings[1]),
        state,
      });
      return { success: true };
    }
    if (query.includes("delete from acp_oauth_states")) {
      this.db.oauthStates.delete(String(this.bindings[0]));
      return { success: true };
    }
    if (query.includes("insert into acp_accounts")) {
      this.db.accounts.add(String(this.bindings[0]));
      return { success: true };
    }
    if (query.includes("insert into acp_github_accounts")) {
      const githubId = Number(this.bindings[0]);
      const accountId = String(this.bindings[2]);
      this.db.accounts.add(accountId);
      this.db.githubAccounts.set(githubId, {
        account_id: accountId,
        created_at: Number(this.bindings[3]),
        github_id: githubId,
        github_login: String(this.bindings[1]),
      });
      return { success: true };
    }
    if (query.includes("insert into acp_login_approvals")) {
      const approvalId = String(this.bindings[0]);
      this.db.loginApprovals.set(approvalId, {
        account_id: String(this.bindings[1]),
        approval_id: approvalId,
        created_at: Number(this.bindings[7]),
        github_login: String(this.bindings[2]),
        principal_id: String(this.bindings[3]),
        principal_public_key: this.bindings[5] === null
          ? null
          : String(this.bindings[5]),
        principal_type: String(this.bindings[4]),
        return_to: String(this.bindings[6]),
      });
      return { success: true };
    }
    if (query.includes("delete from acp_login_approvals")) {
      this.db.loginApprovals.delete(String(this.bindings[0]));
      return { success: true };
    }
    throw new Error(`Unsupported D1 query: ${this.query}`);
  }
}
