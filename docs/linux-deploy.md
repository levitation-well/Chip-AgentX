# AgentX Linux x86_64 单机部署说明

本文档面向 Linux x86_64 单机部署。目标是把当前 AgentX HTTP/Web 服务运行在一个长期在线的 Linux 主机上，使用本地文件目录保存 session、question ledger 与 application/audit logs。

## 目标环境

- Linux x86_64
- Node.js >= 20
- npm >= 10
- 可写的持久化磁盘目录，用于 `AGENTX_DATA_DIR`
- 已按需要安装底层 AI agent 命令，例如 `claude`、`codex`、`opencode` 或项目配置中使用的命令

## 安装与构建

```bash
git clone <repo-url>
cd <repo-dir>
npm install
npm run build
npm run typecheck
npm test
```

`npm run build` 会生成 `dist/`，CLI 入口为 `bin/agentx`，package bin 名称为 `agentx`。在源码目录内可直接运行：

```bash
node bin/agentx server --host 127.0.0.1 --port 3000
```

如果已经通过 npm 包方式安装，也可以使用：

```bash
agentx server --host 127.0.0.1 --port 3000
```

生产环境建议绑定在反向代理后的本地地址；如果需要直接对外监听，请显式设置 `--host 0.0.0.0` 并确保上层网络、安全组和认证配置已就绪。

## 关键环境变量

### 数据目录

`AGENTX_DATA_DIR` 是推荐的主配置项：

```bash
export AGENTX_DATA_DIR=/opt/chip-agentx/data
```

`DATA_DIR` 仍作为兼容 fallback 保留；当 `AGENTX_DATA_DIR` 未设置时，服务会读取 `DATA_DIR`。两者都没有设置时，默认使用当前工作目录下的 `./data`。

数据目录下会创建：

- `sessions/`：session meta、transcript、raw output、lifecycle events
- `questions/`：question ledger JSONL
- `logs/`：application/audit JSONL 文件日志

服务用户必须能读写以上目录。目录不可写时，persistence runtime 初始化会失败，并通过 stdout/application logger 输出包含 `dataDir` 的诊断信息。

### JWT/Auth

HTTP/Web 默认启用认证，需要配置：

```bash
export JWT_SECRET=replace-with-at-least-32-characters
export JWT_EXPIRES_IN=24h
export ADMIN_USER=admin
export ADMIN_PASSWORD_HASH='$2a$10$replace-with-bcrypt-hash'
```

生成 bcrypt hash 示例：

```bash
node -e "import('bcryptjs').then(async b => console.log(await b.hash('change-me', 10)))"
```

MCP stdio 认证使用每个用户的 MCP KEY；本地测试或脚本环境可通过：

```bash
export MCP_API_KEY=replace-with-user-mcp-key
```

仅本地开发可使用 `--no-auth` 关闭 HTTP 认证；不要在可被他人访问的 Linux 服务上使用该选项。

### 日志配置

CLI 支持文件日志和保留天数：

```bash
node bin/agentx server --file-logs --log-retention-days 30
```

当前服务默认把结构化日志写到 stdout。只有传入 `--file-logs` 时，application/audit 日志才会额外写入 `AGENTX_DATA_DIR/logs`。

日志级别由代码中的 logger 调用决定；目前 application logger 会写 `debug`、`info`、`warn`、`error` 结构化 JSON 记录，audit logger 以 `info` 记录审计事件。部署侧通常用 systemd/journald 或外部采集器消费 stdout。

日志保留规则：

- `data/logs` 下 `app-YYYY-MM-DD.jsonl` 与 `audit-YYYY-MM-DD.jsonl` 默认保留 30 天。
- `session transcript`、`question ledger`、`raw output` 不属于 30 天日志清理范围。
- 日志清理只作用于 `logs/`，不会清理 `sessions/` 或 `questions/`。

## data 目录权限

建议创建专用服务用户：

```bash
sudo useradd --system --home /opt/chip-agentx --shell /usr/sbin/nologin agentx
sudo mkdir -p /opt/chip-agentx/data
sudo chown -R agentx:agentx /opt/chip-agentx
sudo chmod 750 /opt/chip-agentx /opt/chip-agentx/data
```

启动前可预创建子目录，也可以让服务初始化时自动创建：

```bash
sudo -u agentx mkdir -p /opt/chip-agentx/data/sessions /opt/chip-agentx/data/questions /opt/chip-agentx/data/logs
```

如果 `sessions/`、`questions/` 或 `logs/` 不可写，服务应视为启动失败；请检查 systemd journal 中的 `persist_error` 或 `data_dir_initialized` 相关记录。

## systemd 示例

示例假设代码位于 `/opt/chip-agentx`，持久化数据位于 `/opt/chip-agentx/data`。

```ini
[Unit]
Description=AgentX HTTP and Web server
After=network.target

[Service]
Type=simple
User=agentx
Group=agentx
WorkingDirectory=/opt/chip-agentx
Environment=NODE_ENV=production
Environment=AGENTX_DATA_DIR=/opt/chip-agentx/data
Environment=JWT_SECRET=replace-with-at-least-32-characters
Environment=JWT_EXPIRES_IN=24h
Environment=ADMIN_USER=admin
Environment=ADMIN_PASSWORD_HASH=$2a$10$replace-with-bcrypt-hash
ExecStart=/usr/bin/node /opt/chip-agentx/bin/agentx server --host 127.0.0.1 --port 3000 --file-logs --log-retention-days 30
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

启用与查看日志：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agentx
sudo systemctl status agentx
journalctl -u agentx -f
```

stdout/journald 是主日志通道；`--file-logs` 仅作为本地 application/audit JSONL 副本。

## 重启恢复语义

服务启动时会初始化 persistence runtime，并扫描历史 session：

- `turnState=running` 的 turn 会被标记为 `interrupted`。
- session/chat 本身继续保留，不会因为重启而删除。
- 有 `claudeSessionId` 且用户仍然拥有当前 chip 权限时，用户可继续下一轮提问；服务会沿用原 AgentX `sessionId` 和原 `claudeSessionId`。
- Admin 最新 Chat 和详情页可以看到 `interrupted` 状态与对应 lifecycle event。

这表示 Linux 服务重启后，正在运行的单轮任务不会被假装成成功完成；管理员可以在会话历史中看到中断结果并继续排查。

## 验证清单

部署后建议执行：

```bash
curl http://127.0.0.1:3000/health
```

然后用浏览器访问 `/admin`：

- Admin 能登录。
- Admin 导航中能看到“会话历史”和“问题台账”。
- 普通用户只能查看自己的历史，不显示 cwd、raw output 或 logs。
- `AGENTX_DATA_DIR/sessions`、`AGENTX_DATA_DIR/questions`、`AGENTX_DATA_DIR/logs` 会按运行情况写入数据。
- `journalctl -u agentx -f` 能看到结构化 JSON 日志。
 
## 公网 Remote MCP `/mcp` 生产部署 (Public Remote MCP)

Remote MCP 通过 `/mcp` 暴露面向标准 MCP 客户端的 Streamable HTTP 端点。应把它视为一个公开但受鉴权保护的 API：每个客户端请求都必须发送 `Authorization: Bearer <MCP_KEY>`，且每个 MCP KEY 都应由管理员在用户管理页面创建、复制和吊销。不要把 JWT 当作 Remote MCP 的凭证。

推荐拓扑：

- 让 Node 只绑定到回环地址：`node bin/agentx server --host 127.0.0.1 --port 3000 --file-logs`。
- 在前面放置 nginx、Caddy 或其他反向代理来处理 HTTPS/TLS。
- 每个 Node 实例只保留一个可写的 `AGENTX_DATA_DIR`。当前版本不提供分布式文件锁，也不提供多节点共享的 MCP transport 状态。
- 保持 `/health` 可访问，供本地与代理层做健康检查。
- 仅通过 HTTPS 暴露 `/mcp`，并考虑把 `/mcp/verify` 限制在可信管理员网络内，因为普通 MCP 客户端并不需要它。

Remote MCP 安全环境变量：

```bash
export AGENTX_CORS_ORIGINS=https://admin.example.com,https://mcp-client.example.com
export AGENTX_MCP_MAX_BODY_BYTES=1048576
export AGENTX_MCP_MAX_OUTPUT_CHARS=200000
export AGENTX_MCP_MAX_POLL_TIMEOUT_MS=30000
export AGENTX_MCP_RATE_LIMIT_WINDOW_MS=60000
export AGENTX_MCP_RATE_LIMIT_MAX=120
export AGENTX_MCP_VERIFY_RATE_LIMIT_MAX=20
export AGENTX_MCP_MAX_TRANSPORTS=100
export AGENTX_MCP_MAX_TRANSPORTS_PER_USER=10
export AGENTX_MCP_TRANSPORT_IDLE_TTL_MS=1800000
export AGENTX_MCP_TRANSPORT_ABSOLUTE_TTL_MS=43200000
export AGENTX_MCP_KEY_TOUCH_MIN_INTERVAL_MS=60000
```

`AGENTX_CORS_ORIGINS=*` 只应作为明确的开发期选择使用。公网部署不要使用通配符 CORS。

nginx 示例：

```nginx
server {
  listen 443 ssl http2;
  server_name agentx.example.com;

  ssl_certificate /etc/letsencrypt/live/agentx.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/agentx.example.com/privkey.pem;

  client_max_body_size 1m;

  location /health {
    proxy_pass http://127.0.0.1:3000/health;
  }

  location /mcp {
    proxy_pass http://127.0.0.1:3000/mcp;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location /mcp/verify {
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:3000/mcp/verify;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

## 页面与 API 路径映射

以下是一份通用 nginx 路径映射示例，供把 AgentX 部署到独立域名时使用：

```nginx
server {
  listen 443 ssl http2;
  server_name agentx.example.com;

  location = /home { proxy_pass http://127.0.0.1:3000; }
  location = /home.html { proxy_pass http://127.0.0.1:3000; }
  location = /login { proxy_pass http://127.0.0.1:3000; }
  location = /chat { proxy_pass http://127.0.0.1:3000; }
  location = /admin { proxy_pass http://127.0.0.1:3000; }
  location = /account { proxy_pass http://127.0.0.1:3000; }
  location = /account.html { proxy_pass http://127.0.0.1:3000; }
  location ^~ /admin/ { proxy_pass http://127.0.0.1:3000; }
  location = /mcp-access { proxy_pass http://127.0.0.1:3000; }
  location = /mcp-access.html { proxy_pass http://127.0.0.1:3000; }
  location = /mcp-client { proxy_pass http://127.0.0.1:3000; }
  location = /mcp-client.html { proxy_pass http://127.0.0.1:3000; }
  location = /feedback { proxy_pass http://127.0.0.1:3000; }
  location = /feedback.html { proxy_pass http://127.0.0.1:3000; }
  location = /datasheet-submit { proxy_pass http://127.0.0.1:3000; }
  location = /datasheet-submit.html { proxy_pass http://127.0.0.1:3000; }
  location = /updates { proxy_pass http://127.0.0.1:3000; }
  location = /updates.html { proxy_pass http://127.0.0.1:3000; }
  location = /join-application { proxy_pass http://127.0.0.1:3000; }
  location = /join-application.html { proxy_pass http://127.0.0.1:3000; }
  location = /tickets { proxy_pass http://127.0.0.1:3000; }
  location = /tickets.html { proxy_pass http://127.0.0.1:3000; }
  location = /ticket-system { proxy_pass http://127.0.0.1:3000; }
  location = /donation-support { proxy_pass http://127.0.0.1:3000; }
  location = /donation-support.html { proxy_pass http://127.0.0.1:3000; }

  location = /health { proxy_pass http://127.0.0.1:3000; }
  location ^~ /api/ { proxy_pass http://127.0.0.1:3000; }
  location ^~ /auth/ { proxy_pass http://127.0.0.1:3000; }
  location ^~ /sessions { proxy_pass http://127.0.0.1:3000; }
  location = /rpc { proxy_pass http://127.0.0.1:3000; }
  location = /mcp { proxy_pass http://127.0.0.1:3000; }
  location ^~ /mcp/ { proxy_pass http://127.0.0.1:3000; }
  location ^~ /mcp-templates/ { proxy_pass http://127.0.0.1:3000; }
  location ^~ /downloads/ { proxy_pass http://127.0.0.1:3000; }
  location ^~ /assets/ { proxy_pass http://127.0.0.1:3000; }
  location = /chips { proxy_pass http://127.0.0.1:3000; }
  location = /styles.css { proxy_pass http://127.0.0.1:3000; }
  location = /auth.js { proxy_pass http://127.0.0.1:3000; }
  location = /chat.js { proxy_pass http://127.0.0.1:3000; }
  location = /admin.js { proxy_pass http://127.0.0.1:3000; }
  location = /account.js { proxy_pass http://127.0.0.1:3000; }
  location = /ui-kit.js { proxy_pass http://127.0.0.1:3000; }
  location = /announcements.js { proxy_pass http://127.0.0.1:3000; }
  location = /i18n.js { proxy_pass http://127.0.0.1:3000; }
  location = /mcp-access.js { proxy_pass http://127.0.0.1:3000; }
  location = /product-shell.js { proxy_pass http://127.0.0.1:3000; }
  location = /tickets.js { proxy_pass http://127.0.0.1:3000; }
  location = /updates.js { proxy_pass http://127.0.0.1:3000; }
}
```

## 通用路由提示

若 AgentX 不是运行在主域名的根路径下，请确保反向代理把上述页面与 API 路径都正确转发到 Node 服务，避免静态页面或 `/home` 等入口出现 404。

Caddy 示例：

```caddyfile
agentx.example.com {
  encode zstd gzip

  handle /health {
    reverse_proxy 127.0.0.1:3000
  }

  handle /mcp* {
    reverse_proxy 127.0.0.1:3000 {
      flush_interval -1
      transport http {
        read_timeout 1h
        write_timeout 1h
      }
    }
  }
}
```

客户端冒烟测试：

```bash
curl -i https://agentx.example.com/health

curl -i https://agentx.example.com/mcp \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <MCP_KEY>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl-smoke","version":"1.0.0"}}}'
```

`initialize` 响应中会包含 `MCP-Session-Id`。后续的 `POST`、`GET` 和 `DELETE /mcp` 请求必须继续同时发送 `MCP-Session-Id` 与 `Authorization: Bearer <MCP_KEY>`。吊销该 key 后，下一次 `/mcp` 请求会失败，并且只会关闭对应的 MCP transport；已经创建的 AgentX session 不会因为 transport 清理而被终止。

Remote MCP 客户端连接成功后，在创建工作会话前先调用 `agentx_whoami`。响应会确认当前 `user`、`mcp.fingerprint`、`permissions.allowedActions`、可见的 `permissions.resources[]`、服务端 `limits` 以及一个简短的 `summary`。其中会刻意返回 `permissions.cwdExposed=false`：客户端不应请求或猜测真实服务器路径。启用芯片资源后，应把可见资源 id 用作 `agent_spawn.chipId`；真实工作区由 AgentX 在服务端解析。无效或已吊销的 key 仍会沿用现有的 Remote MCP 鉴权失败行为，且无法调用 `agentx_whoami`。

通用 MCP 客户端配置：

```json
{
  "mcpServers": {
    "agentx-remote": {
      "url": "https://agentx.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_KEY>"
      }
    }
  }
}
```

运行检查：

- 调用 `agentx_whoami`，确认其中包含 `allowedActions`、`resources`、`limits`、`cwdExposed=false`，且不暴露完整凭证或真实工作区路径。
- 验证两个不同用户都能使用各自的 MCP KEY 连接。
- 验证用户 B 无法列出、查看日志、发送、轮询或终止用户 A 的 session。
- 吊销用户 A 的 key，并确认下一次 `/mcp` 请求失败。
- 发送超大请求体，并确认代理层或 Node 返回 413 类响应。
- 确认较大的 `agent_log` tail/limit 和 `agent_poll.timeoutMs` 会被服务端限制收敛。
- 检查 journald 与 `AGENTX_DATA_DIR/logs`，确认存在 `mcp_transport_open`、`mcp_tool_call`、`mcp_auth_failure`、`mcp_rate_limited`、`mcp_transport_expired` 和 `mcp_transport_close` 等记录。
- 在日志中搜索真实 MCP KEY、完整 `Authorization`、JWT、Cookie、密码和密钥值。它们都不应出现；诊断时应使用 key 指纹或 key id。

## Linux 上的 User/Admin CLI

Phase 43 新增了 `agentx user ...` 和 `agentx admin ...`，作为访问同一部署服务的 HTTP 客户端。它们复用与 Web/Admin 相同的服务端鉴权、额度、模型授权、MCP key 范围、上传审核、公告发布和可见性边界，不会绕过审核或权限检查。

推荐的鉴权输入方式：

```bash
export AGENTX_BASE_URL=https://agentx.example.com
export AGENTX_TOKEN=<jwt-or-api-token>
# or
export AGENTX_MCP_KEY=<user-mcp-key>
```

也支持密码登录，而且无需把密码存入文件：

```bash
printf '%s\n' '<password>' | agentx user whoami \
  --base-url https://agentx.example.com \
  --username admin \
  --password-stdin
```

常用参数：

- `--json`：输出稳定的机器可读结果
- `--dry-run`：预览不会真正落地的 admin 变更
- `--yes`：用于确认高风险 admin 写操作

不要把真实 token、MCP key、JWT、cookie 或密码写入仓库文档、shell 历史导出、截图或已提交文件。CLI 不要求编辑仓库里的 `.env`；应改用进程环境变量、`--token-file` 或 stdin 密钥输入。
