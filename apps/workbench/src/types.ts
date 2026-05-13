export type RouteId = "access" | "hosts" | "settings";

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
