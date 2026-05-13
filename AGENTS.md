# AGENTS.md instructions for /Users/dev/Free

1. 当消息中出现 "你知道吧"、"你懂我啥意思吧"、"懂?"、"你懂我啥意思吗" 等类似含义的词时，无论消息里是否同时包含具体任务描述，都必须立即停止执行，先用自己的话逐条复述对需求的理解，等用户明确确认后再动手。
2. 所有分析回答必须严格基于项目实际代码，严禁主观臆测，所有回答必须使用中文。
3. 文案规范：用词严谨正式，禁止使用 emoji 等非正式表达（适用于技术文档/代码注释/API 文档）。
4. 月报/总结等文本应有思考深度和个人观点，避免机械罗列，像真人写的。
5. 我维护的项目都是顶级基金会的开源项目，请注意代码质量和可维护性，不要过度设计。
6. 源码统一维护在 ~/dev/ 目录下。分析任何仓库前先去 ~/dev/ 查找是否已存在；需要拉取远程源码也统一 clone 到 ~/dev/ 下，不重复克隆。
7. Git 分支命名规范：新功能 `feature/<name>`，Bug 修复 `bugfix/<name>`。
8. 实现任何 Web、客户端、工作台、产品界面或交互功能时，从设计和代码第一刻起同时考虑 Expo、React Native、React Native Web、Electron 四端架构。优先保证 React Native 与 React Native Web 共享业务组件、状态模型和设计 token；Electron 作为桌面容器承载同一 Workbench Web/RN Web 产品面，不另起一套桌面 UI。
9. 所有界面实现必须默认考虑多端自适应体验，包括大屏桌面、小屏桌面、平板和移动端。不得只按当前浏览器宽度实现单一布局；导航、主内容、操作按钮、空状态、错误状态和文本换行都必须在多尺寸下保持可用。
10. 本地开发端口边界固定为：`8790` 是 Workbench Web 产品入口，`8791` 是 relay/API/OAuth/ACP 协议入口。不得把产品页面维护在 `8791`；`8791` 只处理协议、API、回调和服务端必须处理的登录步骤。
11. 产品 UI 必须 API-first。没有真实 API 支撑的页面、导航项、状态、卡片、计数、会话、授权队列、日志、迁移状态、runtime 控制、附件入口等，不得先做假布局或假功能。需要展示某能力时，先补 API、类型、测试，再接 UI。
12. relay Worker 不承载长期产品 UI。Worker-rendered HTML 只能用于尚未 API 化的协议必要步骤，并应优先导回 Workbench；一旦 Workbench 有对应页面和 API，确认、授权、诊断等用户可见界面都应维护在 Workbench。
13. 当前产品聚焦 bridge 兼容层与 Session Workbench。界面与文案应围绕 account session、host discovery、relay health、authorization、session continuity 等真实 bridge 能力，不得引入 fake project、fake deploy、fake repository、generic dashboard 或与当前聚焦无关的功能。
14. 品牌视觉应保持趣味、未来感、高饱和、几何化、年轻但精致的高端创意科技气质。默认复用 `../agentbridge/apps/free/app` 中已有 Free 图标、字体和可用素材；图标默认使用 Hugeicons。需要新增图片素材时再使用图片生成器，不用临时低质占位。
15. 本地浏览器验收和 Playwright 自动化默认使用 Chrome Canary（`--channel chrome-canary` / `channel: "chrome-canary"`）。如果工具落到普通 Chrome 或 Chrome Beta，不能把结果当作有效 UI 验收。
16. 登录与授权流程必须保持同一产品世界观。GitHub OAuth callback 可以由 relay/API 处理 code，但用户确认页、错误页、完成态应尽量回到 `8790` Workbench 维护，样式、布局和交互不得与 Workbench 割裂。
17. 遇到用户指出“假数据”“与当前聚焦无关”“风格不统一”“端口边界不对”时，先回到真实 API、真实路由和当前产品目标重新收敛，不要继续修饰错误方向。
18. 新增或修改任何页面时，必须先接入统一多语言文案层，默认中文并支持 English。不得只在局部按钮或设置页做多语言；导航、标题、空状态、错误状态、加载状态、确认页、登录页都必须同步覆盖。
19. bridge、auth、host 的默认 relay 环境是 `online`，对应线上 relay；本地测试统一使用 `--relay-env local`，对应 `ws://127.0.0.1:8791`。不要要求用户手记本地 URL；只有自定义部署才使用 `--relay-url <ws-url>`。
20. Cloudflare 部署时必须区分域名职责：Workbench Web 是产品 UI 域名，relay/API 是 Worker 协议域名。GitHub OAuth 的用户可见 callback 应配置到 Workbench `/login/callback`，relay 只处理 `/api/login/callback` 的 token exchange 和协议/API。

Never use these patterns — they are all ways of asking permission to continue. Just do the work:

- "如果你要，我下一步可以..."
- "你要我直接...吗？"
- "要不要我帮你..."
- "是否需要我..."
- "我可以帮你...，要我做吗？"
- "下一步可以..."（as an offer, not a description of what you ARE doing）
- Any sentence ending with "...吗？" that asks whether to proceed with implementation

Instead: "接下来我会 xxx" then execute.
