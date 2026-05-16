import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteAttachmentFrameType,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  createFreeAttachmentUri,
  encodeAcpRemoteAttachmentUpload,
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

  it("persists binary image attachment uploads and acknowledges them", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "free-host-attachments-"));
    const [hostSocket, relaySocket] = createMemoryWebSocketPair();
    const outbound: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        outbound.push(JSON.parse(event.data));
      }
    });
    const body = new TextEncoder().encode("image-bytes");
    const uri = createFreeAttachmentUri({
      attachmentId: "att-1",
      connectionId: "conn-1",
      hostId: "host-1",
      messageId: "msg-1",
    });

    const handle = createAcpRemoteHostConnection({
      accountId: "acct-1",
      attachmentRootDir: rootDir,
      hostId: "host-1",
      runtime: {} as never,
      socket: hostSocket,
    });

    try {
      relaySocket.send(encodeAcpRemoteAttachmentUpload(
        {
          accountId: "acct-1",
          attachmentId: "att-1",
          connectionId: "conn-1",
          createdAt: "2026-05-12T00:00:00.000Z",
          hostId: "host-1",
          kind: "attachment/upload",
          messageId: "msg-1",
          mimeType: "image/png",
          requestId: "request-1",
          sha256: sha256Hex(body),
          size: body.byteLength,
          uri,
          version: 1,
        },
        body,
      ));

      await waitFor(() => outbound.length > 0);
      expect(outbound[0]).toMatchObject({
        attachmentId: "att-1",
        connectionId: "conn-1",
        frameType: AcpRemoteAttachmentFrameType.Ack,
        mimeType: "image/png",
        ok: true,
        requestId: "request-1",
        sha256: sha256Hex(body),
        size: body.byteLength,
        uri,
        version: 1,
      });
    } finally {
      handle.close();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("suppresses duplicate in-flight prompt frames and returns the original result", async () => {
    const identity = await createProofFixture();
    const [hostSocket, relaySocket] = createMemoryWebSocketPair();
    const outbound: unknown[] = [];
    relaySocket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        outbound.push(JSON.parse(event.data));
      }
    });
    let resolveTurn: (() => void) | undefined;
    let promptStarts = 0;
    const journalEntries = new Map<string, {
      connectionId: string;
      id: string | number;
      method?: string;
      payload?: unknown;
      status: "completed" | "received";
    }>();

    const handle = createAcpRemoteHostConnection({
      accountId: "acct-1",
      accountSessionVerificationKeys: [
        { kid: "authority-1", publicKey: identity.authorityPublicKey },
      ],
      hostId: "host-1",
      now: () => new Date("2026-05-10T00:00:02.000Z"),
      requestJournal: {
        async lookup(connectionId, id) {
          return journalEntries.get(`${connectionId}:${id}`) as never;
        },
        async markCompleted(entry) {
          journalEntries.set(`${entry.connectionId}:${entry.id}`, {
            ...entry,
            status: "completed",
          });
        },
        async markReceived(entry) {
          journalEntries.set(`${entry.connectionId}:${entry.id}`, {
            ...entry,
            status: "received",
          });
        },
      },
      runtime: {
        sessions: {
          async load() {
            return createRuntimeSession({
              onPromptStart() {
                promptStarts += 1;
              },
              waitForCompletion() {
                return new Promise<void>((resolve) => {
                  resolveTurn = resolve;
                });
              },
            });
          },
          async list() {
            return { sessions: [] };
          },
          async resume() {
            throw new Error("load should restore the test session");
          },
          async start() {
            throw new Error("prompt restore should load the test session");
          },
        },
      } as never,
      socket: hostSocket,
    });

    try {
      relaySocket.send(createHello("conn-1", identity.proof));
      relaySocket.send(createPromptFrame({ seq: 1 }));
      await waitFor(() => promptStarts === 1);

      relaySocket.send(createPromptFrame({ seq: 2 }));
      await new Promise((resolve) => setTimeout(resolve, 20));

      const errorResponsesBeforeCompletion = outbound.filter(
        (message) =>
          isRecord(message) &&
          message.frameType === AcpRemoteFrameType.Data &&
          isRecord(message.payload) &&
          isRecord(message.payload.error),
      );
      expect(errorResponsesBeforeCompletion).toHaveLength(0);
      expect(promptStarts).toBe(1);

      resolveTurn?.();
      await waitFor(() =>
        outbound.some(
          (message) =>
            isRecord(message) &&
            message.frameType === AcpRemoteFrameType.Data &&
            isRecord(message.payload) &&
            message.payload.id === "prompt-1" &&
            isRecord(message.payload.result),
        ),
      );
      expect(promptStarts).toBe(1);
    } finally {
      handle.close();
    }
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

function createPromptFrame(input: { seq: number }): string {
  return JSON.stringify({
    channelId: "acp",
    channelKind: AcpRemoteChannelKind.Acp,
    connectionId: "conn-1",
    frameType: AcpRemoteFrameType.Data,
    payload: {
      id: "prompt-1",
      jsonrpc: "2.0",
      method: "session/prompt",
      params: {
        _meta: {
          "acp-runtime/remote/sessionAgent": {
            command: "fake-agent",
            type: "fake",
          },
          "acp-runtime/remote/sessionWorkspaceRoots": ["/workspace"],
        },
        prompt: [{ text: "long running command", type: "text" }],
        sessionId: "runtime-session-1",
      },
    },
    seq: input.seq,
  });
}

function createRuntimeSession(input: {
  onPromptStart(): void;
  waitForCompletion(): Promise<void>;
}) {
  return {
    agent: {
      listConfigOptions: () => [],
      listModes: () => [],
      setConfigOption: async () => {},
      setMode: async () => {},
    },
    capabilities: { agent: { prompt: true }, client: {} },
    close: async () => {},
    diagnostics: {},
    initialConfigReport: undefined,
    metadata: { id: "runtime-session-1", title: "Runtime Session" },
    queue: {
      policy: () => ({ delivery: "sequential" }),
      setPolicy: () => ({ delivery: "sequential" }),
    },
    snapshot: () => ({
      agent: { command: "fake-agent", type: "fake" },
      cwd: "/workspace",
      session: { id: "runtime-session-1" },
      version: 1,
    }),
    state: {
      history: { drain: () => [] },
      thread: { entries: () => [] },
    },
    status: "ready",
    turn: {
      cancel: async () => true,
      queue: {
        clear: () => 0,
        get: () => undefined,
        list: () => [],
        remove: () => false,
        sendNow: async () => false,
      },
      start: () => {
        input.onPromptStart();
        return {
          events: createDelayedTurnEvents(input.waitForCompletion),
          turnId: "turn-1",
        };
      },
    },
  };
}

async function* createDelayedTurnEvents(waitForCompletion: () => Promise<void>) {
  yield { turnId: "turn-1", type: "started" };
  await waitForCompletion();
  yield {
    output: [{ text: "done", type: "text" }],
    outputText: "done",
    turnId: "turn-1",
    type: "completed",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
