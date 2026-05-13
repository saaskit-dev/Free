import { describe, expect, it } from "vitest";

import {
  ACP_REMOTE_HOST_ACCOUNT_ID_ENV_VAR,
  ACP_REMOTE_HOST_HOST_ID_ENV_VAR,
  ACP_REMOTE_HOST_IDENTITY_PATH_ENV_VAR,
  ACP_REMOTE_HOST_RELAY_ENV_ENV_VAR,
  ACP_REMOTE_HOST_RELAY_URL_ENV_VAR,
  parseAcpRemoteHostCliConfig,
} from "./host-cli.js";

describe("remote host CLI connector", () => {
  it("parses relay connection config from CLI args", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: [
          "--account-id",
          "acct-1",
          "--host-id",
          "host-1",
          "--relay-url",
          "wss://relay.test",
          "--identity-path",
          "/tmp/identity.json",
        ],
        env: {},
      }),
    ).toEqual({
      accountId: "acct-1",
      hostId: "host-1",
      forceLogin: undefined,
      identityPath: "/tmp/identity.json",
      relayUrl: "wss://relay.test",
    });
  });

  it("parses relay connection config from environment", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: [],
        env: {
          [ACP_REMOTE_HOST_ACCOUNT_ID_ENV_VAR]: "acct-1",
          [ACP_REMOTE_HOST_HOST_ID_ENV_VAR]: "host-1",
          [ACP_REMOTE_HOST_IDENTITY_PATH_ENV_VAR]: "/tmp/identity.json",
          [ACP_REMOTE_HOST_RELAY_URL_ENV_VAR]: "wss://relay.test",
        },
      }),
    ).toEqual({
      accountId: "acct-1",
      hostId: "host-1",
      forceLogin: undefined,
      identityPath: "/tmp/identity.json",
      relayUrl: "wss://relay.test",
    });
  });

  it("parses relay environment from CLI args and environment", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: ["--relay-env", "local"],
        env: {
          [ACP_REMOTE_HOST_RELAY_URL_ENV_VAR]: "wss://relay.env.test",
        },
      }),
    ).toMatchObject({
      relayUrl: "ws://127.0.0.1:8791",
    });
    expect(
      parseAcpRemoteHostCliConfig({
        argv: [],
        env: {
          [ACP_REMOTE_HOST_RELAY_ENV_ENV_VAR]: "local",
        },
      }),
    ).toMatchObject({
      relayUrl: "ws://127.0.0.1:8791",
    });
  });

  it("rejects ambiguous relay URL and environment options", () => {
    expect(() =>
      parseAcpRemoteHostCliConfig({
        argv: ["--relay-url", "wss://relay.test", "--relay-env", "local"],
        env: {},
      }),
    ).toThrow("Use either --relay-url or --relay-env, not both.");
  });

  it("defaults accountId and hostId to undefined", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: ["--relay-url", "wss://relay.test"],
        env: {},
      }),
    ).toEqual({
      accountId: undefined,
      hostId: undefined,
      forceLogin: undefined,
      identityPath: undefined,
      relayUrl: "wss://relay.test",
    });
  });

  it("parses force-login without requiring a value", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: ["--force-login"],
        env: {},
      }),
    ).toMatchObject({
      forceLogin: true,
      relayUrl: "wss://free-relay.saaskit.app",
    });
  });

  it("ignores service install options that are not relay connection config", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: [
          "--system",
          "--user",
          "dev",
          "--home-dir",
          "/Users/dev",
          "--workspace-root",
          "/Users/dev",
        ],
        env: {},
      }),
    ).toMatchObject({
      relayUrl: "wss://free-relay.saaskit.app",
    });
  });

  it("defaults relay URL to the hosted relay", () => {
    expect(
      parseAcpRemoteHostCliConfig({
        argv: [],
        env: {},
      }),
    ).toMatchObject({
      relayUrl: "wss://free-relay.saaskit.app",
    });
  });

  it("rejects unknown relay connection config", () => {
    expect(() =>
      parseAcpRemoteHostCliConfig({
        argv: ["--unknown"],
        env: {},
      }),
    ).toThrow("Unknown remote host option: --unknown");
  });
});
