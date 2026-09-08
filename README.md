# Chip-AgentX

A multi-agent session lifecycle manager for AI coding agents, exposing HTTP/SSE and MCP APIs for controlling, observing, and terminating isolated agent sessions. It powers a multi-tenant web control plane and a datasheet knowledge-base retrieval system for chip documentation.

[English](#english) | [简体中文](#简体中文)

---

## English

### Features

- **Multi-agent session lifecycle management** — create, send, poll, log, and kill concurrent sessions for coding agents (`claude-code`, `codex`, `opencode`, `pi`).
- **HTTP/SSE API** — RESTful endpoints plus server-sent events for real-time streaming output and state changes.
- **MCP transport** — both stdio and Remote MCP (Streamable HTTP) support, so external clients can spawn and drive agents through the Model Context Protocol.
- **Multi-tenant authentication and authorization** — JWT-based login, role-based access, MCP key scoping, and chip/datasheet resource grants.
- **Chip datasheet knowledge-base retrieval** — isolated workspaces per session, scoped discovery across brands, product lines, chips, and documents, with citation tracking.
- **Credit ledger** — per-user credit reservations and settlements for agent usage.
- **Web control plane** — static multi-page portal (`/`, `/chat`, `/admin`, `/login`, `/account`, `/mcp-access`, `/tickets`) served directly by the HTTP server.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Chip-AgentX                          │
├──────────────┬─────────────────────┬────────────────────────┤
│   CLI        │   HTTP Server       │   MCP Server           │
│  (cac)       │  (node:http + SSE)  │ (stdio / StreamableHTTP│
├──────────────┴─────────────────────┴────────────────────────┤
│           Public Portal + Chat + Admin + Tickets            │
├─────────────────────────────────────────────────────────────┤
│         Auth Layer (JWT + MCP Key + Role Grants)            │
├─────────────────────────────────────────────────────────────┤
│   Product Config + Announcements + Tickets + Credits        │
├─────────────────────────────────────────────────────────────┤
│              SessionManager (core)                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Registry   │  │  Supervisor │  │      Adapters       │  │
│  │  (Map)      │  │ (tree-kill) │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│     PtyAdapter (node-pty)      │     ChildAdapter          │
│     codex / opencode / pi      │     claude-code           │
└─────────────────────────────────────────────────────────────┘
```

### Quick Start

Requirements:

- Node.js >= 20
- npm >= 10
- A C++ toolchain for building native dependencies (node-pty)

Install and build:

```bash
git clone https://github.com/levitation-well/Chip-AgentX.git
cd Chip-AgentX
npm install
npm run build
```

Start the HTTP/Web server locally without authentication:

```bash
node dist/cli/index.js server --no-auth --port 3000
```

Then open http://127.0.0.1:3000 in your browser.

Start the MCP stdio server:

```bash
export MCP_API_KEY="<your-mcp-key>"
node dist/cli/index.js mcp
```

### Configuration

Copy the example configuration files in `config/` from their `.example.json` counterparts and edit them for your deployment:

- `config/roles.json` — roles and permissions
- `config/chips.json` — chip catalog and workspace mappings
- `config/prompts.json` — system prompts
- `config/product.json` — public portal branding and feature flags

Create a `.env` file based on `.env.example`. At minimum you will usually need:

- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_USER` / `ADMIN_PASSWORD_HASH`
- `DATA_DIR` (or `AGENTX_DATA_DIR`)
- `MCP_API_KEY` (for the stdio MCP server)

### Deployment

For production deployment guidance — including public Remote MCP reverse proxy, TLS, limits, and Remote MCP client examples such as `agentx_whoami` — see [docs/linux-deploy.md](./docs/linux-deploy.md).

### Testing

```bash
npm test         # run the Vitest suite
npm run typecheck # TypeScript strict-mode check
```

### License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**.

contact the author at merlin_working@outlook.com or open an issue in this repository.

See [LICENSE](./LICENSE) for the full legal text.

---

## 简体中文

### 功能特性

- **多智能体会话生命周期管理** —— 为 `claude-code`、`codex`、`opencode`、`pi` 等编码智能体创建、发送、轮询、读取日志和终止并发会话。
- **HTTP/SSE API** —— 提供 RESTful 端点和服务器推送事件，实时流式输出会话内容与状态变化。
- **MCP 传输** —— 同时支持 stdio 与 Remote MCP（Streamable HTTP），外部客户端可通过 Model Context Protocol 驱动智能体。
- **多租户认证与授权** —— 基于 JWT 的登录、角色权限、MCP Key 作用域、芯片与文档资源授权。
- **芯片 datasheet 知识库检索** —— 每个会话拥有隔离工作空间，支持按品牌、产品线、芯片、文档等维度做范围检索，并记录引用来源。
- **积分账本** —— 按用户进行积分预留与结算，控制智能体使用成本。
- **Web 控制面** —— 多页静态门户（`/`、`/chat`、`/admin`、`/login`、`/account`、`/mcp-access`、`/tickets`）由 HTTP 服务器直接服务。

### 架构简图

```
┌─────────────────────────────────────────────────────────────┐
│                        Chip-AgentX                          │
├──────────────┬─────────────────────┬────────────────────────┤
│   CLI        │   HTTP Server       │   MCP Server           │
│  (cac)       │  (node:http + SSE)  │ (stdio / StreamableHTTP│
├──────────────┴─────────────────────┴────────────────────────┤
│           公开门户 + Chat + Admin + 工单系统                 │
├─────────────────────────────────────────────────────────────┤
│         认证层（JWT + MCP Key + 角色授权）                   │
├─────────────────────────────────────────────────────────────┤
│   产品配置 + 公告 + 工单 + 积分                              │
├─────────────────────────────────────────────────────────────┤
│              SessionManager（核心）                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Registry   │  │  Supervisor │  │      Adapters       │  │
│  │  （内存 Map）│  │ (tree-kill) │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│     PtyAdapter (node-pty)      │     ChildAdapter          │
│     codex / opencode / pi      │     claude-code           │
└─────────────────────────────────────────────────────────────┘
```

### 快速开始

环境要求：

- Node.js >= 20
- npm >= 10
- 用于编译原生依赖（node-pty）的 C++ 构建工具链

安装并构建：

```bash
git clone https://github.com/levitation-well/Chip-AgentX.git
cd Chip-AgentX
npm install
npm run build
```

本地免认证启动 HTTP/Web 服务器：

```bash
node dist/cli/index.js server --no-auth --port 3000
```

然后在浏览器打开 http://127.0.0.1:3000。

启动 MCP stdio 服务器：

```bash
export MCP_API_KEY="<your-mcp-key>"
node dist/cli/index.js mcp
```

### 配置说明

将 `config/` 目录下的 `.example.json` 示例文件复制为同名 `.json` 文件并按需修改：

- `config/roles.json` —— 角色与权限
- `config/chips.json` —— 芯片目录与工作空间映射
- `config/prompts.json` —— 系统提示词
- `config/product.json` —— 公开门户品牌与功能开关

根据 `.env.example` 创建 `.env` 文件。通常至少需要：

- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_USER` / `ADMIN_PASSWORD_HASH`
- `DATA_DIR`（或 `AGENTX_DATA_DIR`）
- `MCP_API_KEY`（stdio MCP 服务器使用）

### 部署说明

生产部署指南（包括公网 Remote MCP 反向代理、TLS、限流、客户端配置示例如 `agentx_whoami`）见 [docs/linux-deploy.md](./docs/linux-deploy.md)。

### 测试

```bash
npm test         # 运行 Vitest 测试套件
npm run typecheck # TypeScript 严格模式检查
```

### 许可证

本项目采用 **PolyForm Noncommercial License 1.0.0**

作者：merlin_working@outlook.com，或在本仓库提交 Issue。

完整法律文本见 [LICENSE](./LICENSE)。
