import {
  ArrowLeft01Icon,
  CheckmarkCircle02Icon,
  Clock02Icon,
  Folder02Icon,
  Home01Icon,
} from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, TextInput, useWindowDimensions, View } from "react-native";

import { authorizeSession, loadAuthorizationSession, loadHostWorkspaceDirectory } from "../../api/relay";
import type {
  AuthorizationAgent,
  AuthorizationHost,
  AuthorizationSession,
  AuthorizationWorkspaceRoot,
  LanguageMode,
  LoadState,
} from "../../types";
import { Icon } from "../../ui/Icon";
import { colors, common, typography } from "../../ui/theme";
import { t } from "../../workbench/preferences";

type AuthorizationScreenProps = {
  connectionId: string;
  language: LanguageMode;
  sessionSelectionId?: string;
};

type WorkspaceDirectoryState =
  | { status: "idle" }
  | { status: "loading" }
  | { entries: WorkspaceDirectoryEntry[]; path: string; status: "ready" }
  | { message: string; status: "error" };

type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: "directory";
};

const RECENT_WORKSPACES_STORAGE_KEY = "free.workbench.authorization.recentWorkspaces";
const AUTHORIZED_CLOSE_DELAY_SECONDS = 5;

export function AuthorizationScreen({
  connectionId,
  language,
  sessionSelectionId,
}: AuthorizationScreenProps) {
  const { width } = useWindowDimensions();
  const compact = width < 920;
  const narrow = width < 560;
  const [authorization, setAuthorization] = useState<LoadState<AuthorizationSession>>({ status: "loading" });
  const [selectedHostId, setSelectedHostId] = useState("");
  const [selectedAgentKey, setSelectedAgentKey] = useState("");
  const [selectedRoot, setSelectedRoot] = useState("");
  const [selectedWorkspace, setSelectedWorkspace] = useState("");
  const [agentQuery, setAgentQuery] = useState("");
  const [recentWorkspaces, setRecentWorkspaces] = useState<string[]>([]);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<WorkspaceDirectoryState>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<"authorized" | string>("");
  const [closeCountdown, setCloseCountdown] = useState(AUTHORIZED_CLOSE_DELAY_SECONDS);
  const [manualUnavailableReason, setManualUnavailableReason] = useState<string | undefined>();

  const refreshAuthorization = useMemo(
    () => async (options: { loading?: boolean } = {}) => {
      if (options.loading) {
        setAuthorization({ status: "loading" });
      }
      const state = await loadAuthorizationSession({ connectionId, sessionSelectionId });
      if (state.ok) {
        setAuthorization({ data: state.value, status: "ready" });
        setManualUnavailableReason(undefined);
        return state.value;
      }
      if (state.status === 401) {
        setAuthorization({ message: state.message, status: "unauthorized" });
      } else {
        setAuthorization({ message: state.message, status: "error" });
      }
      return undefined;
    },
    [connectionId, sessionSelectionId],
  );

  useEffect(() => {
    let active = true;
    setAuthorization({ status: "loading" });
    refreshAuthorization().then((value) => {
      if (!active || !value) return;
      selectDefaultHost(value);
    });
    return () => {
      active = false;
    };
  }, [refreshAuthorization]);

  useEffect(() => {
    setRecentWorkspaces(readRecentWorkspaces());
  }, []);

  const authorizationUnavailableReason =
    authorization.status === "ready" ? authorization.data.unavailableReason : undefined;

  useEffect(() => {
    if (authorization.status !== "ready") return;
    if (authorizationUnavailableReason) return;
    const timer = setInterval(() => {
      void refreshAuthorization();
    }, 3000);
    return () => clearInterval(timer);
  }, [authorization.status, authorizationUnavailableReason, refreshAuthorization]);

  const selectedHost = useMemo(() => {
    if (authorization.status !== "ready") return undefined;
    return authorization.data.hosts.find((host) => host.hostId === selectedHostId);
  }, [authorization, selectedHostId]);
  const agents = selectedHost?.metadata?.agentTypes ?? [];
  const filteredAgents = filterAgents(agents, agentQuery);
  const workspaceRoots = normalizeWorkspaceRoots(selectedHost?.metadata?.workspaceRoots ?? []);
  const visibleRecentWorkspaces = recentWorkspaces.filter((path) =>
    workspaceRoots.some((root) => isPathWithinRoot(path, root.path)),
  );
  const unavailableReason =
    authorization.status === "ready"
      ? manualUnavailableReason ?? authorization.data.unavailableReason
      : undefined;
  const requestUnavailable = unavailableReason !== undefined;

  useEffect(() => {
    const hostId = selectedHost?.hostId;
    if (!hostId) {
      setWorkspaceDirectory({ status: "idle" });
      return;
    }
    if (!selectedRoot || requestUnavailable) {
      setWorkspaceDirectory({ status: "idle" });
      return;
    }
    let active = true;
    setWorkspaceDirectory({ status: "loading" });
    loadHostWorkspaceDirectory({
      connectionId,
      hostId,
      path: selectedWorkspace || selectedRoot,
      root: selectedRoot,
    }).then((state) => {
      if (!active) return;
      if (state.ok) {
        setWorkspaceDirectory({
          entries: state.value.entries,
          path: state.value.path,
          status: "ready",
        });
      } else {
        setWorkspaceDirectory({
          message: authorizationMessage(state.message, language) ?? state.message,
          status: "error",
        });
      }
    });
    return () => {
      active = false;
    };
  }, [connectionId, language, requestUnavailable, selectedHost?.hostId, selectedRoot, selectedWorkspace]);

  useEffect(() => {
    if (result !== "authorized") {
      setCloseCountdown(AUTHORIZED_CLOSE_DELAY_SECONDS);
      return;
    }
    let seconds = AUTHORIZED_CLOSE_DELAY_SECONDS;
    setCloseCountdown(seconds);
    const interval = setInterval(() => {
      seconds -= 1;
      setCloseCountdown(Math.max(0, seconds));
      if (seconds <= 0) {
        clearInterval(interval);
        closeAuthorizationWindow();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [result]);

  function selectDefaultHost(value: AuthorizationSession) {
    const firstOnline = value.hosts.find((host) => host.online !== false);
    if (!firstOnline) return;
    setSelectedHostId(firstOnline.hostId);
    setSelectedAgentKey(defaultAgentKey(firstOnline));
    const root = normalizeWorkspaceRoots(firstOnline.metadata?.workspaceRoots ?? [])[0]?.path ?? "";
    setSelectedRoot(root);
    setSelectedWorkspace(root);
  }

  function selectHost(host: AuthorizationHost) {
    setSelectedHostId(host.hostId);
    setSelectedAgentKey(defaultAgentKey(host));
    setAgentQuery("");
    const root = normalizeWorkspaceRoots(host.metadata?.workspaceRoots ?? [])[0]?.path ?? "";
    setSelectedRoot(root);
    setSelectedWorkspace(root);
    setResult("");
  }

  function selectWorkspace(path: string) {
    setSelectedWorkspace(path);
    setResult("");
  }

  function selectRecentWorkspace(path: string) {
    const root = workspaceRoots.find((candidate) => isPathWithinRoot(path, candidate.path));
    if (!root) return;
    setSelectedRoot(root.path);
    setSelectedWorkspace(path);
    setResult("");
  }

  if (authorization.status === "loading") {
    return <CenteredPanel title={t(language, "正在读取授权请求", "Loading authorization request")} />;
  }
  if (authorization.status === "unauthorized") {
    return (
      <CenteredPanel
        title={t(language, "需要登录", "Sign in required")}
        body={authorizationMessage(authorization.message, language)}
      />
    );
  }
  if (authorization.status === "error") {
    return (
      <CenteredPanel
        title={t(language, "授权请求不可用", "Authorization unavailable")}
        body={authorizationMessage(authorization.message, language)}
      />
    );
  }
  if (authorization.data.unavailableReason && authorization.data.hosts.length === 0) {
    return (
      <CenteredPanel
        title={t(language, "授权请求已过期", "Authorization request expired")}
        body={authorizationMessage(authorization.data.unavailableReason, language)}
      />
    );
  }

  const submit = async () => {
    if (!selectedHost || requestUnavailable) return;
    setSubmitting(true);
    setResult("");
    const agent = parseAgentKey(selectedAgentKey);
    const response = await authorizeSession({
      agentCommand: agent?.command,
      agentId: agent?.id,
      agentType: agent?.type,
      connectionId,
      hostId: selectedHost.hostId,
      sessionSelectionId,
      workspaceRoots: selectedWorkspace ? [selectedWorkspace] : undefined,
    });
    setSubmitting(false);
    if (!response.ok) {
      const nextMessage = authorizationMessage(response.message, language) ?? response.message;
      setResult(nextMessage);
      if (isExpiredAuthorizationMessage(response.message)) {
        setManualUnavailableReason(response.message);
        void refreshAuthorization();
      }
      return;
    }
    if (selectedWorkspace) {
      setRecentWorkspaces(storeRecentWorkspace(selectedWorkspace));
    }
    setResult("authorized");
  };

  if (result === "authorized") {
    return (
      <AuthorizedCompletion
        countdown={closeCountdown}
        language={language}
        onClose={closeAuthorizationWindow}
        onHome={goHome}
      />
    );
  }

  const content = (
    <View
      style={{
        flex: compact ? undefined : 1,
        gap: compact ? 8 : 12,
        marginHorizontal: "auto",
        maxWidth: 1280,
        minHeight: compact ? undefined : 0,
        width: "100%",
      }}
    >
      <View style={{ alignItems: "flex-start", flexDirection: compact ? "column" : "row", gap: compact ? 6 : 10, justifyContent: "space-between" }}>
        <View style={{ flex: 1 }}>
          <Text style={common.eyebrow}>{t(language, "远程会话授权", "Remote session authorization")}</Text>
          <Text style={[common.title, { fontSize: compact ? 24 : 30, lineHeight: compact ? 27 : 32, marginTop: 2 }]}>
            {t(language, "选择运行环境", "Choose runtime")}
          </Text>
          <Text style={[common.body, { fontSize: compact ? 13 : 14, lineHeight: compact ? 18 : 19, marginTop: 3 }]} numberOfLines={compact ? 2 : 1}>
            {t(
              language,
              "授权绑定主机、Agent 和工作目录。过期请求需要回到 ACP 客户端重新发起。",
              "Authorization binds host, agent, and workspace. Expired requests must be started again from the ACP client.",
            )}
          </Text>
        </View>
        <StatusPill
          tone={requestUnavailable ? "error" : "success"}
          text={requestUnavailable
            ? t(language, "请求已过期", "Request expired")
            : t(language, "等待授权", "Waiting authorization")}
        />
      </View>

      {unavailableReason ? (
        <Notice tone="error">
          <Text style={noticeTitleStyle}>{t(language, "这次授权已不可继续", "This authorization cannot continue")}</Text>
          <Text style={[common.body, { color: colors.coral, fontSize: 13, lineHeight: 18, marginTop: 3 }]}>
            {authorizationMessage(unavailableReason, language)}
          </Text>
        </Notice>
      ) : null}

      <View style={{ flex: compact ? undefined : 1, flexDirection: compact ? "column" : "row", gap: 12, minHeight: 0 }}>
        <PickerPanel
          compact={compact}
          maxHeight={compact ? 190 : undefined}
          title={t(language, "主机", "Host")}
          toolbar={selectedHost ? (
            <Text style={panelMetaStyle}>
              {hostMeta(selectedHost, language)}
            </Text>
          ) : null}
        >
          {authorization.data.hosts.map((host) => (
            <Choice
              active={host.hostId === selectedHostId}
              disabled={host.online === false}
              key={host.hostId}
              meta={hostMeta(host, language)}
              title={hostTitle(host)}
              onPress={() => selectHost(host)}
            />
          ))}
        </PickerPanel>

        <PickerPanel
          compact={compact}
          maxHeight={compact ? 250 : undefined}
          title={t(language, "Agent", "Agent")}
          toolbar={(
            <TextInput
              accessibilityLabel={t(language, "搜索 Agent", "Search agents")}
              onChangeText={setAgentQuery}
              placeholder={t(language, "搜索 Agent", "Search agents")}
              placeholderTextColor={colors.muted}
              style={searchInputStyle}
              value={agentQuery}
            />
          )}
        >
          {agents.length === 0 ? (
            <Choice
              active={!selectedAgentKey}
              title={t(language, "默认 Host Agent", "Default host agent")}
              onPress={() => setSelectedAgentKey("")}
            />
          ) : filteredAgents.map((agent) => {
            const key = agentKey(agent);
            return (
              <Choice
                active={selectedAgentKey === key}
                key={key}
                meta={agent.id || agent.command || ""}
                title={agent.label || agent.id || agent.command || "Agent"}
                onPress={() => {
                  setSelectedAgentKey(key);
                  setResult("");
                }}
              />
            );
          })}
          {agents.length > 0 && filteredAgents.length === 0 ? (
            <EmptyText>{t(language, "没有匹配的 Agent", "No matching agents")}</EmptyText>
          ) : null}
        </PickerPanel>

        <PickerPanel
          compact={compact}
          title={t(language, "工作目录", "Workspace")}
        >
          <WorkspaceBrowser
            compact={compact}
            directory={workspaceDirectory}
            language={language}
            recentWorkspaces={visibleRecentWorkspaces}
            roots={workspaceRoots}
            selectedRoot={selectedRoot}
            selectedWorkspace={selectedWorkspace}
            onAny={() => {
              setSelectedRoot("");
              setSelectedWorkspace("");
              setResult("");
            }}
            onSelect={selectWorkspace}
            onSelectRecent={selectRecentWorkspace}
            onSelectRoot={(path) => {
              setSelectedRoot(path);
              setSelectedWorkspace(path);
              setResult("");
            }}
          />
        </PickerPanel>
      </View>

      <View style={[common.panel, {
        alignItems: compact ? "stretch" : "center",
        flexDirection: compact ? "column" : "row",
        gap: 12,
        justifyContent: "space-between",
        padding: 12,
      }]}>
        <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
          <Text style={common.eyebrow}>{t(language, "当前选择", "Current selection")}</Text>
          <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 15 }} numberOfLines={compact ? 3 : 1}>
            {selectedHost ? hostTitle(selectedHost) : t(language, "未选择主机", "No host selected")}
            {selectedAgentKey ? ` · ${agentDisplayName(parseAgentKey(selectedAgentKey))}` : ""}
            {selectedWorkspace ? ` · ${selectedWorkspace}` : ""}
          </Text>
          {result ? (
            <Text style={[common.body, { color: result === "authorized" ? "#167A4A" : colors.coral, fontSize: 13, lineHeight: 18 }]}>
              {result === "authorized"
                ? t(language, "已授权，可以回到 ACP 客户端。", "Authorized. Return to the ACP client.")
                : result}
            </Text>
          ) : null}
        </View>
        <Pressable
          disabled={!selectedHost || submitting || requestUnavailable}
          onPress={() => void submit()}
          style={[common.panel, {
            alignItems: "center",
            backgroundColor: selectedHost && !submitting && !requestUnavailable ? colors.lime : "#D8D8D8",
            justifyContent: "center",
            minHeight: 44,
            minWidth: narrow ? "100%" : 128,
            paddingHorizontal: 16,
          }]}
        >
          <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 15 }}>
            {requestUnavailable
              ? t(language, "重新发起后授权", "Start again")
              : submitting
                ? t(language, "正在授权", "Authorizing")
                : t(language, "授权会话", "Authorize")}
          </Text>
        </Pressable>
      </View>
    </View>
  );

  if (compact) {
    return (
      <View style={{ backgroundColor: colors.paper, flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, padding: 14 }}>
          {content}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={{ backgroundColor: colors.paper, flex: 1, maxHeight: "100vh" as unknown as number, overflow: "hidden", padding: 16 }}>
      {content}
    </View>
  );
}

function PickerPanel({
  children,
  compact,
  maxHeight,
  title,
  toolbar,
}: {
  children: ReactNode;
  compact?: boolean;
  maxHeight?: number;
  title: string;
  toolbar?: ReactNode;
}) {
  return (
    <View
      style={[
        common.panel,
        {
          flex: compact ? undefined : 1,
          maxHeight,
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
        },
      ]}
    >
      <View style={{ borderBottomColor: colors.ink, borderBottomWidth: 1, gap: compact ? 6 : 8, padding: compact ? 8 : 10 }}>
        <View style={{ alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "space-between" }}>
          <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: compact ? 15 : 17 }}>{title}</Text>
        </View>
        {toolbar}
      </View>
      <ScrollView style={{ flex: compact ? undefined : 1, minHeight: 0 }} contentContainerStyle={{ gap: compact ? 6 : 8, padding: compact ? 8 : 10 }}>
        {children}
      </ScrollView>
    </View>
  );
}

function Choice({
  active,
  disabled,
  meta,
  onPress,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  meta?: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        backgroundColor: active ? colors.lime : disabled ? "#EFEFEF" : "#FFFFFF",
        borderColor: colors.ink,
        borderRadius: 8,
        borderWidth: 1,
        gap: 3,
        opacity: disabled ? 0.48 : 1,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 14 }} numberOfLines={1}>{title}</Text>
      {meta ? <Text style={{ color: colors.muted, fontFamily: typography.sans, fontSize: 12 }} numberOfLines={1}>{meta}</Text> : null}
    </Pressable>
  );
}

function WorkspaceBrowser({
  compact,
  directory,
  language,
  onSelect,
  onAny,
  onSelectRecent,
  onSelectRoot,
  recentWorkspaces,
  roots,
  selectedRoot,
  selectedWorkspace,
}: {
  compact: boolean;
  directory: WorkspaceDirectoryState;
  language: LanguageMode;
  recentWorkspaces: string[];
  roots: AuthorizationWorkspaceRoot[];
  selectedRoot: string;
  onSelect: (path: string) => void;
  onAny: () => void;
  onSelectRecent: (path: string) => void;
  onSelectRoot: (path: string) => void;
  selectedWorkspace: string;
}) {
  const parent = selectedRoot ? parentPath(selectedWorkspace, selectedRoot) : undefined;
  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable onPress={onAny} style={smallButtonStyle(!selectedWorkspace)}>
          <Text style={smallButtonTextStyle}>{t(language, "不限定", "Any")}</Text>
        </Pressable>
        {roots.map((workspaceRoot) => (
          <Pressable
            key={workspaceRoot.path}
            onPress={() => onSelectRoot(workspaceRoot.path)}
            style={smallButtonStyle(selectedRoot === workspaceRoot.path)}
          >
            <Text style={smallButtonTextStyle}>{workspaceRoot.label || basename(workspaceRoot.path)}</Text>
          </Pressable>
        ))}
      </View>

      {recentWorkspaces.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={common.eyebrow}>{t(language, "最近选择", "Recent")}</Text>
          <View style={{ gap: 6 }}>
            {recentWorkspaces.slice(0, compact ? 3 : 5).map((path) => (
              <PathRow
                active={selectedWorkspace === path}
                icon={Clock02Icon}
                key={path}
                meta={path}
                title={basename(path)}
                onPress={() => onSelectRecent(path)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {selectedRoot ? (
        <View style={fileBrowserStyle}>
          <View style={fileBrowserHeaderStyle}>
            <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
              <Text style={common.eyebrow}>{t(language, "当前路径", "Current path")}</Text>
              <Text style={pathTextStyle} numberOfLines={compact ? 2 : 1}>
                {selectedWorkspace || selectedRoot}
              </Text>
            </View>
            <Pressable onPress={() => onSelect(selectedWorkspace || selectedRoot)} style={smallButtonStyle(true)}>
              <Text style={smallButtonTextStyle}>{t(language, "选择当前", "Select current")}</Text>
            </Pressable>
          </View>

          <View style={{ gap: 0 }}>
            <PathRow
              active={selectedWorkspace === selectedRoot}
              icon={Folder02Icon}
              meta={selectedRoot}
              title={t(language, "根目录", "Root folder")}
              onPress={() => onSelect(selectedRoot)}
            />
            {parent && parent !== selectedWorkspace ? (
              <PathRow
                active={false}
                icon={ArrowLeft01Icon}
                meta={parent}
                title={t(language, "返回上级目录", "Parent folder")}
                onPress={() => onSelect(parent)}
              />
            ) : null}
            {directory.status === "loading" ? (
              <View style={{ padding: 12 }}>
                <EmptyText>{t(language, "正在读取目录", "Loading folders")}</EmptyText>
              </View>
            ) : directory.status === "error" ? (
              <View style={{ padding: 12 }}>
                <EmptyText>{directory.message}</EmptyText>
              </View>
            ) : directory.status === "ready" && directory.entries.length > 0 ? (
              directory.entries.map((entry) => (
                <PathRow
                  active={selectedWorkspace === entry.path}
                  icon={Folder02Icon}
                  key={entry.path}
                  meta={entry.path}
                  title={entry.name}
                  onPress={() => onSelect(entry.path)}
                />
              ))
            ) : (
              <View style={{ padding: 12 }}>
                <EmptyText>{t(language, "没有可展开的子目录", "No child folders")}</EmptyText>
              </View>
            )}
          </View>
        </View>
      ) : (
        <EmptyText>{t(language, "这次会话不会限定工作目录。", "This session will not be limited to a workspace.")}</EmptyText>
      )}
    </View>
  );
}

function PathRow({
  active,
  icon,
  meta,
  onPress,
  title,
}: {
  active: boolean;
  icon: Parameters<typeof Icon>[0]["icon"];
  meta: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        alignItems: "center",
        backgroundColor: active ? colors.lime : "#FFFFFF",
        borderBottomColor: colors.line,
        borderBottomWidth: 1,
        flexDirection: "row",
        gap: 10,
        minHeight: 46,
        paddingHorizontal: 10,
        paddingVertical: 8,
      }}
    >
      <Icon color={colors.ink} icon={icon} size={18} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 13 }} numberOfLines={1}>
          {title}
        </Text>
        <Text style={{ color: colors.muted, fontFamily: typography.mono, fontSize: 11 }} numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

function AuthorizedCompletion({
  countdown,
  language,
  onClose,
  onHome,
}: {
  countdown: number;
  language: LanguageMode;
  onClose: () => void;
  onHome: () => void;
}) {
  return (
    <View style={{ alignItems: "center", backgroundColor: colors.paper, flex: 1, justifyContent: "center", padding: 18 }}>
      <View style={[common.panel, { maxWidth: 560, padding: 20, width: "100%" }]}>
        <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
          <View style={{ alignItems: "center", backgroundColor: colors.lime, borderColor: colors.ink, borderRadius: 999, borderWidth: 1, height: 44, justifyContent: "center", width: 44 }}>
            <Icon color={colors.ink} icon={CheckmarkCircle02Icon} size={24} />
          </View>
          <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
            <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 21 }}>
              {t(language, "授权成功", "Authorization complete")}
            </Text>
            <Text style={[common.body, { fontSize: 14, lineHeight: 20 }]}>
              {t(
                language,
                "Free 已经把这次会话授权给 ACP 客户端。",
                "Free has authorized this session for the ACP client.",
              )}
            </Text>
          </View>
        </View>

        <View style={{ backgroundColor: colors.graphite, borderRadius: 8, marginTop: 16, padding: 12 }}>
          <Text style={{ color: "#FFFDF7", fontFamily: typography.sansSemi, fontSize: 14 }}>
            {t(
              language,
              `${countdown} 秒后尝试自动关闭此页面。`,
              `This page will try to close in ${countdown} seconds.`,
            )}
          </Text>
          <Text style={{ color: "#D9D2C4", fontFamily: typography.sans, fontSize: 12, lineHeight: 17, marginTop: 4 }}>
            {t(
              language,
              "如果浏览器阻止自动关闭，可以直接回到 ACP 客户端，或进入 Workbench 首页。",
              "If the browser blocks closing, return to the ACP client or open the Workbench home page.",
            )}
          </Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 16 }}>
          <Pressable onPress={onClose} style={[buttonLikeStyle(true), { flexGrow: 1 }]}>
            <Text style={buttonLikeTextStyle}>{t(language, "关闭页面", "Close page")}</Text>
          </Pressable>
          <Pressable onPress={onHome} style={[buttonLikeStyle(false), { flexGrow: 1 }]}>
            <Icon color={colors.ink} icon={Home01Icon} size={18} />
            <Text style={buttonLikeTextStyle}>{t(language, "返回首页", "Open home")}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone: "error" }) {
  return (
    <View style={[common.panel, { backgroundColor: tone === "error" ? "#FFF0EB" : "#FFFFFF", borderColor: colors.coral, padding: 12 }]}>
      {children}
    </View>
  );
}

function StatusPill({ text, tone }: { text: string; tone: "error" | "success" }) {
  return (
    <View style={{
      backgroundColor: tone === "success" ? colors.lime : colors.coral,
      borderColor: colors.ink,
      borderRadius: 8,
      borderWidth: 1,
      paddingHorizontal: 12,
      paddingVertical: 8,
      shadowColor: colors.ink,
      shadowOffset: { height: 4, width: 4 },
      shadowOpacity: 1,
      shadowRadius: 0,
    }}>
      <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 13 }}>{text}</Text>
    </View>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <Text style={[common.body, { color: colors.muted, fontSize: 13 }]}>{children}</Text>;
}

function CenteredPanel({ body, title }: { body?: string; title: string }) {
  return (
    <View style={{ alignItems: "center", backgroundColor: colors.paper, flex: 1, justifyContent: "center", padding: 22 }}>
      <View style={[common.panel, { maxWidth: 520, padding: 18, width: "100%" }]}>
        <Text style={{ color: colors.ink, fontFamily: typography.sansSemi, fontSize: 20 }}>{title}</Text>
        {body ? <Text style={[common.body, { marginTop: 8 }]}>{body}</Text> : null}
      </View>
    </View>
  );
}

function hostTitle(host: AuthorizationHost): string {
  return host.metadata?.displayName || host.metadata?.machine || host.hostId;
}

function authorizationMessage(message: string | undefined, language: LanguageMode): string | undefined {
  if (!message) {
    return undefined;
  }
  if (isExpiredAuthorizationMessage(message)) {
    return t(
      language,
      "这次授权请求已经过期。请回到 Zed 重新发起会话，Free 会打开新的授权页。",
      "This authorization request has expired. Return to Zed and start the session again; Free will open a fresh authorization page.",
    );
  }
  if (message.includes("ACP account session is required")) {
    return t(
      language,
      "需要先登录 Free 账号，再继续授权当前设备或会话。",
      "Sign in to Free before authorizing this device or session.",
    );
  }
  return message;
}

function isExpiredAuthorizationMessage(message: string): boolean {
  return message.includes("Client connection is no longer active") ||
    message.includes("Unknown ACP connection") ||
    message.includes("not completed in time");
}

function hostMeta(host: AuthorizationHost, language: LanguageMode): string {
  const online = host.online === false
    ? t(language, "离线", "Offline")
    : t(language, "在线", "Online");
  const agentCount = host.metadata?.agentTypes?.length ?? 0;
  const workspaceCount = host.metadata?.workspaceRoots?.length ?? 0;
  return `${online} · ${agentCount} agents · ${workspaceCount} roots`;
}

function defaultAgentKey(host: AuthorizationHost): string {
  const agents = host.metadata?.agentTypes ?? [];
  return agentKey(agents.find((agent) => agent.id === "codex-acp") ?? agents[0]);
}

function agentKey(agent: AuthorizationAgent | undefined): string {
  if (!agent) return "";
  return JSON.stringify({
    command: agent.command,
    id: agent.id,
    type: agent.type,
  });
}

function parseAgentKey(key: string): AuthorizationAgent | undefined {
  if (!key) return undefined;
  try {
    return JSON.parse(key) as AuthorizationAgent;
  } catch {
    return undefined;
  }
}

function filterAgents(agents: AuthorizationAgent[], query: string): AuthorizationAgent[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return agents;
  return agents.filter((agent) =>
    [agent.label, agent.id, agent.command, agent.type]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

function normalizeWorkspaceRoots(roots: AuthorizationWorkspaceRoot[]): AuthorizationWorkspaceRoot[] {
  return roots.filter((root) => root.path);
}

function readRecentWorkspaces(): string[] {
  if (typeof window === "undefined") return [];
  const raw = window.localStorage.getItem(RECENT_WORKSPACES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string =>
      typeof value === "string" && value.startsWith("/"),
    ).slice(0, 8);
  } catch {
    return [];
  }
}

function storeRecentWorkspace(path: string): string[] {
  const next = [
    path,
    ...readRecentWorkspaces().filter((candidate) => candidate !== path),
  ].slice(0, 8);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(RECENT_WORKSPACES_STORAGE_KEY, JSON.stringify(next));
  }
  return next;
}

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);
}

function closeAuthorizationWindow(): void {
  if (typeof window === "undefined") return;
  window.close();
}

function goHome(): void {
  if (typeof window === "undefined") return;
  window.location.assign("/");
}

function agentDisplayName(agent: AuthorizationAgent | undefined): string {
  return agent?.label || agent?.id || agent?.command || "Agent";
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function parentPath(path: string, root: string): string | undefined {
  if (!path || path === root) return undefined;
  const rootParts = root.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (pathParts.length <= rootParts.length) return root;
  return `/${pathParts.slice(0, -1).join("/")}`;
}

const searchInputStyle = {
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  color: colors.ink,
  fontFamily: typography.sans,
  fontSize: 14,
  minHeight: 38,
  paddingHorizontal: 10,
};

const panelMetaStyle = {
  color: colors.muted,
  fontFamily: typography.sans,
  fontSize: 12,
};

const noticeTitleStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 15,
};

const fileBrowserStyle = {
  backgroundColor: "#FFFFFF",
  borderColor: colors.ink,
  borderRadius: 8,
  borderWidth: 1,
  overflow: "hidden" as const,
};

const fileBrowserHeaderStyle = {
  alignItems: "center" as const,
  backgroundColor: "#FAF7EC",
  borderBottomColor: colors.ink,
  borderBottomWidth: 1,
  flexDirection: "row" as const,
  gap: 10,
  padding: 10,
};

const pathTextStyle = {
  color: colors.ink,
  fontFamily: typography.mono,
  fontSize: 12,
};

function buttonLikeStyle(primary: boolean) {
  return {
    alignItems: "center" as const,
    backgroundColor: primary ? colors.lime : "#FFFFFF",
    borderColor: colors.ink,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row" as const,
    gap: 8,
    justifyContent: "center" as const,
    minHeight: 44,
    paddingHorizontal: 14,
  };
}

const buttonLikeTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 14,
};

function smallButtonStyle(active: boolean) {
  return {
    backgroundColor: active ? colors.lime : "#FFFFFF",
    borderColor: colors.ink,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 7,
  };
}

const smallButtonTextStyle = {
  color: colors.ink,
  fontFamily: typography.sansSemi,
  fontSize: 12,
};
