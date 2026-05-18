import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  Edit02Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, useWindowDimensions, View } from "react-native";

import { revokeHost, updateHostName } from "../../api/relay";
import type { HostRecord, LanguageMode, LoadState } from "../../types";
import { Icon } from "../../ui/Icon";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { minimumLoadingDelay } from "../../ui/loading";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type HostsScreenProps = {
  hosts: LoadState<HostRecord[]>;
  language: LanguageMode;
  onChanged: () => Promise<void>;
};

export function HostsScreen({ hosts, language, onChanged }: HostsScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 900;

  if (hosts.status === "loading") {
    return (
      <Panel
        title={t(language, "正在加载主机", "Loading hosts")}
        body={t(language, "正在读取已授权主机。", "Reading authorized hosts.")}
      />
    );
  }
  if (hosts.status === "unauthorized") {
    return <Panel title={t(language, "需要登录", "Sign in required")} body={hosts.message} />;
  }
  if (hosts.status === "error") {
    return <Panel title={t(language, "主机不可用", "Hosts unavailable")} body={hosts.message} tone="error" />;
  }
  if (hosts.data.length === 0) {
    return (
      <Panel
        title={t(language, "暂无主机", "No hosts")}
        body={t(language, "启动 Free host 后，这里会显示可授权的主机、Agent 和目录。", "Start Free host to see available hosts, agents, and workspaces here.")}
      />
    );
  }

  const onlineCount = hosts.data.filter((host) => host.online).length;
  const orderedHosts = [...hosts.data].sort((left, right) => {
    if (Boolean(left.online) !== Boolean(right.online)) return left.online ? -1 : 1;
    return readHostName(left, language).localeCompare(readHostName(right, language));
  });

  return (
    <View style={{ gap: 10 }}>
      <View style={summaryBarStyle}>
        <Text style={summaryTextStyle}>
          {t(language, "在线", "Online")} {onlineCount} / {hosts.data.length}
        </Text>
      </View>
      <View style={compact ? hostListCompactStyle : hostListStyle}>
        {!compact ? <HostHeader language={language} /> : null}
        {orderedHosts.map((host) => (
          <HostRow
            compact={compact}
            host={host}
            key={host.hostId}
            language={language}
            onChanged={onChanged}
          />
        ))}
      </View>
    </View>
  );
}

function HostHeader({ language }: { language: LanguageMode }) {
  return (
    <View style={hostHeaderStyle}>
      <Text style={[headerCellStyle, { flex: 1.25 }]}>{t(language, "主机", "Host")}</Text>
      <Text style={[headerCellStyle, { flex: 1 }]}>{t(language, "Agent", "Agent")}</Text>
      <Text style={[headerCellStyle, { flex: 1.2 }]}>{t(language, "目录", "Workspaces")}</Text>
      <Text style={[headerCellStyle, { flex: 0.8 }]}>{t(language, "运行实例", "Runtime")}</Text>
      <Text style={[headerCellStyle, { minWidth: 126, textAlign: "right" }]}>{t(language, "操作", "Actions")}</Text>
    </View>
  );
}

function HostRow({
  compact,
  host,
  language,
  onChanged,
}: {
  compact: boolean;
  host: HostRecord;
  language: LanguageMode;
  onChanged: () => Promise<void>;
}) {
  const hostName = readHostName(host, language);
  const hostname = readHostname(host, language);
  const agents = readAgentSummary(host, language);
  const workspaces = readWorkspaceSummary(host, language);
  const runtime = readRuntimeSummary(host, language);
  const savedName = readDisplayName(host);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(savedName);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  useEffect(() => {
    setDraft(savedName);
  }, [savedName]);

  async function save() {
    const next = draft.trim();
    if (next.length > 80) {
      setError(t(language, "名称不能超过 80 个字符。", "Name must be 80 characters or fewer."));
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await updateHostName(host.hostId, next);
      setEditing(false);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(language, "保存失败。", "Save failed."));
    } finally {
      setSaving(false);
    }
  }

  async function removeHost() {
    if (removing) return;
    setRemoving(true);
    setError(undefined);
    try {
      await Promise.all([revokeHost(host.hostId), minimumLoadingDelay()]);
      setConfirmRevoke(false);
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(language, "删除失败。", "Delete failed."));
    } finally {
      setRemoving(false);
    }
  }

  if (compact) {
    return (
      <View style={hostMobileRowStyle}>
        <HostTitleBlock
          host={host}
          hostName={hostName}
          hostname={hostname}
          language={language}
        />
        <View style={mobileSignalGridStyle}>
          <Signal label={t(language, "Agent", "Agent")} value={agents} />
          <Signal label={t(language, "目录", "Workspaces")} value={workspaces} />
          <Signal label={t(language, "运行实例", "Runtime")} value={runtime} />
        </View>
        <HostEditPanel
          confirmRevoke={confirmRevoke}
          draft={draft}
          editing={editing}
          error={error}
          hostname={hostname}
          language={language}
          removing={removing}
          saving={saving}
          setConfirmRevoke={setConfirmRevoke}
          setDraft={setDraft}
          setEditing={setEditing}
          onCancel={() => {
            setDraft(savedName);
            setEditing(false);
            setError(undefined);
          }}
          onRemove={() => void removeHost()}
          onSave={() => void save()}
        />
      </View>
    );
  }

  return (
    <View style={hostRowStyle}>
      <View style={{ flex: 1.25, minWidth: 0 }}>
        <HostTitleBlock
          host={host}
          hostName={hostName}
          hostname={hostname}
          language={language}
        />
      </View>
      <Text numberOfLines={1} style={[primaryCellTextStyle, { flex: 1 }]}>{agents}</Text>
      <Text numberOfLines={1} style={[monoCellTextStyle, { flex: 1.2 }]}>{workspaces}</Text>
      <Text numberOfLines={1} style={[monoCellTextStyle, { flex: 0.8 }]}>{runtime}</Text>
      <HostEditPanel
        confirmRevoke={confirmRevoke}
        draft={draft}
        editing={editing}
        error={error}
        hostname={hostname}
        language={language}
        removing={removing}
        saving={saving}
        setConfirmRevoke={setConfirmRevoke}
        setDraft={setDraft}
        setEditing={setEditing}
        onCancel={() => {
          setDraft(savedName);
          setEditing(false);
          setError(undefined);
        }}
        onRemove={() => void removeHost()}
        onSave={() => void save()}
      />
    </View>
  );
}

function HostTitleBlock({
  host,
  hostName,
  hostname,
  language,
}: {
  host: HostRecord;
  hostName: string;
  hostname: string;
  language: LanguageMode;
}) {
  return (
    <View style={{ gap: 3, minWidth: 0 }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 8, minWidth: 0 }}>
        <View style={[statusDotStyle, { backgroundColor: host.online ? colors.green : colors.coral }]} />
        <Text numberOfLines={1} style={hostNameStyle}>{hostName}</Text>
        <Text style={[statusTextStyle, { color: host.online ? colors.green : colors.coral }]}>
          {host.online ? t(language, "在线", "Online") : t(language, "离线", "Offline")}
        </Text>
      </View>
      <Text numberOfLines={1} style={secondaryMonoStyle}>{hostname}</Text>
    </View>
  );
}

function HostEditPanel({
  confirmRevoke,
  draft,
  editing,
  error,
  hostname,
  language,
  removing,
  saving,
  setConfirmRevoke,
  setDraft,
  setEditing,
  onCancel,
  onRemove,
  onSave,
}: {
  confirmRevoke: boolean;
  draft: string;
  editing: boolean;
  error?: string;
  hostname: string;
  language: LanguageMode;
  removing: boolean;
  saving: boolean;
  setConfirmRevoke: (value: boolean) => void;
  setDraft: (value: string) => void;
  setEditing: (value: boolean) => void;
  onCancel: () => void;
  onRemove: () => void;
  onSave: () => void;
}) {
  if (editing) {
    return (
      <View style={editPanelStyle}>
        <TextInput
          accessibilityLabel={t(language, "主机名称", "Host name")}
          autoCapitalize="none"
          onChangeText={setDraft}
          placeholder={hostname}
          placeholderTextColor={colors.muted}
          style={editInputStyle}
          value={draft}
        />
        <View style={actionRailStyle}>
          <IconButton
            disabled={saving}
            icon={CheckmarkCircle02Icon}
            label={saving ? t(language, "保存中", "Saving") : t(language, "保存", "Save")}
            onPress={onSave}
            primary
          />
          <IconButton
            disabled={saving}
            icon={Cancel01Icon}
            label={t(language, "取消", "Cancel")}
            onPress={onCancel}
          />
        </View>
        {error ? <Text style={errorTextStyle}>{error}</Text> : null}
      </View>
    );
  }
  return (
    <View style={actionRailStyle}>
      <IconButton
        icon={Edit02Icon}
        label={t(language, "改名", "Rename")}
        onPress={() => setEditing(true)}
      />
      <IconButton
        danger
        disabled={removing}
        icon={Delete02Icon}
        label={removing ? t(language, "删除中", "Deleting") : t(language, "撤销授权", "Revoke")}
        onPress={() => setConfirmRevoke(true)}
      />
      <ConfirmDialog
        cancelDisabled={removing}
        confirmLabel={removing ? t(language, "撤销中", "Revoking") : t(language, "撤销授权", "Revoke")}
        confirmLoading={removing}
        description={t(
          language,
          "撤销后该主机将不再被信任，需要重新授权才能使用。",
          "This host will no longer be trusted and must be re-authorized to use.",
        )}
        language={language}
        onCancel={() => {
          if (!removing) setConfirmRevoke(false);
        }}
        onConfirm={onRemove}
        tone="danger"
        title={t(language, "确认撤销主机授权", "Confirm revoke host authorization")}
        visible={confirmRevoke}
      />
      {error ? <Text style={errorTextStyle}>{error}</Text> : null}
    </View>
  );
}

function IconButton({
  danger,
  disabled,
  icon,
  label,
  onPress,
  primary,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: Parameters<typeof Icon>[0]["icon"];
  label: string;
  onPress: () => void;
  primary?: boolean;
}) {
  const color = danger ? colors.coral : colors.ink;
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[actionButtonStyle, primary ? actionButtonPrimaryStyle : null, disabled ? { opacity: 0.55 } : null]}
    >
      <Icon color={color} icon={icon} size={16} />
      <Text numberOfLines={1} style={[actionButtonTextStyle, { color }]}>{label}</Text>
    </Pressable>
  );
}

function Signal({ label, value }: { label: string; value: string }) {
  return (
    <View style={mobileSignalStyle}>
      <Text numberOfLines={1} style={signalLabelStyle}>{label}</Text>
      <Text numberOfLines={1} style={primaryCellTextStyle}>{value}</Text>
    </View>
  );
}

function readDisplayName(host: HostRecord): string {
  const value = host.metadata?.displayName;
  return typeof value === "string" ? value : "";
}

function readHostName(host: HostRecord, language: LanguageMode): string {
  return readDisplayName(host) || readHostname(host, language);
}

function readHostname(host: HostRecord, language: LanguageMode): string {
  const value = host.metadata?.machine;
  return typeof value === "string" && value.trim()
    ? value
    : t(language, "未知 hostname", "Unknown hostname");
}

function readAgentSummary(host: HostRecord, language: LanguageMode): string {
  const agents = host.metadata?.agentTypes ?? [];
  if (agents.length === 0) {
    const fallback = host.metadata?.agentName;
    return typeof fallback === "string" && fallback.trim()
      ? fallback
      : t(language, "未声明", "Not declared");
  }
  const labels = agents.map((agent) =>
    agent.label?.trim() || agent.id?.trim() || agent.command?.trim() || agent.type?.trim() || "Agent"
  );
  const [first, ...rest] = labels;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

function readWorkspaceSummary(host: HostRecord, language: LanguageMode): string {
  const roots = host.metadata?.workspaceRoots ?? [];
  if (roots.length === 0) return t(language, "未声明", "Not declared");
  const paths = roots.map((root) => typeof root === "string" ? root : root.path);
  const [first, ...rest] = paths;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

function readRuntimeSummary(host: HostRecord, language: LanguageMode): string {
  const value = host.metadata?.runtimeInstanceId;
  if (typeof value !== "string" || !value.trim()) return t(language, "未声明", "Not declared");
  return shortId(value);
}

function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
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

const summaryBarStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 10,
};

const summaryTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 13,
};

const hostListStyle = {
  ...common.panel,
  overflow: "hidden" as const,
};

const hostListCompactStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  overflow: "hidden" as const,
};

const hostHeaderStyle = {
  alignItems: "center" as const,
  backgroundColor: "#F5F1E8",
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 12,
  minHeight: 34,
  paddingHorizontal: 14,
};

const hostRowStyle = {
  alignItems: "center" as const,
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 12,
  minHeight: 66,
  paddingHorizontal: 14,
  paddingVertical: 9,
};

const hostMobileRowStyle = {
  borderBottomColor: colors.line,
  borderBottomWidth: 1,
  gap: 10,
  paddingHorizontal: 14,
  paddingVertical: 12,
};

const mobileSignalGridStyle = {
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

const signalLabelStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 10,
  lineHeight: 13,
  textTransform: "uppercase" as const,
};

const headerCellStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 11,
  textTransform: "uppercase" as const,
};

const hostNameStyle = {
  color: colors.ink,
  flexShrink: 1,
  fontFamily: typography.sansSemi,
  fontSize: 15,
  lineHeight: 19,
};

const statusDotStyle = {
  borderRadius: 999,
  height: 7,
  width: 7,
};

const statusTextStyle = {
  fontFamily: typography.sansSemi,
  fontSize: 11,
};

const primaryCellTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 12,
  lineHeight: 16,
  minWidth: 0,
};

const monoCellTextStyle = {
  color: colors.graphite,
  fontFamily: typography.mono,
  fontSize: 11,
  lineHeight: 15,
  minWidth: 0,
};

const secondaryMonoStyle = {
  color: colors.muted,
  fontFamily: typography.mono,
  fontSize: 11,
  lineHeight: 15,
};

const actionRailStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 6,
  justifyContent: "flex-end" as const,
  minWidth: 126,
};

const actionButtonStyle = {
  alignItems: "center" as const,
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 7,
  borderWidth: 1,
  flexDirection: "row" as const,
  gap: 6,
  minHeight: 30,
  paddingHorizontal: 8,
};

const actionButtonPrimaryStyle = {
  backgroundColor: colors.lime,
};

const actionButtonTextStyle = {
  fontFamily: typography.sansSemi,
  fontSize: 12,
};

const editPanelStyle = {
  alignItems: "center" as const,
  flexDirection: "row" as const,
  flexWrap: "wrap" as const,
  gap: 6,
  justifyContent: "flex-end" as const,
  minWidth: 280,
};

const editInputStyle = {
  borderColor: colors.ink,
  borderRadius: 7,
  borderWidth: 1,
  color: colors.ink,
  fontFamily: typography.sans,
  fontSize: 13,
  minHeight: 30,
  minWidth: 150,
  paddingHorizontal: 10,
};

const errorTextStyle = {
  color: colors.coral,
  fontFamily: typography.sans,
  fontSize: 12,
  lineHeight: 16,
};
