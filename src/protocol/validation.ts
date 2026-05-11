import {
  ACP_REMOTE_PROTOCOL_VERSION,
  AcpRemoteChannelKind,
  AcpRemoteEndpointKind,
  AcpRemoteFrameType,
  type AcpRemoteFrame,
} from "./types.js";
import { isAcpRemoteConnectionProof } from "./account-session.js";

export function isAcpRemoteFrame(value: unknown): value is AcpRemoteFrame {
  if (!isRecord(value)) {
    return false;
  }

  switch (value.frameType) {
    case AcpRemoteFrameType.Hello:
      return (
        value.protocolVersion === ACP_REMOTE_PROTOCOL_VERSION &&
        isString(value.connectionId) &&
        isEndpointKind(value.endpoint) &&
        optionalString(value.hostId) &&
        optionalConnectionProof(value.proof) &&
        optionalAgent(value.agent) &&
        optionalStringArray(value.workspaceRoots)
      );
    case AcpRemoteFrameType.Data:
      return (
        isString(value.connectionId) &&
        isString(value.channelId) &&
        isChannelKind(value.channelKind) &&
        Number.isSafeInteger(value.seq) &&
        (value.ack === undefined || Number.isSafeInteger(value.ack))
      );
    case AcpRemoteFrameType.Ack:
      return (
        isString(value.connectionId) &&
        isString(value.channelId) &&
        Number.isSafeInteger(value.ack)
      );
    case AcpRemoteFrameType.Ping:
    case AcpRemoteFrameType.Pong:
      return isString(value.connectionId) && isString(value.nonce);
    case AcpRemoteFrameType.Close:
      return (
        isString(value.connectionId) &&
        optionalString(value.code) &&
        optionalString(value.reason)
      );

    default:
      return false;
  }
}

export function assertAcpRemoteFrame(value: unknown): AcpRemoteFrame {
  if (!isAcpRemoteFrame(value)) {
    throw new Error("Invalid ACP remote frame.");
  }
  return value;
}

function isEndpointKind(value: unknown): value is AcpRemoteEndpointKind {
  return value === AcpRemoteEndpointKind.Client || value === AcpRemoteEndpointKind.Host;
}

function isChannelKind(value: unknown): value is AcpRemoteChannelKind {
  return Object.values(AcpRemoteChannelKind).includes(
    value as AcpRemoteChannelKind,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function optionalConnectionProof(value: unknown): boolean {
  return value === undefined || isAcpRemoteConnectionProof(value);
}

function optionalAgent(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if ("id" in value) {
    return isString(value.id);
  }
  return (
    isString(value.command) &&
    (value.type === undefined || typeof value.type === "string") &&
    (value.args === undefined ||
      (Array.isArray(value.args) &&
        value.args.every((entry) => typeof entry === "string"))) &&
    (value.env === undefined || isStringRecord(value.env))
  );
}

function optionalStringArray(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every((entry) => typeof entry === "string" && entry.length > 0))
  );
}

function isStringRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (entry) => entry === undefined || typeof entry === "string",
    )
  );
}
