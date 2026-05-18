import { describe, expect, it } from "vitest";

import { parseFreeAuthCommand } from "./auth-bin.js";

describe("remote auth CLI", () => {
  it("parses login with defaults", () => {
    expect(parseFreeAuthCommand(["login"])).toEqual({
      force: false,
      name: "login",
      relayUrl: "wss://free-relay.saaskit.app",
    });
  });

  it("parses login relay URL and force refresh", () => {
    expect(
      parseFreeAuthCommand([
        "login",
        "--relay-url",
        "ws://127.0.0.1:8787",
        "--force",
      ]),
    ).toEqual({
      force: true,
      name: "login",
      relayUrl: "ws://127.0.0.1:8787",
    });
  });

  it("parses login relay environment", () => {
    expect(parseFreeAuthCommand(["login", "--relay-env", "local"])).toEqual({
      force: false,
      name: "login",
      relayUrl: "ws://127.0.0.1:8791",
    });
  });

  it("parses status and logout", () => {
    expect(parseFreeAuthCommand(["status"])).toEqual({
      name: "status",
      relayUrl: "wss://free-relay.saaskit.app",
    });
    expect(parseFreeAuthCommand(["status", "--relay-env", "local"])).toEqual({
      name: "status",
      relayUrl: "ws://127.0.0.1:8791",
    });
    expect(parseFreeAuthCommand(["logout"])).toEqual({
      name: "logout",
      relayUrl: "wss://free-relay.saaskit.app",
    });
    expect(parseFreeAuthCommand(["logout", "--relay-env", "local"])).toEqual({
      name: "logout",
      relayUrl: "ws://127.0.0.1:8791",
    });
  });

  it("rejects unknown auth commands", () => {
    expect(() => parseFreeAuthCommand(["whoami"])).toThrow(
      "Unknown free auth command: whoami",
    );
  });
});
