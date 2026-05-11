import { describe, expect, it } from "vitest";

import {
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
} from "../../src/protocol/index.js";
import {
  RELAY_SOCKET_ATTACHMENT_VERSION,
  clientStateStorageKey,
  deleteClientStateSnapshotFromStorage,
  isClientStateSnapshot,
  readClientStateSnapshotFromStorage,
  readRelayWebSocketAttachment,
  writeClientStateSnapshotToStorage,
} from "./relay-snapshot.js";

describe("relay snapshot model", () => {
  it("reads versioned websocket attachments and drops invalid optional fields", () => {
    expect(
      readRelayWebSocketAttachment({
        connectedAt: 123,
        connectionId: "conn-1",
        endpoint: AcpRemoteEndpointKind.Client,
        hostMetadata: { agentTypes: "invalid", workspaceRoots: [] },
        nativeClientAck: true,
        transport: "native-acp",
        version: RELAY_SOCKET_ATTACHMENT_VERSION,
      }),
    ).toEqual({
      connectedAt: 123,
      connectionId: "conn-1",
      endpoint: AcpRemoteEndpointKind.Client,
      hostMetadata: undefined,
      nativeClientAck: true,
      transport: "native-acp",
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    });
  });

  it("rejects attachments with mismatched versions or missing required fields", () => {
    expect(
      readRelayWebSocketAttachment({
        connectedAt: 123,
        connectionId: "conn-1",
        endpoint: AcpRemoteEndpointKind.Client,
        version: 0,
      }),
    ).toBeUndefined();
    expect(
      readRelayWebSocketAttachment({
        connectedAt: 123,
        endpoint: AcpRemoteEndpointKind.Client,
        version: RELAY_SOCKET_ATTACHMENT_VERSION,
      }),
    ).toBeUndefined();
  });

  it("validates client state snapshots by connection id and frame shape", () => {
    const snapshot = {
      bufferedClientPayloads: [dataFrame("conn-1", 1)],
      clientPendingFrames: [],
      completedClientResponses: [],
      connectionId: "conn-1",
      hostPendingFrames: [],
      hostQueuedFrames: [],
      hostRequests: [
        {
          id: 1,
          jsonrpc: "2.0",
          method: "session/new",
          params: {},
        },
      ],
      routeReady: true,
      seq: 1,
    };

    expect(isClientStateSnapshot(snapshot, "conn-1")).toBe(true);
    expect(isClientStateSnapshot(snapshot, "conn-2")).toBe(false);
    expect(
      isClientStateSnapshot(
        {
          ...snapshot,
          bufferedClientPayloads: [{ frameType: "bad" }],
        },
        "conn-1",
      ),
    ).toBe(false);
  });

  it("keeps the durable object storage key namespaced by connection id", () => {
    expect(clientStateStorageKey("conn-1")).toBe("client-state:conn-1");
  });

  it("round-trips valid client snapshots through durable object storage", async () => {
    const storage = new MapStorage();
    const snapshot = {
      bufferedClientPayloads: [],
      clientPendingFrames: [dataFrame("conn-1", 1)],
      completedClientResponses: [],
      connectionId: "conn-1",
      hostPendingFrames: [],
      hostQueuedFrames: [],
      hostRequests: [],
      routeReady: false,
      seq: 1,
    };

    await writeClientStateSnapshotToStorage(storage, snapshot);
    await expect(
      readClientStateSnapshotFromStorage(storage, "conn-1"),
    ).resolves.toEqual(snapshot);

    await deleteClientStateSnapshotFromStorage(storage, "conn-1");
    await expect(
      readClientStateSnapshotFromStorage(storage, "conn-1"),
    ).resolves.toBeUndefined();
  });
});

function dataFrame(connectionId: string, seq: number) {
  return {
    channelId: "channel-1",
    channelKind: AcpRemoteChannelKind.Acp,
    connectionId,
    frameType: AcpRemoteFrameType.Data,
    payload: { jsonrpc: "2.0", method: "session/update" },
    seq,
  };
}

class MapStorage {
  private readonly values = new Map<string, unknown>();

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T = unknown>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}
