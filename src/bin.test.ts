import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const cliRuntime = (process.versions as { bun?: string }).bun
  ? process.execPath
  : "bun";

describe("free cli help", () => {
  it("shows product-level status and session commands in top-level help", async () => {
    const result = await runFree("--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Default relay environment is online.");
    expect(result.stdout).toContain("free login");
    expect(result.stdout).toContain("free logout");
    expect(result.stdout).toContain("free status");
    expect(result.stdout).toContain("free session list");
    expect(result.stdout).toContain("free session close <session-id>");
    expect(result.stdout).toContain("free session close --all");
    expect(result.stdout).not.toContain("free auth");
    expect(result.stdout).not.toContain("free bridge");
    expect(result.stdout).not.toContain("free host");
    expect(result.stdout).not.toContain("free runtime");
  });

  it("routes top-level login and logout to the auth flow", async () => {
    const login = await runFree("login", "--help");
    const logout = await runFree("logout", "--unexpected");

    expect(login.exitCode).toBe(0);
    expect(login.stderr).toBe("");
    expect(login.stdout).toContain("free login [--relay-env online|local]");
    expect(logout.exitCode).toBe(1);
    expect(logout.stderr).toContain("Unknown free logout option: --unexpected");
  });

  it("shows session management commands without exposing runtime naming", async () => {
    const result = await runFree("session", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("free session list");
    expect(result.stdout).toContain("free session close <session-id>");
    expect(result.stdout).toContain("free session close --all");
    expect(result.stdout).not.toContain("runtime");
  });

  it("shows status as the combined status command", async () => {
    const result = await runFree("status", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("free status [--relay-env online|local]");
    expect(result.stdout).toContain("free status [--relay-url <ws-url>]");
    expect(result.stdout).not.toContain("auth status");
    expect(result.stdout).not.toContain("runtime status");
  });

  it("exposes host as the service management command", async () => {
    const result = await runFree("host", "--help");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("free host start");
    expect(result.stdout).toContain("free host run");
    expect(result.stdout).toContain("free host stop");
    expect(result.stdout).not.toContain("free host status");
    expect(result.stdout).not.toContain("free host install");
    expect(result.stdout).not.toContain("free host uninstall");
    expect(result.stdout).not.toContain("free host restart");
  });

  it("does not expose duplicate runtime commands", async () => {
    const runtime = await runFree("runtime", "--help");
    const runtimeService = await runFree("runtime-service", "run");

    expect(runtime.exitCode).toBe(1);
    expect(runtime.stderr).toContain("Unknown free command: runtime");
    expect(runtimeService.exitCode).toBe(1);
    expect(runtimeService.stderr).toContain("Unknown free command: runtime-service");
  });

  it("does not expose the redundant host restart command", async () => {
    const restart = await runFree("host", "restart");
    const install = await runFree("host", "install");
    const status = await runFree("host", "status");
    const uninstall = await runFree("host", "uninstall");

    expect(restart.exitCode).toBe(1);
    expect(restart.stderr).toContain("Unknown host command: restart");
    expect(install.exitCode).toBe(1);
    expect(install.stderr).toContain("Unknown host command: install");
    expect(status.exitCode).toBe(1);
    expect(status.stderr).toContain("Unknown host command: status");
    expect(uninstall.exitCode).toBe(1);
    expect(uninstall.stderr).toContain("Unknown host command: uninstall");
  });
});

function runFree(...args: string[]): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(cliRuntime, ["src/bin.ts", ...args], {
      cwd: new URL("..", import.meta.url),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}
