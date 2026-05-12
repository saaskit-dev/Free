#!/usr/bin/env node

const { execFileSync } = require("node:child_process");
const {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { homedir } = require("node:os");

const LABEL = "dev.saaskit.free.host";

function main() {
  const installedBin = resolveInstalledBin();
  const packageRoot = resolvePackageRoot(installedBin);
  if (!installedBin || !packageRoot) {
    return;
  }
  ensureExecutableBins(packageRoot);
  ensureManagedShadowLaunchers(installedBin);
  if (!shouldUpdateLaunchdService(packageRoot)) {
    return;
  }
  updateLaunchdService({
    hostBinPath: join(packageRoot, "dist", "host", "bin.js"),
    nodePath: process.execPath,
  });
}

function resolveInstalledBin() {
  const explicit = process.env.FREE_INSTALLED_BIN;
  if (explicit && existsSync(explicit)) {
    return resolve(explicit);
  }
  const prefix = process.env.npm_config_prefix;
  const candidate = prefix ? join(prefix, "bin", "free") : undefined;
  if (candidate && existsSync(candidate)) {
    return resolve(candidate);
  }
  return undefined;
}

function resolvePackageRoot(installedBin) {
  const explicit = process.env.FREE_PACKAGE_ROOT;
  if (explicit && existsSync(explicit)) {
    return resolve(explicit);
  }
  if (!installedBin) {
    return undefined;
  }
  try {
    const realBin = realpathSync(installedBin);
    return resolve(dirname(realBin), "..");
  } catch {
    return undefined;
  }
}

function ensureManagedShadowLaunchers(installedBin) {
  const home = homedir();
  const candidates = unique([
    join(home, ".local", "bin", "free"),
    join(home, ".n", "bin", "free"),
    ...pathFreeCandidates(),
  ]);
  for (const candidate of candidates) {
    if (resolve(candidate) === resolve(installedBin)) {
      continue;
    }
    if (!existsSync(candidate) || !isManagedFreeLauncher(candidate)) {
      continue;
    }
    try {
      const candidateReal = realpathSync(candidate);
      const installedReal = realpathSync(installedBin);
      if (candidateReal === installedReal) {
        continue;
      }
    } catch {
      // Fall through and replace the stale managed launcher.
    }
    rmSync(candidate, { force: true });
    symlinkSync(installedBin, candidate);
    console.error(`Updated Free launcher: ${candidate} -> ${installedBin}`);
  }
}

function pathFreeCandidates() {
  return (process.env.PATH ?? "")
    .split(":")
    .filter(Boolean)
    .map((entry) => join(entry, "free"));
}

function unique(values) {
  return [...new Set(values)];
}

function isManagedFreeLauncher(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try {
        const real = realpathSync(path);
        return (
          real.includes("/node_modules/free/") ||
          real.includes("/node_modules/@saaskit-dev/free/") ||
          real.endsWith("/dist/bin.js")
        );
      } catch {
        return true;
      }
    }
    if (!stat.isFile()) {
      return false;
    }
    const text = readFileSync(path, "utf8");
    return text.includes("free") && text.includes("dist/bin.js");
  } catch {
    return false;
  }
}

function ensureExecutableBins(packageRoot) {
  for (const relativePath of [
    "dist/bin.js",
  ]) {
    const binPath = join(packageRoot, relativePath);
    if (!existsSync(binPath)) {
      continue;
    }
    chmodSync(binPath, 0o755);
  }
}

function shouldUpdateLaunchdService(packageRoot) {
  if (process.env.FREE_PACKAGE_ROOT) {
    return true;
  }
  return packageRoot.split(/[\\/]/).includes("node_modules");
}

function updateLaunchdService(input) {
  if (process.platform !== "darwin") {
    return;
  }
  updateLaunchdPlist({
    ...input,
    domain: `gui/${process.getuid?.() ?? ""}`,
    plistPath: join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`),
    target: `${`gui/${process.getuid?.() ?? ""}`}/${LABEL}`,
  });
  if (process.getuid?.() === 0) {
    updateLaunchdPlist({
      ...input,
      domain: "system",
      plistPath: join("/Library", "LaunchDaemons", `${LABEL}.plist`),
      target: `system/${LABEL}`,
    });
  }
}

function updateLaunchdPlist(input) {
  if (!existsSync(input.plistPath)) {
    return;
  }
  const oldText = readFileSync(input.plistPath, "utf8");
  const newText = replaceProgramArgumentsExecutable(oldText, input);
  if (newText === oldText) {
    return;
  }
  writeFileSync(input.plistPath, newText, "utf8");
  restartLaunchdService(input);
  console.error(`Updated Free host service executable: ${input.plistPath}`);
}

function replaceProgramArgumentsExecutable(plist, input) {
  return plist.replace(
    /(<key>ProgramArguments<\/key>\s*<array>\s*<string>)([\s\S]*?)(<\/string>\s*<string>)([\s\S]*?)(<\/string>)/,
    `$1${escapePlist(input.nodePath)}$3${escapePlist(input.hostBinPath)}$5`,
  );
}

function restartLaunchdService(input) {
  try {
    execFileSync("launchctl", ["bootout", input.target], { stdio: "ignore" });
  } catch {
    // Missing or already-stopped services are fine here.
  }
  try {
    execFileSync("launchctl", ["bootstrap", input.domain, input.plistPath], { stdio: "ignore" });
  } catch {
    // launchctl returns non-zero when a service is already loaded.
  }
  try {
    execFileSync("launchctl", ["kickstart", "-k", input.target], { stdio: "ignore" });
  } catch {
    // The next explicit host status command remains the source of truth.
  }
}

function escapePlist(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

try {
  main();
} catch (error) {
  console.error(`Free install maintenance skipped: ${error instanceof Error ? error.message : String(error)}`);
}
