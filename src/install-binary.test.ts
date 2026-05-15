import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("binary installer", () => {
  it("downloads the matching platform binary into the install directory", async () => {
    const root = join(tmpdir(), `free-binary-install-${randomUUID()}`);
    const releaseDir = join(root, "release");
    const installDir = join(root, "bin");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      join(releaseDir, "free-darwin-arm64"),
      "#!/bin/sh\nprintf 'free fake\\n'\n",
      { mode: 0o755 },
    );

    try {
      await execFileAsync(
        "bash",
        [
          "scripts/install-binary.sh",
          "--no-login",
          "--install-dir",
          installDir,
          "--base-url",
          `file://${releaseDir}`,
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            FREE_INSTALL_ARCH: "arm64",
            FREE_INSTALL_OS: "darwin",
            HOME: join(root, "home"),
          },
        },
      );

      const installed = join(installDir, "free");
      await expect(readFile(installed, "utf8")).resolves.toContain("free fake");
      expect((await stat(installed)).mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("runs auth login with the requested relay environment", async () => {
    const root = join(tmpdir(), `free-binary-login-${randomUUID()}`);
    const releaseDir = join(root, "release");
    const installDir = join(root, "bin");
    const argsLog = join(root, "args.log");
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
      join(releaseDir, "free-linux-x64"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$FREE_FAKE_ARGS_LOG\"",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      await execFileAsync(
        "bash",
        [
          "scripts/install-binary.sh",
          "--install-dir",
          installDir,
          "--base-url",
          `file://${releaseDir}`,
          "--relay-env",
          "local",
          "--force-login",
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            FREE_FAKE_ARGS_LOG: argsLog,
            FREE_INSTALL_ARCH: "x86_64",
            FREE_INSTALL_OS: "linux",
            HOME: join(root, "home"),
          },
        },
      );

      await expect(readFile(argsLog, "utf8")).resolves.toBe(
        "auth login --relay-env local --force\n",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
