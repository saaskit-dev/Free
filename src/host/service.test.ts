import { describe, expect, it } from "vitest";

import {
  acpRemoteHostServiceMatchesConfig,
  acpRemoteHostServiceUsesExecutable,
  createMacOSLaunchAgentPlist,
  launchHostPlistPath,
  parseMacOSLaunchAgentRunningState,
} from "./service.js";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("remote host user service", () => {
  it("creates a launchd plist that runs host with self-healing settings", () => {
    const plist = createMacOSLaunchAgentPlist({
      hostBinPath: "/usr/local/bin/free",
      hostId: "dev-mac",
      env: {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      homeDir: "/Users/dev",
      label: "dev.saaskit.free.host",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      standardErrorPath: "/Users/dev/.free/logs/host.err.log",
      standardOutPath: "/Users/dev/.free/logs/host.out.log",
      workspaceRoots: ["/Users/dev/acp-runtime", "/Users/dev/work"],
    });

    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).not.toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain("<string>--relay-url</string>");
    expect(plist).toContain("<string>wss://relay.example.com</string>");
    expect(plist).toContain("<string>--host-id</string>");
    expect(plist).toContain("<string>dev-mac</string>");
    expect(plist).toContain("<string>/Users/dev/acp-runtime</string>");
    expect(plist).toContain("<string>/Users/dev/work</string>");
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(
      "<string>/Users/dev/.n/bin:/Users/dev/.local/bin:/Users/dev/Library/pnpm:" +
      "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>",
    );
  });

  it("does not persist account login state in launchd environment", () => {
    const plist = createMacOSLaunchAgentPlist({
      hostBinPath: "/usr/local/bin/free",
      env: {
        ACP_REMOTE_HOST_ACCOUNT_ID: "acct-1",
        ACP_REMOTE_HOST_ACCOUNT_SESSION: "session-token",
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      },
      label: "dev.saaskit.free.host",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      standardErrorPath: "/Users/dev/.free/logs/host.err.log",
      standardOutPath: "/Users/dev/.free/logs/host.out.log",
      workspaceRoots: ["/Users/dev"],
    });

    expect(plist).not.toContain("ACP_REMOTE_HOST_ACCOUNT_ID");
    expect(plist).not.toContain("ACP_REMOTE_HOST_ACCOUNT_SESSION");
    expect(plist).not.toContain("session-token");
  });

  it("creates a system launchd plist that runs as the target user", () => {
    const plist = createMacOSLaunchAgentPlist({
      hostBinPath: "/usr/local/bin/free",
      homeDir: "/Users/dev",
      label: "dev.saaskit.free.host",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      scope: "system",
      standardErrorPath: "/Users/dev/.free/logs/host.err.log",
      standardOutPath: "/Users/dev/.free/logs/host.out.log",
      userName: "dev",
      workspaceRoots: ["/Users/dev"],
    });

    expect(launchHostPlistPath()).toBe(
      "/Library/LaunchDaemons/dev.saaskit.free.host.plist",
    );
    expect(plist).toContain("<key>UserName</key>");
    expect(plist).toContain("<string>dev</string>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("creates a system launchd plist without explicit user override", () => {
    const plist = createMacOSLaunchAgentPlist({
      hostBinPath: "/usr/local/bin/free",
      homeDir: "/Users/dev",
      label: "dev.saaskit.free.host",
      nodePath: "/usr/local/bin/node",
      relayUrl: "wss://relay.example.com",
      scope: "system",
      standardErrorPath: "/Users/dev/.free/logs/host.err.log",
      standardOutPath: "/Users/dev/.free/logs/host.out.log",
      workspaceRoots: ["/Users/dev"],
    });

    expect(plist).not.toContain("<key>UserName</key>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/dev</string>");
  });

  it("escapes plist values", () => {
    const plist = createMacOSLaunchAgentPlist({
      hostBinPath: "/tmp/acp-runtime",
      label: "dev.saaskit.free.host",
      nodePath: "/tmp/node",
      relayUrl: "wss://relay.example.com/?a=<b>&c=\"d\"",
      standardErrorPath: "/tmp/err.log",
      standardOutPath: "/tmp/out.log",
      workspaceRoots: ["/tmp/project's"],
    });

    expect(plist).toContain("a=&lt;b&gt;&amp;c=&quot;d&quot;");
    expect(plist).toContain("/tmp/project&apos;s");
  });

  it("parses actual launchd running state", () => {
    expect(
      parseMacOSLaunchAgentRunningState(`
gui/501/dev.saaskit.free.host = {
  state = running
}
`),
    ).toBe(true);
    expect(
      parseMacOSLaunchAgentRunningState(`
gui/501/dev.saaskit.free.host = {
  state = not running
}
`),
    ).toBe(false);
  });

  it("detects whether an installed plist uses the current host executable", async () => {
    const homeDir = join(tmpdir(), `free-service-${randomUUID()}`);
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "dev.saaskit.free.host.plist",
    );
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(
      plistPath,
      createMacOSLaunchAgentPlist({
        hostBinPath: "/opt/free/dist/host/bin.js",
        homeDir,
        label: "dev.saaskit.free.host",
        nodePath: "/opt/node",
        relayUrl: "wss://relay.example.com",
        standardErrorPath: join(homeDir, ".free", "logs", "host.err.log"),
        standardOutPath: join(homeDir, ".free", "logs", "host.out.log"),
        workspaceRoots: [homeDir],
      }),
      "utf8",
    );

    await expect(
      acpRemoteHostServiceUsesExecutable({
        homeDir,
        hostBinPath: "/opt/free/dist/host/bin.js",
        nodePath: "/opt/node",
      }),
    ).resolves.toBe(true);
    await expect(
      acpRemoteHostServiceUsesExecutable({
        homeDir,
        hostBinPath: "/old/free/dist/host/bin.js",
        nodePath: "/opt/node",
      }),
    ).resolves.toBe(false);

    await rm(homeDir, { force: true, recursive: true });
  });

  it("detects whether an installed plist matches the selected relay and workspace roots", async () => {
    const homeDir = join(tmpdir(), `free-service-${randomUUID()}`);
    const plistPath = join(
      homeDir,
      "Library",
      "LaunchAgents",
      "dev.saaskit.free.host.plist",
    );
    await mkdir(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(
      plistPath,
      createMacOSLaunchAgentPlist({
        hostBinPath: "/opt/free/dist/host/bin.js",
        homeDir,
        label: "dev.saaskit.free.host",
        nodePath: "/opt/node",
        relayUrl: "ws://127.0.0.1:8791",
        standardErrorPath: join(homeDir, ".free", "logs", "host.err.log"),
        standardOutPath: join(homeDir, ".free", "logs", "host.out.log"),
        workspaceRoots: ["/Users/dev"],
      }),
      "utf8",
    );

    await expect(
      acpRemoteHostServiceMatchesConfig({
        homeDir,
        hostBinPath: "/opt/free/dist/host/bin.js",
        nodePath: "/opt/node",
        relayUrl: "ws://127.0.0.1:8791",
        workspaceRoots: ["/Users/dev"],
      }),
    ).resolves.toBe(true);
    await expect(
      acpRemoteHostServiceMatchesConfig({
        homeDir,
        hostBinPath: "/opt/free/dist/host/bin.js",
        nodePath: "/opt/node",
        relayUrl: "wss://free-relay.saaskit.app",
        workspaceRoots: ["/Users/dev"],
      }),
    ).resolves.toBe(false);

    await rm(homeDir, { force: true, recursive: true });
  });
});
