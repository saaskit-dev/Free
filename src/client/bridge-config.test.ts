import { describe, expect, it } from "vitest";

import {
  createFreeBridgeStdioConfig,
  createFreeBridgeZedConfig,
  parseFreeBridgeConfigArgs,
  parseFreeBridgeRunArgs,
} from "./bridge-config.js";

describe("Free bridge config", () => {
  it("creates generic stdio client config", () => {
    expect(
      createFreeBridgeStdioConfig({
        args: ["bridge", "run"],
        command: "/usr/local/bin/free",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      args: ["bridge", "run", "--relay-url", "wss://relay.example.com"],
      command: "/usr/local/bin/free",
    });
  });

  it("omits relay configuration when using the built-in hosted relay default", () => {
    expect(createFreeBridgeStdioConfig({})).toEqual({
      args: ["bridge", "run"],
      command: expect.any(String),
    });
    expect(parseFreeBridgeConfigArgs([])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      format: "generic",
      relayUrl: undefined,
    });
  });

  it("parses config command arguments", () => {
    expect(
      parseFreeBridgeConfigArgs([
        "--relay-url",
        "wss://relay.example.com",
        "--command",
        "/opt/bin/free",
      ]),
    ).toEqual({
      args: ["bridge", "run"],
      command: "/opt/bin/free",
      format: "generic",
      relayUrl: "wss://relay.example.com",
    });
  });

  it("parses local relay environment for generated configs", () => {
    expect(parseFreeBridgeConfigArgs(["--relay-env", "local"])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      format: "generic",
      relayUrl: "ws://127.0.0.1:8791",
    });
    expect(parseFreeBridgeConfigArgs(["--relay-env", "online"])).toEqual({
      args: ["bridge", "run"],
      command: undefined,
      format: "generic",
      relayUrl: undefined,
    });
  });

  it("creates Zed custom agent config", () => {
    expect(
      createFreeBridgeZedConfig({
        args: ["bridge", "run"],
        command: "/opt/bin/free",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      type: "custom",
      args: ["bridge", "run", "--relay-url", "wss://relay.example.com"],
      command: "/opt/bin/free",
    });
  });

  it("supports legacy command-only config", () => {
    expect(
      parseFreeBridgeConfigArgs([
        "--legacy-command",
        "/opt/bin/free",
      ]),
    ).toEqual({
      args: undefined,
      command: "/opt/bin/free",
      format: "generic",
      relayUrl: undefined,
    });
  });

  it("keeps relay url in env when legacy command configs cannot pass args", () => {
    expect(
      createFreeBridgeStdioConfig({
        command: "/opt/bin/free",
        relayUrl: "wss://relay.example.com",
      }),
    ).toEqual({
      command: "/opt/bin/free",
      env: {
        FREE_RELAY_URL: "wss://relay.example.com",
      },
    });
  });

  it("parses bridge run relay url from args, env, or the built-in default", () => {
    expect(
      parseFreeBridgeRunArgs({
        argv: ["--relay-url", "wss://relay.arg.example.com"],
        env: { FREE_RELAY_URL: "wss://relay.env.example.com" },
      }),
    ).toEqual({ relayUrl: "wss://relay.arg.example.com" });
    expect(
      parseFreeBridgeRunArgs({
        argv: ["--relay-env", "local"],
        env: { FREE_RELAY_URL: "wss://relay.env.example.com" },
      }),
    ).toEqual({ relayUrl: "ws://127.0.0.1:8791" });
    expect(
      parseFreeBridgeRunArgs({
        argv: [],
        env: { FREE_RELAY_URL: "wss://relay.env.example.com" },
      }),
    ).toEqual({ relayUrl: "wss://relay.env.example.com" });
    expect(parseFreeBridgeRunArgs({ argv: [], env: {} })).toEqual({
      relayUrl: "wss://free-relay.saaskit.app",
    });
  });

  it("parses Zed and all output formats", () => {
    expect(parseFreeBridgeConfigArgs(["--zed"])).toMatchObject({
      format: "zed",
    });
    expect(parseFreeBridgeConfigArgs(["--all"])).toMatchObject({
      format: "all",
    });
    expect(parseFreeBridgeConfigArgs(["--format", "all"])).toMatchObject({
      format: "all",
    });
  });

  it("rejects unknown output formats", () => {
    expect(() => parseFreeBridgeConfigArgs(["--format", "zed-json"])).toThrow(
      "Invalid --format value: zed-json. Expected generic, zed, or all.",
    );
  });

  it("rejects incomplete config command arguments", () => {
    expect(() => parseFreeBridgeConfigArgs(["--relay-url"])).toThrow(
      "Missing value for --relay-url.",
    );
    expect(() =>
      parseFreeBridgeConfigArgs([
        "--relay-url",
        "wss://relay.example.com",
        "--relay-env",
        "local",
      ]),
    ).toThrow("Use either --relay-url or --relay-env, not both.");
    expect(() => parseFreeBridgeRunArgs({ argv: ["--relay-url"] })).toThrow(
      "Missing value for --relay-url.",
    );
  });
});
