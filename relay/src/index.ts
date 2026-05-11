import {
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  createAcpRemoteAccountSession,
  decodeAcpRemoteConnectionProof,
  exportEd25519PublicKey,
  readAcpRemoteAccountSessionVerificationKeys,
  verifyAcpRemoteConnectionProof,
  type AcpRemoteAccountSessionSigningKey,
  type AcpRemoteAccountSessionVerificationKey,
  type AcpRemoteDataFrame,
  type AcpRemoteConnectionProof,
  type AcpRemoteScope,
} from "../../src/protocol/index.js";
import {
  encodeAcpRelayAccountSession,
  verifyAcpRelayAccountSessionValue,
  type AcpRelayAccountSession,
} from "./account-session.js";
import {
  AcpRelayD1ControlPlaneStore,
  type AcpRelayAccountRecord,
  type AcpRelayClientDeviceRecord,
  type AcpRelayGrantRecord,
  type AcpRelayHostRecord,
} from "./control-plane-store.js";
import { verifyHostRegistrationProof } from "./host-auth.js";
import {
  D1GitHubAccountStore,
  createGitHubAuthorizationUrl,
  exchangeGitHubCodeForAccessToken,
  fetchGitHubUser,
  resolveOrCreateGithubAccount,
} from "./github-auth.js";
import {
  AcpRelayBroker,
  createRelayAuthorizationPage,
  type AcpRelayClientStateSnapshot,
  type AcpRelayClientTransport,
  type HostMetadata,
} from "./relay-core.js";
import { createRelayTraceSpan } from "./relay-tracing.js";

export type Env = {
  ACP_RELAY_ACCOUNT_SESSION_KEY_ID?: string;
  ACP_RELAY_ACCOUNT_SESSION_PRIVATE_KEY?: string;
  ACP_RELAY_ACCOUNT_SESSION_PUBLIC_KEYS?: string;
  ACP_RELAY_CONTROL_PLANE_SECRET?: string;
  ACP_RELAY_CLIENT_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_HOST_RECONNECT_GRACE_MS?: string;
  ACP_RELAY_DB?: D1Database;
  ACP_RELAY_GITHUB_CLIENT_ID?: string;
  ACP_RELAY_GITHUB_CLIENT_SECRET?: string;
  ACP_RELAY_HEARTBEAT_INTERVAL_MS?: string;
  ACP_RELAY_HEARTBEAT_TIMEOUT_MS?: string;
  ACP_RELAY_LOGIN_URL?: string;
  ACP_RELAY_MAX_BUFFERED_FRAMES_PER_CONNECTION?: string;
  ACP_RELAY_MAX_QUEUED_FRAMES_PER_CONNECTION?: string;
  ACP_RELAY_MAX_CONNECTIONS_PER_ACCOUNT?: string;
  ACP_RELAY_SHARDS: DurableObjectNamespace;
  FREE_OTLP_ENDPOINT?: string;
  FREE_OTLP_HEADER?: string;
  FREE_OTLP_TOKEN?: string;
};

const UPGRADE_REQUIRED = "Expected WebSocket upgrade.";
const MAX_LOG_UPLOAD_RECORDS = 100;
const MAX_LOG_UPLOAD_BYTES = 512 * 1024;
const RELAY_SOCKET_ATTACHMENT_VERSION = 1;
const RELAY_CLIENT_STATE_STORAGE_PREFIX = "client-state:";
const DEFAULT_AUTOMATIC_GRANT_SCOPES = [
  "acp:connect",
  "acp:session:create",
  "acp:session:list",
  "acp:session:resume",
  "acp:turn:send",
  "acp:turn:cancel",
] as const satisfies readonly AcpRemoteScope[];

function waitUntil(
  state: DurableObjectState,
  promise: Promise<unknown>,
): void {
  const maybeState = state as DurableObjectState & {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
  if (typeof maybeState.waitUntil === "function") {
    maybeState.waitUntil(promise);
    return;
  }
  void promise;
}

type RelayWebSocketAttachment = {
  accountId?: string;
  authUrl?: string;
  routeReady?: boolean;
  clientId?: string;
  connectedAt: number;
  connectionId: string;
  hostId?: string;
  hostMetadata?: HostMetadata;
  endpoint: AcpRemoteEndpointKind;
  nativeClientAck?: boolean;
  connectionProof?: AcpRemoteConnectionProof;
  transport?: AcpRelayClientTransport;
  version: typeof RELAY_SOCKET_ATTACHMENT_VERSION;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (
      url.pathname === "/login" ||
      url.pathname === "/login/callback" ||
      url.pathname === "/login/confirm"
    ) {
      return handleGitHubAuthRequest(request, env, url);
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
      url.pathname !== "/host" &&
      !url.pathname.startsWith("/api/hosts/") &&
      url.pathname !== "/authorize"
    ) {
      return new Response("Not found.", { status: 404 });
    }

    // OAuth and API endpoints that persist data require D1
    if (url.pathname.startsWith("/login") && !env.ACP_RELAY_DB) {
      return new Response("GitHub OAuth requires a database (D1).", { status: 503 });
    }
    if (url.pathname === "/api/logs") {
      return handleRelayLogUploadRequest(request, env);
    }
    if (url.pathname === "/api/otel/logs" || url.pathname === "/api/otel/traces") {
      return handleRelayOtlpProxyRequest(request, env, url);
    }
    if (url.pathname.startsWith("/api/") && !env.ACP_RELAY_DB) {
      return new Response("API endpoints require a database (D1).", { status: 503 });
    }

    if (url.pathname === "/api/session") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
      });
      if (!accountSession.ok) {
        return json({ error: accountSession.reason }, {
          status: accountSession.status,
        });
      }
      return json({
        accountId: accountSession.session.accountId,
        expiresAt: accountSession.session.expiresAt,
        sessionId: accountSession.session.sessionId,
      });
    }

    if (url.pathname === "/api/hosts" || url.pathname.startsWith("/api/hosts/")) {
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
        .fetch(withVerifiedAccountSession(request, accountSession.session));
    }

    if (url.pathname === "/authorize") {
      const accountSession = await verifyAccountSessionRequest({
        env,
        request,
        requestedAccountId: resolveRequestedAccountId(request, url),
      });
      if (!accountSession.ok) {
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
        .fetch(withVerifiedAccountSession(request, accountSession.session));
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
      `[relay-do] alarm fired instance=${this.instanceId} age_ms=${ageMs} hosts=${this.broker.onlineHostIds().length}`,
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
    if (url.pathname === "/authorize") {
      return this.authorize(request, url);
    }

    if (url.pathname === "/api/hosts" || url.pathname.startsWith("/api/hosts/")) {
      return this.handleHostApi(request, url);
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
        this.updateSocketAttachment(server, {
          hostMetadata,
        });
        void (async () => {
          try {
            await this.broker.registerHost(hostId, server, hostMetadata);
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
        nativeClientAck,
        transport: clientTransport,
      });
      this.broker.registerClient({
        accountId,
        authUrl,
        clientId,
        connectionId,
        connectionProof,
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
      await this.broker.registerHost(
        attachment.hostId,
        socket,
        attachment.hostMetadata,
      );
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
    const value = asRecord(socket.deserializeAttachment?.());
    if (!value) {
      return undefined;
    }
    if (value.version !== RELAY_SOCKET_ATTACHMENT_VERSION) {
      return undefined;
    }
    if (
      value.endpoint !== AcpRemoteEndpointKind.Client &&
      value.endpoint !== AcpRemoteEndpointKind.Host
    ) {
      return undefined;
    }
    const connectionId =
      typeof value.connectionId === "string" ? value.connectionId : undefined;
    const connectedAt =
      typeof value.connectedAt === "number" ? value.connectedAt : undefined;
    if (!connectionId || connectedAt === undefined) {
      return undefined;
    }
    return {
      accountId: readAttachmentString(value.accountId),
      authUrl: readAttachmentString(value.authUrl),
      routeReady:
        typeof value.routeReady === "boolean"
          ? value.routeReady
          : undefined,
      clientId: readAttachmentString(value.clientId),
      connectedAt,
      connectionId,
      hostId: readAttachmentString(value.hostId),
      hostMetadata: isHostMetadata(value.hostMetadata)
        ? value.hostMetadata
        : undefined,
      endpoint: value.endpoint,
      nativeClientAck:
        typeof value.nativeClientAck === "boolean"
          ? value.nativeClientAck
          : undefined,
      connectionProof: isConnectionProof(value.connectionProof)
        ? value.connectionProof
        : undefined,
      transport: isRelayClientTransport(value.transport)
        ? value.transport
        : undefined,
      version: RELAY_SOCKET_ATTACHMENT_VERSION,
    };
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
    const storage = this.state.storage as DurableObjectStorage & {
      get?<T = unknown>(key: string): Promise<T | undefined>;
    };
    if (typeof storage.get !== "function") {
      return undefined;
    }
    const value = await storage.get(
      clientStateStorageKey(connectionId),
    );
    return isClientStateSnapshot(value, connectionId) ? value : undefined;
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
    const storage = this.state.storage as DurableObjectStorage & {
      put?<T = unknown>(key: string, value: T): Promise<void>;
    };
    if (typeof storage.put !== "function") {
      return;
    }
    await storage.put(clientStateStorageKey(snapshot.connectionId), snapshot);
  }

  private async deleteClientStateSnapshot(connectionId: string): Promise<void> {
    const storage = this.state.storage as DurableObjectStorage & {
      delete?(key: string): Promise<boolean>;
    };
    if (typeof storage.delete !== "function") {
      return;
    }
    await storage.delete(clientStateStorageKey(connectionId));
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

    const hostsResult = await this.broker.authorizableHosts(connectionId);
    return html(
      createRelayAuthorizationPage({
        accountId,
        connectionId,
        hosts: hostsResult.ok ? hostsResult.hosts : [],
        requestUrl: request.url,
        unavailableReason: hostsResult.ok ? undefined : hostsResult.reason,
      }),
      { status: hostsResult.ok ? 200 : 410 },
    );
  }

  private async handleHostApi(_request: Request, url: URL): Promise<Response> {
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
      return json({
        hosts: this.broker.onlineHostIds().map((hostId) => ({
          hostId,
          metadata: this.broker.getHostMetadata(hostId),
        })),
      });
    }
    const hostId = decodeURIComponent(match[1]);
    const metadata = this.broker.getHostMetadata(hostId);
    if (!metadata) {
      return json({ error: "Host not found or has no metadata." }, { status: 404 });
    }
    return json(metadata);
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
      (this.broker.onlineHostIds().length === 0 &&
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

function resolveHostId(request: Request, url: URL): string | undefined {
  return (
    url.searchParams.get("hostId") ??
    request.headers.get("x-acp-host-id") ??
    undefined
  );
}

function resolveClientId(
  request: Request,
  url: URL,
): string | undefined {
  return (
    url.searchParams.get("clientId") ??
    request.headers.get("x-acp-client-id") ??
    request.headers.get("x-acp-verified-client-id") ??
    undefined
  );
}

function resolveAccountId(request: Request, url: URL, fallback?: string): string | undefined {
  return (
    url.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id") ??
    fallback
  );
}

function resolveRequestedAccountId(
  request: Request,
  url: URL,
): string | undefined {
  return resolveAccountId(request, url);
}

function resolveVerifiedAccountId(request: Request): string | undefined {
  return request.headers.get("x-acp-verified-account-id") ?? undefined;
}

function readConnectionProof(
  request: Request,
  url: URL,
): AcpRemoteConnectionProof | undefined {
  const encoded =
    request.headers.get("x-acp-connection-proof") ??
    url.searchParams.get("connectionProof");
  if (!encoded) {
    return undefined;
  }
  try {
    return decodeAcpRemoteConnectionProof(encoded);
  } catch {
    return undefined;
  }
}

function parseHostMetadataHeaders(request: Request): HostMetadata | undefined {
  const raw = request.headers.get("x-acp-host-metadata");
  if (!raw) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    if (!asRecord(value)) {
      return undefined;
    }
    const agentTypes = Array.isArray(value.agentTypes)
      ? value.agentTypes.filter(
          (a: unknown) =>
            asRecord(a) &&
            (typeof (a as Record<string, unknown>).command === "string" ||
              typeof (a as Record<string, unknown>).id === "string") &&
            typeof (a as Record<string, unknown>).label === "string",
        )
      : [];
    const workspaceRoots = Array.isArray(value.workspaceRoots)
      ? value.workspaceRoots.filter(
          (w: unknown) =>
            asRecord(w) && typeof (w as Record<string, unknown>).path === "string",
        )
      : [];
    const machine =
      typeof value.machine === "string" && value.machine.trim()
        ? value.machine
        : undefined;
    const runtimeInstanceId =
      typeof value.runtimeInstanceId === "string" &&
      value.runtimeInstanceId.trim()
        ? value.runtimeInstanceId
        : undefined;
    if (
      agentTypes.length === 0 &&
      workspaceRoots.length === 0 &&
      !runtimeInstanceId
    ) {
      return undefined;
    }
    return {
      agentTypes,
      ...(machine ? { machine } : {}),
      ...(runtimeInstanceId ? { runtimeInstanceId } : {}),
      workspaceRoots,
    };
  } catch {
    return undefined;
  }
}

function withVerifiedAccountSession(
  request: Request,
  session: AcpRelayAccountSession,
): Request {
  const headers = new Headers(request.headers);
  headers.set("x-acp-verified-account-id", session.accountId);
  headers.set("x-acp-account-session-id", session.sessionId);
  if (session.principalType === "client") {
    headers.set("x-acp-verified-client-id", session.principalId);
  }
  return new Request(request, {
    headers,
  });
}

function createAuthorizationUrl(request: Request, connectionId: string): URL {
  const requestUrl = new URL(request.url);
  const authUrl = new URL("/authorize", request.url);
  const accountId =
    requestUrl.searchParams.get("accountId") ??
    request.headers.get("x-acp-account-id");
  if (accountId) {
    authUrl.searchParams.set("accountId", accountId);
  }
  authUrl.searchParams.set("connectionId", connectionId);
  return authUrl;
}

function normalizeMessageData(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  return undefined;
}

function readOptionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "application/json; charset=utf-8",
    },
  });
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

function html(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    ...init,
    headers: {
      ...init.headers,
      "content-type": "text/html; charset=utf-8",
    },
  });
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
    const loginUrl = new URL("/login", input.request.url);
    loginUrl.searchParams.set("returnTo", input.request.url);
    return Response.redirect(loginUrl.toString(), 302);
  }

  if (input.failure.status === 401 && input.env.ACP_RELAY_LOGIN_URL) {
    const loginUrl = new URL(input.env.ACP_RELAY_LOGIN_URL);
    loginUrl.searchParams.set("returnTo", input.request.url);
    const accountId = resolveRequestedAccountId(input.request, input.url);
    if (accountId) {
      loginUrl.searchParams.set("accountId", accountId);
    }
    return Response.redirect(loginUrl.toString(), 302);
  }

  return html(
    createRelayAccountSessionRequiredPage({
      loginUrl: input.env.ACP_RELAY_LOGIN_URL,
      reason: input.failure.reason,
      requestUrl: input.request.url,
    }),
    { status: input.failure.status },
  );
}

function createRelayAccountSessionRequiredPage(input: {
  loginUrl?: string;
  reason: string;
  requestUrl: string;
}): string {
  const loginButton = input.loginUrl
    ? `<a class="primary" href="${escapeHtml(createLoginUrl(input.loginUrl, input.requestUrl))}">Sign in with GitHub</a>`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Free Authorization</title>
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
          <h1 id="title">Authorize Free</h1>
          <p>Sign in to continue this remote ACP authorization.</p>
          <p class="reason">${escapeHtml(input.reason)}</p>
          ${loginButton ? `<div class="actions">${loginButton}</div>` : ""}
        </section>
      </main>
    </div>
  </body>
</html>`;
}

function createLoginUrl(loginUrl: string, returnTo: string): string {
  const url = new URL(loginUrl);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
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
    return new Response("GitHub OAuth is not configured.", { status: 503 });
  }
  const signingKey = readAccountSessionSigningKey(env);
  if (!signingKey.ok) {
    return new Response(signingKey.reason, { status: 503 });
  }
  const db = env.ACP_RELAY_DB;
  if (!db) {
    return new Response("GitHub OAuth requires a database (D1).", {
      status: 503,
    });
  }

  if (url.pathname === "/login/confirm") {
    return handleLoginConfirmationRequest({
      db,
      request,
      signingKey: signingKey.key,
    });
  }

  if (url.pathname === "/login/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return new Response("Missing code or state parameter.", { status: 400 });
    }

    const returnTo = await getOAuthStateReturnTo(state, env);
    if (returnTo === undefined) {
      return new Response("Invalid or expired OAuth state.", { status: 400 });
    }

    let user;
    try {
      const accessToken = await exchangeGitHubCodeForAccessToken(
        { clientId, clientSecret },
        code,
      );
      user = await fetchGitHubUser(accessToken);
    } catch (error) {
      return new Response(
        error instanceof Error ? error.message : "GitHub OAuth failed.",
        { status: 502 },
      );
    }

    const githubStore = new D1GitHubAccountStore(db);
    const githubAccount = await resolveOrCreateGithubAccount(githubStore, user);
    const accountId = githubAccount.accountId;
    await new AcpRelayD1ControlPlaneStore(db).upsertAccount({ accountId });
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
    await openLoginApprovalStore(db).put(approval);
    return html(createLoginApprovalPage({
      accountId,
      approvalId: approval.approvalId,
      githubLogin: githubAccount.githubLogin,
      principalId: principal.principalId,
      principalType: principal.principalType,
      returnTo,
    }));
  }

  // GET /login
  const returnTo = url.searchParams.get("returnTo") ?? "/authorize";
  const state = crypto.randomUUID();
  const stateStore = await openOAuthStateStore(env);
  await stateStore.put(state, returnTo);

  const githubUrl = createGitHubAuthorizationUrl(
    { clientId, clientSecret },
    state,
    new URL("/login/callback", request.url).origin,
  );
  return Response.redirect(githubUrl, 302);
}

async function handleLoginConfirmationRequest(input: {
  db: D1Database;
  request: Request;
  signingKey: AcpRemoteAccountSessionSigningKey;
}): Promise<Response> {
  if (input.request.method !== "POST") {
    return html(createLoginApprovalUnavailablePage({
      message: "Open the login link from Free again to approve this device.",
    }), { status: 405 });
  }

  const approvalId = await readLoginApprovalId(input.request);
  if (!approvalId) {
    return html(createLoginApprovalUnavailablePage({
      message: "The login confirmation request was missing its approval id.",
    }), { status: 400 });
  }

  const approval = await openLoginApprovalStore(input.db).consume(approvalId);
  if (!approval || Date.now() - approval.createdAt > LOGIN_APPROVAL_TTL_MS) {
    return html(createLoginApprovalUnavailablePage({
      message: "This login approval expired. Run `free auth login --force` to start again.",
    }), { status: 410 });
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
      "Set-Cookie": createAccountSessionCookie(input.accountSession),
    },
  });
}

function createAccountSessionJsonResponse(input: {
  accountId: string;
  accountSession: string;
  request: Request;
  returnTo: string;
}): Response {
  return json({
    accountId: input.accountId,
    callbackUrl: buildAccountSessionReturnUrl(input).toString(),
  }, {
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": createAccountSessionCookie(input.accountSession),
    },
  });
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

function createAccountSessionCookie(accountSession: string): string {
  return `${SESSION_COOKIE_NAME}=${accountSession}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax; Secure`;
}

function wantsJsonLoginConfirmation(request: Request): boolean {
  return (request.headers.get("accept") ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === "application/json" || part.startsWith("application/json;"));
}

function createLoginApprovalPage(input: {
  accountId: string;
  approvalId: string;
  githubLogin: string;
  principalId: string;
  principalType: "client" | "host";
  returnTo: string;
}): string {
  const target = summarizeLoginTarget(input.returnTo);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize Free</title>
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
        border: 1px solid color-mix(in oklch, var(--accent) 34%, var(--line));
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
        width: min(680px, 100%);
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
      dl {
        display: grid;
        gap: 10px;
        margin: 24px 0;
        padding: 0;
      }
      .row {
        display: grid;
        grid-template-columns: 132px minmax(0, 1fr);
        gap: 14px;
        border-top: 1px solid var(--line);
        padding-top: 10px;
      }
      dt { color: var(--muted); font-weight: 650; }
      dd {
        margin: 0;
        color: var(--ink);
        overflow-wrap: anywhere;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
      }
      button, .secondary {
        min-height: 42px;
        border-radius: 7px;
        padding: 0 16px;
        font: inherit;
      }
      button {
        border: 0;
        background: var(--accent);
        color: var(--accent-ink);
        font-weight: 680;
        cursor: pointer;
      }
      button:disabled {
        cursor: wait;
        opacity: 0.72;
      }
      .secondary {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--line);
        color: var(--muted);
        text-decoration: none;
      }
      .submit-state {
        color: var(--muted);
        font-size: 0.88rem;
        margin-top: 12px;
        min-height: 1.4em;
      }
      @media (max-width: 580px) {
        .row { grid-template-columns: 1fr; gap: 3px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <div class="brand">Free</div>
        <div class="status">Confirmation required</div>
      </header>
      <main>
        <section class="panel" aria-labelledby="title">
          <h1 id="title">Authorize Free</h1>
          <p>Confirm this sign in before Free creates an account session for this device.</p>
          <dl>
            <div class="row">
              <dt>GitHub account</dt>
              <dd>${escapeHtml(input.githubLogin)}</dd>
            </div>
            <div class="row">
              <dt>Account</dt>
              <dd>${escapeHtml(input.accountId)}</dd>
            </div>
            <div class="row">
              <dt>Device</dt>
              <dd>${escapeHtml(input.principalType)} ${escapeHtml(input.principalId)}</dd>
            </div>
            <div class="row">
              <dt>Return target</dt>
              <dd>${escapeHtml(target)}</dd>
            </div>
          </dl>
          <form method="post" action="/login/confirm" id="approvalForm">
            <input type="hidden" name="approvalId" value="${escapeHtml(input.approvalId)}">
            <div class="actions">
              <button type="submit" id="approvalButton">Authorize this device</button>
              <a class="secondary" href="about:blank" onclick="window.close(); return false;">Cancel</a>
            </div>
            <p class="submit-state" id="submitState" aria-live="polite"></p>
          </form>
        </section>
      </main>
    </div>
    <script>
      (function() {
        var form = document.getElementById("approvalForm");
        var button = document.getElementById("approvalButton");
        var state = document.getElementById("submitState");
        if (!form || !button || !state) return;
        var completed = false;
        var fallbackTimer = 0;
        function tryClose() {
          try { window.open("", "_self"); } catch (_) {}
          try { window.close(); } catch (_) {}
        }
        function finish() {
          if (completed) return;
          completed = true;
          if (fallbackTimer) window.clearTimeout(fallbackTimer);
          button.textContent = "Authorized";
          state.textContent = "Free is connected. This tab will close.";
          window.setTimeout(tryClose, 300);
          window.setTimeout(tryClose, 1000);
          window.setTimeout(function() {
            state.textContent = "Free is connected. This tab can be closed.";
          }, 2200);
        }
        window.addEventListener("message", function(event) {
          if (event && event.data && event.data.type === "free:login-complete") {
            finish();
          }
        });
        form.addEventListener("submit", function(event) {
          event.preventDefault();
          if (completed || button.disabled) return;
          button.disabled = true;
          button.textContent = "Authorizing...";
          state.textContent = "Waiting for Free to finish sign in.";
          fetch(form.action, {
            method: "POST",
            body: new FormData(form),
            credentials: "same-origin",
            headers: { "Accept": "application/json" }
          }).then(function(response) {
            if (!response.ok) throw new Error("Login confirmation failed.");
            return response.json();
          }).then(function(body) {
            if (!body || typeof body.callbackUrl !== "string") {
              throw new Error("Login confirmation did not return a callback URL.");
            }
            var frame = document.createElement("iframe");
            frame.setAttribute("aria-hidden", "true");
            frame.style.position = "fixed";
            frame.style.width = "1px";
            frame.style.height = "1px";
            frame.style.opacity = "0";
            frame.style.pointerEvents = "none";
            frame.style.border = "0";
            frame.src = body.callbackUrl;
            document.body.appendChild(frame);
            fallbackTimer = window.setTimeout(function() {
              if (!completed) window.location.assign(body.callbackUrl);
            }, 8000);
          }).catch(function(error) {
            button.disabled = false;
            button.textContent = "Authorize this device";
            state.textContent = error && error.message
              ? error.message
              : "Login confirmation failed. Try again.";
          });
        });
      })();
    </script>
  </body>
</html>`;
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

function summarizeLoginTarget(returnTo: string): string {
  try {
    const url = new URL(returnTo);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return returnTo;
  }
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
  put(approval: LoginApproval): Promise<void>;
  consume(approvalId: string): Promise<LoginApproval | undefined>;
}

function openLoginApprovalStore(db: D1Database): LoginApprovalStore {
  return new D1LoginApprovalStore(db);
}

class D1LoginApprovalStore implements LoginApprovalStore {
  constructor(private readonly db: D1Database) {}

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
    const row = await this.db
      .prepare(
        `SELECT approval_id, account_id, github_login, principal_id,
                principal_type, principal_public_key, return_to, created_at
         FROM acp_login_approvals
         WHERE approval_id = ? AND created_at > ?`,
      )
      .bind(approvalId, Date.now() - LOGIN_APPROVAL_TTL_MS)
      .first<Record<string, unknown>>();
    await this.db
      .prepare("DELETE FROM acp_login_approvals WHERE approval_id = ?")
      .bind(approvalId)
      .run();
    if (!row) {
      return undefined;
    }
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
}

async function handleRelayLogUploadRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOG_UPLOAD_BYTES) {
    return json({ error: "Log upload body is too large." }, { status: 413 });
  }

  const accountSession = await verifyAccountSessionRequest({
    env,
    request,
  });
  if (!accountSession.ok) {
    return json({ error: accountSession.reason }, {
      status: accountSession.status,
    });
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const batch = parseRelayLogUploadBatch(parsedBody.value);
  if (!batch.ok) {
    return json({ error: batch.reason }, { status: 400 });
  }

  const uploadId = crypto.randomUUID();
  const receivedAt = new Date().toISOString();
  for (const [index, record] of batch.value.records.entries()) {
    console.log(
      JSON.stringify({
        accountId: accountSession.session.accountId,
        accountSessionId: accountSession.session.sessionId,
        context: batch.value.context,
        eventName: "acp.relay.log",
        index,
        receivedAt,
        record,
        spanId: typeof record.spanId === "string" ? record.spanId : undefined,
        source: batch.value.source,
        traceId: typeof record.traceId === "string" ? record.traceId : undefined,
        uploadId,
      }),
    );
  }

  return json({
    accepted: batch.value.records.length,
    ok: true,
    uploadId,
  });
}

async function handleRelayOtlpProxyRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_LOG_UPLOAD_BYTES) {
    return json({ error: "OTLP payload body is too large." }, { status: 413 });
  }

  const accountSession = await verifyAccountSessionRequest({
    env,
    request,
  });
  if (!accountSession.ok) {
    return json({ error: accountSession.reason }, {
      status: accountSession.status,
    });
  }

  if (!env.FREE_OTLP_ENDPOINT || !env.FREE_OTLP_TOKEN) {
    return json({
      accepted: true,
      configured: false,
      reason: "otel_export_disabled",
    });
  }

  const signal = url.pathname.endsWith("/traces") ? "traces" : "logs";
  const upstreamUrl = buildOtlpEndpoint(env.FREE_OTLP_ENDPOINT, signal);
  const response = await fetch(upstreamUrl, {
    body: request.body,
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      [env.FREE_OTLP_HEADER || "X-OTLP-Token"]: env.FREE_OTLP_TOKEN,
    },
    method: "POST",
  });

  if (!response.ok) {
    console.warn(
      JSON.stringify({
        accountId: accountSession.session.accountId,
        eventName: "acp.relay.otlp_proxy_failed",
        signal,
        status: response.status,
      }),
    );
  }

  return new Response(response.body, {
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
    },
    status: response.status,
  });
}

function buildOtlpEndpoint(
  endpoint: string,
  signal: "logs" | "traces",
): string {
  const url = new URL(endpoint);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(`/v1/${signal}`)) {
    return url.toString();
  }
  url.pathname = `${pathname}/v1/${signal}`;
  return url.toString();
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

async function handleControlPlaneRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed.", {
      headers: { allow: "POST" },
      status: 405,
    });
  }

  if (!isAuthorizedControlPlaneRequest(request, env)) {
    return json({ error: "Unauthorized." }, { status: 401 });
  }

  if (!env.ACP_RELAY_DB) {
    return json(
      { error: "Control-plane API requires ACP_RELAY_DB." },
      { status: 503 },
    );
  }

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) {
    return json({ error: parsedBody.reason }, { status: 400 });
  }

  const store = new AcpRelayD1ControlPlaneStore(env.ACP_RELAY_DB);
  switch (url.pathname) {
    case "/control-plane/accounts": {
      const record = parseAccountRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertAccount(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/client-devices": {
      const record = parseClientDeviceRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertClientDevice(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/hosts": {
      const record = parseHostRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertHost(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    case "/control-plane/grants": {
      const record = parseGrantRecord(parsedBody.value);
      if (!record.ok) {
        return json({ error: record.reason }, { status: 400 });
      }
      await store.upsertGrant(record.value);
      return reconcileControlPlaneMutation(request, env, record.value.accountId);
    }
    default:
      return json({ error: "Unknown control-plane endpoint." }, { status: 404 });
  }
}

async function reconcileControlPlaneMutation(
  request: Request,
  env: Env,
  accountId: string,
): Promise<Response> {
  const shardId = env.ACP_RELAY_SHARDS.idFromName(`account:${accountId}`);
  const response = await env.ACP_RELAY_SHARDS.get(shardId).fetch(
    new Request(
      new URL(
        `/internal/reconcile-authorizations?accountId=${encodeURIComponent(accountId)}`,
        request.url,
      ),
      {
        headers: {
          authorization: request.headers.get("authorization") ?? "",
          "x-acp-control-plane-secret":
            request.headers.get("x-acp-control-plane-secret") ?? "",
        },
        method: "POST",
      },
    ),
  );

  if (!response.ok) {
    return json(
      { error: "Control-plane mutation applied but reconcile failed." },
      { status: 502 },
    );
  }

  const payload = (await response.json()) as {
    closedConnectionIds?: unknown;
  };
  return json({
    closedConnectionIds: Array.isArray(payload.closedConnectionIds)
      ? payload.closedConnectionIds
      : [],
    ok: true,
  });
}

function isAuthorizedControlPlaneRequest(request: Request, env: Env): boolean {
  const expected = env.ACP_RELAY_CONTROL_PLANE_SECRET;
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return (
    constantTimeEqual(bearerToken ?? "", expected) ||
    constantTimeEqual(
      request.headers.get("x-acp-control-plane-secret") ?? "",
      expected,
    )
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }
  return mismatch === 0;
}

async function readJsonBody(
  request: Request,
): Promise<
  | {
      ok: true;
      value: unknown;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false, reason: "Request body must be valid JSON." };
  }
}

function parseAccountRecord(
  value: unknown,
): ParseResult<AcpRelayAccountRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Account registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
    },
  };
}

function parseClientDeviceRecord(
  value: unknown,
): ParseResult<AcpRelayClientDeviceRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Client device registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readRequiredString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      disabled: disabled.value,
      publicKey: publicKey.value,
    },
  };
}

function parseHostRecord(value: unknown): ParseResult<AcpRelayHostRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Host registration body must be an object.");
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
  }

  const disabled = readOptionalBoolean(record, "disabled");
  if (!disabled.ok) {
    return disabled;
  }

  const publicKey = readRequiredString(record, "publicKey");
  if (!publicKey.ok) {
    return publicKey;
  }

  const previousPublicKey = readOptionalString(record, "previousPublicKey");
  if (!previousPublicKey.ok) {
    return previousPublicKey;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      disabled: disabled.value,
      hostId: hostId.value,
      previousPublicKey: previousPublicKey.value,
      publicKey: publicKey.value,
    },
  };
}

function parseGrantRecord(value: unknown): ParseResult<AcpRelayGrantRecord> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Grant registration body must be an object.");
  }

  const grantId = readOptionalString(record, "grantId");
  if (!grantId.ok) {
    return grantId;
  }

  const accountId = readRequiredString(record, "accountId");
  if (!accountId.ok) {
    return accountId;
  }

  const clientId = readOptionalString(record, "clientId");
  if (!clientId.ok) {
    return clientId;
  }

  const hostId = readRequiredString(record, "hostId");
  if (!hostId.ok) {
    return hostId;
  }

  const workspaceId = readOptionalString(record, "workspaceId");
  if (!workspaceId.ok) {
    return workspaceId;
  }

  const workspaceRoots = readOptionalStringArray(record, "workspaceRoots");
  if (!workspaceRoots.ok) {
    return workspaceRoots;
  }

  const policyVersion = readRequiredPositiveInteger(record, "policyVersion");
  if (!policyVersion.ok) {
    return policyVersion;
  }

  const scopes = readScopes(record);
  if (!scopes.ok) {
    return scopes;
  }

  const revoked = readOptionalBoolean(record, "revoked");
  if (!revoked.ok) {
    return revoked;
  }

  return {
    ok: true,
    value: {
      accountId: accountId.value,
      clientId: clientId.value,
      grantId: grantId.value,
      hostId: hostId.value,
      policyVersion: policyVersion.value,
      revoked: revoked.value,
      scopes: scopes.value,
      workspaceId: workspaceId.value,
      workspaceRoots: workspaceRoots.value,
    },
  };
}

type RelayLogUploadBatch = {
  context?: Record<string, unknown>;
  records: readonly Record<string, unknown>[];
  source: string;
};

function parseRelayLogUploadBatch(
  value: unknown,
): ParseResult<RelayLogUploadBatch> {
  const record = asRecord(value);
  if (!record) {
    return parseError("Log upload body must be an object.");
  }
  if (record.version !== 1) {
    return parseError("Log upload version must be 1.");
  }
  const source = readRequiredString(record, "source");
  if (!source.ok) {
    return source;
  }
  const records = record.records;
  if (!Array.isArray(records)) {
    return parseError("records must be an array.");
  }
  if (records.length > MAX_LOG_UPLOAD_RECORDS) {
    return parseError(`records must contain at most ${MAX_LOG_UPLOAD_RECORDS} entries.`);
  }
  const parsedRecords: Record<string, unknown>[] = [];
  for (const entry of records) {
    const parsed = asRecord(entry);
    if (!parsed) {
      return parseError("records entries must be objects.");
    }
    parsedRecords.push(parsed);
  }
  const context = record.context === undefined || record.context === null
    ? undefined
    : asRecord(record.context);
  if (record.context !== undefined && record.context !== null && !context) {
    return parseError("context must be an object when provided.");
  }
  return {
    ok: true,
    value: {
      context,
      records: parsedRecords,
      source: source.value,
    },
  };
}

type ParseResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

function parseError(reason: string): ParseResult<never> {
  return { ok: false, reason };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequiredString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string> {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string.`);
  }
  return { ok: true, value };
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
): ParseResult<string | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string" || value.trim() === "") {
    return parseError(`${key} must be a non-empty string when provided.`);
  }
  return { ok: true, value };
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
): ParseResult<boolean | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "boolean") {
    return parseError(`${key} must be a boolean when provided.`);
  }
  return { ok: true, value };
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): ParseResult<readonly string[] | undefined> {
  const value = record[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError(`${key} must be a non-empty string array when provided.`);
  }
  return { ok: true, value };
}

function readRequiredPositiveInteger(
  record: Record<string, unknown>,
  key: string,
): ParseResult<number> {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0) {
    return parseError(`${key} must be a positive integer.`);
  }
  return { ok: true, value: value as number };
}

function readScopes(
  record: Record<string, unknown>,
): ParseResult<readonly AcpRemoteScope[]> {
  const value = record.scopes;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    return parseError("scopes must be a non-empty string array.");
  }
  return { ok: true, value: value as readonly AcpRemoteScope[] };
}

function readAttachmentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRelayClientTransport(
  value: unknown,
): value is AcpRelayClientTransport {
  return value === "native-acp";
}

function isHostMetadata(value: unknown): value is HostMetadata {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.agentTypes) || !Array.isArray(record.workspaceRoots)) {
    return false;
  }
  return (
    record.agentTypes.every((entry) => {
      const agent = asRecord(entry);
      return (
        agent !== undefined &&
        typeof agent.label === "string" &&
        (agent.command === undefined || typeof agent.command === "string") &&
        (agent.id === undefined || typeof agent.id === "string") &&
        (agent.type === undefined || typeof agent.type === "string")
      );
    }) &&
    record.workspaceRoots.every((entry) => {
      const root = asRecord(entry);
      return (
        root !== undefined &&
        typeof root.path === "string" &&
        (root.label === undefined || typeof root.label === "string")
      );
    }) &&
    (record.machine === undefined || typeof record.machine === "string") &&
    (record.runtimeInstanceId === undefined ||
      typeof record.runtimeInstanceId === "string")
  );
}

function isConnectionProof(
  value: unknown,
): value is AcpRemoteConnectionProof {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.clientId === "string" &&
    typeof record.connectionId === "string" &&
    typeof record.hostId === "string" &&
    typeof record.nonce === "string" &&
    typeof record.signature === "string" &&
    typeof record.timestamp === "string" &&
    asRecord(record.accountSession) !== undefined
  );
}

function clientStateStorageKey(connectionId: string): string {
  return `${RELAY_CLIENT_STATE_STORAGE_PREFIX}${connectionId}`;
}

function isClientStateSnapshot(
  value: unknown,
  connectionId: string,
): value is AcpRelayClientStateSnapshot {
  const record = asRecord(value);
  if (!record || record.connectionId !== connectionId) {
    return false;
  }
  return (
    typeof record.routeReady === "boolean" &&
    Array.isArray(record.bufferedClientPayloads) &&
    record.bufferedClientPayloads.every(isDataFrame) &&
    Array.isArray(record.clientPendingFrames) &&
    record.clientPendingFrames.every(isDataFrame) &&
    Array.isArray(record.hostPendingFrames) &&
    record.hostPendingFrames.every(isDataFrame) &&
    Array.isArray(record.hostQueuedFrames) &&
    record.hostQueuedFrames.every(isDataFrame) &&
    Array.isArray(record.hostRequests) &&
    record.hostRequests.every(isJsonRpcRequestRecord) &&
    Number.isSafeInteger(record.seq) &&
    (record.hostId === undefined || typeof record.hostId === "string") &&
    (record.lastHostSeq === undefined ||
      Number.isSafeInteger(record.lastHostSeq)) &&
    (record.connectionProof === undefined ||
      isConnectionProof(record.connectionProof)) &&
    (record.lastAuthorization === undefined ||
      isRelayAuthorizationSelection(record.lastAuthorization))
  );
}

function isDataFrame(value: unknown): value is AcpRemoteDataFrame {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.frameType === AcpRemoteFrameType.Data &&
    typeof record.connectionId === "string" &&
    typeof record.channelId === "string" &&
    Object.values(AcpRemoteChannelKind).includes(
      record.channelKind as AcpRemoteChannelKind,
    ) &&
    Number.isSafeInteger(record.seq)
  );
}

function isJsonRpcRequestRecord(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    (typeof record.id === "string" || typeof record.id === "number")
  );
}

function isRelayAuthorizationSelection(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.hostId === "string" &&
    (record.workspaceRoots === undefined ||
      (Array.isArray(record.workspaceRoots) &&
        record.workspaceRoots.every((entry) => typeof entry === "string"))) &&
    (record.agent === undefined || asRecord(record.agent) !== undefined)
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
