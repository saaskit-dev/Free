export type RouteId = "access" | "sessions" | "hosts" | "settings";

export type AccountSession = {
  account?: {
    id: string;
    name: string;
    provider: "github" | "unknown";
  };
  accountId: string;
  accountName?: string;
  expiresAt: number;
  sessionId: string;
};

export type HostRecord = {
  hostId: string;
  online?: boolean;
  metadata?: {
    agentName?: string;
    displayName?: string;
    machine?: string;
    runtimeInstanceId?: string;
    workspaceRoots?: ({ label?: string; path: string } | string)[];
    [key: string]: unknown;
  };
};

export type SessionRecord = {
  agent?: {
    command?: string;
    id?: string;
    type?: string;
  };
  connectionId?: string;
  createdAt?: string;
  error?: string;
  lifecycle?: "live" | "offline";
  hostId: string;
  hostMetadata?: HostRecord["metadata"];
  hostName?: string;
  hostOnline?: boolean;
  latestEvent?: string;
  requestId?: string | number;
  sessionId: string;
  status?: "waiting_authorization" | "starting" | "active" | "failed" | "offline";
  title?: string;
  updatedAt?: string;
  workspaceRoots: string[];
};

export type SessionHealth = {
  checkedAt: string;
  checks: {
    id: "account_session" | "relay" | "host" | "session";
    label: string;
    message: string;
    status: "ok" | "warning" | "error";
  }[];
  liveSessionCount: number;
  offlineSessionCount: number;
  onlineHostCount: number;
  status: "healthy" | "degraded" | "unhealthy";
};

export type AuthorizationAgent = {
  command?: string;
  id?: string;
  label?: string;
  type?: string;
};

export type AuthorizationWorkspaceRoot = {
  label?: string;
  path: string;
};

export type AuthorizationHost = {
  hostId: string;
  online?: boolean;
  metadata?: {
    agentTypes?: AuthorizationAgent[];
    displayName?: string;
    machine?: string;
    workspaceRoots?: AuthorizationWorkspaceRoot[];
  };
};

export type AuthorizationSession = {
  accountId: string;
  connectionId: string;
  hosts: AuthorizationHost[];
  unavailableReason?: string;
};

export type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "unauthorized"; message: string }
  | { status: "error"; message: string };

export type LoginApproval = {
  accountId: string;
  approvalId: string;
  createdAt: number;
  githubLogin: string;
  principalId: string;
  principalType: "client" | "host";
  returnTo: string;
};

export type ThemeMode = "system" | "light" | "dark";

export type LanguageMode = "zh" | "en";

export type WorkbenchPreferences = {
  language: LanguageMode;
  theme: ThemeMode;
};
