import {
  Logout03Icon,
  RefreshIcon,
  SidebarLeft01Icon,
} from "@hugeicons/core-free-icons";
import { useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, ScrollView, Text, useColorScheme, useWindowDimensions, View } from "react-native";

import { createLogoutUrl } from "../api/relay";
import { AccessScreen } from "../features/access/AccessScreen";
import { HostsScreen } from "../features/hosts/HostsScreen";
import { SessionsScreen } from "../features/sessions/SessionsScreen";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import type { LanguageMode, RouteId, SidebarState, ThemeMode, WorkbenchPreferences } from "../types";
import { Icon } from "../ui/Icon";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { minimumLoadingDelay } from "../ui/loading";
import { colors, common, typography } from "../ui/theme";
import { routes } from "./routes";
import { useWorkbenchData } from "./useWorkbenchData";
import { t } from "./preferences";

type WorkbenchAppFrameProps = {
  preferences: WorkbenchPreferences;
  route: RouteId;
  setLanguage: (language: LanguageMode) => void;
  setRoute: (route: RouteId) => void;
  setSidebar: (sidebar: SidebarState) => void;
  setTheme: (theme: ThemeMode) => void;
};

export function WorkbenchAppFrame({
  preferences,
  route,
  setLanguage,
  setRoute,
  setSidebar,
  setTheme,
}: WorkbenchAppFrameProps) {
  const data = useWorkbenchData();
  const { width } = useWindowDimensions();
  const systemScheme = useColorScheme();
  const compact = width < 820;
  const sidebarCollapsed = !compact && preferences.sidebar === "collapsed";
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
            overflow: "hidden",
            width: compact ? "100%" : sidebarCollapsed ? 60 : 280,
          }}
        >
          <View style={{ padding: compact ? 14 : sidebarCollapsed ? 10 : 18 }}>
            <View
              style={{
                alignItems: "center",
                flexDirection: "row",
                gap: 12,
                justifyContent: "space-between",
                marginBottom: compact ? 22 : sidebarCollapsed ? 0 : 22,
              }}
            >
              {!sidebarCollapsed ? (
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
              ) : null}
              <View style={{ flexDirection: "row", flexShrink: 0, gap: 8 }}>
                {!compact ? (
                  <Pressable
                    accessibilityLabel={t(language, sidebarCollapsed ? "展开侧栏" : "收起侧栏", sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar")}
                    onPress={() => setSidebar(sidebarCollapsed ? "expanded" : "collapsed")}
                    style={[
                      sidebarCollapsed ? collapsedRailButtonStyle : common.panel,
                      { alignItems: "center", height: 40, justifyContent: "center", width: 40 },
                    ]}
                  >
                    <Icon icon={SidebarLeft01Icon} size={18} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>

          <View style={{ flexDirection: compact ? "row" : "column", gap: sidebarCollapsed ? 8 : 10, paddingBottom: compact ? 14 : sidebarCollapsed ? 10 : 18, paddingHorizontal: compact ? 14 : sidebarCollapsed ? 10 : 18 }}>
            {routes.map((item) => {
              const active = item.id === route;
              const label = routeLabel(item.id, language);
              const subtitle = routeSubtitle(item.id, language);
              return (
                <Pressable
                  accessibilityLabel={label}
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
                    flexDirection: compact ? "column" : sidebarCollapsed ? "column" : "row",
                    gap: compact ? 5 : sidebarCollapsed ? 0 : 10,
                    height: sidebarCollapsed ? 40 : undefined,
                    justifyContent: "center",
                    minHeight: sidebarCollapsed ? 40 : 52,
                    paddingHorizontal: compact ? 6 : sidebarCollapsed ? 0 : 12,
                    paddingVertical: sidebarCollapsed ? 0 : 10,
                    width: sidebarCollapsed ? 40 : undefined,
                  }}
                >
                  <Icon icon={item.icon} size={21} />
                  {!sidebarCollapsed ? (
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
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>

        <ScrollView contentContainerStyle={{ padding: compact ? 16 : 28, paddingBottom: 40 }}>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 16, justifyContent: "space-between", marginBottom: 18 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={[common.title, { color: foreground }]}>
                {routeTitle(route, language)}
              </Text>
            </View>
            <View style={{ flexShrink: 0 }}>
              <HeaderActions
                canSignOut={data.session.status === "ready"}
                language={language}
                onRefresh={data.refresh}
              />
            </View>
          </View>

          {route === "access" ? <AccessScreen language={language} session={data.session} /> : null}
          {route === "sessions" ? (
            <SessionsScreen
              hosts={data.hosts}
              language={language}
              onChanged={data.refreshSessions}
              onSessionClosed={data.markSessionClosed}
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
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const runRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.all([onRefresh(), minimumLoadingDelay()]).finally(() => {
      setRefreshing(false);
    });
  };

  const runSignOut = () => {
    if (signingOut) return;
    setSigningOut(true);
    void Promise.all([Linking.openURL(createLogoutUrl()), minimumLoadingDelay()]).finally(() => {
      setSigningOut(false);
    });
  };

  return (
    <>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Pressable
          accessibilityLabel={refreshing ? t(language, "刷新中", "Refreshing") : t(language, "刷新", "Refresh")}
          disabled={refreshing}
          onPress={runRefresh}
          style={[common.panel, headerIconButtonStyle, refreshing ? disabledIconButtonStyle : null]}
        >
          {refreshing ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Icon icon={RefreshIcon} size={18} />
          )}
        </Pressable>
        {canSignOut ? (
          <Pressable
            accessibilityLabel={t(language, "退出登录", "Sign out")}
            onPress={() => setConfirmSignOut(true)}
            style={[common.panel, headerIconButtonStyle]}
          >
            <Icon icon={Logout03Icon} size={18} />
          </Pressable>
        ) : null}
      </View>
      <ConfirmDialog
        cancelDisabled={signingOut}
        confirmLabel={signingOut ? t(language, "退出中", "Signing out") : t(language, "退出登录", "Sign out")}
        confirmLoading={signingOut}
        description={t(language, "退出后需要重新登录才能继续使用工作台。", "You will need to sign in again to continue using the workbench.")}
        language={language}
        onCancel={() => {
          if (!signingOut) setConfirmSignOut(false);
        }}
        onConfirm={runSignOut}
        tone="danger"
        title={t(language, "确认退出登录", "Confirm sign out")}
        visible={confirmSignOut}
      />
    </>
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

const collapsedRailButtonStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
};

const headerIconButtonStyle = {
  alignItems: "center" as const,
  height: 40,
  justifyContent: "center" as const,
  width: 40,
};

const disabledIconButtonStyle = {
  opacity: 0.65,
};
