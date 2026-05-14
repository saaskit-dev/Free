import {
  Logout03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Image, Linking, Pressable, ScrollView, Text, useColorScheme, useWindowDimensions, View } from "react-native";

import { createLogoutUrl } from "../api/relay";
import { AccessScreen } from "../features/access/AccessScreen";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SessionsScreen } from "../features/sessions/SessionsScreen";
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
          <View style={{ alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between", marginBottom: 22 }}>
            <View style={{ alignItems: "center", flexDirection: "row", flex: 1, gap: 12, minWidth: 0 }}>
              <Image source={require("../../assets/images/icon.png")} style={{ height: 42, width: 42 }} />
              <View style={{ minWidth: 0 }}>
                <Text style={{ color: foreground, fontFamily: typography.display, fontSize: 24 }}>
                  Free
                </Text>
                <Text numberOfLines={1} style={[common.eyebrow, { color: muted }]}>
                  {t(language, "Bridge 工作台", "Bridge workbench")}
                </Text>
              </View>
            </View>
            <HeaderActions
              canSignOut={data.session.status === "ready"}
              language={language}
              onRefresh={data.refresh}
            />
          </View>

          <View style={{ flexDirection: compact ? "row" : "column", gap: 10 }}>
            {routes.map((item) => {
              const active = item.id === route;
              const label = routeLabel(item.id, language);
              const subtitle = routeSubtitle(item.id, language);
              return (
                <Pressable
                  key={item.id}
                  onPress={() => {
                    setRoute(item.id);
                    pushRoutePath(item.id);
                  }}
                  style={{
                    alignItems: "center",
                    backgroundColor: active ? colors.lime : dark ? "#24222D" : "#FFFFFF",
                    borderColor: colors.ink,
                    borderRadius: 8,
                    borderWidth: 1,
                    flex: compact ? 1 : undefined,
                    flexDirection: compact ? "column" : "row",
                    gap: compact ? 5 : 10,
                    minHeight: 52,
                    paddingHorizontal: compact ? 6 : 12,
                    paddingVertical: 10,
                  }}
                >
                  <Icon icon={item.icon} size={21} />
                  <View style={{ alignItems: compact ? "center" : "flex-start", flex: compact ? undefined : 1, minWidth: 0 }}>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: active || !dark ? colors.ink : colors.paper,
                        fontFamily: typography.sansSemi,
                        fontSize: compact ? 12 : 14,
                        textAlign: "center",
                      }}
                    >
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
          <View style={{ marginBottom: 18 }}>
            <Text style={[common.title, { color: foreground }]}>
              {routeTitle(route, language)}
            </Text>
          </View>

          {route === "access" ? <AccessScreen language={language} session={data.session} /> : null}
          {route === "sessions" ? (
            <SessionsScreen
              hosts={data.hosts}
              language={language}
              sessions={data.sessions}
            />
          ) : null}
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

function HeaderActions({
  canSignOut,
  language,
  onRefresh,
}: {
  canSignOut: boolean;
  language: LanguageMode;
  onRefresh: () => Promise<void>;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Pressable
        accessibilityLabel={t(language, "刷新", "Refresh")}
        onPress={() => void onRefresh()}
        style={[common.panel, { alignItems: "center", height: 40, justifyContent: "center", width: 40 }]}
      >
        <Icon icon={RefreshIcon} size={18} />
      </Pressable>
      {canSignOut ? (
        <Pressable
          accessibilityLabel={t(language, "退出登录", "Sign out")}
          onPress={() => void Linking.openURL(createLogoutUrl())}
          style={[common.panel, { alignItems: "center", height: 40, justifyContent: "center", width: 40 }]}
        >
          <Icon icon={Logout03Icon} size={18} />
        </Pressable>
      ) : null}
    </View>
  );
}

function pushRoutePath(route: RouteId): void {
  if (typeof window === "undefined") return;
  const pathname =
    route === "sessions"
      ? "/sessions"
      : route === "hosts"
        ? "/hosts"
        : route === "settings"
          ? "/settings"
          : "/access";
  if (window.location.pathname === pathname) return;
  window.history.pushState({}, "", `${pathname}${window.location.search}`);
}

function routeLabel(route: RouteId, language: LanguageMode): string {
  switch (route) {
    case "access":
      return t(language, "访问", "Access");
    case "sessions":
      return t(language, "Session", "Sessions");
    case "hosts":
      return t(language, "主机", "Hosts");
    case "settings":
      return t(language, "设置", "Settings");
  }
}

function routeTitle(route: RouteId, language: LanguageMode): string {
  switch (route) {
    case "access":
      return t(language, "访问", "Access");
    case "sessions":
      return t(language, "Session 管理", "Session management");
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
    case "sessions":
      return t(language, "会话管理", "Session management");
    case "hosts":
      return t(language, "Bridge 主机", "Bridge machines");
    case "settings":
      return t(language, "偏好与账号", "Preferences");
  }
}
