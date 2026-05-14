import {
  AcpRemoteEndpointKind,
  createAcpRemoteAccountSession,
  exportEd25519PublicKey,
  readAcpRemoteAccountSessionVerificationKeys,
  verifyAcpRemoteConnectionProof,
  type AcpRemoteConnectionProofVerificationResult,
  type AcpRemoteAccountSessionSigningKey,
  type AcpRemoteAccountSessionVerificationKey,
  type AcpRemoteScope,
} from "../../src/protocol/index.js";
import {
  encodeAcpRelayAccountSession,
  verifyAcpRelayAccountSessionValue,
  type AcpRelayAccountSession,
} from "./account-session.js";
import {
  AcpRelayD1ControlPlaneStore,
  type AcpRelayHostRecord,
} from "./control-plane-store.js";
import { handleControlPlaneRequest } from "./control-plane-http.js";
import { verifyHostRegistrationProof } from "./host-auth.js";
import {
  D1GitHubAccountStore,
  createGitHubAuthorizationUrl,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  resolveOrCreateGithubAccount,
} from "./github-auth.js";
import {
  asRecord,
  escapeHtml,
  html,
  json,
  readJsonBody,
  readOptionalString,
  readOptionalStringArray,
  readRequiredString,
} from "./http-utils.js";
import { UPGRADE_REQUIRED, type Env } from "./env.js";
import {
  handleRelayLogUploadRequest,
  handleRelayOtlpProxyRequest,
} from "./log-upload-http.js";
import {
  AcpRelayBroker,
  type AcpRelayAttachmentForwardInput,
  createRelayAuthorizationPage,
  type AcpRelayClientStateSnapshot,
  type AcpRelayClientTransport,
} from "./relay-core.js";
import {
  RELAY_SOCKET_ATTACHMENT_VERSION,
  deleteClientStateSnapshotFromStorage,
  readClientStateSnapshotFromStorage,
  readRelayWebSocketAttachment,
  type RelayWebSocketAttachment,
  writeClientStateSnapshotToStorage,
} from "./relay-snapshot.js";
import { createRelayTraceSpan } from "./relay-tracing.js";
import {
  createAuthorizationUrl,
  normalizeMessageData,
  parseHostMetadataHeaders,
  readConnectionProof,
  readConnectionProofs,
  readOptionalPositiveInteger,
  resolveClientId,
  resolveHostId,
  resolveRequestedAccountId,
  resolveVerifiedAccountId,
  waitUntil,
  withVerifiedAccountSession,
} from "./request-utils.js";

export type { Env } from "./env.js";

const DEFAULT_AUTOMATIC_GRANT_SCOPES = [
  "acp:connect",
  "acp:session:create",
  "acp:session:list",
  "acp:session:resume",
  "acp:turn:send",
  "acp:turn:cancel",
] as const satisfies readonly AcpRemoteScope[];

const MAX_RELAY_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS" && isWorkbenchApiCorsPath(url.pathname)) {
      return createWorkbenchApiCorsPreflightResponse(request, env);
    }

    if (url.pathname === "/health") {
      return withWorkbenchApiCors(json({ ok: true }), request, env);
    }

    if (
      url.pathname === "/api/login/start" ||
      url.pathname === "/api/login/callback" ||
      url.pathname === "/api/login/confirm"
    ) {
      return handleGitHubAuthRequest(request, env, url);
    }

    if (url.pathname === "/logout") {
      return createLogoutResponse(request, env);
    }

    if (url.pathname.startsWith("/control-plane/")) {
      return handleControlPlaneRequest(request, env, url);
    }

    if (
      url.pathname !== "/acp" &&
      url.pathname !== "/api/hosts" &&
      url.pathname !== "/api/logs" &&
      url.pathname !== "/api/otel/logs" &&
      url.pathname !== "/api/otel/traces" &&
      url.pathname !== "/api/session" &&
      url.pathname !== "/api/sessions" &&
      url.pathname !== "/api/login/start" &&
      url.pathname !== "/api/login/callback" &&
      url.pathname !== "/api/login/confirm" &&
      url.pathname !== "/api/authorize" &&
      !url.pathname.startsWith("/api/login/approvals/") &&
      url.pathname !== "/attachments" &&
      url.pathname !== "/logout" &&
      url.pathname !== "/host" &&
      !url.pathname.startsWith("/api/hosts/") &&
      url.pathname !== "/authorize"
    ) {
      return new Response("Not found.", { status: 404 });
    }

    // OAuth and API endpoints that persist data require D1
    if (url.pathname === "/api/logs") {
      return handleRelayLogUploadRequest(
        request,
        env,
        verifyAccountSessionRequest,
      );
    }
    if (url.pathname === "/api/otel/logs" || url.pathname === "/api/otel/traces") {
      return handleRelayOtlpProxyRequest(
        request,
        env,
        url,
        verifyAccountSessionRequest,
      );
    }
    if (url.pathname.startsWith("/api/") && !env.ACP_RELAY_DB) {
      return new Response("API endpoints require a database (D1).", { status: 503 });
    }

    if (url.pathname.startsWith("/api/login/approvals/")) {
      if (!env.ACP_RELAY_DB) {
        return new Response("API endpoints require a database (D1).", { status: 503 });
      }
      return handleLoginApprovalApi({
        db: env.ACP_RELAY_DB,
        env,
        request,
        url,
      });
    }

    if (url.pathname === "/api/session") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
      });
      if (!accountSession.ok) {
        return withWorkbenchApiCors(
          json({ error: accountSession.reason }, {
            status: accountSession.status,
          }),
          request,
          env,
        );
      }
      const githubAccount = await new D1GitHubAccountStore(env.ACP_RELAY_DB as D1Database)
        .findByAccountId(accountSession.session.accountId);
      return withWorkbenchApiCors(
        json({
          account: {
            id: accountSession.session.accountId,
            name: githubAccount?.githubLogin ?? accountSession.session.accountId,
            provider: githubAccount ? "github" : "unknown",
          },
          accountId: accountSession.session.accountId,
          accountName: githubAccount?.githubLogin ?? accountSession.session.accountId,
          expiresAt: accountSession.session.expiresAt,
          sessionId: accountSession.session.sessionId,
        }),
        request,
        env,
      );
    }

    if (url.pathname === "/attachments") {
      const connectionProof = readConnectionProof(request, url);
      if (!connectionProof) {
        return new Response("Missing connection proof.", { status: 401 });
      }
      const verificationKeys = readAccountSessionVerificationKeys(env);
      if (!verificationKeys.ok) {
        return new Response(verificationKeys.reason, { status: 503 });
      }
      const proof = await verifyAcpRemoteConnectionProof(
        connectionProof,
        verificationKeys.keys,
        {
          clientId: resolveClientId(request, url),
          connectionId: url.searchParams.get("connectionId") ?? undefined,
          hostId: resolveHostId(request, url),
        },
      );
      if (!proof.ok) {
        return new Response(proof.reason, { status: 401 });
      }
      const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${proof.accountId}`);
      return env.ACP_RELAY_SHARDS.get(shardId).fetch(
        withVerifiedConnectionProof(request, proof),
      );
    }

    if (
      url.pathname === "/api/hosts" ||
      url.pathname.startsWith("/api/hosts/") ||
      url.pathname === "/api/sessions"
    ) {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        return new Response(accountSession.reason, {
          status: accountSession.status,
        });
      }
      const shardId = env.ACP_RELAY_SHARDS.idFromName(
        `account:${accountSession.session.accountId}`,
      );
      return env.ACP_RELAY_SHARDS
        .get(shardId)
        .fetch(withVerifiedAccountSession(request, accountSession.session))
        .then((response) => withWorkbenchApiCors(response, request, env));
    }

    if (url.pathname === "/authorize" && request.method === "GET") {
      const workbenchOrigin = resolveWorkbenchOrigin({ env, request });
      if (workbenchOrigin) {
        const workbenchUrl = new URL("/authorize", workbenchOrigin);
        url.searchParams.forEach((value, key) => {
          workbenchUrl.searchParams.append(key, value);
        });
        return Response.redirect(workbenchUrl.toString(), 302);
      }
    }

    if (url.pathname === "/authorize" || url.pathname === "/api/authorize") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        if (url.pathname === "/api/authorize") {
          return withWorkbenchApiCors(
            json({ error: accountSession.reason }, { status: accountSession.status }),
            request,
            env,
          );
        }
        return createAuthorizationSessionFailureResponse({
          env,
          failure: accountSession,
          request,
          url,
        });
      }

      const shardId = env.ACP_RELAY_SHARDS.idFromName(
        `account:${accountSession.session.accountId}`,
      );
      return env.ACP_RELAY_SHARDS
        .get(shardId)
        .fetch(withVerifiedAccountSession(request, accountSession.session))
        .then((response) =>
          url.pathname === "/api/authorize"
            ? withWorkbenchApiCors(response, request, env)
            : response,
        );
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(UPGRADE_REQUIRED, { status: 426 });
    }

    if (url.pathname === "/host" && !resolveHostId(request, url)) {
      return new Response("Missing host id.", { status: 400 });
    }

    let routeRequest = request;
    let accountId: string;
    if (url.pathname === "/host") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
        return new Response(accountSession.reason, {
          status: accountSession.status,
        });
      }
      accountId = accountSession.session.accountId;
      routeRequest = withVerifiedAccountSession(request, accountSession.session);
      const hostId = resolveHostId(request, url);
      if (!hostId) {
        return new Response("Missing host id.", { status: 400 });
      }
      const proof = await verifyHostRegistrationRequest({
        accountId,
        env,
        hostId,
        request,
      });
      if (!proof.ok) {
        return new Response(proof.reason, { status: 401 });
      }
    } else {
      const connectionProof = readConnectionProof(request, url);
      const connectionProofs = readConnectionProofs(request);
      if (!connectionProof) {
        return new Response("Missing connection proof.", { status: 401 });
      }
      const verificationKeys = readAccountSessionVerificationKeys(env);
      if (!verificationKeys.ok) {
        return new Response(verificationKeys.reason, { status: 503 });
      }
      const proof = await verifyAcpRemoteConnectionProof(
        connectionProof,
        verificationKeys.keys,
        {
          clientId: resolveClientId(request, url),
          connectionId: url.searchParams.get("connectionId") ?? undefined,
          hostId: resolveHostId(request, url),
        },
      );
      if (!proof.ok) {
        return new Response(proof.reason, { status: 401 });
      }
      for (const candidate of connectionProofs) {
        const candidateProof = await verifyAcpRemoteConnectionProof(
          candidate,
          verificationKeys.keys,
          {
            clientId: resolveClientId(request, url),
            connectionId: url.searchParams.get("connectionId") ?? undefined,
          },
        );
        if (!candidateProof.ok) {
          return new Response(candidateProof.reason, { status: 401 });
        }
        if (candidateProof.accountId !== proof.accountId) {
          return new Response("Connection proof account mismatch.", { status: 401 });
        }
      }
      accountId = proof.accountId;
    }

    const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${accountId}`);
    return env.ACP_RELAY_SHARDS.get(shardId).fetch(routeRequest);
  },
};

export class AcpRelayShard {
  private readonly broker: AcpRelayBroker;
  private readonly heartbeatIntervalMs: number | undefined;
  private readonly restorePromise: Promise<void>;
  private readonly createdAt: number;
  private instanceId: string;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.createdAt = Date.now();
    this.instanceId = crypto.randomUUID();
    console.log(
      `[relay-do] instance created id=${this.instanceId} time=${new Date().toISOString()}`,
    );
    this.heartbeatIntervalMs = readOptionalPositiveInteger(
      this.env.ACP_RELAY_HEARTBEAT_INTERVAL_MS,
    );
    this.broker = new AcpRelayBroker({
      controlPlaneStore: this.env.ACP_RELAY_DB
        ? new AcpRelayD1ControlPlaneStore(this.env.ACP_RELAY_DB)
        : undefined,
      clientReconnectGraceMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_CLIENT_RECONNECT_GRACE_MS,
      ),
      hostReconnectGraceMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_HOST_RECONNECT_GRACE_MS,
      ),
      heartbeatTimeoutMs: readOptionalPositiveInteger(
        this.env.ACP_RELAY_HEARTBEAT_TIMEOUT_MS,
      ),
      maxBufferedFramesPerConnection: readOptionalPositiveInteger(
        this.env.ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION,
      ),
      maxQueuedFramesPerConnection: readOptionalPositiveInteger(
        this.env.ACP_RELAY_MAX_QUEUED_FRAMES_PER_CONNECTION,
      ),
      maxConnectionsPerAccount: readOptionalPositiveInteger(
        this.env.ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT,
      ),
      onClientRouteAuthorized: ({ connectionId, hostId }) => {
        this.updateClientSocketAttachmentByConnectionId(connectionId, {
          routeReady: true,
          hostId,
        });
      },
      onTraceSpan: (input) => {
        const span = createRelayTraceSpan(this.env, input);
        waitUntil(this.state, span.exportPromise);
        return span.context;
      },
    });
    this.restorePromise = this.restoreHibernatedWebSockets();
  }

  async alarm(): Promise<void> {
    await this.restorePromise;
    const now = Date.now();
    const ageMs = now - this.createdAt;
    console.log(
      `[relay-do] alarm fired instance=${this.instanceId} age_ms=${ageMs} active_host_routes=${this.broker.activeHostRouteIds().length}`,
    );
    this.broker.closeUnresponsiveHosts();
    this.broker.closeExpiredDisconnectedHosts();
    const expiredClientIds = this.broker.closeExpiredDisconnectedClients();
    await Promise.all(
      expiredClientIds.map((connectionId) =>
        this.deleteClientStateSnapshot(connectionId),
      ),
    );
    await this.writeAllClientStateSnapshots();
    this.broker.pingHosts();
    await this.scheduleHeartbeat();
  }

  async fetch(request: Request): Promise<Response> {
    await this.restorePromise;
    const url = new URL(request.url);
    if (url.pathname === "/internal/reconcile-authorizations") {
      return this.reconcileAuthorizations(request);
    }
    if (url.pathname === "/authorize" || url.pathname === "/api/authorize") {
      return this.authorize(request, url);
    }

    if (url.pathname === "/attachments") {
      return this.handleAttachmentUpload(request, url);
    }

    if (url.pathname === "/api/hosts" || url.pathname.startsWith("/api/hosts/")) {
      return this.handleHostApi(request, url);
    }

    if (url.pathname === "/api/sessions") {
      return this.handleSessionsApi(request, url);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(UPGRADE_REQUIRED, { status: 426 });
    }

    const endpoint =
      url.pathname === "/host"
        ? AcpRemoteEndpointKind.Host
        : AcpRemoteEndpointKind.Client;
    const clientTransport: AcpRelayClientTransport = "native-acp";
    const connectionId =
      url.searchParams.get("connectionId") ?? crypto.randomUUID();
    const hostId = resolveHostId(request, url);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectedAt = Date.now();
    this.acceptRelayWebSocket(server, {
      connectedAt,
      connectionId,
      hostId,
      endpoint,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    });

    console.log(
      `[relay-do] ws connected endpoint=${endpoint} connectionId=${connectionId} hostId=${hostId ?? "none"} instance=${this.instanceId}`,
    );

    if (endpoint === AcpRemoteEndpointKind.Host) {
      if (!hostId) {
        server.close(1008, "Missing host id.");
      } else {
        const hostMetadata = parseHostMetadataHeaders(request);
        const hostAccountId = resolveVerifiedAccountId(request);
        this.updateSocketAttachment(server, {
          accountId: hostAccountId,
          hostMetadata,
        });
        void (async () => {
          try {
            await this.broker.registerHost({
              accountId: hostAccountId,
              hostId,
              metadata: hostMetadata,
              socket: server,
            });
            await this.writeAllClientStateSnapshots();
            await this.scheduleHeartbeat();
          } catch (error) {
            console.error("Failed to register ACP relay host route", error);
            server.close(1011, "Failed to register host route.");
          }
        })();
      }
    } else {
      const authUrl = createAuthorizationUrl(request, connectionId).toString();
      const nativeClientAck = url.searchParams.get("nativeClientAck") === "1";
      const connectionProof = readConnectionProof(request, url);
      const connectionProofs = readConnectionProofs(request);
      if (!connectionProof) {
        server.close(1008, "Missing connection proof.");
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }
      const accountId = connectionProof.accountSession.accountId;
      const clientId = resolveClientId(request, url) ?? connectionProof.clientId;
      if (connectionProof.accountSession.accountId !== accountId) {
        server.close(1008, "Connection proof account mismatch.");
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }
      if (connectionProof.clientId !== clientId) {
        server.close(1008, "Connection proof client mismatch.");
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }
      if (hostId && connectionProof.hostId !== hostId) {
        server.close(1008, "Connection proof host mismatch.");
        return new Response(null, {
          status: 101,
          webSocket: client,
        } as ResponseInit & { webSocket: WebSocket });
      }
      const stateSnapshot = await this.readClientStateSnapshot(connectionId);
      this.updateSocketAttachment(server, {
        accountId,
        authUrl,
        clientId,
        connectionProof,
        connectionProofs,
        nativeClientAck,
        transport: clientTransport,
      });
      this.broker.registerClient({
        accountId,
        authUrl,
        clientId,
        connectionId,
        connectionProof,
        connectionProofs,
        hostId,
        nativeClientAck,
        socket: server,
        stateSnapshot,
        transport: clientTransport,
      });
      await this.writeOrDeleteClientStateSnapshot(connectionId);
    }

    if (!this.usesWebSocketHibernation()) {
      server.addEventListener("message", (event) => {
        void this.webSocketMessage(server, event.data);
      });
      server.addEventListener("close", (event) => {
        const closeEvent = event as { code?: unknown; reason?: unknown } | undefined;
        this.webSocketClose(
          server,
          typeof closeEvent?.code === "number" ? closeEvent.code : undefined,
          typeof closeEvent?.reason === "string" ? closeEvent.reason : undefined,
        );
      });
      server.addEventListener("error", (event) => {
        this.webSocketError(server, event);
      });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      socket.close(1008, "Missing relay socket attachment.");
      return;
    }
    const text = normalizeMessageData(message);
    if (!text) {
      return;
    }
    if (attachment.endpoint === AcpRemoteEndpointKind.Host) {
      const connectionId = this.broker.handleHostText(text);
      if (connectionId) {
        await this.writeOrDeleteClientStateSnapshot(connectionId);
      }
      return;
    }
    await this.broker.handleClientText(attachment.connectionId, text);
    await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
  }

  async webSocketClose(
    socket: WebSocket,
    code?: number,
    reason?: string,
  ): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    const durationMs = Date.now() - attachment.connectedAt;
    console.log(
      `[relay-do] ws close endpoint=${attachment.endpoint} connectionId=${attachment.connectionId} hostId=${attachment.hostId ?? "none"} code=${code ?? "-"} reason="${reason ?? ""}" duration_ms=${durationMs} instance=${this.instanceId}`,
    );
    this.removeSocket(
      attachment.endpoint,
      attachment.connectionId,
      attachment.hostId,
      socket,
      { code, reason },
    );
    if (attachment.endpoint === AcpRemoteEndpointKind.Client) {
      await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
    } else {
      await this.writeAllClientStateSnapshots();
    }
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    await this.restorePromise;
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    const durationMs = Date.now() - attachment.connectedAt;
    const message =
      typeof error === "object" &&
      error !== null &&
      "message" in error &&
      typeof error.message === "string"
        ? error.message
        : "";
    console.log(
      `[relay-do] ws error endpoint=${attachment.endpoint} connectionId=${attachment.connectionId} hostId=${attachment.hostId ?? "none"} message="${message}" duration_ms=${durationMs} instance=${this.instanceId}`,
    );
    this.removeSocket(
      attachment.endpoint,
      attachment.connectionId,
      attachment.hostId,
      socket,
      { final: false },
    );
    if (attachment.endpoint === AcpRemoteEndpointKind.Client) {
      await this.writeOrDeleteClientStateSnapshot(attachment.connectionId);
    } else {
      await this.writeAllClientStateSnapshots();
    }
  }

  private async restoreHibernatedWebSockets(): Promise<void> {
    const sockets = this.state.getWebSockets?.() ?? [];
    const restored = sockets
      .map((socket) => ({
        attachment: this.readSocketAttachment(socket),
        socket,
      }))
      .filter(
        (
          entry,
        ): entry is {
          attachment: RelayWebSocketAttachment;
          socket: WebSocket;
        } => entry.attachment !== undefined,
      );
    for (const { attachment, socket } of restored) {
      if (attachment.endpoint !== AcpRemoteEndpointKind.Host) {
        continue;
      }
      if (!attachment.hostId) {
        socket.close(1008, "Missing host id.");
        continue;
      }
      await this.broker.registerHost({
        accountId: attachment.accountId,
        hostId: attachment.hostId,
        metadata: attachment.hostMetadata,
        socket,
      });
    }
    for (const { attachment, socket } of restored) {
      if (attachment.endpoint !== AcpRemoteEndpointKind.Client) {
        continue;
      }
      if (!attachment.accountId || !attachment.authUrl) {
        socket.close(1008, "Missing client route metadata.");
        continue;
      }
      const stateSnapshot = await this.readClientStateSnapshot(
        attachment.connectionId,
      );
      this.broker.registerClient({
        accountId: attachment.accountId,
        authUrl: attachment.authUrl,
        routeReady:
          attachment.routeReady ?? attachment.connectionProof !== undefined,
        clientId: attachment.clientId,
        connectionProof: attachment.connectionProof,
        connectionProofs: attachment.connectionProofs,
        connectionId: attachment.connectionId,
        hostId: attachment.hostId,
        nativeClientAck: attachment.nativeClientAck,
        restoredHibernatedSocket: true,
        socket,
        stateSnapshot,
        transport: attachment.transport,
      });
    }
    if (restored.some((entry) => entry.attachment.endpoint === AcpRemoteEndpointKind.Host)) {
      await this.scheduleHeartbeat();
    }
  }

  private acceptRelayWebSocket(
    socket: WebSocket,
    attachment: RelayWebSocketAttachment,
  ): void {
    if (this.usesWebSocketHibernation()) {
      const tags = [
        `endpoint:${attachment.endpoint}`,
        `connection:${attachment.connectionId}`,
        ...(attachment.hostId ? [`host:${attachment.hostId}`] : []),
      ];
      this.state.acceptWebSocket?.(socket, tags);
    } else {
      socket.accept();
    }
    socket.serializeAttachment?.(attachment);
  }

  private usesWebSocketHibernation(): boolean {
    return typeof this.state.acceptWebSocket === "function";
  }

  private readSocketAttachment(
    socket: WebSocket,
  ): RelayWebSocketAttachment | undefined {
    return readRelayWebSocketAttachment(socket.deserializeAttachment?.());
  }

  private updateSocketAttachment(
    socket: WebSocket,
    updates: Partial<RelayWebSocketAttachment>,
  ): void {
    const attachment = this.readSocketAttachment(socket);
    if (!attachment) {
      return;
    }
    socket.serializeAttachment?.({
      ...attachment,
      ...updates,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    } satisfies RelayWebSocketAttachment);
  }

  private updateClientSocketAttachmentByConnectionId(
    connectionId: string,
    updates: Partial<RelayWebSocketAttachment>,
  ): void {
    for (const socket of this.state.getWebSockets?.() ?? []) {
      const attachment = this.readSocketAttachment(socket);
      if (
        attachment?.endpoint !== AcpRemoteEndpointKind.Client ||
        attachment.connectionId !== connectionId
      ) {
        continue;
      }
      this.updateSocketAttachment(socket, updates);
    }
  }

  private async readClientStateSnapshot(
    connectionId: string,
  ): Promise<AcpRelayClientStateSnapshot | undefined> {
    return readClientStateSnapshotFromStorage(this.state.storage, connectionId);
  }

  private async writeOrDeleteClientStateSnapshot(
    connectionId: string,
  ): Promise<void> {
    const snapshot = this.broker.clientStateSnapshot(connectionId);
    if (!snapshot) {
      await this.deleteClientStateSnapshot(connectionId);
      return;
    }
    await this.writeClientStateSnapshot(snapshot);
  }

  private async writeAllClientStateSnapshots(): Promise<void> {
    await Promise.all(
      this.broker
        .clientConnectionIds()
        .map((connectionId) =>
          this.writeOrDeleteClientStateSnapshot(connectionId),
        ),
    );
  }

  private async writeClientStateSnapshot(
    snapshot: AcpRelayClientStateSnapshot,
  ): Promise<void> {
    await writeClientStateSnapshotToStorage(this.state.storage, snapshot);
  }

  private async deleteClientStateSnapshot(connectionId: string): Promise<void> {
    await deleteClientStateSnapshotFromStorage(this.state.storage, connectionId);
  }

  private async authorize(request: Request, url: URL): Promise<Response> {
    const accountId = resolveVerifiedAccountId(request);
    if (!accountId) {
      return new Response("ACP relay account session is required.", {
        status: 401,
      });
    }
    const connectionId = url.searchParams.get("connectionId");
    if (!connectionId) {
      return new Response("Missing connection id.", { status: 400 });
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return json({ error: body.reason }, { status: 400 });
      }
      const record = asRecord(body.value);
      if (!record) {
        return json({ error: "Request body must be an object." }, { status: 400 });
      }
      const hostIdResult = readRequiredString(record, "hostId");
      if (!hostIdResult.ok) {
        return json({ error: hostIdResult.reason }, { status: 400 });
      }
      const hostId = hostIdResult.value;
      const agentCommandResult = readOptionalString(record, "agentCommand");
      const agentIdResult = readOptionalString(record, "agentId");
      const agentTypeResult = readOptionalString(record, "agentType");
      const sessionSelectionIdResult = readOptionalString(
        record,
        "sessionSelectionId",
      );
      const workspaceRootsResult = readOptionalStringArray(record, "workspaceRoots");
      const agentCommand = agentCommandResult.ok ? agentCommandResult.value : undefined;
      const agentId = agentIdResult.ok ? agentIdResult.value : undefined;
      const agentType = agentTypeResult.ok ? agentTypeResult.value : undefined;
      const sessionSelectionId =
        (sessionSelectionIdResult.ok ? sessionSelectionIdResult.value : undefined) ??
        url.searchParams.get("sessionSelectionId") ??
        undefined;
      const workspaceRoots = workspaceRootsResult.ok ? workspaceRootsResult.value : undefined;
      const clientAgent = agentCommand
        ? { command: agentCommand, type: agentType ?? undefined }
        : agentId
          ? { id: agentId }
        : undefined;
      const result = await this.broker.authorizeClient({
        clientAgent,
        connectionId,
        hostId,
        sessionSelectionId,
        workspaceRoots,
      });
      if (result.ok) {
        this.updateClientSocketAttachmentByConnectionId(connectionId, {
          routeReady: true,
          hostId: result.hostId,
        });
        await this.writeOrDeleteClientStateSnapshot(connectionId);
      }
      return json(result, { status: result.ok ? 200 : 404 });
    }

    const hostsResult = await this.broker.discoverableHostsForConnection(connectionId);
    const fallbackHostsResult = hostsResult.ok
      ? undefined
      : await this.broker.discoverableHostsForAccount({
        accountId,
        clientId:
          request.headers.get("x-acp-verified-client-id") ??
          request.headers.get("x-acp-verified-principal-id") ??
          undefined,
      });
    const hosts = hostsResult.ok
      ? hostsResult.hosts
      : fallbackHostsResult?.ok
        ? fallbackHostsResult.hosts
        : hostsResult.hosts ?? [];
    if (url.pathname === "/api/authorize") {
      return json({
        accountId,
        connectionId,
        hosts,
        unavailableReason: hostsResult.ok ? undefined : hostsResult.reason,
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      });
    }
    return html(
      createRelayAuthorizationPage({
        accountId,
        connectionId,
        hosts,
        requestUrl: request.url,
        unavailableReason: hostsResult.ok ? undefined : hostsResult.reason,
      }),
      { status: hostsResult.ok ? 200 : 410 },
    );
  }

  private async handleHostApi(request: Request, url: URL): Promise<Response> {
    const workspaceMatch = url.pathname.match(/^\/api\/hosts\/([^/]+)\/workspaces$/);
    if (workspaceMatch) {
      const connectionId = url.searchParams.get("connectionId");
      const root = url.searchParams.get("root");
      if (!connectionId || !root) {
        return json({ ok: false, reason: "Missing connectionId or root." }, { status: 400 });
      }
      const result = await this.broker.listHostWorkspaceDirectory({
        connectionId,
        hostId: decodeURIComponent(workspaceMatch[1]),
        path: url.searchParams.get("path") ?? undefined,
        root,
      });
      return json(result, { status: result.ok ? 200 : 404 });
    }

    const match = url.pathname.match(/^\/api\/hosts\/(.+)$/);
    if (!match) {
      const accountId = resolveVerifiedAccountId(request);
      if (!accountId) {
        return json({ error: "ACP relay account session is required." }, { status: 401 });
      }
      const clientId =
        request.headers.get("x-acp-verified-client-id") ??
        request.headers.get("x-acp-verified-principal-id") ??
        "";
      const result = await this.broker.discoverableHosts({ accountId, clientId });
      if (!result.ok) {
        return json({ error: result.reason }, { status: 410 });
      }
      return json({
        hosts: result.hosts,
      });
    }
    const hostId = decodeURIComponent(match[1]);
    const accountId = resolveVerifiedAccountId(request);
    if (!accountId) {
      return json({ error: "ACP relay account session is required." }, { status: 401 });
    }
    const clientId =
      request.headers.get("x-acp-verified-client-id") ??
      request.headers.get("x-acp-verified-principal-id") ??
      "";
    if (request.method === "PATCH") {
      const body = await readJsonBody(request);
      if (!body.ok) {
        return json({ error: body.reason }, { status: 400 });
      }
      const record = asRecord(body.value);
      if (!record) {
        return json({ error: "Request body must be an object." }, { status: 400 });
      }
      const rawName = record.name;
      if (typeof rawName !== "string") {
        return json({ error: "name must be a string." }, { status: 400 });
      }
      const name = rawName.trim();
      if (name.length > 80) {
        return json({ error: "name must be 80 characters or fewer." }, { status: 400 });
      }
      const update = await this.broker.setHostDisplayName({
        accountId,
        clientId,
        hostId,
        name,
      });
      if (!update.ok) {
        return json({ error: update.reason }, { status: update.status });
      }
      return json(update.host);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed." }, {
        headers: { allow: "GET, HEAD, PATCH" },
        status: 405,
      });
    }
    const result = await this.broker.discoverableHosts({
      accountId,
      clientId,
      hostId,
    });
    if (!result.ok) {
      return json({ error: result.reason }, { status: 410 });
    }
    const host = result.hosts[0];
    if (!host) {
      return json({ error: "Host not found." }, { status: 404 });
    }
    return json(host);
  }

  private async handleSessionsApi(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "Method not allowed." }, {
        headers: { allow: "GET, HEAD" },
        status: 405,
      });
    }
    const accountId = resolveVerifiedAccountId(request);
    if (!accountId) {
      return json({ error: "ACP relay account session is required." }, { status: 401 });
    }
    const clientId =
      request.headers.get("x-acp-verified-client-id") ??
      request.headers.get("x-acp-verified-principal-id") ??
      "";
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : undefined;
    const result = await this.broker.listSessions({
      accountId,
      clientId,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    return json({ sessions: result.sessions }, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  private async handleAttachmentUpload(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        headers: { allow: "POST" },
        status: 405,
      });
    }
    const accountId = resolveVerifiedAccountId(request);
    const clientId =
      request.headers.get("x-acp-verified-client-id") ??
      request.headers.get("x-acp-verified-principal-id") ??
      undefined;
    if (!accountId || !clientId) {
      return json({ ok: false, reason: "Connection proof is required." }, { status: 401 });
    }
    const connectionId = url.searchParams.get("connectionId");
    const hostId = resolveHostId(request, url);
    const attachmentId =
      request.headers.get("x-free-attachment-id") ??
      url.searchParams.get("attachmentId");
    const messageId =
      request.headers.get("x-free-message-id") ??
      url.searchParams.get("messageId");
    if (!connectionId || !hostId || !attachmentId || !messageId) {
      return json(
        { ok: false, reason: "Missing connectionId, hostId, messageId, or attachmentId." },
        { status: 400 },
      );
    }
    const mimeType = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (!mimeType?.startsWith("image/")) {
      return json({ ok: false, reason: "Only image attachments are supported." }, { status: 415 });
    }
    const declaredLength = readContentLength(request);
    if (declaredLength !== undefined && declaredLength > MAX_RELAY_ATTACHMENT_BYTES) {
      return json({ ok: false, reason: "Attachment body is too large." }, { status: 413 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0) {
      return json({ ok: false, reason: "Attachment body is empty." }, { status: 400 });
    }
    if (body.byteLength > MAX_RELAY_ATTACHMENT_BYTES) {
      return json({ ok: false, reason: "Attachment body is too large." }, { status: 413 });
    }
    const expectedSha256 = request.headers.get("x-free-attachment-sha256");
    const sha256 = await sha256Hex(body);
    if (expectedSha256 && expectedSha256 !== sha256) {
      return json({ ok: false, reason: "Attachment checksum mismatch." }, { status: 400 });
    }
    const input: AcpRelayAttachmentForwardInput = {
      accountId,
      attachmentId,
      body,
      clientId,
      connectionId,
      hostId,
      messageId,
      mimeType,
      sha256,
    };
    const result = await this.broker.forwardClientAttachment(input);
    return json(result, { status: result.ok ? 200 : 404 });
  }

  private removeSocket(
    endpoint: AcpRemoteEndpointKind,
    connectionId: string,
    hostId: string | undefined,
    socket: WebSocket,
    close?: { code?: number; final?: boolean; reason?: string },
  ): void {
    if (endpoint === AcpRemoteEndpointKind.Host) {
      if (hostId) {
        this.broker.removeHost(hostId, socket);
      }
      return;
    }

    this.broker.removeClient(connectionId, socket, {
      final:
        close?.final ??
        (close?.code === 1000 &&
          close.reason === "ACP client connection closed."),
    });
  }

  private async scheduleHeartbeat(): Promise<void> {
    if (
      !this.heartbeatIntervalMs ||
      (this.broker.activeHostRouteIds().length === 0 &&
        !this.broker.hasPendingHostReconnects() &&
        !this.broker.hasPendingClientReconnects())
    ) {
      return;
    }

    await this.state.storage.setAlarm(Date.now() + this.heartbeatIntervalMs);
  }

  private async reconcileAuthorizations(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        headers: { allow: "POST" },
        status: 405,
      });
    }

    const closedConnectionIds = await this.broker.reconcileAuthorizedRoutes();
    await Promise.all(
      closedConnectionIds.map((connectionId) =>
        this.deleteClientStateSnapshot(connectionId),
      ),
    );
    return json({
      closedConnectionIds,
      ok: true,
    });
  }
}

function readAccountSessionVerificationKeys(env: Env):
  | {
      ok: true;
      keys: readonly [
        AcpRemoteAccountSessionVerificationKey,
        ...AcpRemoteAccountSessionVerificationKey[],
      ];
    }
  | {
      ok: false;
      reason: string;
    } {
  try {
    return {
      keys: readAcpRemoteAccountSessionVerificationKeys(
        env.ACP_RELAY_ACCOUNT_SESSION_PUBLIC_KEYS,
      ),
      ok: true,
    };
  } catch {
    return {
      ok: false,
      reason: "ACP account session verification keys are invalid.",
    };
  }
}

function readAccountSessionSigningKey(env: Env):
  | {
      ok: true;
      key: AcpRemoteAccountSessionSigningKey;
    }
  | {
      ok: false;
      reason: string;
    } {
  const kid = env.ACP_RELAY_ACCOUNT_SESSION_KEY_ID;
  const privateKey = env.ACP_RELAY_ACCOUNT_SESSION_PRIVATE_KEY;
  if (!kid || !privateKey) {
    return {
      ok: false,
      reason: "ACP account session signing key is not configured.",
    };
  }
  return {
    key: { kid, privateKey },
    ok: true,
  };
}

function createAuthorizationSessionFailureResponse(input: {
  env: Env;
  failure: {
    reason: string;
    status: number;
  };
  request: Request;
  url: URL;
}): Response {
  if (input.failure.status === 401 && input.env.ACP_RELAY_GITHUB_CLIENT_ID) {
    const loginUrl = createWorkbenchLoginStartUrl({
      env: input.env,
      request: input.request,
      returnTo: input.request.url,
    });
    if (loginUrl) {
      return Response.redirect(loginUrl.toString(), 302);
    }
  }

  return html(
    createRelayAccountSessionRequiredPage({
      reason: input.failure.reason,
    }),
    { status: input.failure.status },
  );
}

function createLogoutResponse(request: Request, env: Env): Response {
  const returnUrl = new URL("/", resolveWorkbenchOrigin({ env, request }) ?? request.url);
  return new Response(null, {
    headers: {
      Location: returnUrl.toString(),
      "Set-Cookie": createExpiredAccountSessionCookie(request),
    },
    status: 302,
  });
}

function isWorkbenchApiCorsPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/api/session" ||
    pathname === "/api/sessions" ||
    pathname === "/api/login/start" ||
    pathname === "/api/login/callback" ||
    pathname === "/api/login/confirm" ||
    pathname.startsWith("/api/login/approvals/") ||
    pathname === "/api/authorize" ||
    pathname === "/api/hosts" ||
    pathname.startsWith("/api/hosts/")
  );
}

function createWorkbenchApiCorsPreflightResponse(request: Request, env: Env): Response {
  return new Response(null, {
    headers: createWorkbenchApiCorsHeaders(request, env, {
      "Access-Control-Allow-Headers": "authorization, content-type, x-acp-account-id",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, PATCH, POST",
      "Access-Control-Max-Age": "600",
    }),
    status: 204,
  });
}

function withWorkbenchApiCors(
  response: Response,
  request: Request,
  env: Env,
): Response {
  const headers = new Headers(response.headers);
  createWorkbenchApiCorsHeaders(request, env).forEach((value, key) => {
    headers.set(key, value);
  });
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function createWorkbenchApiCorsHeaders(
  request: Request,
  env: Env,
  extraHeaders: HeadersInit = {},
): Headers {
  const headers = new Headers(extraHeaders);
  const origin = request.headers.get("origin");
  if (origin && isAllowedWorkbenchOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
  return headers;
}

function isAllowedWorkbenchOrigin(origin: string, env: Env): boolean {
  try {
    const url = new URL(origin);
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "8790"
    ) {
      return true;
    }
    return env.ACP_RELAY_WORKBENCH_ORIGIN !== undefined &&
      normalizeOrigin(env.ACP_RELAY_WORKBENCH_ORIGIN) === url.origin;
  } catch {
    return false;
  }
}

function withVerifiedConnectionProof(
  request: Request,
  proof: Extract<AcpRemoteConnectionProofVerificationResult, { ok: true }>,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-acp-verified-account-id", proof.accountId);
  headers.set("x-acp-verified-client-id", proof.clientId);
  headers.set("x-acp-verified-principal-id", proof.clientId);
  headers.set("x-acp-verified-principal-type", "client");
  return new Request(request, { headers });
}

function readContentLength(request: Request): number | undefined {
  const raw = request.headers.get("content-length");
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(data.byteLength);
  bytes.set(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createRelayAccountSessionRequiredPage(input: {
  body?: string;
  heading?: string;
  reason: string;
  title?: string;
}): string {
  const title = input.title ?? "Free Authorization";
  const heading = input.heading ?? "Authorize Free";
  const body = input.body ?? "Sign in to continue this remote ACP authorization.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8f5;
        --surface: #ffffff;
        --ink: #18211d;
        --muted: #5d6862;
        --line: #d8ddd7;
        --accent: #176b56;
        --accent-ink: #f4fbf7;
        --warn: #b26b23;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
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
        background: color-mix(in oklch, var(--surface) 86%, var(--bg));
      }
      .brand { font-weight: 720; letter-spacing: 0; }
      .status {
        border: 1px solid color-mix(in oklch, var(--warn) 32%, var(--line));
        border-radius: 999px;
        color: var(--warn);
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
        width: min(640px, 100%);
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--surface);
        padding: clamp(24px, 5vw, 40px);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(1.55rem, 4vw, 2.25rem);
        line-height: 1.08;
        letter-spacing: 0;
      }
      p { margin: 0; color: var(--muted); }
      .reason {
        margin-top: 18px;
        border-left: 3px solid var(--warn);
        padding-left: 12px;
        color: var(--ink);
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin-top: 26px;
      }
      .primary {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 42px;
        border-radius: 7px;
        background: var(--accent);
        color: var(--accent-ink);
        padding: 0 16px;
        font-weight: 680;
        text-decoration: none;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.9em;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand">Free</div>
        <div class="status">Sign in required</div>
      </header>
      <main>
        <section class="panel" aria-labelledby="title">
          <h1 id="title">${escapeHtml(heading)}</h1>
          <p>${escapeHtml(body)}</p>
          <p class="reason">${escapeHtml(input.reason)}</p>
        </section>
      </main>
    </div>
  </body>
</html>`;
}

const SESSION_COOKIE_NAME = "acp_relay_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_APPROVAL_TTL_MS = 10 * 60 * 1000;

type LoginApproval = {
  accountId: string;
  approvalId: string;
  createdAt: number;
  githubLogin: string;
  principalId: string;
  principalType: "client" | "host";
  publicKey?: string;
  returnTo: string;
};

async function handleGitHubAuthRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const clientId = env.ACP_RELAY_GITHUB_CLIENT_ID;
  const clientSecret = env.ACP_RELAY_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return withWorkbenchApiCors(
      json({ error: "GitHub sign in is not configured for this relay." }, { status: 503 }),
      request,
      env,
    );
  }
  const signingKey = readAccountSessionSigningKey(env);
  if (!signingKey.ok) {
    return withWorkbenchApiCors(
      json({ error: signingKey.reason }, { status: 503 }),
      request,
      env,
    );
  }
  const db = env.ACP_RELAY_DB;
  if (!db) {
    return withWorkbenchApiCors(
      json({ error: "GitHub OAuth requires a database (D1)." }, { status: 503 }),
      request,
      env,
    );
  }

  if (url.pathname === "/api/login/confirm") {
    return handleLoginConfirmationRequest({
      db,
      env,
      request,
      signingKey: signingKey.key,
    });
  }

  if (url.pathname === "/api/login/start") {
    if (request.method !== "GET") {
      return withWorkbenchApiCors(
        json({ error: "Method not allowed." }, {
          headers: { allow: "GET" },
          status: 405,
        }),
        request,
        env,
      );
    }
    const returnTo = url.searchParams.get("returnTo") ??
      resolveDefaultWorkbenchReturnTo(request, env);
    const redirectUri = url.searchParams.get("redirectUri") ??
      new URL("/login/callback", resolveDefaultWorkbenchReturnTo(request, env)).toString();
    const redirectUrl = new URL(redirectUri);
    if (!isAllowedWorkbenchOrigin(redirectUrl.origin, env)) {
      return withWorkbenchApiCors(
        json({ error: "redirectUri must point to the Workbench origin." }, { status: 400 }),
        request,
        env,
      );
    }
    const state = crypto.randomUUID();
    const stateStore = await openOAuthStateStore(env);
    await stateStore.put(state, returnTo);
    return withWorkbenchApiCors(
      json({
        authorizationUrl: createGitHubAuthorizationUrl(
          { clientId, clientSecret },
          state,
          redirectUrl.origin,
        ),
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      }),
      request,
      env,
    );
  }

  if (url.pathname === "/api/login/callback") {
    if (request.method !== "POST") {
      return withWorkbenchApiCors(
        json({ error: "Method not allowed." }, {
          headers: { allow: "POST" },
          status: 405,
        }),
        request,
        env,
      );
    }
    const parsed = await readJsonBody(request);
    const record = parsed.ok ? asRecord(parsed.value) : undefined;
    const code = typeof record?.code === "string" ? record.code : "";
    const state = typeof record?.state === "string" ? record.state : "";
    if (!code || !state) {
      return withWorkbenchApiCors(
        json({ error: "Missing code or state parameter." }, { status: 400 }),
        request,
        env,
      );
    }
    const result = await createLoginApprovalFromGitHubCallback({
      clientId,
      clientSecret,
      code,
      db,
      env,
      request,
      state,
    });
    if (!result.ok) {
      return withWorkbenchApiCors(
        json({ error: result.reason }, { status: result.status }),
        request,
        env,
      );
    }
    return withWorkbenchApiCors(
      json({
        approvalUrl: createWorkbenchLoginApprovalUrl({
          approvalId: result.approval.approvalId,
          env,
          request,
          returnTo: result.approval.returnTo,
        })?.toString(),
      }, {
        headers: {
          "Cache-Control": "no-store",
        },
      }),
      request,
      env,
    );
  }

  return json({ error: "Not found." }, { status: 404 });
}

async function createLoginApprovalFromGitHubCallback(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  db: D1Database;
  env: Env;
  request: Request;
  state: string;
}): Promise<
  | { ok: true; approval: LoginApproval }
  | { ok: false; reason: string; status: number }
> {
  const returnTo = await getOAuthStateReturnTo(input.state, input.env);
  if (returnTo === undefined) {
    return { ok: false, reason: "Invalid or expired OAuth state.", status: 400 };
  }

  let user;
  try {
    const accessToken = await exchangeGitHubCodeForAccessToken(
      { clientId: input.clientId, clientSecret: input.clientSecret },
      input.code,
    );
    user = await fetchGitHubUser(accessToken);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "GitHub OAuth failed.",
      status: 502,
    };
  }

  const githubStore = new D1GitHubAccountStore(input.db);
  const githubAccount = await resolveOrCreateGithubAccount(githubStore, user);
  const accountId = githubAccount.accountId;
  await new AcpRelayD1ControlPlaneStore(input.db).upsertAccount({ accountId });
  const principal = resolveLoginPrincipal(returnTo);
  const approval: LoginApproval = {
    accountId,
    approvalId: crypto.randomUUID(),
    createdAt: Date.now(),
    githubLogin: githubAccount.githubLogin,
    principalId: principal.principalId,
    principalType: principal.principalType,
    ...(principal.publicKey ? { publicKey: principal.publicKey } : {}),
    returnTo,
  };
  await openLoginApprovalStore(input.db).put(approval);
  return { ok: true, approval };
}

function createWorkbenchLoginApprovalUrl(input: {
  approvalId: string;
  env: Env;
  request: Request;
  returnTo: string;
}): URL | undefined {
  const workbenchOrigin = resolveWorkbenchOrigin(input);
  if (!workbenchOrigin) {
    return undefined;
  }
  const approvalUrl = new URL("/login/approve", workbenchOrigin);
  approvalUrl.searchParams.set("approvalId", input.approvalId);
  return approvalUrl;
}

function resolveWorkbenchOrigin(input: {
  env: Env;
  request: Request;
  returnTo?: string;
}): string | undefined {
  const requestOrigin = input.request.headers.get("origin");
  if (requestOrigin && isAllowedWorkbenchOrigin(requestOrigin, input.env)) {
    return new URL(requestOrigin).origin;
  }

  const relayLocalOrigin = deriveLocalWorkbenchOriginFromRelayRequest(input.request);
  if (relayLocalOrigin) {
    return relayLocalOrigin;
  }

  const configuredOrigin = readConfiguredWorkbenchOrigin(input.env);
  if (configuredOrigin) {
    return configuredOrigin;
  }

  if (!input.returnTo) {
    return undefined;
  }
  try {
    const returnUrl = new URL(input.returnTo, input.request.url);
    if (isAllowedWorkbenchOrigin(returnUrl.origin, input.env)) {
      return returnUrl.origin;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function createWorkbenchLoginStartUrl(input: {
  env: Env;
  request: Request;
  returnTo: string;
}): URL | undefined {
  const workbenchOrigin = resolveWorkbenchOrigin(input);
  if (!workbenchOrigin) {
    return undefined;
  }
  const loginUrl = new URL("/login/start", workbenchOrigin);
  loginUrl.searchParams.set("returnTo", input.returnTo);
  return loginUrl;
}

function resolveDefaultWorkbenchReturnTo(request: Request, env: Env): string {
  return resolveWorkbenchOrigin({ env, request }) ?? "http://127.0.0.1:8790/";
}

function readConfiguredWorkbenchOrigin(env: Env): string | undefined {
  if (!env.ACP_RELAY_WORKBENCH_ORIGIN) {
    return undefined;
  }
  return normalizeOrigin(env.ACP_RELAY_WORKBENCH_ORIGIN);
}

function deriveLocalWorkbenchOriginFromRelayRequest(request: Request): string | undefined {
  try {
    const url = new URL(request.url);
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port === "8791"
    ) {
      return "http://127.0.0.1:8790";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

async function handleLoginApprovalApi(input: {
  db: D1Database;
  env: Env;
  request: Request;
  url: URL;
}): Promise<Response> {
  if (input.request.method !== "GET") {
    return withWorkbenchApiCors(
      json({ error: "Method not allowed." }, {
        headers: { allow: "GET" },
        status: 405,
      }),
      input.request,
      input.env,
    );
  }
  const match = input.url.pathname.match(/^\/api\/login\/approvals\/([^/]+)$/);
  const approvalId = match ? decodeURIComponent(match[1]) : "";
  if (!approvalId) {
    return withWorkbenchApiCors(
      json({ error: "Missing approval id." }, { status: 400 }),
      input.request,
      input.env,
    );
  }
  const approval = await openLoginApprovalStore(input.db).get(approvalId);
  if (!approval) {
    return withWorkbenchApiCors(
      json({ error: "Login approval is expired or unavailable." }, { status: 404 }),
      input.request,
      input.env,
    );
  }
  return withWorkbenchApiCors(
    json({
      accountId: approval.accountId,
      approvalId: approval.approvalId,
      createdAt: approval.createdAt,
      githubLogin: approval.githubLogin,
      principalId: approval.principalId,
      principalType: approval.principalType,
      returnTo: approval.returnTo,
    }, {
      headers: {
        "Cache-Control": "no-store",
      },
    }),
    input.request,
    input.env,
  );
}

async function handleLoginConfirmationRequest(input: {
  db: D1Database;
  env: Env;
  request: Request;
  signingKey: AcpRemoteAccountSessionSigningKey;
}): Promise<Response> {
  if (input.request.method !== "POST") {
    const response = html(createLoginApprovalUnavailablePage({
      message: "Open the login link from Free again to approve this device.",
    }), { status: 405 });
    return withWorkbenchApiCors(response, input.request, input.env);
  }

  const approvalId = await readLoginApprovalId(input.request);
  if (!approvalId) {
    const response = html(createLoginApprovalUnavailablePage({
      message: "The login confirmation request was missing its approval id.",
    }), { status: 400 });
    return withWorkbenchApiCors(response, input.request, input.env);
  }

  const approval = await openLoginApprovalStore(input.db).consume(approvalId);
  if (!approval || Date.now() - approval.createdAt > LOGIN_APPROVAL_TTL_MS) {
    const response = html(createLoginApprovalUnavailablePage({
      message: "This login approval expired. Run `free auth login --force` to start again.",
    }), { status: 410 });
    return withWorkbenchApiCors(response, input.request, input.env);
  }

  const principalPublicKey =
    approval.publicKey ?? await createEphemeralLoginPublicKey();
  const session = await createAcpRemoteAccountSession({
    accountId: approval.accountId,
    principalId: approval.principalId,
    principalPublicKey,
    principalType: approval.principalType,
    signingKey: input.signingKey,
    ttlMs: SESSION_MAX_AGE_SECONDS * 1000,
  });
  const accountSession = encodeAcpRelayAccountSession(session);
  if (wantsJsonLoginConfirmation(input.request)) {
    return createAccountSessionJsonResponse({
      accountId: approval.accountId,
      accountSession,
      env: input.env,
      request: input.request,
      returnTo: approval.returnTo,
    });
  }
  return createAccountSessionRedirectResponse({
    accountId: approval.accountId,
    accountSession,
    request: input.request,
    returnTo: approval.returnTo,
  });
}

async function readLoginApprovalId(request: Request): Promise<string | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  const normalizedContentType = contentType.toLowerCase();
  if (
    normalizedContentType.includes("application/x-www-form-urlencoded") ||
    normalizedContentType.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    const value = form.get("approvalId");
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  const parsed = await readJsonBody(request);
  if (parsed.ok) {
    const record = asRecord(parsed.value);
    const value = record?.approvalId;
    return typeof value === "string" && value.trim() ? value : undefined;
  }
  return undefined;
}

function createAccountSessionRedirectResponse(input: {
  accountId: string;
  accountSession: string;
  request: Request;
  returnTo: string;
}): Response {
  const redirectUrl = buildAccountSessionReturnUrl(input);
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl.toString(),
      "Set-Cookie": createAccountSessionCookie(input.request, input.accountSession),
    },
  });
}

function createAccountSessionJsonResponse(input: {
  accountId: string;
  accountSession: string;
  env: Env;
  request: Request;
  returnTo: string;
}): Response {
  return withWorkbenchApiCors(
    json({
      accountId: input.accountId,
      callbackUrl: buildAccountSessionReturnUrl(input).toString(),
    }, {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": createAccountSessionCookie(input.request, input.accountSession),
      },
    }),
    input.request,
    input.env,
  );
}

function buildAccountSessionReturnUrl(input: {
  accountId: string;
  accountSession: string;
  request: Request;
  returnTo: string;
}): URL {
  const redirectUrl = input.returnTo
    ? new URL(input.returnTo, input.request.url)
    : new URL("/authorize", input.request.url);
  if (shouldReturnAccountSessionInQuery(redirectUrl)) {
    redirectUrl.searchParams.delete("accountSessionReturn");
    redirectUrl.searchParams.set("accountSession", input.accountSession);
    redirectUrl.searchParams.set("accountId", input.accountId);
  }
  return redirectUrl;
}

function createAccountSessionCookie(request: Request, accountSession: string): string {
  return `${SESSION_COOKIE_NAME}=${accountSession}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${shouldUseSecureCookie(request) ? "; Secure" : ""}`;
}

function createExpiredAccountSessionCookie(request: Request): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${shouldUseSecureCookie(request) ? "; Secure" : ""}`;
}

function shouldUseSecureCookie(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:";
}

function wantsJsonLoginConfirmation(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === "application/json" || part.startsWith("application/json;"));
}

function createLoginApprovalUnavailablePage(input: { message: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Free Login</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f7f8f5;
        color: #18211d;
        font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 24px;
      }
      section {
        width: min(560px, 100%);
        border: 1px solid #d8ddd7;
        border-radius: 8px;
        background: #ffffff;
        padding: 30px;
      }
      h1 { margin: 0 0 10px; font-size: 1.7rem; letter-spacing: 0; }
      p { margin: 0; color: #5d6862; }
    </style>
  </head>
  <body>
    <section>
      <h1>Login approval unavailable</h1>
      <p>${escapeHtml(input.message)}</p>
    </section>
  </body>
</html>`;
}

function shouldReturnAccountSessionInQuery(url: URL): boolean {
  return (
    isLocalhostUrl(url) &&
    url.searchParams.get("accountSessionReturn") === "query" &&
    url.searchParams.get("accountSessionPrincipalId") !== null &&
    url.searchParams.get("accountSessionPublicKey") !== null
  );
}

function resolveLoginPrincipal(returnTo: string | undefined): {
  principalId: string;
  principalType: "client" | "host";
  publicKey?: string;
} {
  if (!returnTo) {
    return {
      principalId: "web",
      principalType: "client",
    };
  }
  try {
    const url = new URL(returnTo);
    const principalId =
      url.searchParams.get("accountSessionPrincipalId") ?? "web";
    const principalType =
      url.searchParams.get("accountSessionPrincipalType") === "host"
        ? "host"
        : "client";
    const publicKey =
      url.searchParams.get("accountSessionPublicKey") ?? undefined;
    return {
      principalId,
      principalType,
      ...(publicKey ? { publicKey } : {}),
    };
  } catch {
    return {
      principalId: "web",
      principalType: "client",
    };
  }
}

async function createEphemeralLoginPublicKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  return exportEd25519PublicKey(pair.publicKey);
}

async function getOAuthStateReturnTo(
  state: string,
  env: Env,
): Promise<string | undefined> {
  const stateStore = await openOAuthStateStore(env);
  return stateStore.get(state);
}

interface OAuthStateStore {
  put(state: string, returnTo: string): Promise<void>;
  get(state: string): Promise<string | undefined>;
}

async function openOAuthStateStore(env: Env): Promise<OAuthStateStore> {
  if (env.ACP_RELAY_DB) {
    return new D1OAuthStateStore(env.ACP_RELAY_DB);
  }
  throw new Error("OAuth requires a database (D1).");
}

class D1OAuthStateStore implements OAuthStateStore {
  constructor(private readonly db: D1Database) {}

  async put(state: string, returnTo: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO acp_oauth_states (state, return_to, created_at) VALUES (?, ?, ?) ON CONFLICT(state) DO UPDATE SET return_to = ?, created_at = ?",
      )
      .bind(state, returnTo, Date.now(), returnTo, Date.now())
      .run();
  }

  async get(state: string): Promise<string | undefined> {
    const row = await this.db
      .prepare(
        "SELECT return_to FROM acp_oauth_states WHERE state = ? AND created_at > ?",
      )
      .bind(state, Date.now() - 10 * 60 * 1000)
      .first<{ return_to: string }>();
    if (row) {
      await this.db
        .prepare("DELETE FROM acp_oauth_states WHERE state = ?")
        .bind(state)
        .run();
    }
    return row?.return_to;
  }
}

interface LoginApprovalStore {
  get(approvalId: string): Promise<LoginApproval | undefined>;
  put(approval: LoginApproval): Promise<void>;
  consume(approvalId: string): Promise<LoginApproval | undefined>;
}

function openLoginApprovalStore(db: D1Database): LoginApprovalStore {
  return new D1LoginApprovalStore(db);
}

class D1LoginApprovalStore implements LoginApprovalStore {
  constructor(private readonly db: D1Database) {}

  async get(approvalId: string): Promise<LoginApproval | undefined> {
    const row = await this.db
      .prepare(
        `SELECT approval_id, account_id, github_login, principal_id,
                principal_type, principal_public_key, return_to, created_at
         FROM acp_login_approvals
         WHERE approval_id = ? AND created_at > ?`,
      )
      .bind(approvalId, Date.now() - LOGIN_APPROVAL_TTL_MS)
      .first<Record<string, unknown>>();
    return row ? readLoginApprovalRow(row) : undefined;
  }

  async put(approval: LoginApproval): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO acp_login_approvals (
           approval_id,
           account_id,
           github_login,
           principal_id,
           principal_type,
           principal_public_key,
           return_to,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        approval.approvalId,
        approval.accountId,
        approval.githubLogin,
        approval.principalId,
        approval.principalType,
        approval.publicKey ?? null,
        approval.returnTo,
        approval.createdAt,
      )
      .run();
  }

  async consume(approvalId: string): Promise<LoginApproval | undefined> {
    const approval = await this.get(approvalId);
    await this.db
      .prepare("DELETE FROM acp_login_approvals WHERE approval_id = ?")
      .bind(approvalId)
      .run();
    return approval;
  }
}

function readLoginApprovalRow(row: Record<string, unknown>): LoginApproval {
  const principalType = row.principal_type === "host" ? "host" : "client";
  const publicKey = typeof row.principal_public_key === "string" &&
    row.principal_public_key.trim()
    ? row.principal_public_key
    : undefined;
  return {
    accountId: String(row.account_id),
    approvalId: String(row.approval_id),
    createdAt: Number(row.created_at),
    githubLogin: String(row.github_login),
    principalId: String(row.principal_id),
    principalType,
    ...(publicKey ? { publicKey } : {}),
    returnTo: String(row.return_to),
  };
}

async function verifyAccountSessionRequest(input: {
  env: Env;
  request: Request;
  requestedAccountId?: string;
}): Promise<
  | {
      ok: true;
      session: AcpRelayAccountSession;
    }
  | {
      ok: false;
      reason: string;
      status: number;
    }
> {
  const verificationKeys = readAccountSessionVerificationKeys(input.env);
  if (!verificationKeys.ok) {
    return {
      ok: false,
      reason: verificationKeys.reason,
      status: 503,
    };
  }

  const value = readAccountSessionValue(input.request);
  if (!value) {
    return {
      ok: false,
      reason: "ACP account session is required.",
      status: 401,
    };
  }

  const verification = await verifyAcpRelayAccountSessionValue({
    value,
    verificationKeys: verificationKeys.keys,
  });
  if (!verification.ok) {
    return {
      ok: false,
      reason: verification.reason,
      status: 401,
    };
  }

  if (
    input.requestedAccountId &&
    input.requestedAccountId !== verification.session.accountId
  ) {
    return {
      ok: false,
      reason: "ACP relay account session does not match requested account.",
      status: 403,
    };
  }

  return {
    ok: true,
    session: verification.session,
  };
}

function readAccountSessionValue(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  const header = request.headers.get("x-acp-account-session");
  if (header) {
    return header;
  }
  const cookie = readCookie(request.headers.get("cookie"), "acp_relay_session");
  if (cookie) {
    return cookie;
  }
  return readLocalhostQueryAccountSessionValue(request);
}

function readLocalhostQueryAccountSessionValue(
  request: Request,
): string | undefined {
  const url = new URL(request.url);
  if (!isLocalhostUrl(url)) {
    return undefined;
  }
  const accountSession = url.searchParams.get("accountSession");
  return accountSession && accountSession.trim() ? accountSession : undefined;
}

function isLocalhostUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1"
  );
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [cookieName, ...valueParts] = part.trim().split("=");
    if (cookieName === name && valueParts.length > 0) {
      return valueParts.join("=");
    }
  }
  return undefined;
}

async function verifyHostRegistrationRequest(input: {
  accountId: string;
  env: Env;
  hostId: string;
  request: Request;
}): Promise<
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  if (!input.env.ACP_RELAY_DB) {
    return { ok: false, reason: "Host registry is not configured." };
  }
  const store = new AcpRelayD1ControlPlaneStore(input.env.ACP_RELAY_DB);
  let host = await store.getHost({
    accountId: input.accountId,
    hostId: input.hostId,
  });
  if (!host) {
    const registration = await tryAutoRegisterHost({
      accountId: input.accountId,
      hostId: input.hostId,
      env: input.env,
      request: input.request,
      store,
    });
    if (!registration.ok) {
      return registration;
    }
    host = registration.host;
  }
  if (!host || host.disabled) {
    return { ok: false, reason: "Host is not registered for this account." };
  }

  const hostPublicKeys = [host?.publicKey, host?.previousPublicKey].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  if (hostPublicKeys.length === 0) {
    return {
      ok: false,
      reason: "Host registration proof key is not configured.",
    };
  }

  const proof = await verifyHostRegistrationProof({
    accountId: input.accountId,
    hostId: input.hostId,
    nonce: input.request.headers.get("x-acp-host-nonce") ?? "",
    publicKeys: hostPublicKeys,
    signature: input.request.headers.get("x-acp-host-signature") ?? "",
    timestamp: input.request.headers.get("x-acp-host-timestamp") ?? "",
  });
  if (proof.ok) {
    return proof;
  }
  const registration = await tryAutoRegisterHost({
    accountId: input.accountId,
    hostId: input.hostId,
    env: input.env,
    request: input.request,
    store,
  });
  return registration.ok ? { ok: true } : proof;
}

async function tryAutoRegisterHost(input: {
  accountId: string;
  hostId: string;
  env: Env;
  request: Request;
  store: AcpRelayD1ControlPlaneStore;
}): Promise<
  | {
      ok: true;
      host: AcpRelayHostRecord;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  const session = await verifyAccountSessionRequest({
    env: input.env,
    request: input.request,
    requestedAccountId: input.accountId,
  });
  if (!session.ok) {
    return {
      ok: false,
      reason: "Host is not registered for this account.",
    };
  }
  const publicKey = input.request.headers.get("x-acp-host-public-key");
  if (!publicKey) {
    return {
      ok: false,
      reason: "Host registration public key is required.",
    };
  }
  const proof = await verifyHostRegistrationProof({
    accountId: input.accountId,
    hostId: input.hostId,
    nonce: input.request.headers.get("x-acp-host-nonce") ?? "",
    publicKey,
    signature: input.request.headers.get("x-acp-host-signature") ?? "",
    timestamp: input.request.headers.get("x-acp-host-timestamp") ?? "",
  });
  if (!proof.ok) {
    return proof;
  }
  const host: AcpRelayHostRecord = {
    accountId: input.accountId,
    hostId: input.hostId,
    publicKey,
  };
  await input.store.upsertAccount({ accountId: input.accountId });
  await input.store.upsertHost(host);
  await input.store.upsertGrant({
    accountId: input.accountId,
    hostId: input.hostId,
    grantId: `default:${input.accountId}:${input.hostId}`,
    policyVersion: 1,
    scopes: DEFAULT_AUTOMATIC_GRANT_SCOPES,
  });
  return { host, ok: true };
}
