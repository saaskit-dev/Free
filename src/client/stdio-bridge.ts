import type { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  connectAcpRemoteClientRelay,
  type ConnectedAcpRemoteClientRelay,
  type ConnectAcpRemoteClientRelayOptions,
} from "./relay-client.js";
import {
  ensureAcpRemoteTraceContext,
  readAcpRemoteTraceContextFromJsonRpcMessage,
  writeAcpRemoteTraceparentToJsonRpcMessage,
  type AcpRemoteTraceContext,
} from "../shared/trace-context.js";
import {
  recordFreeSpanError,
  SpanKind,
  startFreeSpan,
  type FreeSpanHandle,
} from "../observability/spans.js";
import { createAcpRemoteReconnectBackoff } from "../shared/reconnect.js";
import {
  summarizeAcpRemotePayloadForLog,
  type AcpRemotePayloadLogSummary,
} from "../shared/payload-log-summary.js";
import {
  createAcpRemoteConnectionProof,
  encodeAcpRemoteConnectionProof,
  type AcpRemoteAccountSessionCredential,
  type AcpRemoteConnectionProof,
} from "../protocol/account-session.js";
import { resolveFreeWorkbenchOriginForRelayUrl } from "../relay-environment.js";

export type AcpRemoteStdioBridgeOptions = Omit<
  ConnectAcpRemoteClientRelayOptions,
  "onMessage"
> & {
  autoAuthorize?: {
    accountSession: string;
    hostId?: string;
  };
  connectionProofCredential?: AcpRemoteAccountSessionCredential;
  hostDisplayNames?: ReadonlyMap<string, string>;
  input?: Readable;
  debugLog?: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void;
  openAuthUrl?: (url: string) => void;
  output?: Writable;
  reconnect?: {
    maxDelayMs?: number;
    maxQueuedMessages?: number;
    minDelayMs?: number;
  };
};

export type AcpRemoteBridgeDebugContext = {
  connectionId?: string;
  direction?: "client_to_relay" | "relay_to_client";
  eventName?: string;
  freeMessageId?: string;
  freePhase?: string;
  jsonRpcId?: string | number;
  method?: string;
  sessionId?: string;
  spanId?: string;
  severityText?: "ERROR" | "INFO";
  traceId?: string;
  traceparent?: string;
} & AcpRemotePayloadLogSummary;

export type AcpRemoteStdioBridgeHandle = {
  close(): void;
  connection: ConnectedAcpRemoteClientRelay;
};

const MAX_BRIDGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const DEFAULT_BRIDGE_AUTH_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export function createAcpRemoteStdioBridge(
  options: AcpRemoteStdioBridgeOptions,
): AcpRemoteStdioBridgeHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const openAuthUrl = options.openAuthUrl ?? openUrl;
  const connectionId = options.connectionId ?? crypto.randomUUID();
  const reconnectQueuePauseThreshold =
    options.reconnect?.maxQueuedMessages ?? Number.MAX_SAFE_INTEGER;
  const reconnectQueueHardLimit =
    reconnectQueuePauseThreshold === Number.MAX_SAFE_INTEGER
      ? Number.MAX_SAFE_INTEGER
      : reconnectQueuePauseThreshold * 2;
  const pendingOutbound: PendingOutboundMessage[] = [];
  const deliveredResponseIds = new Set<string | number>();
  let authorizePromise: Promise<void> | undefined;
  let authUrl: string | undefined;
  let closed = false;
  let inputPausedForReconnectQueue = false;
  const reconnectBackoff = createAcpRemoteReconnectBackoff({
    maxDelayMs: options.reconnect?.maxDelayMs,
    minDelayMs: options.reconnect?.minDelayMs,
  });
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connection: ConnectedAcpRemoteClientRelay | undefined;
  let lineBuffer = "";
  const requestMethods = new Map<string | number, string>();
  const requestSessionIds = new Map<string | number, string>();
  const requestTraceContexts = new Map<string | number, AcpRemoteTraceContext>();
  const requestSpans = new Map<string | number, FreeSpanHandle>();
  const inFlightOutbound = new Map<string | number, PendingOutboundMessage>();
  const authRequestTimers = new Map<string | number, ReturnType<typeof setTimeout>>();
  const authRequestTimeoutMs = readBridgeAuthRequestTimeoutMs(process.env);
  const debugLog = options.debugLog ?? (() => {});
  const sessionBindings = createSessionBindingStore({
    debugLog,
    relayUrl: String(options.relayUrl),
  });
  const remoteDisplayConfigOptionsBySessionId = new Map<string, unknown>();
  const configOptionsBySessionId = new Map<string, unknown[]>();
  let lastConfigOptions: unknown[] = [];

  const connect = () => {
    if (closed) {
      return;
    }
    connection = connectAcpRemoteClientRelay({
      ...options,
      connectionId,
      nativeClientAck: true,
      onClose(event) {
        if (closed) {
          options.onClose?.(event);
          return;
        }
        connection = undefined;
        debugLog(
          `relay connection closed code=${event?.code ?? "-"} reason=${
            event?.reason ?? "-"
          }`,
          {
            connectionId,
            eventName: "acp.remote.bridge.relay_closed",
            severityText: "ERROR",
          },
        );
        settleInFlightRequestsAfterRelayClose();
        scheduleReconnect();
      },
      onError(error) {
        options.onError?.(error);
      },
      onMessage(message) {
        const responseId = readJsonRpcResponseId(message);
        if (isDuplicateDeliveredResponse(responseId)) {
          if (responseId !== undefined) {
            sendNativeClientAck({ id: responseId });
          }
          return;
        }
        if (responseId !== undefined) {
          clearAuthRequestTimer(responseId);
          inFlightOutbound.delete(responseId);
        }
        sessionBindings.storeFromResponse(message, requestMethods);
        const notificationSessionId = readMessageSessionIdFromJson(message);
        const responseSessionId =
          responseId !== undefined
            ? requestSessionIds.get(responseId)
            : undefined;
        const displaySessionId = responseSessionId ?? notificationSessionId;
        const clientMessage = injectRemoteDisplayConfigOption(
          message,
          displaySessionId
            ? remoteDisplayConfigOptionsBySessionId.get(displaySessionId)
            : undefined,
          options.hostDisplayNames,
        );
        const clientSessionId =
          readResultSessionId(clientMessage) ?? displaySessionId;
        const remoteDisplayConfigOption = readRemoteConfigOption(
          readConfigOptions(clientMessage),
        );
        if (clientSessionId && remoteDisplayConfigOption) {
          remoteDisplayConfigOptionsBySessionId.set(
            clientSessionId,
            remoteDisplayConfigOption,
          );
        }
        const clientConfigOptions = readConfigOptions(clientMessage);
        if (clientConfigOptions) {
          lastConfigOptions = clientConfigOptions;
          if (clientSessionId) {
            configOptionsBySessionId.set(clientSessionId, clientConfigOptions);
          }
        }
        const nativeClientAckSeq = readNativeClientAckSeq(clientMessage);
        let outputMessage =
          nativeClientAckSeq !== undefined
            ? stripNativeClientAckSeq(clientMessage)
            : clientMessage;
        const relayAuthUrl = readRelayAuthUrl(outputMessage);
        authUrl = relayAuthUrl ?? authUrl;
        outputMessage = rewriteRelayAuthUrlForWorkbench(outputMessage);
        const relayOutputInfo = logRelayMessage(
          outputMessage,
          requestMethods,
          requestSessionIds,
          requestTraceContexts,
          connectionId,
          debugLog,
        );
        if (authUrl && options.autoAuthorize && !authorizePromise) {
          debugLog("auto-authorize relay browser authentication");
          authorizePromise = authorizeRelay({
            authUrl,
            ...options.autoAuthorize,
          });
        }
        writeOutput(output, `${outputMessage}\n`, () => {
          endClientRequestSpan(
            relayOutputInfo.id,
            {
              "acp.remote.stdout_write_failed": true,
              hasError: true,
              method: relayOutputInfo.method,
              sessionId: relayOutputInfo.sessionId,
            },
            new Error("Bridge stdout write failed."),
          );
          debugLog(
            `stdout write failed id=${formatJsonRpcId(relayOutputInfo.id)} method=${
              relayOutputInfo.method ?? "-"
            }`,
            compactBridgeDebugContext({
              connectionId,
              direction: "relay_to_client",
              eventName: "acp.remote.bridge.stdout_write_failed",
              jsonRpcId: isJsonRpcId(relayOutputInfo.id) ? relayOutputInfo.id : undefined,
              method: relayOutputInfo.method,
              severityText: "ERROR",
              sessionId: relayOutputInfo.sessionId,
              ...traceContextToDebugFields(relayOutputInfo.traceContext),
            }),
          );
          close();
        }, () => {
          endClientRequestSpan(relayOutputInfo.id, {
            hasError: relayOutputInfo.hasError,
            method: relayOutputInfo.method,
            sessionId: relayOutputInfo.sessionId,
          });
          debugLog(
            `stdout flushed id=${formatJsonRpcId(relayOutputInfo.id)} method=${
              relayOutputInfo.method ?? "-"
            }`,
            compactBridgeDebugContext({
              connectionId,
              direction: "relay_to_client",
              eventName: "acp.remote.bridge.stdout_flushed",
              jsonRpcId: isJsonRpcId(relayOutputInfo.id) ? relayOutputInfo.id : undefined,
              method: relayOutputInfo.method,
              severityText: "INFO",
              sessionId: relayOutputInfo.sessionId,
              ...traceContextToDebugFields(relayOutputInfo.traceContext),
            }),
          );
          if (nativeClientAckSeq !== undefined) {
            sendNativeClientAck({ seq: nativeClientAckSeq });
          }
          if (responseId !== undefined) {
            deliveredResponseIds.add(responseId);
            sendNativeClientAck({ id: responseId });
          }
        });
      },
    });
    debugLog(`relay connection active connectionId=${connectionId}`, {
      connectionId,
      eventName: "acp.remote.bridge.relay_connected",
      severityText: "INFO",
    });
    flushPendingOutbound();
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) {
      return;
    }
    const delayMs = reconnectBackoff.nextDelayMs();
    debugLog(
      `relay connection closed; reconnecting in ${Math.round(delayMs / 1000)}s`,
      {
        connectionId,
        eventName: "acp.remote.bridge.reconnect_scheduled",
        severityText: "INFO",
      },
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delayMs);
  };

  const flushPendingOutbound = () => {
    if (!connection) {
      return;
    }
    replayInFlightOutbound();
    const flushed = pendingOutbound.length;
    while (pendingOutbound.length > 0) {
      const next = pendingOutbound.shift();
      if (next !== undefined) {
        trackInFlightOutbound(next.message);
        connection.send(next.message);
      }
    }
    if (flushed > 0) {
      debugLog(`flushed ${flushed} queued relay message(s)`, {
        connectionId,
        eventName: "acp.remote.bridge.reconnect_queue_flushed",
        severityText: "INFO",
      });
    }
    resumeInputAfterReconnectQueue();
  };

  const sendToRelay = (message: string) => {
    if (!connection) {
      queueOutbound(message);
      return;
    }
    reconnectBackoff.reset();
    trackInFlightOutbound(message);
    connection.send(message);
  };

  const queueOutbound = (message: string) => {
    const id = readJsonRpcRequestId(message);
    const queued: PendingOutboundMessage = {
      id,
      message,
    };
    if (pendingOutbound.length >= reconnectQueueHardLimit) {
      debugLog(
        `relay reconnect queue limit exceeded id=${formatJsonRpcId(id)}`,
        {
          connectionId,
          eventName: "acp.remote.bridge.reconnect_queue_overflow",
          jsonRpcId: id,
          severityText: "ERROR",
        },
      );
      close();
      return;
    }
    pendingOutbound.push(queued);
    debugLog(`queued relay message while reconnecting id=${formatJsonRpcId(id)}`, {
      connectionId,
      eventName: "acp.remote.bridge.reconnect_queue_enqueued",
      jsonRpcId: id,
      severityText: "INFO",
    });
    if (pendingOutbound.length >= reconnectQueuePauseThreshold) {
      pauseInputForReconnectQueue();
    }
  };

  const pauseInputForReconnectQueue = () => {
    if (inputPausedForReconnectQueue) {
      return;
    }
    inputPausedForReconnectQueue = true;
    input.pause();
    debugLog("paused stdio input while relay reconnect queue drains", {
      connectionId,
      eventName: "acp.remote.bridge.reconnect_queue_paused",
      severityText: "INFO",
    });
  };

  const resumeInputAfterReconnectQueue = () => {
    if (!inputPausedForReconnectQueue || pendingOutbound.length > 0) {
      return;
    }
    inputPausedForReconnectQueue = false;
    input.resume();
    debugLog("resumed stdio input after relay reconnect queue flushed", {
      connectionId,
      eventName: "acp.remote.bridge.reconnect_queue_resumed",
      severityText: "INFO",
    });
  };

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    connection?.close();
    clearAuthRequestTimers();
    pendingOutbound.splice(0);
    inFlightOutbound.clear();
    resumeInputAfterReconnectQueue();
    requestMethods.clear();
    requestSessionIds.clear();
    requestTraceContexts.clear();
    endAllClientRequestSpans(
      new Error("Bridge closed before request completed."),
    );
    options.onClose?.();
  };

  const preparePromptAttachmentsForRelay = async (
    message: string,
  ): Promise<
    | { ok: true; message: string }
    | { ok: false; response: string }
  > => {
    const parsed = parseJson(message);
    if (!parsed || parsed.method !== "session/prompt") {
      return { ok: true, message };
    }
    const params = isRecord(parsed.params) ? parsed.params : undefined;
    if (!params || !Array.isArray(params.prompt)) {
      return { ok: true, message };
    }
    const prompt = params.prompt;
    if (!prompt.some(isInlineImageBlock)) {
      return { ok: true, message };
    }
    const requestId = isJsonRpcId(parsed.id) ? parsed.id : undefined;
    const hostId =
      readRemoteHostIdFromParams(params) ??
      options.hostId ??
      options.connectionProof?.hostId;
    if (!hostId) {
      return {
        ok: false,
        response: createJsonRpcErrorResponse(
          requestId,
          "Remote image attachments require an authorized host route.",
        ),
      };
    }
    const proof = selectConnectionProofForHost({
      connectionProof: options.connectionProof,
      connectionProofs: options.connectionProofs,
      hostId,
    });
    if (!proof) {
      return {
        ok: false,
        response: createJsonRpcErrorResponse(
          requestId,
          "Remote image attachments require a connection proof for the selected host.",
        ),
      };
    }
    const messageId = readString(params.messageId) ?? crypto.randomUUID();
    try {
      const preparedPrompt = await Promise.all(
        prompt.map(async (block, index) => {
          if (!isInlineImageBlock(block)) {
            return block;
          }
          const attachment = await uploadPromptImageAttachment({
            block,
            connectionId,
            credential: options.connectionProofCredential,
            hostId,
            messageId,
            proof,
            relayUrl: options.relayUrl,
          });
          return {
            mimeType: attachment.mimeType,
            name: `image-${index + 1}`,
            size: attachment.size,
            title: `image-${index + 1}`,
            type: "resource_link",
            uri: attachment.uri,
          };
        }),
      );
      return {
        ok: true,
        message: JSON.stringify({
          ...parsed,
          params: {
            ...params,
            messageId,
            prompt: preparedPrompt,
          },
        }),
      };
    } catch (error) {
      return {
        ok: false,
        response: createJsonRpcErrorResponse(
          requestId,
          `Remote image attachment upload failed: ${formatError(error)}`,
        ),
      };
    }
  };

  const isDuplicateDeliveredResponse = (id?: string | number): boolean => {
    if (id === undefined) {
      return false;
    }
    if (deliveredResponseIds.has(id)) {
      debugLog(`relay duplicate response suppressed id=${formatJsonRpcId(id)}`, {
        connectionId,
        eventName: "acp.remote.bridge.duplicate_response_suppressed",
        jsonRpcId: id,
        severityText: "ERROR",
      });
      return true;
    }
    return false;
  };

  const sendNativeClientAck = (ack: { id?: string | number; seq?: number }) => {
    connection?.send(JSON.stringify({
      jsonrpc: "2.0",
      method: NATIVE_CLIENT_ACK_METHOD,
      params: ack,
    }));
    debugLog(
      ack.id !== undefined
        ? `relay response acknowledged id=${formatJsonRpcId(ack.id)}`
        : `relay notification acknowledged seq=${ack.seq ?? "-"}`,
      {
        connectionId,
        eventName: "acp.remote.bridge.client_ack_sent",
        jsonRpcId: ack.id,
        severityText: "INFO",
      },
    );
  };

  const trackInFlightOutbound = (message: string) => {
    const request = readJsonRpcRequest(message);
    if (!request) {
      return;
    }
    inFlightOutbound.set(request.id, {
      id: request.id,
      message,
      method: request.method,
    });
  };

  const replayInFlightOutbound = () => {
    if (!connection || inFlightOutbound.size === 0) {
      return;
    }
    const replayable = [...inFlightOutbound.values()].filter((entry) =>
      isReplayableRelayClientRequest(entry.method)
    );
    for (const entry of replayable) {
      connection.send(entry.message);
    }
    if (replayable.length > 0) {
      debugLog(`replayed ${replayable.length} in-flight relay request(s)`, {
        connectionId,
        eventName: "acp.remote.bridge.inflight_replayed",
        severityText: "INFO",
      });
    }
  };

  const settleInFlightRequestsAfterRelayClose = () => {
    for (const entry of [...inFlightOutbound.values()]) {
      if (isReplayableRelayClientRequest(entry.method)) {
        continue;
      }
      clearAuthRequestTimer(entry.id);
      inFlightOutbound.delete(entry.id!);
      requestMethods.delete(entry.id!);
      requestSessionIds.delete(entry.id!);
      requestTraceContexts.delete(entry.id!);
      const response = createRelayConnectionLostResponse(entry);
      endClientRequestSpan(
        entry.id,
        {
          "acp.remote.failure": "relay_connection_closed",
          hasError: true,
          method: entry.method,
        },
        new Error("Relay connection closed before this request completed."),
      );
      writeOutput(output, `${response}\n`, () => close());
      debugLog(
        `failed in-flight relay request after disconnect id=${formatJsonRpcId(
          entry.id,
        )} method=${entry.method}`,
        {
          connectionId,
          eventName: "acp.remote.bridge.inflight_failed",
          jsonRpcId: entry.id,
          method: entry.method,
          severityText: "ERROR",
        },
      );
    }
  };

  const clearAuthRequestTimer = (id: string | number | undefined): void => {
    if (id === undefined) {
      return;
    }
    const timer = authRequestTimers.get(id);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    authRequestTimers.delete(id);
  };

  const clearAuthRequestTimers = (): void => {
    for (const timer of authRequestTimers.values()) {
      clearTimeout(timer);
    }
    authRequestTimers.clear();
  };

  const armAuthRequestTimeout = (message: string, authorizationUrl: string): void => {
    const request = readJsonRpcRequest(message);
    if (!request || !isAuthGatedRequest(request.method)) {
      return;
    }
    clearAuthRequestTimer(request.id);
    const timer = setTimeout(() => {
      authRequestTimers.delete(request.id);
      const inFlight = inFlightOutbound.get(request.id);
      const queuedIndex = pendingOutbound.findIndex((entry) => entry.id === request.id);
      if (!inFlight && queuedIndex === -1) {
        return;
      }
      if (queuedIndex !== -1) {
        pendingOutbound.splice(queuedIndex, 1);
      }
      inFlightOutbound.delete(request.id);
      deliveredResponseIds.add(request.id);
      const response = createAuthorizationTimeoutResponse({
        authorizationUrl: toWorkbenchAuthorizationUrl(authorizationUrl),
        connectionId,
        request,
        timeoutMs: authRequestTimeoutMs,
      });
      endClientRequestSpan(
        request.id,
        {
          "acp.remote.failure": "authorization_timeout",
          hasError: true,
          method: request.method,
        },
        new Error("Free authorization was not completed before the bridge timeout."),
      );
      writeOutput(output, `${response}\n`, () => close());
      setTimeout(() => close(), 0);
      debugLog(
        `authorization timed out id=${formatJsonRpcId(request.id)} method=${request.method}`,
        {
          connectionId,
          eventName: "acp.remote.bridge.authorization_timeout",
          jsonRpcId: request.id,
          method: request.method,
          severityText: "ERROR",
        },
      );
    }, authRequestTimeoutMs);
    authRequestTimers.set(request.id, timer);
  };

  connect();

  const onData = (chunk: Buffer | string) => {
    lineBuffer += String(chunk);
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    void forwardLines(lines).catch(() => close());
  };

  const forwardLines = async (lines: string[]) => {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        let outbound = sessionBindings.applyToRequest(trimmed);
        const sessionSelection = isRelaySessionNewRequest(outbound)
          ? addSessionSelectionId(outbound, connectionId)
          : undefined;
        outbound = sessionSelection?.message ?? outbound;
        const outboundSessionId = readMessageSessionIdFromJson(outbound);
        const remoteConfigResponse = createRemoteConfigSetResponse(
          outbound,
          outboundSessionId
            ? configOptionsBySessionId.get(outboundSessionId) ?? lastConfigOptions
            : lastConfigOptions,
        );
        if (remoteConfigResponse) {
          writeOutput(output, `${remoteConfigResponse}\n`, () => close());
          continue;
        }
        const attachmentPreparation = await preparePromptAttachmentsForRelay(
          outbound,
        );
        if (!attachmentPreparation.ok) {
          writeOutput(output, `${attachmentPreparation.response}\n`, () => close());
          continue;
        }
        outbound = attachmentPreparation.message;
        outbound = startClientRequestSpan(outbound);
        logClientMessage(
          outbound,
          requestMethods,
          requestSessionIds,
          requestTraceContexts,
          connectionId,
          debugLog,
        );
        const isAuthenticate = isRelayAuthenticateRequest(outbound);
        const isSessionNew = isRelaySessionNewRequest(outbound);
        if (isAuthenticate || isSessionNew) {
          if (authorizePromise) {
            await authorizePromise;
          } else if (authUrl) {
            debugLog(
              `open authorization url trigger=${
                isSessionNew ? "session/new" : "authenticate"
              }`,
            );
            const urlWithSelection = sessionSelection?.selectionId
              ? addSessionSelectionIdToAuthUrl(
                  authUrl,
                  sessionSelection.selectionId,
                )
              : authUrl;
            openAuthUrl(toWorkbenchAuthorizationUrl(urlWithSelection));
            armAuthRequestTimeout(outbound, urlWithSelection);
          }
        }
        sendToRelay(outbound);
      }
    }
  };

  const startClientRequestSpan = (message: string): string => {
    const parsed = parseJson(message);
    if (!parsed || typeof parsed.method !== "string") {
      return ensureAcpRemoteTraceContext(message).message;
    }

    const id = isJsonRpcId(parsed.id) ? parsed.id : undefined;
    const traceContext = readAcpRemoteTraceContextFromJsonRpcMessage(parsed);
    const sessionId = readMessageSessionId(parsed);
    const payloadSummary = summarizeAcpRemotePayloadForLog(parsed);
    const span = startFreeSpan(spanNameForBridgeRequest(parsed.method), {
      attributes: {
        "acp.jsonrpc.id": id === undefined ? undefined : String(id),
        "acp.jsonrpc.method": parsed.method,
        "acp.remote.component": "bridge",
        "acp.remote.connection_id": connectionId,
        "acp.remote.direction": "client_to_relay",
        "acp.remote.payload_bytes": payloadSummary.payloadBytes,
        "acp.remote.payload_hash": payloadSummary.payloadHash,
        "acp.session.id": sessionId,
        "free.message.id": messageIdFromPayloadSummary(payloadSummary),
        "free.message.prompt_text_chars": payloadSummary.promptTextChars,
        "free.message.prompt_text_hash": payloadSummary.promptTextHash,
        "free.phase": phaseForBridgeRequest(parsed.method),
      },
      kind: SpanKind.CLIENT,
      traceContext,
    });
    if (!span.traceparent) {
      return ensureAcpRemoteTraceContext(message).message;
    }

    const traced = writeAcpRemoteTraceparentToJsonRpcMessage(
      message,
      span.traceparent,
    );
    if (id !== undefined) {
      requestSpans.set(id, span);
    } else {
      span.span.end();
    }
    return traced;
  };

  const endClientRequestSpan = (
    id: unknown,
    attributes: {
      hasError?: boolean;
      method?: string;
      sessionId?: string;
      [key: string]: unknown;
    } = {},
    error?: unknown,
  ): void => {
    if (!isJsonRpcId(id)) {
      return;
    }
    const span = requestSpans.get(id);
    if (!span) {
      return;
    }
    requestSpans.delete(id);
    span.span.setAttributes({
      "acp.remote.response_has_error": attributes.hasError,
      "acp.jsonrpc.method": attributes.method,
      "acp.session.id": attributes.sessionId,
      "free.outcome": attributes.hasError ? "error" : "ok",
      ...Object.fromEntries(
        Object.entries(attributes).filter(([, value]) => value !== undefined),
      ),
    });
    if (error || attributes.hasError) {
      recordFreeSpanError(
        span.span,
        error ?? new Error("Relay returned a JSON-RPC error response."),
      );
    }
    span.span.end();
  };

  const endAllClientRequestSpans = (error: unknown): void => {
    for (const span of requestSpans.values()) {
      recordFreeSpanError(span.span, error);
      span.span.end();
    }
    requestSpans.clear();
  };

  const onEnd = () => {
    close();
  };

  input.setEncoding?.("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("error", onEnd);
  output.on?.("error", onEnd);

  return {
    close() {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      output.off?.("error", onEnd);
      close();
    },
    connection: connection!,
  };
}

type PendingOutboundMessage = {
  id?: string | number;
  message: string;
  method?: string;
};

const REMOTE_HOST_ID_META = "acp-runtime/remote/hostId";
const REMOTE_SESSION_AGENT_META = "acp-runtime/remote/sessionAgent";
const REMOTE_SESSION_MACHINE_META = "acp-runtime/remote/sessionMachine";
const REMOTE_SESSION_SELECTION_ID_META =
  "acp-runtime/remote/sessionSelectionId";
const REMOTE_SESSION_WORKSPACE_ROOTS_META =
  "acp-runtime/remote/sessionWorkspaceRoots";
const NATIVE_CLIENT_ACK_METHOD = "acp-runtime/remote/client_ack";
const NATIVE_CLIENT_ACK_SEQ_META = "acp-runtime/remote/clientAckSeq";
const REMOTE_CONFIG_OPTION_PREFIX = "acp-runtime.remote.";

function openUrl(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function readBridgeAuthRequestTimeoutMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.FREE_BRIDGE_AUTH_REQUEST_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_BRIDGE_AUTH_REQUEST_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_BRIDGE_AUTH_REQUEST_TIMEOUT_MS;
  }
  return Math.max(1000, Math.floor(parsed));
}

function writeOutput(
  output: Writable,
  data: string,
  onClosed: () => void,
  onFlushed?: () => void,
): void {
  try {
    output.write(data, (error) => {
      if (error) {
        onClosed();
        return;
      }
      onFlushed?.();
    });
  } catch {
    onClosed();
  }
}

type SessionBindingStore = {
  applyToRequest(message: string): string;
  storeFromResponse(
    message: string,
    requestMethods: Map<string | number, string>,
  ): void;
};

function createSessionBindingStore(input: {
  debugLog: (message: string) => void;
  relayUrl: string;
}): SessionBindingStore {
  const path = sessionBindingStorePath();
  let cache = readSessionBindingFile(path);

  const writeCache = () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      input.debugLog(
        `remote session binding cache write failed: ${formatError(error)}`,
      );
    }
  };

  return {
    applyToRequest(message) {
      const parsed = parseJson(message);
      if (!parsed || !isSessionBindingMethod(parsed.method)) {
        return message;
      }
      const params = isRecord(parsed.params) ? parsed.params : {};
      if (hasRemoteBindingMetadata(params._meta)) {
        return message;
      }
      const sessionId =
        typeof params.sessionId === "string" ? params.sessionId : undefined;
      if (!sessionId) {
        return message;
      }
      const binding = cache.sessions[sessionBindingKey(input.relayUrl, sessionId)];
      if (!binding) {
        return message;
      }
      return JSON.stringify({
        ...parsed,
        params: {
          ...params,
          _meta: {
            ...(isRecord(params._meta) ? params._meta : {}),
            ...binding,
          },
        },
      });
    },
    storeFromResponse(message, requestMethods) {
      const parsed = parseJson(message);
      if (!parsed || !isJsonRpcId(parsed.id)) {
        return;
      }
      const method = requestMethods.get(parsed.id);
      if (
        method !== "session/new" &&
        method !== "session/load" &&
        method !== "session/resume"
      ) {
        return;
      }
      const result = isRecord(parsed.result) ? parsed.result : undefined;
      const sessionId =
        typeof result?.sessionId === "string" ? result.sessionId : undefined;
      const binding = readRemoteBindingMetadata(result?._meta);
      if (!sessionId || !binding) {
        return;
      }
      cache = {
        sessions: {
          ...cache.sessions,
          [sessionBindingKey(input.relayUrl, sessionId)]: binding,
        },
        version: 1,
      };
      writeCache();
    },
  };
}

function sessionBindingStorePath(): string {
  const home =
    process.env.ACP_RUNTIME_HOME_DIR ??
    process.env.ACP_RUNTIME_CACHE_DIR ??
    join(homedir(), ".free");
  return join(home, "remote-session-bindings.json");
}

function readSessionBindingFile(path: string): {
  sessions: Record<string, Record<string, unknown>>;
  version: 1;
} {
  if (!existsSync(path)) {
    return { sessions: {}, version: 1 };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.sessions)) {
      return { sessions: {}, version: 1 };
    }
    return {
      sessions: Object.fromEntries(
        Object.entries(parsed.sessions).flatMap(([key, value]) => {
          const binding = readRemoteBindingMetadata(value);
          return binding ? [[key, binding]] : [];
        }),
      ),
      version: 1,
    };
  } catch {
    return { sessions: {}, version: 1 };
  }
}

function addSessionSelectionId(
  message: string,
  connectionId: string,
): { message: string; selectionId: string } | undefined {
  const parsed = parseJson(message);
  if (!parsed || parsed.method !== "session/new") {
    return undefined;
  }
  const params = isRecord(parsed.params) ? parsed.params : {};
  const existingMeta = isRecord(params._meta) ? params._meta : {};
  const existingSelectionId = readString(
    existingMeta[REMOTE_SESSION_SELECTION_ID_META],
  );
  const selectionId =
    existingSelectionId ??
    `${connectionId}:${formatJsonRpcId(parsed.id ?? crypto.randomUUID())}:${
      crypto.randomUUID()
    }`;
  return {
    message: JSON.stringify({
      ...parsed,
      params: {
        ...params,
        _meta: {
          ...existingMeta,
          [REMOTE_SESSION_SELECTION_ID_META]: selectionId,
        },
      },
    }),
    selectionId,
  };
}

function addSessionSelectionIdToAuthUrl(
  authUrl: string,
  selectionId: string,
): string {
  try {
    const url = new URL(authUrl);
    url.searchParams.set("sessionSelectionId", selectionId);
    return url.toString();
  } catch {
    return authUrl;
  }
}

function toWorkbenchAuthorizationUrl(authUrl: string): string {
  try {
    const relayUrl = new URL(authUrl);
    const workbenchOrigin = resolveFreeWorkbenchOriginForRelayUrl({
      relayUrl: relayUrl.toString(),
    });
    if (!workbenchOrigin) {
      return authUrl;
    }
    const workbenchUrl = new URL("/authorize", workbenchOrigin);
    relayUrl.searchParams.forEach((value, key) => {
      workbenchUrl.searchParams.append(key, value);
    });
    return workbenchUrl.toString();
  } catch {
    return authUrl;
  }
}

function sessionBindingKey(relayUrl: string, sessionId: string): string {
  return `${relayUrl}#${sessionId}`;
}

function isSessionBindingMethod(method: unknown): boolean {
  return (
    method === "session/load" ||
    method === "session/resume" ||
    method === "session/close" ||
    method === "session/set_config_option" ||
    method === "session/set_mode" ||
    method === "session/cancel" ||
    method === "session/prompt"
  );
}

function hasRemoteBindingMetadata(value: unknown): boolean {
  return Boolean(readRemoteBindingMetadata(value));
}

function readRemoteBindingMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const hostId = readString(value[REMOTE_HOST_ID_META]);
  if (!hostId) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {
    [REMOTE_HOST_ID_META]: hostId,
  };
  const agent = readSessionAgent(value[REMOTE_SESSION_AGENT_META]);
  if (agent) {
    metadata[REMOTE_SESSION_AGENT_META] = agent;
  }
  const machine = readString(value[REMOTE_SESSION_MACHINE_META]);
  if (machine) {
    metadata[REMOTE_SESSION_MACHINE_META] = machine;
  }
  const workspaceRoots = readStringArray(value[REMOTE_SESSION_WORKSPACE_ROOTS_META]);
  if (workspaceRoots) {
    metadata[REMOTE_SESSION_WORKSPACE_ROOTS_META] = workspaceRoots;
  }
  return metadata;
}

function readSessionAgent(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.id);
  if (id) {
    return { id };
  }
  const command = readString(value.command);
  if (!command) {
    return undefined;
  }
  const agent: Record<string, unknown> = { command };
  const args = readStringArray(value.args);
  if (args) {
    agent.args = args;
  }
  const env = readStringRecord(value.env);
  if (env) {
    agent.env = env;
  }
  const type = readString(value.type);
  if (type) {
    agent.type = type;
  }
  return agent;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  return strings.length ? strings : undefined;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some((entry) => typeof entry[1] !== "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInlineImageBlock(value: unknown): value is {
  data: string;
  mimeType: string;
  type: "image";
} {
  return (
    isRecord(value) &&
    value.type === "image" &&
    typeof value.data === "string" &&
    typeof value.mimeType === "string" &&
    value.mimeType.startsWith("image/")
  );
}

function readRemoteHostIdFromParams(params: Record<string, unknown>): string | undefined {
  const meta = isRecord(params._meta) ? params._meta : undefined;
  return readString(meta?.[REMOTE_HOST_ID_META]);
}

function selectConnectionProofForHost(input: {
  connectionProof?: AcpRemoteConnectionProof;
  connectionProofs?: readonly AcpRemoteConnectionProof[];
  hostId: string;
}): AcpRemoteConnectionProof | undefined {
  const candidates = [
    ...(input.connectionProof ? [input.connectionProof] : []),
    ...(input.connectionProofs ?? []),
  ];
  return candidates.find((proof) => proof.hostId === input.hostId);
}

async function uploadPromptImageAttachment(input: {
  block: { data: string; mimeType: string };
  connectionId: string;
  credential?: AcpRemoteAccountSessionCredential;
  hostId: string;
  messageId: string;
  proof: AcpRemoteConnectionProof;
  relayUrl: string | URL;
}): Promise<{
  attachmentId: string;
  mimeType: string;
  sha256: string;
  size: number;
  uri: string;
}> {
  const body = Buffer.from(input.block.data, "base64");
  if (body.byteLength === 0) {
    throw new Error("Image attachment body is empty.");
  }
  if (body.byteLength > MAX_BRIDGE_ATTACHMENT_BYTES) {
    throw new Error("Image attachment body is too large.");
  }
  const attachmentId = crypto.randomUUID();
  const sha256 = sha256Hex(body);
  const url = createAttachmentUploadUrl({
    attachmentId,
    connectionId: input.connectionId,
    hostId: input.hostId,
    messageId: input.messageId,
    relayUrl: input.relayUrl,
  });
  const proof = input.credential
    ? await createAcpRemoteConnectionProof({
        connectionId: input.connectionId,
        credential: input.credential,
        hostId: input.hostId,
      })
    : input.proof;
  const response = await fetch(url, {
    body,
    headers: {
      "content-type": input.block.mimeType,
      "x-acp-client-id": proof.clientId,
      "x-acp-connection-proof": encodeAcpRemoteConnectionProof(proof),
      "x-free-attachment-id": attachmentId,
      "x-free-attachment-sha256": sha256,
      "x-free-message-id": input.messageId,
    },
    method: "POST",
  });
  const result = await readAttachmentUploadResponse(response);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.attachment;
}

function createAttachmentUploadUrl(input: {
  attachmentId: string;
  connectionId: string;
  hostId: string;
  messageId: string;
  relayUrl: string | URL;
}): string {
  const url = new URL(String(input.relayUrl));
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }
  url.pathname = "/attachments";
  url.search = "";
  url.searchParams.set("attachmentId", input.attachmentId);
  url.searchParams.set("connectionId", input.connectionId);
  url.searchParams.set("hostId", input.hostId);
  url.searchParams.set("messageId", input.messageId);
  return url.toString();
}

async function readAttachmentUploadResponse(response: Response): Promise<
  | {
      ok: true;
      attachment: {
        attachmentId: string;
        mimeType: string;
        sha256: string;
        size: number;
        uri: string;
      };
    }
  | { ok: false; reason: string }
> {
  let parsed: unknown;
  let raw = "";
  try {
    raw = await response.text();
    parsed = raw ? JSON.parse(raw) : undefined;
  } catch {
    return {
      ok: false,
      reason: raw || `Attachment upload failed with HTTP ${response.status}.`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: readString(isRecord(parsed) ? parsed.reason ?? parsed.error : undefined) ??
        `Attachment upload failed with HTTP ${response.status}.`,
    };
  }
  if (!isRecord(parsed) || parsed.ok !== true) {
    return { ok: false, reason: "Attachment upload response was invalid." };
  }
  const attachment = parsed;
  if (
    typeof attachment.attachmentId !== "string" ||
    typeof attachment.mimeType !== "string" ||
    typeof attachment.sha256 !== "string" ||
    typeof attachment.size !== "number" ||
    typeof attachment.uri !== "string"
  ) {
    return { ok: false, reason: "Attachment upload response was invalid." };
  }
  return {
    attachment: {
      attachmentId: attachment.attachmentId,
      mimeType: attachment.mimeType,
      sha256: attachment.sha256,
      size: attachment.size,
      uri: attachment.uri,
    },
    ok: true,
  };
}

function createJsonRpcErrorResponse(
  id: string | number | undefined,
  message: string,
): string {
  return JSON.stringify({
    error: {
      code: -32602,
      message,
    },
    id: id ?? null,
    jsonrpc: "2.0",
  });
}

function createAuthorizationTimeoutResponse(input: {
  authorizationUrl: string;
  connectionId: string;
  request: { id: string | number; method: string };
  timeoutMs: number;
}): string {
  return JSON.stringify({
    error: {
      code: -32002,
      data: {
        authUrl: input.authorizationUrl,
        connectionId: input.connectionId,
        timeoutMs: input.timeoutMs,
      },
      message:
        "Free authorization was not completed in time. Start a new session from the ACP client to continue.",
    },
    id: input.request.id,
    jsonrpc: "2.0",
  });
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function authorizeRelay(input: {
  accountSession: string;
  authUrl: string;
  hostId?: string;
}): Promise<void> {
  const hostId = input.hostId ?? await resolveSingleHostId(input);
  const response = await fetch(input.authUrl, {
    body: JSON.stringify({ hostId }),
    headers: {
      Authorization: `Bearer ${input.accountSession}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(
      `ACP relay authorization failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await readOptionalJsonResponse(response);
  if (body?.ok !== true) {
    throw new Error(
      `ACP relay authorization failed: ${
        typeof body?.reason === "string" ? body.reason : "unexpected response"
      }`,
    );
  }
}

async function resolveSingleHostId(input: {
  accountSession: string;
  authUrl: string;
}): Promise<string> {
  const authUrl = new URL(input.authUrl);
  const hostsUrl = new URL("/api/hosts", authUrl);
  const response = await fetch(hostsUrl, {
    headers: {
      Authorization: `Bearer ${input.accountSession}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `ACP relay host discovery failed: ${response.status} ${response.statusText}`,
    );
  }
  const body = await readOptionalJsonResponse(response);
  const hosts = Array.isArray(body?.hosts)
    ? body.hosts.filter(isRelayHostDiscoveryEntry)
    : [];
  const onlineHosts = hosts.filter((host) => host.online !== false);
  if (onlineHosts.length === 0) {
    throw new Error(
      "ACP relay host discovery found no online hosts.",
    );
  }
  if (onlineHosts.length > 1) {
    throw new Error(
      "ACP relay auto authorization requires an explicit host id when multiple online hosts are available.",
    );
  }
  return onlineHosts
    .sort((left, right) => left.hostId.localeCompare(right.hostId))[0].hostId;
}

type RelayHostDiscoveryEntry = {
  hostId: string;
  online?: boolean;
};

function isRelayHostDiscoveryEntry(
  entry: unknown,
): entry is RelayHostDiscoveryEntry {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { hostId?: unknown }).hostId === "string" &&
    (entry as { hostId: string }).hostId.trim() !== "" &&
    ((entry as { online?: unknown }).online === undefined ||
      typeof (entry as { online?: unknown }).online === "boolean")
  );
}

function readRelayAuthUrl(message: string): string | undefined {
  const parsed = parseJson(message);
  const methods = parsed?.result?.authMethods;
  if (!Array.isArray(methods)) {
    return undefined;
  }
  for (const method of methods) {
    const value = method?._meta?.["acp-runtime/remote/authUrl"];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function rewriteRelayAuthUrlForWorkbench(message: string): string {
  const parsed = parseJson(message);
  if (!isRecord(parsed)) {
    return message;
  }
  const result = isRecord(parsed.result) ? parsed.result : undefined;
  const methods = result?.authMethods;
  if (!Array.isArray(methods)) {
    return message;
  }
  let changed = false;
  const authMethods = methods.map((method) => {
    if (!isRecord(method)) {
      return method;
    }
    const meta = isRecord(method._meta) ? method._meta : undefined;
    const value = readString(meta?.["acp-runtime/remote/authUrl"]);
    if (!value) {
      return method;
    }
    const rewritten = toWorkbenchAuthorizationUrl(value);
    if (rewritten === value) {
      return method;
    }
    changed = true;
    return {
      ...method,
      _meta: {
        ...meta,
        "acp-runtime/remote/authUrl": rewritten,
      },
    };
  });
  if (!changed) {
    return message;
  }
  return JSON.stringify({
    ...parsed,
    result: {
      ...result,
      authMethods,
    },
  });
}

async function readOptionalJsonResponse(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    const body = await response.json() as unknown;
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

function isRelayAuthenticateRequest(message: string): boolean {
  const parsed = parseJson(message);
  return parsed?.method === "authenticate";
}

function isRelaySessionNewRequest(message: string): boolean {
  const parsed = parseJson(message);
  return parsed?.method === "session/new";
}

function createRemoteConfigSetResponse(
  message: string,
  configOptions: readonly unknown[],
): string | undefined {
  const parsed = parseJson(message);
  if (!parsed || parsed.method !== "session/set_config_option") {
    return undefined;
  }
  const params = isRecord(parsed.params) ? parsed.params : undefined;
  const configId = readString(params?.configId);
  if (!configId?.startsWith(REMOTE_CONFIG_OPTION_PREFIX)) {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "id")) {
    return undefined;
  }
  return JSON.stringify({
    id: parsed.id,
    jsonrpc: "2.0",
    result: {
      configOptions,
    },
  });
}

function injectRemoteDisplayConfigOption(
  message: string,
  fallbackOption?: unknown,
  hostDisplayNames?: ReadonlyMap<string, string>,
): string {
  const parsed = parseJson(message);
  const result = isRecord(parsed?.result) ? parsed.result : undefined;
  const params = isRecord(parsed?.params) ? parsed.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  if (!result && !update) {
    return message;
  }
  const meta = isRecord(result?._meta) ? result._meta : undefined;
  const option = meta
    ? createRemoteDisplayConfigOption(
        meta,
        readString(result?.sessionId),
        hostDisplayNames,
      )
    : undefined;
  const remoteOption = option ?? fallbackOption;
  if (!remoteOption) {
    return message;
  }
  if (result && (Array.isArray(result.configOptions) || option)) {
    return JSON.stringify({
      ...parsed,
      result: {
        ...result,
        configOptions: [
          ...readNonRemoteConfigOptions(result.configOptions ?? []),
          remoteOption,
        ],
      },
    });
  }
  if (update && Array.isArray(update.configOptions)) {
    return JSON.stringify({
      ...parsed,
      params: {
        ...params,
        update: {
          ...update,
          configOptions: [
            ...readNonRemoteConfigOptions(update.configOptions),
            remoteOption,
          ],
        },
      },
    });
  }
  return message;
}

function readMessageSessionIdFromJson(message: string): string | undefined {
  const parsed = parseJson(message);
  return parsed ? readMessageSessionId(parsed) : undefined;
}

function readConfigOptions(message: string): unknown[] | undefined {
  const parsed = parseJson(message);
  const result = isRecord(parsed?.result) ? parsed.result : undefined;
  const params = isRecord(parsed?.params) ? parsed.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  const configOptions = Array.isArray(result?.configOptions)
    ? result.configOptions
    : Array.isArray(update?.configOptions)
      ? update.configOptions
      : [];
  return configOptions.length ? configOptions : undefined;
}

function readNativeClientAckSeq(message: string): number | undefined {
  const parsed = parseJson(message);
  const params = isRecord(parsed?.params) ? parsed.params : undefined;
  const meta = isRecord(params?._meta) ? params._meta : undefined;
  const seq = meta?.[NATIVE_CLIENT_ACK_SEQ_META];
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0
    ? seq
    : undefined;
}

function stripNativeClientAckSeq(message: string): string {
  const parsed = parseJson(message);
  const params = isRecord(parsed?.params) ? { ...parsed.params } : undefined;
  const meta = isRecord(params?._meta) ? { ...params._meta } : undefined;
  if (!parsed || !params || !meta) {
    return message;
  }
  delete meta[NATIVE_CLIENT_ACK_SEQ_META];
  if (Object.keys(meta).length > 0) {
    params._meta = meta;
  } else {
    delete params._meta;
  }
  return JSON.stringify({
    ...parsed,
    params,
  });
}

function readNonRemoteConfigOptions(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.filter((entry) => !isRemoteConfigOption(entry))
    : [];
}

function readRemoteConfigOption(value: unknown): unknown | undefined {
  return Array.isArray(value) ? value.find(isRemoteConfigOption) : undefined;
}

function isRemoteConfigOption(value: unknown): boolean {
  return (
    isRecord(value) &&
    readString(value.id)?.startsWith(REMOTE_CONFIG_OPTION_PREFIX) === true
  );
}

function readResultSessionId(message: string): string | undefined {
  const parsed = parseJson(message);
  const result = isRecord(parsed?.result) ? parsed.result : undefined;
  return readString(result?.sessionId);
}

function formatSessionAgent(agent: Record<string, unknown> | undefined): string {
  if (!agent) {
    return "Default host agent";
  }
  const id = readString(agent.id);
  if (id) {
    return id;
  }
  const type = readString(agent.type);
  if (type) {
    return type;
  }
  const command = readString(agent.command);
  return command ? basename(command) : "Default host agent";
}

function createRemoteDisplayConfigOption(
  meta: Record<string, unknown>,
  sessionId?: string,
  hostDisplayNames?: ReadonlyMap<string, string>,
): Record<string, unknown> | undefined {
  const hostId = readString(meta[REMOTE_HOST_ID_META]);
  if (!hostId) {
    return undefined;
  }
  const machine =
    readString(meta[REMOTE_SESSION_MACHINE_META]) ?? "Unknown machine";
  const hostName = hostDisplayNames?.get(hostId) ?? machine;
  const agent = formatSessionAgent(readSessionAgent(meta[REMOTE_SESSION_AGENT_META]));
  const workspace =
    readStringArray(meta[REMOTE_SESSION_WORKSPACE_ROOTS_META])?.[0] ??
    "No workspace preference";
  const hostWorkspace = `${hostName} · ${workspace}`;
  const entries = [
    { description: hostWorkspace, name: hostWorkspace, value: hostWorkspace },
    { description: agent, name: agent, value: agent },
    ...(sessionId
      ? [
          {
            description: sessionId,
            name: sessionId,
            value: sessionId,
          },
        ]
      : []),
  ];
  const currentValue = entries[0]?.value ?? "remote-context";
  return {
    category: "remote",
    currentValue,
    description:
      "Remote host, workspace, agent, and session selected in ACP relay authorization.",
    id: `${REMOTE_CONFIG_OPTION_PREFIX}context`,
    name: "Remote Context",
    options: entries,
    type: "select",
  };
}

function readJsonRpcRequestId(message: string): string | number | undefined {
  const parsed = parseJson(message);
  const id = parsed?.id;
  return isJsonRpcId(id) ? id : undefined;
}

function readJsonRpcRequest(
  message: string,
): { id: string | number; method: string } | undefined {
  const parsed = parseJson(message);
  if (!parsed || typeof parsed.method !== "string" || !isJsonRpcId(parsed.id)) {
    return undefined;
  }
  return {
    id: parsed.id,
    method: parsed.method,
  };
}

function readJsonRpcResponseId(message: string): string | number | undefined {
  const parsed = parseJson(message);
  if (
    !parsed ||
    (!Object.prototype.hasOwnProperty.call(parsed, "result") &&
      !Object.prototype.hasOwnProperty.call(parsed, "error"))
  ) {
    return undefined;
  }
  const id = parsed.id;
  return isJsonRpcId(id) ? id : undefined;
}

function isReplayableRelayClientRequest(method: string | undefined): boolean {
  return (
    method === "authenticate" ||
    method === "initialize" ||
    method === "session/list" ||
    method === "session/load" ||
    method === "session/new" ||
    method === "session/prompt" ||
    method === "session/resume"
  );
}

function isAuthGatedRequest(method: string | undefined): boolean {
  return method === "authenticate" || method === "session/new";
}

function createRelayConnectionLostResponse(
  request: PendingOutboundMessage,
): string {
  return JSON.stringify({
    error: {
      code: -32001,
      message:
        "Relay connection closed before this request completed. The request status is unknown; retry if appropriate.",
    },
    id: request.id,
    jsonrpc: "2.0",
  });
}

function logClientMessage(
  message: string,
  requestMethods: Map<string | number, string>,
  requestSessionIds: Map<string | number, string>,
  requestTraceContexts: Map<string | number, AcpRemoteTraceContext>,
  connectionId: string,
  debugLog: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void,
): void {
  const parsed = parseJson(message);
  if (!parsed) {
    debugLog("client -> relay invalid json", {
      connectionId,
      direction: "client_to_relay",
      eventName: "acp.remote.bridge.transport",
      severityText: "ERROR",
    });
    return;
  }
  const method = parsed.method;
  const id = parsed.id;
  const sessionId = readMessageSessionId(parsed);
  const traceContext = readAcpRemoteTraceContextFromJsonRpcMessage(parsed);
  const payloadSummary = summarizeAcpRemotePayloadForLog(parsed);
  if (typeof method === "string" && isJsonRpcId(id)) {
    requestMethods.set(id, method);
    if (sessionId) {
      requestSessionIds.set(id, sessionId);
    }
    if (traceContext) {
      requestTraceContexts.set(id, traceContext);
    }
  }
  debugLog(
    `client -> relay id=${formatJsonRpcId(id)} method=${
      typeof method === "string" ? method : "-"
    }${sessionId ? ` sessionId=${sessionId}` : ""}${
      traceContext ? ` traceId=${traceContext.traceId}` : ""
    }`,
    compactBridgeDebugContext({
      connectionId,
      direction: "client_to_relay",
      eventName: "acp.remote.bridge.transport",
      jsonRpcId: isJsonRpcId(id) ? id : undefined,
      method: typeof method === "string" ? method : undefined,
      ...payloadSummary,
      freeMessageId: messageIdFromPayloadSummary(payloadSummary),
      freePhase: phaseForBridgeRequest(method),
      sessionId,
      ...traceContextToDebugFields(traceContext),
      severityText: "INFO",
    }),
  );
}

function logRelayMessage(
  message: string,
  requestMethods: Map<string | number, string>,
  requestSessionIds: Map<string | number, string>,
  requestTraceContexts: Map<string | number, AcpRemoteTraceContext>,
  connectionId: string,
  debugLog: (
    message: string,
    context?: AcpRemoteBridgeDebugContext,
  ) => void,
): {
  hasError?: boolean;
  id?: unknown;
  method?: string;
  sessionId?: string;
  traceContext?: AcpRemoteTraceContext;
} {
  const parsed = parseJson(message);
  if (!parsed) {
    debugLog("relay -> client invalid json", {
      connectionId,
      direction: "relay_to_client",
      eventName: "acp.remote.bridge.transport",
      severityText: "ERROR",
    });
    return {};
  }
  const id = parsed.id;
  const method = isJsonRpcId(id) ? requestMethods.get(id) : undefined;
  const sessionId =
    readMessageSessionId(parsed) ??
    (isJsonRpcId(id) ? requestSessionIds.get(id) : undefined);
  const traceContext =
    readAcpRemoteTraceContextFromJsonRpcMessage(parsed) ??
    (isJsonRpcId(id) ? requestTraceContexts.get(id) : undefined);
  if (isJsonRpcId(id)) {
    requestMethods.delete(id);
    requestSessionIds.delete(id);
    requestTraceContexts.delete(id);
  }
  const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
  const payloadSummary = summarizeAcpRemotePayloadForLog(parsed);
  const errorMessage =
    hasError && typeof parsed.error?.message === "string"
      ? ` message=${parsed.error.message}`
      : "";
  const notificationMethod = typeof parsed.method === "string" ? parsed.method : "-";
  const payloadDetails = formatPayloadSummaryForLogMessage(payloadSummary);
  debugLog(
    `relay -> client id=${formatJsonRpcId(id)} method=${
      method ?? notificationMethod
    } error=${hasError ? "yes" : "no"}${
      sessionId ? ` sessionId=${sessionId}` : ""
    }${traceContext ? ` traceId=${traceContext.traceId}` : ""}${
      errorMessage
    }${payloadDetails}`,
    compactBridgeDebugContext({
      connectionId,
      direction: "relay_to_client",
      eventName: "acp.remote.bridge.transport",
      jsonRpcId: isJsonRpcId(id) ? id : undefined,
      method: method ?? (notificationMethod !== "-" ? notificationMethod : undefined),
      ...payloadSummary,
      freeMessageId: messageIdFromPayloadSummary(payloadSummary),
      freePhase: phaseForBridgeResponse(method ?? notificationMethod, hasError),
      sessionId,
      ...traceContextToDebugFields(traceContext),
      severityText: hasError ? "ERROR" : "INFO",
    }),
  );
  return {
    hasError,
    id,
    method: method ?? (notificationMethod !== "-" ? notificationMethod : undefined),
    sessionId,
    traceContext,
  };
}

function formatPayloadSummaryForLogMessage(
  summary: ReturnType<typeof summarizeAcpRemotePayloadForLog>,
): string {
  const parts: string[] = [];
  appendLogPart(parts, "payloadBytes", summary.payloadBytes);
  appendLogPart(parts, "payloadHash", summary.payloadHash);
  appendLogPart(parts, "updateKind", summary.updateKind);
  appendLogPart(parts, "updateMessageId", summary.updateMessageId);
  appendLogPart(parts, "updateTextChars", summary.updateTextChars);
  appendLogPart(parts, "updateTextHash", summary.updateTextHash);
  appendLogPart(parts, "promptMessageId", summary.promptMessageId);
  appendLogPart(parts, "promptBlockCount", summary.promptBlockCount);
  appendLogPart(parts, "promptTextChars", summary.promptTextChars);
  appendLogPart(parts, "promptTextHash", summary.promptTextHash);
  appendLogPart(parts, "stopReason", summary.stopReason);
  appendLogPart(parts, "responseUserMessageId", summary.responseUserMessageId);
  appendLogPart(parts, "configOptionCount", summary.configOptionCount);
  appendLogPart(parts, "configOptionIds", summary.configOptionIds);
  appendLogPreview(parts, "updateTextPreview", summary.updateTextPreview);
  appendLogPreview(parts, "promptTextPreview", summary.promptTextPreview);
  appendLogPreview(parts, "payloadPreview", summary.payloadPreview);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function appendLogPart(
  parts: string[],
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined || value === "") {
    return;
  }
  parts.push(`${key}=${formatLogValue(value)}`);
}

function appendLogPreview(
  parts: string[],
  key: string,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }
  parts.push(`${key}=${JSON.stringify(value)}`);
}

function formatLogValue(value: string | number | boolean): string {
  return typeof value === "string" && /\s/.test(value)
    ? JSON.stringify(value)
    : String(value);
}

function readMessageSessionId(message: Record<string, any>): string | undefined {
  const params = isRecord(message.params) ? message.params : undefined;
  const result = isRecord(message.result) ? message.result : undefined;
  return readString(params?.sessionId) ?? readString(result?.sessionId);
}

function compactBridgeDebugContext(
  context: AcpRemoteBridgeDebugContext,
): AcpRemoteBridgeDebugContext | undefined {
  const compacted = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as AcpRemoteBridgeDebugContext;
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function traceContextToDebugFields(
  traceContext: AcpRemoteTraceContext | undefined,
): Pick<
  AcpRemoteBridgeDebugContext,
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

function spanNameForBridgeRequest(method: string): string {
  return method === "session/prompt" ? "free.message.receive" : `free.bridge.${method}`;
}

function phaseForBridgeRequest(method: string | undefined): string | undefined {
  return method === "session/prompt" ? "bridge.receive" : undefined;
}

function phaseForBridgeResponse(
  method: string | undefined,
  hasError: boolean,
): string | undefined {
  if (method !== "session/prompt") {
    return undefined;
  }
  return hasError ? "bridge.return_error" : "bridge.return_result";
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

function parseJson(message: string): Record<string, any> | undefined {
  try {
    const parsed = JSON.parse(message) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, any>
      : undefined;
  } catch {
    return undefined;
  }
}
