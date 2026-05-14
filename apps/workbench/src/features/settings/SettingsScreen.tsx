import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";

import type {
  AccountSession,
  LanguageMode,
  LoadState,
  ThemeMode,
  WorkbenchPreferences,
} from "../../types";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type SettingsCategory = "appearance" | "language" | "account" | "privacy";

type SettingsScreenProps = {
  preferences: WorkbenchPreferences;
  session: LoadState<AccountSession>;
  setLanguage: (language: LanguageMode) => void;
  setTheme: (theme: ThemeMode) => void;
};

export function SettingsScreen({
  preferences,
  session,
  setLanguage,
  setTheme,
}: SettingsScreenProps) {
  const language = preferences.language;
  const [category, setCategory] = useState<SettingsCategory>("appearance");
  const categories = settingsCategories(language);

  return (
    <View style={{ gap: 18 }}>
      <View>
        <Text style={common.eyebrow}>{t(language, "设置", "Settings")}</Text>
        <Text style={common.title}>{t(language, "工作台设置", "Workbench settings")}</Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {categories.map((item) => {
          const active = item.id === category;
          return (
            <Pressable
              key={item.id}
              onPress={() => setCategory(item.id)}
              style={{
                backgroundColor: active ? colors.lime : "#FFFFFF",
                borderColor: colors.ink,
                borderRadius: 8,
                borderWidth: 1,
                minHeight: 48,
                minWidth: 132,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 15 }}>
                {item.label}
              </Text>
              <Text style={{ color: colors.muted, fontFamily: typography.sans, fontSize: 12, marginTop: 2 }}>
                {item.subtitle}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {category === "appearance" ? (
        <SettingsPanel
          description={t(
            language,
            "跟随系统会自动匹配当前设备外观。",
            "System follows the current device appearance.",
          )}
          title={t(language, "外观", "Appearance")}
        >
          <Segmented
            current={preferences.theme}
            items={[
              { label: t(language, "跟随系统", "System"), value: "system" },
              { label: t(language, "白色", "Light"), value: "light" },
              { label: t(language, "黑色", "Dark"), value: "dark" },
            ]}
            onChange={setTheme}
          />
        </SettingsPanel>
      ) : null}

      {category === "language" ? (
        <SettingsPanel
          description={t(
            language,
            "切换后会立即应用到工作台界面。",
            "Changes apply to the workbench immediately.",
          )}
          title={t(language, "语言", "Language")}
        >
          <Segmented
            current={preferences.language}
            items={[
              { label: "中文", value: "zh" },
              { label: "English", value: "en" },
            ]}
            onChange={setLanguage}
          />
        </SettingsPanel>
      ) : null}

      {category === "account" ? (
        <SettingsPanel
          description={t(language, "当前登录账号和会话状态。", "Current account and session status.")}
          title={t(language, "账号", "Account")}
        >
          <AccountState language={language} session={session} />
        </SettingsPanel>
      ) : null}

      {category === "privacy" ? (
        <SettingsPanel
          description={t(
            language,
            "清除后会恢复默认主题和语言。",
            "Clearing restores the default theme and language.",
          )}
          title={t(language, "隐私与本机数据", "Privacy and local data")}
        >
          <Pressable
            onPress={clearLocalPreferences}
            style={{
              alignItems: "center",
              alignSelf: "flex-start",
              backgroundColor: "#FFFFFF",
              borderColor: colors.ink,
              borderRadius: 8,
              borderWidth: 1,
              minHeight: 42,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.ink, fontFamily: typography.sansSemi }}>
              {t(language, "清除本机偏好", "Clear local preferences")}
            </Text>
          </Pressable>
        </SettingsPanel>
      ) : null}
    </View>
  );
}

function settingsCategories(language: LanguageMode): readonly {
  id: SettingsCategory;
  label: string;
  subtitle: string;
}[] {
  return [
    {
      id: "appearance",
      label: t(language, "外观", "Appearance"),
      subtitle: t(language, "主题", "Theme"),
    },
    {
      id: "language",
      label: t(language, "语言", "Language"),
      subtitle: t(language, "中文 / English", "Chinese / English"),
    },
    {
      id: "account",
      label: t(language, "账号", "Account"),
      subtitle: t(language, "会话", "Session"),
    },
    {
      id: "privacy",
      label: t(language, "隐私", "Privacy"),
      subtitle: t(language, "本机数据", "Local data"),
    },
  ];
}

function SettingsPanel({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <View style={[common.panel, { padding: 18, gap: 16 }]}>
      <View>
        <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 20 }}>
          {title}
        </Text>
        <Text style={[common.body, { marginTop: 6 }]}>{description}</Text>
      </View>
      {children}
    </View>
  );
}

function Segmented<TValue extends string>({
  current,
  items,
  onChange,
}: {
  current: TValue;
  items: readonly { label: string; value: TValue }[];
  onChange: (value: TValue) => void;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {items.map((item) => {
        const active = item.value === current;
        return (
          <Pressable
            key={item.value}
            onPress={() => onChange(item.value)}
            style={{
              backgroundColor: active ? colors.lime : "#FFFFFF",
              borderColor: colors.ink,
              borderRadius: 8,
              borderWidth: 1,
              minHeight: 42,
              minWidth: 124,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, textAlign: "center" }}>
              {item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function AccountState({
  language,
  session,
}: {
  language: LanguageMode;
  session: LoadState<AccountSession>;
}) {
  if (session.status === "loading") {
    return <Text style={common.body}>{t(language, "正在读取账号会话。", "Reading account session.")}</Text>;
  }
  if (session.status === "unauthorized") {
    return <Text style={common.body}>{t(language, "当前未登录。", "Not signed in.")}</Text>;
  }
  if (session.status === "error") {
    return <Text style={[common.body, { color: colors.coral }]}>{session.message}</Text>;
  }
  return (
    <View style={{ gap: 10 }}>
      <Fact label={t(language, "账号名称", "Account name")} value={accountName(session.data)} />
      <Fact label={t(language, "账号 ID", "Account ID")} mono value={session.data.accountId} />
      <Fact label={t(language, "会话 ID", "Session ID")} mono value={session.data.sessionId} />
      <Fact
        label={t(language, "过期时间", "Expires")}
        value={new Date(session.data.expiresAt).toLocaleString()}
      />
    </View>
  );
}

function accountName(session: AccountSession): string {
  return session.account?.name || session.accountName || session.accountId;
}

function Fact({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={common.eyebrow}>{label}</Text>
      <Text style={{ color: colors.ink, fontFamily: mono ? typography.mono : typography.sansSemi, fontSize: mono ? 13 : 16 }}>
        {value}
      </Text>
    </View>
  );
}

function clearLocalPreferences(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("free.workbench.preferences");
  window.location.reload();
}
