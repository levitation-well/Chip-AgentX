# v1.1 第二阶段需求：受控芯片资料访问原型

日期：2026-04-29
分支：`v1.1-chip-access`

## 1. 背景与目标

当前仓库已经完成 AgentX 初版 demo：可以通过 CLI、HTTP/SSE、Web UI 和 MCP 驱动 Claude Code 等 AI agent，并支持 Claude Code 的多轮 conversation 模式。这个基础能力已经能证明"网页和 AI agent 工具 MCP 可以接入"。

第二阶段的目标是在现有 demo 基础上，收敛成一个本机可跑通的外部试用原型，用于半导体资料受控访问：

- 外部用户通过网页账号登录后，在授权范围内查询芯片资料。
- 客户的代码工具通过 MCP 接入，使用配置 key 调用芯片资料问答工具。
- Claude Code 按芯片型号进入对应资料目录，依靠工作目录控制资料查询范围。
- 系统提示词由配置文件和 Markdown 文件维护，可按入口和场景控制注入时机。

**第二阶段不是云端商用安全版。明文密码、全局 MCP Key、未沙箱化 Claude Code 都只适合本机或内部试用，云端开放前必须升级。**

## 2. 范围

### 包含

- Web 本地账号密码登录，使用 session cookie 维持登录态
- RBAC 角色模型：`admin`、`internal`、`customer`
- Web 聊天页必须选择芯片型号，第一版只支持 `E521.39`
- MCP 调用可省略芯片型号，默认使用 `E521.39`
- 每个芯片配置一个资料目录，Claude Code 在该芯片目录作为 `cwd` 启动
- 系统提示词由 `global + role + chip` 三层组合
- 提示词注入策略可配置，支持 `first_turn` 和 `every_turn`
- 中台页面管理芯片、提示词、用户/角色、MCP 全局 Key
- 继续沿用现有 stdio MCP server，新增或包装芯片问答工具

### 不包含

- 自助注册
- 数据库
- 审计日志页面
- 文件级资料权限隔离
- Docker 沙箱
- per-key MCP 权限
- 企业 SSO/OAuth

## 3. 核心功能需求

### 3.1 用户认证 (AUTH)

| REQ-ID | 需求 | 描述 |
|--------|------|------|
| AUTH-01 | 网页端登录 | 用户可以通过账号密码登录系统，登录成功后获得会话令牌 |
| AUTH-02 | 登录状态保持 | 登录状态通过 Session/Cookie 保持，支持会话过期 |
| AUTH-03 | MCP KEY 认证 | MCP 接入需要配置 API KEY 进行认证，KEY 与用户绑定 |

### 3.2 芯片选择 (CHIP)

| REQ-ID | 需求 | 描述 |
|--------|------|------|
| CHIP-01 | 芯片选择器 | 网页对话界面上有芯片型号选择器（目前仅支持 E521.39） |
| CHIP-02 | 工作目录映射 | 系统根据用户选择的芯片型号，配置 Claude Code 的工作目录 |
| CHIP-03 | 目录配置管理 | 管理员可以在中台网页配置芯片与工作目录的映射关系 |

### 3.3 系统提示词 (SYS)

| REQ-ID | 需求 | 描述 |
|--------|------|------|
| SYS-01 | 提示词注入 | 每次用户提问前，自动插入系统提示词到 Claude Code 上下文 |
| SYS-02 | 提示词配置 | 系统提示词保存在 md 文件中，可在网页端配置和编辑 |
| SYS-03 | 提示词场景 | 支持多个提示词场景（如内部研发、外部经销商），可按场景切换 |

## 4. 配置文件结构

### 4.1 目录结构

```
config/
  app.json      # 应用配置（提示词注入策略等）
  chips.json    # 芯片配置
  users.json    # 用户配置
  roles.json    # 角色配置
  mcp.json      # MCP 配置

prompts/
  global.md     # 全局提示词
  roles/
    admin.md
    internal.md
    customer.md
  chips/
    E521.39.md  # 芯片专用提示词

knowledge/
  E521.39/
    datasheet.md
    application-notes.md
    register-map.md
```

### 4.2 角色定义

| 角色 | 权限 | 描述 |
|------|------|------|
| admin | 所有权限 | 管理员，可访问中台配置 |
| internal | Web + MCP + E521.39 | 内部员工，可使用完整功能 |
| customer | Web + E521.39 | 外部客户，仅限网页访问和指定芯片 |

## 5. 验收标准

### 5.1 Web 登录

- `admin`、`internal`、`customer` 三类账号可登录
- 未登录访问聊天页或中台页会被拦截
- 非 `admin` 访问中台页会被拒绝

### 5.2 芯片选择与目录控制

- Web 聊天页必须选择芯片
- 第一版渲染 `E521.39`
- 创建会话时前端只传 `chipModel`，不传任意 `cwd`
- 后端把 `E521.39` 映射到配置里的 `workspaceDir`，Claude Code 在该目录启动

### 5.3 提示词注入

- 系统能读取 `global + role + chip` 三段 `.md`
- Web 可按 `first_turn` / `every_turn` 策略注入
- MCP 调用会注入对应提示词
- 缺失提示词文件时返回清楚错误，不直接启动 Claude Code

### 5.4 中台配置

- `admin` 能查看和修改芯片配置
- `admin` 能查看和修改提示词文件
- `admin` 能查看和修改用户和角色配置
- `admin` 能查看和修改 MCP 全局 Key、默认角色、默认芯片
- 保存配置时做基础校验

### 5.5 MCP 接入

- `agentx mcp` 继续可启动
- 未提供或提供错误 MCP Key 时，芯片问答工具拒绝调用
- 正确 MCP Key 下，`query_chip_datasheet` 可用
- `chipModel` 省略时默认 `E521.39`
- 默认 MCP 角色为 `internal`，且可配置

## 6. 已知限制

- 明文密码只能用于本机 demo 或内部试用
- 全局 MCP Key 只能用于本机 demo 或内部试用
- 未沙箱化 Claude Code 不适合直接开放到公网
- 同一个芯片目录内的资料默认对授权角色全部可见

## 7. 后续升级（云端外部开放前必须）

- 密码哈希或企业账号登录
- per-key MCP 权限
- Docker 沙箱或只读资料目录
- 审计日志
- 按客户/角色隔离资料目录

---

*需求文档创建：2026-04-29*
