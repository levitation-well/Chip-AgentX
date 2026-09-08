/**
 * BE1 安全契约测试：group 授权的芯片推导必须在 HTTP / Remote MCP 多条路径上一致生效，
 * 且显式 chipIds 语义要与安全层一致。
 *
 * 这里覆盖两条关键规则：
 * 1. `resourceGrants.chipIds` 字段缺失时，品牌/产品线推导可放行对应芯片。
 * 2. `resourceGrants.chipIds = []` 时，非 admin 用户即使有 group 授权也必须被全拒绝。
 */

import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import type { ScopeOptionsResponse } from '../src/scope/scope-options.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createMockManager() {
  const spawnCalls: any[] = [];
  return {
    spawnCalls,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      spawnCalls.push(params);
      return {
        id: `session-grp-${spawnCalls.length}`,
        sessionId: `session-grp-${spawnCalls.length}`,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? '',
        task: params.task,
        chipId: params.chipId,
        userId: params.userId,
        totalOutputChars: 0,
        sessionMode: 'conversation',
        turnState: 'idle',
        turnCount: 0,
        claudeSessionId: undefined
      };
    }),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    listWithPid: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    off: vi.fn()
  };
}

/**
 * 测试服务器：三个芯片
 *   X1, X2 → productLines:['灯光']；Y → productLines:['传感']
 * 用户 u：仅 productLine 授权 ['灯光']，缺失 chipIds 字段，应继承 / 推导出 X1、X2。
 * 用户 denied：productLine 授权 ['灯光'] + chipIds: []，应被显式全拒绝。
 * 用户 v：无任何授权（回归对照）。
 * 为打通 Remote MCP whoami（路径 4），给 u 配一把 MCP key，带同样的产品线授权 + whoami 工具。
 */
async function startGroupAuthServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-group-auth-'));
  const kbRoot = join(dataDir, 'kb');
  await mkdir(join(kbRoot, 'X1'), { recursive: true });
  await mkdir(join(kbRoot, 'X2'), { recursive: true });
  await mkdir(join(kbRoot, 'Y'), { recursive: true });

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();

  // u：仅产品线授权（灯光），无单芯片授权。
  // mcpTools 同时授予 agentx_whoami 与 agent_spawn：MCP key 的工具权限会与用户权限取交集，
  // 故单芯片 agent_spawn 测试要求用户本身也持有 agent_spawn 工具（零越权由芯片资源安全闸把守）。
  const u = await userStore.createUser('u', 'u-secret', 'customer', {
    resourceGrants: { productLines: ['灯光'], mcpTools: ['agentx_whoami', 'agent_spawn'] }
  });
  const denied = await userStore.createUser('denied', 'denied-secret', 'customer', {
    resourceGrants: { productLines: ['灯光'], chipIds: [], mcpTools: ['agentx_whoami', 'agent_spawn'] }
  });
  // v：无任何授权（回归对照）。
  const v = await userStore.createUser('v', 'v-secret', 'customer', {
    resourceGrants: { mcpTools: ['agentx_whoami'] }
  });
  // 给 u 一把 MCP key，带同样的产品线授权 + whoami 工具，用于 Remote MCP whoami 路径。
  const uKey = await userStore.addMcpKey(u.id, 'u remote', {
    resourceGrants: { productLines: ['灯光'], mcpTools: ['agentx_whoami'] }
  });
  // 另给 u 一把带 agent_spawn 工具的 MCP key，用于 Remote MCP 单芯片 agent_spawn 路径
  // （whoami key 仅授予 agentx_whoami，不足以发起 spawn；零越权仍由芯片资源安全闸把守）。
  const uSpawnKey = await userStore.addMcpKey(u.id, 'u remote spawn', {
    resourceGrants: { productLines: ['灯光'], mcpTools: ['agent_spawn', 'agentx_whoami'] }
  });

  const chipCatalog = {
    knowledgeBaseRoot: kbRoot,
    chips: [
      { id: 'X1', label: 'X1 灯光', workspaceDir: 'X1', productLines: ['灯光'], brand: 'ELMOS' },
      { id: 'X2', label: 'X2 灯光', workspaceDir: 'X2', productLines: ['灯光'], brand: 'ELMOS' },
      { id: 'Y', label: 'Y 传感', workspaceDir: 'Y', productLines: ['传感'], brand: 'OTHER' }
    ]
  };

  const manager = createMockManager();
  const jwtService = new JwtService(config);

  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: true, catalog: chipCatalog },
    prompts: { enabled: false },
    persistence: { enabled: false },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() } as never
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    u,
    denied,
    v,
    uKey,
    uSpawnKey,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    server,
    jwtService
  };
}

async function closeServer(server: Server | undefined, dataDir: string | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 读取 /chips 列表，返回芯片 id 数组。 */
async function fetchChipIds(baseUrl: string, token: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/chips`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { chips: Array<{ id: string }> };
  return body.chips.map((c) => c.id);
}

/** 读取 /api/scope-options。 */
async function fetchScopeOptions(baseUrl: string, token: string): Promise<ScopeOptionsResponse> {
  const res = await fetch(`${baseUrl}/api/scope-options`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  return (await res.json()) as ScopeOptionsResponse;
}

/** 用 Remote MCP agentx_whoami 取可见 chip 资源 id 列表。 */
async function fetchWhoamiChipIds(baseUrl: string, key: string): Promise<string[]> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'group-auth-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'agentx_whoami', arguments: {} });
    const text = (result.content as Array<{ text: string }>)[0].text;
    const whoami = JSON.parse(text) as {
      permissions: { resources: Array<{ type: string; id: string }> };
    };
    return whoami.permissions.resources.filter((r) => r.type === 'chip').map((r) => r.id);
  } finally {
    await transport.close();
  }
}

/**
 * 用 Remote MCP agent_spawn 发起单芯片会话，返回 `{ ok, isError, text }`。
 * MCP 工具失败（如 403 越权）会以 `isError:true` 的结果或抛错形式回来，这里统一归一化，
 * 让调用方既能断言「成功放行」也能断言「被拒绝」。
 */
async function spawnSingleChipOverMcp(
  baseUrl: string,
  key: string,
  chipId: string
): Promise<{ ok: boolean; text: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'group-auth-spawn-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: 'agent_spawn',
      arguments: {
        agentType: 'claude-code',
        task: `${chipId} 单芯片参数`,
        sessionMode: 'conversation',
        chipId
      }
    });
    const text = ((result.content as Array<{ text?: string }> | undefined)?.[0]?.text) ?? '';
    return { ok: result.isError !== true, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  } finally {
    await transport.close();
  }
}

describe('T17 group 授权四路径一致放行 + 回归 + 零越权', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startGroupAuthServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    started = undefined;
    vi.restoreAllMocks();
  });

  // ── 路径 1：用户可见芯片列表 ──
  it('路径1 GET /chips：缺失 chipIds 的 group 用户 u 看到 X1/X2，不含 Y', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const ids = await fetchChipIds(started.baseUrl, token);
    expect(ids).toContain('X1');
    expect(ids).toContain('X2');
    expect(ids).not.toContain('Y');
  });

  // ── 路径 2：scope-options single + group ──
  it('路径2 GET /api/scope-options：single.chips=X1/X2，group.productLines 含灯光，且不含 Y', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const options = await fetchScopeOptions(started.baseUrl, token);

    const singleIds = options.single.chips.map((c) => c.chipId);
    expect(singleIds).toContain('X1');
    expect(singleIds).toContain('X2');
    expect(singleIds).not.toContain('Y');

    const lighting = options.group.productLines.find((g) => g.value === '灯光');
    expect(lighting).toBeDefined();
    expect(lighting!.chipIds).toContain('X1');
    expect(lighting!.chipIds).toContain('X2');

    // 不应出现传感产品线（Y 未授权）
    const sensor = options.group.productLines.find((g) => g.value === '传感');
    expect(sensor).toBeUndefined();
  });

  // ── 路径 3：POST /sessions group 物化 ──
  it('路径3 POST /sessions group(灯光) → 201（物化覆盖 X1+X2）', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '灯光产品线参数',
        sessionMode: 'conversation',
        scope: { mode: 'group', groups: [{ dimension: 'productLine', value: '灯光' }] }
      })
    });

    expect(res.status).toBe(201);
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBeUndefined();
    expect(spawnParams.systemPrompt).toContain('AGENTX AUTHORIZED SCOPE');
  });

  // ── 路径 4：Remote MCP whoami resources ──
  it('路径4 agentx_whoami(Remote MCP)：resources 含 X1/X2，不含 Y', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const ids = await fetchWhoamiChipIds(started.baseUrl, started.uKey.key);
    expect(ids).toContain('X1');
    expect(ids).toContain('X2');
    expect(ids).not.toContain('Y');
  });

  // ── 路径 5（单芯片 web）：group 授权的单芯片会话创建必须放行 ──
  // 这是 T17 安全闸缺口：单芯片会话创建/访问走 assertAuthorizedChipResource /
  // assertAuthorizedResource 两个安全闸，改动前不识别 group 授权，灯光芯片单芯片请求被误拒。
  it('单芯片 web POST /sessions chipId=X1（灯光，group 授权）→ 201', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'X1 单芯片参数',
        chipId: 'X1',
        sessionMode: 'conversation'
      })
    });

    expect(res.status).toBe(201);
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBe('X1');
  });

  // ── 路径 6（单芯片 Remote MCP）：group 授权的单芯片 agent_spawn 必须放行（HTTP↔MCP 一致）──
  it('单芯片 Remote MCP agent_spawn chipId=X1（灯光，group 授权）→ 成功', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const result = await spawnSingleChipOverMcp(started.baseUrl, started.uSpawnKey.key, 'X1');
    expect(result.ok).toBe(true);
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBe('X1');
  });

  // ── 零越权（单芯片 MCP）：未授权芯片 Y 仍必须被安全闸拒绝 ──
  it('零越权 单芯片 Remote MCP agent_spawn chipId=Y（未授权）→ 拒绝', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const result = await spawnSingleChipOverMcp(started.baseUrl, started.uSpawnKey.key, 'Y');
    expect(result.ok).toBe(false);
    expect(started.manager.spawnCalls).toHaveLength(0);
  });

  // ── 回归（单芯片 web）：无授权用户 v 的单芯片请求 X1 仍必须 403 ──
  it('回归 用户 v（无授权）单芯片 web POST /sessions chipId=X1 → 403', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.v.id, 'v', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'X1 单芯片参数',
        chipId: 'X1',
        sessionMode: 'conversation'
      })
    });
    expect(res.status).toBe(403);
    expect(started.manager.spawnCalls).toHaveLength(0);
  });

  // ── 回归：无任何 group 授权的 v 在四条路径上都看不到 X1/X2/Y ──
  it('回归 用户 v（无授权）在 /chips 与 /api/scope-options 上看不到任何芯片', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.v.id, 'v', 'customer');

    const ids = await fetchChipIds(started.baseUrl, token);
    expect(ids).not.toContain('X1');
    expect(ids).not.toContain('X2');
    expect(ids).not.toContain('Y');
    expect(ids).toHaveLength(0);

    const options = await fetchScopeOptions(started.baseUrl, token);
    expect(options.single.chips).toHaveLength(0);
    expect(options.group.productLines).toHaveLength(0);
    expect(options.global.chipIds).toHaveLength(0);
  });

  it('回归 用户 v group(灯光) → 403（无授权不放行）', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.v.id, 'v', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '灯光产品线参数',
        sessionMode: 'conversation',
        scope: { mode: 'group', groups: [{ dimension: 'productLine', value: '灯光' }] }
      })
    });
    expect(res.status).toBe(403);
  });

  // ── 零越权：u 请求未授权产品线（传感）→ 403 ──
  it('零越权 u group(传感) → 403（未授权产品线）', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '传感产品线参数',
        sessionMode: 'conversation',
        scope: { mode: 'group', groups: [{ dimension: 'productLine', value: '传感' }] }
      })
    });
    expect(res.status).toBe(403);
  });

  // ── 零越权：u 单芯片请求 Y（未授权芯片）→ 403 ──
  it('零越权 u 单芯片 chipId=Y → 403（未授权芯片）', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.u.id, 'u', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'Y 芯片参数',
        chipId: 'Y',
        sessionMode: 'conversation'
      })
    });
    expect(res.status).toBe(403);
  });

  it('显式空 chipIds 会让 denied 用户在 /chips 上看不到任何 group 推导芯片', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.denied.id, 'denied', 'customer');

    const ids = await fetchChipIds(started.baseUrl, token);
    expect(ids).toEqual([]);
  });

  it('显式空 chipIds 会让 denied 用户的单芯片请求继续返回 403', async () => {
    started = await startGroupAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.denied.id, 'denied', 'customer');

    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'X1 芯片参数',
        chipId: 'X1',
        sessionMode: 'conversation'
      })
    });
    expect(res.status).toBe(403);
  });
});
