import {
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  type AcpRemoteConnectionProof,
  type AcpRemoteDataFrame,
} from "../../src/protocol/index.js";
import {
  type AcpRelayClientStateSnapshot,
  type AcpRelayClientTransport,
  type HostMetadata,
} from "./relay-core.js";

export const RELAY_SOCKET_ATTACHMENT_VERSION = 1;

const RELAY_CLIENT_STATE_STORAGE_PREFIX = "client-state:";

export type RelayWebSocketAttachment = {
  accountId?: string;
  authUrl?: string;
  routeReady?: boolean;
  clientId?: string;
  connectedAt: number;
  connectionId: string;
  hostId?: string;
  hostMetadata?: HostMetadata;
  endpoint: AcpRemoteEndpointKind;
  nativeClientAck?: boolean;
  connectionProof?: AcpRemoteConnectionProof;
  connectionProofs?: readonly AcpRemoteConnectionProof[];
  transport?: AcpRelayClientTransport;
  version: typeof RELAY_SOCKET_ATTACHMENT_VERSION;
};

export function clientStateStorageKey(connectionId: string): string {
  return `${RELAY_CLIENT_STATE_STORAGE_PREFIX}${connectionId}`;
}

export async function readClientStateSnapshotFromStorage(
  storage: RelaySnapshotStorage,
  connectionId: string,
): Promise<AcpRelayClientStateSnapshot | undefined> {
  if (typeof storage.get !== "function") {
    return undefined;
  }
  const value = await storage.get(clientStateStorageKey(connectionId));
  return isClientStateSnapshot(value, connectionId) ? value : undefined;
}

export async function writeClientStateSnapshotToStorage(
  storage: RelaySnapshotStorage,
  snapshot: AcpRelayClientStateSnapshot,
): Promise<void> {
  if (typeof storage.put !== "function") {
    return;
  }
  await storage.put(clientStateStorageKey(snapshot.connectionId), snapshot);
}

export async function deleteClientStateSnapshotFromStorage(
  storage: RelaySnapshotStorage,
  connectionId: string,
): Promise<void> {
  if (typeof storage.delete !== "function") {
    return;
  }
  await storage.delete(clientStateStorageKey(connectionId));
}

export function readRelayWebSocketAttachment(
  value: unknown,
): RelayWebSocketAttachment | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (record.version !== RELAY_SOCKET_ATTACHMENT_VERSION) {
    return undefined;
  }
  if (
    record.endpoint !== AcpRemoteEndpointKind.Client &&
    record.endpoint !== AcpRemoteEndpointKind.Host
  ) {
    return undefined;
  }
  const connectionId =
    typeof record.connectionId === "string" ? record.connectionId : undefined;
  const connectedAt =
    typeof record.connectedAt === "number" ? record.connectedAt : undefined;
  if (!connectionId || connectedAt === undefined) {
    return undefined;
  }
  return {
    accountId: readAttachmentString(record.accountId),
    authUrl: readAttachmentString(record.authUrl),
    routeReady:
      typeof record.routeReady === "boolean" ? record.routeReady : undefined,
    clientId: readAttachmentString(record.clientId),
    connectedAt,
    connectionId,
    hostId: readAttachmentString(record.hostId),
    hostMetadata: isHostMetadata(record.hostMetadata)
      ? record.hostMetadata
      : undefined,
    endpoint: record.endpoint,
    nativeClientAck:
      typeof record.nativeClientAck === "boolean"
        ? record.nativeClientAck
        : undefined,
    connectionProof: isConnectionProof(record.connectionProof)
      ? record.connectionProof
      : undefined,
    connectionProofs: Array.isArray(record.connectionProofs)
      ? record.connectionProofs.filter(isConnectionProof)
      : undefined,
    transport: isRelayClientTransport(record.transport)
      ? record.transport
      : undefined,
    version: RELAY_SOCKET_ATTACHMENT_VERSION,
  };
}

export function isClientStateSnapshot(
  value: unknown,
  connectionId: string,
): value is AcpRelayClientStateSnapshot {
  const record = asRecord(value);
  if (!record || record.connectionId !== connectionId) {
    return false;
  }
  return (
    typeof record.routeReady === "boolean" &&
    Array.isArray(record.bufferedClientPayloads) &&
    record.bufferedClientPayloads.every(isDataFrame) &&
    Array.isArray(record.clientPendingFrames) &&
    record.clientPendingFrames.every(isDataFrame) &&
    Array.isArray(record.hostPendingFrames) &&
    record.hostPendingFrames.every(isDataFrame) &&
    Array.isArray(record.hostQueuedFrames) &&
    record.hostQueuedFrames.every(isDataFrame) &&
    Array.isArray(record.hostRequests) &&
    record.hostRequests.every(isJsonRpcRequestRecord) &&
    Number.isSafeInteger(record.seq) &&
    (record.hostId === undefined || typeof record.hostId === "string") &&
    (record.lastHostSeq === undefined ||
      Number.isSafeInteger(record.lastHostSeq)) &&
    (record.connectionProof === undefined ||
      isConnectionProof(record.connectionProof)) &&
    (record.connectionProofs === undefined ||
      (Array.isArray(record.connectionProofs) &&
        record.connectionProofs.every(isConnectionProof))) &&
    (record.lastAuthorization === undefined ||
      isRelayAuthorizationSelection(record.lastAuthorization))
  );
}

function readAttachmentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRelayClientTransport(
  value: unknown,
): value is AcpRelayClientTransport {
  return value === "native-acp";
}

function isHostMetadata(value: unknown): value is HostMetadata {
  const record = asRecord(value);
  if (
    !record ||
    !Array.isArray(record.agentTypes) ||
    !Array.isArray(record.workspaceRoots)
  ) {
    return false;
  }
  return (
    record.agentTypes.every((entry) => {
      const agent = asRecord(entry);
      return (
        agent !== undefined &&
        typeof agent.label === "string" &&
        (agent.command === undefined || typeof agent.command === "string") &&
        (agent.id === undefined || typeof agent.id === "string") &&
        (agent.type === undefined || typeof agent.type === "string")
      );
    }) &&
    record.workspaceRoots.every((entry) => {
      const root = asRecord(entry);
      return (
        root !== undefined &&
        typeof root.path === "string" &&
        (root.label === undefined || typeof root.label === "string")
      );
    }) &&
    (record.machine === undefined || typeof record.machine === "string") &&
    (record.runtimeInstanceId === undefined ||
      typeof record.runtimeInstanceId === "string")
  );
}

function isConnectionProof(
  value: unknown,
): value is AcpRemoteConnectionProof {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.clientId === "string" &&
    typeof record.connectionId === "string" &&
    typeof record.hostId === "string" &&
    typeof record.nonce === "string" &&
    typeof record.signature === "string" &&
    typeof record.timestamp === "string" &&
    asRecord(record.accountSession) !== undefined
  );
}

function isDataFrame(value: unknown): value is AcpRemoteDataFrame {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.frameType === AcpRemoteFrameType.Data &&
    typeof record.connectionId === "string" &&
    typeof record.channelId === "string" &&
    Object.values(AcpRemoteChannelKind).includes(
      record.channelKind as AcpRemoteChannelKind,
    ) &&
    Number.isSafeInteger(record.seq)
  );
}

function isJsonRpcRequestRecord(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    (typeof record.id === "string" || typeof record.id === "number")
  );
}

function isRelayAuthorizationSelection(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.hostId === "string" &&
    (record.workspaceRoots === undefined ||
      (Array.isArray(record.workspaceRoots) &&
        record.workspaceRoots.every((entry) => typeof entry === "string"))) &&
    (record.agent === undefined || asRecord(record.agent) !== undefined)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

type RelaySnapshotStorage = {
  delete?(key: string): Promise<boolean>;
  get?<T = unknown>(key: string): Promise<T | undefined>;
  put?<T = unknown>(key: string, value: T): Promise<void>;
};
