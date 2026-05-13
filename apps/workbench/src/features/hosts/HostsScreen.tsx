import { CheckmarkCircle02Icon, Edit02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { updateHostName } from "../../api/relay";
import type { HostRecord, LanguageMode, LoadState } from "../../types";
import { Icon } from "../../ui/Icon";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type HostsScreenProps = {
  hosts: LoadState<HostRecord[]>;
  language: LanguageMode;
  onChanged: () => Promise<void>;
};

export function HostsScreen({ hosts, language, onChanged }: HostsScreenProps) {
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
        body={t(language, "当前账号还没有可管理的主机。", "This account has no manageable hosts yet.")}
      />
    );
  }

  return (
    <View style={{ gap: 12 }}>
      {hosts.data.map((host) => (
        <HostCard key={host.hostId} host={host} language={language} onChanged={onChanged} />
      ))}
    </View>
  );
}

function HostCard({
  host,
  language,
  onChanged,
}: {
  host: HostRecord;
  language: LanguageMode;
  onChanged: () => Promise<void>;
}) {
  const savedName = readDisplayName(host);
  const hostname = readHostname(host, language);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(savedName);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

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

  return (
    <View style={[common.panel, { padding: 18 }]}>
      <View style={{ alignItems: "flex-start", flexDirection: "row", gap: 12, justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
          <Text style={common.eyebrow}>{t(language, "主机名称", "Host name")}</Text>
          <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 22, lineHeight: 26 }}>
            {savedName || hostname}
          </Text>
        </View>
        <Text style={[common.eyebrow, { color: host.online ? colors.green : colors.coral, paddingTop: 4 }]}>
          {host.online ? t(language, "在线", "online") : t(language, "离线", "offline")}
        </Text>
      </View>

      <View style={{ gap: 10, marginTop: 16 }}>
        <Field label={t(language, "Hostname", "Hostname")} value={hostname} />
        <Field label={t(language, "Host ID", "Host ID")} mono value={host.hostId} />
        {host.metadata?.runtimeInstanceId ? (
          <Field label={t(language, "运行实例", "Runtime instance")} mono value={host.metadata.runtimeInstanceId} />
        ) : null}
      </View>

      {editing ? (
        <View style={{ gap: 10, marginTop: 16 }}>
          <TextInput
            accessibilityLabel={t(language, "主机名称", "Host name")}
            autoCapitalize="none"
            onChangeText={setDraft}
            placeholder={hostname}
            placeholderTextColor={colors.muted}
            style={{
              borderColor: colors.ink,
              borderRadius: 8,
              borderWidth: 1,
              color: colors.ink,
              fontFamily: typography.sans,
              fontSize: 16,
              minHeight: 44,
              paddingHorizontal: 12,
            }}
            value={draft}
          />
          {error ? <Text style={{ color: colors.coral, fontFamily: typography.sans, fontSize: 13 }}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
            <Pressable
              disabled={saving}
              onPress={() => void save()}
              style={[buttonStyle(true), saving ? { opacity: 0.6 } : null]}
            >
              <Icon color={colors.ink} icon={CheckmarkCircle02Icon} size={18} />
              <Text style={buttonTextStyle}>{saving ? t(language, "保存中", "Saving") : t(language, "保存", "Save")}</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => {
                setDraft(savedName);
                setEditing(false);
                setError(undefined);
              }}
              style={buttonStyle(false)}
            >
              <Text style={buttonTextStyle}>{t(language, "取消", "Cancel")}</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setEditing(true)} style={[buttonStyle(false), { marginTop: 16, alignSelf: "flex-start" }]}>
          <Icon color={colors.ink} icon={Edit02Icon} size={18} />
          <Text style={buttonTextStyle}>{t(language, "设置名称", "Set name")}</Text>
        </Pressable>
      )}
    </View>
  );
}

function Field({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <View style={{ gap: 3 }}>
      <Text style={common.eyebrow}>{label}</Text>
      <Text style={{ color: colors.graphite, fontFamily: mono ? typography.mono : typography.sans, fontSize: 14 }}>
        {value}
      </Text>
    </View>
  );
}

function readDisplayName(host: HostRecord): string {
  const value = host.metadata?.displayName;
  return typeof value === "string" ? value : "";
}

function readHostname(host: HostRecord, language: LanguageMode): string {
  const value = host.metadata?.machine;
  return typeof value === "string" && value.trim()
    ? value
    : t(language, "未知 hostname", "Unknown hostname");
}

function buttonStyle(primary: boolean) {
  return {
    alignItems: "center" as const,
    backgroundColor: primary ? colors.lime : "#FFFFFF",
    borderColor: colors.ink,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row" as const,
    gap: 8,
    minHeight: 42,
    paddingHorizontal: 14,
  };
}

const buttonTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 14,
};

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
