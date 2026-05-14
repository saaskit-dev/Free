import { GithubIcon, ShieldUserIcon } from "@hugeicons/core-free-icons";
import { useEffect, useState } from "react";
import { Pressable, Text, useWindowDimensions, View } from "react-native";

import { confirmLoginApproval, loadLoginApproval } from "../../api/relay";
import type { LanguageMode, LoadState, LoginApproval } from "../../types";
import { Icon } from "../../ui/Icon";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type LoginApprovalScreenProps = {
  approvalId: string;
  language: LanguageMode;
};

export function LoginApprovalScreen({ approvalId, language }: LoginApprovalScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 680;
  const [approval, setApproval] = useState<LoadState<LoginApproval>>({ status: "loading" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadLoginApproval(approvalId).then((result) => {
      if (!active) return;
      if (result.ok) {
        setApproval({ status: "ready", data: result.value });
        return;
      }
      setApproval({
        status: result.status === 401 ? "unauthorized" : "error",
        message: result.message,
      });
    });
    return () => {
      active = false;
    };
  }, [approvalId]);

  async function authorize() {
    if (submitting || approval.status !== "ready") return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await confirmLoginApproval(approval.data.approvalId);
      if (typeof window !== "undefined") {
        window.location.assign(result.callbackUrl);
      }
    } catch (error) {
      setSubmitting(false);
      setSubmitError(error instanceof Error ? error.message : t(language, "登录确认失败。", "Login confirmation failed."));
    }
  }

  return (
    <View style={[common.page, { padding: compact ? 16 : 32 }]}>
      <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginBottom: compact ? 20 : 42 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Icon icon={ShieldUserIcon} size={30} />
          <View>
            <Text style={{ color: colors.ink, fontFamily: typography.display, fontSize: 28 }}>
              Free
            </Text>
            <Text style={common.eyebrow}>{t(language, "设备授权", "Device authorization")}</Text>
          </View>
        </View>
      </View>

      <View style={[common.panel, { alignSelf: "center", maxWidth: 760, overflow: "hidden", width: "100%" }]}>
        <View style={{ backgroundColor: colors.lime, padding: compact ? 18 : 26 }}>
          <Text style={common.eyebrow}>{t(language, "需要确认", "Confirmation required")}</Text>
          <Text style={[common.title, { marginTop: 10 }]}>
            {t(language, "授权此工作台会话", "Authorize this Workbench session")}
          </Text>
        </View>

        <View style={{ padding: compact ? 18 : 26, gap: 18 }}>
          {approval.status === "loading" ? (
            <Text style={common.body}>
              {t(language, "正在读取登录授权。", "Reading login approval.")}
            </Text>
          ) : null}

          {approval.status === "error" || approval.status === "unauthorized" ? (
            <Text style={[common.body, { color: colors.coral }]}>{approval.message}</Text>
          ) : null}

          {approval.status === "ready" ? (
            <>
              <Text style={common.body}>
                {t(
                  language,
                  "确认 GitHub 登录后，Free 会为此浏览器创建账号会话。",
                  "Confirm the GitHub sign in before Free creates an account session for this browser.",
                )}
              </Text>
              <View style={{ gap: 10 }}>
                <Fact label={t(language, "GitHub 账号", "GitHub account")} value={approval.data.githubLogin} />
                <Fact label={t(language, "账号名称", "Account name")} value={approval.data.githubLogin} />
                <Fact label={t(language, "账号 ID", "Account ID")} mono value={approval.data.accountId} />
                <Fact
                  label={t(language, "设备", "Device")}
                  value={`${approval.data.principalType} ${approval.data.principalId}`}
                />
                <Fact label={t(language, "返回目标", "Return target")} value={summarizeUrl(approval.data.returnTo)} />
              </View>
              <View style={{ flexDirection: compact ? "column" : "row", gap: 12 }}>
                <Pressable
                  disabled={submitting}
                  onPress={() => void authorize()}
                  style={[common.panel, {
                    alignItems: "center",
                    backgroundColor: colors.ink,
                    flexDirection: "row",
                    gap: 10,
                    justifyContent: "center",
                    minHeight: 50,
                    minWidth: compact ? undefined : 230,
                    paddingHorizontal: 16,
                  }]}
                >
                  <Icon color={colors.paper} icon={GithubIcon} size={21} />
                  <Text style={{ color: colors.paper, fontFamily: typography.sansSemi, fontSize: 16 }}>
                    {submitting
                      ? t(language, "正在授权", "Authorizing")
                      : t(language, "授权此设备", "Authorize this device")}
                  </Text>
                </Pressable>
              </View>
              {submitError ? (
                <Text style={[common.body, { color: colors.coral }]}>{submitError}</Text>
              ) : null}
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function Fact({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <View style={{ borderColor: colors.line, borderTopWidth: 1, gap: 4, paddingTop: 10 }}>
      <Text style={common.eyebrow}>{label}</Text>
      <Text style={{ color: colors.ink, fontFamily: mono ? typography.mono : typography.sansSemi, fontSize: mono ? 13 : 16 }}>
        {value}
      </Text>
    </View>
  );
}

function summarizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}
