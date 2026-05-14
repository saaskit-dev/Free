import { useMemo, useState } from "react";
import { Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";

import type { HostRecord, LanguageMode, LoadState, SessionRecord } from "../../types";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type SessionsScreenProps = {
  hosts: LoadState<HostRecord[]>;
  language: LanguageMode;
  sessions: LoadState<SessionRecord[]>;
};

type AvailabilityFilter = "all" | "online" | "offline";

export function SessionsScreen({ hosts, language, sessions }: SessionsScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 900;
  const [query, setQuery] = useState("");
  const [hostId, setHostId] = useState("all");
  const [agentKey, setAgentKey] = useState("all");
  const [workspaceRoot, setWorkspaceRoot] = useState("all");
  const [availability, setAvailability] = useState<AvailabilityFilter>("all");

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
        const agent = readAgentLabel(session);
        agents.set(readAgentKey(session), agent);
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
      if (hostId !== "all" && session.hostId !== hostId) return false;
      if (agentKey !== "all" && readAgentKey(session) !== agentKey) return false;
      if (workspaceRoot !== "all" && !session.workspaceRoots.includes(workspaceRoot)) return false;
      if (availability === "online" && !session.hostOnline) return false;
      if (availability === "offline" && session.hostOnline) return false;
      if (!needle) return true;
      const values = [
        session.sessionId,
        session.hostId,
        readSessionHostLabel(session, hostLabels),
        readAgentLabel(session),
        ...session.workspaceRoots,
      ];
      return values.some((value) => value.toLowerCase().includes(needle));
    });
  }, [agentKey, availability, hostId, hostLabels, query, sessions, workspaceRoot]);

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
          onChangeText={setQuery}
          placeholder={t(language, "搜索 Session、主机、Agent、目录", "Search session, host, agent, workspace")}
          placeholderTextColor={colors.muted}
          style={[inputStyle, { flex: compact ? undefined : 1, width: compact ? "100%" : undefined }]}
          value={query}
        />
        <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Text style={common.eyebrow}>{visibleSessions.length}</Text>
          <FilterButton active={availability === "all"} label={t(language, "全部", "All")} onPress={() => setAvailability("all")} />
          <FilterButton active={availability === "online"} label={t(language, "在线", "Online")} onPress={() => setAvailability("online")} />
          <FilterButton active={availability === "offline"} label={t(language, "离线", "Offline")} onPress={() => setAvailability("offline")} />
        </View>
      </View>

      <View style={filterRailStyle}>
        <FilterGroup
          allLabel={t(language, "全部主机", "All hosts")}
          label={t(language, "主机", "Host")}
          options={filterOptions.hosts.map((id) => [id, hostLabels.get(id) ?? shortId(id)] as const)}
          value={hostId}
          onChange={setHostId}
        />
        <FilterGroup
          allLabel={t(language, "全部 Agent", "All agents")}
          label={t(language, "Agent", "Agent")}
          options={filterOptions.agents}
          value={agentKey}
          onChange={setAgentKey}
        />
        <FilterGroup
          allLabel={t(language, "全部目录", "All workspaces")}
          label={t(language, "目录", "Workspace")}
          options={filterOptions.workspaces}
          value={workspaceRoot}
          onChange={setWorkspaceRoot}
        />
      </View>

      {sessions.data.length === 0 ? (
        <Panel
          title={t(language, "暂无 Session", "No sessions")}
          body={t(
            language,
            "当前账号还没有可管理的 Session。通过 ACP 客户端完成授权后，Session 会出现在这里。",
            "This account has no manageable sessions yet. Sessions appear here after an ACP client is authorized.",
          )}
        />
      ) : visibleSessions.length === 0 ? (
        <Panel
          title={t(language, "没有匹配的 Session", "No matching sessions")}
          body={t(language, "调整筛选条件或搜索词后再查看。", "Adjust the filters or search text.")}
        />
      ) : (
        <View style={[common.panel, { overflow: "hidden" }]}>
          {!compact ? <SessionHeader language={language} /> : null}
          {visibleSessions.map((session) => (
            <SessionRow
              compact={compact}
              key={session.sessionId}
              hostLabel={readSessionHostLabel(session, hostLabels)}
              language={language}
              session={session}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function FilterGroup({
  allLabel,
  label,
  onChange,
  options,
  value,
}: {
  allLabel: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  if (options.length === 0) return null;
  return (
    <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      <Text style={[common.eyebrow, { marginRight: 2 }]}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <FilterButton active={value === "all"} label={allLabel} onPress={() => onChange("all")} />
        {options.map(([optionValue, optionLabel]) => (
          <FilterButton
            key={optionValue}
            active={value === optionValue}
            label={optionLabel}
            onPress={() => onChange(optionValue)}
          />
        ))}
      </View>
    </View>
  );
}

function FilterButton({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: active ? colors.lime : "#FFFFFF",
        borderColor: colors.ink,
        borderRadius: 8,
        borderWidth: 1,
        minHeight: 30,
        paddingHorizontal: 10,
        justifyContent: "center",
      }}
    >
      <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}

function SessionRow({
  compact,
  hostLabel,
  language,
  session,
}: {
  compact: boolean;
  hostLabel: string;
  language: LanguageMode;
  session: SessionRecord;
}) {
  const workspaces = session.workspaceRoots.length > 0
    ? session.workspaceRoots.map(readWorkspaceLabel).join(" · ")
    : t(language, "未限定目录", "No workspace limit");
  const updated = formatTime(session.updatedAt ?? session.createdAt, language);
  return (
    <View style={[rowStyle, compact ? { alignItems: "flex-start", flexDirection: "column", gap: 6 } : null]}>
      <View style={{ flex: compact ? undefined : 1.2, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {hostLabel}
        </Text>
        <Text numberOfLines={1} style={secondaryMonoStyle}>
          {shortId(session.sessionId)}
        </Text>
      </View>
      <View style={{ flex: compact ? undefined : 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {readAgentLabel(session)}
        </Text>
        <Text numberOfLines={1} style={secondaryMonoStyle}>
          {shortId(session.hostId)}
        </Text>
      </View>
      <View style={{ flex: compact ? undefined : 1.4, minWidth: 0 }}>
        <Text numberOfLines={1} style={primaryTextStyle}>
          {workspaces}
        </Text>
        {compact ? (
          <Text numberOfLines={1} style={secondaryTextStyle}>
            {updated}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: compact ? "flex-start" : "flex-end", flex: compact ? undefined : 0.7, minWidth: compact ? undefined : 120 }}>
        <Text style={[common.eyebrow, { color: session.hostOnline ? colors.green : colors.coral }]}>
          {session.hostOnline ? t(language, "在线", "Online") : t(language, "离线", "Offline")}
        </Text>
        {!compact ? (
          <Text numberOfLines={1} style={secondaryTextStyle}>
            {updated}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function SessionHeader({ language }: { language: LanguageMode }) {
  return (
    <View style={[rowStyle, { backgroundColor: "#F5F1E8", minHeight: 34, paddingVertical: 8 }]}>
      <Text style={[headerCellStyle, { flex: 1.2 }]}>{t(language, "主机", "Host")}</Text>
      <Text style={[headerCellStyle, { flex: 1 }]}>{t(language, "Agent", "Agent")}</Text>
      <Text style={[headerCellStyle, { flex: 1.4 }]}>{t(language, "工作目录", "Workspace")}</Text>
      <Text style={[headerCellStyle, { flex: 0.7, minWidth: 120, textAlign: "right" }]}>{t(language, "状态", "State")}</Text>
    </View>
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
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 10,
  paddingBottom: 2,
};

const rowStyle = {
  alignItems: "center" as const,
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 12,
  minHeight: 58,
  paddingHorizontal: 12,
  paddingVertical: 9,
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
