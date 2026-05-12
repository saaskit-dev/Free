type FreeProductRoute =
  | "/"
  | "/app"
  | "/sessions"
  | "/authorization"
  | "/settings"
  | "/system";

type SessionState = "waiting-auth" | "running" | "idle";
type ContextTab = "Diff" | "Files" | "Terminal" | "Logs";
type CommandMode = "execute" | "running" | "authorization";

interface ProductSession {
  readonly id: string;
  readonly agent: string;
  readonly agentMark: string;
  readonly agentClass: string;
  readonly title: string;
  readonly titleZh: string;
  readonly repo: string;
  readonly branch: string;
  readonly host: string;
  readonly event: string;
  readonly eventZh: string;
  readonly detail: string;
  readonly detailZh: string;
  readonly updated: string;
  readonly state: SessionState;
  readonly context: string;
  readonly href: FreeProductRoute;
  readonly attention?: string;
  readonly attentionZh?: string;
  readonly warning?: string;
  readonly warningZh?: string;
}

interface WorkflowView {
  readonly route: FreeProductRoute;
  readonly selectedSessionId: string;
  readonly surfaceLabel: string;
  readonly title: string;
  readonly eyebrow: string;
  readonly statusLabel: string;
  readonly statusTone: "amber" | "green" | "gray";
  readonly activeContext: ContextTab;
  readonly canvas: string;
  readonly handoff: HandoffState;
  readonly command: CommandState;
}

interface HandoffState {
  readonly text: string;
  readonly textZh: string;
  readonly meta: string;
  readonly metaZh: string;
  readonly actions: readonly string[];
  readonly actionsZh: readonly string[];
}

interface CommandState {
  readonly mode: CommandMode;
  readonly agent: string;
  readonly buildMode: string;
  readonly buildModeZh: string;
  readonly model: string;
  readonly autonomy: string;
  readonly autonomyZh: string;
  readonly context: string;
  readonly contextZh: string;
  readonly value: string;
  readonly valueZh: string;
}

const PRODUCT_ROUTES: readonly FreeProductRoute[] = [
  "/",
  "/app",
  "/sessions",
  "/authorization",
  "/settings",
  "/system",
];

const ROUTE_LABELS: Record<FreeProductRoute, string> = {
  "/": "Attention",
  "/app": "Workbench",
  "/sessions": "Sessions",
  "/authorization": "Authorization",
  "/settings": "Settings",
  "/system": "System",
};

const SESSIONS: readonly ProductSession[] = [
  {
    id: "deploy-production",
    agent: "Claude Code",
    agentMark: "Cl",
    agentClass: "claude",
    title: "Deploy to production",
    titleZh: "部署到生产环境",
    repo: "acme-api",
    branch: "release/v1.2.0",
    host: "prod-host-1",
    event: "Needs deploy approval",
    eventZh: "需要部署授权",
    detail: "Production deploy is blocked until a human approves the remote command.",
    detailZh: "生产部署已阻塞，需要人工批准远程命令后才能继续。",
    updated: "1m",
    state: "waiting-auth",
    context: "prod",
    href: "/authorization",
    attention: "terminal approval",
    attentionZh: "终端授权",
  },
  {
    id: "aws-credentials",
    agent: "Custom ACP",
    agentMark: "AC",
    agentClass: "custom",
    title: "Access AWS credentials",
    titleZh: "访问 AWS 凭据",
    repo: "infra",
    branch: "main",
    host: "aws-us-east-1",
    event: "Needs credential access",
    eventZh: "需要凭据访问授权",
    detail: "Agent requested short-lived AWS credentials for migration validation.",
    detailZh: "Agent 请求用于迁移验证的短期 AWS 凭据。",
    updated: "3m",
    state: "waiting-auth",
    context: "cloud",
    href: "/authorization",
    attention: "credential scope",
    attentionZh: "凭据范围",
  },
  {
    id: "fix-login",
    agent: "Claude Code",
    agentMark: "Cl",
    agentClass: "claude",
    title: "Fix login race condition",
    titleZh: "修复登录竞态条件",
    repo: "acme-api",
    branch: "fix/auth",
    host: "prod-host-1",
    event: "Updated auth session locking logic",
    eventZh: "已更新认证 session 锁逻辑",
    detail: "Analyzed session creation and moved cache invalidation before response send.",
    detailZh: "已分析 session 创建流程，并将缓存失效移到响应发送前。",
    updated: "2m",
    state: "running",
    context: "auth",
    href: "/app",
  },
  {
    id: "billing-tests",
    agent: "Codex",
    agentMark: "Cx",
    agentClass: "codex",
    title: "Billing retry logic",
    titleZh: "账单重试逻辑",
    repo: "acme-billing",
    branch: "main",
    host: "staging-host-1",
    event: "Running tests 8/12",
    eventZh: "正在运行测试 8/12",
    detail: "Retry behavior is being verified against the staged payment adapter.",
    detailZh: "正在通过预发支付适配器验证重试行为。",
    updated: "5m",
    state: "running",
    context: "billing",
    href: "/app",
  },
  {
    id: "next-upgrade",
    agent: "Gemini",
    agentMark: "Ge",
    agentClass: "gemini",
    title: "Upgrade Next.js to 15",
    titleZh: "升级 Next.js 到 15",
    repo: "acme-web",
    branch: "main",
    host: "dev-host-1",
    event: "Building project 42%",
    eventZh: "正在构建项目 42%",
    detail: "Compiler migration is running after dependency and config edits.",
    detailZh: "依赖和配置修改完成后，编译器迁移正在执行。",
    updated: "12m",
    state: "running",
    context: "web",
    href: "/app",
  },
  {
    id: "auth-middleware",
    agent: "Cursor Agent",
    agentMark: "Cu",
    agentClass: "cursor",
    title: "Refactor auth middleware",
    titleZh: "重构认证中间件",
    repo: "acme-api",
    branch: "refactor/auth",
    host: "prod-host-2",
    event: "Applying changes 2/4",
    eventZh: "正在应用变更 2/4",
    detail: "Middleware split is being applied across request guards and tests.",
    detailZh: "中间件拆分正在应用到请求守卫和测试中。",
    updated: "18m",
    state: "running",
    context: "auth",
    href: "/app",
  },
  {
    id: "database-queries",
    agent: "Codex",
    agentMark: "Cx",
    agentClass: "codex muted",
    title: "Optimize database queries",
    titleZh: "优化数据库查询",
    repo: "acme-api",
    branch: "perf/db",
    host: "prod-host-1",
    event: "Completed · all tests passed",
    eventZh: "已完成 · 全部测试通过",
    detail: "Query plan regression tests passed after index and resolver changes.",
    detailZh: "索引和 resolver 修改后，查询计划回归测试已通过。",
    updated: "2h",
    state: "idle",
    context: "db",
    href: "/sessions",
  },
  {
    id: "ci-pipeline",
    agent: "Gemini",
    agentMark: "Ge",
    agentClass: "gemini muted",
    title: "CI pipeline improvements",
    titleZh: "改进 CI 流水线",
    repo: "acme-web",
    branch: "ci/cd",
    host: "prod-host-1",
    event: "Completed · deployed successfully",
    eventZh: "已完成 · 部署成功",
    detail: "Deployment workflow was simplified and the release job completed.",
    detailZh: "部署工作流已简化，发布任务已完成。",
    updated: "5h",
    state: "idle",
    context: "ci",
    href: "/sessions",
  },
  {
    id: "error-messages",
    agent: "Cursor Agent",
    agentMark: "Cu",
    agentClass: "cursor muted",
    title: "Improve error messages",
    titleZh: "改进错误信息",
    repo: "acme-api",
    branch: "chore/errors",
    host: "dev-host-1",
    event: "Idle · 3 failing tests",
    eventZh: "空闲 · 3 个测试失败",
    detail: "Copy changes are complete, but three integration tests still fail.",
    detailZh: "文案变更已完成，但仍有三个集成测试失败。",
    updated: "1d",
    state: "idle",
    context: "errors",
    href: "/sessions",
    warning: "tests failed",
    warningZh: "测试失败",
  },
  {
    id: "webhook-idempotency",
    agent: "Custom ACP",
    agentMark: "AC",
    agentClass: "custom muted",
    title: "Add idempotency to webhook",
    titleZh: "为 webhook 增加幂等性",
    repo: "acme-api",
    branch: "feat/webhooks",
    host: "staging-host-2",
    event: "Idle · waiting for review",
    eventZh: "空闲 · 等待 review",
    detail: "One approval remains before the webhook session can continue.",
    detailZh: "webhook session 继续前还需要一次批准。",
    updated: "2d",
    state: "idle",
    context: "webhook",
    href: "/sessions",
  },
];

export function isFreeProductAppPath(pathname: string): boolean {
  return normalizeProductRoute(pathname) !== null;
}

export function createFreeProductAppPage(pathname = "/app"): string {
  const route = normalizeProductRoute(pathname) ?? "/app";
  const view = createWorkflowView(route);
  return `<!doctype html>
<html lang="en" data-theme="light" data-language="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Free</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23ece8ff'/%3E%3Cpath d='M11 8h11v4h-6v3h5v4h-5v5h-5z' fill='%234f35dd'/%3E%3C/svg%3E">
    <style>
${renderStyles()}
    </style>
  </head>
  <body>
    <div class="app-frame" data-route="${escapeHtml(route)}">
      ${renderTopBar(view)}
      <div class="workspace">
        ${renderSessionMemorySurface(view.selectedSessionId)}
        ${renderWorkflowCanvas(view)}
        ${renderContextSurface(view)}
      </div>
    </div>
    ${renderClientScript()}
  </body>
</html>`;
}

function normalizeProductRoute(pathname: string): FreeProductRoute | null {
  return PRODUCT_ROUTES.includes(pathname as FreeProductRoute)
    ? pathname as FreeProductRoute
    : null;
}

function createWorkflowView(route: FreeProductRoute): WorkflowView {
  switch (route) {
    case "/":
      return {
        route,
        selectedSessionId: "deploy-production",
        surfaceLabel: "Attention handoff",
        title: "Deploy to production waiting approval",
        eyebrow: "Session requires human authorization",
        statusLabel: "Waiting Auth",
        statusTone: "amber",
        activeContext: "Logs",
        canvas: renderHomeCanvas(),
        handoff: {
          text: "Claude Code is waiting for a scoped production deploy decision.",
          textZh: "Claude Code 正在等待一次限定范围的生产部署决策。",
          meta: "1 command blocked · release diff ready · smoke output available",
          metaZh: "1 个命令被阻塞 · release diff 已就绪 · smoke 输出可查看",
          actions: ["Approve once", "Deny", "Continue with constraints"],
          actionsZh: ["批准一次", "拒绝", "带约束继续"],
        },
        command: {
          mode: "authorization",
          agent: "Claude Code",
          buildMode: "Deploy",
          buildModeZh: "部署",
          model: "Sonnet 3.7",
          autonomy: "Approval required",
          autonomyZh: "需要授权",
          context: "acme-api / release/v1.2.0",
          contextZh: "acme-api / release/v1.2.0",
          value: "Approve the production deploy only after checking the migration log and release diff.",
          valueZh: "检查迁移日志和 release diff 后，仅批准本次生产部署。",
        },
      };
    case "/authorization":
      return {
        route,
        selectedSessionId: "deploy-production",
        surfaceLabel: "Authorization queue",
        title: "Authorization decisions",
        eyebrow: "Blocked workflow operations",
        statusLabel: "Waiting Auth",
        statusTone: "amber",
        activeContext: "Logs",
        canvas: renderAuthorizationCanvas(),
        handoff: {
          text: "Two sessions are blocked on human authorization.",
          textZh: "两个 session 正在等待人工授权。",
          meta: "2 pending decisions · terminal and credential scopes",
          metaZh: "2 个待决策项 · 终端与凭据范围",
          actions: ["Approve once", "Deny", "Continue with constraints"],
          actionsZh: ["批准一次", "拒绝", "带约束继续"],
        },
        command: {
          mode: "authorization",
          agent: "Claude Code",
          buildMode: "Authorize",
          buildModeZh: "授权",
          model: "Sonnet 3.7",
          autonomy: "Scoped approval",
          autonomyZh: "限定范围授权",
          context: "prod-host-1",
          contextZh: "prod-host-1",
          value: "Allow terminal once for the production deploy after reviewing the command scope.",
          valueZh: "确认命令范围后，为本次生产部署批准一次终端执行。",
        },
      };
    case "/sessions":
      return {
        route,
        selectedSessionId: "error-messages",
        surfaceLabel: "Session memory",
        title: "All session memory",
        eyebrow: "Attention queue and durable workflow history",
        statusLabel: "Idle overview",
        statusTone: "gray",
        activeContext: "Files",
        canvas: renderSessionsCanvas(),
        handoff: {
          text: "Idle sessions can be resumed from their latest workflow event.",
          textZh: "空闲 session 可以从最新 workflow 事件继续。",
          meta: "4 idle sessions · 1 with failing tests",
          metaZh: "4 个空闲 session · 1 个存在测试失败",
          actions: ["Open session", "Review failure", "Queue follow-up"],
          actionsZh: ["打开 session", "检查失败", "排队后续任务"],
        },
        command: {
          mode: "execute",
          agent: "Codex",
          buildMode: "Review",
          buildModeZh: "Review",
          model: "GPT-5",
          autonomy: "Auto",
          autonomyZh: "自动",
          context: "selected session",
          contextZh: "已选 session",
          value: "Open the idle session with failing tests and continue from the latest failure summary.",
          valueZh: "打开存在测试失败的空闲 session，并从最新失败摘要继续推进。",
        },
      };
    case "/settings":
      return {
        route,
        selectedSessionId: "fix-login",
        surfaceLabel: "Runtime settings",
        title: "Agent and workspace settings",
        eyebrow: "Default runtime behavior",
        statusLabel: "Ready",
        statusTone: "green",
        activeContext: "Files",
        canvas: renderSettingsCanvas(),
        handoff: {
          text: "Workspace defaults affect new sessions, not running workflows.",
          textZh: "工作区默认设置只影响新 session，不影响正在运行的 workflow。",
          meta: "settings are scoped by workspace and host",
          metaZh: "设置按工作区和 host 生效",
          actions: ["Apply defaults", "Review policy", "Open system"],
          actionsZh: ["应用默认设置", "检查策略", "打开系统状态"],
        },
        command: {
          mode: "execute",
          agent: "Codex",
          buildMode: "Configure",
          buildModeZh: "配置",
          model: "GPT-5",
          autonomy: "Manual",
          autonomyZh: "手动",
          context: "workspace policy",
          contextZh: "工作区策略",
          value: "Set new sessions in acme-api to request terminal approval before production commands.",
          valueZh: "将 acme-api 的新 session 设置为生产命令前请求终端授权。",
        },
      };
    case "/system":
      return {
        route,
        selectedSessionId: "fix-login",
        surfaceLabel: "System state",
        title: "Relay, host, and runtime continuity",
        eyebrow: "Operational health",
        statusLabel: "Live",
        statusTone: "green",
        activeContext: "Logs",
        canvas: renderSystemCanvas(),
        handoff: {
          text: "Runtime continuity is healthy across relay and active hosts.",
          textZh: "relay 与活跃 host 的 runtime 连续性状态正常。",
          meta: "relay live · 2 hosts ready · 1 restoring",
          metaZh: "relay 在线 · 2 个 host 就绪 · 1 个正在恢复",
          actions: ["Open logs", "Run check", "Export state"],
          actionsZh: ["打开日志", "运行检查", "导出状态"],
        },
        command: {
          mode: "execute",
          agent: "Codex",
          buildMode: "Diagnose",
          buildModeZh: "诊断",
          model: "GPT-5",
          autonomy: "Read only",
          autonomyZh: "只读",
          context: "relay / host",
          contextZh: "relay / host",
          value: "Run a read-only health check and summarize reconnect risk for active sessions.",
          valueZh: "运行一次只读健康检查，并总结活跃 session 的重连风险。",
        },
      };
    case "/app":
    default:
      return {
        route: "/app",
        selectedSessionId: "fix-login",
        surfaceLabel: "Workflow Canvas",
        title: "Fix login race condition",
        eyebrow: "Operational workflow",
        statusLabel: "Running",
        statusTone: "green",
        activeContext: "Diff",
        canvas: renderWorkbenchCanvas(),
        handoff: {
          text: "Claude Code finished implementation and is waiting for review.",
          textZh: "Claude Code 已完成实现，正在等待 review。",
          meta: "2 files changed · 3 tests updated · 1 next step",
          metaZh: "2 个文件变更 · 3 个测试更新 · 1 个下一步",
          actions: ["Review changes", "Approve and continue", "Request changes"],
          actionsZh: ["查看变更", "批准并继续", "要求修改"],
        },
        command: {
          mode: "running",
          agent: "Claude Code",
          buildMode: "Build",
          buildModeZh: "构建",
          model: "Sonnet 3.7",
          autonomy: "Auto",
          autonomyZh: "自动",
          context: "acme-api / fix/auth",
          contextZh: "acme-api / fix/auth",
          value: "Add a regression test for concurrent login in @auth.ts and link it to #123.\nAlso update @docs/auth.md with the changed cache invalidation behavior.",
          valueZh: "在 @auth.ts 中为并发登录添加回归测试，并关联 #123。\n同时更新 @docs/auth.md，说明缓存失效行为的变更。",
        },
      };
  }
}

function renderTopBar(view: WorkflowView): string {
  return `<header class="topbar">
        <div class="brand-zone">
          <a class="brand" href="/" aria-label="Free home">
            <span class="brand-mark">F</span>
            <span>Free</span>
          </a>
          <label class="search" aria-label="Search sessions">
            <span class="search-icon">/</span>
            <input data-session-search data-i18n-placeholder="search.placeholder" value="" placeholder="Search sessions, repo, branch, host..." />
            <span class="shortcut">⌘K</span>
          </label>
        </div>
        <div class="project-zone">
          <div class="crumbs">
            <span class="project-icon">ac</span>
            <span>acme-api</span>
            <span class="crumb-muted">/</span>
            <span>${escapeHtml(currentSession(view.selectedSessionId).branch)}</span>
          </div>
          <nav class="view-nav" aria-label="Product routes">
            ${renderRouteLink("/", view.route)}
            ${renderRouteLink("/app", view.route)}
            ${renderRouteLink("/authorization", view.route)}
            ${renderRouteLink("/sessions", view.route)}
            ${renderRouteLink("/settings", view.route)}
            ${renderRouteLink("/system", view.route)}
          </nav>
        </div>
        <div class="runtime-zone">
          <button class="topbar-toggle" type="button" data-theme-toggle>Light</button>
          <button class="topbar-toggle" type="button" data-language-toggle>中文</button>
          <span>${escapeHtml(view.command.agent)}</span>
          <span class="runtime-separator"></span>
          <span>${escapeHtml(view.command.model)}</span>
          <span class="live-dot"></span>
          <span data-runtime-status data-i18n="${escapeHtml(statusCopyKey(view.statusLabel))}">${escapeHtml(view.statusLabel)}</span>
          <span class="avatar">DV</span>
        </div>
      </header>`;
}

function renderRouteLink(route: FreeProductRoute, current: FreeProductRoute): string {
  const active = route === current ? " active" : "";
  return `<a class="route-link${active}" href="${escapeHtml(route)}" data-i18n="${escapeHtml(routeCopyKey(route))}">${escapeHtml(ROUTE_LABELS[route])}</a>`;
}

function routeCopyKey(route: FreeProductRoute): string {
  switch (route) {
    case "/":
      return "route.attention";
    case "/app":
      return "route.workbench";
    case "/sessions":
      return "route.sessions";
    case "/authorization":
      return "route.authorization";
    case "/settings":
      return "route.settings";
    case "/system":
      return "route.system";
  }
}

function stateCopyKey(state: SessionState): string {
  switch (state) {
    case "waiting-auth":
      return "state.waiting-auth";
    case "running":
      return "state.running";
    case "idle":
      return "state.idle";
  }
}

function renderSessionMemorySurface(selectedSessionId: string): string {
  return `<aside class="session-surface" aria-label="Session Memory Surface">
        <div class="surface-tools">
          <button class="small-button" type="button" data-popover-toggle="recent" data-i18n="surface.recent">Recent</button>
          <button class="icon-button" type="button" aria-label="Filter sessions" data-popover-toggle="filters" data-i18n="surface.filter">Filter</button>
        </div>
        <div class="surface-popover" data-popover="recent" hidden>
          <strong data-i18n="surface.recentSessions">Recent sessions</strong>
          <button type="button" data-jump-session="fix-login" data-i18n="session.fix-login.title">Fix login race condition</button>
          <button type="button" data-jump-session="deploy-production" data-i18n="session.deploy-production.title">Deploy to production</button>
          <button type="button" data-jump-session="error-messages" data-i18n="session.error-messages.title">Improve error messages</button>
        </div>
        <div class="surface-popover" data-popover="filters" hidden>
          <strong data-i18n="surface.filters">Filters</strong>
          <button type="button" data-state-filter="all" data-i18n="filter.all">All states</button>
          <button type="button" data-state-filter="waiting-auth" data-i18n="state.waiting-auth">Waiting Auth</button>
          <button type="button" data-state-filter="running" data-i18n="state.running">Running</button>
          <button type="button" data-state-filter="idle" data-i18n="state.idle">Idle</button>
        </div>
        <div class="empty-search" data-empty-search data-i18n="surface.empty" hidden>No sessions match the current filter.</div>
        ${renderSessionSection("waiting-auth", "Waiting Auth")}
        ${renderSessionSection("running", "Running", selectedSessionId)}
        ${renderSessionSection("idle", "Idle", selectedSessionId)}
        <a class="new-session" href="/authorization" data-i18n="surface.newSession">New Session</a>
      </aside>`;
}

function renderSessionSection(
  state: SessionState,
  label: string,
  selectedSessionId?: string,
): string {
  const sessions = SESSIONS.filter((session) => session.state === state);
  if (sessions.length === 0) {
    return "";
  }

  const rows = sessions.map((session) => renderSessionRow(session, selectedSessionId)).join("");
  return `<section class="session-section" data-state="${escapeHtml(state)}">
          <div class="section-heading">
            <span data-i18n="${escapeHtml(stateCopyKey(state))}">${escapeHtml(label)}</span>
            <span>${sessions.length}</span>
          </div>
          <div class="session-list">${rows}</div>
        </section>`;
}

function renderSessionRow(session: ProductSession, selectedSessionId?: string): string {
  const selected = session.id === selectedSessionId ? " selected" : "";
  const waiting = session.state === "waiting-auth" ? " waiting" : "";
  const warning = session.warning ? `<span class="warning-marker" data-session-warning-target>${escapeHtml(session.warning)}</span>` : "";
  const searchEn = `${session.title} ${session.agent} ${session.repo} ${session.branch} ${session.host} ${session.event}`.toLowerCase();
  const searchZh = `${session.titleZh} ${session.agent} ${session.repo} ${session.branch} ${session.host} ${session.eventZh}`.toLowerCase();
  return `<a class="session-row${selected}${waiting}" href="${escapeHtml(session.href)}" data-session-id="${escapeHtml(session.id)}" data-session-state="${escapeHtml(session.state)}" data-session-agent="${escapeHtml(session.agent)}" data-session-title-en="${escapeHtml(session.title)}" data-session-title-zh="${escapeHtml(session.titleZh)}" data-session-event-en="${escapeHtml(session.event)}" data-session-event-zh="${escapeHtml(session.eventZh)}" data-session-warning-en="${escapeHtml(session.warning ?? "")}" data-session-warning-zh="${escapeHtml(session.warningZh ?? "")}" data-session-detail-en="${escapeHtml(session.detail)}" data-session-detail-zh="${escapeHtml(session.detailZh)}" data-session-repo="${escapeHtml(session.repo)}" data-session-branch="${escapeHtml(session.branch)}" data-session-host="${escapeHtml(session.host)}" data-session-search-en="${escapeHtml(searchEn)}" data-session-search-zh="${escapeHtml(searchZh)}">
            <span class="agent-mark ${escapeHtml(session.agentClass)}">${escapeHtml(session.agentMark)}</span>
            <span class="row-main">
              <span class="row-title" data-session-title-target>${escapeHtml(session.title)}</span>
              <span class="row-meta">${escapeHtml(session.repo)} / ${escapeHtml(session.branch)} / ${escapeHtml(session.host)}</span>
              <span class="row-event"><span data-session-event-target>${escapeHtml(session.event)}</span>${warning}</span>
            </span>
            <span class="row-side">
              <span class="state-dot ${escapeHtml(session.state)}"></span>
              <span>${escapeHtml(session.updated)}</span>
            </span>
          </a>`;
}

function renderWorkflowCanvas(view: WorkflowView): string {
  const viewKey = viewCopyBase(view.route);
  return `<main class="workflow-canvas" aria-label="Workflow Canvas">
        <div class="canvas-header">
          <div>
            <div class="eyebrow" data-canvas-eyebrow data-i18n="${escapeHtml(`${viewKey}.eyebrow`)}">${escapeHtml(view.eyebrow)}</div>
            <h1 data-canvas-title data-i18n="${escapeHtml(`${viewKey}.title`)}">${escapeHtml(view.title)}</h1>
          </div>
          <span class="status-badge ${escapeHtml(view.statusTone)}" data-status-badge>
            <span class="state-dot ${escapeHtml(view.statusTone)}"></span>
            <span data-status-label data-i18n="${escapeHtml(statusCopyKey(view.statusLabel))}">${escapeHtml(view.statusLabel)}</span>
          </span>
        </div>
        <section class="canvas-body" aria-label="${escapeHtml(view.surfaceLabel)}">
          ${view.canvas}
        </section>
        ${renderHandoff(view.handoff)}
        ${renderCommandSurface(view.command)}
      </main>`;
}

function viewCopyBase(route: FreeProductRoute): string {
  switch (route) {
    case "/":
      return "view.attention";
    case "/app":
      return "view.workbench";
    case "/sessions":
      return "view.sessions";
    case "/authorization":
      return "view.authorization";
    case "/settings":
      return "view.settings";
    case "/system":
      return "view.system";
  }
}

function statusCopyKey(label: string): string {
  switch (label) {
    case "Waiting Auth":
      return "state.waiting-auth";
    case "Running":
      return "state.running";
    case "Idle overview":
      return "status.idleOverview";
    case "Ready":
      return "status.ready";
    case "Live":
      return "status.live";
    default:
      return "state.idle";
  }
}

function renderHomeCanvas(): string {
  return `${renderWorkflowSection(
    "Why this needs attention",
    `<p data-i18n="attention.body">The deploy session is blocked by a terminal authorization request. The agent has completed release preparation, but production execution requires a human decision before the workflow can continue.</p>
    <div class="decision-layout">
      <div class="decision-block">
        <span class="field-label" data-i18n="attention.requestedOperation">Requested operation</span>
        <strong data-i18n="attention.deployCommand">Run production deploy command</strong>
        <p data-i18n="attention.scope">Scope is limited to <code>acme-api</code> on <code>prod-host-1</code>.</p>
      </div>
      <div class="decision-block">
        <span class="field-label" data-i18n="attention.latestEvidence">Latest evidence</span>
        <strong data-i18n="attention.migrationPassed">Migration dry run passed</strong>
        <p data-i18n="attention.evidenceBody">Release diff and smoke output are available in the context surface.</p>
      </div>
    </div>`,
    "section.attention.why",
  )}
  ${renderWorkflowTimeline([
    ["Release branch prepared", "package, migrations, and smoke command were staged", "timeline.attention.release", "timeline.attention.releaseDetail"],
    ["Deploy command requested", "authorization required before production terminal execution", "timeline.attention.deploy", "timeline.attention.deployDetail"],
    ["Human handoff", "review scope, then approve once or request constraints", "timeline.attention.handoff", "timeline.attention.handoffDetail"],
  ])}`;
}

function renderWorkbenchCanvas(): string {
  return `${renderWorkflowSection(
    "Authentication flow analysis",
    `<p data-i18n="workbench.analysis.body">I analyzed session creation and identified a race condition during concurrent login. Duplicate session writes can occur before cache invalidation completes.</p>
    <ul class="findings">
      <li data-i18n="workbench.finding.duplicate">Duplicate session writes can occur under high concurrency.</li>
      <li data-i18n="workbench.finding.retry">The retry path bypasses the session mutex.</li>
      <li data-i18n="workbench.finding.cache">Cache invalidation happens after the response is sent.</li>
    </ul>`,
    "section.workbench.analysis",
  )}
  ${renderWorkflowTimeline([
    ["Opened 12 files", "auth.ts, session.ts, middleware.ts, session-cache.ts", "timeline.workbench.opened", "timeline.workbench.openedDetail"],
    ["Searched session creation logic", "8 results in 3 files", "timeline.workbench.searched", "timeline.workbench.searchedDetail"],
    ["Analyzed authentication flow", "2m 14s", "timeline.workbench.analyzed", "timeline.workbench.analyzedDetail"],
  ])}
  ${renderModifiedFiles()}
  ${renderTests()}`;
}

function renderSessionsCanvas(): string {
  const rows = SESSIONS.map((session) => `<tr>
      <td><span class="table-title" data-table-title-target data-table-title-en="${escapeHtml(session.title)}" data-table-title-zh="${escapeHtml(session.titleZh)}">${escapeHtml(session.title)}</span><span>${escapeHtml(session.agent)}</span></td>
      <td data-table-status-target data-table-status-state="${escapeHtml(session.state)}">${escapeHtml(statusLabel(session.state))}</td>
      <td>${escapeHtml(session.repo)} / ${escapeHtml(session.branch)}</td>
      <td data-table-event-target data-table-event-en="${escapeHtml(session.event)}" data-table-event-zh="${escapeHtml(session.eventZh)}">${escapeHtml(session.event)}</td>
      <td>${escapeHtml(session.updated)}</td>
    </tr>`).join("");
  return `${renderWorkflowSection(
    "Attention memory",
    `<p data-i18n="sessions.body">Sessions are sorted by operational attention, not by project taxonomy. Waiting authorization blocks progress, running sessions need observation, and idle sessions are low attention unless they carry failure context.</p>`,
    "section.sessions.memory",
  )}
  <table class="dense-table">
    <thead><tr><th data-i18n="table.session">Session</th><th data-i18n="table.status">Status</th><th data-i18n="table.workspace">Workspace</th><th data-i18n="table.latestEvent">Latest event</th><th data-i18n="table.updated">Updated</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderAuthorizationCanvas(): string {
  const waitingRows = SESSIONS.filter((session) => session.state === "waiting-auth")
    .map((session) => `<div class="auth-row">
      <div>
        <span class="table-title">${escapeHtml(session.title)}</span>
        <span>${escapeHtml(session.detail)}</span>
      </div>
      <div>
        <span class="field-label" data-i18n="auth.scope">Scope</span>
        <span>${escapeHtml(session.repo)} / ${escapeHtml(session.host)}</span>
      </div>
      <div class="auth-actions">
        <button type="button" data-auth-action="approve" data-i18n="action.approveOnce">Approve once</button>
        <button type="button" data-auth-action="deny" data-i18n="action.deny">Deny</button>
      </div>
    </div>`).join("");
  return `${renderWorkflowSection(
    "Blocked operations",
    `<p data-i18n="authorization.body">Authorization keeps the state model simple while preserving the concrete decision. The product state remains Waiting Auth; the row and canvas explain the requested scope.</p>`,
    "section.authorization.blocked",
  )}
  <div class="auth-list">${waitingRows}</div>
  `;
}

function renderSettingsCanvas(): string {
  return `${renderWorkflowSection(
    "Runtime defaults",
    `<p data-i18n="settings.body">Settings are scoped to agents, hosts, and workspaces. Internal relay details stay hidden unless the user opens system diagnostics.</p>`,
    "section.settings.defaults",
  )}
  <div class="settings-list">
    ${renderSettingRow("Default agent", "Claude Code for acme-api, Codex for local maintenance")}
    ${renderSettingRow("Permission mode", "Production terminal commands require explicit approval")}
    ${renderSettingRow("Workspace roots", "/Users/dev/Free, /Users/dev/acp-runtime")}
    ${renderSettingRow("Restore behavior", "Reconnect and restore sessions before creating a new workflow")}
  </div>`;
}

function renderSystemCanvas(): string {
  return `${renderWorkflowSection(
    "Continuity state",
    `<p data-i18n="system.body">System status focuses on relay, host, and runtime continuity. It does not expose ticket, grant, connection id, or route internals in the default surface.</p>`,
    "section.system.continuity",
  )}
  <div class="system-lines">
    ${renderSystemLine("Relay", "Live", "account session verified, broker accepting clients")}
    ${renderSystemLine("prod-host-1", "Ready", "4 active sessions, reconnect window healthy")}
    ${renderSystemLine("dev-host-1", "Restoring session", "idle workflow metadata is being replayed")}
    ${renderSystemLine("Runtime", "Ready", "Claude Code, Codex, Gemini, Cursor Agent advertised")}
  </div>`;
}

function renderWorkflowSection(title: string, body: string, titleKey?: string): string {
  const i18n = titleKey ? ` data-i18n="${escapeHtml(titleKey)}"` : "";
  return `<section class="workflow-section">
    <h2${i18n}>${escapeHtml(title)}</h2>
    ${body}
  </section>`;
}

function renderWorkflowTimeline(items: readonly [string, string, string?, string?][]): string {
  const rows = items.map(([title, detail, titleKey, detailKey]) => `<div class="event-line">
      <span class="event-icon"></span>
      <span class="event-title"${titleKey ? ` data-i18n="${escapeHtml(titleKey)}"` : ""}>${escapeHtml(title)}</span>
      <span class="event-detail"${detailKey ? ` data-i18n="${escapeHtml(detailKey)}"` : ""}>${escapeHtml(detail)}</span>
    </div>`).join("");
  return `<section class="workflow-section timeline" aria-label="Workflow operations">${rows}</section>`;
}

function renderModifiedFiles(): string {
  const rows = [
    ["src/lib/auth/session.ts", "+32", "-8", "green"],
    ["src/middleware/auth.ts", "+10", "-2", "green"],
    ["src/lib/cache/session-cache.ts", "+6", "-2", "amber"],
  ].map(([file, added, removed, tone]) => `<div class="file-row">
      <span>${escapeHtml(file)}</span>
      <span class="change add">${escapeHtml(added)}</span>
      <span class="change remove">${escapeHtml(removed)}</span>
      <span class="spark ${escapeHtml(tone)}"></span>
    </div>`).join("");
  return `<section class="workflow-section">
    <div class="section-line"><h2 data-i18n="section.workbench.modifiedFiles">Modified files</h2><span class="change add">+48</span><span class="change remove">-12</span></div>
    <div class="file-list">${rows}</div>
  </section>`;
}

function renderTests(): string {
  const rows = [
    ["auth concurrency", "3.2s"],
    ["session retry", "2.1s"],
    ["login integration", "7.1s"],
  ].map(([name, duration]) => `<div class="test-row"><span>${escapeHtml(name)}</span><span>${escapeHtml(duration)}</span></div>`).join("");
  return `<section class="workflow-section">
    <div class="section-line"><h2 data-i18n="section.workbench.tests">Tests</h2><span>12.4s</span></div>
    <div class="test-list">${rows}</div>
  </section>`;
}

function renderHandoff(handoff: HandoffState): string {
  return `<section class="handoff" aria-label="Handoff">
    <div>
      <strong data-handoff-text data-handoff-text-en="${escapeHtml(handoff.text)}" data-handoff-text-zh="${escapeHtml(handoff.textZh)}">${escapeHtml(handoff.text)}</strong>
      <span data-handoff-meta data-handoff-meta-en="${escapeHtml(handoff.meta)}" data-handoff-meta-zh="${escapeHtml(handoff.metaZh)}">${escapeHtml(handoff.meta)}</span>
    </div>
    <div class="handoff-actions">
      ${handoff.actions.map((action, index) => `<button type="button" class="${index === 0 ? "primary" : "secondary"}" data-auth-action="${escapeHtml(action.toLowerCase().replaceAll(" ", "-"))}" data-action-label-en="${escapeHtml(action)}" data-action-label-zh="${escapeHtml(handoff.actionsZh[index] ?? action)}">${escapeHtml(action)}</button>`).join("")}
    </div>
  </section>`;
}

function renderSettingRow(label: string, value: string): string {
  return `<div class="setting-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderSystemLine(label: string, state: string, detail: string): string {
  return `<div class="system-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(state)}</strong><span>${escapeHtml(detail)}</span></div>`;
}

function renderCommandSurface(command: CommandState): string {
  const action = command.mode === "running"
    ? "Interrupt"
    : command.mode === "authorization"
      ? "Approve"
      : "Execute";
  const secondary = command.mode === "running"
    ? "Stop"
    : command.mode === "authorization"
      ? "Deny"
      : "Queue";
  return `<section class="command-surface" aria-label="Command Surface" data-command-mode="${escapeHtml(command.mode)}">
    <div class="command-toolbar">
      <span data-command-agent>${escapeHtml(command.agent)}</span>
      <span data-command-build data-command-build-en="${escapeHtml(command.buildMode)}" data-command-build-zh="${escapeHtml(command.buildModeZh)}">${escapeHtml(command.buildMode)}</span>
      <span>${escapeHtml(command.model)}</span>
      <span data-command-autonomy data-command-autonomy-en="${escapeHtml(command.autonomy)}" data-command-autonomy-zh="${escapeHtml(command.autonomyZh)}">${escapeHtml(command.autonomy)}</span>
      <span class="context-chip" data-command-context data-command-context-en="${escapeHtml(command.context)}" data-command-context-zh="${escapeHtml(command.contextZh)}">Context: ${escapeHtml(command.context)}</span>
    </div>
    <textarea aria-label="Workflow command" data-command-input data-command-value-en="${escapeHtml(command.value)}" data-command-value-zh="${escapeHtml(command.valueZh)}">${escapeHtml(command.value)}</textarea>
    <div class="command-footer">
      <div class="utility-actions">
        <button type="button" aria-label="Attach file">@</button>
        <button type="button" aria-label="Reference issue">#</button>
        <button type="button" aria-label="Command shortcut">/</button>
      </div>
      <div class="run-actions">
        <button type="button" class="secondary" data-command-secondary>${escapeHtml(secondary)}</button>
        <button type="button" class="primary" data-command-action>${escapeHtml(action)}</button>
      </div>
    </div>
    <div class="command-hint" data-command-hint data-i18n="command.hint">Use @ for files, # for issues, and / for workflow commands.</div>
  </section>`;
}

function renderContextSurface(view: WorkflowView): string {
  return `<aside class="context-surface" aria-label="Context Surface">
    <div class="context-tabs" role="tablist" aria-label="Context tabs">
      ${(["Diff", "Files", "Terminal", "Logs"] as const).map((tab) => renderContextTab(tab, view.activeContext)).join("")}
    </div>
    <div class="context-body">
      ${renderDiffContext(view.activeContext)}
      ${renderFilesContext(view.activeContext)}
      ${renderTerminalContext(view.activeContext)}
      ${renderLogsContext(view.activeContext)}
    </div>
  </aside>`;
}

function renderContextTab(tab: ContextTab, activeContext: ContextTab): string {
  const active = tab === activeContext ? " active" : "";
  const selected = tab === activeContext ? "true" : "false";
  return `<button class="context-tab${active}" type="button" role="tab" aria-selected="${selected}" data-context-tab="${escapeHtml(tab)}" data-i18n="${escapeHtml(contextTabCopyKey(tab))}">${escapeHtml(tab)}</button>`;
}

function contextTabCopyKey(tab: ContextTab): string {
  switch (tab) {
    case "Diff":
      return "context.diff";
    case "Files":
      return "context.files";
    case "Terminal":
      return "context.terminal";
    case "Logs":
      return "context.logs";
  }
}

function renderDiffContext(activeContext: ContextTab): string {
  return `<section class="context-panel" data-context-panel="Diff"${activeContext === "Diff" ? "" : " hidden"}>
    <div class="context-file">src/lib/auth/session.ts <span class="change add">+32</span> <span class="change remove">-8</span></div>
    <pre class="diff"><code>132  export async function createSession(
133    userId: string,
134    expiresAt: Date
135  ): Promise&lt;Session&gt; {
136-   const session = await db.session.create({
137-     data: { userId, expiresAt },
138-   });
139-   await cache.invalidate(userId);
140-   return session;
136+   return await mutex.runExclusive(async () =&gt; {
137+     const session = await db.session.create({
138+       data: { userId, expiresAt },
139+     });
140+     await cache.invalidate(userId);
141+     return session;
142+   });
143  }</code></pre>
    <div class="context-footer"><span data-i18n="context.hunks">1 of 3 hunks</span> <button type="button" data-i18n="context.showUnchanged">Show unchanged</button></div>
  </section>`;
}

function renderFilesContext(activeContext: ContextTab): string {
  const files = [
    "src/lib/auth/session.ts",
    "src/middleware/auth.ts",
    "src/lib/cache/session-cache.ts",
    "docs/auth.md",
  ].map((file) => `<li>${escapeHtml(file)}</li>`).join("");
  return `<section class="context-panel" data-context-panel="Files"${activeContext === "Files" ? "" : " hidden"}>
    <div class="context-file" data-i18n="context.filesReferenced">Files referenced by current workflow</div>
    <ul class="file-tree">${files}</ul>
  </section>`;
}

function renderTerminalContext(activeContext: ContextTab): string {
  return `<section class="context-panel" data-context-panel="Terminal"${activeContext === "Terminal" ? "" : " hidden"}>
    <div class="context-file" data-i18n="context.latestCommand">Latest command output</div>
    <pre class="terminal"><code>$ pnpm exec vitest run auth
PASS auth concurrency 3.2s
PASS session retry 2.1s
PASS login integration 7.1s</code></pre>
  </section>`;
}

function renderLogsContext(activeContext: ContextTab): string {
  return `<section class="context-panel" data-context-panel="Logs"${activeContext === "Logs" ? "" : " hidden"}>
    <div class="context-file" data-i18n="context.continuityLog">Relay and host continuity log</div>
    <div class="log-lines">
      <span>12:08:31 relay accepted client binding for acme-api</span>
      <span>12:08:34 host prod-host-1 confirmed runtime session restore</span>
      <span>12:08:36 authorization requested for terminal execution</span>
      <span>12:08:41 waiting for human approval</span>
    </div>
  </section>`;
}

function statusLabel(state: SessionState): string {
  switch (state) {
    case "waiting-auth":
      return "Waiting Auth";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
  }
}

function currentSession(sessionId: string): ProductSession {
  return SESSIONS.find((session) => session.id === sessionId) ?? SESSIONS[0];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderClientScript(): string {
  return `<script>
(() => {
  const translations = {
    en: {
      "route.attention": "Attention",
      "route.workbench": "Workbench",
      "route.sessions": "Sessions",
      "route.authorization": "Authorization",
      "route.settings": "Settings",
      "route.system": "System",
      "search.placeholder": "Search sessions, repo, branch, host...",
      "surface.recent": "Recent",
      "surface.filter": "Filter",
      "surface.recentSessions": "Recent sessions",
      "surface.filters": "Filters",
      "surface.empty": "No sessions match the current filter.",
      "surface.newSession": "New Session",
      "filter.all": "All states",
      "state.waiting-auth": "Waiting Auth",
      "state.running": "Running",
      "state.idle": "Idle",
      "status.idleOverview": "Idle overview",
      "status.ready": "Ready",
      "status.live": "Live",
      "status.interruptRequested": "Interrupt requested",
      "theme.light": "Light",
      "theme.dark": "Dark",
      "view.attention.eyebrow": "Session requires human authorization",
      "view.attention.title": "Deploy to production waiting approval",
      "view.workbench.eyebrow": "Operational workflow",
      "view.workbench.title": "Fix login race condition",
      "view.sessions.eyebrow": "Attention queue and durable workflow history",
      "view.sessions.title": "All session memory",
      "view.authorization.eyebrow": "Blocked workflow operations",
      "view.authorization.title": "Authorization decisions",
      "view.settings.eyebrow": "Default runtime behavior",
      "view.settings.title": "Agent and workspace settings",
      "view.system.eyebrow": "Operational health",
      "view.system.title": "Relay, host, and runtime continuity",
      "section.attention.why": "Why this needs attention",
      "section.workbench.analysis": "Authentication flow analysis",
      "section.workbench.modifiedFiles": "Modified files",
      "section.workbench.tests": "Tests",
      "section.sessions.memory": "Attention memory",
      "section.authorization.blocked": "Blocked operations",
      "section.settings.defaults": "Runtime defaults",
      "section.system.continuity": "Continuity state",
      "attention.body": "The deploy session is blocked by a terminal authorization request. The agent has completed release preparation, but production execution requires a human decision before the workflow can continue.",
      "attention.requestedOperation": "Requested operation",
      "attention.deployCommand": "Run production deploy command",
      "attention.scope": "Scope is limited to acme-api on prod-host-1.",
      "attention.latestEvidence": "Latest evidence",
      "attention.migrationPassed": "Migration dry run passed",
      "attention.evidenceBody": "Release diff and smoke output are available in the context surface.",
      "workbench.analysis.body": "I analyzed session creation and identified a race condition during concurrent login. Duplicate session writes can occur before cache invalidation completes.",
      "workbench.finding.duplicate": "Duplicate session writes can occur under high concurrency.",
      "workbench.finding.retry": "The retry path bypasses the session mutex.",
      "workbench.finding.cache": "Cache invalidation happens after the response is sent.",
      "timeline.attention.release": "Release branch prepared",
      "timeline.attention.releaseDetail": "package, migrations, and smoke command were staged",
      "timeline.attention.deploy": "Deploy command requested",
      "timeline.attention.deployDetail": "authorization required before production terminal execution",
      "timeline.attention.handoff": "Human handoff",
      "timeline.attention.handoffDetail": "review scope, then approve once or request constraints",
      "timeline.workbench.opened": "Opened 12 files",
      "timeline.workbench.openedDetail": "auth.ts, session.ts, middleware.ts, session-cache.ts",
      "timeline.workbench.searched": "Searched session creation logic",
      "timeline.workbench.searchedDetail": "8 results in 3 files",
      "timeline.workbench.analyzed": "Analyzed authentication flow",
      "timeline.workbench.analyzedDetail": "2m 14s",
      "sessions.body": "Sessions are sorted by operational attention, not by project taxonomy. Waiting authorization blocks progress, running sessions need observation, and idle sessions are low attention unless they carry failure context.",
      "authorization.body": "Authorization keeps the state model simple while preserving the concrete decision. The product state remains Waiting Auth; the row and canvas explain the requested scope.",
      "settings.body": "Settings are scoped to agents, hosts, and workspaces. Internal relay details stay hidden unless the user opens system diagnostics.",
      "system.body": "System status focuses on relay, host, and runtime continuity. It does not expose ticket, grant, connection id, or route internals in the default surface.",
      "table.session": "Session",
      "table.status": "Status",
      "table.workspace": "Workspace",
      "table.latestEvent": "Latest event",
      "table.updated": "Updated",
      "auth.scope": "Scope",
      "action.approveOnce": "Approve once",
      "action.deny": "Deny",
      "context.diff": "Diff",
      "context.files": "Files",
      "context.terminal": "Terminal",
      "context.logs": "Logs",
      "context.hunks": "1 of 3 hunks",
      "context.showUnchanged": "Show unchanged",
      "context.filesReferenced": "Files referenced by current workflow",
      "context.latestCommand": "Latest command output",
      "context.continuityLog": "Relay and host continuity log",
      "command.contextPrefix": "Context: ",
      "command.execute": "Execute",
      "command.executing": "Executing",
      "command.queue": "Queue",
      "command.interrupt": "Interrupt",
      "command.interrupting": "Interrupting",
      "command.stop": "Stop",
      "command.approve": "Approve",
      "command.approved": "Approved",
      "command.deny": "Deny",
      "command.build": "Build",
      "command.continue": "Continue",
      "command.authorize": "Authorize",
      "command.auto": "Auto",
      "command.manual": "Manual",
      "command.approvalRequired": "Approval required",
      "command.hint": "Use @ for files, # for issues, and / for workflow commands.",
      "command.hintRunning": "Running sessions accept interruption or scoped follow-up instructions.",
      "command.hintAuthorization": "Authorization decisions should be scoped to the current operation.",
      "command.hintIdle": "Idle sessions accept a new workflow continuation command.",
      "command.hintInterruptQueued": "The running session has an interrupt request queued.",
      "command.hintApprovalRecorded": "Approval recorded for the current operation.",
      "command.hintCommandQueued": "Command queued for the selected session.",
      "command.inputRunning": "Interrupt only if the current operation is blocked. Otherwise continue watching the workflow.",
      "command.inputAuthorization": "Review the requested operation scope, then approve once or deny with constraints.",
      "command.inputIdlePrefix": "Continue from the latest idle event: ",
      "command.inputIdleFallback": "review the current state",
      "status.authorizationDenied": "Authorization denied. The agent is waiting for revised constraints.",
      "status.authorizationRecorded": "Authorization recorded. The workflow is ready to continue.",
      "session.selectedFallback": "Session selected.",
      "session.fix-login.title": "Fix login race condition",
      "session.deploy-production.title": "Deploy to production",
      "session.error-messages.title": "Improve error messages"
    },
    zh: {
      "route.attention": "关注",
      "route.workbench": "工作台",
      "route.sessions": "Sessions",
      "route.authorization": "授权",
      "route.settings": "设置",
      "route.system": "系统",
      "search.placeholder": "搜索 session、repo、branch、host...",
      "surface.recent": "最近",
      "surface.filter": "筛选",
      "surface.recentSessions": "最近 session",
      "surface.filters": "筛选",
      "surface.empty": "没有匹配当前条件的 session。",
      "surface.newSession": "新建 Session",
      "filter.all": "全部状态",
      "state.waiting-auth": "等待授权",
      "state.running": "运行中",
      "state.idle": "空闲",
      "status.idleOverview": "空闲概览",
      "status.ready": "就绪",
      "status.live": "在线",
      "status.interruptRequested": "已请求中断",
      "theme.light": "浅色",
      "theme.dark": "深色",
      "view.attention.eyebrow": "Session 需要人工授权",
      "view.attention.title": "生产部署等待授权",
      "view.workbench.eyebrow": "运行中的 workflow",
      "view.workbench.title": "修复登录竞态条件",
      "view.sessions.eyebrow": "注意力队列与持久 workflow 历史",
      "view.sessions.title": "全部 session 记忆",
      "view.authorization.eyebrow": "被阻塞的 workflow 操作",
      "view.authorization.title": "授权决策",
      "view.settings.eyebrow": "默认 runtime 行为",
      "view.settings.title": "Agent 与工作区设置",
      "view.system.eyebrow": "运行状态",
      "view.system.title": "Relay、host 与 runtime 连续性",
      "section.attention.why": "为什么需要处理",
      "section.workbench.analysis": "认证流程分析",
      "section.workbench.modifiedFiles": "修改文件",
      "section.workbench.tests": "测试",
      "section.sessions.memory": "注意力记忆",
      "section.authorization.blocked": "被阻塞的操作",
      "section.settings.defaults": "Runtime 默认设置",
      "section.system.continuity": "连续性状态",
      "attention.body": "部署 session 被终端授权请求阻塞。Agent 已完成发布准备，但生产执行需要人工决策后 workflow 才能继续。",
      "attention.requestedOperation": "请求操作",
      "attention.deployCommand": "运行生产部署命令",
      "attention.scope": "范围限定为 acme-api 上的 prod-host-1。",
      "attention.latestEvidence": "最新证据",
      "attention.migrationPassed": "迁移 dry run 已通过",
      "attention.evidenceBody": "Release diff 和 smoke 输出可在右侧上下文中查看。",
      "workbench.analysis.body": "我已分析 session 创建流程，并识别出并发登录期间的竞态条件。缓存失效完成前，可能发生重复 session 写入。",
      "workbench.finding.duplicate": "高并发下可能发生重复 session 写入。",
      "workbench.finding.retry": "重试路径绕过了 session mutex。",
      "workbench.finding.cache": "缓存失效发生在响应发送之后。",
      "timeline.attention.release": "Release branch 已准备",
      "timeline.attention.releaseDetail": "package、migrations 和 smoke 命令已暂存",
      "timeline.attention.deploy": "部署命令已请求",
      "timeline.attention.deployDetail": "生产终端执行前需要授权",
      "timeline.attention.handoff": "人工交接",
      "timeline.attention.handoffDetail": "检查范围，然后批准一次或要求约束",
      "timeline.workbench.opened": "已打开 12 个文件",
      "timeline.workbench.openedDetail": "auth.ts、session.ts、middleware.ts、session-cache.ts",
      "timeline.workbench.searched": "已搜索 session 创建逻辑",
      "timeline.workbench.searchedDetail": "3 个文件中 8 个结果",
      "timeline.workbench.analyzed": "已分析认证流程",
      "timeline.workbench.analyzedDetail": "2 分 14 秒",
      "sessions.body": "Session 按操作注意力排序，而不是按项目分类排序。等待授权会阻塞进度，运行中的 session 需要观察，空闲 session 只有在携带失败上下文时才需要提高注意力。",
      "authorization.body": "授权在保持状态模型简洁的同时保留具体决策。产品状态仍然是等待授权，session 行和画布负责解释请求范围。",
      "settings.body": "设置按 agent、host 和工作区生效。除非用户打开系统诊断，否则内部 relay 细节应保持隐藏。",
      "system.body": "系统状态聚焦 relay、host 与 runtime 连续性。默认界面不暴露 ticket、grant、connection id 或 route 内部细节。",
      "table.session": "Session",
      "table.status": "状态",
      "table.workspace": "工作区",
      "table.latestEvent": "最新事件",
      "table.updated": "更新时间",
      "auth.scope": "范围",
      "action.approveOnce": "批准一次",
      "action.deny": "拒绝",
      "context.diff": "Diff",
      "context.files": "文件",
      "context.terminal": "终端",
      "context.logs": "日志",
      "context.hunks": "第 1 个，共 3 个 hunk",
      "context.showUnchanged": "显示未变更",
      "context.filesReferenced": "当前 workflow 引用的文件",
      "context.latestCommand": "最新命令输出",
      "context.continuityLog": "Relay 与 host 连续性日志",
      "command.contextPrefix": "上下文：",
      "command.execute": "执行",
      "command.executing": "执行中",
      "command.queue": "排队",
      "command.interrupt": "中断",
      "command.interrupting": "正在中断",
      "command.stop": "停止",
      "command.approve": "批准",
      "command.approved": "已批准",
      "command.deny": "拒绝",
      "command.build": "构建",
      "command.continue": "继续",
      "command.authorize": "授权",
      "command.auto": "自动",
      "command.manual": "手动",
      "command.approvalRequired": "需要授权",
      "command.hint": "使用 @ 引用文件，使用 # 引用 issue，使用 / 调用 workflow 命令。",
      "command.hintRunning": "运行中的 session 支持中断或限定范围的后续指令。",
      "command.hintAuthorization": "授权决策应限定在当前操作范围内。",
      "command.hintIdle": "空闲 session 可以接收新的 workflow 继续命令。",
      "command.hintInterruptQueued": "已为运行中的 session 排队中断请求。",
      "command.hintApprovalRecorded": "当前操作的授权已记录。",
      "command.hintCommandQueued": "命令已加入所选 session 的队列。",
      "command.inputRunning": "仅在当前操作被阻塞时中断。否则继续观察 workflow。",
      "command.inputAuthorization": "检查请求操作的范围，然后批准一次或带约束拒绝。",
      "command.inputIdlePrefix": "从最新空闲事件继续：",
      "command.inputIdleFallback": "检查当前状态",
      "status.authorizationDenied": "授权已拒绝。Agent 正在等待新的约束条件。",
      "status.authorizationRecorded": "授权已记录。Workflow 可以继续执行。",
      "session.selectedFallback": "已选择 session。",
      "session.fix-login.title": "修复登录竞态条件",
      "session.deploy-production.title": "部署到生产环境",
      "session.error-messages.title": "改进错误信息"
    }
  };
  const stateLabelKeys = {
    "waiting-auth": "state.waiting-auth",
    running: "state.running",
    idle: "state.idle"
  };
  const stateTones = {
    "waiting-auth": "amber",
    running: "green",
    idle: "gray"
  };
  let activeStateFilter = "all";
  let activeSelectedRow = null;
  let currentLanguage = readPreference("free-language", "en");
  let currentTheme = readPreference("free-theme", "light");

  const bySelector = (selector) => document.querySelector(selector);
  const allBySelector = (selector) => Array.from(document.querySelectorAll(selector));

  function readPreference(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writePreference(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      return;
    }
  }

  function t(key) {
    return (translations[currentLanguage] && translations[currentLanguage][key]) || translations.en[key] || key;
  }

  function localizedDataset(element, base) {
    if (!element) {
      return "";
    }
    const suffix = currentLanguage === "zh" ? "Zh" : "En";
    return element.dataset[base + suffix] || element.dataset[base + "En"] || "";
  }

  function sessionText(row, field) {
    const prefix = "session" + field.charAt(0).toUpperCase() + field.slice(1);
    return localizedDataset(row, prefix);
  }

  function setStatusByKey(key, tone) {
    const badge = bySelector("[data-status-badge]");
    const text = bySelector("[data-status-label]");
    if (!badge || !text) {
      return;
    }
    badge.classList.remove("green", "amber", "gray");
    badge.classList.add(tone);
    const dot = badge.querySelector(".state-dot");
    if (dot) {
      dot.className = "state-dot " + tone;
    }
    text.dataset.statusKey = key;
    text.removeAttribute("data-i18n");
    text.textContent = t(key);
  }

  function applyTheme(theme) {
    currentTheme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = currentTheme;
    writePreference("free-theme", currentTheme);
    updateThemeToggle();
  }

  function updateThemeToggle() {
    const button = bySelector("[data-theme-toggle]");
    if (button) {
      button.textContent = currentTheme === "dark" ? t("theme.dark") : t("theme.light");
    }
  }

  function updateLanguageToggle() {
    const button = bySelector("[data-language-toggle]");
    if (button) {
      button.textContent = currentLanguage === "zh" ? "EN" : "中文";
    }
  }

  function applySessionLanguage() {
    allBySelector(".session-row").forEach((row) => {
      const title = row.querySelector("[data-session-title-target]");
      const event = row.querySelector("[data-session-event-target]");
      const warning = row.querySelector("[data-session-warning-target]");
      if (title) {
        title.textContent = sessionText(row, "title");
      }
      if (event) {
        event.textContent = sessionText(row, "event");
      }
      if (warning) {
        warning.textContent = sessionText(row, "warning");
      }
    });
    allBySelector("[data-table-title-target]").forEach((item) => {
      item.textContent = localizedDataset(item, "tableTitle");
    });
    allBySelector("[data-table-event-target]").forEach((item) => {
      item.textContent = localizedDataset(item, "tableEvent");
    });
    allBySelector("[data-table-status-target]").forEach((item) => {
      const state = item.dataset.tableStatusState || "idle";
      item.textContent = t(stateLabelKeys[state] || "state.idle");
    });
  }

  function applyLocalizedChrome() {
    allBySelector("[data-i18n]").forEach((element) => {
      element.textContent = t(element.getAttribute("data-i18n"));
    });
    allBySelector("[data-i18n-placeholder]").forEach((element) => {
      element.setAttribute("placeholder", t(element.getAttribute("data-i18n-placeholder")));
    });
  }

  function applyLocalizedStatefulContent() {
    const handoffText = bySelector("[data-handoff-text]");
    const handoffMeta = bySelector("[data-handoff-meta]");
    const build = bySelector("[data-command-build]");
    const autonomy = bySelector("[data-command-autonomy]");
    const context = bySelector("[data-command-context]");
    const input = bySelector("[data-command-input]");
    const status = bySelector("[data-status-label]");
    const command = bySelector(".command-surface");
    if (handoffText && !activeSelectedRow) {
      handoffText.textContent = localizedDataset(handoffText, "handoffText");
    }
    if (handoffMeta && !activeSelectedRow) {
      handoffMeta.textContent = localizedDataset(handoffMeta, "handoffMeta");
    }
    allBySelector("[data-action-label-en]").forEach((button) => {
      button.textContent = localizedDataset(button, "actionLabel");
    });
    if (build && !activeSelectedRow) {
      build.textContent = localizedDataset(build, "commandBuild");
    }
    if (autonomy && !activeSelectedRow) {
      autonomy.textContent = localizedDataset(autonomy, "commandAutonomy");
    }
    if (context && !activeSelectedRow) {
      context.textContent = t("command.contextPrefix") + localizedDataset(context, "commandContext");
    }
    if (input && !activeSelectedRow && document.activeElement !== input) {
      input.value = localizedDataset(input, "commandValue");
    }
    if (status && status.dataset.statusKey) {
      status.textContent = t(status.dataset.statusKey);
    }
    if (command && activeSelectedRow) {
      setCommandForSession(activeSelectedRow);
    } else {
      updateCommandActionLabels();
    }
  }

  function applyLanguage(language) {
    currentLanguage = language === "zh" ? "zh" : "en";
    document.documentElement.lang = currentLanguage === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.language = currentLanguage;
    writePreference("free-language", currentLanguage);
    applyLocalizedChrome();
    applySessionLanguage();
    applyLocalizedStatefulContent();
    updateThemeToggle();
    updateLanguageToggle();
    updateSessionFilters();
  }

  function setCommandForSession(row) {
    const state = row.dataset.sessionState || "idle";
    const command = bySelector(".command-surface");
    const agent = bySelector("[data-command-agent]");
    const build = bySelector("[data-command-build]");
    const autonomy = bySelector("[data-command-autonomy]");
    const context = bySelector("[data-command-context]");
    const input = bySelector("[data-command-input]");
    const primary = bySelector("[data-command-action]");
    const secondary = bySelector("[data-command-secondary]");
    const hint = bySelector("[data-command-hint]");
    if (!command || !agent || !build || !autonomy || !context || !input || !primary || !secondary || !hint) {
      return;
    }

    agent.textContent = row.dataset.sessionAgent || "Agent";
    context.textContent = t("command.contextPrefix") + (row.dataset.sessionRepo || "repo") + " / " + (row.dataset.sessionBranch || "branch");

    if (state === "running") {
      command.dataset.commandMode = "running";
      build.textContent = t("command.build");
      autonomy.textContent = t("command.auto");
      primary.textContent = t("command.interrupt");
      secondary.textContent = t("command.stop");
      input.value = t("command.inputRunning");
      hint.textContent = t("command.hintRunning");
    } else if (state === "waiting-auth") {
      command.dataset.commandMode = "authorization";
      build.textContent = t("command.authorize");
      autonomy.textContent = t("command.approvalRequired");
      primary.textContent = t("command.approve");
      secondary.textContent = t("command.deny");
      input.value = t("command.inputAuthorization");
      hint.textContent = t("command.hintAuthorization");
    } else {
      command.dataset.commandMode = "execute";
      build.textContent = t("command.continue");
      autonomy.textContent = t("command.manual");
      primary.textContent = t("command.execute");
      secondary.textContent = t("command.queue");
      input.value = t("command.inputIdlePrefix") + (sessionText(row, "event") || t("command.inputIdleFallback")) + ".";
      hint.textContent = t("command.hintIdle");
    }
  }

  function updateCommandActionLabels() {
    const command = bySelector(".command-surface");
    const primary = bySelector("[data-command-action]");
    const secondary = bySelector("[data-command-secondary]");
    const mode = command ? command.dataset.commandMode : "execute";
    if (!primary || !secondary) {
      return;
    }
    if (mode === "running") {
      primary.textContent = t("command.interrupt");
      secondary.textContent = t("command.stop");
    } else if (mode === "authorization") {
      primary.textContent = t("command.approve");
      secondary.textContent = t("command.deny");
    } else {
      primary.textContent = t("command.execute");
      secondary.textContent = t("command.queue");
    }
  }

  function selectSession(row) {
    activeSelectedRow = row;
    allBySelector(".session-row").forEach((item) => item.classList.toggle("selected", item === row));
    const title = bySelector("[data-canvas-title]");
    const eyebrow = bySelector("[data-canvas-eyebrow]");
    const handoff = bySelector("[data-handoff-text]");
    const state = row.dataset.sessionState || "idle";
    if (title) {
      title.removeAttribute("data-i18n");
      title.textContent = sessionText(row, "title") || "Session";
    }
    if (eyebrow) {
      eyebrow.removeAttribute("data-i18n");
      eyebrow.textContent = (row.dataset.sessionRepo || "workspace") + " / " + (row.dataset.sessionBranch || "branch") + " / " + (row.dataset.sessionHost || "host");
    }
    if (handoff) {
      handoff.textContent = sessionText(row, "event") || t("session.selectedFallback");
    }
    setStatusByKey(stateLabelKeys[state] || "state.idle", stateTones[state] || "gray");
    setCommandForSession(row);
  }

  function updateSessionFilters() {
    const search = bySelector("[data-session-search]");
    const query = search ? search.value.trim().toLowerCase() : "";
    let visibleCount = 0;

    allBySelector(".session-row").forEach((row) => {
      const searchText = currentLanguage === "zh" ? row.dataset.sessionSearchZh : row.dataset.sessionSearchEn;
      const matchesQuery = !query || (searchText || "").includes(query);
      const matchesState = activeStateFilter === "all" || row.dataset.sessionState === activeStateFilter;
      const visible = matchesQuery && matchesState;
      row.hidden = !visible;
      if (visible) {
        visibleCount += 1;
      }
    });

    allBySelector(".session-section").forEach((section) => {
      const visibleRows = Array.from(section.querySelectorAll(".session-row")).filter((row) => !row.hidden);
      section.hidden = visibleRows.length === 0;
      const count = section.querySelector(".section-heading span:last-child");
      if (count) {
        count.textContent = String(visibleRows.length);
      }
    });

    const empty = bySelector("[data-empty-search]");
    if (empty) {
      empty.hidden = visibleCount !== 0;
    }
  }

  const tabs = document.querySelectorAll("[data-context-tab]");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.getAttribute("data-context-tab");
      document.querySelectorAll("[data-context-panel]").forEach((panel) => {
        panel.hidden = panel.getAttribute("data-context-panel") !== target;
      });
      tabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", active ? "true" : "false");
      });
    });
  });

  allBySelector(".session-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      selectSession(row);
    });
  });

  const search = bySelector("[data-session-search]");
  if (search) {
    search.addEventListener("input", updateSessionFilters);
  }

  allBySelector("[data-popover-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.getAttribute("data-popover-toggle");
      allBySelector("[data-popover]").forEach((popover) => {
        popover.hidden = popover.getAttribute("data-popover") !== target ? true : !popover.hidden;
      });
    });
  });

  allBySelector("[data-state-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activeStateFilter = button.getAttribute("data-state-filter") || "all";
      allBySelector("[data-state-filter]").forEach((item) => {
        item.classList.toggle("active-filter", item === button);
      });
      updateSessionFilters();
    });
  });

  allBySelector("[data-jump-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.getAttribute("data-jump-session");
      const row = bySelector('[data-session-id="' + id + '"]');
      if (row) {
        selectSession(row);
        row.scrollIntoView({ block: "nearest" });
      }
      allBySelector("[data-popover]").forEach((popover) => {
        popover.hidden = true;
      });
    });
  });

  document.querySelectorAll("[data-auth-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const text = document.querySelector("[data-handoff-text]");
      if (text) {
        const action = button.getAttribute("data-auth-action") || "";
        if (action.includes("deny") || action === "request-changes") {
          text.textContent = t("status.authorizationDenied");
          setStatusByKey("state.idle", "gray");
        } else {
          text.textContent = t("status.authorizationRecorded");
          setStatusByKey("state.running", "green");
        }
      }
    });
  });

  document.querySelectorAll("[data-command-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const command = bySelector(".command-surface");
      const hint = bySelector("[data-command-hint]");
      const mode = command ? command.dataset.commandMode : "execute";
      if (mode === "running") {
        button.textContent = t("command.interrupting");
        setStatusByKey("status.interruptRequested", "amber");
        if (hint) {
          hint.textContent = t("command.hintInterruptQueued");
        }
      } else if (mode === "authorization") {
        button.textContent = t("command.approved");
        setStatusByKey("state.running", "green");
        if (hint) {
          hint.textContent = t("command.hintApprovalRecorded");
        }
      } else {
        button.textContent = t("command.executing");
        setStatusByKey("state.running", "green");
        if (hint) {
          hint.textContent = t("command.hintCommandQueued");
        }
      }
    });
  });

  const themeToggle = bySelector("[data-theme-toggle]");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      applyTheme(currentTheme === "dark" ? "light" : "dark");
    });
  }

  const languageToggle = bySelector("[data-language-toggle]");
  if (languageToggle) {
    languageToggle.addEventListener("click", () => {
      applyLanguage(currentLanguage === "zh" ? "en" : "zh");
    });
  }

  applyTheme(currentTheme);
  applyLanguage(currentLanguage);
})();
</script>`;
}

function renderStyles(): string {
  return `      :root {
        color-scheme: light;
        --bg: oklch(0.962 0.006 286);
        --shell: oklch(0.984 0.004 286);
        --surface: oklch(0.995 0.003 286);
        --surface-2: oklch(0.948 0.007 286);
        --surface-3: oklch(0.906 0.009 286);
        --ink: oklch(0.215 0.016 286);
        --muted: oklch(0.47 0.015 286);
        --soft: oklch(0.67 0.011 286);
        --text-2: oklch(0.36 0.014 286);
        --line: oklch(0.88 0.008 286);
        --line-strong: oklch(0.72 0.012 286);
        --accent: oklch(0.52 0.16 282);
        --accent-soft: oklch(0.93 0.026 282);
        --accent-line: oklch(0.72 0.07 282);
        --green: oklch(0.54 0.13 154);
        --green-soft: oklch(0.936 0.032 154);
        --amber: oklch(0.61 0.13 74);
        --amber-soft: oklch(0.95 0.035 74);
        --amber-line: oklch(0.78 0.075 74);
        --red: oklch(0.58 0.16 28);
        --red-soft: oklch(0.95 0.036 28);
        --primary-ink: oklch(0.985 0.004 286);
        --diff-ink: oklch(0.37 0.015 286);
        --agent-codex-bg: oklch(0.93 0.022 238);
        --agent-codex-fg: oklch(0.48 0.09 238);
        --agent-gemini-bg: oklch(0.93 0.026 286);
        --agent-gemini-fg: oklch(0.5 0.11 286);
        --agent-cursor-bg: oklch(0.93 0.028 154);
        --agent-cursor-fg: oklch(0.45 0.1 154);
        --shadow: 0 18px 42px rgb(23 21 31 / 0.12);
      }

      :root[data-theme="dark"] {
        color-scheme: dark;
        --bg: oklch(0.145 0.012 286);
        --shell: oklch(0.18 0.012 286);
        --surface: oklch(0.205 0.012 286);
        --surface-2: oklch(0.25 0.014 286);
        --surface-3: oklch(0.29 0.014 286);
        --ink: oklch(0.91 0.011 286);
        --muted: oklch(0.64 0.014 286);
        --soft: oklch(0.46 0.012 286);
        --text-2: oklch(0.76 0.014 286);
        --line: oklch(0.31 0.012 286);
        --line-strong: oklch(0.43 0.017 286);
        --accent: oklch(0.68 0.15 282);
        --accent-soft: oklch(0.255 0.045 282);
        --accent-line: oklch(0.52 0.095 282);
        --green: oklch(0.68 0.14 154);
        --green-soft: oklch(0.25 0.04 154);
        --amber: oklch(0.76 0.12 74);
        --amber-soft: oklch(0.205 0.018 74);
        --amber-line: oklch(0.34 0.045 74);
        --red: oklch(0.67 0.16 28);
        --red-soft: oklch(0.25 0.045 28);
        --primary-ink: oklch(0.98 0.004 286);
        --diff-ink: oklch(0.82 0.014 286);
        --agent-codex-bg: oklch(0.26 0.04 238);
        --agent-codex-fg: oklch(0.76 0.09 238);
        --agent-gemini-bg: oklch(0.25 0.045 286);
        --agent-gemini-fg: oklch(0.76 0.1 286);
        --agent-cursor-bg: oklch(0.24 0.04 154);
        --agent-cursor-fg: oklch(0.76 0.11 154);
        --shadow: 0 18px 42px rgb(0 0 0 / 0.22);
      }

      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font: 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button, input, textarea { font: inherit; }
      button {
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      a { color: inherit; text-decoration: none; }
      code, pre, textarea {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      .app-frame {
        height: 100vh;
        display: grid;
        grid-template-rows: 52px minmax(0, 1fr);
        background: var(--bg);
      }
      .topbar {
        display: grid;
        grid-template-columns: 360px minmax(0, 1fr) 420px;
        border-bottom: 1px solid var(--line);
        background: var(--surface);
      }
      .brand-zone, .project-zone, .runtime-zone {
        min-width: 0;
        display: flex;
        align-items: center;
      }
      .brand-zone {
        gap: 14px;
        padding: 0 12px;
        border-right: 1px solid var(--line);
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 9px;
        font-size: 15px;
        font-weight: 760;
      }
      .brand-mark {
        display: grid;
        place-items: center;
        width: 25px;
        height: 25px;
        border-radius: 7px;
        background: var(--accent-soft);
        color: var(--accent);
        font-weight: 820;
      }
      .search {
        min-width: 0;
        height: 34px;
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 9px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--bg);
        color: var(--muted);
      }
      .search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--ink);
      }
      .shortcut {
        border-left: 1px solid var(--line);
        padding-left: 8px;
        white-space: nowrap;
      }
      .project-zone {
        justify-content: space-between;
        gap: 18px;
        padding: 0 22px;
      }
      .crumbs {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 240px;
        font-weight: 720;
      }
      .project-icon {
        display: grid;
        place-items: center;
        width: 18px;
        height: 18px;
        border: 1px solid var(--line-strong);
        border-radius: 4px;
        font-size: 10px;
        color: var(--muted);
      }
      .crumb-muted { color: var(--muted); }
      .view-nav {
        display: flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
      }
      .route-link {
        padding: 5px 7px;
        border-radius: 6px;
        color: var(--muted);
        white-space: nowrap;
      }
      .route-link.active {
        color: var(--ink);
        background: var(--accent-soft);
      }
      .runtime-zone {
        justify-content: flex-end;
        gap: 9px;
        padding: 0 14px;
        color: var(--muted);
      }
      .topbar-toggle {
        height: 26px;
        min-width: 52px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--shell);
        color: var(--muted);
        padding: 0 8px;
        font-weight: 680;
      }
      .topbar-toggle:hover {
        color: var(--ink);
        border-color: var(--line-strong);
        background: var(--surface-2);
      }
      .runtime-separator {
        width: 1px;
        height: 18px;
        background: var(--line);
      }
      .live-dot, .state-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 999px;
      }
      .live-dot, .state-dot.green, .state-dot.running { background: var(--green); }
      .state-dot.amber, .state-dot.waiting-auth { background: var(--amber); }
      .state-dot.gray, .state-dot.idle { background: var(--soft); }
      .avatar {
        display: grid;
        place-items: center;
        width: 26px;
        height: 26px;
        border-radius: 999px;
        background: var(--surface-3);
        color: var(--ink);
        font-weight: 760;
      }
      .workspace {
        min-height: 0;
        display: grid;
        grid-template-columns: 280px minmax(520px, 1fr) 336px;
      }
      .session-surface {
        min-height: 0;
        overflow: auto;
        padding: 12px;
        border-right: 1px solid var(--line);
        background: var(--bg);
        position: relative;
      }
      .surface-tools {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-bottom: 12px;
      }
      .surface-popover {
        margin: 0 0 10px;
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        box-shadow: var(--shadow);
      }
      .surface-popover strong {
        display: block;
        margin: 0 0 6px;
        color: var(--muted);
        font-size: 11px;
      }
      .surface-popover button {
        width: 100%;
        justify-content: flex-start;
        text-align: left;
        margin-top: 4px;
      }
      .surface-popover button.active-filter {
        color: var(--accent);
        border-color: var(--accent-line);
        background: var(--accent-soft);
      }
      .empty-search {
        margin: 8px 0 12px;
        padding: 10px;
        color: var(--muted);
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
      }
      .small-button, .icon-button {
        height: 28px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
        color: var(--ink);
        padding: 0 9px;
      }
      .session-section { margin-bottom: 15px; }
      .section-heading {
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: var(--muted);
        font-weight: 760;
        position: sticky;
        top: -12px;
        background: var(--bg);
        z-index: 1;
      }
      .session-list {
        display: grid;
        gap: 5px;
      }
      .session-row {
        min-height: 66px;
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) 40px;
        gap: 9px;
        align-items: start;
        padding: 9px 9px;
        border: 1px solid transparent;
        border-radius: 7px;
      }
      .session-row:hover { background: var(--surface); border-color: var(--line); }
      .session-row.selected {
        background: var(--surface-2);
        border-color: var(--accent-line);
      }
      .session-row.waiting {
        background: var(--amber-soft);
        border-color: var(--amber-line);
      }
      .agent-mark {
        display: grid;
        place-items: center;
        width: 24px;
        height: 24px;
        border-radius: 7px;
        font-weight: 800;
        font-size: 10px;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .agent-mark.codex { background: var(--agent-codex-bg); color: var(--agent-codex-fg); }
      .agent-mark.gemini { background: var(--agent-gemini-bg); color: var(--agent-gemini-fg); }
      .agent-mark.cursor { background: var(--agent-cursor-bg); color: var(--agent-cursor-fg); }
      .agent-mark.custom { background: var(--surface-2); color: var(--muted); }
      .agent-mark.muted { opacity: 0.68; }
      .row-main {
        min-width: 0;
        display: grid;
        gap: 2px;
      }
      .row-title {
        font-weight: 760;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-meta, .row-event {
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .row-event { color: var(--text-2); }
      .row-side {
        display: grid;
        justify-items: end;
        gap: 12px;
        color: var(--muted);
        font-size: 11px;
      }
      .warning-marker {
        margin-left: 6px;
        color: var(--red);
        font-weight: 720;
      }
      .new-session {
        display: block;
        padding: 10px;
        color: var(--accent);
        font-weight: 720;
      }
      .workflow-canvas {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto auto;
        padding: 18px 24px 24px;
        background: var(--shell);
      }
      .canvas-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 14px;
      }
      .eyebrow {
        color: var(--muted);
        font-weight: 700;
        margin-bottom: 5px;
      }
      h1 {
        margin: 0;
        font-size: 23px;
        line-height: 1.15;
        letter-spacing: 0;
      }
      h2 {
        margin: 0 0 8px;
        font-size: 14px;
        line-height: 1.25;
        letter-spacing: 0;
      }
      p {
        margin: 0;
        color: var(--text-2);
        max-width: 82ch;
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 5px 8px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--muted);
        white-space: nowrap;
      }
      .status-badge.green { background: var(--green-soft); color: var(--green); }
      .status-badge.amber { background: var(--amber-soft); color: var(--amber); }
      .canvas-body {
        min-height: 0;
        overflow: auto;
        display: grid;
        align-content: start;
        gap: 12px;
      }
      .workflow-section {
        padding: 9px 0;
        border-top: 1px solid var(--line);
      }
      .workflow-section:first-child { border-top: 0; padding-top: 0; }
      .findings {
        margin: 10px 0 0;
        padding-left: 18px;
        color: var(--text-2);
      }
      .decision-layout {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
        margin-top: 12px;
      }
      .decision-block {
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface);
      }
      .field-label {
        display: block;
        margin-bottom: 4px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 720;
      }
      .event-line {
        min-height: 28px;
        display: grid;
        grid-template-columns: 20px minmax(180px, 0.6fr) minmax(0, 1fr);
        align-items: center;
        gap: 8px;
      }
      .event-icon {
        width: 13px;
        height: 13px;
        border: 2px solid var(--accent);
        border-radius: 999px;
      }
      .event-title, .table-title { font-weight: 760; }
      .event-detail, .test-row span:last-child, .system-line span:last-child { color: var(--muted); }
      .section-line, .file-row, .test-row, .setting-row, .system-line, .auth-row {
        display: grid;
        align-items: center;
        gap: 10px;
      }
      .section-line {
        grid-template-columns: minmax(0, 1fr) auto auto;
        margin-bottom: 8px;
      }
      .file-list, .test-list, .settings-list, .system-lines, .auth-list {
        display: grid;
        border: 1px solid var(--line);
        border-radius: 7px;
        overflow: hidden;
        background: var(--surface);
      }
      .file-row {
        grid-template-columns: minmax(0, 1fr) 42px 42px 80px;
        padding: 7px 10px;
        border-top: 1px solid var(--line);
      }
      .file-row:first-child, .test-row:first-child, .setting-row:first-child, .system-line:first-child, .auth-row:first-child {
        border-top: 0;
      }
      .change.add { color: var(--green); }
      .change.remove { color: var(--red); }
      .spark {
        height: 8px;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--green) 0 72%, var(--amber) 72% 84%, var(--red) 84% 100%);
      }
      .spark.green { background: linear-gradient(90deg, var(--green) 0 86%, var(--red) 86% 100%); }
      .test-row, .setting-row, .system-line {
        grid-template-columns: minmax(0, 1fr) auto;
        padding: 7px 10px;
        border-top: 1px solid var(--line);
      }
      .system-line { grid-template-columns: 130px 110px minmax(0, 1fr); }
      .setting-row strong { text-align: right; }
      .handoff {
        margin-top: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 8px 10px;
        border: 1px solid var(--line);
        border-radius: 7px;
        background: var(--surface-2);
      }
      .handoff div:first-child {
        display: grid;
        gap: 2px;
      }
      .handoff span { color: var(--muted); }
      .handoff-actions, .auth-actions, .run-actions, .utility-actions {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      button, .primary, .secondary {
        height: 30px;
        border-radius: 7px;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        padding: 0 10px;
      }
      .primary {
        border-color: var(--accent);
        background: var(--accent);
        color: var(--primary-ink);
        font-weight: 760;
      }
      .secondary { background: var(--surface); }
      .dense-table {
        width: 100%;
        border-collapse: collapse;
        border: 1px solid var(--line);
        border-radius: 7px;
        overflow: hidden;
        background: var(--surface);
      }
      .dense-table th, .dense-table td {
        padding: 10px 11px;
        border-top: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }
      .dense-table th {
        color: var(--muted);
        font-size: 11px;
        font-weight: 760;
        background: var(--surface-2);
      }
      .dense-table td:first-child {
        display: grid;
        gap: 2px;
      }
      .auth-row {
        grid-template-columns: minmax(0, 1fr) 180px auto;
        padding: 12px;
        border-top: 1px solid var(--line);
      }
      .auth-row > div:first-child {
        display: grid;
        gap: 2px;
      }
      .command-surface {
        margin-top: 8px;
        border: 1px solid var(--accent-line);
        border-radius: 8px;
        background: var(--surface);
        overflow: hidden;
      }
      .command-toolbar {
        min-height: 30px;
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--line);
      }
      .command-toolbar span {
        min-height: 22px;
        display: inline-flex;
        align-items: center;
        padding: 0 8px;
        border: 1px solid var(--line);
        border-radius: 6px;
        color: var(--muted);
        background: var(--shell);
      }
      .command-toolbar .context-chip {
        margin-left: auto;
        border-color: transparent;
        background: transparent;
      }
      textarea {
        display: block;
        width: 100%;
        min-height: 58px;
        resize: vertical;
        border: 0;
        outline: 0;
        padding: 10px 12px;
        background: var(--surface);
        color: var(--ink);
        line-height: 1.45;
      }
      .command-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 6px 8px;
      }
      .utility-actions button {
        width: 30px;
        padding: 0;
      }
      .command-hint {
        padding: 0 10px 8px;
        color: var(--muted);
        font-size: 11px;
      }
      .context-surface {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        border-left: 1px solid var(--line);
        background: var(--surface);
        display: grid;
        grid-template-rows: 48px minmax(0, 1fr);
      }
      .context-tabs {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        border-bottom: 1px solid var(--line);
      }
      .context-tab {
        height: 48px;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--muted);
        border-bottom: 2px solid transparent;
        font-weight: 720;
      }
      .context-tab.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }
      .context-body {
        min-height: 0;
        overflow: auto;
      }
      .context-panel {
        min-height: 100%;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
      }
      .context-file {
        min-height: 42px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 13px;
        border-bottom: 1px solid var(--line);
        font-weight: 760;
      }
      .diff, .terminal {
        margin: 0;
        padding: 14px;
        overflow: auto;
        background: var(--shell);
        color: var(--diff-ink);
        font-size: 11px;
        line-height: 1.7;
      }
      .terminal {
        background: oklch(0.13 0.012 286);
        color: oklch(0.82 0.03 154);
      }
      .file-tree, .log-lines {
        margin: 0;
        padding: 12px 14px;
        display: grid;
        gap: 9px;
        align-content: start;
      }
      .file-tree { list-style: none; }
      .log-lines span {
        padding-bottom: 8px;
        border-bottom: 1px solid var(--line);
        color: var(--text-2);
      }
      .context-footer {
        min-height: 42px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        border-top: 1px solid var(--line);
        color: var(--muted);
      }
      [hidden] { display: none !important; }

      @media (max-width: 1180px) {
        .topbar {
          grid-template-columns: 320px minmax(0, 1fr);
        }
        .runtime-zone { display: none; }
        .workspace {
          grid-template-columns: 260px minmax(0, 1fr);
        }
        .context-surface { display: none; }
      }`;
}
