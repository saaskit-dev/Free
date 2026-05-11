import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryWebSocket, createMemoryWebSocketPair, waitFor } from "../shared/test-helpers.js";
import { createAcpRemoteClientConnection } from "./relay-connection.js";

describe("createAcpRemoteClientConnection", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("native-acp transport", () => {
    it("passes raw JSON-RPC through to onMessage", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const received: string[] = [];

      const conn = createAcpRemoteClientConnection({
        socket: clientSocket,
        onMessage(msg) { received.push(msg); },
      });

      const jsonRpc = JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 });
      relaySocket.send(jsonRpc);

      await waitFor(() => received.length > 0);
      expect(received).toEqual([jsonRpc]);

      conn.close();
    });

    it("sends raw JSON-RPC to the socket", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      const sent: string[] = [];

      relaySocket.addEventListener("message", (e) => {
        if (typeof e.data === "string") sent.push(e.data);
      });

      const conn = createAcpRemoteClientConnection({
        socket: clientSocket,
        onMessage() {},
      });

      conn.send(JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }));

      await waitFor(() => sent.length > 0);
      expect(sent).toEqual([JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 })]);

      conn.close();
    });

    it("calls onClose when socket closes", async () => {
      const [clientSocket, relaySocket] = createMemoryWebSocketPair();
      let closed = false;

      createAcpRemoteClientConnection({
        socket: clientSocket,
        onMessage() {},
        onClose() { closed = true; },
      });

      relaySocket.close();
      await waitFor(() => closed);
      expect(closed).toBe(true);
    });

    it("terminates and reports close when transport heartbeat times out", async () => {
      vi.useFakeTimers();
      const socket = new PingableMemoryWebSocket();
      const closeEvents: unknown[] = [];
      const errors: string[] = [];

      createAcpRemoteClientConnection({
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 20,
        socket,
        onMessage() {},
        onClose(event) { closeEvents.push(event); },
        onError(error) { errors.push(error.message); },
      });

      await vi.advanceTimersByTimeAsync(10);
      expect(socket.pingCount).toBe(1);

      await vi.advanceTimersByTimeAsync(20);
      expect(socket.terminated).toBe(true);
      expect(errors).toEqual(["Relay WebSocket heartbeat timed out."]);
      expect(closeEvents).toEqual([
        expect.objectContaining({
          code: 1006,
          reason: "Relay WebSocket heartbeat timed out.",
        }),
      ]);
    });

    it("keeps the connection open when heartbeat pong arrives", async () => {
      vi.useFakeTimers();
      const socket = new PingableMemoryWebSocket();
      let closed = false;

      const conn = createAcpRemoteClientConnection({
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 20,
        socket,
        onMessage() {},
        onClose() { closed = true; },
      });

      await vi.advanceTimersByTimeAsync(10);
      socket.emitPong();
      await vi.advanceTimersByTimeAsync(20);

      expect(closed).toBe(false);
      expect(socket.terminated).toBe(false);
      conn.close();
    });

    it("does not ping while the websocket is still connecting", async () => {
      vi.useFakeTimers();
      const socket = new PingableMemoryWebSocket();
      socket.readyState = 0;

      const conn = createAcpRemoteClientConnection({
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 20,
        socket,
        onMessage() {},
      });

      await vi.advanceTimersByTimeAsync(30);
      expect(socket.pingCount).toBe(0);

      socket.readyState = 1;
      await vi.advanceTimersByTimeAsync(10);
      expect(socket.pingCount).toBe(1);

      conn.close();
    });
  });

  it("swallows cleanup errors when closing before the websocket opens", () => {
    const socket = new CloseBeforeOpenWebSocket();
    const conn = createAcpRemoteClientConnection({
      socket,
      onMessage() {},
    });

    expect(() => conn.close()).not.toThrow();
    expect(socket.closeErrorDelivered).toBe(1);
  });
});

class PingableMemoryWebSocket extends MemoryWebSocket {
  pingCount = 0;
  readyState = 1;
  terminated = false;
  private readonly pongListeners = new Set<() => void>();

  on(type: "pong", listener: () => void): void {
    if (type === "pong") {
      this.pongListeners.add(listener);
    }
  }

  off(type: "pong", listener: () => void): void {
    if (type === "pong") {
      this.pongListeners.delete(listener);
    }
  }

  ping(callback?: (error?: Error) => void): void {
    this.pingCount += 1;
    callback?.();
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, "terminated");
  }

  emitPong(): void {
    for (const listener of this.pongListeners) {
      listener();
    }
  }
}

class CloseBeforeOpenWebSocket {
  readyState = 0;
  closeErrorDelivered = 0;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(): void {}

  close(): void {
    const errorListeners = this.listeners.get("error") ?? new Set();
    if (!errorListeners.size) {
      throw new Error("WebSocket was closed before the connection was established");
    }
    this.closeErrorDelivered += errorListeners.size;
    for (const listener of errorListeners) {
      listener(
        new Error("WebSocket was closed before the connection was established"),
      );
    }
  }
}
