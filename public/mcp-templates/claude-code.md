# Claude Code Remote MCP config

This template is for users who already have a private MCP key. Keep the full key in your local secret store or process environment only; do not paste it into chat, screenshots, commits, or shared documents. Key storage is 本机私有 only.

AgentX Remote MCP URL:

```text
https://mcp.example.com/mcp
```

## Setup

```bash
read -rsp "MCP key: " AGENTX_MCP_KEY
export AGENTX_MCP_KEY
claude mcp add --transport http agentx-remote \
  https://mcp.example.com/mcp \
  --header "Authorization: Bearer $AGENTX_MCP_KEY"
```

## After Connect

1. Call `agentx_whoami({})`.
2. Use `permissions.resources[].id` as `agent_spawn.chipId`.
3. Prefer `agent_spawn.chatMode`; choose only a selectable id from `agentx_whoami.searchModes`.
4. `agent_spawn.model` is compatibility-only and is still resolved through the same chatMode contract.
5. Remote MCP does not currently accept image input, so `chatMode=multimodal` is rejected server-side.
6. Do not pass `cwd`, `env`, or custom `systemPrompt`.
7. Poll with `agent_poll` until `exited=true`, then read the answer with `agent_log`.

```bash
claude mcp remove agentx-remote
```
