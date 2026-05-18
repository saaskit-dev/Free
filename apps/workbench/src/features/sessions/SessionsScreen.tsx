import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

import { checkSessionHealth, closeSession } from "../../api/relay";
import type { HostRecord, LanguageMode, LoadState, SessionHealth, SessionRecord } from "../../types";
import { minimumLoadingDelay } from "../../ui/loading";
import { colors, common, typography } from "../../ui/theme";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { t } from "../../workbench/preferences";

type SessionsScreenProps = {
  hosts: LoadState<HostRecord[]>;
  language: LanguageMode;
  onChanged: () => Promise<void>;
  onSessionClosed: (sessionId: string) => void;
  sessions: LoadState<SessionRecord[]>;
};

type StatusFilter = "all" | "online" | "offline" | Exclude<NonNullable<SessionRecord["status"]>, "offline">;
type FilterId = "agent" | "host" | "status" | "workspace";
type HealthState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; value: SessionHealth }
  | { status: "error"; message: string };
type ToastState = { id: number; tone: "error" | "success"; value: string };

export function SessionsScreen({ hosts, language, onChanged, onSessionClosed, sessions }: SessionsScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 900;
  const [query, setQuery] = useState("");
  const [hostId, setHostId] = useState("all");
  const [agentKey, setAgentKey] = useState("all");
  const [workspaceRoot, setWorkspaceRoot] = useState("all");
  const [status, setStatus] = useState<StatusFilter>("online");
  const [openFilter, setOpenFilter] = useState<FilterId | undefined>();
  const [copiedKey, setCopiedKey] = useState<string | undefined>();
  const [closingSessionId, setClosingSessionId] = useState<string | undefined>();
  const [confirmSession, setConfirmSession] = useState<SessionRecord | undefined>();
  const [toast, setToast] = useState<ToastState | undefined>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [health, setHealth] = useState<HealthState>({ status: "idle" });

  useEffect(() => {
    return () => {
      if (toastTimer.current) {
        clearTimeout(toastTimer.current);
      }
    };
  }, []);

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
      if (hostId !== "all" && session.hostId !== hostId) return false;
      if (agentKey !== "all" && readAgentKey(session) !== agentKey) return false;
      if (workspaceRoot !== "all" && !session.workspaceRoots.includes(workspaceRoot)) return false;
      if (!matchesStatusFilter(session, status)) return false;
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
        readBridgeLabel(session, language),
        readActivityLabel(session, language),
        session.latestEvent ?? "",
        session.error ?? "",
      ];
      return values.some((value) => value.toLowerCase().includes(needle));
    });
  }, [agentKey, hostId, hostLabels, language, query, sessions, status, workspaceRoot]);

  const sessionCounts = useMemo(() => {
    if (sessions.status !== "ready") {
      return { detached: 0, live: 0, offline: 0, total: 0 };
    }
    return sessions.data.reduce(
      (counts, session) => {
        counts.total += 1;
        if (session.lifecycle === "offline") {
          counts.offline += 1;
        } else if (session.status === "detached") {
          counts.detached += 1;
        } else {
          counts.live += 1;
        }
        return counts;
      },
      { detached: 0, live: 0, offline: 0, total: 0 },
    );
  }, [sessions]);

  const copyValue = (value: string, key: string) => {
    void copyText(value).then((ok) => {
      if (!ok) {
        showToast("error", t(language, "复制失败", "Copy failed"));
        return;
      }
      setCopiedKey(key);
      showToast("success", t(language, "已复制 Session ID", "Session ID copied"));
      setTimeout(() => {
        setCopiedKey((current) => current === key ? undefined : current);
      }, 1400);
    });
  };

  const closeDisconnectedSession = (session: SessionRecord) => {
    if (closingSessionId) return;
    setConfirmSession(session);
  };

  const confirmCloseSession = () => {
    if (!confirmSession || closingSessionId) return;
    const session = confirmSession;
    setClosingSessionId(session.sessionId);
    void Promise.all([closeSession(session.sessionId), minimumLoadingDelay()])
      .then(async () => {
        onSessionClosed(session.sessionId);
        setConfirmSession(undefined);
        showToast("success", t(language, "Session 已关闭", "Session closed"));
        void onChanged();
      })
      .catch((error: unknown) => {
        showToast("error", error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setClosingSessionId(undefined);
      });
  };

  const showToast = (tone: ToastState["tone"], value: string) => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    const id = Date.now();
    setToast({ id, tone, value });
    toastTimer.current = setTimeout(() => {
      setToast((current) => current?.id === id ? undefined : current);
    }, 1800);
  };

  const runHealthCheck = () => {
    if (health.status === "checking") return;
    setHealth({ status: "checking" });
    void Promise.all([checkSessionHealth(), minimumLoadingDelay()]).then(([result]) => {
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

  const confirmClosing = closingSessionId === confirmSession?.sessionId;

  return (
    <View style={{ gap: 10, position: "relative" }}>
      {toast ? <ToastNotice toast={toast} /> : null}
      <ConfirmDialog
        cancelDisabled={confirmClosing}
        confirmLabel={confirmClosing ? t(language, "关闭中", "Closing") : t(language, "关闭 Session", "Close session")}
        confirmLoading={confirmClosing}
        description={confirmSession
          ? t(
            language,
            "此操作会关闭这个未连接的 ACP Session。关闭后只能作为历史记录查看。",
            "This closes the detached ACP session. After closing, it remains visible as history.",
          )
          : undefined}
        language={language}
        onCancel={() => {
          if (!confirmClosing) setConfirmSession(undefined);
        }}
        onConfirm={confirmCloseSession}
        tone="danger"
        title={t(language, "确认关闭 Session", "Confirm session close")}
        visible={confirmSession !== undefined}
      />
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
          {visibleSessions.length} / {sessionCounts.total}
        </Text>
        <Pressable
          accessibilityLabel={t(language, "检查链路健康", "Check chain health")}
          accessibilityRole="button"
          accessibilityState={health.status === "checking" ? { busy: true, disabled: true } : undefined}
          disabled={health.status === "checking"}
          onPress={runHealthCheck}
          style={[actionButtonStyle, health.status === "checking" ? disabledActionButtonStyle : null]}
        >
          <Text style={actionButtonTextStyle}>
            {health.status === "checking" ? t(language, "检查中", "Checking") : t(language, "健康检查", "Health")}
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
            ["online", t(language, "在线", "Online")],
            ["detached", t(language, "未连接", "Detached")],
            ["offline", t(language, "已关闭", "Closed")],
            ["active", t(language, "运行中", "Active")],
            ["starting", t(language, "启动中", "Starting")],
            ["waiting_authorization", t(language, "等待授权", "Waiting")],
            ["failed", t(language, "失败", "Failed")],
          ]}
          value={status}
          onChange={(value) => {
            setStatus(value as StatusFilter);
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
          body={readEmptyFilterMessage(status, sessionCounts, language)}
        />
      ) : (
        <View style={compact ? mobileListStyle : [common.panel, { overflow: "hidden" }]}>
          {visibleSessions.map((session) => (
            <SessionRow
              compact={compact}
              copiedKey={copiedKey}
              hostLabel={readSessionHostLabel(session, hostLabels)}
              key={session.sessionId}
              language={language}
              onClose={closeDisconnectedSession}
              onCopy={copyValue}
              closing={closingSessionId === session.sessionId}
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
          {t(language, "在线", "Live")} {health.value.liveSessionCount} · {t(language, "未连接", "Detached")} {health.value.detachedSessionCount ?? 0} · {t(language, "已关闭", "Closed")} {health.value.offlineSessionCount} · Host {health.value.onlineHostCount}
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
    <View style={{ elevation: open ? 20 : 1, minWidth: 150, position: "relative", zIndex: open ? 200 : 1 }}>
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
  onClose,
  onCopy,
  closing,
  session,
}: {
  closing: boolean;
  compact: boolean;
  copiedKey?: string;
  hostLabel: string;
  language: LanguageMode;
  onClose: (session: SessionRecord) => void;
  onCopy: (value: string, key: string) => void;
  session: SessionRecord;
}) {
  const updated = formatSessionUpdated(session, language);
  const agentLabel = readAgentLabel(session);
  const title = readSessionTitle(session, language);
  const sessionIdKey = `${session.sessionId}:session`;
  if (compact) {
    return (
      <MobileSessionRow
        agentLabel={agentLabel}
        closing={closing}
        copied={copiedKey === sessionIdKey}
        hostLabel={hostLabel}
        language={language}
        onClose={() => onClose(session)}
        onCopy={() => onCopy(session.sessionId, sessionIdKey)}
        session={session}
        title={title}
        updated={updated}
      />
    );
  }
  return (
    <DesktopSessionRow
      agentLabel={agentLabel}
      closing={closing}
      copied={copiedKey === sessionIdKey}
      hostLabel={hostLabel}
      language={language}
      onClose={() => onClose(session)}
      onCopy={() => onCopy(session.sessionId, sessionIdKey)}
      session={session}
      title={title}
      updated={updated}
    />
  );
}

function DesktopSessionRow({
  agentLabel,
  closing,
  copied,
  hostLabel,
  language,
  onClose,
  onCopy,
  session,
  title,
  updated,
}: {
  agentLabel: string;
  closing: boolean;
  copied: boolean;
  hostLabel: string;
  language: LanguageMode;
  onClose: () => void;
  onCopy: () => void;
  session: SessionRecord;
  title: string;
  updated: string;
}) {
  const canClose = canCloseFromWorkbench(session);
  const statusTone = readLifecycleStatusTone(session);
  const activityDetail = hasSessionActiveEvent(session) ? readSessionDetail(session, language) : "";
  const rawTitle = session.title?.trim();
  const workspace = readWorkspaceSummary(session, language);
  const displayTitle = rawTitle ? title : workspace;
  const subtitle = rawTitle && workspace !== displayTitle ? workspace : readSessionContextLine(session, language);
  return (
    <View style={desktopRowStyle}>
      <View style={desktopMainStyle}>
        <View style={desktopTitleLineStyle}>
          <Text numberOfLines={1} style={mobileTitleStyle}>
            {displayTitle}
          </Text>
          <View style={[mobileStatusPillStyle, { borderColor: statusTone }]}>
            <View style={[mobileStatusDotStyle, { backgroundColor: statusTone }]} />
            <Text numberOfLines={1} style={[mobileStatusTextStyle, { color: statusTone }]}>
              {readLifecycleStatusLabel(session, language)}
            </Text>
          </View>
        </View>
        {subtitle ? (
          <Text numberOfLines={1} style={mobileWorkspaceStyle}>
            {subtitle}
          </Text>
        ) : null}
        <Pressable
          accessibilityLabel={t(language, "复制 Session ID", "Copy session ID")}
          accessibilityRole="button"
          onPress={onCopy}
        >
          <Text style={[
            secondaryMonoStyle,
            sessionIdTextStyle,
            copied ? { color: colors.green } : null,
          ]}>
            {copied ? t(language, "已复制", "Copied") : session.sessionId}
          </Text>
        </Pressable>
      </View>

      <View style={desktopSignalsStyle}>
        <DesktopSignal
          label={t(language, "Host", "Host")}
          tone={session.hostOnline === false ? colors.coral : colors.ink}
          value={hostLabel}
        />
        <DesktopSignal
          label={t(language, "Agent", "Agent")}
          tone={colors.ink}
          value={agentLabel}
        />
        <DesktopSignal
          label={t(language, "Bridge", "Bridge")}
          tone={session.bridgeConnected || session.connectionId ? colors.green : colors.muted}
          value={readBridgeLabel(session, language)}
        />
        <DesktopSignal
          label={t(language, "活动", "Activity")}
          tone={session.error ? colors.coral : hasSessionActiveEvent(session) ? colors.cyan : colors.muted}
          value={activityDetail || readActivityLabel(session, language)}
        />
      </View>

      <View style={desktopTailStyle}>
        <Text numberOfLines={1} style={secondaryTextStyle}>{updated}</Text>
        {canClose ? (
          <ActionButton
            disabled={closing}
            label={closing ? t(language, "关闭中", "Closing") : t(language, "关闭", "Close")}
            onPress={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}

function DesktopSignal({
  label,
  tone,
  value,
}: {
  label: string;
  tone: string;
  value: string;
}) {
  return (
    <View style={desktopSignalStyle}>
      <Text numberOfLines={1} style={mobileSignalLabelStyle}>{label}</Text>
      <Text numberOfLines={1} style={[mobileSignalValueStyle, { color: tone }]}>
        {value}
      </Text>
    </View>
  );
}

function MobileSessionRow({
  agentLabel,
  closing,
  copied,
  hostLabel,
  language,
  onClose,
  onCopy,
  session,
  title,
  updated,
}: {
  agentLabel: string;
  closing: boolean;
  copied: boolean;
  hostLabel: string;
  language: LanguageMode;
  onClose: () => void;
  onCopy: () => void;
  session: SessionRecord;
  title: string;
  updated: string;
}) {
  const canClose = canCloseFromWorkbench(session);
  const statusTone = readLifecycleStatusTone(session);
  const activityDetail = hasSessionActiveEvent(session) ? readSessionDetail(session, language) : "";
  const rawTitle = session.title?.trim();
  const workspace = readWorkspaceSummary(session, language);
  const mobileTitle = rawTitle ? title : workspace;
  const mobileSubtitle = rawTitle && workspace !== mobileTitle ? workspace : "";
  return (
    <View style={mobileRowStyle}>
      <View style={mobileRowHeaderStyle}>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text numberOfLines={1} style={mobileTitleStyle}>
            {mobileTitle}
          </Text>
          {mobileSubtitle ? (
            <Text numberOfLines={1} style={mobileWorkspaceStyle}>
              {mobileSubtitle}
            </Text>
          ) : null}
        </View>
        <View style={[mobileStatusPillStyle, { borderColor: statusTone }]}>
          <View style={[mobileStatusDotStyle, { backgroundColor: statusTone }]} />
          <Text numberOfLines={1} style={[mobileStatusTextStyle, { color: statusTone }]}>
            {readLifecycleStatusLabel(session, language)}
          </Text>
        </View>
      </View>

      <View style={mobileSublineStyle}>
        <Text numberOfLines={1} style={mobileAgentStyle}>{agentLabel}</Text>
        <Text numberOfLines={1} style={secondaryTextStyle}>{updated}</Text>
      </View>

      <View style={mobileSignalsStyle}>
        <MobileSignal
          label={t(language, "Host", "Host")}
          tone={session.hostOnline === false ? colors.coral : colors.ink}
          value={hostLabel}
        />
        <MobileSignal
          label={t(language, "Bridge", "Bridge")}
          tone={session.bridgeConnected || session.connectionId ? colors.green : colors.muted}
          value={readBridgeLabel(session, language)}
        />
        <MobileSignal
          label={t(language, "活动", "Activity")}
          tone={session.error ? colors.coral : hasSessionActiveEvent(session) ? colors.cyan : colors.muted}
          value={activityDetail || readActivityLabel(session, language)}
        />
      </View>

      <View style={mobileFooterStyle}>
        <Pressable
          accessibilityLabel={t(language, "复制 Session ID", "Copy session ID")}
          accessibilityRole="button"
          onPress={onCopy}
          style={mobileSessionIdStyle}
        >
          <Text style={[
            secondaryMonoStyle,
            sessionIdTextStyle,
            copied ? { color: colors.green } : null,
          ]}>
            {copied
              ? t(language, "已复制", "Copied")
              : session.sessionId}
          </Text>
        </Pressable>
        {canClose ? (
          <ActionButton
            disabled={closing}
            label={closing ? t(language, "关闭中", "Closing") : t(language, "关闭", "Close")}
            onPress={onClose}
          />
        ) : null}
      </View>
    </View>
  );
}

function MobileSignal({
  label,
  tone,
  value,
}: {
  label: string;
  tone: string;
  value: string;
}) {
  return (
    <View style={mobileSignalStyle}>
      <Text numberOfLines={1} style={mobileSignalLabelStyle}>{label}</Text>
      <Text numberOfLines={1} style={[mobileSignalValueStyle, { color: tone }]}>{value}</Text>
    </View>
  );
}

function ActionButton({
  disabled,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled}
      onPress={onPress}
      style={[actionButtonStyle, disabled ? disabledActionButtonStyle : null]}
    >
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
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the textarea-based fallback for local HTTP workbench pages.
    }
  }
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textarea);
    }
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

function readSessionTitle(session: SessionRecord, language: LanguageMode): string {
  const title = session.title?.trim();
  const workspace = readPrimaryWorkspaceLabel(session, language);
  if (!title) return workspace;
  const agent = readAgentLabel(session);
  const hostName = session.hostName ?? session.hostMetadata?.displayName ?? session.hostMetadata?.machine;
  const redundantTokens = [agent, hostName].filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0
  );
  if (redundantTokens.some((token) => title.includes(token)) && workspace !== title) {
    return workspace;
  }
  return title;
}

function readPrimaryWorkspaceLabel(session: SessionRecord, language: LanguageMode): string {
  const first = session.workspaceRoots[0];
  if (!first) return t(language, "未限定目录", "No workspace limit");
  return readWorkspaceLabel(first);
}

function readWorkspaceSummary(session: SessionRecord, language: LanguageMode): string {
  if (session.workspaceRoots.length === 0) {
    return t(language, "未限定目录", "No workspace limit");
  }
  const [first, ...rest] = session.workspaceRoots;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

function readSessionContextLine(session: SessionRecord, language: LanguageMode): string {
  const workspace = readWorkspaceSummary(session, language);
  if (session.workspaceRoots.length <= 1) return workspace;
  return `${workspace} · ${t(language, "共", "Total")} ${session.workspaceRoots.length} ${t(language, "个目录", "workspaces")}`;
}

function readLifecycleStatusLabel(session: SessionRecord, language: LanguageMode): string {
  if (session.lifecycle === "offline" || session.status === "offline") {
    return t(language, "Session 已关闭", "Session closed");
  }
  if (session.status === "detached") {
    return t(language, "未连接，未关闭", "Detached open");
  }
  if (session.hostOnline === false) {
    return t(language, "Host 离线", "Host offline");
  }
  return readStatusLabel(session.status, language);
}

function readBridgeLabel(session: SessionRecord, language: LanguageMode): string {
  return session.bridgeConnected || session.connectionId
    ? t(language, "已连接", "Connected")
    : t(language, "未连接", "Disconnected");
}

function readActivityLabel(session: SessionRecord, language: LanguageMode): string {
  return hasSessionActiveEvent(session)
    ? t(language, "有活动", "Active event")
    : t(language, "无活动", "No activity");
}

function hasSessionActiveEvent(session: SessionRecord): boolean {
  return Boolean(session.hasActiveEvent || session.error);
}

function canCloseFromWorkbench(session: SessionRecord): boolean {
  if (session.lifecycle === "offline" || session.status === "offline") {
    return false;
  }
  return !Boolean(session.bridgeConnected || session.connectionId);
}

function readSessionDetail(session: SessionRecord, language: LanguageMode): string {
  if (session.error) return session.error;
  const event = session.latestEvent?.trim();
  if (!event) return "";
  if (event === "Session is not attached to a live ACP client.") {
    return t(language, "ACP Session 未关闭。", "ACP session is open.");
  }
  if (event === "ACP session is open.") {
    return t(language, "ACP Session 未关闭。", "ACP session is open.");
  }
  if (event === "ACP session was closed.") {
    return t(language, "ACP Session 已关闭。", "ACP session was closed.");
  }
  return event;
}

function matchesStatusFilter(session: SessionRecord, status: StatusFilter): boolean {
  if (status === "all") return true;
  if (status === "online") return session.lifecycle !== "offline" && session.status !== "offline" && session.status !== "detached";
  if (status === "offline") return session.lifecycle === "offline" || session.status === "offline";
  return session.status === status;
}

function readEmptyFilterMessage(
  status: StatusFilter,
  counts: { detached: number; live: number; offline: number; total: number },
  language: LanguageMode,
): string {
  if (status === "online" && (counts.detached > 0 || counts.offline > 0)) {
    return t(
      language,
      counts.detached > 0
        ? "当前没有在线 Session。可在状态筛选中选择未连接或全部查看未关闭 Session。"
        : "当前没有在线 Session。可在状态筛选中选择已关闭或全部查看历史。",
      counts.detached > 0
        ? "No online sessions. Choose Detached or All in the state filter to view open sessions."
        : "No online sessions. Choose Closed or All in the state filter to view history.",
    );
  }
  if (status === "offline" && counts.live > 0) {
    return t(
      language,
      "当前没有已关闭 Session。可在状态筛选中选择在线或全部查看在线 Session。",
      "No closed sessions. Choose Online or All in the state filter to view live sessions.",
    );
  }
  return t(language, "调整筛选条件或搜索词后再查看。", "Adjust the filters or search text.");
}

function readStatusLabel(status: SessionRecord["status"], language: LanguageMode): string {
  if (status === "waiting_authorization") return t(language, "等待授权", "Waiting");
  if (status === "starting") return t(language, "启动中", "Starting");
  if (status === "detached") return t(language, "未连接", "Detached");
  if (status === "failed") return t(language, "失败", "Failed");
  if (status === "offline") return t(language, "已关闭", "Closed");
  return t(language, "运行中", "Active");
}

function readStatusTone(status: SessionRecord["status"]): string {
  if (status === "failed") return colors.coral;
  if (status === "starting" || status === "waiting_authorization") return colors.cyan;
  if (status === "detached") return colors.cyan;
  if (status === "offline") return colors.muted;
  return colors.green;
}

function readLifecycleStatusTone(session: SessionRecord): string {
  if (session.lifecycle === "offline" || session.status === "offline") {
    return colors.muted;
  }
  if (session.status === "detached") {
    return colors.cyan;
  }
  if (session.hostOnline === false) {
    return colors.coral;
  }
  return readStatusTone(session.status);
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
    return t(language, `${health.liveSessionCount} 个在线 Session 可见。`, `${health.liveSessionCount} live session${health.liveSessionCount === 1 ? "" : "s"} visible.`);
  }
  if ((health.detachedSessionCount ?? 0) > 0) {
    return t(language, "没有在线 Session，存在未连接但未关闭的 Session。", "No live session. Detached open sessions are available.");
  }
  if (health.offlineSessionCount > 0) {
    return t(language, "没有在线 Session，存在已关闭历史。", "No live session. Closed session history is available.");
  }
  return t(language, "没有在线 Session，请从 ACP 客户端启动。", "No live session. Start a session from an ACP client.");
}

function ToastNotice({ toast }: { toast: ToastState }) {
  return (
    <View
      accessibilityRole="alert"
      style={[
        toastNoticeStyle,
        { borderColor: toast.tone === "error" ? colors.coral : colors.green },
      ]}
    >
      <Text style={[
        toastNoticeTextStyle,
        { color: toast.tone === "error" ? colors.coral : colors.green },
      ]}>
        {toast.value}
      </Text>
    </View>
  );
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

function formatSessionUpdated(session: SessionRecord, language: LanguageMode): string {
  const value = session.updatedAt ?? session.createdAt;
  if (value) return formatTime(value, language);
  if (session.lifecycle !== "offline" && session.status !== "offline" && session.status !== "detached") {
    return t(language, "当前在线", "Live now");
  }
  return t(language, "未记录", "Not recorded");
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
  elevation: 10,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 8,
  paddingBottom: 2,
  zIndex: 100,
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

const toastNoticeStyle = {
  backgroundColor: "#FFFFFF",
  borderRadius: 8,
  borderWidth: 1,
  maxWidth: 360,
  paddingHorizontal: 12,
  paddingVertical: 9,
  position: "absolute" as const,
  right: 0,
  shadowColor: colors.ink,
  shadowOffset: { width: 2, height: 2 },
  shadowOpacity: 1,
  shadowRadius: 0,
  top: 0,
  zIndex: 500,
};

const toastNoticeTextStyle = {
  fontFamily: typography.sansSemi,
  fontSize: 13,
  lineHeight: 17,
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
  zIndex: 300,
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

const disabledActionButtonStyle = {
  opacity: 0.55,
};

const mobileListStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  overflow: "hidden" as const,
};

const desktopRowStyle = {
  alignItems: "center" as const,
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 12,
  minHeight: 78,
  paddingHorizontal: 14,
  paddingVertical: 10,
};

const desktopMainStyle = {
  flex: 1.35,
  gap: 3,
  minWidth: 0,
};

const desktopTitleLineStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  gap: 8,
  minWidth: 0,
};

const desktopSignalsStyle = {
  borderColor: colors.line,
  borderRadius: 7,
  borderWidth: 1,
  flex: 1.35,
  flexDirection: "row" as const,
  minWidth: 360,
  overflow: "hidden" as const,
};

const desktopSignalStyle = {
  borderRightColor: colors.line,
  borderRightWidth: 1,
  flex: 1,
  gap: 2,
  minWidth: 0,
  paddingHorizontal: 9,
  paddingVertical: 7,
};

const desktopTailStyle = {
  alignItems: "flex-end" as const,
  gap: 6,
  minWidth: 112,
};

const mobileRowStyle = {
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  gap: 9,
  paddingHorizontal: 14,
  paddingVertical: 12,
};

const mobileRowHeaderStyle = {
  alignItems: "flex-start" as const,
  flexDirection: "row" as const,
  gap: 10,
};

const mobileTitleStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 15,
  lineHeight: 19,
};

const mobileWorkspaceStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 11,
  lineHeight: 15,
};

const mobileStatusPillStyle = {
  alignItems: "center" as const,
  borderRadius: 999,
  borderWidth: 1,
  flexDirection: "row" as const,
  gap: 5,
  maxWidth: 116,
  minHeight: 24,
  paddingHorizontal: 8,
};

const mobileStatusDotStyle = {
  borderRadius: 999,
  height: 6,
  width: 6,
};

const mobileStatusTextStyle = {
  fontFamily: typography.sansSemi,
  fontSize: 11,
  lineHeight: 14,
};

const mobileSublineStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  gap: 8,
  justifyContent: "space-between" as const,
};

const mobileAgentStyle = {
  color: colors.ink,
  flex: 1,
  fontFamily: typography.sansSemi,
  fontSize: 12,
  lineHeight: 16,
};

const mobileSignalsStyle = {
  borderColor: colors.line,
  borderRadius: 7,
  borderWidth: 1,
  flexDirection: "row" as const,
  overflow: "hidden" as const,
};

const mobileSignalStyle = {
  borderRightColor: colors.line,
  borderRightWidth: 1,
  flex: 1,
  gap: 2,
  minWidth: 0,
  paddingHorizontal: 8,
  paddingVertical: 7,
};

const mobileSignalLabelStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 10,
  lineHeight: 13,
  textTransform: "uppercase" as const,
};

const mobileSignalValueStyle = {
  fontFamily: typography.sansSemi,
  fontSize: 12,
  lineHeight: 16,
};

const mobileFooterStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  gap: 8,
  justifyContent: "space-between" as const,
};

const mobileSessionIdStyle = {
  flex: 1,
  minWidth: 0,
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

const sessionIdTextStyle = {
  color: colors.muted,
  fontSize: 10.5,
  flexShrink: 1,
};
