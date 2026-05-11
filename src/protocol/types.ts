export const ACP_REMOTE_PROTOCOL_VERSION = 1 as const;

export const AcpRemoteEndpointKind = {
  Client: "client",
  Host: "host",
} as const;

export const AcpRemoteChannelKind = {
  Acp: "acp",
  Filesystem: "fs",
} as const;

export const AcpRemoteFrameType = {
  Ack: "ack",
  Close: "close",
  Data: "data",
  Hello: "hello",
  Ping: "ping",
  Pong: "pong",
} as const;

export type AcpRemoteEndpointKind =
  (typeof AcpRemoteEndpointKind)[keyof typeof AcpRemoteEndpointKind];

export type AcpRemoteChannelKind =
  (typeof AcpRemoteChannelKind)[keyof typeof AcpRemoteChannelKind];

export type AcpRemoteFrameType =
  (typeof AcpRemoteFrameType)[keyof typeof AcpRemoteFrameType];

export type AcpRemoteId = string;

export type AcpRemoteScope =
  | "acp:connect"
  | "acp:session:list"
  | "acp:session:create"
  | "acp:session:resume"
  | "acp:turn:send"
  | "acp:turn:cancel"
  | (string & {});

export type AcpRemoteClientDeviceType =
  | "cli"
  | "desktop"
  | "mobile"
  | "web";

export type AcpRemoteClientDevice = {
  accountId: AcpRemoteId;
  clientId: AcpRemoteId;
  publicKey: string;
  trustLevel?: string;
  type: AcpRemoteClientDeviceType;
};

export type AcpRemoteHostHost = {
  alias?: string;
  hostId: AcpRemoteId;
  ownerAccountId: AcpRemoteId;
  publicKey: string;
};

export type AcpRemoteAgentGrant =
  | {
      id: string;
    }
  | {
      args?: readonly string[];
      command: string;
      env?: Record<string, string | undefined>;
      type?: string;
    };

export type AcpRemoteGrant = {
  accountId: AcpRemoteId;
  agent?: AcpRemoteAgentGrant;
  clientId?: AcpRemoteId;
  hostId: AcpRemoteId;
  policyVersion: number;
  scopes: readonly AcpRemoteScope[];
  workspaceId?: AcpRemoteId;
  workspaceRoots?: readonly string[];
};

export type AcpRemoteHelloFrame = {
  agent?: AcpRemoteAgentGrant;
  connectionId: AcpRemoteId;
  endpoint: AcpRemoteEndpointKind;
  frameType: typeof AcpRemoteFrameType.Hello;
  hostId?: AcpRemoteId;
  protocolVersion: typeof ACP_REMOTE_PROTOCOL_VERSION;
  proof?: import("./account-session.js").AcpRemoteConnectionProof;
  workspaceRoots?: readonly string[];
};

export type AcpRemoteDataFrame = {
  ack?: number;
  channelId: AcpRemoteId;
  channelKind: AcpRemoteChannelKind;
  connectionId: AcpRemoteId;
  frameType: typeof AcpRemoteFrameType.Data;
  payload: unknown;
  seq: number;
};

export type AcpRemoteAckFrame = {
  ack: number;
  channelId: AcpRemoteId;
  connectionId: AcpRemoteId;
  frameType: typeof AcpRemoteFrameType.Ack;
};

export type AcpRemotePingFrame = {
  connectionId: AcpRemoteId;
  frameType: typeof AcpRemoteFrameType.Ping;
  nonce: string;
};

export type AcpRemotePongFrame = {
  connectionId: AcpRemoteId;
  frameType: typeof AcpRemoteFrameType.Pong;
  nonce: string;
};

export type AcpRemoteCloseFrame = {
  code?: string;
  connectionId: AcpRemoteId;
  frameType: typeof AcpRemoteFrameType.Close;
  reason?: string;
};

export type AcpRemoteFrame =
  | AcpRemoteAckFrame
  | AcpRemoteCloseFrame
  | AcpRemoteDataFrame
  | AcpRemoteHelloFrame
  | AcpRemotePingFrame
  | AcpRemotePongFrame;

export type AcpRemoteConnectionRoute = {
  accountId: AcpRemoteId;
  clientId: AcpRemoteId;
  connectionId: AcpRemoteId;
  hostId: AcpRemoteId;
  scopes: readonly AcpRemoteScope[];
  workspaceId?: AcpRemoteId;
};
