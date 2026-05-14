#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { ACP_REMOTE_DEFAULT_RELAY_URL } from "../dist/defaults.js";
import {
  createAcpRemoteConnectionProof,
  encodeAcpRemoteAccountSession,
  encodeAcpRemoteConnectionProof,
} from "../dist/index.js";

const relayUrl =
  process.env.ACP_RELAY_HTTP_URL ??
  ACP_REMOTE_DEFAULT_RELAY_URL.replace(/^ws(s?):\/\//, "http$1://");
const connectionId =
  process.env.ACP_CONNECTION_ID ?? `remote-smoke-${crypto.randomUUID()}`;
const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 30_000);
const REMOTE_AUTH_URL_META = "acp-runtime/remote/authUrl";
const REMOTE_SESSION_SELECTION_ID_META =
  "acp-runtime/remote/sessionSelectionId";
const traceparent = createTraceparent();

const credential = await loadAccountCredential();
const clientId = credential.accountSession.principalId;
const accountSessionValue = encodeAcpRemoteAccountSession(
  credential.accountSession,
);
await checkHealth();
const hosts = await listHosts(accountSessionValue);
const host = resolveHost(hosts);
await runNativeAcpSmoke({ accountSessionValue, credential, host });

console.log(
  JSON.stringify(
    {
      connectionId,
      hostId: host.hostId,
      ok: true,
      relayUrl,
      workspaceRoot,
    },
    null,
    2,
  ),
);

async function loadAccountCredential() {
  const raw = await readFile(join(homedir(), ".free", "account-session.json"), "utf8");
  const credential = JSON.parse(raw);
  if (!credential?.accountSession?.accountId || !credential?.privateKey) {
    throw new Error("Missing ~/.free/account-session.json. Run `free auth login` first.");
  }
  return credential;
}

async function checkHealth() {
  const response = await fetch(new URL("/health", relayUrl));
  if (!response.ok) {
    throw new Error(`Relay health check failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  if (body?.ok !== true) {
    throw new Error("Relay health check did not return ok=true.");
  }
}

async function listHosts(accountSessionValue) {
  const response = await fetch(new URL("/api/hosts", relayUrl), {
    headers: {
      Authorization: `Bearer ${accountSessionValue}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Host discovery failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  return Array.isArray(body?.hosts) ? body.hosts : [];
}

function resolveHost(hosts) {
  const host = chooseHost(hosts);
  if (!host?.hostId) {
    throw new Error("No online host found. Run `free auth login` on the target machine.");
  }
  return host;
}

function chooseHost(hosts) {
  const candidates = hosts
    .filter((entry) =>
      typeof entry?.hostId === "string" &&
      entry.hostId.trim() &&
      entry.online !== false
    )
    .sort((left, right) => left.hostId.localeCompare(right.hostId));
  const localMachine = hostname();
  return candidates.find((entry) => entry.metadata?.machine === localMachine) ??
    candidates[0];
}

async function runNativeAcpSmoke({ accountSessionValue, credential, host }) {
  const proof = await createAcpRemoteConnectionProof({
    connectionId,
    credential,
    hostId: host.hostId,
  });
  const url = new URL("/acp", relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("connectionId", connectionId);
  url.searchParams.set("hostId", host.hostId);

  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${accountSessionValue}`,
      "x-acp-connection-proof": encodeAcpRemoteConnectionProof(proof),
    },
  });
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });

  await onceOpen(socket);
  const initialize = request(socket, pending, {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      _meta: { traceparent },
      clientCapabilities: {},
      protocolVersion: 1,
    },
  });
  const initializeResult = await withTimeout(initialize, timeoutMs, "initialize");
  if (initializeResult.error) {
    throw new Error(`initialize failed: ${JSON.stringify(initializeResult.error)}`);
  }
  const authUrl = readAuthUrl(initializeResult);

  const sessionSelectionId = `${connectionId}:2:${crypto.randomUUID()}`;
  const sessionNew = request(socket, pending, {
    id: 2,
    jsonrpc: "2.0",
    method: "session/new",
    params: {
      _meta: {
        ...(authUrl
          ? {
              [REMOTE_SESSION_SELECTION_ID_META]: sessionSelectionId,
            }
          : {}),
        traceparent,
      },
      cwd: workspaceRoot,
      mcpServers: [],
    },
  });
  if (authUrl) {
    await authorizeRoute({
      accountSessionValue,
      authUrl,
      host,
      sessionSelectionId,
    });
  }
  const sessionResult = await withTimeout(sessionNew, timeoutMs, "session/new");
  if (sessionResult.error) {
    throw new Error(`session/new failed: ${JSON.stringify(sessionResult.error)}`);
  }
  const sessionId = sessionResult.result?.sessionId;
  if (!sessionId) {
    throw new Error(`session/new returned no sessionId: ${JSON.stringify(sessionResult)}`);
  }
  await withTimeout(
    request(socket, pending, {
      id: 3,
      jsonrpc: "2.0",
      method: "session/close",
      params: {
        _meta: { traceparent },
        sessionId,
      },
    }),
    timeoutMs,
    "session/close",
  ).catch(() => undefined);
  socket.close(1000, "remote smoke completed");
}

async function authorizeRoute({
  accountSessionValue,
  authUrl,
  host,
  sessionSelectionId,
}) {
  const selectedAgent = chooseAgent(host.metadata?.agentTypes ?? []);
  const body = {
    hostId: host.hostId,
    sessionSelectionId,
    workspaceRoots: [workspaceRoot],
  };
  if (selectedAgent?.id) {
    body.agentId = selectedAgent.id;
  } else if (selectedAgent?.command) {
    body.agentCommand = selectedAgent.command;
    if (selectedAgent.type) {
      body.agentType = selectedAgent.type;
    }
  }

  const response = await fetch(new URL(authUrl, relayUrl), {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${accountSessionValue}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const responseBody = await response.json().catch(() => undefined);
  if (!response.ok || responseBody?.ok !== true) {
    throw new Error(
      `Authorization failed: ${response.status} ${response.statusText} ${
        JSON.stringify(responseBody)
      }`,
    );
  }
}

function chooseAgent(agentTypes) {
  return agentTypes.find((agent) => agent?.id === "codex-acp") ?? agentTypes[0];
}

function readAuthUrl(message) {
  const methods = Array.isArray(message?.result?.authMethods)
    ? message.result.authMethods
    : [];
  for (const method of methods) {
    const value = method?._meta?.[REMOTE_AUTH_URL_META];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

function request(socket, pending, message) {
  return new Promise((resolve) => {
    pending.set(message.id, resolve);
    socket.send(JSON.stringify(message));
  });
}

function createTraceparent() {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
