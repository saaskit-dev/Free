import { describe, expect, it } from "vitest";

import type { AcpRemoteAccountSessionCredential } from "../protocol/account-session.js";
import { decodeAcpRemoteAccountSession } from "../protocol/account-session.js";
import {
  createBridgeAutoAuthorizeOptions,
  resolveBridgeHostId,
  waitForBridgeHostSelection,
} from "./relay-bridge.js";

const credential: AcpRemoteAccountSessionCredential = {
  accountSession: {
    accountId: "account-1",
    alg: "Ed25519",
    expiresAt: "2099-01-01T00:00:00.000Z",
    issuedAt: "2026-01-01T00:00:00.000Z",
    kid: "kid-1",
    principalId: "client-1",
    principalType: "client",
    publicKey: "public-key",
    sessionId: "session-1",
    signature: "signature",
  },
  privateKey: "private-key",
};

describe("Free relay bridge host discovery recovery", () => {
  it("passes the cached account session and selected host into bridge auto authorization", () => {
    const autoAuthorize = createBridgeAutoAuthorizeOptions({
      accountCredential: credential,
      hostId: "host-1",
    });

    expect(autoAuthorize.hostId).toBe("host-1");
    expect(decodeAcpRemoteAccountSession(autoAuthorize.accountSession))
      .toMatchObject({
        accountId: "account-1",
        principalId: "client-1",
        sessionId: "session-1",
      });
  });

  it("waits for a host to appear instead of exiting during a transient host restart", async () => {
    const delays: number[] = [];
    const logs: string[] = [];
    let attempts = 0;

    const selection = await waitForBridgeHostSelection({
      accountCredential: credential,
      log(message) {
        logs.push(message);
      },
      maxAttempts: 4,
      relayUrl: "ws://127.0.0.1:8791",
      resolveHostId: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(
            "No online Free host found for local relay (ws://127.0.0.1:8791).",
          );
        }
        return {
          hosts: [{ hostId: "host-1", online: true }],
          primaryHostId: "host-1",
        };
      },
      retryDelay: (attempt) => attempt * 100,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(selection.primaryHostId).toBe("host-1");
    expect(attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("retrying in 100ms (1/4)");
  });

  it("selects a registered host even when it is not currently connected", async () => {
    const restoreFetch = stubFetch(async () => new Response(JSON.stringify({
      hosts: [
        {
          hostId: "host-offline",
          metadata: { machine: "remote-machine" },
          online: false,
        },
      ],
    }), { status: 200 }));
    try {
      const selection = await resolveBridgeHostId({
        accountCredential: credential,
        relayUrl: "ws://127.0.0.1:8791",
      });

      expect(selection).toEqual({
        hosts: [
          {
            hostId: "host-offline",
            metadata: { machine: "remote-machine" },
            online: false,
          },
        ],
        primaryHostId: "host-offline",
      });
    } finally {
      restoreFetch();
    }
  });

  it("keeps authorization failures fatal instead of hiding invalid credentials behind retries", async () => {
    const delays: number[] = [];

    await expect(
      waitForBridgeHostSelection({
        accountCredential: credential,
        maxAttempts: 4,
        relayUrl: "ws://127.0.0.1:8791",
        resolveHostId: async () => {
          throw new Error("Free host discovery failed: 401 Unauthorized");
        },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toThrow("Free host discovery failed: 401 Unauthorized");
    expect(delays).toEqual([]);
  });
});

function stubFetch(fetchMock: typeof fetch): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchMock;
  return () => {
    globalThis.fetch = previous;
  };
}
