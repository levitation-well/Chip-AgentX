# AgentX 认证与 MCP KEY

Phase 4 起，`agentx server` 默认启用认证。HTTP API 使用 JWT，MCP stdio 使用 MCP KEY。

## .env 配置

从 `.env.example` 创建 `.env`：

```env
JWT_SECRET=replace-with-at-least-32-characters
JWT_EXPIRES_IN=24h
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=$2a$10$replace-with-bcrypt-hash
DATA_DIR=./data
MCP_API_KEY=replace-with-user-mcp-key
```

生成管理员密码 hash：

```bash
node -e "import('bcryptjs').then(async b => console.log(await b.hash('change-me', 10)))"
```

`data/users.json` 保存用户和 KEY 数据，不应提交到 git。完整 MCP KEY 只在创建时显示一次。

## 启动 Web/API

```bash
npx agentx server --port 3000
```

本地开发如需关闭认证：

```bash
npx agentx server --no-auth
```

Web 路由：

- `/` 登录
- `/chat` 用户聊天
- `/admin` 管理员用户与 MCP KEY 控制台

## 管理员流程

1. 打开 `/`，使用 `ADMIN_USER` 和对应明文密码登录。
2. 进入 `/admin`。
3. 创建普通用户。
4. 选择用户，输入 KEY 名称并生成 MCP KEY。
5. 复制生成响应中的完整 KEY；列表之后只显示 id/name/createdAt/lastUsed。

## MCP stdio

配置 `MCP_API_KEY` 后启动：

```bash
MCP_API_KEY=<user-key> npx agentx mcp
```

MCP KEY 与用户绑定。通过该 KEY 创建的会话只对对应用户可见。

## Remote MCP 权限自查

公网或内网 Remote MCP 客户端连接 `/mcp` 后，应先调用无参数只读工具 `agentx_whoami`。该工具只返回当前 MCP KEY 绑定的安全摘要：当前 `user`、`mcp.keyId`/`mcp.fingerprint`、可调用的 `allowedActions`、可见 `resources[]`、服务端 `limits` 和一句 `summary`。

`agentx_whoami` 不返回完整 MCP KEY、`Authorization` header、JWT、Cookie、密码 hash、环境变量 secret、其他用户信息或真实服务器路径。`permissions.cwdExposed` 固定为 `false`；chips 启用时，外部客户端用 `resources[].id` 作为后续 `agent_spawn.chipId`，由服务端解析 workspace。

## HTTP 调用

登录：

```bash
curl -X POST http://127.0.0.1:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-me"}'
```

携带 token：

```bash
curl http://127.0.0.1:3000/sessions \
  -H "Authorization: Bearer <token>"
```
