# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **本文件与仓库根目录 `AGENTS.md` 是同一份指南的两个镜像**（Claude / Codex 各一份）。除文件顶部这三行 CC 专属头外，正文应保持一致：改了一个必须同步另一个（见「架构统一与防漂移 · 单一事实源清单」）。

## 项目

**Coding Agent Lifecycle Manager（编码智能体生命周期管理器）/ Chip-AgentX**

一个服务端后端服务，管理多个编码智能体（Claude Code、Codex、OpenCode、Pi）的会话——创建、控制、监控、终止——通过 Web/HTTP-SSE 与 MCP 协议暴露多租户 API，使外部开发者能通过 AI 智能体查询**芯片数据手册（datasheet）知识库**。

**核心价值：** 一个可控、可观察、多实例的 PTY/进程管理器，让任意数量并发用户在隔离工作空间中驱动 AI 编码智能体运行，支持流式输出与完整会话生命周期控制，经 HTTP/SSE 与 MCP 暴露。

## 约束条件（红线）

- **运行时**：Node.js ≥ 20，ESM 模块；全程 TypeScript 严格模式。
- **PTY**：用 `@lydell/node-pty`（Windows 自动 ConPTY）；`claude-code` 用 `--print` 走 `child_process` 回退（PTY 与 `--dangerously-skip-permissions` 冲突）。
- **构建/测试**：`tsup` 输出 ESM+CJS；Vitest 单测。
- **依赖最小化**：不引重型框架，优先原生 `http`。
- **安全**：智能体进程不得在其指定工作空间之外拥有写权限。
- **Agent 后端范围（当前）**：默认启用并开发 `claude-code` 后端；`codex` / `opencode` / `pi` 代码保留但**暂不开发、暂不投用**。默认 `agentType`、示例与文档一律以 `claude-code` 为准。
- **Agent 语言边界**：开发 agent 与用户对话用中文；除与用户直接对话以外的场景（给其他 agent、工具、代码注释、提交说明、文档片段、日志、外部协作上下文）默认用英文。
- **版本同步**：当前版本 **2.2.45**，版本号以 `package.json` 为准。每次修改仓库内容都必须同步修改产品版本号，并检查 `package.json`、`package-lock.json`、`CHANGELOG.md`、版本断言测试、CLI/MCP/API `/api/version` 与 UI 显示是否一致。
- **资源版本同步**：每次改 `public/`、`webui/` 或任何浏览器可缓存静态资源，必须同步 bump 资源版本号（HTML 中的 `?v=...`）并更新相关测试断言，避免浏览器/CDN 加载旧资源。
- **HTTP 缓存策略**：HTML 用 `Cache-Control: no-cache, no-store, must-revalidate`；带 `?v=` 的 JS/CSS 用 `public, max-age=31536000, immutable`。不得给静态资源用单独的 `no-cache`（无 ETag/Last-Modified 时浏览器行为不确定）。
- **bfcache 防护**：所有 HTML 必须经 `product-shell.js` 加载 `pageshow` 监听，在 bfcache 恢复时自动 `reload()`。新增 HTML 不得遗漏。
- **开发分支约束**：每次开发都必须先新建独立 Git 分支再改；本地与 `.worktrees/` 下都不得直接在现有开发分支上继续叠加新需求。分支名以目标版本号 `VX.X.X-` 前缀开头（如 `V2.2.10-xxx`）。
- **纯文档维护例外**：仅改 `CLAUDE.md` / `AGENTS.md` / `docs/` 等不影响产品行为、不属浏览器可缓存资源的文档，按文档维护处理，**不触发版本号 bump**。

## 架构统一与防漂移（单一事实源清单）

> 核心诉求：**架构统一、不要「改着改着代码飞了」**。下面每一项都是一个 single source of truth；动到它附近时，先回到本清单确认没有 fork 出第二套实现/配置/样式。

| 关注点 | 唯一事实源 | 反模式（禁止） |
| --- | --- | --- |
| 会话动作逻辑 + schema | `src/server/session-actions.ts`（`createSessionActions` / `AgentActionSchemas`），HTTP 与 MCP 共用 | 在 http-server 和 mcp-server 各写一份动作逻辑 |
| WebUI 视觉 | `public/styles.css` 的设计 token + 组件类；`webui/src/` 运行时重映射成皮肤 | 硬编码颜色、平行调色板、第二套组件库 |
| 跨会话待办 | GitHub Issues | 把待办散落在代码注释/临时文档 |
| 产品版本号 | `package.json` 为准 | 只改一两处导致版本漂移 |
| 静态资源版本 | HTML 里的 `?v=...` 查询参数 | 改了 public 资源不 bump `?v=` |
| Agent 后端 | 仅 `claude-code` | 文档/示例/测试出现 codex 等默认值 |
| 前端交付 | `public/` 运行时实时读取；唯一构建产物是 `public/assets/agentx-webui.{js,css}` | 把前端整体打包进后端 bundle |
| 本指南 | `CLAUDE.md` ↔ `AGENTS.md` 互为镜像 | 只改一个，两份说法不一致 |

**防漂移工作法：**
1. 动手前先找现有实现/约定**复用**，不新建平行实现；确需新组件时**扩展**现有体系（如扩 `styles.css` token），而非另起一套。
2. 新需求先开 `VX.X.X-` 分支，不在旧分支上叠加。
3. 发现 bug / 技术债 / 未接线功能 → 落 GitHub Issue，不要只留代码注释。
4. 改了协议、版本、资源、样式、文档任一「事实源」，按上表回查其镜像/同步点。
5. **每个改动先做一次全局影响排查**：本项目已较大，一处改动常牵连前端、后端、协议、测试、文档、静态资源等多处。动手前/收尾时都要确认改动是否波及其它位置（前后端契约、HTTP↔MCP 双路径、测试断言、`?v=` 资源版本、镜像文档等），不要只盯当前文件。

## 常用命令

所有命令在仓库根执行；脚本本身跨平台。

| 任务 | 命令 | 说明 |
| --- | --- | --- |
| 安装依赖 | `npm install` | 首次或依赖变更后 |
| 全量测试 | `npm test` | `vitest run`，跑 `src/**/*.test.ts` + `tests/**/*.test.ts` |
| 监听测试 | `npm run test:watch` | `vitest` 监听 |
| 单文件测试 | `npx vitest run tests/http-server.test.ts` | 路径相对仓库根；`-t "<用例名片段>"` 只跑某个 `it` |
| 类型检查 | `npm run typecheck` | `tsc --noEmit`，严格模式 |
| 构建后端 | `npm run build` | `tsup` 输出 `dist/`（ESM + CJS + d.ts） |
| 构建前端组件 | `npm run build:webui` | `vite build`，把 `webui/src/main.tsx` 打包成 `public/assets/agentx-webui.{js,css}` |

启动本地服务器（HTTP/Web 控制面）：

```powershell
# 开发期免认证（仅本地）：
node bin/agentx server --no-auth --port 3000
# 或先构建再用构建产物：
npm run build; node dist/cli/index.js server --no-auth
```

- `bin/agentx` 只是 `import '../dist/cli/index.js'` 的薄包装，**必须先 `npm run build`**；开发期可直接 `node dist/cli/index.js <cmd>`。
- `server` 默认绑定 `127.0.0.1:3000`，可用 `--host/--port/--public-dir/--data-dir/--product-config/--file-logs` 调整。生产需配 `.env`，不要用 `--no-auth`。
- 静态 Web 资源默认从 `public/` **实时**读取，改 `public/` 下文件无需重新构建后端即可生效。

启动 MCP stdio 服务器：

```powershell
$env:MCP_API_KEY = "<用户 MCP key>"; node dist/cli/index.js mcp
```

其它 CLI 子命令（`src/cli/commands/` 各一个文件）：`spawn`、`exec`、`log`、`poll`、`kill`、`list`、`mcp`、`server`、`fingerprint`、`user`、`admin`。结构化输出 JSON 到 stdout。

环境变量（参考 `.env.example`，`dotenv` 加载）：`JWT_SECRET`、`JWT_EXPIRES_IN`、`ADMIN_USER`、`ADMIN_PASSWORD_HASH`（bcrypt）、`DATA_DIR`（或 `AGENTX_DATA_DIR`）、`MCP_API_KEY`、`CHIP_CONFIG_FILE`。运行期配置在 `config/`（`roles.json`、`chips.json`、`prompts.json`、`user-chip-access.json` 等，均有 `.example.json` 模板）。

## 代码架构

### 核心生命周期（PTY/进程管理）

对外门面是 `SessionManager`（`src/session-manager.ts`），组合三块：

- **ProcessRegistry**（`src/registry.ts`）：内存持有所有会话状态（`Map`），冒泡底层 adapter 的 `output`/`exit`/`state` 事件。
- **Supervisor**（`src/supervisor.ts`）：管「无输出超时」（默认 5 分钟）与进程终止（`tree-kill` 杀整树）；Windows 上 `exitOnLastSession` 默认开启以处理 ConPTY 清理。
- **Adapters**（`src/adapters/`）：`createAdapter(agentType, opts)` 工厂——
  - `PtyAdapter`（`pty-adapter.ts`）：`codex`/`opencode`/`pi` 走 `@lydell/node-pty`。
  - `ChildAdapter` / `ClaudeCodeConversationAdapter`（`child-adapter.ts`）：`claude-code` 走 `child_process` 的 `--print` 模式。

`SessionManager` 经 `EventEmitter` 向上游推流式输出与状态。会话动作的统一实现与 Zod schema 在 `src/server/session-actions.ts`，HTTP 与 MCP 两条协议路径**共用**它（见单一事实源清单）。

### 两条对外协议路径

- **HTTP / SSE**（`src/http-server.ts`，`createHttpServer`/`startHttpServer`）：原生 Node `http`。承载会话动作、SSE 流、认证、admin、芯片/提示词治理、积分、**静态 Web UI 服务**。体量最大，许多子能力以 `src/server/`、`src/auth/`、`src/security/`、`src/scope/` 等拆出后在此装配。
- **MCP**（`src/mcp-server.ts`，`createMcpServer`/`startMcpServer`）：`@modelcontextprotocol/sdk`。`agentx mcp` 走 `StdioServerTransport`；HTTP 服务器内还挂 `StreamableHTTPServerTransport`（Remote MCP over HTTP）。工具名集中在 `AGENTX_MCP_TOOL_NAMES`：`agentx_whoami`、`agent_spawn`、`agent_log`、`agent_send`、`agent_poll`、`agent_kill`、`agent_list`。

### 关键支撑模块

- `src/auth/`：JWT、用户存储（bcrypt）、角色（`roles.ts`）、认证中间件、登录/账户路由（`routes.ts`）、MCP key 治理。
- `src/persistence/`：JSON 文件 + 内存的持久化运行时（`runtime.ts`/`json-file.ts`/`paths.ts`），会话历史与提问账本（`session-history-store.ts`、`question-ledger.ts`）。数据落 `DATA_DIR`。
- `src/chips/` + `src/scope/` + `src/security/` + `src/source-citations/`：芯片 datasheet 知识库的工作空间解析、可见性/授权、检索范围（scope preset/分片）、答案契约与引用来源清洗——**「查询芯片 datasheet」业务核心**。
- `src/prompts/` + `src/prompt-governance-store.ts`：系统提示词目录、按角色注入、治理历史。
- `src/model-catalog.ts` / `src/credits.ts` / `src/search-modes.ts`：模型目录与授权、积分账本、检索模式（含图片输入能力）解析。
- `src/admin/`、`src/announcements/`、`src/tickets/`、`src/product/`、`src/fingerprint/`、`src/observability/`、`src/i18n/`、`src/logging/`：后台只读视图、公告、工单、产品壳/版本与 changelog、客户端指纹、指标/留存/脱敏、多语言、结构化日志。

### 前端 public/ 与后端的关系

`public/` 是多页静态站点（`index.html`/`chat.html`/`admin.html`/`login.html`/`account.html`/`mcp-access.html`/`tickets.html` 等，配套同名 `.js` 与共享 `styles.css`、`assets/`、`i18n.js`）。后端**不打包前端**，而在 `tryServeStaticAsset`（`src/http-server.ts`）按路由从磁盘 `publicDir` **实时读取返回**（带越界防护 `isPathInside` 与缓存头）。`public/assets/agentx-webui.{js,css}` 是唯一需构建的产物，来源 `webui/src/`（React + Tailwind，`npm run build:webui`）。`public/demos/` 是 chat 皮肤离线参考页，不参与运行时。

## 关键约定

- **ESM + 严格 TS**：`"type": "module"`，`tsconfig` 开 `strict` + `noUnusedLocals/Parameters` + `noImplicitReturns`；`moduleResolution: "Bundler"`。
- **导入必须带 `.js` 扩展名**：源码用 TS，但相对导入一律写 `./foo.js`（如 `import { SessionManager } from './session-manager.js'`），否则 ESM 解析失败。
- **构建外部化**：`tsup.config.ts` 把 `@lydell/node-pty`、`@modelcontextprotocol/sdk`、`tree-kill`、`cac`、`zod` 标 external；CJS 注入 `createRequire` banner。版本号与 changelog 经 `define`（`__AGENTX_PACKAGE_VERSION__` / `__AGENTX_CHANGELOG_MARKDOWN__`）构建期注入。
- **Windows / ConPTY**：终止进程在 Windows 上可能有延迟，见 `Supervisor` 与 `session-actions.ts`（搜 `ConPTY`）。
- **claude-code 走 `--print` 回退**：每个 turn 是一次短命 `claude --print` 子进程，会话连续性靠 `claudeSessionId` 续接。
- **协议逻辑单点**：改会话动作只动 `src/server/session-actions.ts`，HTTP 与 MCP 同时受益；不要两处各写。

## 测试约定

- 测试在 `tests/`（也允许 `src/**/*.test.ts`），用 Vitest（`globals: true`、`environment: 'node'`、超时 30s）。文件多按 phase/模块命名。
- **Web UI 测试是「合约断言」而非渲染测试**：`tests/web-ui*.test.ts` 用 `readPublicFile()` 直读 `public/` 源文件，配 `jsdom` 对 DOM 结构与 CSS **文本内容**断言。**不运行布局/渲染引擎**，故 CSS 实际布局/视觉正确性需浏览器实机验证。
- **全量测试期望**：`npm test` 应全绿；`tests/web-ui.test.ts` 或认证重定向用例失败时不再按历史 baseline 自动忽略，先确认是否由本次改动/资源版本/认证行为引入。

## 技术栈速查

> 仅留落地速查。

| 层 | 技术 | 版本/形态 | 备注 |
| --- | --- | --- | --- |
| 运行时 | Node.js | ≥ 20 LTS | ESM；node-pty 要求 |
| 语言 | TypeScript | 6.x 严格模式 | `moduleResolution: Bundler` |
| PTY | `@lydell/node-pty` | 1.2.0-beta.12 | Windows 自动 ConPTY；codex/opencode/pi 用 |
| 非交互进程 | `child_process` | 内置 | claude-code `--print` 回退 |
| 构建（后端） | `tsup` | 8.5.1 | ESM + CJS + d.ts |
| 构建（前端） | `vite` | — | `webui/src` → `public/assets/agentx-webui.{js,css}` |
| 测试 | `vitest` | 4.1.5 | node 环境，超时 30s |
| HTTP/SSE | Node `http` | 内置 | 原生，无重型框架 |
| MCP | `@modelcontextprotocol/sdk` | v1.x | stdio + StreamableHTTP |
| 校验 | `zod` | latest | session-actions schema |
| CLI | `cac` | latest | 子命令解析 |
| 会话状态 | `Map`（内存） | — | 多实例持久化未来可上 Redis |

## UI 风格组件复用与统一规范

当用户要求把某页面/组件「改成和另一个页面一样」「使用同款导航/卡片/按钮/输入框/皮肤」「风格统一」时，先理解为**设计系统复用与视觉契约对齐**，而非单点 CSS 微调。

执行顺序：

1. **先找样板组件**：确认基准页面/组件/皮肤/状态（例：以 `/home` 的 `portal-topbar` 胶囊导航为准）。
2. **再查真实复用路径**：比较 HTML 结构、body/page 外壳 class、共享 CSS 选择器、皮肤变量、JS 注入槽位与 active/current 状态来源。
3. **优先接入已有组件体系**：让目标页面复用样板的 class、外壳、token、皮肤变量与交互槽位；不要为「看起来相似」复制一套平行 CSS。
4. **删除/收敛页面专用覆盖**：旧页面若有更高优先级局部选择器覆盖共享样式，应移除或降级，让共享规则成为唯一视觉来源。
5. **保留业务布局边界**：只统一被点名的组件与外壳，不顺手重做主体布局/数据流/业务交互。
6. **同步测试契约**：测试从旧私有组件名改为共享组件契约（如 `portal-topbar`、`data-portal-auth`、`data-agentx-skin-root`、`aria-current="page"`）。
7. **验收用 DOM/样式值辅助，视觉由用户确认**：可自动检查 computed style、尺寸、当前态、皮肤槽、可点击性、路由；不要用截图替代用户视觉接受。

参考案例：Chat 页导航看似已有 `landing-topbar portal-topbar float-nav`，但因 `body` 缺 `portal-page portal-workspace-page` 且有 `body.chat-page .portal-topbar` 局部覆盖，未真正复用首页胶囊导航。修复 = 让 Chat 接入 portal 外壳并删除 Chat 专用覆盖，使 `/chat` 与 `/home` 共用同一套导航样式/皮肤变量/当前态契约。Chat 工作台组件族（左侧会话列表、更新日志区、对话画布、底部 Composer、芯片选择胶囊、输入框、发送按钮、标准/增强/多模态分段、错误提示）须统一到同一套 surface/border/radius/shadow/blur/spacing/font-weight/active·hover·focus 与主题变量，不允许部分组件仍用旧浅色卡片、部分用新深色背景。

### Admin 管理台样式约束

- admin 页面固定使用 shadcn 灰阶主题（oklch token），不参与门户/聊天的多皮肤切换体系。
- admin 相关 CSS 禁止新增硬编码色值，一律引用 token；发现新写的样式绕开 token 直接写死颜色，视为回归，需改为引用既有或新扩展的 token。
- 共享组件类（密集表格、筛选条、主从布局、抽屉、tab、徽标、选择器、空态、错误横幅）为单一来源，禁止各分区再写平行实现；新分区需要组件级样式时，先扩展共享组件类定义，不在页面级或分区级另起一套视觉相同的实现。
- admin 各组件的视觉形状与 token 以 `public/styles.css` 的设计 token 与共享组件类为准。典型例：徽标（`.admin-badge`，状态 / 角色 / 来源指示）为**胶囊**（`border-radius: 999px`）；token 选择器标签（`.admin-token`，可增删的多选标签）为**圆角矩形**（`border-radius: 6px`）——两者形状是**有意区分**（状态指示 vs 可编辑标签），不是历史漂移，不要把徽标改成圆角矩形去"对齐"token。要改任何 admin 组件的形状、尺寸或 token，必须**先更新 `public/styles.css` 中对应的共享组件类定义（改契约），再改具体页面实现，二者同批提交**；禁止只改实现不改契约——那会让代码与设计契约脱节，正是"改着改着飞了"的根源。
