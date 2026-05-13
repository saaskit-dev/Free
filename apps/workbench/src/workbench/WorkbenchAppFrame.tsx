import {
  Logout03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Image, Linking, Pressable, ScrollView, Text, useColorScheme, useWindowDimensions, View } from "react-native";

import { createLogoutUrl } from "../api/relay";
import { AccessScreen } from "../features/access/AccessScreen";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import type { LanguageMode, RouteId, ThemeMode, WorkbenchPreferences } from "../types";
import { Icon } from "../ui/Icon";
import { colors, common, typography } from "../ui/theme";
import { routes } from "./routes";
import { useWorkbenchData } from "./useWorkbenchData";
import { t } from "./preferences";

type WorkbenchAppFrameProps = {
  preferences: WorkbenchPreferences;
  route: RouteId;
  setLanguage: (language: LanguageMode) => void;
  setRoute: (route: RouteId) => void;
  setTheme: (theme: ThemeMode) => void;
};

export function WorkbenchAppFrame({
  preferences,
  route,
  setLanguage,
  setRoute,
  setTheme,
}: WorkbenchAppFrameProps) {
  const data = useWorkbenchData();
  const { width } = useWindowDimensions();
  const systemScheme = useColorScheme();
  const compact = width < 820;
  const language = preferences.language;
  const dark = preferences.theme === "dark" ||
    (preferences.theme === "system" && systemScheme === "dark");
  const pageBackground = dark ? "#101014" : colors.paper;
  const railBackground = dark ? "#1A1921" : colors.paper;
  const foreground = dark ? colors.paper : colors.ink;
  const muted = dark ? "#A8A3B8" : colors.muted;

  return (
    <View style={[common.page, { backgroundColor: pageBackground }]}>
      <View style={{ flex: 1, flexDirection: compact ? "column" : "row" }}>
        <View
          style={{
            backgroundColor: railBackground,
            borderBottomWidth: compact ? 1 : 0,
            borderColor: foreground,
            borderRightWidth: compact ? 0 : 1,
            padding: compact ? 14 : 18,
            width: compact ? "100%" : 280,
          }}
        >
          <View style={{ alignItems: "center", flexDirection: "row", gap: 12, marginBottom: 22 }}>
            <Image source={require("../../assets/images/icon.png")} style={{ height: 42, width: 42 }} />
            <View>
              <Text style={{ color: foreground, fontFamily: typography.display, fontSize: 24 }}>
                Free
              </Text>
              <Text style={[common.eyebrow, { color: muted }]}>
                {t(language, "Bridge 工作台", "Bridge workbench")}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: compact ? "row" : "column", gap: 10 }}>
            {routes.map((item) => {
              const active = item.id === route;
              const label = routeLabel(item.id, language);
              const subtitle = routeSubtitle(item.id, language);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => setRoute(item.id)}
                  style={{
                    alignItems: "center",
                    backgroundColor: active ? colors.lime : dark ? "#24222D" : "#FFFFFF",
                    borderColor: colors.ink,
                    borderRadius: 8,
                    borderWidth: 1,
                    flex: compact ? 1 : undefined,
                    flexDirection: "row",
                    gap: 10,
                    minHeight: 52,
                    paddingHorizontal: 12,
                    paddingVertical: 10,
                  }}
                >
                  <Icon icon={item.icon} size={21} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: active || !dark ? colors.ink : colors.paper, fontFamily: typography.sansSemi, fontSize: 14 }}>
                      {label}
                    </Text>
                    {!compact ? (
                      <Text style={{ color: active ? colors.muted : muted, fontFamily: typography.sans, fontSize: 12 }}>
                        {subtitle}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        <ScrollView contentContainerStyle={{ padding: compact ? 16 : 28, paddingBottom: 40 }}>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between", marginBottom: 20 }}>
            <View style={{ flex: 1 }}>
              <Text style={[common.eyebrow, { color: muted }]}>
                {sessionStatusLabel(data.session.status, language)}
              </Text>
              <Text style={[common.title, { color: foreground, marginTop: 6 }]}>
                {t(language, "Session 工作台", "Session workbench")}
              </Text>
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Pressable
                accessibilityLabel={t(language, "刷新", "Refresh")}
                onPress={() => void data.refresh()}
                style={[common.panel, { alignItems: "center", height: 42, justifyContent: "center", width: 42 }]}
              >
                <Icon icon={RefreshIcon} size={19} />
              </Pressable>
              {data.session.status === "ready" ? (
                <Pressable
                  accessibilityLabel={t(language, "退出登录", "Sign out")}
                  onPress={() => void Linking.openURL(createLogoutUrl())}
                  style={[common.panel, { alignItems: "center", height: 42, justifyContent: "center", width: 42 }]}
                >
                  <Icon icon={Logout03Icon} size={19} />
                </Pressable>
              ) : null}
            </View>
          </View>

          {route === "access" ? <AccessScreen language={language} session={data.session} /> : null}
          {route === "hosts" ? (
            <HostsScreen hosts={data.hosts} language={language} onChanged={data.refresh} />
          ) : null}
          {route === "settings" ? (
            <SettingsScreen
              session={data.session}
              preferences={preferences}
              setLanguage={setLanguage}
              setTheme={setTheme}
            />
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

function sessionStatusLabel(
  status: ReturnType<typeof useWorkbenchData>["session"]["status"],
  language: LanguageMode,
): string {
  switch (status) {
    case "loading":
      return t(language, "正在检查账号会话", "Checking account session");
    case "ready":
      return t(language, "已登录 Bridge 工作区", "Authenticated bridge surface");
    case "unauthorized":
      return t(language, "未登录 Bridge 工作区", "Signed-out bridge surface");
    case "error":
      return t(language, "账号会话异常", "Account session issue");
  }
}

function routeLabel(route: RouteId, language: LanguageMode): string {
  switch (route) {
    case "access":
      return t(language, "访问", "Access");
    case "hosts":
      return t(language, "主机", "Hosts");
    case "settings":
      return t(language, "设置", "Settings");
  }
}

function routeSubtitle(route: RouteId, language: LanguageMode): string {
  switch (route) {
    case "access":
      return t(language, "账号会话", "Account session");
    case "hosts":
      return t(language, "Bridge 主机", "Bridge machines");
    case "settings":
      return t(language, "偏好与账号", "Preferences");
  }
}
