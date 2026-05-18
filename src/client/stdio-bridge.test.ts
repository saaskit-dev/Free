import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type {
  AcpWebSocketEventListener,
  AcpWebSocketLike,
  AcpWebSocketMessageListener,
} from "../protocol/websocket-stream.js";
import {
  createAcpRemoteAccountSession,
  createAcpRemoteConnectionProof,
  decodeAcpRemoteConnectionProof,
  type AcpRemoteAccountSessionCredential,
  type AcpRemoteConnectionProof,
} from "../protocol/index.js";
import { createAcpRemoteStdioBridge } from "./stdio-bridge.js";

describe("createAcpRemoteStdioBridge", () => {
  it("returns an ACP error when browser authorization is not completed", async () => {
    const previousTimeout = process.env.FREE_BRIDGE_AUTH_REQUEST_TIMEOUT_MS;
    process.env.FREE_BRIDGE_AUTH_REQUEST_TIMEOUT_MS = "1000";
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    const openedUrls: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "ws://127.0.0.1:8791",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            authMethods: [{
              _meta: {
                "acp-runtime/remote/authUrl":
                  "http://127.0.0.1:8791/authorize?connectionId=connection-1",
              },
              id: "acp-runtime-browser",
              name: "Sign in with Free",
            }],
          },
        }),
      );
      input.write(
        `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );
      await new Promise<void>((resolve) => process.nextTick(resolve));

      expect(openedUrls).toEqual([
        expect.stringContaining("http://127.0.0.1:8790/authorize?connectionId=connection-1"),
      ]);
      await waitFor(() => outputText.includes('"id":2'), 1300);

      const messages = outputText
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { error?: { data?: { authUrl?: string }; message?: string }; id?: number });
      expect(messages.at(-1)).toMatchObject({
        error: {
          data: {
            authUrl: expect.stringContaining("http://127.0.0.1:8790/authorize?connectionId=connection-1"),
          },
          message: "Free authorization was not completed in time. Start a new session from the ACP client to continue.",
        },
        id: 2,
      });
    } finally {
      bridge.close();
      if (previousTimeout === undefined) {
        delete process.env.FREE_BRIDGE_AUTH_REQUEST_TIMEOUT_MS;
      } else {
        process.env.FREE_BRIDGE_AUTH_REQUEST_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("rewrites relay authorization metadata to the Workbench origin", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://127.0.0.1:8791",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            authMethods: [{
              _meta: {
                "acp-runtime/remote/authUrl":
                  "http://127.0.0.1:8791/authorize?connectionId=conn-1",
              },
              id: "acp-runtime-browser",
              name: "Sign in with Free",
            }],
          },
        }),
      );

      await waitFor(() => outputText.trim().length > 0);
      const outputMessage = JSON.parse(outputText.trim()) as {
        result?: {
          authMethods?: {
            _meta?: Record<string, string>;
          }[];
        };
      };
      expect(
        outputMessage.result?.authMethods?.[0]?._meta?.["acp-runtime/remote/authUrl"],
      ).toBe("http://127.0.0.1:8790/authorize?connectionId=conn-1");
    } finally {
      bridge.close();
    }
  });

  it("opens authorization for session/new so workspace selection remains explicit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const openedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const restoreFetch = stubFetch(fetchMock as typeof fetch);
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      autoAuthorize: {
        accountSession: "account-session-1",
        hostId: "host-1",
      },
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "ws://127.0.0.1:8791",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          result: {
            authMethods: [{
              _meta: {
                "acp-runtime/remote/authUrl":
                  "http://127.0.0.1:8791/authorize?connectionId=connection-1",
              },
              id: "acp-runtime-browser",
              name: "Sign in with Free",
            }],
          },
        }),
      );
      await waitFor(() => fetchMock.mock.calls.length === 1);

      input.write(
        `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );

      await waitFor(() =>
        sockets[0]?.sent.some((message) => {
          try {
            return JSON.parse(message).method === "session/new";
          } catch {
            return false;
          }
        }) ?? false,
      );
      const outboundMessage = sockets[0]!.sent.find((message) => {
        try {
          return JSON.parse(message).method === "session/new";
        } catch {
          return false;
        }
      })!;
      const outbound = JSON.parse(outboundMessage) as {
        params?: { _meta?: Record<string, string> };
      };
      const outboundSelectionId =
        outbound.params?._meta?.["acp-runtime/remote/sessionSelectionId"];

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(openedUrls).toHaveLength(1);
      const sessionAuthorizeUrl = new URL(openedUrls[0]!);
      expect(sessionAuthorizeUrl.searchParams.get("sessionSelectionId")).toBe(
        outboundSelectionId,
      );
    } finally {
      bridge.close();
      restoreFetch();
    }
  });

  it("opens authorization for session/new after bridge restart before initialize provides auth url", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const openedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      void url;
      void init;
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const restoreFetch = stubFetch(fetchMock as typeof fetch);
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      autoAuthorize: {
        accountSession: "account-session-1",
        hostId: "host-1",
      },
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      openAuthUrl(url) {
        openedUrls.push(url);
      },
      output,
      relayUrl: "ws://127.0.0.1:8791",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );

      await waitFor(() =>
        sockets[0]?.sent.some((message) => {
          try {
            return JSON.parse(message).method === "session/new";
          } catch {
            return false;
          }
        }) ?? false,
      );
      const outboundMessage = sockets[0]!.sent.find((message) => {
        try {
          return JSON.parse(message).method === "session/new";
        } catch {
          return false;
        }
      })!;
      const outbound = JSON.parse(outboundMessage) as {
        params?: { _meta?: Record<string, string> };
      };
      const outboundSelectionId =
        outbound.params?._meta?.["acp-runtime/remote/sessionSelectionId"];

      expect(fetchMock).not.toHaveBeenCalled();
      expect(openedUrls).toHaveLength(1);
      const sessionAuthorizeUrl = new URL(openedUrls[0]!);
      expect(sessionAuthorizeUrl.origin).toBe("http://127.0.0.1:8790");
      expect(sessionAuthorizeUrl.pathname).toBe("/authorize");
      expect(sessionAuthorizeUrl.searchParams.get("connectionId")).toBe(
        "connection-1",
      );
      expect(sessionAuthorizeUrl.searchParams.get("sessionSelectionId")).toBe(
        outboundSelectionId,
      );
    } finally {
      bridge.close();
      restoreFetch();
    }
  });

  it("injects trace metadata and reuses it for response debug context", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const debugContexts: {
      direction?: string;
      traceId?: string;
    }[] = [];
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      debugLog(_message, context) {
        if (context) {
          debugContexts.push(context);
        }
      },
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      const outbound = JSON.parse(sockets[0]!.sent[0]) as {
        params?: { _meta?: { traceparent?: unknown } };
      };
      const traceparent = outbound.params?._meta?.traceparent;
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      const traceId = String(traceparent).split("-")[1];

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() =>
        debugContexts.some(
          (context) =>
            context.direction === "relay_to_client" &&
            context.traceId === traceId,
        ),
      );
    } finally {
      bridge.close();
    }
  });

  it("logs prompt payload summaries for outbound user messages", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const debugContexts: {
      direction?: string;
      method?: string;
      payloadBytes?: number;
      payloadHash?: string;
      promptBlockCount?: number;
      promptTextChars?: number;
      promptTextHash?: string;
      promptTextPreview?: string;
    }[] = [];
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      debugLog(_message, context) {
        if (context) {
          debugContexts.push(context);
        }
      },
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 5,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ text: "why did the user bubble disappear?", type: "text" }],
            sessionId: "session-1",
          },
        })}\n`,
      );

      await waitFor(() =>
        debugContexts.some(
          (context) =>
            context.direction === "client_to_relay" &&
            context.method === "session/prompt" &&
            context.promptTextChars === 34,
        ),
      );
      const context = debugContexts.find(
        (entry) =>
          entry.direction === "client_to_relay" &&
          entry.method === "session/prompt",
      );
      expect(context).toMatchObject({
        promptBlockCount: 1,
        promptTextChars: 34,
      });
      expect(context?.payloadBytes).toBeGreaterThan(0);
      expect(context?.payloadHash).toMatch(/^[0-9a-f]{16}$/);
      expect(context?.promptTextHash).toMatch(/^[0-9a-f]{16}$/);
      expect(context?.promptTextPreview).toBe("why did the user bubble disappear?");
    } finally {
      bridge.close();
    }
  });

  it("uploads prompt images before forwarding resource links over the relay socket", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sockets: TestSocket[] = [];
    const imageBody = Buffer.from("image-bytes");
    const proof = createFakeConnectionProof();
    const credential = await createTestAccountCredential();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      const headers = init?.headers as Record<string, string>;
      const body = init?.body as Uint8Array;
      const attachmentId = requestUrl.searchParams.get("attachmentId") ?? "";
      const uploadProof = decodeAcpRemoteConnectionProof(
        headers["x-acp-connection-proof"] ?? "",
      );

      expect(requestUrl.protocol).toBe("http:");
      expect(requestUrl.pathname).toBe("/attachments");
      expect(requestUrl.searchParams.get("connectionId")).toBe("connection-1");
      expect(requestUrl.searchParams.get("hostId")).toBe("host-1");
      expect(requestUrl.searchParams.get("messageId")).toBe("client-message-1");
      expect(headers["content-type"]).toBe("image/png");
      expect(headers["x-acp-client-id"]).toBe("client-1");
      expect(headers["x-acp-connection-proof"]).toBeTruthy();
      expect(uploadProof.connectionId).toBe("connection-1");
      expect(uploadProof.hostId).toBe("host-1");
      expect(Date.parse(uploadProof.timestamp)).toBeGreaterThan(
        Date.parse(proof.timestamp),
      );
      expect(headers["x-free-attachment-id"]).toBe(attachmentId);
      expect(Buffer.from(body).toString("utf8")).toBe("image-bytes");

      return new Response(JSON.stringify({
        attachmentId,
        mimeType: "image/png",
        ok: true,
        sha256: headers["x-free-attachment-sha256"],
        size: imageBody.byteLength,
        uri: `free-attachment://host-1/connection-1/client-message-1/${attachmentId}`,
      }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    });
    const restoreFetch = stubFetch(fetchMock as typeof fetch);
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      connectionProof: proof,
      connectionProofCredential: credential,
      input,
      output,
      relayUrl: "ws://relay.test/socket",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 6,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            messageId: "client-message-1",
            prompt: [
              { text: "look", type: "text" },
              {
                data: imageBody.toString("base64"),
                mimeType: "image/png",
                type: "image",
              },
            ],
            sessionId: "session-1",
          },
        })}\n`,
      );

      await waitFor(() => fetchMock.mock.calls.length === 1);
      await waitFor(() => sockets[0]?.sent.length === 1);
      const outbound = JSON.parse(sockets[0]!.sent[0]) as {
        params?: { prompt?: unknown[] };
      };

      expect(outbound.params?.prompt?.[1]).toMatchObject({
        mimeType: "image/png",
        size: imageBody.byteLength,
        type: "resource_link",
      });
      expect(JSON.stringify(outbound)).toContain("free-attachment://host-1");
      expect(JSON.stringify(outbound)).not.toContain(imageBody.toString("base64"));
    } finally {
      bridge.close();
      restoreFetch();
    }
  });

  it("refreshes signed connection proofs for relay reconnects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sockets: TestSocket[] = [];
    const proofs: AcpRemoteConnectionProof[] = [];
    const credential = await createTestAccountCredential();
    const staleProof = await createAcpRemoteConnectionProof({
      connectionId: "connection-1",
      credential,
      hostId: "host-1",
      nonce: "stale-proof",
      now: new Date("2026-05-14T00:00:00.000Z"),
    });
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      connectionProof: staleProof,
      connectionProofCredential: credential,
      input,
      output,
      reconnect: {
        maxDelayMs: 5,
        minDelayMs: 5,
      },
      relayUrl: "ws://relay.test/socket",
      socketFactory({ headers }) {
        proofs.push(
          decodeAcpRemoteConnectionProof(headers["x-acp-connection-proof"] ?? ""),
        );
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await waitFor(() => sockets.length === 1);
      sockets[0]?.emitClose();
      await waitFor(() => sockets.length === 2);

      expect(proofs).toHaveLength(2);
      expect(proofs[0]?.connectionId).toBe("connection-1");
      expect(proofs[0]?.hostId).toBe("host-1");
      expect(proofs[0]?.nonce).not.toBe("stale-proof");
      expect(proofs[1]?.connectionId).toBe("connection-1");
      expect(proofs[1]?.hostId).toBe("host-1");
      expect(proofs[1]?.nonce).not.toBe("stale-proof");
      expect(proofs[1]?.nonce).not.toBe(proofs[0]?.nonce);
    } finally {
      bridge.close();
    }
  });

  it("uploads multiple prompt images concurrently before forwarding resource links", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sockets: TestSocket[] = [];
    const imageBodies = [
      Buffer.from("image-one"),
      Buffer.from("image-two"),
    ];
    const proof = createFakeConnectionProof();
    const pendingResponses: Array<Deferred<Response>> = [];
    const uploadRequests: Array<{
      attachmentId: string;
      body: string;
      mimeType: string;
      sha256: string;
    }> = [];
    const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = new URL(String(url));
      const headers = init?.headers as Record<string, string>;
      const body = init?.body as Uint8Array;
      const attachmentId = requestUrl.searchParams.get("attachmentId") ?? "";
      const response = createDeferred<Response>();

      uploadRequests.push({
        attachmentId,
        body: Buffer.from(body).toString("utf8"),
        mimeType: headers["content-type"],
        sha256: headers["x-free-attachment-sha256"],
      });
      pendingResponses.push(response);
      return response.promise;
    });
    const restoreFetch = stubFetch(fetchMock as typeof fetch);
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      connectionProof: proof,
      input,
      output,
      relayUrl: "ws://relay.test/socket",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 7,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            messageId: "client-message-2",
            prompt: [
              { text: "compare", type: "text" },
              {
                data: imageBodies[0]!.toString("base64"),
                mimeType: "image/png",
                type: "image",
              },
              {
                data: imageBodies[1]!.toString("base64"),
                mimeType: "image/jpeg",
                type: "image",
              },
            ],
            sessionId: "session-1",
          },
        })}\n`,
      );

      await waitFor(() => fetchMock.mock.calls.length === 2);
      expect(uploadRequests.map((request) => request.body)).toEqual([
        "image-one",
        "image-two",
      ]);
      expect(sockets[0]?.sent.length ?? 0).toBe(0);

      pendingResponses[1]!.resolve(createAttachmentUploadResponse({
        attachmentId: uploadRequests[1]!.attachmentId,
        mimeType: uploadRequests[1]!.mimeType,
        sha256: uploadRequests[1]!.sha256,
        size: imageBodies[1]!.byteLength,
        uri: `free-attachment://host-1/connection-1/client-message-2/${
          uploadRequests[1]!.attachmentId
        }`,
      }));
      expect(sockets[0]?.sent.length ?? 0).toBe(0);

      pendingResponses[0]!.resolve(createAttachmentUploadResponse({
        attachmentId: uploadRequests[0]!.attachmentId,
        mimeType: uploadRequests[0]!.mimeType,
        sha256: uploadRequests[0]!.sha256,
        size: imageBodies[0]!.byteLength,
        uri: `free-attachment://host-1/connection-1/client-message-2/${
          uploadRequests[0]!.attachmentId
        }`,
      }));

      await waitFor(() => sockets[0]?.sent.length === 1);
      const outbound = JSON.parse(sockets[0]!.sent[0]) as {
        params?: { prompt?: unknown[] };
      };

      expect(outbound.params?.prompt?.[1]).toMatchObject({
        mimeType: "image/png",
        type: "resource_link",
        uri: `free-attachment://host-1/connection-1/client-message-2/${
          uploadRequests[0]!.attachmentId
        }`,
      });
      expect(outbound.params?.prompt?.[2]).toMatchObject({
        mimeType: "image/jpeg",
        type: "resource_link",
        uri: `free-attachment://host-1/connection-1/client-message-2/${
          uploadRequests[1]!.attachmentId
        }`,
      });
      expect(JSON.stringify(outbound)).not.toContain(imageBodies[0]!.toString("base64"));
      expect(JSON.stringify(outbound)).not.toContain(imageBodies[1]!.toString("base64"));
    } finally {
      bridge.close();
      restoreFetch();
    }
  });

  it("queues outbound requests while the relay is reconnecting", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        maxQueuedMessages: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      await waitFor(() => sockets.length === 1);
      sockets[0]?.emitClose();
      input.write(
        `${JSON.stringify({
          id: 2,
          jsonrpc: "2.0",
          method: "session/list",
          params: {},
        })}\n`,
      );
      input.write(
        `${JSON.stringify({
          id: 3,
          jsonrpc: "2.0",
          method: "session/list",
          params: {},
        })}\n`,
      );

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 2);
      expect(outputText).not.toContain("reconnect queue is full");
      expect(
        sockets[1]!.sent.map((message) => JSON.parse(message).id),
      ).toEqual([2, 3]);
    } finally {
      bridge.close();
    }
  });

  it("replays replayable in-flight requests after relay reconnect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 1);
      expect(JSON.parse(sockets[1]!.sent[0])).toMatchObject({
        id: 4,
        method: "session/load",
      });

      sockets[1]?.emitMessage(
        JSON.stringify({
          id: 4,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() => outputText.includes('"id":4'));
      expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
        id: 4,
        result: { sessionId: "session-1" },
      });
    } finally {
      bridge.close();
    }
  });

  it("requests recovery for session/prompt after relay reconnect without replaying the prompt", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 5,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ content: "hi", type: "text" }],
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 1);
      expect(JSON.parse(sockets[1]!.sent[0])).toMatchObject({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/recover_in_flight",
        params: {
          requests: [{
            id: 5,
            method: "session/prompt",
          }],
        },
      });
    } finally {
      bridge.close();
    }
  });

  it("auto-retries recoverable session/prompt failures and preserves the client response id", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 50,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ text: "recover this", type: "text" }],
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          error: {
            code: -32005,
            data: { reason: "request_status_unknown_after_reconnect" },
            message: "The request status is unknown after reconnect.",
          },
          id: 50,
          jsonrpc: "2.0",
        }),
      );

      await waitFor(() => promptMessages(sockets[0]!.sent).length === 2);
      expect(outputText).toBe("");
      const retry = promptMessages(sockets[0]!.sent).at(-1)!;
      expect(retry.id).not.toBe(50);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: retry.id,
          jsonrpc: "2.0",
          result: { stopReason: "end_turn" },
        }),
      );

      await waitFor(() => outputText.includes('"id":50'));
      expect(JSON.parse(outputText.trim())).toMatchObject({
        id: 50,
        jsonrpc: "2.0",
        result: { stopReason: "end_turn" },
      });
      expect(outputText).not.toContain("-32005");
    } finally {
      bridge.close();
    }
  });

  it("stops auto-retrying recoverable session/prompt failures after a bounded limit", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 51,
          jsonrpc: "2.0",
          method: "session/prompt",
          params: {
            prompt: [{ text: "host may restart", type: "text" }],
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => promptMessages(sockets[0]!.sent).length === 1);

      let currentId: string | number = 51;
      for (let failure = 1; failure <= 3; failure += 1) {
        sockets[0]?.emitMessage(
          JSON.stringify({
            error: {
              code: -32003,
              data: { reason: "host_restarted" },
              message:
                "Remote host restarted before this request completed. The request status is unknown; retry if appropriate.",
            },
            id: currentId,
            jsonrpc: "2.0",
          }),
        );
        if (failure < 3) {
          await waitFor(() =>
            promptMessages(sockets[0]!.sent).length === failure + 1,
          );
          currentId = promptMessages(sockets[0]!.sent).at(-1)!.id;
        }
      }

      await waitFor(() => outputText.includes('"id":51'));
      expect(promptMessages(sockets[0]!.sent)).toHaveLength(3);
      expect(JSON.parse(outputText.trim())).toMatchObject({
        error: {
          code: -32003,
          data: { reason: "host_restarted" },
        },
        id: 51,
        jsonrpc: "2.0",
      });
    } finally {
      bridge.close();
    }
  });

  it("replays session/new after relay reconnect", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 6,
          jsonrpc: "2.0",
          method: "session/new",
          params: {
            cwd: "/Users/dev",
            mcpServers: [],
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => sockets.length === 2);
      await waitFor(() => sockets[1]!.sent.length === 1);
      expect(JSON.parse(sockets[1]!.sent[0])).toMatchObject({
        id: 6,
        method: "session/new",
      });
      expect(outputText).not.toContain(
        "Relay connection closed before this request completed",
      );

      sockets[1]?.emitMessage(
        JSON.stringify({
          id: 6,
          jsonrpc: "2.0",
          result: { sessionId: "session-2" },
        }),
      );

      await waitFor(() => outputText.includes('"id":6'));
      expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
        id: 6,
        result: { sessionId: "session-2" },
      });
    } finally {
      bridge.close();
    }
  });

  it("fails non-replayable in-flight requests when relay disconnects", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      reconnect: {
        maxDelayMs: 1,
        minDelayMs: 1,
      },
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 7,
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);
      sockets[0]?.emitClose();

      await waitFor(() => outputText.includes('"id":7'));
      expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
        error: {
          code: -32001,
        },
        id: 7,
        jsonrpc: "2.0",
      });
      await waitFor(() => sockets.length === 2);
      expect(sockets[1]!.sent).toHaveLength(0);
    } finally {
      bridge.close();
    }
  });

  it("fails in-flight requests before closing the bridge", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    let closed = false;
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      onClose() {
        closed = true;
      },
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    input.write(
      `${JSON.stringify({
        id: 8,
        jsonrpc: "2.0",
        method: "session/prompt",
        params: {
          prompt: [{ text: "hello", type: "text" }],
          sessionId: "session-1",
        },
      })}\n`,
    );
    await waitFor(() => sockets[0]?.sent.length === 1);

    bridge.close({
      reason: "Bridge executable changed before this request completed.",
    });

    await waitFor(() => outputText.includes('"id":8'));
    expect(JSON.parse(outputText.trim().split("\n")[0]!)).toMatchObject({
      error: {
        code: -32007,
        data: {
          method: "session/prompt",
          reason: "bridge_closed",
        },
        message: expect.stringContaining("Bridge executable changed"),
      },
      id: 8,
      jsonrpc: "2.0",
    });
    await waitFor(() => closed);
  });

  it("acknowledges relay responses after writing them to stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );

      await waitFor(() =>
        sockets[0]?.sent.some((message) =>
          message.includes("acp-runtime/remote/client_ack"),
        ) ?? false,
      );
      expect(outputText).toContain('"id":9');
      expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { id: 9 },
      });

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 9,
          jsonrpc: "2.0",
          result: { sessionId: "session-1" },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(outputText.trim().split("\n")).toHaveLength(1);
    } finally {
      bridge.close();
    }
  });

  it("acknowledges relay notifications after writing them to stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      sockets[0]?.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            _meta: {
              "acp-runtime/remote/clientAckSeq": 42,
            },
            sessionId: "session-1",
            update: {
              content: { text: "hello", type: "text" },
              sessionUpdate: "user_message_chunk",
            },
          },
        }),
      );

      await waitFor(() =>
        sockets[0]?.sent.some((message) =>
          message.includes("acp-runtime/remote/client_ack"),
        ) ?? false,
      );
      const outputMessage = JSON.parse(outputText.trim()) as {
        params?: { _meta?: unknown };
      };
      expect(outputMessage.params?._meta).toBeUndefined();
      expect(JSON.parse(sockets[0]!.sent.at(-1)!)).toMatchObject({
        jsonrpc: "2.0",
        method: "acp-runtime/remote/client_ack",
        params: { seq: 42 },
      });
    } finally {
      bridge.close();
    }
  });

  it("injects stable remote display config locally and intercepts its updates", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      hostDisplayNames: new Map([["host-a", "Studio"]]),
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 10,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 10,
          jsonrpc: "2.0",
          result: {
            _meta: {
              "acp-runtime/remote/hostId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "claude-acp" },
              "acp-runtime/remote/sessionMachine": "dev.local",
              "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/07"],
            },
            configOptions: [
              {
                currentValue: "real",
                id: "real-option",
                name: "Real Option",
                type: "string",
              },
            ],
            sessionId: "session-1",
          },
        }),
      );

      await waitFor(() => outputText.includes('"id":10'));
      const firstResponse = JSON.parse(outputText.trim().split("\n")[0]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { description?: string; name: string; value: string }[];
          }[];
        };
      };
      expect(firstResponse.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "real-option" }),
          expect.objectContaining({
            currentValue: "Studio · /Users/dev/07",
            id: "acp-runtime.remote.context",
            options: [
              {
                description: "Studio · /Users/dev/07",
                name: "Studio · /Users/dev/07",
                value: "Studio · /Users/dev/07",
              },
              {
                description: "claude-acp",
                name: "claude-acp",
                value: "claude-acp",
              },
              {
                description: "session-1",
                name: "session-1",
                value: "session-1",
              },
            ],
          }),
        ]),
      );

      input.write(
        `${JSON.stringify({
          id: 11,
          jsonrpc: "2.0",
          method: "session/set_config_option",
          params: {
            configId: "acp-runtime.remote.context",
            sessionId: "session-1",
            value: "changed",
          },
        })}\n`,
      );

      await waitFor(() => outputText.includes('"id":11'));
      expect(
        sockets[0]!.sent.some((message) => {
          try {
            return JSON.parse(message).method === "session/set_config_option";
          } catch {
            return false;
          }
        }),
      ).toBe(false);
      const secondResponse = JSON.parse(outputText.trim().split("\n")[1]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { description?: string; name: string; value: string }[];
          }[];
        };
      };
      expect(secondResponse.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            currentValue: "Studio · /Users/dev/07",
            id: "acp-runtime.remote.context",
            options: expect.arrayContaining([
              {
                description: "session-1",
                name: "session-1",
                value: "session-1",
              },
            ]),
          }),
        ]),
      );

      input.write(
        `${JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          method: "session/set_config_option",
          params: {
            configId: "real-option",
            sessionId: "session-1",
            value: "changed-real",
          },
        })}\n`,
      );

      await waitFor(() =>
        sockets[0]!.sent.some((message) => {
          try {
            const parsed = JSON.parse(message);
            return (
              parsed.id === 12 && parsed.method === "session/set_config_option"
            );
          } catch {
            return false;
          }
        }),
      );

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 12,
          jsonrpc: "2.0",
          result: {
            configOptions: [
              {
                currentValue: "changed-real",
                id: "real-option",
                name: "Real Option",
                type: "string",
              },
            ],
          },
        }),
      );

      await waitFor(() => outputText.includes('"id":12'));
      const thirdResponse = JSON.parse(outputText.trim().split("\n")[2]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { description?: string; name: string; value: string }[];
          }[];
        };
      };
      expect(thirdResponse.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            currentValue: "changed-real",
            id: "real-option",
          }),
          expect.objectContaining({
            currentValue: "Studio · /Users/dev/07",
            id: "acp-runtime.remote.context",
          }),
        ]),
      );
    } finally {
      bridge.close();
    }
  });

  it("keeps remote display config on config option update notifications", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 20,
          jsonrpc: "2.0",
          method: "session/new",
          params: { cwd: "/tmp/project", mcpServers: [] },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 20,
          jsonrpc: "2.0",
          result: {
            _meta: {
              "acp-runtime/remote/hostId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "codex" },
              "acp-runtime/remote/sessionMachine": "dev.local",
              "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/acp-runtime"],
            },
            configOptions: [],
            sessionId: "session-1",
          },
        }),
      );
      await waitFor(() => outputText.includes('"id":20'));

      sockets[0]?.emitMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              configOptions: [
                {
                  currentValue: "real",
                  id: "real-option",
                  name: "Real Option",
                  type: "string",
                },
              ],
              sessionUpdate: "config_option_update",
            },
          },
        }),
      );

      await waitFor(() => outputText.includes('"session/update"'));
      const update = JSON.parse(outputText.trim().split("\n")[1]!) as {
        params: {
          update: {
            configOptions: {
              currentValue?: string;
              id: string;
              options?: { description?: string; name: string; value: string }[];
            }[];
          };
        };
      };
      expect(update.params.update.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "real-option" }),
          expect.objectContaining({
            currentValue: "dev.local · /Users/dev/acp-runtime",
            id: "acp-runtime.remote.context",
            options: expect.arrayContaining([
              {
                description: "dev.local · /Users/dev/acp-runtime",
                name: "dev.local · /Users/dev/acp-runtime",
                value: "dev.local · /Users/dev/acp-runtime",
              },
              {
                description: "session-1",
                name: "session-1",
                value: "session-1",
              },
            ]),
          }),
        ]),
      );
    } finally {
      bridge.close();
    }
  });

  it("injects remote display config when session response has no real config options", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    const debugContexts: {
      configOptionCount?: number;
      configOptionHasRemoteContext?: boolean;
      configOptionIds?: string;
      direction?: string;
      method?: string;
    }[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      debugLog(_message, context) {
        if (context) {
          debugContexts.push(context);
        }
      },
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 30,
          jsonrpc: "2.0",
          method: "session/load",
          params: { sessionId: "session-1" },
        })}\n`,
      );
      await waitFor(() => sockets[0]?.sent.length === 1);

      sockets[0]?.emitMessage(
        JSON.stringify({
          id: 30,
          jsonrpc: "2.0",
          result: {
            _meta: {
              "acp-runtime/remote/hostId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "codex" },
              "acp-runtime/remote/sessionMachine": "dev.local",
              "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/acp-runtime"],
            },
            sessionId: "session-1",
          },
        }),
      );

      await waitFor(() => outputText.includes('"id":30'));
      const response = JSON.parse(outputText.trim()) as {
        result: {
          configOptions?: {
            currentValue?: string;
            id: string;
          }[];
        };
      };
      expect(response.result.configOptions).toEqual([
        expect.objectContaining({
          currentValue: "dev.local · /Users/dev/acp-runtime",
          id: "acp-runtime.remote.context",
        }),
      ]);
      expect(debugContexts).toContainEqual(
        expect.objectContaining({
          configOptionCount: 1,
          configOptionHasRemoteContext: true,
          configOptionIds: "acp-runtime.remote.context",
          direction: "relay_to_client",
          method: "session/load",
        }),
      );
    } finally {
      bridge.close();
    }
  });

  it("intercepts remote config updates with session-scoped config options", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      for (const [id, sessionId, machine] of [
        [40, "session-1", "one.local"],
        [41, "session-2", "two.local"],
      ] as const) {
        input.write(
          `${JSON.stringify({
            id,
            jsonrpc: "2.0",
            method: "session/load",
            params: { sessionId },
          })}\n`,
        );
        await waitFor(() => sockets[0]!.sent.some((message) => {
          try {
            return JSON.parse(message).id === id;
          } catch {
            return false;
          }
        }));
        sockets[0]?.emitMessage(
          JSON.stringify({
            id,
            jsonrpc: "2.0",
            result: {
              _meta: {
                "acp-runtime/remote/hostId": "host-a",
                "acp-runtime/remote/sessionAgent": { id: "codex" },
                "acp-runtime/remote/sessionMachine": machine,
                "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/acp-runtime"],
              },
              configOptions: [
                {
                  currentValue: `real-${sessionId}`,
                  id: `real-${sessionId}`,
                  name: `Real ${sessionId}`,
                  type: "string",
                },
              ],
              sessionId,
            },
          }),
        );
        await waitFor(() => outputText.includes(`"id":${id}`));
      }

      input.write(
        `${JSON.stringify({
          id: 42,
          jsonrpc: "2.0",
          method: "session/set_config_option",
          params: {
            configId: "acp-runtime.remote.context",
            sessionId: "session-1",
            value: "ignored",
          },
        })}\n`,
      );

      await waitFor(() => outputText.includes('"id":42'));
      const response = JSON.parse(outputText.trim().split("\n")[2]!) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
          }[];
        };
      };
      expect(response.result.configOptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            currentValue: "one.local · /Users/dev/acp-runtime",
            id: "acp-runtime.remote.context",
          }),
          expect.objectContaining({ id: "real-session-1" }),
        ]),
      );
      expect(response.result.configOptions).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "real-session-2" }),
        ]),
      );
    } finally {
      bridge.close();
    }
  });

  it("rebuilds the remote display config from request metadata when the option cache is cold", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputText += chunk;
    });
    const sockets: TestSocket[] = [];
    const bridge = createAcpRemoteStdioBridge({
      clientId: "client-1",
      connectionId: "connection-1",
      hostDisplayNames: new Map([["host-a", "Studio"]]),
      input,
      output,
      relayUrl: "ws://relay.test",
      socketFactory() {
        const socket = new TestSocket();
        sockets.push(socket);
        return socket;
      },
    });

    try {
      input.write(
        `${JSON.stringify({
          id: 50,
          jsonrpc: "2.0",
          method: "session/set_config_option",
          params: {
            _meta: {
              "acp-runtime/remote/hostId": "host-a",
              "acp-runtime/remote/sessionAgent": { id: "codex" },
              "acp-runtime/remote/sessionMachine": "dev.local",
              "acp-runtime/remote/sessionWorkspaceRoots": ["/Users/dev/Free"],
            },
            configId: "acp-runtime.remote.context",
            sessionId: "session-cold",
            value: "ignored",
          },
        })}\n`,
      );

      await waitFor(() => outputText.includes('"id":50'));
      expect(sockets[0]?.sent).toHaveLength(0);
      const response = JSON.parse(outputText.trim()) as {
        result: {
          configOptions: {
            currentValue?: string;
            id: string;
            options?: { description?: string; name: string; value: string }[];
          }[];
        };
      };
      expect(response.result.configOptions).toEqual([
        expect.objectContaining({
          currentValue: "Studio · /Users/dev/Free",
          id: "acp-runtime.remote.context",
          options: expect.arrayContaining([
            {
              description: "codex",
              name: "codex",
              value: "codex",
            },
            {
              description: "session-cold",
              name: "session-cold",
              value: "session-cold",
            },
          ]),
        }),
      ]);
    } finally {
      bridge.close();
    }
  });
});

class TestSocket implements AcpWebSocketLike {
  readonly sent: string[] = [];
  private readonly closeListeners = new Set<AcpWebSocketEventListener>();
  private readonly errorListeners = new Set<AcpWebSocketEventListener>();
  private readonly messageListeners = new Set<AcpWebSocketMessageListener>();

  addEventListener(
    type: "close" | "error",
    listener: AcpWebSocketEventListener,
  ): void;
  addEventListener(
    type: "message",
    listener: AcpWebSocketMessageListener,
  ): void;
  addEventListener(
    type: "close" | "error" | "message",
    listener: AcpWebSocketEventListener | AcpWebSocketMessageListener,
  ): void {
    if (type === "close") {
      this.closeListeners.add(listener as AcpWebSocketEventListener);
    } else if (type === "error") {
      this.errorListeners.add(listener as AcpWebSocketEventListener);
    } else {
      this.messageListeners.add(listener as AcpWebSocketMessageListener);
    }
  }

  close(): void {
    this.emitClose();
  }

  emitClose(): void {
    for (const listener of this.closeListeners) {
      listener();
    }
  }

  emitMessage(data: string): void {
    for (const listener of this.messageListeners) {
      listener({ data });
    }
  }

  removeEventListener(
    type: "close" | "error",
    listener: AcpWebSocketEventListener,
  ): void;
  removeEventListener(
    type: "message",
    listener: AcpWebSocketMessageListener,
  ): void;
  removeEventListener(
    type: "close" | "error" | "message",
    listener: AcpWebSocketEventListener | AcpWebSocketMessageListener,
  ): void {
    if (type === "close") {
      this.closeListeners.delete(listener as AcpWebSocketEventListener);
    } else if (type === "error") {
      this.errorListeners.delete(listener as AcpWebSocketEventListener);
    } else {
      this.messageListeners.delete(listener as AcpWebSocketMessageListener);
    }
  }

  send(data: ArrayBuffer | ArrayBufferView | string): void {
    if (typeof data === "string") {
      this.sent.push(data);
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 5));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}

function promptMessages(messages: string[]): Array<{ id: string | number }> {
  return messages
    .map((message) => JSON.parse(message) as { id?: unknown; method?: unknown })
    .filter((message): message is { id: string | number; method: string } =>
      message.method === "session/prompt" &&
      (typeof message.id === "string" || typeof message.id === "number")
    );
}

type Deferred<T> = {
  promise: Promise<T>;
  reject(reason?: unknown): void;
  resolve(value: T): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function stubFetch(fetchMock: typeof fetch): () => void {
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
    writable: true,
  });
  return () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: previousFetch,
      writable: true,
    });
  };
}

function createAttachmentUploadResponse(input: {
  attachmentId: string;
  mimeType: string;
  sha256: string;
  size: number;
  uri: string;
}): Response {
  return new Response(JSON.stringify({
    attachmentId: input.attachmentId,
    mimeType: input.mimeType,
    ok: true,
    sha256: input.sha256,
    size: input.size,
    uri: input.uri,
  }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function createFakeConnectionProof(): AcpRemoteConnectionProof {
  return {
    accountSession: {
      accountId: "acct-1",
      alg: "Ed25519",
      expiresAt: "2026-06-12T00:00:00.000Z",
      issuedAt: "2026-05-12T00:00:00.000Z",
      kid: "authority-1",
      principalId: "client-1",
      principalType: "client",
      publicKey: "public-key",
      sessionId: "account-session-1",
      signature: "session-signature",
    },
    clientId: "client-1",
    connectionId: "connection-1",
    hostId: "host-1",
    nonce: "nonce-1",
    signature: "proof-signature",
    timestamp: "2026-05-12T00:00:00.000Z",
  };
}

async function createTestAccountCredential(): Promise<AcpRemoteAccountSessionCredential> {
  const authority = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const client = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  return {
    accountSession: await createAcpRemoteAccountSession({
      accountId: "acct-1",
      expiresAt: "2026-06-12T00:00:00.000Z",
      issuedAt: "2026-05-12T00:00:00.000Z",
      principalId: "client-1",
      principalPublicKey: client.publicKey,
      principalType: "client",
      signingKey: {
        kid: "authority-1",
        privateKey: authority.privateKey,
      },
    }),
    privateKey: client.privateKey,
  };
}
