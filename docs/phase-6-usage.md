# 第 6 阶段：系统提示词配置

## 概览

Phase 6 实现了基于 RBAC 角色管理的系统提示词注入能力。系统提示词由三层组成（global + role + chip），并根据可配置策略注入到 Claude Code 会话中。

## 架构

### 三层提示词组合

```
=== GLOBAL ===
[global.md content]

=== [ROLE_NAME] ===
[role-specific.md content]

=== [CHIP_NAME] ===
[chip-specific.md content]
```

### RBAC 角色定义

| 角色 | 允许芯片 | 注入策略 | 说明 |
|----------|--------------|------------------|---------------------------------------------------|
| admin | *（全部） | every_turn | 可访问全部芯片和 Admin UI |
| internal | *（全部） | every_turn | 通过 Web + MCP 访问全部芯片 |
| customer | 仅 `E521.39` | first_turn | 仅限 Web 访问，且只允许 `E521.39` |

## 配置文件

### `config/roles.json`

定义角色与芯片访问矩阵，以及注入策略：

```json
{
  "admin": {
    "description": "Administrator with full access",
    "access": {
      "allowedChips": ["*"],
      "injectionPolicy": "every_turn"
    }
  },
  "internal": {
    "description": "Internal employee with full chip access",
    "access": {
      "allowedChips": ["*"],
      "injectionPolicy": "every_turn"
    }
  },
  "customer": {
    "description": "External customer with limited chip access",
    "access": {
      "allowedChips": ["E521.39"],
      "injectionPolicy": "first_turn"
    }
  }
}
```

### `config/prompts.json`

定义提示词文件路径：

```json
{
  "baseDir": "prompts",
  "files": {
    "global": "global.md",
    "roles": "roles",
    "chips": "chips"
  }
}
```

### 提示词文件

| 文件 | 用途 |
|-------------------------------|------------------------------------|
| `prompts/global.md` | 所有用户共享的基础 AI 行为 |
| `prompts/roles/admin.md` | Admin 专属上下文 |
| `prompts/roles/internal.md` | 内部员工专属上下文 |
| `prompts/roles/customer.md` | 客户专属上下文 |
| `prompts/chips/E521.39.md` | `E521.39` 芯片专属知识 |

## Admin 界面

进入 `/admin` -> `Prompt Management` 区域可执行：

- 查看全部提示词文件列表（按 global / role / chip 分类）
- 点击文件打开 Markdown 编辑器
- 保存修改（通过临时文件 rename 的原子写入）
- 路径遍历攻击会被校验拦截

## 注入策略

| 策略 | 行为 | 适用场景 |
|------------|---------------------------------|---------------------------------------|
| `first_turn` | 仅在创建会话时注入 | 客户场景，一次性上下文 |
| `every_turn` | 每次用户发消息都注入 | Admin、internal，适合持续提醒 |

## 安全性

- **路径遍历保护**：提示词文件路径会约束在 `prompts/` 目录内。
- **基于角色的访问控制**：`customer` 角色只允许访问 `E521.39` 芯片，未授权芯片返回 `403`。
- **JWT 角色声明**：角色写入 JWT，用于会话级访问控制。
- **原子写入**：提示词文件通过临时文件 rename 保存，避免写坏文件。

## API 端点

| 方法 | 路径 | 说明 |
|--------|-------------------------|----------------------------------|
| GET | `/admin/prompts` | 列出全部提示词文件 |
| GET | `/admin/prompts/:path` | 读取提示词文件内容 |
| PUT | `/admin/prompts/:path` | 保存提示词文件内容 |

## 排障

### `every_turn` 策略在后续轮次未注入

> **已知限制（Gap 06-A）：** `every_turn` 在后续用户消息中的注入还没有接到 `agent_send` handler。`injectSystemPrompt()` 本身逻辑是正确的，但 `POST /sessions/:id/send` 还没有根据 session metadata 查出系统提示词并 prepend。这项问题记录在项目问题跟踪中。

### 提示词未注入

1. 确认 `prompts/` 目录下存在对应提示词文件。
2. 确认 `config/prompts.json` 的路径配置正确。
3. 检查服务端日志里 Claude Code 的启动参数是否包含 `--system-prompt`。
4. 确认 `config/roles.json` 中存在匹配的角色配置。

### 客户无法访问芯片

1. 检查 `data/users.json` 中用户的角色。
2. 检查 `config/roles.json` 中该角色的配置。
3. 确认芯片 ID 完全匹配（区分大小写）。
4. 查看服务端返回中是否出现 `403`。
