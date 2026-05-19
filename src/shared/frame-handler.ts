import {
  type AcpRemoteAckFrame,
  type AcpRemoteDataFrame,
} from "../protocol/types.js";
import {
  ACP_METHOD_SCOPE_BY_METHOD,
  ACP_NOTIFICATION_SCOPE_BY_METHOD,
  isAcpRemoteJsonRpcMessage,
  isAcpRemoteJsonRpcRequest,
  parseAcpRemoteFrameText,
  requiredScopeForAcpPayload,
  type AcpRemoteJsonRpcMessage,
  type AcpRemoteJsonRpcNotification,
  type AcpRemoteJsonRpcRequest,
} from "../protocol/index.js";

export const parseFrame = parseAcpRemoteFrameText;

export {
  ACP_METHOD_SCOPE_BY_METHOD,
  ACP_NOTIFICATION_SCOPE_BY_METHOD,
  requiredScopeForAcpPayload,
};

export type JsonRpcMessage = AcpRemoteJsonRpcMessage;

export type JsonRpcNotification = AcpRemoteJsonRpcNotification;

export type JsonRpcRequest = AcpRemoteJsonRpcRequest;

export const isJsonRpcMessage = isAcpRemoteJsonRpcMessage;

export const isJsonRpcRequest = isAcpRemoteJsonRpcRequest;

export type OutboundFrameTracker = {
  nextSeq(connectionId: string): number;
  pendingOutboundFrames: Map<string, Map<number, AcpRemoteDataFrame>>;
  trackOutbound(connectionId: string, frame: AcpRemoteDataFrame): void;
  handleAck(frame: AcpRemoteAckFrame): void;
  getPendingCount(connectionId: string): number;
};

export function createOutboundFrameTracker(): OutboundFrameTracker {
  const seqCounters = new Map<string, number>();
  const pendingOutboundFrames = new Map<string, Map<number, AcpRemoteDataFrame>>();

  return {
    pendingOutboundFrames,
    nextSeq(connectionId) {
      const seq = (seqCounters.get(connectionId) ?? 0) + 1;
      seqCounters.set(connectionId, seq);
      return seq;
    },
    trackOutbound(connectionId, frame) {
      let pending = pendingOutboundFrames.get(connectionId);
      if (!pending) {
        pending = new Map();
        pendingOutboundFrames.set(connectionId, pending);
      }
      pending.set(frame.seq, frame);
    },
    handleAck(frame) {
      const pending = pendingOutboundFrames.get(frame.connectionId);
      if (!pending) return;
      for (const seq of [...pending.keys()].sort((a, b) => a - b)) {
        if (seq > frame.ack) break;
        pending.delete(seq);
      }
    },
    getPendingCount(connectionId) {
      return pendingOutboundFrames.get(connectionId)?.size ?? 0;
    },
  };
}
