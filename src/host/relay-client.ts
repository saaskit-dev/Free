import {
  createAcpRemoteRelayUrl,
  createAcpRemoteWebSocketFactory,
  type AcpRemoteSocketFactory,
  type AcpRemoteWebSocketConstructor,
} from "../shared/index.js";
import {
  createAcpRemoteHostConnection,
  type AcpRemoteHostConnectionHandle,
  type AcpRemoteHostConnectionOptions,
} from "./relay-connection.js";
import {
  createAcpRemoteHostRegistrationHeaders,
  loadOrCreateAcpRemoteHostIdentity,
  loadOrCreateHostMachineIdentity,
  type AcpRemoteHostIdentity,
} from "./host-identity.js";
import type { AcpWebSocketLike } from "../protocol/websocket-stream.js";

export type HostMetadata = {
  agentTypes: readonly {
    command?: string;
    id?: string;
    type?: string;
    label: string;
  }[];
  displayName?: string;
  machine?: string;
  runtimeInstanceId?: string;
  workspaceRoots: readonly { path: string; label?: string }[];
};

export type AcpRemoteHostSocketFactory = AcpRemoteSocketFactory;
export type AcpRemoteHostWebSocketConstructor = AcpRemoteWebSocketConstructor;

export type ConnectAcpRemoteHostRelayOptions = Omit<
  AcpRemoteHostConnectionOptions,
  "socket"
> & {
  accountId?: string;
  accountSession?: string;
  hostId?: string;
  hostMetadata?: HostMetadata;
  identity?: AcpRemoteHostIdentity;
  identityPath?: string;
  relayUrl: string | URL;
  socketFactory: AcpRemoteSocketFactory;
};

export type ConnectedAcpRemoteHostRelay =
  AcpRemoteHostConnectionHandle & {
    headers: Record<string, string>;
    hostId: string;
    identity: AcpRemoteHostIdentity;
    socket: AcpWebSocketLike;
    url: string;
  };

export async function connectAcpRemoteHostRelay(
  options: ConnectAcpRemoteHostRelayOptions,
): Promise<ConnectedAcpRemoteHostRelay> {
  const machine = await loadOrCreateHostMachineIdentity();
  const hostId = options.hostId ?? machine.hostId;
  const accountId = options.accountId ?? "default";

  const identity =
    options.identity ??
    (options.identityPath
      ? await loadOrCreateAcpRemoteHostIdentity({
          accountId,
          hostId,
          path: options.identityPath,
        })
      : machine.identity);

  const url = createAcpRemoteHostRelayUrl({
    accountId,
    hostId,
    relayUrl: options.relayUrl,
  });
  const headers = await createAcpRemoteHostRegistrationHeaders({
    accountId,
    hostId,
    identity,
  });
  if (options.accountSession) {
    headers["Authorization"] = `Bearer ${options.accountSession}`;
  }
  if (options.hostMetadata) {
    headers["x-acp-host-metadata"] = JSON.stringify(options.hostMetadata);
  }
  const socket = options.socketFactory({
    headers,
    url,
  });
  try {
    await waitForAcpRemoteHostSocketOpen(socket);
  } catch (error) {
    closeAcpRemoteHostSocketAfterOpenFailure(socket);
    throw error;
  }
  const handle = createAcpRemoteHostConnection({
    ...options,
    hostId,
    socket,
  });
  return {
    ...handle,
    headers,
    hostId,
    identity,
    socket,
    url,
  };
}

export const createAcpRemoteHostWebSocketFactory = createAcpRemoteWebSocketFactory;

export function createAcpRemoteHostRelayUrl(input: {
  accountId: string;
  hostId: string;
  relayUrl: string | URL;
}): string {
  return createAcpRemoteRelayUrl({
    endpointPath: "/host",
    params: {
      accountId: input.accountId,
      hostId: input.hostId,
    },
    relayUrl: input.relayUrl,
  });
}

const WEBSOCKET_OPEN_READY_STATE = 1;
const DEFAULT_SOCKET_OPEN_TIMEOUT_MS = 30_000;

function waitForAcpRemoteHostSocketOpen(
  socket: AcpWebSocketLike,
  timeoutMs = DEFAULT_SOCKET_OPEN_TIMEOUT_MS,
): Promise<void> {
  const candidate = socket as AcpWebSocketLike & {
    addEventListener?(type: "open", listener: () => void): void;
    readyState?: number;
    removeEventListener?(type: "open", listener: () => void): void;
  };
  if (
    typeof candidate.readyState !== "number" ||
    candidate.readyState === WEBSOCKET_OPEN_READY_STATE
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      candidate.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("close", onClose);
      socket.removeEventListener?.("error", onError);
    };
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onOpen = () => {
      settle(resolve);
    };
    const onClose = (event?: unknown) => {
      const details = normalizeHostSocketCloseEvent(event);
      settle(() => {
        reject(
          new Error(
            `ACP remote host relay closed before opening${details ? ` (${details})` : ""}.`,
          ),
        );
      });
    };
    const onError = (event?: unknown) => {
      const details = normalizeHostSocketErrorEvent(event);
      settle(() => {
        reject(
          new Error(
            `ACP remote host relay failed before opening${details ? ` (${details})` : ""}.`,
          ),
        );
      });
    };
    const timeout = setTimeout(() => {
      settle(() => {
        reject(
          new Error(
            `ACP remote host relay did not open within ${timeoutMs}ms.`,
          ),
        );
      });
    }, timeoutMs);

    candidate.addEventListener?.("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

function closeAcpRemoteHostSocketAfterOpenFailure(
  socket: AcpWebSocketLike,
): void {
  socket.addEventListener("error", () => {
    // ws emits an error when close() aborts a not-yet-open connection. The
    // caller already receives the original open failure, so keep this cleanup
    // error from becoming an unhandled process error.
  });
  try {
    socket.close(1000, "ACP remote host relay failed before opening.");
  } catch {
    // The open failure is already being reported to the caller.
  }
}

function normalizeHostSocketCloseEvent(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { code?: unknown; reason?: unknown };
  const parts: string[] = [];
  if (typeof candidate.code === "number") {
    parts.push(`code=${candidate.code}`);
  }
  if (typeof candidate.reason === "string" && candidate.reason) {
    parts.push(`reason=${candidate.reason}`);
  } else if (candidate.reason instanceof Uint8Array && candidate.reason.length) {
    parts.push(`reason=${new TextDecoder().decode(candidate.reason)}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

function normalizeHostSocketErrorEvent(event: unknown): string | undefined {
  if (event instanceof Error) {
    return formatHostSocketErrorMessage(event.message);
  }
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const candidate = event as { error?: unknown; message?: unknown };
  if (candidate.error instanceof Error) {
    return formatHostSocketErrorMessage(candidate.error.message);
  }
  if (typeof candidate.message === "string" && candidate.message) {
    return formatHostSocketErrorMessage(candidate.message);
  }
  return undefined;
}

function formatHostSocketErrorMessage(message: string): string {
  if (/unexpected server response:\s*401/i.test(message)) {
    return "relay login expired or invalid (HTTP 401); run `free auth login --force` and restart the host";
  }
  return message;
}
