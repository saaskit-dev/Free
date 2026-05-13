import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { useState } from "react";
import { Text, View } from "react-native";

import { WorkbenchAppFrame } from "./workbench/WorkbenchAppFrame";
import { LoginCallbackScreen } from "./features/access/LoginCallbackScreen";
import { LoginApprovalScreen } from "./features/access/LoginApprovalScreen";
import { LoginStartScreen } from "./features/access/LoginStartScreen";
import type { RouteId } from "./types";
import { t, useWorkbenchPreferences } from "./workbench/preferences";
import { colors, typography } from "./ui/theme";

export default function App() {
  const [route, setRoute] = useState<RouteId>("access");
  const { preferences, setLanguage, setTheme } = useWorkbenchPreferences();
  const [fontsLoaded] = useFonts({
    BricolageGrotesqueBold: require("../assets/fonts/BricolageGrotesque-Bold.ttf"),
    IBMPlexMono: require("../assets/fonts/IBMPlexMono-Regular.ttf"),
    IBMPlexSans: require("../assets/fonts/IBMPlexSans-Regular.ttf"),
    IBMPlexSansSemiBold: require("../assets/fonts/IBMPlexSans-SemiBold.ttf"),
  });

  if (!fontsLoaded) {
    return (
      <View style={{ alignItems: "center", backgroundColor: colors.paper, flex: 1, justifyContent: "center" }}>
        <Text style={{ color: colors.ink, fontFamily: typography.sans, fontSize: 15 }}>
          {t(preferences.language, "正在加载 Free Workbench", "Loading Free Workbench")}
        </Text>
      </View>
    );
  }

  const approvalId = readLoginApprovalIdFromLocation();
  if (approvalId) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginApprovalScreen approvalId={approvalId} language={preferences.language} />
      </>
    );
  }

  const loginStartReturnTo = readLoginStartReturnToFromLocation();
  if (loginStartReturnTo) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginStartScreen language={preferences.language} returnTo={loginStartReturnTo} />
      </>
    );
  }

  const callback = readLoginCallbackFromLocation();
  if (callback) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginCallbackScreen
          code={callback.code}
          language={preferences.language}
          state={callback.state}
        />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      <WorkbenchAppFrame
        preferences={preferences}
        route={route}
        setLanguage={setLanguage}
        setRoute={setRoute}
        setTheme={setTheme}
      />
    </>
  );
}

function readLoginApprovalIdFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.location.pathname !== "/login/approve") return undefined;
  const value = new URLSearchParams(window.location.search).get("approvalId");
  return value && value.trim() ? value : undefined;
}

function readLoginStartReturnToFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.location.pathname !== "/login/start") return undefined;
  return normalizeWorkbenchReturnTo(
    new URLSearchParams(window.location.search).get("returnTo"),
  );
}

function readLoginCallbackFromLocation(): { code: string; state: string } | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.location.pathname !== "/login/callback") return undefined;
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return undefined;
  return { code, state };
}

function normalizeWorkbenchReturnTo(value: string | null): string {
  if (!value) return defaultWorkbenchReturnTo();
  try {
    const url = new URL(value);
    if (url.hostname === "localhost" && url.port === "8790") {
      url.hostname = "127.0.0.1";
    }
    return url.toString();
  } catch {
    return defaultWorkbenchReturnTo();
  }
}

function defaultWorkbenchReturnTo(): string {
  if (typeof window === "undefined") return "http://127.0.0.1:8790/";
  const url = new URL("/", window.location.origin);
  if (url.hostname === "localhost" && url.port === "8790") {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}
