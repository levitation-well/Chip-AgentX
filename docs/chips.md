# 芯片配置与目录隔离

Phase 5 新增功能。通过服务端芯片配置，普通网页用户只能通过选择芯片来指定工作目录，无法直接提交任意 `cwd`。

## 配置

从 `config/chips.example.json` 复制并编辑：

```json
{
  "knowledgeBaseRoot": "./knowledge-bases",
  "chips": [
    { "id": "E521.39", "label": "E521.39 芯片", "workspaceDir": "E521.39" },
    { "id": "RISC-V", "label": "RISC-V 内核", "workspaceDir": "RISC-V" }
  ]
}
```

- `knowledgeBaseRoot`：知识库根目录，所有芯片工作区必须在此目录下。
- `chips[].id`：芯片唯一标识，用户提交给 API 的值。
- `chips[].label`：显示给用户的名称。
- `chips[].workspaceDir`：相对于 `knowledgeBaseRoot` 的工作区目录（支持相对路径）。

配置路径通过环境变量指定：

```env
CHIP_CONFIG_FILE=./config/chips.json
```

启动时若配置文件不存在或无法读取，芯片功能自动降级为禁用状态（不报错）。

## 安全边界

### 普通用户不能提交任意 cwd

`POST /sessions` 在芯片启用时：
- 拒绝包含 `cwd` 的请求体（返回 400）
- 必须提供 `chipId`
- 服务端根据 `chipId` 解析真实工作目录

### 路径越界防护

- `realpath()` 解析符号链接，防止通过符号链接逃逸
- `isPathInside()` 校验工作目录必须在 `knowledgeBaseRoot` 之内
- `..` 路径穿越被拒绝

### 公共 API 不泄露服务器路径

`GET /chips` 只返回 `{ chips: [{ id, label }] }`，不暴露 `workspaceDir` 和绝对路径。

## Web UI 行为

- `/chat` 页面初始化时从 `GET /chips` 加载芯片列表，填充下拉选择器
- 选择芯片后创建会话，body 包含 `chipId`
- 会话创建后，选择器禁用，显示当前会话绑定的芯片
- 点击"新会话"清空活跃会话，选择器恢复启用
- 历史会话显示其绑定的芯片 ID

## 管理员查看映射

`GET /admin/chips`（需要管理员 JWT）返回完整芯片配置，包括 `workspaceDir`。

## Deferred 范围

以下功能**不在 Phase 5 范围**，记录为后续里程碑任务：

- 完整的可编辑芯片目录管理界面（CRUD UI）
- Docker 沙箱隔离
- RBAC 角色权限体系
