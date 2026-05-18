import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import {
  decodeAcpRemoteAccountSession,
  encodeAcpRemoteAccountSession,
  exportEd25519PrivateKey,
  exportEd25519PublicKey,
  type AcpRemoteAccountSession,
} from "../protocol/account-session.js";
import {
  createFreeWorkbenchLoginStartUrl,
  resolveFreeWorkbenchOriginForRelayUrl,
} from "../relay-environment.js";

export type HostSession = {
  accountId: string;
  accountSession: AcpRemoteAccountSession;
  privateKey?: string;
  savedAt: number;
};

const SESSION_FILE_NAME = "account-session.json";
const SESSION_DIR = (homeDir = homedir()) => join(homeDir, ".free");
const SESSION_PATH = (homeDir = homedir(), relayUrl?: string) =>
  join(SESSION_DIR(homeDir), sessionFileNameForRelayUrl(relayUrl));

export function getSessionPath(homeDir?: string, relayUrl?: string): string {
  return SESSION_PATH(homeDir, relayUrl);
}

export function encodeHostAccountSession(session: HostSession): string {
  return encodeAcpRemoteAccountSession(session.accountSession);
}

export function decodeHostAccountSession(value: string): HostSession {
  const accountSession = decodeAcpRemoteAccountSession(value);
  return {
    accountId: accountSession.accountId,
    accountSession,
    savedAt: Date.now(),
  };
}

export async function loadCachedSession(
  homeDir?: string,
  relayUrl?: string,
): Promise<HostSession | undefined> {
  return readSessionFile(SESSION_PATH(homeDir, relayUrl));
}

async function readSessionFile(path: string): Promise<HostSession | undefined> {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = await readFile(path, "utf-8");
    const session = JSON.parse(raw) as Partial<HostSession>;
    if (!session.accountSession?.accountId || !session.privateKey) {
      return undefined;
    }
    return {
      accountId: session.accountSession.accountId,
      accountSession: session.accountSession,
      privateKey: session.privateKey,
      savedAt: typeof session.savedAt === "number" ? session.savedAt : Date.now(),
    };
  } catch {
    return undefined;
  }
}

export async function saveSession(
  session: HostSession,
  homeDir?: string,
  relayUrl?: string,
): Promise<void> {
  if (!session.privateKey) {
    throw new Error("Cannot save an account session without its private key.");
  }
  const dir = SESSION_DIR(homeDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    SESSION_PATH(homeDir, relayUrl),
    JSON.stringify(
      {
        accountSession: session.accountSession,
        privateKey: session.privateKey,
        savedAt: session.savedAt,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export async function clearCachedSession(homeDir?: string, relayUrl?: string): Promise<void> {
  await rm(SESSION_PATH(homeDir, relayUrl), { force: true });
}

function sessionFileNameForRelayUrl(relayUrl?: string): string {
  if (!relayUrl) {
    return SESSION_FILE_NAME;
  }
  try {
    const url = new URL(relayUrl.replace(/^ws(s?):\/\//, "http$1://"));
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "8791"
    ) {
      return "account-session.local.json";
    }
    if (url.hostname === "free-relay.saaskit.app") {
      return SESSION_FILE_NAME;
    }
    return `account-session.${Buffer.from(url.origin).toString("base64url")}.json`;
  } catch {
    return SESSION_FILE_NAME;
  }
}

export type SessionValidationResult =
  | { accountId: string; ok: true }
  | { ok: false; reason: string; retryable?: boolean; status?: number };

export async function validateRelaySession(input: {
  relayUrl: string;
  session: HostSession;
}): Promise<SessionValidationResult> {
  try {
    const url = new URL(
      "/api/session",
      input.relayUrl.replace(/^ws(s?):\/\//, "http$1://"),
    );
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${encodeHostAccountSession(input.session)}`,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
      return {
        ok: false,
        reason: typeof body?.error === "string"
          ? body.error
          : `Relay rejected cached account session with HTTP ${response.status}.`,
        status: response.status,
      };
    }
    const body = await response.json().catch(() => undefined) as { accountId?: unknown } | undefined;
    const accountId = typeof body?.accountId === "string"
      ? body.accountId
      : input.session.accountId;
    return { accountId, ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not validate cached account session: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    };
  }
}

export type OAuthLoginOptions = {
  onStatus?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void>;
  statusIntervalMs?: number;
  timeoutMs?: number;
};

export async function loginViaOAuth(
  relayUrl: string,
  options: OAuthLoginOptions = {},
): Promise<HostSession> {
  const principalId = crypto.randomUUID();
  const principalKeyPair = await createPrincipalKeyPair();
  const reportStatus = (message: string) => {
    const onStatus = options.onStatus ?? defaultLoginStatusReporter;
    onStatus(message);
  };
  return new Promise((resolve, reject) => {
    let completed = false;
    let statusInterval: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (completed) {
        return false;
      }
      completed = true;
      if (statusInterval) {
        clearInterval(statusInterval);
      }
      if (timeout) {
        clearTimeout(timeout);
      }
      try {
        server.close();
      } catch {
        // Server may not have reached the listening state on early bind errors.
      }
      return true;
    };
    const resolveLogin = (session: HostSession) => {
      if (cleanup()) {
        resolve(session);
      }
    };
    const rejectLogin = (error: Error) => {
      if (cleanup()) {
        reject(error);
      }
    };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const addr = server.address();
      const localPort = typeof addr === "object" && addr ? addr.port : 0;
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${localPort}`);

      if (url.pathname === "/callback") {
        reportStatus("Browser authorization received. Verifying account credential...");
        const encodedSession = url.searchParams.get("accountSession");
        const accountId = url.searchParams.get("accountId");
        if (!encodedSession || !accountId) {
          sendHtml(res, 400, createLocalOAuthResultPage({
            detail: "Run `free login --force` to start a fresh browser sign in.",
            message: "The relay completed sign in, but did not return the account credential this device needs.",
            tone: "error",
          }));
          rejectLogin(new Error("OAuth callback missing account session."));
          return;
        }

        let accountSession: AcpRemoteAccountSession;
        try {
          accountSession = decodeAcpRemoteAccountSession(encodedSession);
        } catch (error) {
          sendHtml(res, 400, createLocalOAuthResultPage({
            detail: "Run `free login --force` to request a new account credential.",
            message: "The relay returned an account credential that this version of Free could not read.",
            tone: "error",
          }));
          rejectLogin(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (
          accountSession.accountId !== accountId ||
          accountSession.principalId !== principalId ||
          accountSession.publicKey !== principalKeyPair.publicKey ||
          accountSession.principalType !== "client"
        ) {
          sendHtml(res, 400, createLocalOAuthResultPage({
            detail: "Run `free login --force` from the same terminal session and browser.",
            message: "The returned account credential does not match this device.",
            tone: "error",
          }));
          rejectLogin(new Error("OAuth callback account session mismatch."));
          return;
        }

        reportStatus("Account credential verified. Completing CLI login...");
        sendHtml(res, 200, createLocalOAuthResultPage({
          autoClose: true,
          detail: "This tab can be closed.",
          message: "Free is connected to your account on this device.",
          tone: "success",
        }));

        resolveLogin({
          accountId,
          accountSession,
          privateKey: principalKeyPair.privateKey,
          savedAt: Date.now(),
        });
        return;
      }

      if (url.pathname === "/favicon.ico") {
        writeResponse(res, 204, "text/plain; charset=utf-8", "");
        return;
      }

      writeResponse(res, 200, "text/plain; charset=utf-8", "Free OAuth listener ready.");
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) {
        rejectLogin(new Error("Failed to bind local OAuth server."));
        return;
      }
      const port = addr.port;
      const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`);
      callbackUrl.searchParams.set("accountSessionPrincipalId", principalId);
      callbackUrl.searchParams.set("accountSessionPrincipalType", "client");
      callbackUrl.searchParams.set("accountSessionPublicKey", principalKeyPair.publicKey);
      callbackUrl.searchParams.set("accountSessionReturn", "query");
      const httpRelayUrl = relayUrl.replace(/^ws(s?):\/\//, "http$1://");
      const workbenchOrigin = resolveFreeWorkbenchOriginForRelayUrl({
        env: process.env,
        relayUrl,
      });
      if (!workbenchOrigin) {
        rejectLogin(new Error(`Unable to resolve Workbench origin for relay ${httpRelayUrl}.`));
        return;
      }
      const loginUrl = new URL(createFreeWorkbenchLoginStartUrl({
        returnTo: callbackUrl.toString(),
        workbenchOrigin,
      }));
      const startedAt = Date.now();
      const statusIntervalMs = Math.max(1_000, options.statusIntervalMs ?? 15_000);
      reportStatus(`Local sign-in listener ready: http://127.0.0.1:${port}/`);
      reportStatus(`Opening browser for login: ${loginUrl.toString()}`);
      reportStatus("Waiting for GitHub sign in and device authorization in the browser...");
      statusInterval = setInterval(() => {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        reportStatus(
          `Still waiting for browser authorization (${elapsedSeconds}s). Finish GitHub sign in and click Authorize this device.`,
        );
      }, statusIntervalMs);

      (options.openBrowser ?? openBrowser)(loginUrl.toString()).catch((err) => {
        reportStatus(`Could not open browser automatically: ${err instanceof Error ? err.message : err}`);
        reportStatus(`Please open this URL manually: ${loginUrl.toString()}`);
      });
    });
    server.on("error", (error) => {
      rejectLogin(error instanceof Error ? error : new Error(String(error)));
    });

    timeout = setTimeout(() => {
      rejectLogin(new Error("OAuth login timed out after 5 minutes."));
    }, options.timeoutMs ?? 5 * 60 * 1000);
  });
}

function defaultLoginStatusReporter(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function createPrincipalKeyPair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as {
    privateKey: Parameters<typeof exportEd25519PrivateKey>[0];
    publicKey: Parameters<typeof exportEd25519PublicKey>[0];
  };
  return {
    privateKey: await exportEd25519PrivateKey(pair.privateKey),
    publicKey: await exportEd25519PublicKey(pair.publicKey),
  };
}

async function openBrowser(url: string): Promise<void> {
  const { execFile } = await import("child_process");
  const platform = process.platform;
  const command = platform === "darwin" ? "open"
    : platform === "win32" ? "cmd.exe"
    : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", url] : [url];

  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  writeResponse(res, status, "text/html; charset=utf-8", body);
}

function writeResponse(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Connection": "close",
    "Content-Length": Buffer.byteLength(body, "utf-8"),
    "Content-Type": contentType,
  });
  res.end(body);
}

function createLocalOAuthResultPage(input: {
  autoClose?: boolean;
  detail?: string;
  message: string;
  tone: "error" | "success";
}): string {
  const isSuccess = input.tone === "success";
  const title = isSuccess ? "Free sign in complete" : "Free sign in failed";
  const status = isSuccess ? "Connected" : "Action required";
  const titleZh = isSuccess ? "Free 登录完成" : "Free 登录失败";
  const statusZh = isSuccess ? "已连接" : "需要处理";
  const messageZh = translateLocalOAuthMessage(input.message);
  const detailZh = input.detail ? translateLocalOAuthMessage(input.detail) : undefined;
  const script = input.autoClose
    ? `<script>
      (function() {
        var zh = (navigator.language || "").toLowerCase().indexOf("zh") === 0;
        var closeCopy = zh ? "Free 已连接，可以关闭此标签页。" : "Free is connected. This tab can be closed.";
        try {
          if (window.parent && window.parent !== window) {
            window.parent.postMessage({ type: "free:login-complete" }, "*");
          }
        } catch (_) {}
        function tryClose() {
          try { window.open("", "_self"); } catch (_) {}
          try { window.close(); } catch (_) {}
        }
        window.setTimeout(tryClose, 900);
        window.setTimeout(tryClose, 1800);
        window.setTimeout(function() {
          var detail = document.getElementById("detail");
          if (detail) detail.textContent = closeCopy;
        }, 2600);
      })();
    </script>`
    : "";
  return `<!doctype html>
<html lang="en" data-tone="${escapeHtml(input.tone)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --paper: oklch(0.982 0.018 95);
        --ink: oklch(0.18 0.025 274);
        --muted: oklch(0.48 0.028 278);
        --line: oklch(0.81 0.035 276);
        --panel: oklch(0.995 0.012 98);
        --surface: oklch(0.94 0.026 276);
        --lime: oklch(0.91 0.205 128);
        --blue: oklch(0.63 0.2 252);
        --coral: oklch(0.68 0.19 28);
        --accent: var(--lime);
      }
      html[data-tone="error"] { --accent: var(--coral); }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--paper);
        color: var(--ink);
        font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        overflow-x: hidden;
      }
      .shell {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        position: relative;
        isolation: isolate;
      }
      .shell::before,
      .shell::after {
        content: "";
        position: absolute;
        z-index: -1;
        pointer-events: none;
      }
      .shell::before {
        inset: 126px auto auto -54px;
        width: min(42vw, 520px);
        aspect-ratio: 1;
        background: var(--lime);
        clip-path: polygon(0 0, 100% 12%, 78% 82%, 9% 100%);
      }
      .shell::after {
        inset: 0 -120px auto auto;
        width: min(45vw, 620px);
        height: 230px;
        background: var(--blue);
        clip-path: polygon(18% 0, 100% 0, 100% 86%, 0 64%);
        opacity: 0.92;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 22px clamp(18px, 5vw, 56px);
        border-bottom: 1px solid var(--ink);
        background: color-mix(in oklch, var(--paper) 88%, var(--surface));
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        font-weight: 760;
        letter-spacing: 0;
      }
      .mark {
        display: grid;
        place-items: center;
        width: 42px;
        height: 42px;
        background: var(--ink);
        color: var(--panel);
        border: 1px solid var(--ink);
        font-size: 26px;
        line-height: 1;
        box-shadow: 5px 5px 0 var(--accent);
      }
      .brand small {
        display: block;
        color: var(--muted);
        font-size: 12px;
        font-weight: 620;
        margin-top: 1px;
      }
      .status {
        border: 1px solid var(--ink);
        border-radius: 8px;
        background: var(--accent);
        color: var(--ink);
        padding: 8px 12px;
        font-size: 13px;
        font-weight: 720;
        white-space: nowrap;
        box-shadow: 4px 4px 0 var(--ink);
      }
      main {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: clamp(34px, 9vh, 84px) clamp(18px, 5vw, 56px);
      }
      .panel {
        width: min(680px, 100%);
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        padding: clamp(24px, 6vw, 44px);
        box-shadow: 10px 10px 0 var(--ink);
        position: relative;
      }
      .panel::before {
        content: "";
        position: absolute;
        inset: 16px 16px auto auto;
        width: 72px;
        height: 72px;
        background:
          linear-gradient(90deg, var(--ink) 1px, transparent 1px),
          linear-gradient(var(--ink) 1px, transparent 1px);
        background-size: 12px 12px;
        opacity: 0.14;
      }
      h1 {
        max-width: 13ch;
        margin: 0 0 12px;
        font-size: 42px;
        line-height: 1.02;
        letter-spacing: 0;
      }
      p {
        max-width: 62ch;
        margin: 0;
        color: var(--muted);
      }
      .detail {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 24px;
        border: 1px solid var(--ink);
        background: color-mix(in oklch, var(--accent) 24%, var(--panel));
        border-radius: 8px;
        padding: 12px 14px;
        color: var(--ink);
        font-weight: 640;
      }
      .dot {
        flex: 0 0 auto;
        width: 12px;
        height: 12px;
        border: 1px solid var(--ink);
        background: var(--accent);
        transform: rotate(45deg);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
      @media (max-width: 620px) {
        header {
          align-items: flex-start;
          flex-direction: column;
        }
        .status { align-self: flex-start; }
        main { align-items: flex-start; }
        .panel {
          box-shadow: 6px 6px 0 var(--ink);
        }
        h1 {
          font-size: 32px;
          max-width: 12ch;
        }
        .panel::before {
          width: 48px;
          height: 48px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand" aria-label="Free">
          <span class="mark">F</span>
          <span>
            Free
            <small data-en="Device connection" data-zh="设备连接">Device connection</small>
          </span>
        </div>
        <div class="status" data-en="${escapeHtml(status)}" data-zh="${escapeHtml(statusZh)}">${escapeHtml(status)}</div>
      </header>
      <main>
        <section class="panel" aria-labelledby="title">
          <h1 id="title" data-en="${escapeHtml(title)}" data-zh="${escapeHtml(titleZh)}">${escapeHtml(title)}</h1>
          <p data-en="${escapeHtml(input.message)}" data-zh="${escapeHtml(messageZh)}">${escapeHtml(input.message)}</p>
          ${input.detail ? `<p class="detail" id="detail" data-en="${escapeHtml(input.detail)}" data-zh="${escapeHtml(detailZh ?? input.detail)}"><span class="dot" aria-hidden="true"></span><span>${escapeHtml(input.detail)}</span></p>` : ""}
        </section>
      </main>
    </div>
    <script>
      (function() {
        var zh = (navigator.language || "").toLowerCase().indexOf("zh") === 0;
        if (!zh) return;
        document.documentElement.lang = "zh-CN";
        document.querySelectorAll("[data-zh]").forEach(function(node) {
          var value = node.getAttribute("data-zh");
          if (!value) return;
          if (node.id === "detail") {
            var text = node.querySelector("span:last-child");
            if (text) text.textContent = value;
            return;
          }
          node.textContent = value;
        });
      })();
    </script>
    ${script}
  </body>
</html>`;
}

function translateLocalOAuthMessage(value: string): string {
  switch (value) {
    case "Free is connected to your account on this device.":
      return "Free 已连接到此设备上的账号。";
    case "This tab can be closed.":
      return "可以关闭此标签页。";
    case "The relay completed sign in, but did not return the account credential this device needs.":
      return "Relay 已完成登录，但未返回此设备需要的账号凭证。";
    case "Run `free login --force` to start a fresh browser sign in.":
      return "运行 `free login --force` 重新开始浏览器登录。";
    case "The relay returned an account credential that this version of Free could not read.":
      return "Relay 返回的账号凭证无法被当前版本的 Free 读取。";
    case "Run `free login --force` to request a new account credential.":
      return "运行 `free login --force` 请求新的账号凭证。";
    case "The returned account credential does not match this device.":
      return "返回的账号凭证与此设备不匹配。";
    case "Run `free login --force` from the same terminal session and browser.":
      return "在同一个终端会话和浏览器中运行 `free login --force`。";
    default:
      return value;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
