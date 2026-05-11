import { normalizeWebSocketMessageData, type AcpWebSocketLike } from "../protocol/websocket-stream.js";

export type AcpRemoteClientConnectionOptions = {
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  socket: AcpWebSocketLike;
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
};

export type AcpRemoteClientCloseEvent = {
  code?: number;
  reason?: string;
};

export type AcpRemoteClientConnectionHandle = {
  close(): void;
  send(message: string): void;
};

export function createAcpRemoteClientConnection(
  options: AcpRemoteClientConnectionOptions,
): AcpRemoteClientConnectionHandle {
  const { socket, onMessage, onClose, onError } = options;
  const heartbeat = {
    intervalMs: options.heartbeatIntervalMs ?? 15_000,
    timeoutMs: options.heartbeatTimeoutMs ?? 45_000,
  };

  return createNativeAcpConnection({
    heartbeat,
    socket,
    onMessage,
    onClose,
    onError,
  });
}

function createNativeAcpConnection(input: {
  heartbeat: AcpRemoteClientHeartbeatOptions;
  socket: AcpWebSocketLike;
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
}): AcpRemoteClientConnectionHandle {
  const { heartbeat, socket, onMessage, onClose, onError } = input;
  let closed = false;
  const sender = createBufferedSocketSender(socket, () => closed, (error) => {
    failConnection(error);
  });
  let heartbeatCleanup: (() => void) | undefined;

  const onMessageHandler = (event: { data: unknown }) => {
    const text = normalizeWebSocketMessageData(event.data);
    if (text) {
      onMessage(text);
    }
  };

  const failConnection = (error: Error) => {
    if (closed) {
      return;
    }
    closed = true;
    heartbeatCleanup?.();
    sender.dispose();
    socket.removeEventListener?.("message", onMessageHandler);
    socket.removeEventListener?.("close", onCloseHandler);
    socket.removeEventListener?.("error", onErrorHandler);
    onError?.(error);
    forceCloseSocket(socket, 1006, error.message);
    onClose?.({ code: 1006, reason: error.message });
  };

  const onCloseHandler = (event?: unknown) => {
    if (!closed) {
      closed = true;
      heartbeatCleanup?.();
      sender.dispose();
      onClose?.(normalizeCloseEvent(event));
    }
  };

  const onErrorHandler = () => {
    onError?.(new Error("WebSocket error."));
  };

  socket.addEventListener("message", onMessageHandler);
  socket.addEventListener("close", onCloseHandler);
  socket.addEventListener("error", onErrorHandler);
  heartbeatCleanup = startSocketHeartbeat(socket, heartbeat, failConnection);

  return {
    send(message: string) {
      if (closed) return;
      sender.send(message);
    },
    close() {
      if (closed) return;
      closed = true;
      heartbeatCleanup?.();
      sender.dispose();
      socket.removeEventListener?.("message", onMessageHandler);
      socket.removeEventListener?.("close", onCloseHandler);
      socket.removeEventListener?.("error", onErrorHandler);
      swallowSocketCloseError(socket);
      socket.close(1000, "ACP client connection closed.");
    },
  };
}

type AcpRemoteClientHeartbeatOptions = {
  intervalMs: number;
  timeoutMs: number;
};

function startSocketHeartbeat(
  socket: AcpWebSocketLike,
  options: AcpRemoteClientHeartbeatOptions,
  onTimeout: (error: Error) => void,
): (() => void) | undefined {
  if (options.intervalMs <= 0 || options.timeoutMs <= 0) {
    return undefined;
  }
  const candidate = socket as AcpWebSocketLike & {
    off?(type: "pong", listener: () => void): void;
    on?(type: "pong", listener: () => void): void;
    ping?(callback?: (error?: Error) => void): void;
    readyState?: number;
  };
  if (typeof candidate.ping !== "function" || typeof candidate.on !== "function") {
    return undefined;
  }

  let awaitingPong = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const clearHeartbeatTimeout = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const onPong = () => {
    awaitingPong = false;
    clearHeartbeatTimeout();
  };
  const interval = setInterval(() => {
    if (!isSocketOpen(candidate)) {
      return;
    }
    if (awaitingPong) {
      return;
    }
    awaitingPong = true;
    timeout = setTimeout(() => {
      onTimeout(new Error("Relay WebSocket heartbeat timed out."));
    }, options.timeoutMs);
    timeout.unref?.();
    try {
      candidate.ping?.((error?: Error) => {
        if (error) {
          onTimeout(error);
        }
      });
    } catch (error) {
      onTimeout(error instanceof Error ? error : new Error(String(error)));
    }
  }, options.intervalMs);
  interval.unref?.();
  candidate.on("pong", onPong);

  return () => {
    clearInterval(interval);
    clearHeartbeatTimeout();
    candidate.off?.("pong", onPong);
  };
}

function forceCloseSocket(
  socket: AcpWebSocketLike,
  code: number,
  reason: string,
): void {
  const candidate = socket as AcpWebSocketLike & {
    terminate?: () => void;
  };
  try {
    if (typeof candidate.terminate === "function") {
      candidate.terminate();
      return;
    }
    swallowSocketCloseError(socket);
    socket.close(code, reason);
  } catch {
    // Nothing else to do; the caller has already settled the connection.
  }
}

function swallowSocketCloseError(socket: AcpWebSocketLike): void {
  const candidate = socket as AcpWebSocketLike & {
    on?(type: "error", listener: () => void): void;
  };
  const noop = () => {
    // ws emits an error when close() aborts a not-yet-open connection. The
    // bridge has already settled the ACP connection, so this cleanup error
    // must not escape as an uncaught process error.
  };
  socket.addEventListener("error", () => {
    noop();
  });
  candidate.on?.("error", noop);
}

function normalizeCloseEvent(event: unknown): AcpRemoteClientCloseEvent | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { code?: unknown; reason?: unknown };
  const code = typeof candidate.code === "number" ? candidate.code : undefined;
  let reason: string | undefined;
  if (typeof candidate.reason === "string") {
    reason = candidate.reason;
  } else if (candidate.reason instanceof Uint8Array) {
    reason = new TextDecoder().decode(candidate.reason);
  }
  return code === undefined && reason === undefined ? undefined : { code, reason };
}

function createBufferedSocketSender(
  socket: AcpWebSocketLike,
  isClosed: () => boolean,
  onError?: (error: Error) => void,
): {
  dispose(): void;
  send(data: string): void;
} {
  const queue: string[] = [];
  const candidate = socket as AcpWebSocketLike & {
    addEventListener?(type: "open", listener: () => void): void;
    on?(type: "open", listener: () => void): void;
    off?(type: "open", listener: () => void): void;
    readyState?: number;
    removeEventListener?(type: "open", listener: () => void): void;
  };

  const sendNow = (data: string) => {
    try {
      socket.send(data);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const flush = () => {
    if (isClosed() || !isSocketOpen(candidate)) {
      return;
    }
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        sendNow(next);
        if (isClosed()) {
          return;
        }
      }
    }
  };

  const onOpen = () => {
    flush();
  };
  if (!isSocketOpen(candidate)) {
    candidate.addEventListener?.("open", onOpen);
    candidate.on?.("open", onOpen);
  }

  return {
    dispose() {
      queue.length = 0;
      candidate.removeEventListener?.("open", onOpen);
      candidate.off?.("open", onOpen);
    },
    send(data: string) {
      if (isClosed()) {
        return;
      }
      if (isSocketOpen(candidate)) {
        sendNow(data);
        return;
      }
      queue.push(data);
    },
  };
}

function isSocketOpen(socket: { readyState?: number }): boolean {
  return typeof socket.readyState !== "number" || socket.readyState === 1;
}
