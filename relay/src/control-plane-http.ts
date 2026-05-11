import type { AcpRemoteScope } from "../../src/protocol/index.js";
import type { Env } from "./env.js";
import {
  AcpRelayD1ControlPlaneStore,
  type AcpRelayAccountRecord,
  type AcpRelayClientDeviceRecord,
  type AcpRelayGrantRecord,
  type AcpRelayHostRecord,
} from "./control-plane-store.js";
import {
  asRecord,
  json,
  parseError,
  readJsonBody,
  readOptionalBoolean,
  readOptionalString,
  readOptionalStringArray,
  readRequiredPositiveInteger,
  readRequiredString,
  type ParseResult,
} from "./http-utils.js";

export async function handleControlPlaneRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  if (!isAuthorizedControlPlaneRequest(request, env)) {
    return json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!env.ACP_RELAY_DB) {
    return json(
      { error: "Control-plane API requires ACP_RELAY_DB." },
      { status: 503 },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const store = new AcpRelayD1ControlPlaneStore(env.ACP_RELAY_DB);
  switch (url.pathname) {
    case "/control-plane/accounts": {
      const record = parseAccountRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertAccount(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/client-devices": {
      const record = parseClientDeviceRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertClientDevice(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/hosts": {
      const record = parseHostRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertHost(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/grants": {
      const record = parseGrantRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertGrant(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    default:
      return json({ error: "Unknown control-plane endpoint." }, { status: 404 });
  }
}

async function reconcileControlPlaneMutation(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${accountId}`);
  const response = await env.ACP_RELAY_SHARDS.get(shardId).fetch(
    new Request(
      new URL(
        `/internal/reconcile-authorizations?accountId=${encodeURIComponent(accountId)}`,
        request.url,
      ),
      {
        headers: {
          authorization: request.headers.get("authorization") ?? "",
          "x-acp-control-plane-secret":
            request.headers.get("x-acp-control-plane-secret") ?? "",
        },
        method: "POST",
      },
    ),
  );

  if (!response.ok) {
    return json(
      { error: "Control-plane mutation applied but reconcile failed." },
      { status: 502 },
    );
  }

  const payload = (await response.json()) as {
    closedConnectionIds?: unknown;
  };
  return json({
    closedConnectionIds: Array.isArray(payload.closedConnectionIds)
      ? payload.closedConnectionIds
      : [],
    ok: true,
  });
}

function isAuthorizedControlPlaneRequest(request: Request, env: Env): boolean {
  const expected = env.ACP_RELAY_CONTROL_PLANE_SECRET;
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return (
    constantTimeEqual(bearerToken ?? "", expected) ||
    constantTimeEqual(
      request.headers.get("x-acp-control-plane-secret") ?? "",
      expected,
    )
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }
  return mismatch === 0;
}

function parseAccountRecord(
  value: unknown,
): ParseResult<AcpRelayAccountRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Account registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
    },
  };
}

function parseClientDeviceRecord(
  value: unknown,
): ParseResult<AcpRelayClientDeviceRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Client device registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readRequiredString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      disabled: disabled.value,
      publicKey: publicKey.value,
    },
  };
}

function parseHostRecord(value: unknown): ParseResult<AcpRelayHostRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Host registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  const previousPublicKey = readOptionalString(record, "previousPublicKey");
  if (!previousPublicKey.ok) {
    return previousPublicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
      hostId: hostId.value,
      previousPublicKey: previousPublicKey.value,
      publicKey: publicKey.value,
    },
  };
}

function parseGrantRecord(value: unknown): ParseResult<AcpRelayGrantRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Grant registration body must be an object.");
  }

  const grantId = readOptionalString(record, "grantId");
  if (!grantId.ok) {
    return grantId;
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readOptionalString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
  }

  const workspaceId = readOptionalString(record, "workspaceId");
  if (!workspaceId.ok) {
    return workspaceId;
  }

  const workspaceRoots = readOptionalStringArray(record, "workspaceRoots");
  if (!workspaceRoots.ok) {
    return workspaceRoots;
  }

  const policyVersion = readRequiredPositiveInteger(record, "policyVersion");
  if (!policyVersion.ok) {
    return policyVersion;
  }

  const scopes = readScopes(record);
  if (!scopes.ok) {
    return scopes;
  }

  const revoked = readOptionalBoolean(record, "revoked");
  if (!revoked.ok) {
    return revoked;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      grantId: grantId.value,
      hostId: hostId.value,
      policyVersion: policyVersion.value,
      revoked: revoked.value,
      scopes: scopes.value,
      workspaceId: workspaceId.value,
      workspaceRoots: workspaceRoots.value,
    },
  };
}

function readScopes(
  record: Record<string, unknown>,
): ParseResult<readonly AcpRemoteScope[]> {
  const value = record.scopes;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError("scopes must be a non-empty string array.");
  }
  return { ok: true, value: value as readonly AcpRemoteScope[] };
}
