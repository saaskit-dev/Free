import { describe, expect, it } from "vitest";

import { parseFreeAuthCommand } from "./auth-bin.js";

describe("remote auth CLI", () => {
  it("parses login with defaults", () => {
    expect(parseFreeAuthCommand(["login"])).toEqual({
      ensureHost: true,
      force: false,
      name: "login",
      relayUrl: "wss://relay.saaskit.app",
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
      ensureHost: true,
      force: true,
      name: "login",
      relayUrl: "ws://127.0.0.1:8787",
    });
  });

  it("parses login without host install", () => {
    expect(parseFreeAuthCommand(["login", "--no-host"])).toEqual({
      ensureHost: false,
      force: false,
      name: "login",
      relayUrl: "wss://relay.saaskit.app",
    });
  });

  it("parses status and logout", () => {
    expect(parseFreeAuthCommand(["status"])).toEqual({ name: "status" });
    expect(parseFreeAuthCommand(["logout"])).toEqual({ name: "logout" });
  });

  it("rejects unknown auth commands", () => {
    expect(() => parseFreeAuthCommand(["whoami"])).toThrow(
      "Unknown free auth command: whoami",
    );
  });
});
