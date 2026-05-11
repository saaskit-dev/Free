import {
  createAcpRemoteRelayUrl,
  type AcpRemoteSocketFactory,
} from "../shared/index.js";
import {
  createAcpRemoteClientConnection,
} from "./relay-connection.js";
import {
  encodeAcpRemoteConnectionProof,
  type AcpRemoteConnectionProof,
} from "../protocol/account-session.js";

export type ConnectAcpRemoteClientRelayOptions = {
  accountSession?: string;
  clientId?: string;
  connectionId?: string;
  connectionProof?: AcpRemoteConnectionProof;
  hostId?: string;
  nativeClientAck?: boolean;
  relayUrl: string | URL;
  socketFactory: AcpRemoteSocketFactory;
  onMessage: (message: string) => void;
  onClose?: (event?: AcpRemoteClientCloseEvent) => void;
  onError?: (error: Error) => void;
};

export type AcpRemoteClientCloseEvent = {
  code?: number;
  reason?: string;
};

export type ConnectedAcpRemoteClientRelay = {
  close(): void;
  send(message: string): void;
  connectionId: string;
};

export function createAcpRemoteClientRelayUrl(input: {
  clientId: string;
  connectionId: string;
  hostId?: string;
  nativeClientAck?: boolean;
  relayUrl: string | URL;
}): string {
  const params: Record<string, string> = {
    clientId: input.clientId,
    connectionId: input.connectionId,
  };
  if (input.hostId) {
    params.hostId = input.hostId;
  }
  if (input.nativeClientAck) {
    params.nativeClientAck = "1";
  }
  return createAcpRemoteRelayUrl({
    endpointPath: "/acp",
    params,
    relayUrl: input.relayUrl,
  });
}

export function connectAcpRemoteClientRelay(
  options: ConnectAcpRemoteClientRelayOptions,
): ConnectedAcpRemoteClientRelay {
  const clientId = options.clientId ?? "editor-bridge";
  const connectionId = options.connectionId ?? crypto.randomUUID();

  const url = createAcpRemoteClientRelayUrl({
    clientId,
    connectionId,
    hostId: options.hostId,
    nativeClientAck: options.nativeClientAck,
    relayUrl: options.relayUrl,
  });

  const headers: Record<string, string> = {};
  if (options.accountSession) {
    headers["Authorization"] = `Bearer ${options.accountSession}`;
  }
  if (options.connectionProof) {
    headers["x-acp-connection-proof"] = encodeAcpRemoteConnectionProof(
      options.connectionProof,
    );
  }
  const socket = options.socketFactory({
    headers,
    url,
  });

  const handle = createAcpRemoteClientConnection({
    socket,
    onMessage: options.onMessage,
    onClose: options.onClose,
    onError: options.onError,
  });

  return {
    close() { handle.close(); },
    send(message: string) { handle.send(message); },
    connectionId,
  };
}
