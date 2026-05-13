import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { startGitHubLogin } from "../../api/relay";
import type { LanguageMode } from "../../types";
import { common } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type LoginStartScreenProps = {
  language: LanguageMode;
  returnTo: string;
};

export function LoginStartScreen({ language, returnTo }: LoginStartScreenProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    startGitHubLogin(returnTo).then((authorizationUrl) => {
      if (!active || typeof window === "undefined") return;
      window.location.assign(authorizationUrl);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : t(language, "GitHub 登录失败。", "GitHub login failed."));
    });
    return () => {
      active = false;
    };
  }, [returnTo]);

  return (
    <View style={[common.page, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
      <View style={[common.panel, { maxWidth: 520, padding: 20, width: "100%" }]}>
        <Text style={common.title}>{t(language, "GitHub 登录", "GitHub sign in")}</Text>
        <Text style={[common.body, { marginTop: 10 }]}>
          {error ?? t(language, "正在创建 GitHub 授权请求。", "Creating the GitHub authorization request.")}
        </Text>
      </View>
    </View>
  );
}
