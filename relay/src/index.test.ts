import { describe, expect, it, vi } from "vitest";

import {
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  decodeAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
  encodeAcpRemoteConnectionProof,
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

  it("requires a connection proof for attachment uploads", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/attachments", {
        body: "image-bytes",
        headers: { "content-type": "image/png" },
        method: "POST",
      }),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Missing connection proof.");
  });

  it("routes verified attachment uploads to the account shard", async () => {
    const connectionProof = await createTestConnectionProof();
    let routedName: string | undefined;
    let routedRequest:
      | {
          body: string;
          headers: Record<string, string>;
          url: string;
        }
      | undefined;
    const env = createEnv({
      ACP_RELAY_SHARDS: {
        idFromName(name: string) {
          routedName = name;
          return { name } as DurableObjectId;
        },
        get() {
          return {
            async fetch(request: Request) {
              const headers: Record<string, string> = {};
              request.headers.forEach((value, key) => {
                headers[key] = value;
              });
              routedRequest = {
                body: await request.text(),
                headers,
                url: request.url,
              };
              return Response.json({ ok: true });
            },
          };
        },
      } as unknown as DurableObjectNamespace,
    });

    const response = await worker.fetch(
      new Request(
        "https://relay.test/attachments?connectionId=conn-1&hostId=host-1&messageId=msg-1&attachmentId=att-1",
        {
          body: "image-bytes",
          headers: {
            "content-type": "image/png",
            "x-acp-client-id": "client-1",
            "x-acp-connection-proof": connectionProof,
          },
          method: "POST",
        },
      ),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(routedName).toBe("account:acct-1");
    expect(routedRequest).toMatchObject({
      body: "image-bytes",
      headers: {
        "content-type": "image/png",
        "x-acp-client-id": "client-1",
        "x-acp-verified-account-id": "acct-1",
        "x-acp-verified-client-id": "client-1",
        "x-acp-verified-principal-id": "client-1",
        "x-acp-verified-principal-type": "client",
      },
    });
  });

  it("does not serve product UI from the relay root", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/"),
      createEnv(),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found.");
  });

  it("does not keep archived or unbacked product routes on the relay", async () => {
    const accountSession = await createTestAccountSession();
    const paths = ["/archive/demo", "/authorization", "/hosts", "/sessions", "/system"] as const;

    for (const path of paths) {
      const response = await worker.fetch(
        new Request(`https://relay.test${path}`, {
          headers: {
            authorization: `Bearer ${accountSession}`,
          },
        }),
        createEnv(),
      );

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not found.");
    }
  });

  it("clears the browser account session on logout", async () => {
    const response = await worker.fetch(
      new Request("https://relay.test/logout"),
      createEnv(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://relay.test/");
    expect(response.headers.get("set-cookie")).toContain("acp_relay_session=;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
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

  it("returns a CORS JSON error when Workbench starts login without GitHub config", async () => {
    const response = await worker.fetch(
      new Request(
        "https://relay.test/api/login/start?returnTo=http%3A%2F%2F127.0.0.1%3A8790%2F&redirectUri=http%3A%2F%2F127.0.0.1%3A8790%2Flogin%2Fcallback",
        {
          headers: {
            origin: "http://127.0.0.1:8790",
          },
        },
      ),
      createEnv({ ACP_RELAY_DB: new FakeAuthD1Database() as unknown as D1Database }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      error: "GitHub sign in is not configured for this relay.",
    });
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
        new Request(
          `https://relay.test/api/login/start?returnTo=${encodeURIComponent(returnTo.toString())}&redirectUri=http%3A%2F%2F127.0.0.1%3A8790%2Flogin%2Fcallback`,
          {
            headers: {
              origin: "http://127.0.0.1:8790",
            },
          },
        ),
        env,
      );
      expect(login.status).toBe(200);
      const loginBody = await login.json() as { authorizationUrl?: string };
      const githubUrl = new URL(loginBody.authorizationUrl ?? "");
      const state = githubUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      const callback = await worker.fetch(
        new Request("https://relay.test/api/login/callback", {
          body: JSON.stringify({ code: "ok", state }),
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:8790",
          },
          method: "POST",
        }),
        env,
      );
      expect(callback.status).toBe(200);
      expect(db.loginApprovals.size).toBe(1);

      const approvalId = Array.from(db.loginApprovals.keys())[0];
      const confirmed = await worker.fetch(
        new Request("https://relay.test/api/login/confirm", {
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
        new Request(
          `https://relay.test/api/login/start?returnTo=${encodeURIComponent(returnTo.toString())}&redirectUri=http%3A%2F%2F127.0.0.1%3A8790%2Flogin%2Fcallback`,
          {
            headers: {
              origin: "http://127.0.0.1:8790",
            },
          },
        ),
        env,
      );
      const loginBody = await login.json() as { authorizationUrl?: string };
      const githubUrl = new URL(loginBody.authorizationUrl ?? "");
      const state = githubUrl.searchParams.get("state");

      await worker.fetch(
        new Request("https://relay.test/api/login/callback", {
          body: JSON.stringify({ code: "ok", state }),
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:8790",
          },
          method: "POST",
        }),
        env,
      );
      const approvalId = Array.from(db.loginApprovals.keys())[0];
      const confirmationForm = new FormData();
      confirmationForm.set("approvalId", approvalId);
      const confirmed = await worker.fetch(
        new Request("https://relay.test/api/login/confirm", {
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

  it("moves workbench login approval UI to the web origin", async () => {
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
      const login = await worker.fetch(
        new Request(
          "https://relay.test/api/login/start?returnTo=http%3A%2F%2F127.0.0.1%3A8790%2F&redirectUri=http%3A%2F%2F127.0.0.1%3A8790%2Flogin%2Fcallback",
          {
            headers: {
              origin: "http://127.0.0.1:8790",
            },
          },
        ),
        env,
      );
      expect(login.status).toBe(200);
      expect(login.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
      const loginBody = await login.json() as { authorizationUrl?: string };
      const githubUrl = new URL(loginBody.authorizationUrl ?? "");
      const state = githubUrl.searchParams.get("state");
      expect(githubUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8790/login/callback");

      const callback = await worker.fetch(
        new Request("https://relay.test/api/login/callback", {
          body: JSON.stringify({ code: "ok", state }),
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1:8790",
          },
          method: "POST",
        }),
        env,
      );

      expect(callback.status).toBe(200);
      expect(callback.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
      const callbackBody = await callback.json() as { approvalUrl?: string };
      const approvalUrl = new URL(callbackBody.approvalUrl ?? "");
      expect(approvalUrl.origin).toBe("http://127.0.0.1:8790");
      expect(approvalUrl.pathname).toBe("/login/approve");
      const approvalId = approvalUrl.searchParams.get("approvalId");
      expect(approvalId).toBeTruthy();

      const approval = await worker.fetch(
        new Request(`https://relay.test/api/login/approvals/${approvalId}`, {
          headers: {
            origin: "http://127.0.0.1:8790",
          },
        }),
        env,
      );
      expect(approval.status).toBe(200);
      expect(approval.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
      const body = await approval.json() as {
        githubLogin?: string;
        returnTo?: string;
      };
      expect(body.githubLogin).toBe("octocat");
      expect(body.returnTo).toBe("http://127.0.0.1:8790/");

      const confirmed = await worker.fetch(
        new Request("https://relay.test/api/login/confirm", {
          body: JSON.stringify({ approvalId }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            origin: "http://127.0.0.1:8790",
          },
          method: "POST",
        }),
        env,
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:8790");
      expect(confirmed.headers.get("set-cookie")).toContain("acp_relay_session=");
      const confirmationBody = await confirmed.json() as { callbackUrl?: string };
      expect(confirmationBody.callbackUrl).toBe("http://127.0.0.1:8790/");

      const session = await worker.fetch(
        new Request("https://relay.test/api/session", {
          headers: {
            cookie: confirmed.headers.get("set-cookie") ?? "",
            origin: "http://127.0.0.1:8790",
          },
        }),
        env,
      );
      expect(session.status).toBe(200);
      await expect(session.json()).resolves.toMatchObject({
        account: {
          name: "octocat",
          provider: "github",
        },
        accountName: "octocat",
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not keep relay-hosted login entrypoints", async () => {
    const env = createEnv({
      ACP_RELAY_DB: new FakeAuthD1Database() as unknown as D1Database,
      ACP_RELAY_GITHUB_CLIENT_ID: "github-client",
      ACP_RELAY_GITHUB_CLIENT_SECRET: "github-secret",
    });

    const response = await worker.fetch(
      new Request("http://127.0.0.1:8791/login?returnTo=http%3A%2F%2F127.0.0.1%3A52700%2Fcallback"),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not found.");
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

async function createTestConnectionProof(): Promise<string> {
  const accountSession = await createAcpRemoteAccountSession({
    accountId: "acct-1",
    principalId: "client-1",
    principalPublicKey: TEST_PUBLIC_KEY,
    principalType: "client",
    signingKey: TEST_SIGNING_KEY,
  });
  const proof = await createAcpRemoteConnectionProof({
    connectionId: "conn-1",
    credential: {
      accountSession,
      privateKey: TEST_SIGNING_KEY.privateKey,
    },
    hostId: "host-1",
  });
  return encodeAcpRemoteConnectionProof(proof);
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
      if (query.includes("where account_id")) {
        const accountId = String(this.bindings[0]);
        return ([...this.db.githubAccounts.values()].find(
          (account) => account.account_id === accountId,
        ) as T | undefined) ?? null;
      }
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
