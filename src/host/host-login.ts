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
const SESSION_PATH = (homeDir = homedir()) => join(SESSION_DIR(homeDir), SESSION_FILE_NAME);

export function getSessionPath(homeDir?: string): string {
  return SESSION_PATH(homeDir);
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

export async function loadCachedSession(homeDir?: string): Promise<HostSession | undefined> {
  return readSessionFile(SESSION_PATH(homeDir));
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

export async function saveSession(session: HostSession, homeDir?: string): Promise<void> {
  if (!session.privateKey) {
    throw new Error("Cannot save an account session without its private key.");
  }
  const dir = SESSION_DIR(homeDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(
    SESSION_PATH(homeDir),
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

export async function clearCachedSession(homeDir?: string): Promise<void> {
  await rm(SESSION_PATH(homeDir), { force: true });
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
            detail: "Run `free auth login --force` to start a fresh browser sign in.",
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
            detail: "Run `free auth login --force` to request a new account credential.",
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
            detail: "Run `free auth login --force` from the same terminal session and browser.",
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
  const accent = isSuccess ? "#8cff54" : "#ff6d5a";
  const script = input.autoClose
    ? `<script>
      (function() {
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
          if (detail) detail.textContent = "Free is connected. This tab can be closed.";
        }, 2600);
      })();
    </script>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #0a0f1f;
        --surface: #121a33;
        --surface-2: #1b2550;
        --ink: #ecf2ff;
        --muted: #aab7d6;
        --line: #2f3a63;
        --accent: ${accent};
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(1200px 500px at 12% -10%, #5d3df433 0%, transparent 70%),
          radial-gradient(1000px 420px at 100% 0%, #00e7ff2a 0%, transparent 75%),
          var(--bg);
        color: var(--ink);
        font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        padding: 18px clamp(20px, 5vw, 52px);
        border-bottom: 1px solid var(--line);
        background: color-mix(in oklch, var(--surface) 90%, #000000);
      }
      .brand { font-weight: 780; letter-spacing: 0.02em; }
      .status {
        border: 1px solid color-mix(in oklch, var(--accent) 40%, var(--line));
        border-radius: 999px;
        color: var(--accent);
        padding: 5px 10px;
        font-size: 0.86rem;
        white-space: nowrap;
      }
      main {
        display: grid;
        place-items: center;
        padding: 34px clamp(20px, 5vw, 52px);
      }
      .panel {
        width: min(560px, 100%);
        border: 1px solid var(--line);
        border-radius: 14px;
        background: linear-gradient(180deg, var(--surface) 0%, var(--surface-2) 100%);
        padding: clamp(24px, 5vw, 38px);
        box-shadow: 0 14px 46px #00000052;
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(1.45rem, 4vw, 2.15rem);
        line-height: 1.08;
        letter-spacing: 0;
      }
      p { margin: 0; color: var(--muted); }
      .detail {
        margin-top: 18px;
        border-left: 3px solid var(--accent);
        background: color-mix(in oklch, var(--surface) 75%, #000000);
        border-radius: 8px;
        padding: 10px 12px;
        color: var(--ink);
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand">Free</div>
        <div class="status">${escapeHtml(status)}</div>
      </header>
      <main>
        <section class="panel" aria-labelledby="title">
          <h1 id="title">${escapeHtml(title)}</h1>
          <p>${escapeHtml(input.message)}</p>
          ${input.detail ? `<p class="detail" id="detail">${escapeHtml(input.detail)}</p>` : ""}
        </section>
      </main>
    </div>
    ${script}
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
