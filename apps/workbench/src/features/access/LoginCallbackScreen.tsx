import { useEffect, useState } from "react";
import { Text, View } from "react-native";

import { completeGitHubLogin } from "../../api/relay";
import type { LanguageMode } from "../../types";
import { common } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type LoginCallbackScreenProps = {
  code: string;
  language: LanguageMode;
  state: string;
};

export function LoginCallbackScreen({ code, language, state }: LoginCallbackScreenProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    completeGitHubLogin({ code, state }).then((approvalUrl) => {
      if (!active || typeof window === "undefined") return;
      window.location.assign(approvalUrl);
    }).catch((reason) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : t(language, "GitHub 回调失败。", "GitHub callback failed."));
    });
    return () => {
      active = false;
    };
  }, [code, state]);

  return (
    <View style={[common.page, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
      <View style={[common.panel, { maxWidth: 520, padding: 20, width: "100%" }]}>
        <Text style={common.title}>{t(language, "GitHub 回调", "GitHub callback")}</Text>
        <Text style={[common.body, { marginTop: 10 }]}>
          {error ?? t(language, "正在完成 GitHub 登录。", "Completing GitHub sign in.")}
        </Text>
      </View>
    </View>
  );
}
