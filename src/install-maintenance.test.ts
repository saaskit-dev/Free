import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("install maintenance", () => {
  it("keeps isolated install smoke from rewriting user launchers and launchd", async () => {
    const root = join(tmpdir(), `free-install-maintenance-${randomUUID()}`);
    const prefix = join(root, "prefix");
    const home = join(root, "home");
    const packageRoot = join(prefix, "lib", "node_modules", "free");
    const installedBin = join(prefix, "bin", "free");
    const oldPackageRoot = join(root, "old-free");
    const oldInstalledBin = join(oldPackageRoot, "dist", "bin.js");
    const shadowBin = join(home, ".n", "bin", "free");
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "app.saaskit.free.plist",
    );
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/old/node</string>
    <string>${oldPackageRoot}/dist/host/bin.js</string>
  </array>
</dict>
</plist>`;

    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await mkdir(join(oldPackageRoot, "dist"), { recursive: true });
    await mkdir(join(home, ".n", "bin"), { recursive: true });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "bin.js"), "#!/usr/bin/env node\n", {
      mode: 0o644,
    });
    await writeFile(oldInstalledBin, "#!/usr/bin/env node\n", { mode: 0o755 });
    await symlink(join(packageRoot, "dist", "bin.js"), installedBin);
    await symlink(oldInstalledBin, shadowBin);
    await writeFile(plistPath, plist, "utf8");

    try {
      await execFileAsync(process.execPath, ["scripts/install-maintenance.cjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FREE_INSTALL_ISOLATED: "1",
          HOME: home,
          npm_config_prefix: prefix,
          PATH: join(prefix, "bin"),
        },
      });

      await expect(readlink(shadowBin)).resolves.toBe(oldInstalledBin);
      await expect(readFile(plistPath, "utf8")).resolves.toBe(plist);
      expect((await lstat(shadowBin)).isSymbolicLink()).toBe(true);
      const installedStat = await stat(join(packageRoot, "dist", "bin.js"));
      expect(installedStat.mode & 0o111).not.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("repairs broken managed shadow launchers during a real install", async () => {
    const root = join(tmpdir(), `free-install-maintenance-${randomUUID()}`);
    const prefix = join(root, "prefix");
    const home = join(root, "home");
    const packageRoot = join(prefix, "lib", "node_modules", "free");
    const installedBin = join(prefix, "bin", "free");
    const shadowBin = join(home, ".local", "bin", "free");

    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await mkdir(join(home, ".local", "bin"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "bin.js"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    });
    await symlink(join(packageRoot, "dist", "bin.js"), installedBin);
    await symlink(join(root, "deleted-prefix", "bin", "free"), shadowBin);

    try {
      await execFileAsync(process.execPath, ["scripts/install-maintenance.cjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FREE_INSTALLED_BIN: installedBin,
          FREE_PACKAGE_ROOT: packageRoot,
          HOME: home,
          npm_config_prefix: prefix,
          PATH: join(prefix, "bin"),
        },
      });

      await expect(readlink(shadowBin)).resolves.toBe(installedBin);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  const macIt = process.platform === "darwin" ? it : it.skip;

  macIt("migrates an installed launchd service to the free binary launcher", async () => {
    const root = join(tmpdir(), `free-install-maintenance-${randomUUID()}`);
    const prefix = join(root, "prefix");
    const home = join(root, "home");
    const packageRoot = join(prefix, "lib", "node_modules", "free");
    const installedBin = join(prefix, "bin", "free");
    const launchctl = join(root, "bin", "launchctl");
    const plistPath = join(
      home,
      "Library",
      "LaunchAgents",
      "app.saaskit.free.plist",
    );

    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(prefix, "bin"), { recursive: true });
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "bin.js"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    });
    await symlink(join(packageRoot, "dist", "bin.js"), installedBin);
    await writeFile(
      launchctl,
      "#!/bin/sh\nexit 0\n",
      { mode: 0o755 },
    );
    await writeFile(
      plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>ProgramArguments</key>
  <array>
    <string>/old/node</string>
    <string>/old/free/dist/host/bin.js</string>
    <string>run</string>
    <string>--relay-url</string>
    <string>wss://relay.example.com</string>
  </array>
</dict>
</plist>`,
      "utf8",
    );

    try {
      await execFileAsync(process.execPath, ["scripts/install-maintenance.cjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          FREE_INSTALLED_BIN: installedBin,
          FREE_PACKAGE_ROOT: packageRoot,
          HOME: home,
          npm_config_prefix: prefix,
          PATH: `${join(root, "bin")}:${join(prefix, "bin")}`,
        },
      });

      const plist = await readFile(plistPath, "utf8");
      expect(plist).toContain(`<string>${installedBin}</string>`);
      expect(plist).toContain("<string>host</string>");
      expect(plist).toContain("<string>run</string>");
      expect(plist).toContain("<string>--relay-url</string>");
      expect(plist).toContain("<string>wss://relay.example.com</string>");
      expect(plist).not.toContain("/old/node");
      expect(plist).not.toContain("/old/free/dist/host/bin.js");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
