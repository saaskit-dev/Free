import { GithubIcon, Login03Icon } from "@hugeicons/core-free-icons";
import { Pressable, Text, View } from "react-native";

import { createLoginUrl, currentWorkbenchUrl } from "../../api/relay";
import type { AccountSession, LanguageMode, LoadState } from "../../types";
import { Icon } from "../../ui/Icon";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type AccessScreenProps = {
  language: LanguageMode;
  session: LoadState<AccountSession>;
};

export function AccessScreen({ language, session }: AccessScreenProps) {
  if (session.status === "loading") {
    return (
      <StatePanel
        body={t(language, "正在检查当前浏览器的登录状态。", "Checking the sign-in state for this browser.")}
        title={t(language, "正在检查账号会话", "Checking account session")}
      />
    );
  }

  if (session.status === "unauthorized") {
    return (
      <View style={{ gap: 14 }}>
        <StatePanel
          title={t(language, "需要登录", "Sign in required")}
          body={t(
            language,
            "登录后可以管理主机、Session 和授权请求。",
            "Sign in to manage hosts, sessions, and authorization requests.",
          )}
        />
        <Pressable
          onPress={() => navigateToLogin(createLoginUrl(currentWorkbenchUrl()))}
          style={[common.panel, { alignItems: "center", backgroundColor: colors.lime, flexDirection: "row", gap: 12, padding: 16 }]}
        >
          <Icon icon={GithubIcon} size={22} />
          <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 16 }}>
            {t(language, "使用 GitHub 登录", "Sign in with GitHub")}
          </Text>
          <Icon icon={Login03Icon} size={20} />
        </Pressable>
      </View>
    );
  }

  if (session.status === "error") {
    return (
      <StatePanel
        title={t(language, "会话不可用", "Session unavailable")}
        body={session.message}
        tone="error"
      />
    );
  }

  return (
    <View style={{ gap: 14 }}>
      <View style={[common.panel, { padding: 18 }]}>
        <Text style={common.eyebrow}>{t(language, "账号", "Account")}</Text>
        <Text style={{ color: colors.ink, fontFamily: typography.display, fontSize: 30, marginTop: 10 }}>
          {accountName(session.data)}
        </Text>
        <Text style={{ color: colors.muted, fontFamily: typography.mono, fontSize: 12, marginTop: 8 }}>
          {session.data.accountId}
        </Text>
        <Text style={[common.body, { marginTop: 10 }]}>
          {t(language, "过期时间", "Expires at")} {new Date(session.data.expiresAt).toLocaleString()}.
        </Text>
      </View>
      <View style={[common.panel, { padding: 18 }]}>
        <Text style={common.eyebrow}>{t(language, "会话 ID", "Session id")}</Text>
        <Text style={{ color: colors.graphite, fontFamily: typography.mono, fontSize: 13, marginTop: 10 }}>
          {session.data.sessionId}
        </Text>
      </View>
    </View>
  );
}

function accountName(session: AccountSession): string {
  return session.account?.name || session.accountName || session.accountId;
}

function navigateToLogin(url: string): void {
  if (typeof window !== "undefined") {
    window.location.assign(url);
    return;
  }
}

function StatePanel({
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
