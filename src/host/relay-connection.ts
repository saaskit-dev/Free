import {
  AgentSideConnection,
  type AnyMessage,
  type Stream,
} from "@agentclientprotocol/sdk";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  AcpRemoteEndpointKind,
  AcpRemoteChannelKind,
  AcpRemoteAttachmentFrameType,
  AcpRemoteFrameType,
  type AcpRemoteAckFrame,
  type AcpRemoteAttachmentAckFrame,
  type AcpRemoteAgentGrant,
  type AcpRemoteDataFrame,
  type AcpRemoteFrame,
  type AcpRemotePongFrame,
} from "../protocol/types.js";
import {
  decodeAcpRemoteAttachmentUpload,
  parseFreeAttachmentUri,
} from "../protocol/attachments.js";
import {
  verifyAcpRemoteConnectionProof,
  type AcpRemoteAccountSessionVerificationKey,
  type AcpRemoteConnectionProof,
} from "../protocol/account-session.js";
import {
  normalizeWebSocketMessageData,
  type AcpWebSocketLike,
} from "../protocol/websocket-stream.js";
import {
  parseFrame,
  isJsonRpcRequest,
} from "../shared/frame-handler.js";
import {
  pathContains,
  safeRealpath,
  isRecord,
  readString,
} from "../shared/fs-utils.js";
import {
  readAcpRemoteTraceContextFromJsonRpcMessage,
  withAcpRemoteTraceparentInJsonRpcMessage,
  type AcpRemoteTraceContext,
} from "../shared/trace-context.js";
import {
  recordFreeSpanError,
  SpanKind,
  startFreeSpan,
  type FreeSpanHandle,
} from "../observability/spans.js";
import {
  summarizeAcpRemotePayloadForLog,
  type AcpRemotePayloadLogSummary,
} from "../shared/payload-log-summary.js";
import {
  AcpRemoteRuntimeAgent,
  type AcpRemoteRuntimeAgentOptions,
} from "./runtime-agent.js";
import {
  createAcpRemoteHostAttachmentStore,
  type AcpRemoteHostAttachmentStore,
} from "./attachments.js";
import type { AcpRuntimeAgentInput } from "@saaskit-dev/acp-runtime";

export type AcpRemoteHostConnectionOptions =
  Omit<AcpRemoteRuntimeAgentOptions, "runtime"> & {
    hostId: string;
    debugLog?: (
      message: string,
      context?: AcpRemoteHostDebugContext,
    ) => void;
    maxBufferedFramesPerConnection?: number;
    maxQueuedFramesPerConnection?: number;
    now?: () => Date;
    requiredPolicyVersion?: number;
    requestJournal?: AcpRemoteHostRequestJournal;
    runtime: AcpRemoteRuntimeAgentOptions["runtime"];
    socket: AcpWebSocketLike;
    state?: AcpRemoteHostConnectionState;
    accountId?: string;
    accountSessionVerificationKeys?: readonly [
      AcpRemoteAccountSessionVerificationKey,
      ...AcpRemoteAccountSessionVerificationKey[],
    ];
    attachmentRootDir?: string;
    attachmentStore?: AcpRemoteHostAttachmentStore;
  };

export type AcpRemoteHostDebugContext = {
  ack?: number;
  connectionId?: string;
  direction?: "relay_to_host" | "host_to_relay";
  freeMessageId?: string;
  freePhase?: string;
  jsonRpcId?: string | number;
  method?: string;
  seq?: number;
  sessionId?: string;
  spanId?: string;
  severityText?: "ERROR" | "INFO";
  traceId?: string;
  traceparent?: string;
} & AcpRemotePayloadLogSummary;

export type AcpRemoteHostConnectionHandle = {
  close(): void;
};

export type AcpRemoteHostRequestJournalEntry = {
  connectionId: string;
  id: string | number;
  method?: string;
  payload?: AnyMessage;
  status: "completed" | "received";
};

export type AcpRemoteHostRequestJournal = {
  lookup(
    connectionId: string,
    id: string | number,
  ): Promise<AcpRemoteHostRequestJournalEntry | undefined>;
  markCompleted(entry: {
    connectionId: string;
    id: string | number;
    method?: string;
    payload: AnyMessage;
  }): Promise<void>;
  markReceived(entry: {
    connectionId: string;
    id: string | number;
    method?: string;
  }): Promise<void>;
};

type ActiveRelayAcpConnection = {
  agent: AcpRemoteRuntimeAgent;
  channel: RelayAcpChannel;
  closeAfterInFlight?: boolean;
  connection: AgentSideConnection;
  lastInboundSeq?: number;
  outboundQueue: AcpRemoteDataFrame[];
  pendingOutboundFrames: Map<number, AcpRemoteDataFrame>;
};

export type AcpRemoteHostConnectionState = {
  active: Map<string, ActiveRelayAcpConnection>;
  hostRequestContexts: Map<
    string,
    Map<string | number, AcpHostRequestDebugContext>
  >;
  inFlightRuntimeRequests: Map<
    string,
    Map<string | number, AcpHostRequestDebugContext>
  >;
  outboundSeq: Map<string, number>;
  relayRequestContexts: Map<
    string,
    Map<string | number, AcpHostRequestDebugContext>
  >;
  socket?: AcpWebSocketLike;
  authorizationChecks: Map<string, Promise<boolean>>;
  authorizations: Map<string, AcpRemoteHostConnectionAuthorization>;
};

type AcpRemoteHostConnectionAuthorization = {
  accountId: string;
  agent?: AcpRemoteAgentGrant;
  clientId: string;
  hostId: string;
  proof: AcpRemoteConnectionProof;
  workspaceRoots?: readonly string[];
};

type AcpHostRequestDebugContext = {
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
};

const DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_QUEUED_FRAMES_PER_CONNECTION = Number.MAX_SAFE_INTEGER;

export function createAcpRemoteHostConnectionState(): AcpRemoteHostConnectionState {
  return {
    active: new Map(),
    hostRequestContexts: new Map(),
    inFlightRuntimeRequests: new Map(),
    outboundSeq: new Map(),
    relayRequestContexts: new Map(),
    authorizationChecks: new Map(),
    authorizations: new Map(),
  };
}

export function countAcpRemoteHostInFlightRuntimeRequests(
  state: Pick<AcpRemoteHostConnectionState, "inFlightRuntimeRequests">,
): number {
  let count = 0;
  for (const requests of state.inFlightRuntimeRequests.values()) {
    count += requests.size;
  }
  return count;
}

export function createAcpRemoteHostConnection(
  options: AcpRemoteHostConnectionOptions,
): AcpRemoteHostConnectionHandle {
  const state = options.state ?? createAcpRemoteHostConnectionState();
  state.socket = options.socket;
  const {
    active,
    hostRequestContexts,
    inFlightRuntimeRequests,
    outboundSeq,
    relayRequestContexts,
    authorizationChecks,
    authorizations,
  } = state;
  const maxBufferedFramesPerConnection =
    options.maxBufferedFramesPerConnection ??
    DEFAULT_MAX_BUFFERED_FRAMES_PER_CONNECTION;
  const maxQueuedFramesPerConnection =
    options.maxQueuedFramesPerConnection ??
    DEFAULT_MAX_QUEUED_FRAMES_PER_CONNECTION;
  const debugLog = options.debugLog ?? (() => {});
  const attachmentStore =
    options.attachmentStore ??
    createAcpRemoteHostAttachmentStore({
      rootDir: options.attachmentRootDir,
    });
  let disposed = false;

  const sendSocket = (data: string) => {
    state.socket?.send(data);
  };

  const onMessage = (event: { data: unknown }) => {
    void handleMessage(event);
  };

  const handleMessage = async (event: { data: unknown }) => {
    const attachment = decodeAcpRemoteAttachmentUpload(event.data);
    if (attachment) {
      await handleAttachmentUpload(attachment);
      return;
    }

    const text = normalizeWebSocketMessageData(event.data);
    if (!text) {
      return;
    }

    const frame = parseFrame(text);
    if (!frame) {
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Ping) {
      const pong: AcpRemotePongFrame = {
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Pong,
        nonce: frame.nonce,
      };
      sendSocket(JSON.stringify(pong));
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Pong) {
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Ack) {
      handleRelayAck(frame);
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Hello) {
      if (frame.endpoint !== AcpRemoteEndpointKind.Client) {
        return;
      }
      const check = validateClientHelloFrame(frame);
      authorizationChecks.set(frame.connectionId, check);
      void check.finally(() => {
        authorizationChecks.delete(frame.connectionId);
      });
      return;
    }

    if (frame.frameType === AcpRemoteFrameType.Close) {
      const entry = active.get(frame.connectionId);
      if (entry && isFinalClientCloseFrame(frame)) {
        await entry.agent.closeActiveSessions(frame.reason);
      }
      if (hasInFlightRuntimeRequests(frame.connectionId)) {
        if (entry) {
          entry.closeAfterInFlight = true;
        }
      } else {
        entry?.channel.close();
        active.delete(frame.connectionId);
      }
      hostRequestContexts.delete(frame.connectionId);
      relayRequestContexts.delete(frame.connectionId);
      authorizations.delete(frame.connectionId);
      authorizationChecks.delete(frame.connectionId);
      return;
    }

    if (
      frame.frameType !== AcpRemoteFrameType.Data ||
      (frame.channelKind !== AcpRemoteChannelKind.Acp &&
        frame.channelKind !== AcpRemoteChannelKind.Filesystem)
    ) {
      return;
    }

    if (frame.channelKind === AcpRemoteChannelKind.Filesystem) {
      sendRelayAck(frame.connectionId, frame.seq);
      void handleFilesystemControlFrame(frame);
      return;
    }

    const pendingAuthorizationCheck = authorizationChecks.get(frame.connectionId);
    if (pendingAuthorizationCheck && !(await pendingAuthorizationCheck)) {
      return;
    }
    const authorization = authorizations.get(frame.connectionId);
    if (!authorization) {
      closeRemoteConnection(
        frame.connectionId,
        "missing_authorization",
        "ACP remote connection has no valid authorization.",
      );
      return;
    }
    let entry = active.get(frame.connectionId);
    if (
      entry?.lastInboundSeq !== undefined &&
      frame.seq <= entry.lastInboundSeq
    ) {
      sendRelayAck(frame.connectionId, frame.seq);
      return;
    }
    let inboundPayload = frame.payload;
    try {
      inboundPayload = await resolveAttachmentReferencesInPayload(
        inboundPayload,
        authorization,
        frame.connectionId,
      );
    } catch (error) {
      const request = isJsonRpcRequest(inboundPayload) ? inboundPayload : undefined;
      if (request) {
        sendAcpPayloadDirect(frame.connectionId, {
          error: {
            code: -32602,
            message: `Remote attachment could not be resolved: ${formatError(error)}`,
          },
          id: request.id,
          jsonrpc: "2.0",
        });
      }
      sendRelayAck(frame.connectionId, frame.seq);
      return;
    }

    const tracedInbound = startHostPayloadSpan(
      "relay_to_host",
      frame.connectionId,
      inboundPayload,
      {
        ack: frame.ack,
        seq: frame.seq,
      },
    );
    const payloadForRuntime = tracedInbound.payload as AnyMessage;
    logRelayAcpPayload(frame.connectionId, payloadForRuntime, {
      ack: frame.ack,
      seq: frame.seq,
    });
    const request = readJournalableJsonRpcRequest(payloadForRuntime);
    if (request && options.requestJournal) {
      const duplicate = await resolveHostRequestDuplicate(
        frame.connectionId,
        request,
      );
      if (duplicate) {
        debugLog(
          `host request duplicate resolved id=${formatJsonRpcId(request.id)} method=${request.method}`,
          compactHostDebugContext({
            connectionId: frame.connectionId,
            direction: "relay_to_host",
            jsonRpcId: request.id,
            method: request.method,
            severityText: "INFO",
          }),
        );
        tracedInbound.span?.span.end();
        sendAcpPayloadDirect(frame.connectionId, duplicate);
        sendRelayAck(frame.connectionId, frame.seq);
        return;
      }
    }

    if (!entry) {
      const agent = resolveAuthorizationAgent(authorization.agent);
      const runtimeOptions = {
        ...options,
        agent: agent ?? options.agent,
        remoteHostId: authorization.hostId,
        sessionAgent: agent ?? options.agent,
        workspaceRoots: authorization.workspaceRoots ?? options.workspaceRoots,
      };
      const channel = new RelayAcpChannel(frame.connectionId, sendAcpPayload);
      let runtimeAgent: AcpRemoteRuntimeAgent | undefined;
      const connection = new AgentSideConnection(
        (agentConnection) => {
          if (!options.runtime) {
            throw new Error("ACP remote host requires a runtime.");
          }
          runtimeAgent = new AcpRemoteRuntimeAgent(agentConnection, {
            ...runtimeOptions,
            runtime: options.runtime,
          });
          return runtimeAgent;
        },
        channel.stream,
      );
      if (!runtimeAgent) {
        throw new Error("ACP remote host failed to create runtime agent.");
      }
      entry = {
        agent: runtimeAgent,
        channel,
        closeAfterInFlight: false,
        connection,
        lastInboundSeq: undefined,
        outboundQueue: [],
        pendingOutboundFrames: new Map(),
      };
      active.set(frame.connectionId, entry);
      void connection.closed.finally(() => {
        if (active.get(frame.connectionId) !== entry) {
          return;
        }
        closeRemoteConnection(
          frame.connectionId,
          "acp_connection_closed",
          "ACP connection closed.",
        );
      }).catch(() => {
        // The relay has been notified by the finalizer above.
      });
    }

    if (request && options.requestJournal) {
      try {
        await options.requestJournal.markReceived({
          connectionId: frame.connectionId,
          id: request.id,
          method: request.method,
        });
      } catch (error) {
        sendAcpPayloadDirect(frame.connectionId, {
          error: {
            code: -32002,
            message:
              "Remote host could not persist request receipt before handing it to the runtime.",
          },
          id: request.id,
          jsonrpc: "2.0",
        });
        closeRemoteConnection(
          frame.connectionId,
          "request_journal_failed",
          error instanceof Error ? error.message : "Request journal failed.",
        );
        if (tracedInbound.span) {
          recordFreeSpanError(tracedInbound.span.span, error);
          tracedInbound.span.span.end();
        }
        return;
      }
    }
    if (request) {
      rememberInFlightRuntimeRequest(frame.connectionId, request);
    }
    if (!entry.channel.enqueue(payloadForRuntime)) {
      forgetInFlightRuntimeRequest(frame.connectionId, request?.id);
      if (tracedInbound.span) {
        recordFreeSpanError(
          tracedInbound.span.span,
          new Error("ACP connection closed before receiving relay frame."),
        );
        tracedInbound.span.span.end();
      }
      closeRemoteConnection(
        frame.connectionId,
        "acp_connection_closed",
        "ACP connection closed before receiving relay frame.",
      );
      return;
    }
    tracedInbound.span?.span.end();
    entry.lastInboundSeq = frame.seq;
    sendRelayAck(frame.connectionId, frame.seq);
  };

  const handleAttachmentUpload = async (
    upload: NonNullable<ReturnType<typeof decodeAcpRemoteAttachmentUpload>>,
  ): Promise<void> => {
    let ack: AcpRemoteAttachmentAckFrame;
    try {
      const record = await attachmentStore.writeUpload(upload);
      ack = {
        attachmentId: record.attachmentId,
        connectionId: record.connectionId,
        frameType: AcpRemoteAttachmentFrameType.Ack,
        mimeType: record.mimeType,
        ok: true,
        requestId: upload.header.requestId,
        sha256: record.sha256,
        size: record.size,
        uri: record.uri,
        version: 1,
      };
    } catch (error) {
      ack = {
        attachmentId: upload.header.attachmentId,
        connectionId: upload.header.connectionId,
        error: formatError(error),
        frameType: AcpRemoteAttachmentFrameType.Ack,
        ok: false,
        requestId: upload.header.requestId,
        version: 1,
      };
    }
    sendSocket(JSON.stringify(ack));
  };

  const resolveAttachmentReferencesInPayload = async (
    payload: unknown,
    authorization: AcpRemoteHostConnectionAuthorization,
    connectionId: string,
  ): Promise<unknown> => {
    if (!isRecord(payload) || payload.method !== "session/prompt") {
      return payload;
    }
    const params = isRecord(payload.params) ? payload.params : undefined;
    const prompt = Array.isArray(params?.prompt) ? params.prompt : undefined;
    if (!params || !prompt) {
      return payload;
    }

    let changed = false;
    const resolvedPrompt = await Promise.all(
      prompt.map(async (block) => {
        if (!isRecord(block) || block.type !== "resource_link") {
          return block;
        }
        const uri = readString(block.uri);
        const mimeType = readString(block.mimeType);
        const ref = uri ? parseFreeAttachmentUri(uri) : undefined;
        if (!uri || !ref || !mimeType?.startsWith("image/")) {
          return block;
        }
        if (ref.connectionId !== connectionId) {
          throw new Error("Attachment connection mismatch.");
        }
        const image = await attachmentStore.readImage(uri, {
          accountId: authorization.accountId,
          hostId: authorization.hostId,
        });
        changed = true;
        return {
          data: image.data,
          mimeType: image.mimeType,
          type: "image",
        };
      }),
    );

    if (!changed) {
      return payload;
    }
    return {
      ...payload,
      params: {
        ...params,
        prompt: resolvedPrompt,
      },
    };
  };

  const validateClientHelloFrame = async (
    frame: Extract<AcpRemoteFrame, { frameType: typeof AcpRemoteFrameType.Hello }>,
  ): Promise<boolean> => {
    if (!frame.proof) {
      closeRemoteConnection(
        frame.connectionId,
        "missing_authorization",
        "ACP remote connection proof is missing.",
      );
      return false;
    }

    const keys = options.accountSessionVerificationKeys;
    if (!keys?.length) {
      closeRemoteConnection(
        frame.connectionId,
        "invalid_authorization",
        "Account session verification keys are not configured.",
      );
      return false;
    }

    const result = await verifyAcpRemoteConnectionProof(frame.proof, keys, {
      accountId: options.accountId,
      connectionId: frame.connectionId,
      hostId: options.hostId,
      now: options.now?.(),
    });
    if (!result.ok) {
      closeRemoteConnection(
        frame.connectionId,
        "invalid_authorization",
        result.reason,
      );
      return false;
    }
    authorizations.set(frame.connectionId, {
      accountId: result.accountId,
      agent: frame.agent,
      clientId: result.clientId,
      hostId: options.hostId,
      proof: frame.proof,
      workspaceRoots: frame.workspaceRoots,
    });
    replayAcpOutboundFrames(frame.connectionId);
    return true;
  };

  const closeRemoteConnection = (
    connectionId: string,
    code: string,
    reason: string,
  ) => {
    const entry = active.get(connectionId);
    entry?.channel.close();
    active.delete(connectionId);
    hostRequestContexts.delete(connectionId);
    inFlightRuntimeRequests.delete(connectionId);
    relayRequestContexts.delete(connectionId);
    authorizations.delete(connectionId);
    outboundSeq.delete(connectionId);
    sendSocket(
      JSON.stringify({
        code,
        connectionId,
        frameType: AcpRemoteFrameType.Close,
        reason,
      }),
    );
  };

  const handleRelayAck = (frame: AcpRemoteAckFrame) => {
    const entry = active.get(frame.connectionId);
    if (!entry) {
      return;
    }
    for (const seq of [...entry.pendingOutboundFrames.keys()].sort(
      (left, right) => left - right,
    )) {
      if (seq > frame.ack) {
        break;
      }
      entry.pendingOutboundFrames.delete(seq);
    }
    flushAcpOutboundQueue(frame.connectionId, entry);
  };

  const sendRelayAck = (connectionId: string, ack: number) => {
    sendSocket(
      JSON.stringify({
        ack,
        channelId: "acp",
        connectionId,
        frameType: AcpRemoteFrameType.Ack,
      } satisfies AcpRemoteAckFrame),
    );
  };

  const handleFilesystemControlFrame = async (
    frame: AcpRemoteDataFrame,
  ): Promise<void> => {
    const request = parseWorkspaceListRequest(frame.payload);
    if (!request) {
      return;
    }
    const result = await listWorkspaceDirectory({
      path: request.path,
      root: request.root,
      workspaceRoots: options.workspaceRoots,
    });
    sendSocket(
      JSON.stringify({
        channelId: "workspace",
        channelKind: AcpRemoteChannelKind.Filesystem,
        connectionId: frame.connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: {
          ...result,
          kind: "workspace/list/result",
          requestId: request.requestId,
        },
        seq: 1,
      } satisfies AcpRemoteDataFrame),
    );
  };

  const sendAcpPayload = (connectionId: string, payload: AnyMessage) => {
    forgetCompletedInFlightRuntimeRequest(connectionId, payload);
    const entry = active.get(connectionId);
    if (!entry) {
      return;
    }
    const seq = (outboundSeq.get(connectionId) ?? 0) + 1;
    outboundSeq.set(connectionId, seq);
    const tracedOutbound = startHostPayloadSpan(
      "host_to_relay",
      connectionId,
      payload,
      { seq },
    );
    const payloadForRelay = tracedOutbound.payload as AnyMessage;
    rememberHostRequestResponse(connectionId, payloadForRelay);
    logHostAcpPayload(connectionId, payloadForRelay, { seq });
    const frame: AcpRemoteDataFrame = {
      channelId: "acp",
      channelKind: AcpRemoteChannelKind.Acp,
      connectionId,
      frameType: AcpRemoteFrameType.Data,
      payload: payloadForRelay,
      seq,
    };
    if (
      !state.socket ||
      entry.pendingOutboundFrames.size >= maxBufferedFramesPerConnection
    ) {
      if (entry.outboundQueue.length >= maxQueuedFramesPerConnection) {
        closeRemoteConnection(
          connectionId,
          "host_outbound_queue_overflow",
          "ACP remote host outbound queue limit exceeded.",
        );
        if (tracedOutbound.span) {
          recordFreeSpanError(
            tracedOutbound.span.span,
            new Error("ACP remote host outbound queue limit exceeded."),
          );
          tracedOutbound.span.span.end();
        }
        return;
      }
      entry.outboundQueue.push(frame);
      tracedOutbound.span?.span.end();
      return;
    }
    sendQueuedAcpFrame(entry, frame);
    tracedOutbound.span?.span.end();
  };

  const sendAcpPayloadDirect = (connectionId: string, payload: AnyMessage) => {
    forgetCompletedInFlightRuntimeRequest(connectionId, payload);
    const seq = (outboundSeq.get(connectionId) ?? 0) + 1;
    outboundSeq.set(connectionId, seq);
    const tracedOutbound = startHostPayloadSpan(
      "host_to_relay",
      connectionId,
      payload,
      { seq },
    );
    const payloadForRelay = tracedOutbound.payload as AnyMessage;
    rememberHostRequestResponse(connectionId, payloadForRelay);
    logHostAcpPayload(connectionId, payloadForRelay, { seq });
    sendSocket(
      JSON.stringify({
        channelId: "acp",
        channelKind: AcpRemoteChannelKind.Acp,
        connectionId,
        frameType: AcpRemoteFrameType.Data,
        payload: payloadForRelay,
        seq,
      } satisfies AcpRemoteDataFrame),
    );
    tracedOutbound.span?.span.end();
  };

  const rememberHostRequestResponse = (
    connectionId: string,
    payload: AnyMessage,
  ) => {
    if (!options.requestJournal || !isJsonRpcResponseWithId(payload)) {
      return;
    }
    const context = relayRequestContexts.get(connectionId)?.get(payload.id);
    void options.requestJournal
      .markCompleted({
        connectionId,
        id: payload.id,
        method: context?.method,
        payload,
      })
      .catch((error) => {
        debugLog(
          `Failed to persist remote host request response: ${error instanceof Error ? error.message : error}`,
          {
            connectionId,
            jsonRpcId: payload.id,
            method: context?.method,
            severityText: "ERROR",
          },
        );
      });
  };

  const rememberInFlightRuntimeRequest = (
    connectionId: string,
    request: { id: string | number; method: string },
  ) => {
    const context = relayRequestContexts.get(connectionId)?.get(request.id);
    requestContextMap(inFlightRuntimeRequests, connectionId).set(request.id, {
      method: context?.method ?? request.method,
      sessionId: context?.sessionId,
      traceContext: context?.traceContext,
    });
  };

  const forgetCompletedInFlightRuntimeRequest = (
    connectionId: string,
    payload: AnyMessage,
  ) => {
    if (!isJsonRpcResponseWithId(payload)) {
      return;
    }
    forgetInFlightRuntimeRequest(connectionId, payload.id);
  };

  const forgetInFlightRuntimeRequest = (
    connectionId: string,
    id: string | number | undefined,
  ) => {
    if (id === undefined) {
      return;
    }
    const requests = inFlightRuntimeRequests.get(connectionId);
    if (!requests) {
      return;
    }
    requests.delete(id);
    if (requests.size === 0) {
      inFlightRuntimeRequests.delete(connectionId);
      closeDeferredConnectionIfIdle(connectionId);
    }
  };

  const hasInFlightRuntimeRequests = (connectionId: string): boolean =>
    (inFlightRuntimeRequests.get(connectionId)?.size ?? 0) > 0;

  const closeDeferredConnectionIfIdle = (connectionId: string) => {
    const entry = active.get(connectionId);
    if (!entry?.closeAfterInFlight || hasInFlightRuntimeRequests(connectionId)) {
      return;
    }
    entry.channel.close();
    active.delete(connectionId);
  };

  const isFinalClientCloseFrame = (
    frame: Extract<AcpRemoteFrame, { frameType: typeof AcpRemoteFrameType.Close }>,
  ): boolean =>
    frame.code === "client_closed" ||
    frame.code === "client_reconnect_timeout";

  const resolveHostRequestDuplicate = async (
    connectionId: string,
    request: { id: string | number; method: string },
  ): Promise<AnyMessage | undefined> => {
    if (!options.requestJournal) {
      return undefined;
    }
    const entry = await options.requestJournal.lookup(connectionId, request.id);
    if (!entry) {
      return undefined;
    }
    if (entry.status === "completed" && entry.payload) {
      return entry.payload;
    }
    if (isReplayableRuntimeRequestAfterRestart(request.method)) {
      return undefined;
    }
    return {
      error: {
        code: -32003,
        data: {
          method: entry.method ?? request.method,
          status: entry.status,
        },
        message:
          "Remote host already delivered this request to the runtime before restart; the result is unknown and the request was not replayed.",
      },
      id: request.id,
      jsonrpc: "2.0",
    };
  };

  const isReplayableRuntimeRequestAfterRestart = (method: string): boolean =>
    method === "session/load" || method === "session/resume";

  const sendQueuedAcpFrame = (
    entry: ActiveRelayAcpConnection,
    frame: AcpRemoteDataFrame,
  ) => {
    entry.pendingOutboundFrames.set(frame.seq, frame);
    sendSocket(JSON.stringify(frame));
  };

  const replayAcpOutboundFrames = (connectionId: string) => {
    const entry = active.get(connectionId);
    if (!entry || !state.socket) {
      return;
    }
    for (const frame of [...entry.pendingOutboundFrames.values()].sort(
      (left, right) => left.seq - right.seq,
    )) {
      sendSocket(JSON.stringify(frame));
    }
    flushAcpOutboundQueue(connectionId, entry);
  };

  const flushAcpOutboundQueue = (
    connectionId: string,
    entry: ActiveRelayAcpConnection,
  ) => {
    while (
      active.get(connectionId) === entry &&
      entry.outboundQueue.length > 0 &&
      entry.pendingOutboundFrames.size < maxBufferedFramesPerConnection
    ) {
      const next = entry.outboundQueue.shift();
      if (!next) {
        return;
      }
      sendQueuedAcpFrame(entry, next);
    }
  };

  const onClose = () => {
    if (state.socket === options.socket) {
      state.socket = undefined;
    }
  };

  const disposeState = () => {
    for (const entry of active.values()) {
      entry.channel.close();
    }
    active.clear();
    hostRequestContexts.clear();
    inFlightRuntimeRequests.clear();
    outboundSeq.clear();
    relayRequestContexts.clear();
    authorizations.clear();
    authorizationChecks.clear();
  };

  function logAcpPayload(
    direction: "relay_to_host" | "host_to_relay",
    sourceMap: Map<string, Map<string | number, AcpHostRequestDebugContext>>,
    targetMap: Map<string, Map<string | number, AcpHostRequestDebugContext>>,
    connectionId: string,
    payload: unknown,
    frameContext?: { ack?: number; seq?: number },
  ): void {
    const details = readAcpPayloadDebugDetails(payload);
    const payloadSummary = summarizeAcpRemotePayloadForLog(payload);
    const responseContext =
      details.id !== undefined && details.isResponse
        ? sourceMap.get(connectionId)?.get(details.id)
        : undefined;
    const method = details.method ?? responseContext?.method;
    const sessionId = details.sessionId ?? responseContext?.sessionId;
    const traceContext = details.traceContext ?? responseContext?.traceContext;
    if (details.id !== undefined && details.isResponse) {
      sourceMap.get(connectionId)?.delete(details.id);
    } else if (details.id !== undefined && details.method) {
      requestContextMap(targetMap, connectionId).set(details.id, {
        method: details.method,
        sessionId: details.sessionId,
        traceContext: details.traceContext,
      });
    }
    const label = direction === "relay_to_host" ? "relay -> host" : "host -> relay";
    debugLog(
      `${label} id=${formatJsonRpcId(details.id)} method=${
        method ?? "-"
      } error=${details.hasError ? "yes" : "no"}${
        sessionId ? ` sessionId=${sessionId}` : ""
      }${traceContext ? ` traceId=${traceContext.traceId}` : ""}`,
      compactHostDebugContext({
        connectionId,
        direction,
        ...frameContext,
        freeMessageId: messageIdFromPayloadSummary(payloadSummary),
        freePhase: phaseForHostTransport(direction, method),
        jsonRpcId: details.id,
        method,
        ...payloadSummary,
        sessionId,
        ...traceContextToDebugFields(traceContext),
        severityText: details.hasError ? "ERROR" : "INFO",
      }),
    );
  }

  function logRelayAcpPayload(
    connectionId: string,
    payload: unknown,
    frameContext?: { ack?: number; seq?: number },
  ): void {
    logAcpPayload(
      "relay_to_host",
      hostRequestContexts,
      relayRequestContexts,
      connectionId,
      payload,
      frameContext,
    );
  }

  function logHostAcpPayload(
    connectionId: string,
    payload: unknown,
    frameContext?: { ack?: number; seq?: number },
  ): void {
    logAcpPayload(
      "host_to_relay",
      relayRequestContexts,
      hostRequestContexts,
      connectionId,
      payload,
      frameContext,
    );
  }

  function startHostPayloadSpan(
    direction: "relay_to_host" | "host_to_relay",
    connectionId: string,
    payload: unknown,
    frameContext?: { ack?: number; seq?: number },
  ): {
    payload: unknown;
    span?: FreeSpanHandle;
  } {
    const details = readAcpPayloadDebugDetails(payload);
    const payloadSummary = summarizeAcpRemotePayloadForLog(payload);
    if (!details.traceContext) {
      return { payload };
    }
    const span = startFreeSpan(
      spanNameForHostTransport(direction, details.method),
      {
        attributes: {
          "acp.jsonrpc.id": details.id === undefined ? undefined : String(details.id),
          "acp.jsonrpc.method": details.method,
          "acp.remote.ack": frameContext?.ack,
          "acp.remote.component": "host",
          "acp.remote.connection_id": connectionId,
          "acp.remote.direction": direction,
          "acp.remote.seq": frameContext?.seq,
          "acp.session.id": details.sessionId,
          "free.message.id": messageIdFromPayloadSummary(payloadSummary),
          "free.message.prompt_text_chars": payloadSummary.promptTextChars,
          "free.message.prompt_text_hash": payloadSummary.promptTextHash,
          "free.phase": phaseForHostTransport(direction, details.method),
        },
        kind: direction === "relay_to_host" ? SpanKind.SERVER : SpanKind.CLIENT,
        traceContext: details.traceContext,
      },
    );
    if (!span.traceparent || !isRecord(payload)) {
      return { payload, span };
    }
    return {
      payload: withAcpRemoteTraceparentInJsonRpcMessage(
        payload,
        span.traceparent,
      ),
      span,
    };
  }

  options.socket.addEventListener("message", onMessage);
  options.socket.addEventListener("close", onClose);
  options.socket.addEventListener("error", onClose);

  return {
    close() {
      if (disposed) {
        return;
      }
      disposed = true;
      options.socket.removeEventListener?.("message", onMessage);
      options.socket.removeEventListener?.("close", onClose);
      options.socket.removeEventListener?.("error", onClose);
      if (state.socket === options.socket) {
        state.socket = undefined;
      }
      disposeState();
      options.socket.close(1000, "ACP remote host connection closed.");
    },
  };
}

function readAcpPayloadDebugDetails(payload: unknown): {
  hasError: boolean;
  id?: string | number;
  isResponse: boolean;
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
} {
  if (!isRecord(payload)) {
    return {
      hasError: false,
      isResponse: false,
    };
  }
  const id = isJsonRpcId(payload.id) ? payload.id : undefined;
  const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
  const isResponse =
    hasError || Object.prototype.hasOwnProperty.call(payload, "result");
  const method = typeof payload.method === "string" ? payload.method : undefined;
  return {
    hasError,
    id,
    isResponse,
    method,
    sessionId: readPayloadSessionId(payload),
    traceContext: readAcpRemoteTraceContextFromJsonRpcMessage(payload),
  };
}

function readPayloadSessionId(payload: Record<string, unknown>): string | undefined {
  const params = isRecord(payload.params) ? payload.params : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  return readString(params?.sessionId) ?? readString(result?.sessionId);
}

function requestContextMap(
  maps: Map<string, Map<string | number, AcpHostRequestDebugContext>>,
  connectionId: string,
): Map<string | number, AcpHostRequestDebugContext> {
  const existing = maps.get(connectionId);
  if (existing) {
    return existing;
  }
  const next = new Map<string | number, AcpHostRequestDebugContext>();
  maps.set(connectionId, next);
  return next;
}

function compactHostDebugContext(
  context: AcpRemoteHostDebugContext,
): AcpRemoteHostDebugContext | undefined {
  const compacted = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as AcpRemoteHostDebugContext;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function traceContextToDebugFields(
  traceContext: AcpRemoteTraceContext | undefined,
): Pick<
  AcpRemoteHostDebugContext,
  "spanId" | "traceId" | "traceparent"
> {
  return traceContext
    ? {
        spanId: traceContext.spanId,
        traceId: traceContext.traceId,
        traceparent: traceContext.traceparent,
      }
    : {};
}

function spanNameForHostTransport(
  direction: "relay_to_host" | "host_to_relay",
  method: string | undefined,
): string {
  if (method === "session/prompt") {
    return direction === "relay_to_host"
      ? "free.host.receive_prompt"
      : "free.host.return_result";
  }
  return `free.host.transport.${direction}.${method ?? "message"}`;
}

function phaseForHostTransport(
  direction: "relay_to_host" | "host_to_relay",
  method: string | undefined,
): string | undefined {
  if (method !== "session/prompt") {
    return undefined;
  }
  return direction === "relay_to_host" ? "host.receive" : "host.return_result";
}

function messageIdFromPayloadSummary(
  summary: AcpRemotePayloadLogSummary,
): string | undefined {
  return summary.promptMessageId ??
    summary.responseUserMessageId ??
    summary.updateMessageId;
}

function formatJsonRpcId(id: unknown): string {
  return isJsonRpcId(id) ? String(id) : "-";
}

function isJsonRpcId(id: unknown): id is string | number {
  return typeof id === "string" || typeof id === "number";
}

function resolveAuthorizationAgent(
  agent: AcpRemoteAgentGrant | undefined,
): AcpRuntimeAgentInput | undefined {
  if (!agent) {
    return undefined;
  }
  if ("id" in agent) {
    return agent.id;
  }
  return {
    args: agent.args as string[] | undefined,
    command: agent.command,
    env: agent.env,
    type: agent.type,
  };
}

type WorkspaceListRequest = {
  kind: "workspace/list";
  path?: string;
  requestId: string;
  root: string;
};

function parseWorkspaceListRequest(value: unknown): WorkspaceListRequest | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "workspace/list" ||
    typeof record.requestId !== "string" ||
    typeof record.root !== "string"
  ) {
    return undefined;
  }
  return {
    kind: "workspace/list",
    path: typeof record.path === "string" ? record.path : undefined,
    requestId: record.requestId,
    root: record.root,
  };
}

async function listWorkspaceDirectory(input: {
  path?: string;
  root: string;
  workspaceRoots?: readonly string[];
}): Promise<
  | {
      ok: true;
      path: string;
      entries: readonly { name: string; path: string; type: "directory" }[];
    }
  | { ok: false; reason: string }
> {
  const configuredRoots = input.workspaceRoots?.length
    ? input.workspaceRoots
    : [input.root];
  const requestedRoot = await safeRealpath(resolve(input.root));
  const allowedRoots = await Promise.all(
    configuredRoots.map((root) => safeRealpath(resolve(root))),
  );
  if (!allowedRoots.some((root) => pathContains(root, requestedRoot))) {
    return { ok: false, reason: "Workspace root is not allowed." };
  }

  const requestedPath = await safeRealpath(resolve(input.path ?? input.root));
  if (!pathContains(requestedRoot, requestedPath)) {
    return { ok: false, reason: "Workspace path is outside the selected root." };
  }

  try {
    const entries = await readdir(requestedPath, { withFileTypes: true });
    return {
      entries: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => ({
          name: entry.name,
          path: resolve(requestedPath, entry.name),
          type: "directory" as const,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      ok: true,
      path: requestedPath,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error
        ? error.message
        : `Unable to list workspace directory ${basename(requestedPath)}.`,
    };
  }
}

function isJsonRpcResponseWithId(
  payload: AnyMessage,
): payload is AnyMessage & { id: string | number } {
  if (typeof payload !== "object" || payload === null) {
    return false;
  }
  const candidate = payload as {
    id?: unknown;
    jsonrpc?: unknown;
    method?: unknown;
  };
  return (
    candidate.jsonrpc === "2.0" &&
    candidate.method === undefined &&
    (typeof candidate.id === "string" || typeof candidate.id === "number")
  );
}

function readJournalableJsonRpcRequest(
  payload: unknown,
): { id: string | number; method: string } | undefined {
  if (!isJsonRpcRequest(payload)) {
    return undefined;
  }
  if (typeof payload.id !== "string" && typeof payload.id !== "number") {
    return undefined;
  }
  return {
    id: payload.id,
    method: payload.method,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RelayAcpChannel {
  private closed = false;
  private controller: ReadableStreamDefaultController<AnyMessage> | undefined;
  readonly stream: Stream;

  constructor(
    private readonly connectionId: string,
    private readonly sendMessage: (connectionId: string, message: AnyMessage) => void,
  ) {
    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.controller = controller;
        },
        cancel: () => {
          this.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        abort: () => {
          this.close();
        },
        close: () => {
          this.close();
        },
        write: (message) => {
          this.send(message);
        },
      }),
    };
  }

  enqueue(message: AnyMessage): boolean {
    if (this.closed) {
      return false;
    }
    this.controller?.enqueue(message);
    return true;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.controller?.close();
  }

  private send(message: AnyMessage): void {
    if (this.closed) {
      return;
    }
    this.sendMessage(this.connectionId, message);
  }
}
