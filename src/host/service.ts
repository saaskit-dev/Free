import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const ACP_REMOTE_HOST_LAUNCHD_LABEL =
  "dev.saaskit.free.host";

export type AcpRemoteHostServiceInstallOptions = {
  hostBinPath: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  identityPath?: string;
  label?: string;
  nodePath: string;
  relayUrl: string;
  scope?: AcpRemoteHostServiceScope;
  userName?: string;
  workspaceRoots: readonly string[];
};

export type AcpRemoteHostServiceScope = "system" | "user";

export type AcpRemoteHostServiceStatus = {
  installed: boolean;
  label: string;
  plistPath: string;
  running: boolean;
};

export async function acpRemoteHostServiceUsesExecutable(input: {
  homeDir?: string;
  hostBinPath: string;
  label?: string;
  nodePath?: string;
  scope?: AcpRemoteHostServiceScope;
}): Promise<boolean> {
  const scope = input.scope ?? "user";
  const label = input.label ?? ACP_REMOTE_HOST_LAUNCHD_LABEL;
  const homeDir = input.homeDir ?? homedir();
  const plistPath = launchdPlistPath(label, scope, homeDir);
  if (!existsSync(plistPath)) {
    return false;
  }
  const plist = await readFile(plistPath, "utf8");
  return (
    plist.includes(`<string>${escapePlist(input.hostBinPath)}</string>`) &&
    (!input.nodePath ||
      plist.includes(`<string>${escapePlist(input.nodePath)}</string>`))
  );
}

export async function installAcpRemoteHostUserService(
  options: AcpRemoteHostServiceInstallOptions,
): Promise<AcpRemoteHostServiceStatus> {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(options.scope);
  const scope = options.scope ?? "user";
  const label = options.label ?? ACP_REMOTE_HOST_LAUNCHD_LABEL;
  const homeDir = options.homeDir ?? homedir();
  await removeOppositeLaunchdService({
    homeDir,
    label,
    scope,
    userName: options.userName,
  });
  const plistPath = launchdPlistPath(label, scope, homeDir);
  const logDir = join(homeDir, ".free", "logs");
  await mkdir(dirname(plistPath), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeFile(
    plistPath,
    createMacOSLaunchAgentPlist({
      ...options,
      homeDir,
      label,
      scope,
      standardErrorPath: join(logDir, "host.err.log"),
      standardOutPath: join(logDir, "host.out.log"),
    }),
    "utf8",
  );
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  ignoreLaunchctlFailure("bootout", launchdDomain(scope), plistPath);
  await waitForLaunchdServiceStopped(label, scope);
  await bootstrapAndKickstartLaunchAgent(label, plistPath, scope);
  await waitForLaunchdServiceRunning(label, scope);
  return getAcpRemoteHostUserServiceStatus(label, scope, homeDir);
}

async function removeOppositeLaunchdService(input: {
  homeDir: string;
  label: string;
  scope: AcpRemoteHostServiceScope;
  userName?: string;
}): Promise<void> {
  if (input.scope === "system") {
    const userPlistPath = launchdPlistPath(input.label, "user", input.homeDir);
    const userUid = input.userName ? readUserId(input.userName) : undefined;
    const userTarget = userUid
      ? `gui/${userUid}/${input.label}`
      : launchdServiceTarget(input.label, "user");
    ignoreLaunchctlFailure("bootout", userTarget);
    await rm(userPlistPath, { force: true });
    return;
  }

  const systemPlistPath = launchdPlistPath(input.label, "system", input.homeDir);
  if (!existsSync(systemPlistPath)) {
    return;
  }
  if (process.getuid?.() !== 0) {
    throw new Error(
      `System host is already installed at ${systemPlistPath}. ` +
      "Run `sudo free host uninstall --system` before installing user mode.",
    );
  }
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(input.label, "system"));
  await rm(systemPlistPath, { force: true });
}

export async function uninstallAcpRemoteHostUserService(
  label = ACP_REMOTE_HOST_LAUNCHD_LABEL,
  scope: AcpRemoteHostServiceScope = "user",
  homeDir = homedir(),
): Promise<void> {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  const plistPath = launchdPlistPath(label, scope, homeDir);
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  await rm(plistPath, { force: true });
}

export async function restartAcpRemoteHostUserService(
  label = ACP_REMOTE_HOST_LAUNCHD_LABEL,
  scope: AcpRemoteHostServiceScope = "user",
  homeDir = homedir(),
): Promise<AcpRemoteHostServiceStatus> {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  const plistPath = launchdPlistPath(label, scope, homeDir);
  await bootstrapAndKickstartLaunchAgent(label, plistPath, scope);
  await waitForLaunchdServiceRunning(label, scope);
  return getAcpRemoteHostUserServiceStatus(label, scope, homeDir);
}

export function stopAcpRemoteHostUserService(
  label = ACP_REMOTE_HOST_LAUNCHD_LABEL,
  scope: AcpRemoteHostServiceScope = "user",
  homeDir = homedir(),
): AcpRemoteHostServiceStatus {
  assertMacOSServiceSupport();
  assertLaunchdScopePermissions(scope);
  ignoreLaunchctlFailure("bootout", launchdServiceTarget(label, scope));
  return getAcpRemoteHostUserServiceStatus(label, scope, homeDir);
}

export function getAcpRemoteHostUserServiceStatus(
  label = ACP_REMOTE_HOST_LAUNCHD_LABEL,
  scope: AcpRemoteHostServiceScope = "user",
  homeDir = homedir(),
): AcpRemoteHostServiceStatus {
  assertMacOSServiceSupport();
  const plistPath = launchdPlistPath(label, scope, homeDir);
  return {
    installed: existsSync(plistPath),
    label,
    plistPath,
    running: isLaunchdServiceRunning(label, scope),
  };
}

export async function readAcpRemoteHostUserServicePlist(
  label = ACP_REMOTE_HOST_LAUNCHD_LABEL,
  scope: AcpRemoteHostServiceScope = "user",
  homeDir = homedir(),
): Promise<string | undefined> {
  const plistPath = launchdPlistPath(label, scope, homeDir);
  if (!existsSync(plistPath)) {
    return undefined;
  }
  return readFile(plistPath, "utf8");
}

export function createMacOSLaunchAgentPlist(input: {
  hostBinPath: string;
  hostId?: string;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  identityPath?: string;
  label: string;
  nodePath: string;
  relayUrl: string;
  scope?: AcpRemoteHostServiceScope;
  standardErrorPath: string;
  standardOutPath: string;
  userName?: string;
  workspaceRoots: readonly string[];
}): string {
  const homeDir = input.homeDir ?? homedir();
  const scope = input.scope ?? "user";
  const args = [
    input.nodePath,
    input.hostBinPath,
    "run",
    "--relay-url",
    input.relayUrl,
    ...input.workspaceRoots.flatMap((root) => ["--workspace-root", root]),
    ...(input.hostId ? ["--host-id", input.hostId] : []),
    ...(input.identityPath ? ["--identity-path", input.identityPath] : []),
  ];
  const env = sanitizeLaunchdEnv(input.env, homeDir);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(input.label)}</string>
${scope === "system" && input.userName ? `  <key>UserName</key>\n  <string>${escapePlist(input.userName)}</string>\n` : ""}  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapePlist(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapePlist(key)}</key>\n    <string>${escapePlist(value)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.standardOutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.standardErrorPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapePlist(homeDir)}</string>
</dict>
</plist>
`;
}

export function launchAgentPlistPath(label = ACP_REMOTE_HOST_LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

export function launchHostPlistPath(label = ACP_REMOTE_HOST_LAUNCHD_LABEL): string {
  return join("/Library", "LaunchDaemons", `${label}.plist`);
}

function launchdPlistPath(
  label: string,
  scope: AcpRemoteHostServiceScope,
  homeDir: string,
): string {
  return scope === "system"
    ? launchHostPlistPath(label)
    : join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

function sanitizeLaunchdEnv(
  env: Record<string, string | undefined> | undefined,
  homeDir = homedir(),
): Record<string, string> {
  const result: Record<string, string> = {
    HOME: homeDir,
    PATH: defaultLaunchdPath(homeDir),
  };
  for (const key of [
    "ACP_REMOTE_HOST_WORKSPACE_ROOTS",
    "FREE_OTLP_LOGS_ENDPOINT",
    "FREE_OTLP_SERVICE_NAME",
    "FREE_OTLP_TRACES_ENDPOINT",
  ]) {
    const value = env?.[key] ?? process.env[key];
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

function defaultLaunchdPath(homeDir: string): string {
  return [
    join(homeDir, ".n", "bin"),
    join(homeDir, ".local", "bin"),
    join(homeDir, "Library", "pnpm"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
}

function isLaunchdServiceRunning(
  label: string,
  scope: AcpRemoteHostServiceScope,
): boolean {
  try {
    const output = execFileSync("launchctl", [
      "print",
      launchdServiceTarget(label, scope),
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseMacOSLaunchAgentRunningState(output);
  } catch {
    return false;
  }
}

export function parseMacOSLaunchAgentRunningState(output: string): boolean {
  return /^\s*state = running\s*$/m.test(output);
}

function launchdUserDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdDomain(scope: AcpRemoteHostServiceScope): string {
  return scope === "system" ? "system" : launchdUserDomain();
}

function launchdServiceTarget(
  label: string,
  scope: AcpRemoteHostServiceScope,
): string {
  return `${launchdDomain(scope)}/${label}`;
}

async function bootstrapAndKickstartLaunchAgent(
  label: string,
  plistPath: string,
  scope: AcpRemoteHostServiceScope,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    ignoreLaunchctlFailure("bootstrap", launchdDomain(scope), plistPath);
    try {
      execFileSync("launchctl", [
        "kickstart",
        "-k",
        launchdServiceTarget(label, scope),
      ], { stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
      await delay(250 * (attempt + 1));
    }
  }
  writeLaunchctlErrorOutput(lastError);
  throw lastError;
}

async function waitForLaunchdServiceStopped(
  label: string,
  scope: AcpRemoteHostServiceScope,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isLaunchdServiceRunning(label, scope)) {
      return;
    }
    await delay(100);
  }
}

async function waitForLaunchdServiceRunning(
  label: string,
  scope: AcpRemoteHostServiceScope,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (isLaunchdServiceRunning(label, scope)) {
      return;
    }
    await delay(100);
  }
}

function ignoreLaunchctlFailure(...args: string[]): void {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // launchctl returns non-zero when bootstrapping an already-loaded service or
    // booting out a missing one. The next status check is the source of truth.
  }
}

function assertMacOSServiceSupport(): void {
  if (process.platform !== "darwin") {
    throw new Error("free host service install currently supports macOS launchd only.");
  }
}

function assertLaunchdScopePermissions(
  scope: AcpRemoteHostServiceScope = "user",
): void {
  if (scope === "system" && process.getuid?.() !== 0) {
    throw new Error("System host install/restart/stop/uninstall requires root. Re-run with sudo.");
  }
}

function readUserId(userName: string): string | undefined {
  try {
    return execFileSync("id", ["-u", userName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeLaunchctlErrorOutput(error: unknown): void {
  if (!error || typeof error !== "object") {
    return;
  }
  const output = error as { stderr?: unknown; stdout?: unknown };
  writeOutput(output.stdout);
  writeOutput(output.stderr);
}

function writeOutput(output: unknown): void {
  if (typeof output === "string") {
    process.stderr.write(output);
    return;
  }
  if (Buffer.isBuffer(output)) {
    process.stderr.write(output.toString("utf8"));
  }
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
