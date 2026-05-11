import { describe, expect, it } from "vitest";

import { AcpRemoteFrameType } from "../protocol/types.js";
import {
  connectAcpRemoteHostRelay,
  createAcpRemoteHostRelayUrl,
  createAcpRemoteHostWebSocketFactory,
} from "./relay-client.js";

describe("ACP remote host relay client", () => {
  it("builds a host relay websocket url", () => {
    expect(
      createAcpRemoteHostRelayUrl({
        accountId: "acct-1",
        hostId: "host-1",
        relayUrl: "https://relay.example.com/acp?foo=bar",
      }),
    ).toBe(
      "https://relay.example.com/host?foo=bar&accountId=acct-1&hostId=host-1",
    );
  });

  it("creates signed registration headers and wires the host relay connection", async () => {
    const sent: string[] = [];
    const listeners = new Map<
      string,
      Set<(...args: unknown[]) => void>
    >();
    const socket = {
      addEventListener(type: string, listener: (...args: unknown[]) => void) {
        const bucket = listeners.get(type) ?? new Set();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      close() {},
      removeEventListener(type: string, listener: (...args: unknown[]) => void) {
        listeners.get(type)?.delete(listener);
      },
      send(data: string) {
        sent.push(data);
      },
    };

    const connected = await connectAcpRemoteHostRelay({
      accountId: "acct-1",
      agent: "simulator",
      hostId: "host-1",
      hostMetadata: {
        agentTypes: [{ id: "simulator-agent-acp-local", label: "Simulator" }],
        machine: "dev-mac",
        workspaceRoots: [{ path: "/Users/dev/acp-runtime" }],
      },
      relayUrl: "https://relay.example.com/acp",
      runtime: {
        sessions: {
          async list() {
            throw new Error("not used");
          },
          async load() {
            throw new Error("not used");
          },
          async resume() {
            throw new Error("not used");
          },
          async start() {
            throw new Error("not used");
          },
        },
      },
      accountSessionVerificationKeys: [
        {
          kid: "test-key",
          publicKey: "test-public-key",
        },
      ],
      socketFactory(input) {
        expect(input.url).toBe(
          "https://relay.example.com/host?accountId=acct-1&hostId=host-1",
        );
        expect(input.headers["x-acp-account-id"]).toBe("acct-1");
        expect(input.headers["x-acp-host-id"]).toBe("host-1");
        expect(typeof input.headers["x-acp-host-signature"]).toBe("string");
        expect(typeof input.headers["x-acp-host-nonce"]).toBe("string");
        expect(typeof input.headers["x-acp-host-timestamp"]).toBe("string");
        expect(
          JSON.parse(input.headers["x-acp-host-metadata"] ?? "{}"),
        ).toMatchObject({
          machine: "dev-mac",
          workspaceRoots: [{ path: "/Users/dev/acp-runtime" }],
        });
        return socket;
      },
    });

    const pingListeners = listeners.get("message");
    expect(pingListeners?.size).toBe(1);
    for (const listener of pingListeners ?? []) {
      listener({
        data: JSON.stringify({
          connectionId: "heartbeat:host-1",
          frameType: AcpRemoteFrameType.Ping,
          nonce: "nonce-1",
        }),
      });
    }

    expect(sent).toContain(
      JSON.stringify({
        connectionId: "heartbeat:host-1",
        frameType: AcpRemoteFrameType.Pong,
        nonce: "nonce-1",
      }),
    );

    connected.close();
  });

  it("swallows cleanup errors after a socket fails before opening", async () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const socket = {
      readyState: 0,
      addEventListener(type: string, listener: (...args: unknown[]) => void) {
        const bucket = listeners.get(type) ?? new Set();
        bucket.add(listener);
        listeners.set(type, bucket);
        if (type === "close") {
          queueMicrotask(() => {
            for (const closeListener of listeners.get("close") ?? []) {
              closeListener({ code: 1006, reason: "handshake stalled" });
            }
          });
        }
      },
      close() {
        const errorListeners = listeners.get("error") ?? new Set();
        if (!errorListeners.size) {
          throw new Error(
            "WebSocket was closed before the connection was established",
          );
        }
        for (const errorListener of errorListeners) {
          errorListener(
            new Error(
              "WebSocket was closed before the connection was established",
            ),
          );
        }
      },
      removeEventListener(type: string, listener: (...args: unknown[]) => void) {
        listeners.get(type)?.delete(listener);
      },
      send() {},
    };

    await expect(
      connectAcpRemoteHostRelay({
        accountId: "acct-1",
        agent: "simulator",
        hostId: "host-1",
        relayUrl: "https://relay.example.com/acp",
        runtime: {
          sessions: {
            async list() {
              throw new Error("not used");
            },
            async load() {
              throw new Error("not used");
            },
            async resume() {
              throw new Error("not used");
            },
            async start() {
              throw new Error("not used");
            },
          },
        },
        accountSessionVerificationKeys: [
          {
            kid: "test-key",
            publicKey: "test-public-key",
          },
        ],
        socketFactory() {
          return socket;
        },
      }),
    ).rejects.toThrow(
      "ACP remote host relay closed before opening (code=1006 reason=handshake stalled).",
    );
  });

  it("adapts websocket constructors that accept header options", () => {
    const calls: unknown[] = [];
    class HeaderWebSocket {
      constructor(
        url: string,
        protocols?: readonly string[] | string,
        options?: {
          headers?: Record<string, string>;
        },
      ) {
        calls.push({ options, protocols, url });
      }

      addEventListener(type: "close" | "error", listener: () => void): void;
      addEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      addEventListener(
        _type: "close" | "error" | "message",
        _listener: (() => void) | ((event: { data: unknown }) => void),
      ): void {}
      close() {}
      removeEventListener(type: "close" | "error", listener: () => void): void;
      removeEventListener(
        type: "message",
        listener: (event: { data: unknown }) => void,
      ): void;
      removeEventListener(
        _type: "close" | "error" | "message",
        _listener: (() => void) | ((event: { data: unknown }) => void),
      ): void {}
      send(_data: string) {}
    }

    const socketFactory = createAcpRemoteHostWebSocketFactory(HeaderWebSocket);
    socketFactory({
      headers: {
        "x-acp-host-signature": "signature",
      },
      url: "wss://relay.example.com/host",
    });

    expect(calls).toEqual([
      {
        options: {
          headers: {
            "x-acp-host-signature": "signature",
          },
        },
        protocols: undefined,
        url: "wss://relay.example.com/host",
      },
    ]);
  });
});
