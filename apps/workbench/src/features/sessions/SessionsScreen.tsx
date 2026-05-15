import { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { checkSessionHealth } from "../../api/relay";
import type { HostRecord, LanguageMode, LoadState, SessionHealth, SessionRecord } from "../../types";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type SessionsScreenProps = {
  hosts: LoadState<HostRecord[]>;
  language: LanguageMode;
  sessions: LoadState<SessionRecord[]>;
};

type AvailabilityFilter = "all" | "online" | "offline";
type StatusFilter = "all" | NonNullable<SessionRecord["status"]>;
type FilterId = "agent" | "availability" | "host" | "status" | "workspace";
type HealthState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; value: SessionHealth }
  | { status: "error"; message: string };

export function SessionsScreen({ hosts, language, sessions }: SessionsScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 900;
  const [query, setQuery] = useState("");
  const [hostId, setHostId] = useState("all");
  const [agentKey, setAgentKey] = useState("all");
  const [workspaceRoot, setWorkspaceRoot] = useState("all");
  const [availability, setAvailability] = useState<AvailabilityFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [openFilter, setOpenFilter] = useState<FilterId | undefined>();
  const [copiedKey, setCopiedKey] = useState<string | undefined>();
  const [health, setHealth] = useState<HealthState>({ status: "idle" });
  const [showOffline, setShowOffline] = useState(false);

  const hostLabels = useMemo(() => {
    const labels = new Map<string, string>();
    if (hosts.status === "ready") {
      for (const host of hosts.data) {
        labels.set(host.hostId, readHostLabel(host));
      }
    }
    if (sessions.status === "ready") {
      for (const session of sessions.data) {
        labels.set(session.hostId, readSessionHostLabel(session, labels));
      }
    }
    return labels;
  }, [hosts, sessions]);

  const filterOptions = useMemo(() => {
    const agents = new Map<string, string>();
    const workspaces = new Map<string, string>();
    const hostIds = new Set<string>();
    if (sessions.status === "ready") {
      for (const session of sessions.data) {
        hostIds.add(session.hostId);
        agents.set(readAgentKey(session), readAgentLabel(session));
        for (const root of session.workspaceRoots) {
          workspaces.set(root, readWorkspaceLabel(root));
        }
      }
    }
    return {
      agents: [...agents.entries()].sort((left, right) => left[1].localeCompare(right[1])),
      hosts: [...hostIds].sort((left, right) =>
        (hostLabels.get(left) ?? left).localeCompare(hostLabels.get(right) ?? right),
      ),
      workspaces: [...workspaces.entries()].sort((left, right) => left[1].localeCompare(right[1])),
    };
  }, [hostLabels, sessions]);

  const visibleSessions = useMemo(() => {
    if (sessions.status !== "ready") return [];
    const needle = query.trim().toLowerCase();
    return sessions.data.filter((session) => {
      if (!showOffline && session.lifecycle === "offline") return false;
      if (hostId !== "all" && session.hostId !== hostId) return false;
      if (agentKey !== "all" && readAgentKey(session) !== agentKey) return false;
      if (workspaceRoot !== "all" && !session.workspaceRoots.includes(workspaceRoot)) return false;
      if (availability === "online" && !session.hostOnline) return false;
      if (availability === "offline" && session.hostOnline) return false;
      if (status !== "all" && session.status !== status) return false;
      if (!needle) return true;
      const values = [
        session.sessionId,
        String(session.requestId ?? ""),
        session.connectionId ?? "",
        session.hostId,
        session.title ?? "",
        readSessionHostLabel(session, hostLabels),
        readAgentLabel(session),
        readStatusLabel(session.status, language),
        session.latestEvent ?? "",
        session.error ?? "",
        ...session.workspaceRoots,
      ];
      return values.some((value) => value.toLowerCase().includes(needle));
    });
  }, [agentKey, availability, hostId, hostLabels, language, query, sessions, showOffline, status, workspaceRoot]);

  const sessionCounts = useMemo(() => {
    if (sessions.status !== "ready") {
      return { live: 0, offline: 0, total: 0 };
    }
    return sessions.data.reduce(
      (counts, session) => {
        counts.total += 1;
        if (session.lifecycle === "offline") {
          counts.offline += 1;
        } else {
          counts.live += 1;
        }
        return counts;
      },
      { live: 0, offline: 0, total: 0 },
    );
  }, [sessions]);

  const copyValue = (value: string, key: string) => {
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopiedKey(key);
      setTimeout(() => {
        setCopiedKey((current) => current === key ? undefined : current);
      }, 1400);
    });
  };

  const runHealthCheck = () => {
    setHealth({ status: "checking" });
    void checkSessionHealth().then((result) => {
      if (!result.ok) {
        setHealth({ message: result.message, status: "error" });
        return;
      }
      setHealth({ status: "ready", value: result.value });
    }).catch((error: unknown) => {
      setHealth({
        message: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    });
  };

  if (sessions.status === "loading") {
    return (
      <Panel
        title={t(language, "正在加载 Session", "Loading sessions")}
        body={t(language, "正在读取当前账号的 Session。", "Reading sessions for this account.")}
      />
    );
  }
  if (sessions.status === "unauthorized") {
    return (
      <Panel
        title={t(language, "需要登录", "Sign in required")}
        body={t(
          language,
          "请先登录 Free，然后查看 Session 管理。",
          "Sign in to Free before viewing session management.",
        )}
      />
    );
  }
  if (sessions.status === "error") {
    return <Panel title={t(language, "Session 不可用", "Sessions unavailable")} body={sessions.message} tone="error" />;
  }

  return (
    <View style={{ gap: 10 }}>
      <View style={toolbarStyle}>
        <TextInput
          accessibilityLabel={t(language, "搜索 Session", "Search sessions")}
          autoCapitalize="none"
          onChangeText={(value) => {
            setOpenFilter(undefined);
            setQuery(value);
          }}
          placeholder={t(language, "搜索 Session、主机、Agent、目录、ID", "Search session, host, agent, workspace, ID")}
          placeholderTextColor={colors.muted}
          style={[inputStyle, { flex: compact ? undefined : 1, width: compact ? "100%" : undefined }]}
          value={query}
        />
        <Text style={common.eyebrow}>
          {visibleSessions.length} / {showOffline ? sessionCounts.total : sessionCounts.live}
        </Text>
        <Pressable
          accessibilityLabel={t(language, "检查链路健康", "Check chain health")}
          accessibilityRole="button"
          onPress={runHealthCheck}
          style={actionButtonStyle}
        >
          <Text style={actionButtonTextStyle}>
            {health.status === "checking" ? t(language, "检查中", "Checking") : t(language, "健康检查", "Health")}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t(language, "显示离线 Session", "Show offline sessions")}
          accessibilityRole="button"
          onPress={() => setShowOffline((value) => !value)}
          style={[actionButtonStyle, showOffline ? selectButtonActiveStyle : null]}
        >
          <Text style={actionButtonTextStyle}>
            {showOffline
              ? t(language, "隐藏离线", "Hide offline")
              : t(language, `显示离线 ${sessionCounts.offline}`, `Show offline ${sessionCounts.offline}`)}
          </Text>
        </Pressable>
      </View>

      <HealthPanel health={health} language={language} />

      <View style={filterRailStyle}>
        <SelectFilter
          allLabel={t(language, "全部状态", "All states")}
          filterId="status"
          label={t(language, "状态", "State")}
          openFilter={openFilter}
          options={[
            ["active", t(language, "运行中", "Active")],
            ["starting", t(language, "启动中", "Starting")],
            ["waiting_authorization", t(language, "等待授权", "Waiting")],
            ["failed", t(language, "失败", "Failed")],
            ["offline", t(language, "离线历史", "Offline history")],
          ]}
          value={status}
          onChange={(value) => {
            setStatus(value as StatusFilter);
            setOpenFilter(undefined);
          }}
          onToggle={setOpenFilter}
        />
        <SelectFilter
          allLabel={t(language, "全部在线状态", "All availability")}
          filterId="availability"
          label={t(language, "在线状态", "Availability")}
          openFilter={openFilter}
          options={[
            ["online", t(language, "在线", "Online")],
            ["offline", t(language, "离线", "Offline")],
          ]}
          value={availability}
          onChange={(value) => {
            setAvailability(value as AvailabilityFilter);
            setOpenFilter(undefined);
          }}
          onToggle={setOpenFilter}
        />
        <SelectFilter
          allLabel={t(language, "全部主机", "All hosts")}
          filterId="host"
          label={t(language, "主机", "Host")}
          openFilter={openFilter}
          options={filterOptions.hosts.map((id) => [id, hostLabels.get(id) ?? shortId(id)] as const)}
          value={hostId}
          onChange={(value) => {
            setHostId(value);
            setOpenFilter(undefined);
          }}
          onToggle={setOpenFilter}
        />
        <SelectFilter
          allLabel={t(language, "全部 Agent", "All agents")}
          filterId="agent"
          label={t(language, "Agent", "Agent")}
          openFilter={openFilter}
          options={filterOptions.agents}
          value={agentKey}
          onChange={(value) => {
            setAgentKey(value);
            setOpenFilter(undefined);
          }}
          onToggle={setOpenFilter}
        />
        <SelectFilter
          allLabel={t(language, "全部目录", "All workspaces")}
          filterId="workspace"
          label={t(language, "目录", "Workspace")}
          openFilter={openFilter}
          options={filterOptions.workspaces}
          value={workspaceRoot}
          onChange={(value) => {
            setWorkspaceRoot(value);
            setOpenFilter(undefined);
          }}
          onToggle={setOpenFilter}
        />
      </View>

      {sessionCounts.total === 0 ? (
        <Panel
          title={t(language, "暂无 Session", "No sessions")}
          body={t(
            language,
            "通过 ACP 客户端完成授权后，Session 会出现在这里。",
            "Sessions appear here after an ACP client is authorized.",
          )}
        />
      ) : visibleSessions.length === 0 ? (
        <Panel
          title={t(language, "没有匹配的 Session", "No matching sessions")}
          body={
            !showOffline && sessionCounts.offline > 0
              ? t(
                  language,
                  "当前没有激活 Session。离线历史已默认隐藏，可点击显示离线查看。",
                  "No live sessions. Offline history is hidden by default.",
                )
              : t(language, "调整筛选条件或搜索词后再查看。", "Adjust the filters or search text.")
          }
        />
      ) : (
        <View style={[common.panel, { overflow: "hidden" }]}>
          {!compact ? <SessionHeader language={language} /> : null}
          {visibleSessions.map((session) => (
            <SessionRow
              compact={compact}
              copiedKey={copiedKey}
              hostLabel={readSessionHostLabel(session, hostLabels)}
              key={session.sessionId}
              language={language}
              onCopy={copyValue}
              session={session}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function HealthPanel({
  health,
  language,
}: {
  health: HealthState;
  language: LanguageMode;
}) {
  if (health.status === "idle") return null;
  if (health.status === "checking") {
    return (
      <View style={[common.panel, healthPanelStyle]}>
        <Text style={healthTitleStyle}>{t(language, "链路健康检查中", "Checking chain health")}</Text>
      </View>
    );
  }
  if (health.status === "error") {
    return (
      <View style={[common.panel, healthPanelStyle]}>
        <Text style={[healthTitleStyle, { color: colors.coral }]}>
          {t(language, "链路健康检查失败", "Health check failed")}
        </Text>
        <Text style={secondaryTextStyle}>{health.message}</Text>
      </View>
    );
  }
  const title = health.value.status === "healthy"
    ? t(language, "链路健康", "Chain healthy")
    : health.value.status === "degraded"
      ? t(language, "链路部分可用", "Chain degraded")
      : t(language, "链路异常", "Chain unhealthy");
  const tone = health.value.status === "healthy"
    ? colors.green
    : health.value.status === "degraded"
      ? colors.cyan
      : colors.coral;
  return (
    <View style={[common.panel, healthPanelStyle]}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "space-between" }}>
        <Text style={[healthTitleStyle, { color: tone }]}>{title}</Text>
        <Text style={common.eyebrow}>
          {t(language, "激活", "Live")} {health.value.liveSessionCount} · {t(language, "离线", "Offline")} {health.value.offlineSessionCount} · Host {health.value.onlineHostCount}
        </Text>
      </View>
      <View style={{ gap: 5 }}>
        {health.value.checks.map((check) => (
          <Text key={check.id} style={secondaryTextStyle}>
            {readHealthCheckLabel(check.status, language)} {readHealthCheckName(check.id, language)}: {readHealthCheckMessage(check, health.value, language)}
          </Text>
        ))}
      </View>
    </View>
  );
}

function SelectFilter({
  allLabel,
  filterId,
  label,
  onChange,
  onToggle,
  openFilter,
  options,
  value,
}: {
  allLabel: string;
  filterId: FilterId;
  label: string;
  onChange: (value: string) => void;
  onToggle: (filter: FilterId | undefined) => void;
  openFilter: FilterId | undefined;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  const open = openFilter === filterId;
  const items = [["all", allLabel] as const, ...options];
  const selectedLabel = items.find(([optionValue]) => optionValue === value)?.[1] ?? allLabel;
  const active = value !== "all";
  return (
    <View style={{ minWidth: 150, position: "relative", zIndex: open ? 50 : 1 }}>
      <Text style={[common.eyebrow, { marginBottom: 4 }]}>{label}</Text>
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        onPress={() => onToggle(open ? undefined : filterId)}
        style={[selectButtonStyle, active ? selectButtonActiveStyle : null]}
      >
        <Text numberOfLines={1} style={selectButtonTextStyle}>{selectedLabel}</Text>
        <Text style={selectCaretStyle}>{open ? "▲" : "▼"}</Text>
      </Pressable>
      {open ? (
        <View style={selectMenuStyle}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 168 }}>
            {items.map(([optionValue, optionLabel]) => (
              <Pressable
                key={optionValue}
                onPress={() => {
                  onChange(optionValue);
                }}
                style={[
                  selectOptionStyle,
                  optionValue === value ? selectOptionActiveStyle : null,
                ]}
              >
                <Text numberOfLines={1} style={selectOptionTextStyle}>
                  {optionLabel}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

function SessionRow({
  compact,
  copiedKey,
  hostLabel,
  language,
  onCopy,
  session,
}: {
  compact: boolean;
  copiedKey?: string;
  hostLabel: string;
  language: LanguageMode;
  onCopy: (value: string, key: string) => void;
  session: SessionRecord;
}) {
  const workspaces = session.workspaceRoots.length > 0
    ? session.workspaceRoots.map(readWorkspaceLabel).join(" · ")
    : t(language, "未限定目录", "No workspace limit");
  const updated = formatTime(session.updatedAt ?? session.createdAt, language);
  const title = session.title?.trim() || `${readAgentLabel(session)} · ${hostLabel}`;
  return (
    <View style={[rowStyle, compact ? compactRowStyle : null]}>
      <View style={{ flex: compact ? undefined : 1.05, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={secondaryMonoStyle}>
          {hostLabel} · {shortId(session.sessionId)}
        </Text>
      </View>
      <View style={{ flex: compact ? undefined : 0.9, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {readAgentLabel(session)}
        </Text>
        <Text numberOfLines={1} style={secondaryTextStyle}>
          {session.hostOnline ? t(language, "在线", "Online") : t(language, "离线", "Offline")} · {updated}
        </Text>
      </View>
      <View style={{ flex: compact ? undefined : 1.15, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {workspaces}
        </Text>
        <SessionMeta language={language} session={session} />
      </View>
      <View style={{ flex: compact ? undefined : 1.45, minWidth: 0 }}>
        <SessionIdentity language={language} session={session} />
      </View>
      <SessionActions
        copiedKey={copiedKey}
        language={language}
        onCopy={onCopy}
        session={session}
      />
    </View>
  );
}

function SessionHeader({ language }: { language: LanguageMode }) {
  return (
    <View style={[rowStyle, { backgroundColor: "#F5F1E8", minHeight: 34, paddingVertical: 8 }]}>
      <Text style={[headerCellStyle, { flex: 1.05 }]}>{t(language, "主机", "Host")}</Text>
      <Text style={[headerCellStyle, { flex: 0.9 }]}>{t(language, "Agent", "Agent")}</Text>
      <Text style={[headerCellStyle, { flex: 1.15 }]}>{t(language, "上下文", "Context")}</Text>
      <Text style={[headerCellStyle, { flex: 1.45 }]}>{t(language, "标识", "Identity")}</Text>
      <Text style={[headerCellStyle, { minWidth: 154, textAlign: "right" }]}>{t(language, "操作", "Actions")}</Text>
    </View>
  );
}

function SessionMeta({
  language,
  session,
}: {
  language: LanguageMode;
  session: SessionRecord;
}) {
  const statusLabel = readStatusLabel(session.status, language);
  const statusTone = readStatusTone(session.status);
  const detail = session.error ?? session.latestEvent ?? "";
  return (
    <View style={{ gap: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={[common.eyebrow, { color: statusTone }]}>
        {statusLabel}
      </Text>
      {detail ? (
        <Text numberOfLines={2} style={[secondaryTextStyle, session.error ? { color: colors.coral } : null]}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

function SessionIdentity({
  language,
  session,
}: {
  language: LanguageMode;
  session: SessionRecord;
}) {
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Text selectable numberOfLines={1} style={secondaryMonoStyle}>
        {t(language, "Session", "Session")} {session.sessionId}
      </Text>
      {session.connectionId ? (
        <Text selectable numberOfLines={1} style={secondaryMonoStyle}>
          {t(language, "连接", "Connection")} {session.connectionId}
        </Text>
      ) : null}
      {session.requestId !== undefined ? (
        <Text selectable numberOfLines={1} style={secondaryMonoStyle}>
          {t(language, "请求", "Request")} {String(session.requestId)}
        </Text>
      ) : null}
    </View>
  );
}

function SessionActions({
  copiedKey,
  language,
  onCopy,
  session,
}: {
  copiedKey?: string;
  language: LanguageMode;
  onCopy: (value: string, key: string) => void;
  session: SessionRecord;
}) {
  return (
    <View style={actionRailStyle}>
      <ActionButton
        label={copiedKey === `${session.sessionId}:session` ? t(language, "已复制", "Copied") : t(language, "复制 ID", "Copy ID")}
        onPress={() => onCopy(session.sessionId, `${session.sessionId}:session`)}
      />
      {session.connectionId ? (
        <ActionButton
          label={copiedKey === `${session.sessionId}:connection` ? t(language, "已复制", "Copied") : t(language, "复制连接", "Copy conn")}
          onPress={() => onCopy(session.connectionId ?? "", `${session.sessionId}:connection`)}
        />
      ) : null}
    </View>
  );
}

function ActionButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={actionButtonStyle}>
      <Text style={actionButtonTextStyle}>{label}</Text>
    </Pressable>
  );
}

function Panel({
  body,
  title,
  tone = "default",
}: {
  body: string;
  title: string;
  tone?: "default" | "error";
}) {
  return (
    <View style={[common.panel, { padding: 18 }]}>
      <Text style={{ color: tone === "error" ? colors.coral : colors.ink, fontFamily: typography.sansSemi, fontSize: 18 }}>
        {title}
      </Text>
      <Text style={[common.body, { marginTop: 8 }]}>{body}</Text>
    </View>
  );
}

async function copyText(value: string): Promise<boolean> {
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function"
  ) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  return false;
}

function readHostLabel(host: HostRecord): string {
  const displayName = host.metadata?.displayName;
  if (typeof displayName === "string" && displayName.trim()) return displayName;
  const machine = host.metadata?.machine;
  if (typeof machine === "string" && machine.trim()) return machine;
  return shortId(host.hostId);
}

function readSessionHostLabel(session: SessionRecord, hostLabels: ReadonlyMap<string, string>): string {
  const label = hostLabels.get(session.hostId);
  if (label) return label;
  if (session.hostName?.trim()) return session.hostName;
  const displayName = session.hostMetadata?.displayName;
  if (typeof displayName === "string" && displayName.trim()) return displayName;
  const machine = session.hostMetadata?.machine;
  if (typeof machine === "string" && machine.trim()) return machine;
  return shortId(session.hostId);
}

function readAgentLabel(session: SessionRecord): string {
  return session.agent?.id ?? session.agent?.command ?? session.agent?.type ?? "Agent";
}

function readAgentKey(session: SessionRecord): string {
  return session.agent?.id ?? session.agent?.command ?? session.agent?.type ?? "unknown";
}

function readStatusLabel(status: SessionRecord["status"], language: LanguageMode): string {
  if (status === "waiting_authorization") return t(language, "等待授权", "Waiting");
  if (status === "starting") return t(language, "启动中", "Starting");
  if (status === "failed") return t(language, "失败", "Failed");
  if (status === "offline") return t(language, "离线历史", "Offline");
  return t(language, "运行中", "Active");
}

function readStatusTone(status: SessionRecord["status"]): string {
  if (status === "failed") return colors.coral;
  if (status === "starting" || status === "waiting_authorization") return colors.cyan;
  if (status === "offline") return colors.muted;
  return colors.green;
}

function readHealthCheckLabel(status: SessionHealth["checks"][number]["status"], language: LanguageMode): string {
  if (status === "ok") return t(language, "正常", "OK");
  if (status === "warning") return t(language, "注意", "Warning");
  return t(language, "异常", "Error");
}

function readHealthCheckName(id: SessionHealth["checks"][number]["id"], language: LanguageMode): string {
  if (id === "account_session") return t(language, "账号会话", "Account session");
  if (id === "relay") return t(language, "Relay", "Relay");
  if (id === "host") return t(language, "主机", "Host");
  return t(language, "Session", "Session");
}

function readHealthCheckMessage(
  check: SessionHealth["checks"][number],
  health: SessionHealth,
  language: LanguageMode,
): string {
  if (check.id === "account_session") return t(language, "Workbench 登录会话有效。", "Workbench account session is valid.");
  if (check.id === "relay") return t(language, "Relay API 与账号分片可响应。", "Relay API and account shard responded.");
  if (check.id === "host") {
    if (health.onlineHostCount > 0) {
      return t(language, `${health.onlineHostCount} 台主机在线。`, `${health.onlineHostCount} host${health.onlineHostCount === 1 ? "" : "s"} online.`);
    }
    return t(language, "没有在线主机，需启动或重连 Free host。", "No host is online. Start or reconnect a Free host.");
  }
  if (health.liveSessionCount > 0) {
    return t(language, `${health.liveSessionCount} 个激活 Session 可见。`, `${health.liveSessionCount} live session${health.liveSessionCount === 1 ? "" : "s"} visible.`);
  }
  if (health.offlineSessionCount > 0) {
    return t(language, "没有激活 Session，存在离线历史。", "No live session. Offline session history is available.");
  }
  return t(language, "没有激活 Session，请从 ACP 客户端启动。", "No live session. Start a session from an ACP client.");
}

function readWorkspaceLabel(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const segment = normalized.split("/").filter(Boolean).pop();
  return segment ? `/${segment}` : normalized || "/";
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function formatTime(value: string | undefined, language: LanguageMode): string {
  if (!value) return t(language, "未知", "Unknown");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const inputStyle = {
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  color: colors.ink,
  fontFamily: typography.sans,
  fontSize: 14,
  minHeight: 34,
  paddingHorizontal: 12,
};

const toolbarStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
};

const filterRailStyle = {
  alignItems: "flex-start" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
  paddingBottom: 2,
};

const healthPanelStyle = {
  gap: 8,
  padding: 12,
};

const healthTitleStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 14,
};

const selectButtonStyle = {
  alignItems: "center" as const,
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 7,
  borderWidth: 1,
  flexDirection: "row" as const,
  gap: 6,
  minHeight: 32,
  paddingHorizontal: 10,
};

const selectButtonActiveStyle = {
  backgroundColor: "#F8FFE3",
  borderColor: colors.graphite,
};

const selectButtonTextStyle = {
  color: colors.ink,
  flex: 1,
  fontFamily: typography.sansSemi,
  fontSize: 12,
};

const selectCaretStyle = {
  color: colors.muted,
  fontFamily: typography.sansSemi,
  fontSize: 9,
};

const selectMenuStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  left: 0,
  marginTop: 4,
  overflow: "hidden" as const,
  position: "absolute" as const,
  right: 0,
  shadowColor: colors.ink,
  shadowOffset: { width: 2, height: 2 },
  shadowOpacity: 1,
  shadowRadius: 0,
  top: 52,
};

const selectOptionStyle = {
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  minHeight: 30,
  justifyContent: "center" as const,
  paddingHorizontal: 10,
};

const selectOptionActiveStyle = {
  backgroundColor: "#F5F1E8",
};

const selectOptionTextStyle = {
  color: colors.ink,
  fontFamily: typography.sans,
  fontSize: 12,
};

const rowStyle = {
  alignItems: "center" as const,
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 12,
  minHeight: 56,
  paddingHorizontal: 12,
  paddingVertical: 8,
};

const compactRowStyle = {
  alignItems: "flex-start" as const,
  flexDirection: "column" as const,
  gap: 7,
};

const actionRailStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 6,
  justifyContent: "flex-end" as const,
  minWidth: 154,
};

const actionButtonStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 7,
  borderWidth: 1,
  justifyContent: "center" as const,
  minHeight: 30,
  paddingHorizontal: 9,
};

const actionButtonTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 12,
};

const primaryTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 14,
  lineHeight: 18,
};

const secondaryTextStyle = {
  color: colors.muted,
  fontFamily: typography.sans,
  fontSize: 12,
  lineHeight: 16,
};

const secondaryMonoStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 11,
  lineHeight: 15,
};

const headerCellStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 11,
  textTransform: "uppercase" as const,
};
