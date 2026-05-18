import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { SeverityNumber } from "@opentelemetry/api-logs";
import type {
  Agent,
  AgentCapabilities,
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  ClientCapabilities,
  CloseSessionRequest,
  CloseSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import type { AcpRuntimeSession } from "@saaskit-dev/acp-runtime";
import type {
  AcpRuntimeAgentInput,
  AcpRuntimeAuthorityHandlers,
  AcpRuntimeConfigValue,
  AcpRuntimeListSessionsOptions,
  AcpRuntimeSessionList,
  AcpRuntimeStartSessionOptions,
} from "@saaskit-dev/acp-runtime";
import {
  mapAcpMcpServersToRuntime,
  mapAcpPromptToUserMessageNotifications,
  mapAcpPermissionOutcomeToRuntimeDecision,
  mapAcpPromptToRuntimePrompt,
  mapRemotePermissionRequestToAcp,
  mapRuntimeConfigOptionsToAcp,
  mapRuntimeHistoryEntryToAcpNotifications,
  mapRuntimeSessionListToAcp,
  mapRuntimeSessionToAcpResponse,
  mapRuntimeThreadEntryToAcpNotifications,
  mapRuntimeTurnCompletionToAcp,
  mapRuntimeTurnEventToAcpNotifications,
  createRemoteInitializeResponse,
} from "./mappers.js";
import { emitFreeLog } from "../observability/logging.js";
import {
  SpanKind,
  withFreeSpan,
  type FreeSpanHandle,
} from "../observability/spans.js";
import { traceContextFromMeta } from "../observability/tracing.js";
import {
  pathContains,
  safeRealpath,
  isRecord,
  isStringRecord,
  readStringArray,
  formatError,
} from "../shared/fs-utils.js";

type RemoteRuntimeSessions = {
  list(
    options?: AcpRuntimeListSessionsOptions & {
      _traceContext?: import("@opentelemetry/api").Context;
    },
  ): Promise<AcpRuntimeSessionList>;
  load(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
    _traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession>;
  resume(options: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    handlers?: AcpRuntimeAuthorityHandlers;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    sessionId: string;
    _traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession>;
  start(
    options: AcpRuntimeStartSessionOptions & {
      _traceContext?: import("@opentelemetry/api").Context;
    },
  ): Promise<AcpRuntimeSession>;
};

export type AcpRemoteRuntimeAgentOptions = {
  agent?: AcpRuntimeAgentInput;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: InitializeResponse["agentInfo"];
  remoteHostId?: string;
  remoteMachineName?: string;
  runtime: {
    isClosed?: () => boolean;
    sessions: RemoteRuntimeSessions;
  };
  sessionAgent?: AcpRuntimeAgentInput;
  workspaceRoots?: readonly string[];
};

type ActiveRemoteSession = {
  session: AcpRuntimeSession;
  terminalHandles: Map<string, Awaited<ReturnType<AgentSideConnection["createTerminal"]>>>;
  turnId?: string;
};

type SessionScopedParams = {
  _meta?: Record<string, unknown> | null;
  sessionId: string;
};

const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_MACHINE_META = "acp-runtime/remote/sessionMachine";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";
const REMOTE_HOST_ID_META = "acp-runtime/remote/hostId";
const REMOTE_RUNTIME_REQUEST_KEY_META = "acp-runtime/remote/requestKey";

export class AcpRemoteRuntimeAgent implements Agent {
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, ActiveRemoteSession>();
  private readonly sessionRestorePromises = new Map<
    string,
    Promise<ActiveRemoteSession>
  >();
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly options: AcpRemoteRuntimeAgentOptions,
  ) {}

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? {};
    return createRemoteInitializeResponse(params, {
      agentCapabilities: this.options.agentCapabilities,
      agentInfo: this.options.agentInfo,
    });
  }

  async authenticate(
    _params: AuthenticateRequest,
  ): Promise<AuthenticateResponse | void> {
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.withRuntimeSpan("session/new", params, async (span) => {
      const selection = readSessionSelection(params);
      const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
      const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
      const cwd = await this.authorizeRequiredWorkspaceCwd(
        cwdInput,
        "session/new",
        workspaceRoots,
      );
      const agent = selection.agent ?? this.requireAgent();
      const mcpServers = mapAcpMcpServersToRuntime(params.mcpServers);
      const session = await this.options.runtime.sessions.start({
        agent,
        cwd,
        handlers: this.createAuthorityHandlers(),
        mcpServers,
        _traceContext: span.context,
      });
      this.storeActiveSession(session);
      return addTraceparentMetadata(
        addRemoteSessionMetadata(
          mapRuntimeSessionToAcpResponse(session.metadata),
          this.createRemoteSessionMetadata(selection, cwd),
        ),
        span.traceparent,
      );
    });
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.withRuntimeSpan("session/load", params, async (span) => {
      const selection = readSessionSelection(params);
      const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
      const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
      const cwd = await this.authorizeRequiredWorkspaceCwd(
        cwdInput,
        "session/load",
        workspaceRoots,
      );
      const agent = selection.agent ?? this.requireAgent();
      const mcpServers = mapAcpMcpServersToRuntime(params.mcpServers ?? []);
      const session = await this.loadOrResumeRuntimeSession({
        agent,
        cwd,
        mcpServers,
        preferred: "load",
        method: "session/load",
        sessionId: params.sessionId,
        traceContext: span.context,
      });
      this.storeActiveSession(session, [params.sessionId]);
      await this.replayHistory(params.sessionId, session);
      return addTraceparentMetadata(
        addRemoteSessionMetadata(
          mapRuntimeSessionToAcpResponse(session.metadata),
          this.createRemoteSessionMetadata({ agent }, cwd),
        ),
        span.traceparent,
      );
    });
  }

  async resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    return this.withRuntimeSpan("session/resume", params, async (span) => {
      const selection = readSessionSelection(params);
      const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
      const cwdInput = selection.workspaceRoots?.[0] ?? params.cwd;
      const cwd = await this.authorizeRequiredWorkspaceCwd(
        cwdInput,
        "session/resume",
        workspaceRoots,
      );
      const agent = selection.agent ?? this.requireAgent();
      const mcpServers = mapAcpMcpServersToRuntime(params.mcpServers ?? []);
      const session = await this.loadOrResumeRuntimeSession({
        agent,
        cwd,
        mcpServers,
        preferred: "resume",
        method: "session/resume",
        sessionId: params.sessionId,
        traceContext: span.context,
      });
      this.storeActiveSession(session, [params.sessionId]);
      await this.replayHistory(params.sessionId, session);
      return addTraceparentMetadata(
        addRemoteSessionMetadata(
          mapRuntimeSessionToAcpResponse(session.metadata),
          this.createRemoteSessionMetadata({ agent }, cwd),
        ),
        span.traceparent,
      );
    });
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    return this.withRuntimeSpan("session/list", params, async (span) => {
      const cwd = await this.authorizeWorkspaceCwd(
        params.cwd ?? undefined,
        "session/list",
      );
      const list = mapRuntimeSessionListToAcp(
        await this.options.runtime.sessions.list({
          agent: this.requireAgent(),
          cursor: params.cursor ?? undefined,
          cwd,
          source: "all",
          _traceContext: span.context,
        }),
      );
      return addTraceparentMetadata({
        ...list,
        sessions: list.sessions.map((session) =>
          addRemoteSessionMetadata(
            session,
            this.createRemoteSessionMetadata(
              { agent: this.options.sessionAgent ?? this.options.agent },
              session.cwd,
            ),
          ),
        ),
      }, span.traceparent);
    });
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse | void> {
    return this.withRuntimeSpan("session/close", params, async (span) => {
      const active = await this.getOrRestoreSession(params, "session/close");
      await active.session.close();
      this.deleteSessionAliases(active);
      active.terminalHandles.clear();
      return addTraceparentMetadata({}, span.traceparent);
    });
  }

  async closeActiveSessions(reason = "Remote ACP client disconnected."): Promise<void> {
    const activeSessions = [...new Set(this.sessions.values())];
    this.sessions.clear();
    for (const active of activeSessions) {
      active.terminalHandles.clear();
      await active.session.close().catch((error) => {
        emitFreeLog({
          body: `Remote runtime session close failed after client disconnect: ${formatError(error)}`,
          eventName: "acp.remote.session.close.failed",
          exception: error,
          severityNumber: SeverityNumber.ERROR,
        });
      });
    }
    if (activeSessions.length > 0) {
      emitFreeLog({
        body: reason,
        eventName: "acp.remote.session.close.client_disconnected",
      });
    }
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    return this.withRuntimeSpan("session/set_mode", params, async (span) => {
      const active = await this.getOrRestoreSession(params, "session/set_mode");
      await active.session.agent.setMode(params.modeId);
      return addTraceparentMetadata({}, span.traceparent);
    });
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.withRuntimeSpan(
      "session/set_config_option",
      params,
      async (span) => {
        const active = await this.getOrRestoreSession(
          params,
          "session/set_config_option",
        );
        const value: AcpRuntimeConfigValue =
          "type" in params && params.type === "boolean" ? params.value : params.value;
        await active.session.agent.setConfigOption(params.configId, value);
        const configOptions = mapRuntimeConfigOptionsToAcp(
          active.session.metadata.agentConfigOptions,
        ) ?? [];
        return addTraceparentMetadata({
          configOptions: applyAcceptedConfigOptionValue(
            configOptions,
            params.configId,
            value,
          ),
        }, span.traceparent);
      },
    );
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.withRuntimeSpan("session/prompt", params, async (span) => {
      const active = await this.getOrRestoreSession(params, "session/prompt");
      const userMessageId = params.messageId ?? randomUUID();
      span.span.setAttributes({
        "free.message.id": userMessageId,
        "free.message.prompt_block_count": Array.isArray(params.prompt)
          ? params.prompt.length
          : 1,
        "free.message.prompt_text_chars": promptTextLength(params.prompt),
        "free.phase": "runtime.run",
      });
      for (const notification of mapAcpPromptToUserMessageNotifications(
        params.sessionId,
        params.prompt,
        userMessageId,
      )) {
        await this.connection.sessionUpdate(notification);
      }
      const turn = active.session.turn.start(
        mapAcpPromptToRuntimePrompt(params.prompt),
        {
          _traceContext: span.context,
          acpRuntimeRequestKey: readRuntimeRequestKey(params),
        } as Parameters<typeof active.session.turn.start>[1] & {
          acpRuntimeRequestKey?: string;
        },
      );
      span.span.setAttributes({
        "acp.turn.id": turn.turnId,
      });
      active.turnId = turn.turnId;

      try {
        let completion:
          | import("@saaskit-dev/acp-runtime").AcpRuntimeTurnCompletion
          | undefined;
        for await (const event of turn.events) {
          for (const notification of mapRuntimeTurnEventToAcpNotifications(
            params.sessionId,
            event,
          )) {
            await this.connection.sessionUpdate(notification);
          }
          if (event.type === "completed") {
            completion = {
              output: event.output,
              outputText: event.outputText,
              turnId: event.turnId,
            };
          } else if (event.type === "cancelled") {
            return addTraceparentMetadata({
              stopReason: "cancelled",
              userMessageId,
            }, span.traceparent);
          } else if (event.type === "failed") {
            emitRemotePromptFailureLog({
              hostId: this.options.remoteHostId,
              error: event.error,
              sessionId: params.sessionId,
              traceContext: span.context,
              turnId: event.turnId,
            });
            throw RequestError.internalError(
              { sessionId: params.sessionId, turnId: event.turnId },
              formatError(event.error),
            );
          }
        }

        if (!completion) {
          throw RequestError.internalError(
            { sessionId: params.sessionId },
            "Remote runtime turn ended without completion.",
          );
        }

        return addTraceparentMetadata(
          mapRuntimeTurnCompletionToAcp(completion, {
            userMessageId,
          }),
          span.traceparent,
        );
      } catch (error) {
        if (isRuntimeServiceRestartRequiredError(error)) {
          this.deleteSessionAliases(active);
          emitFreeLog({
            body: `ACP runtime service disconnected during prompt: ${formatError(error)}`,
            eventName: "acp.remote.runtime_service.disconnected",
            exception: error,
            severityNumber: SeverityNumber.ERROR,
          });
          throw RequestError.internalError(
            {
              reason: "runtime_service_restarted",
              sessionId: params.sessionId,
              turnId: turn.turnId,
            },
            "ACP runtime service restarted before this request completed. The message was not completed; resend it to continue.",
          );
        }
        throw error;
      } finally {
        if (active.turnId === turn.turnId) {
          active.turnId = undefined;
        }
      }
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.withRuntimeSpan("session/cancel", params, async () => {
      const active = await this.getOrRestoreSession(params, "session/cancel");
      if (active.turnId) {
        await active.session.turn.cancel(active.turnId);
      }
    });
  }

  private withRuntimeSpan<T>(
    method: string,
    params: { _meta?: Record<string, unknown> | null; sessionId?: string },
    work: (span: FreeSpanHandle) => Promise<T>,
  ): Promise<T> {
    return withFreeSpan(
      spanNameForRuntimeMethod(method),
      {
        attributes: {
          "acp.jsonrpc.method": method,
          "acp.remote.component": "host",
          "acp.remote.host.id": this.options.remoteHostId,
          "acp.remote.machine": this.options.remoteMachineName,
          "acp.session.id": params.sessionId,
          "free.phase": phaseForRuntimeMethod(method),
        },
        context: traceContextFromParams(params),
        kind: SpanKind.SERVER,
      },
      work,
    );
  }

  private requireAgent(): AcpRuntimeAgentInput {
    if (!this.options.agent) {
      throw RequestError.invalidParams(
        {},
        "No agent configured. Select an agent during authorization.",
      );
    }
    return this.options.agent;
  }

  private createRemoteSessionMetadata(
    selection: {
      agent?: AcpRuntimeAgentInput;
      workspaceRoots?: readonly string[];
    },
    cwd: string,
  ): Record<string, unknown> {
    return createRemoteSessionMetadata({
      agent:
        selection.agent ??
        this.options.sessionAgent ??
        this.options.agent,
      hostId: this.options.remoteHostId,
      machine: this.options.remoteMachineName,
      workspaceRoots:
        selection.workspaceRoots ??
        this.options.workspaceRoots ??
      (cwd ? [cwd] : undefined),
    });
  }

  private async getOrRestoreSession(
    params: SessionScopedParams,
    method: string,
  ): Promise<ActiveRemoteSession> {
    const active = this.sessions.get(params.sessionId);
    if (active) {
      if (this.options.runtime.isClosed?.()) {
        return this.restoreActiveSession(active, params.sessionId, method);
      }
      return active;
    }

    const existingRestore = this.sessionRestorePromises.get(params.sessionId);
    if (existingRestore) {
      return existingRestore;
    }

    const restore = this.restoreSession(params, method);
    this.sessionRestorePromises.set(params.sessionId, restore);
    try {
      return await restore;
    } finally {
      this.sessionRestorePromises.delete(params.sessionId);
    }
  }

  private async restoreSession(
    params: SessionScopedParams,
    method: string,
  ): Promise<ActiveRemoteSession> {
    const traceContext = traceContextFromParams(params);
    const selection = readSessionSelection(params);
    const workspaceRoots = selection.workspaceRoots ?? this.options.workspaceRoots;
    const cwdInput = selection.workspaceRoots?.[0] ?? workspaceRoots?.[0];
    if (!cwdInput) {
      throw RequestError.invalidParams(
        { method, sessionId: params.sessionId },
        `Unknown remote runtime session: ${params.sessionId}`,
      );
    }
    const cwd = await this.authorizeRequiredWorkspaceCwd(
      cwdInput,
      method,
      workspaceRoots,
    );
    const agent =
      selection.agent ?? this.options.sessionAgent ?? this.requireAgent();
    let session: AcpRuntimeSession;
    try {
      const mcpServers: ReturnType<typeof mapAcpMcpServersToRuntime> = [];
      session = await this.loadOrResumeRuntimeSession({
        agent,
        cwd,
        mcpServers,
        method,
        preferred: "resume",
        sessionId: params.sessionId,
        traceContext,
      });
    } catch (error) {
      if (method !== "session/prompt") {
        throw error;
      }
      session = await this.options.runtime.sessions.start({
        agent,
        cwd,
        handlers: this.createAuthorityHandlers(),
        mcpServers: [],
        _traceContext: traceContext,
      });
    }
    const active = this.storeActiveSession(session, [params.sessionId]);
    await this.replayHistory(params.sessionId, session);
    return active;
  }

  private async loadOrResumeRuntimeSession(input: {
    agent?: AcpRuntimeAgentInput;
    cwd?: string;
    mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime>;
    preferred?: "load" | "resume";
    method: string;
    sessionId: string;
    traceContext?: import("@opentelemetry/api").Context;
  }): Promise<AcpRuntimeSession> {
    const attempts =
      input.preferred === "resume"
        ? [
            this.options.runtime.sessions.resume.bind(this.options.runtime.sessions),
            this.options.runtime.sessions.load.bind(this.options.runtime.sessions),
          ]
        : [
            this.options.runtime.sessions.load.bind(this.options.runtime.sessions),
            this.options.runtime.sessions.resume.bind(this.options.runtime.sessions),
          ];
    let firstError: unknown;
    let secondError: unknown;
    for (const attempt of attempts) {
      try {
        const options = {
          handlers: this.createAuthorityHandlers(),
          sessionId: input.sessionId,
          _traceContext: input.traceContext,
        } as Parameters<typeof attempt>[0];
        if (input.agent !== undefined) {
          (options as { agent?: AcpRuntimeAgentInput }).agent = input.agent;
        }
        if (input.cwd !== undefined) {
          (options as { cwd?: string }).cwd = input.cwd;
        }
        if (input.mcpServers !== undefined) {
          (options as { mcpServers?: ReturnType<typeof mapAcpMcpServersToRuntime> })
            .mcpServers = input.mcpServers;
        }
        return await attempt(options);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
        } else {
          secondError = error;
        }
      }
    }
    throw RequestError.invalidParams(
      {
        firstError: formatError(firstError),
        method: input.method,
        secondError: formatError(secondError),
        sessionId: input.sessionId,
      },
      `Remote runtime session could not be restored: ${input.sessionId}`,
    );
  }

  private storeActiveSession(
    session: AcpRuntimeSession,
    aliases: readonly string[] = [],
  ): ActiveRemoteSession {
    const active: ActiveRemoteSession = {
      session,
      terminalHandles: new Map(),
    };
    this.sessions.set(session.metadata.id, active);
    for (const alias of aliases) {
      if (alias !== session.metadata.id) {
        this.sessions.set(alias, active);
      }
    }
    this.ensureRuntimeRecoveryMonitor();
    return active;
  }

  private async restoreActiveSession(
    active: ActiveRemoteSession,
    alias: string,
    method: string,
  ): Promise<ActiveRemoteSession> {
    if (active.turnId) {
      throw RequestError.internalError(
        {
          reason: "runtime_service_restarted",
          sessionId: alias,
          turnId: active.turnId,
        },
        "ACP runtime service restarted before this request completed. The message was not completed; resend it to continue.",
      );
    }
    const snapshot = active.session.snapshot();
    const session = await this.loadOrResumeRuntimeSession({
      agent: snapshot.agent,
      cwd: snapshot.cwd,
      method,
      mcpServers: snapshot.mcpServers,
      preferred: "resume",
      sessionId: active.session.metadata.id,
    });
    const aliases = [...this.sessionAliasesFor(active), alias];
    this.deleteSessionAliases(active);
    const restored = this.storeActiveSession(session, aliases);
    emitFreeLog({
      body: `ACP runtime session resumed after runtime service restart: ${active.session.metadata.id}`,
      eventName: "acp.remote.runtime_session.resumed",
    });
    return restored;
  }

  private ensureRuntimeRecoveryMonitor(): void {
    if (this.recoveryTimer || !this.options.runtime.isClosed) {
      return;
    }
    this.recoveryTimer = setInterval(() => {
      if (!this.options.runtime.isClosed?.()) {
        return;
      }
      void this.restoreIdleSessionsAfterRuntimeRestart();
    }, 1000);
    this.recoveryTimer.unref?.();
  }

  private async restoreIdleSessionsAfterRuntimeRestart(): Promise<void> {
    const activeSessions = [...new Set(this.sessions.values())].filter(
      (active) => !active.turnId,
    );
    for (const active of activeSessions) {
      const alias = this.sessionAliasesFor(active)[0] ?? active.session.metadata.id;
      if (!this.sessions.has(alias)) {
        continue;
      }
      await this.restoreActiveSession(active, alias, "session/resume").catch((error) => {
        emitFreeLog({
          body: `ACP runtime session resume failed after runtime service restart: ${formatError(error)}`,
          eventName: "acp.remote.runtime_session.resume.failed",
          exception: error,
          severityNumber: SeverityNumber.ERROR,
        });
      });
    }
  }

  private sessionAliasesFor(active: ActiveRemoteSession): string[] {
    return [...this.sessions.entries()]
      .filter(([, candidate]) => candidate === active || candidate.session === active.session)
      .map(([sessionId]) => sessionId);
  }

  private async replayHistory(
    sessionId: string,
    session: AcpRuntimeSession,
  ): Promise<void> {
    const history = session.state.history.drain();
    const notifications =
      history.length > 0
        ? history.flatMap((entry) =>
            mapRuntimeHistoryEntryToAcpNotifications(sessionId, entry),
          )
        : session.state.thread.entries().flatMap((entry) =>
            mapRuntimeThreadEntryToAcpNotifications(sessionId, entry),
          );
    for (const notification of notifications) {
      await this.connection.sessionUpdate(notification);
    }
  }

  private deleteSessionAliases(active: ActiveRemoteSession): void {
    for (const [sessionId, candidate] of this.sessions.entries()) {
      if (candidate === active || candidate.session === active.session) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private async authorizeWorkspaceCwd(
    cwd: string | null | undefined,
    method: string,
    workspaceRoots = this.options.workspaceRoots,
  ): Promise<string | undefined> {
    if (!workspaceRoots?.length) {
      return cwd ?? undefined;
    }
    if (!cwd) {
      throw RequestError.invalidParams(
        { method },
        `Remote workspace policy requires cwd for ${method}.`,
      );
    }

    const resolvedCwd = await safeRealpath(resolve(cwd));
    const allowed = (
      await Promise.all(workspaceRoots.map((r) => safeRealpath(resolve(r))))
    ).some((root) => pathContains(root, resolvedCwd));
    if (!allowed) {
      throw RequestError.invalidParams(
        { cwd, method },
        "Remote workspace policy denied cwd.",
      );
    }
    return resolvedCwd;
  }

  private authorizeRequiredWorkspaceCwd(
    cwd: string,
    method: string,
    workspaceRoots = this.options.workspaceRoots,
  ): Promise<string> {
    return this.authorizeWorkspaceCwd(cwd, method, workspaceRoots).then((r) => r ?? cwd);
  }

  private createAuthorityHandlers(): AcpRuntimeAuthorityHandlers {
    const handlers: AcpRuntimeAuthorityHandlers = {
      permission: async (request) => {
        const response = await this.connection.requestPermission(
          mapRemotePermissionRequestToAcp(
            this.findSessionIdForTurn(request.turnId),
            request,
          ),
        );
        return mapAcpPermissionOutcomeToRuntimeDecision(response.outcome);
      },
    };

    if (this.clientCapabilities.fs?.readTextFile || this.clientCapabilities.fs?.writeTextFile) {
      handlers.filesystem = {
        readTextFile: async (path) => {
          const response = await this.connection.readTextFile({
            path,
            sessionId: this.findActiveSessionId(),
          });
          return response.content;
        },
        writeTextFile: async (input) => {
          await this.connection.writeTextFile({
            content: input.content,
            path: input.path,
            sessionId: this.findActiveSessionId(),
          });
        },
      };
    }

    if (this.clientCapabilities.terminal) {
      handlers.terminal = {
        kill: async (terminalId) => {
          const handle = this.findTerminalHandle(terminalId);
          await handle.kill();
        },
        output: async (terminalId) => {
          const output = await this.findTerminalHandle(
            terminalId,
          ).currentOutput();
          return {
            exitCode: output.exitStatus?.exitCode ?? null,
            output: output.output,
            truncated: output.truncated ?? false,
          };
        },
        release: async (terminalId) => {
          const handle = this.findTerminalHandle(terminalId);
          await handle.release();
          this.deleteTerminalHandle(terminalId);
        },
        start: async (request) => {
          const handle = await this.connection.createTerminal({
            args: request.args,
            command: request.command,
            cwd: request.cwd,
            env: Object.entries(request.env ?? {}).flatMap(([name, value]) =>
              value === undefined ? [] : [{ name, value }],
            ),
            sessionId: this.findActiveSessionId(),
          });
          this.storeTerminalHandle(handle);
          return { terminalId: handle.id };
        },
        wait: async (terminalId) => {
          const result = await this.findTerminalHandle(terminalId).waitForExit();
          return { exitCode: result.exitCode ?? 0 };
        },
      };
    }

    return handlers;
  }

  private storeTerminalHandle(
    handle: Awaited<ReturnType<AgentSideConnection["createTerminal"]>>,
  ): void {
    const active = [...this.sessions.values()].find(
      (entry) => entry.turnId !== undefined,
    );
    active?.terminalHandles.set(handle.id, handle);
  }

  private findTerminalHandle(
    terminalId: string,
  ): Awaited<ReturnType<AgentSideConnection["createTerminal"]>> {
    for (const active of this.sessions.values()) {
      const handle = active.terminalHandles.get(terminalId);
      if (handle) {
        return handle;
      }
    }
    throw RequestError.invalidParams({ terminalId }, "Unknown terminal.");
  }

  private deleteTerminalHandle(terminalId: string): void {
    for (const active of this.sessions.values()) {
      active.terminalHandles.delete(terminalId);
    }
  }

  private findSessionIdForTurn(turnId: string): string {
    for (const [sessionId, active] of this.sessions.entries()) {
      if (active.turnId === turnId) {
        return sessionId;
      }
    }
    return this.findActiveSessionId();
  }

  private findActiveSessionId(): string {
    for (const [sessionId, active] of this.sessions.entries()) {
      if (active.turnId !== undefined) {
        return sessionId;
      }
    }
    const first = this.sessions.keys().next();
    if (!first.done) {
      return first.value;
    }
    throw RequestError.invalidParams({}, "No active remote runtime session.");
  }
}

function readRuntimeRequestKey(params: { _meta?: Record<string, unknown> | null }): string | undefined {
  const value = params._meta?.[REMOTE_RUNTIME_REQUEST_KEY_META];
  return typeof value === "string" && value ? value : undefined;
}

function readSessionSelection(params: unknown): {
  agent?: AcpRuntimeAgentInput;
  workspaceRoots?: readonly string[];
} {
  if (!isRecord(params) || !isRecord(params._meta)) {
    return {};
  }
  return {
    agent: readSessionAgent(params._meta[REMOTE_SESSION_AGENT_META]),
    workspaceRoots: readStringArray(
      params._meta[REMOTE_SESSION_WORKSPACE_ROOTS_META],
    ),
  };
}

function traceContextFromParams(
  params: { _meta?: Record<string, unknown> | null },
): import("@opentelemetry/api").Context | undefined {
  return traceContextFromMeta(params._meta);
}

function readSessionAgent(value: unknown): AcpRuntimeAgentInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.id === "string" && value.id.trim()) {
    return value.id;
  }
  if (typeof value.command !== "string" || !value.command.trim()) {
    return undefined;
  }
  return {
    args: Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string")
      : undefined,
    command: value.command,
    env: isStringRecord(value.env) ? value.env : undefined,
    type: typeof value.type === "string" ? value.type : undefined,
  };
}

function addRemoteSessionMetadata<T extends object>(
  response: T,
  metadata: Record<string, unknown>,
): T & { _meta: Record<string, unknown> } {
  const existingMeta =
    "_meta" in response && isRecord(response._meta) ? response._meta : {};
  return {
    ...response,
    _meta: {
      ...existingMeta,
      ...metadata,
    },
  };
}

function addTraceparentMetadata<T extends object>(
  response: T,
  traceparent: string | undefined,
): T {
  if (!traceparent) {
    return response;
  }
  return addRemoteSessionMetadata(response, { traceparent });
}

function spanNameForRuntimeMethod(method: string): string {
  return method === "session/prompt"
    ? "free.runtime.run_turn"
    : `free.host.runtime.${method.replaceAll("/", ".")}`;
}

function phaseForRuntimeMethod(method: string): string | undefined {
  return method === "session/prompt" ? "runtime.run" : undefined;
}

function isRuntimeServiceRestartRequiredError(error: unknown): boolean {
  const message = formatError(error);
  return (
    message.includes("ACP runtime service connection closed") ||
    message.includes("Runtime service connection closed") ||
    message.includes("Runtime service peer disconnected") ||
    message.includes("EPIPE") ||
    message.includes("ECONNRESET")
  );
}

function promptTextLength(prompt: PromptRequest["prompt"]): number {
  if (!Array.isArray(prompt)) {
    return 0;
  }
  let total = 0;
  for (const part of prompt) {
    if (
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      total += part.text.length;
    }
  }
  return total;
}

function createRemoteSessionMetadata(input: {
  agent?: AcpRuntimeAgentInput;
  hostId?: string;
  machine?: string;
  workspaceRoots?: readonly string[];
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  if (input.hostId) {
    metadata[REMOTE_HOST_ID_META] = input.hostId;
  }
  if (input.machine) {
    metadata[REMOTE_SESSION_MACHINE_META] = input.machine;
  }
  const agent = serializeSessionAgent(input.agent);
  if (agent) {
    metadata[REMOTE_SESSION_AGENT_META] = agent;
  }
  if (input.workspaceRoots?.length) {
    metadata[REMOTE_SESSION_WORKSPACE_ROOTS_META] = input.workspaceRoots;
  }
  return metadata;
}

function serializeSessionAgent(
  agent: AcpRuntimeAgentInput | undefined,
): Record<string, unknown> | undefined {
  if (!agent) {
    return undefined;
  }
  if (typeof agent === "string") {
    return { id: agent };
  }
  const serialized: Record<string, unknown> = {
    command: agent.command,
  };
  if (agent.args?.length) {
    serialized.args = agent.args;
  }
  if (agent.env && Object.keys(agent.env).length) {
    serialized.env = agent.env;
  }
  if (agent.type) {
    serialized.type = agent.type;
  }
  return serialized;
}

function emitRemotePromptFailureLog(input: {
  hostId?: string;
  error: unknown;
  sessionId: string;
  traceContext?: import("@opentelemetry/api").Context;
  turnId: string;
}): void {
  emitFreeLog({
    attributes: {
      "acp.remote.host.id": input.hostId,
      "acp.session.id": input.sessionId,
      "acp.turn.id": input.turnId,
    },
    body: `Remote runtime prompt failed: ${formatError(input.error)}`,
    context: input.traceContext,
    eventName: "acp.remote.host.prompt.failed",
    exception: input.error,
    severityNumber: SeverityNumber.ERROR,
  });
}

function applyAcceptedConfigOptionValue<T extends { currentValue?: unknown; id: string }>(
  options: readonly T[],
  configId: string,
  value: AcpRuntimeConfigValue,
): T[] {
  return options.map((option) => {
    if (option.id !== configId) {
      return option;
    }
    return {
      ...option,
      currentValue: typeof value === "boolean" ? value : String(value),
    };
  });
}

export function createAcpRemoteRuntimeAgent(input: {
  connection: AgentSideConnection;
  options: AcpRemoteRuntimeAgentOptions;
}): AcpRemoteRuntimeAgent {
  return new AcpRemoteRuntimeAgent(input.connection, input.options);
}
