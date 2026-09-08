/**
 * TDD: C2 — 动态 scope 描述符接入 POST /sessions
 *
 * 测试分组：
 *  1. group 模式 → 201，cwd = scope 物化副本，chipId = undefined
 *  2. 越权（请求未授权产线）→ 403
 *  3. 超阈值范围（fileCount > 200）→ 413（通过 mock prepareDynamicScopeSession）
 *  4. 单芯片（chipId 路径）→ 201，零回归
 *  5. scope.mode = 'single'（不走动态路径）→ chipId 仍必填，否则 400
 *
 * V11（Phase 5）：动态 scope 补齐 /rpc 与 Remote MCP 平价——见下方
 * 「POST /rpc 与 Remote MCP 动态 scope 平价（V11）」describe 块。
 */

import { once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, type HttpServerOptions } from '../src/http-server.js';
import { SessionManager } from '../src/session-manager.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { CreditLedger } from '../src/credits.js';
import { createPersistenceRuntime } from '../src/persistence/index.js';
import { ScopeTooLargeError } from '../src/scope/scale.js';
import type { RunScopeQueryLargeOptions } from '../src/scope/run-scope-query.js';
import type { TwoStageResult } from '../src/scope/two-stage.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// 通用 mock manager 工厂（捕获 spawn 调用参数）
// ---------------------------------------------------------------------------
function createMockManager() {
  const spawnCalls: any[] = [];
  return {
    spawnCalls,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      spawnCalls.push(params);
      return {
        id: `session-dyn-${spawnCalls.length}`,
        sessionId: `session-dyn-${spawnCalls.length}`,
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

// ---------------------------------------------------------------------------
// 测试服务器工厂：两个芯片（E521.39 = 氛围灯产线，E522.94 = 非授权产线）
// alice 仅授权 E521.39；bob 授权 E521.39 + E522.94
// ---------------------------------------------------------------------------
async function startDynamicScopeServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-dyn-scope-'));
  const kbRoot = join(dataDir, 'kb');
  // 为两个 chip 创建目录（resolveChipWorkspace 需要目录存在）
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await mkdir(join(kbRoot, 'E522.94'), { recursive: true });

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();

  // alice 只授权氛围灯 E521.39；bob 授权两个
  const aliceGrants = { chipIds: ['E521.39'], documentIds: ['doc-e52139'] };
  const bobGrants = { chipIds: ['E521.39', 'E522.94'] };
  const alice = await userStore.createUser('alice-dyn', 'alice-secret', 'customer', {
    resourceGrants: aliceGrants
  });
  const bob = await userStore.createUser('bob-dyn', 'bob-secret', 'customer', {
    resourceGrants: bobGrants
  });

  // 写 legacy user-chip-access.json（BE1 启动迁移兼容输入）
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(
    userAccessFile,
    JSON.stringify({ users: { [alice.id]: ['E521.39'], [bob.id]: ['E521.39', 'E522.94'] } }, null, 2),
    'utf-8'
  );

  const chipCatalog = {
    knowledgeBaseRoot: kbRoot,
    chips: [
      {
        id: 'E521.39',
        label: 'E521.39 氛围灯',
        description: '氛围灯芯片',
        queryHint: '氛围灯问题',
        workspaceDir: 'E521.39',
        productLines: ['氛围灯'],
        applicationTags: ['LIN-bus'],
        brand: 'E521'
      },
      {
        id: 'E522.94',
        label: 'E522.94 外饰灯',
        description: '外饰灯芯片',
        queryHint: '外饰灯问题',
        workspaceDir: 'E522.94',
        productLines: ['外饰灯'],
        brand: 'E522'
      }
    ]
  };

  const manager = createMockManager();
  const jwtService = new JwtService(config);

  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService
    },
    chips: {
      enabled: true,
      userAccessFile,
      catalog: chipCatalog
    },
    persistence: { enabled: false },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    } as never
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    alice,
    bob,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    kbRoot,
    manager,
    server,
    jwtService,
    userStore
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

async function jsonResponse(r: Response) {
  return (await r.json()) as any;
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------
describe('POST /sessions 动态 scope 描述符（C2）', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startDynamicScopeServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    started = undefined;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 用例 1：group 模式，已授权产线 → 201，scope 物化路径作为 cwd
  // -----------------------------------------------------------------------
  it('group scope 已授权产线 → 201，cwd = 物化副本，chipId = undefined', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '请问氛围灯产线的主要参数',
        sessionMode: 'conversation',
        scope: {
          mode: 'group',
          groups: [{ dimension: 'productLine', value: '氛围灯' }]
        }
      })
    });

    expect(response.status).toBe(201);
    const body = await jsonResponse(response);
    // 返回 sessionId
    expect(body.sessionId).toMatch(/^session-dyn-/);

    // spawn 接收到的参数：chipId = undefined，cwd 是 scope 物化副本（在 dataDir 下）
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBeUndefined();
    expect(spawnParams.cwd).toBeDefined();
    expect(typeof spawnParams.cwd).toBe('string');
    // scope 物化 cwd 应在 scope-workspaces 下（persistence 关闭时使用默认 dataDir）
    expect(spawnParams.cwd).toContain('scope-workspaces');

    // systemPrompt 含 AGENTX AUTHORIZED SCOPE 上下文
    expect(spawnParams.systemPrompt).toContain('AGENTX AUTHORIZED SCOPE');
  });

  // -----------------------------------------------------------------------
  // 用例 1b：group 模式 application 维度（T19 按功能）→ 201
  // 回归护栏：曾因共享 action schema（session-actions.ts）缺 'application' 枚举值，
  // 被 agent_spawn.parse 在 201 之前拒成 400，导致「按功能」检索端到端不可用。
  // -----------------------------------------------------------------------
  it('group scope application 维度（按功能）→ 201，cwd = 物化副本', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '哪些芯片支持 LIN',
        sessionMode: 'conversation',
        scope: {
          mode: 'group',
          groups: [{ dimension: 'application', value: 'LIN-bus' }]
        }
      })
    });

    expect(response.status).toBe(201);
    const body = await jsonResponse(response);
    expect(body.sessionId).toMatch(/^session-dyn-/);
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams.chipId).toBeUndefined();
    expect(spawnParams.cwd).toContain('scope-workspaces');
  });

  it('完整 payload 校验失败发生在动态 scope 物化之前，不残留工作区', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    const previousDataDir = process.env.AGENTX_DATA_DIR;
    process.env.AGENTX_DATA_DIR = dataDir;
    try {
      const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'invalid sibling must fail before copy',
          sessionMode: 'invalid-mode',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        })
      });

      expect(response.status).toBe(400);
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(access(join(dataDir, 'scope-workspaces'))).rejects.toThrow();
    } finally {
      if (previousDataDir === undefined) delete process.env.AGENTX_DATA_DIR;
      else process.env.AGENTX_DATA_DIR = previousDataDir;
    }
  });

  it('group scope 物化后附带未授权 documentId → 403 且立即清理工作区', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');
    const previousDataDir = process.env.AGENTX_DATA_DIR;
    process.env.AGENTX_DATA_DIR = dataDir;
    try {
      const response = await fetch(`${started.baseUrl}/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'valid scope with an unauthorized sibling document',
          sessionMode: 'conversation',
          documentId: 'doc-not-authorized',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        })
      });

      expect(response.status).toBe(403);
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(readdir(join(dataDir, 'scope-workspaces'))).resolves.toEqual([]);
    } finally {
      if (previousDataDir === undefined) delete process.env.AGENTX_DATA_DIR;
      else process.env.AGENTX_DATA_DIR = previousDataDir;
    }
  });

  // -----------------------------------------------------------------------
  // 用例 2：越权 — alice 请求未授权的 外饰灯 产线 → 403
  // -----------------------------------------------------------------------
  it('group scope 越权（alice 请求 外饰灯 产线）→ 403', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '请问外饰灯参数',
        sessionMode: 'conversation',
        scope: {
          mode: 'group',
          groups: [{ dimension: 'productLine', value: '外饰灯' }]
        }
      })
    });

    expect(response.status).toBe(403);
  });

  // -----------------------------------------------------------------------
  // 用例 3：超阈值范围 → 413（通过 mock prepareDynamicScopeSession 抛出）
  // -----------------------------------------------------------------------
  it('超阈值范围 → 413', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    // mock prepareDynamicScopeSession 抛出 ScopeTooLargeError
    const queryRunnerModule = await import('../src/scope/query-runner.js');
    vi.spyOn(queryRunnerModule, 'prepareDynamicScopeSession').mockRejectedValueOnce(
      new ScopeTooLargeError(250, 200)
    );

    const token = started.jwtService.sign(started.bob.id, 'bob-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '全产线检索',
        sessionMode: 'conversation',
        scope: {
          mode: 'global'
        }
      })
    });

    expect(response.status).toBe(413);
  });

  // -----------------------------------------------------------------------
  // 用例 4：单芯片（chipId 路径）→ 201，零回归
  // -----------------------------------------------------------------------
  it('单芯片 chipId 路径 → 201 零回归（不走 scope 物化）', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '单芯片问题',
        chipId: 'E521.39',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
    const body = await jsonResponse(response);
    expect(body.sessionId).toMatch(/^session-dyn-/);

    // 单芯片路径：chipId 存在，不用 scope 物化（spawnCalls[0].chipId 应为 E521.39）
    const spawnParams = started.manager.spawnCalls[0];
    // 单芯片路径：chipId 存在
    expect(spawnParams.chipId).toBe('E521.39');
    // cwd 来自 chip 物化副本（prepareChipLaunch），一定是字符串
    expect(typeof spawnParams.cwd).toBe('string');
    // systemPrompt 走单芯片模板，不是 scope 模板
    expect(spawnParams.systemPrompt).toContain('AGENTX WORKSPACE');
    expect(spawnParams.systemPrompt).not.toContain('AGENTX AUTHORIZED SCOPE');
  });

  // -----------------------------------------------------------------------
  // 用例 5：scope.mode = 'single' 不走动态路径，chipId 必填，否则 400
  // -----------------------------------------------------------------------
  it('scope.mode = single 且无 chipId → 400（不走动态路径）', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '单芯片无 chipId',
        sessionMode: 'conversation',
        scope: { mode: 'single' }
      })
    });

    // scope.mode = single 不触发动态物化，应走普通 chip 路径 → chipId 缺失 → 400
    expect(response.status).toBe(400);
  });

  // -----------------------------------------------------------------------
  // 用例 6：global scope，bob（有两个 chip 授权）→ 201
  // -----------------------------------------------------------------------
  it('global scope + 有授权 chip → 201', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.bob.id, 'bob-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '全库检索测试',
        sessionMode: 'conversation',
        scope: { mode: 'global' }
      })
    });

    expect(response.status).toBe(201);
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams.chipId).toBeUndefined();
    expect(spawnParams.systemPrompt).toContain('AGENTX AUTHORIZED SCOPE');
  });
});

// ---------------------------------------------------------------------------
// V11（Phase 5）：POST /rpc 与 Remote MCP 动态 scope 平价
//
// 根因（已证实）：/sessions 读 body.scope 并把 group/global 路由到
// prepareAuthorizedDynamicScopeSession；而 /rpc 的 createWebRpcActions.agent_spawn
// 与 Remote MCP 的 agent_spawn 只看 chipId/documentId/scopePresetId，从不读
// input.scope，于是 { scope: { mode: 'group' } } 被静默丢弃（无 chipId 时还会 400）。
//
// 本组测试断言修复后：两入口对 group/global scope 描述符产生与 /sessions 同构的
// 动态会话（而非被忽略或 400），且越权 chip 仍一致被拒（403 / isError:true）。
// ---------------------------------------------------------------------------
async function connectMcpClient(baseUrl: string, mcpKey: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${mcpKey}` } }
  });
  const client = new Client({ name: 'agentx-v11-scope-parity-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function parseMcpToolText(result: any) {
  return JSON.parse((result.content[0] as { text: string }).text) as any;
}

// customer 角色默认 mcpTools 仅 ['agentx_whoami']（见 security/authorization.ts 的
// ROLE_AUTHORIZATION_TEMPLATES），MCP key 若显式传 resourceGrants 但不含 mcpTools，
// 会与用户级 grants 相交、仍卡在角色默认值——测试 key 需显式带全量 mcpTools 才能调 agent_spawn。
const ALL_MCP_TOOLS = ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill'];

describe('POST /rpc 与 Remote MCP 动态 scope 平价（V11）', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startDynamicScopeServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    started = undefined;
    vi.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // /rpc：group scope 已授权产线 → 200（非 400/忽略），且产生动态物化会话
  // -----------------------------------------------------------------------
  it('/rpc agent_spawn 传 group scope 已授权产线 → 200，cwd = 物化副本，chipId = undefined', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: '请问氛围灯产线的主要参数',
          sessionMode: 'conversation',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        }
      })
    });

    expect(response.status).toBe(200);
    const payload = await jsonResponse(response);
    expect(payload.error).toBeUndefined();
    expect(payload.result?.sessionId).toMatch(/^session-dyn-/);

    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBeUndefined();
    expect(typeof spawnParams.cwd).toBe('string');
    expect(spawnParams.cwd).toContain('scope-workspaces');
    expect(spawnParams.systemPrompt).toContain('AGENTX AUTHORIZED SCOPE');
  });

  it('/rpc group scope 物化后附带未授权 documentId → 403 且立即清理工作区', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');
    const previousDataDir = process.env.AGENTX_DATA_DIR;
    process.env.AGENTX_DATA_DIR = dataDir;
    try {
      const response = await fetch(`${started.baseUrl}/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'agent_spawn',
          params: {
            agentType: 'claude-code',
            task: 'valid scope with an unauthorized sibling document',
            sessionMode: 'conversation',
            documentId: 'doc-not-authorized',
            scope: {
              mode: 'group',
              groups: [{ dimension: 'productLine', value: '氛围灯' }]
            }
          }
        })
      });

      expect(response.status).toBe(403);
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(readdir(join(dataDir, 'scope-workspaces'))).resolves.toEqual([]);
    } finally {
      if (previousDataDir === undefined) delete process.env.AGENTX_DATA_DIR;
      else process.env.AGENTX_DATA_DIR = previousDataDir;
    }
  });

  it('/rpc 明确拒绝 multimodal 图片入口且不物化、不 spawn', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, { modelGrants: ['haiku', 'sonnet', 'opus'] });
    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');
    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: 'inspect /api/chat-uploads/00000000-0000-4000-8000-000000000001/image.png?token=redacted',
          chatMode: 'multimodal',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        }
      })
    });

    expect(response.status).toBe(403);
    expect(await jsonResponse(response)).toMatchObject({ code: 'ENTRY_NOT_SUPPORTED' });
    expect(started.manager.spawnCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // /rpc：越权（alice 请求未授权的 外饰灯 产线）→ 403
  // -----------------------------------------------------------------------
  it('/rpc agent_spawn 传 group scope 越权（alice 请求 外饰灯 产线）→ 403', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.alice.id, 'alice-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: '请问外饰灯参数',
          sessionMode: 'conversation',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '外饰灯' }]
          }
        }
      })
    });

    expect(response.status).toBe(403);
    expect(started.manager.spawnCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // /rpc：global scope，bob（两个 chip 授权）→ 200
  // -----------------------------------------------------------------------
  it('/rpc agent_spawn 传 global scope + 有授权 chip → 200', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.bob.id, 'bob-dyn', 'customer');

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: '全库检索测试',
          sessionMode: 'conversation',
          scope: { mode: 'global' }
        }
      })
    });

    expect(response.status).toBe(200);
    const payload = await jsonResponse(response);
    expect(payload.error).toBeUndefined();
    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams.chipId).toBeUndefined();
    expect(spawnParams.systemPrompt).toContain('AGENTX AUTHORIZED SCOPE');
  });

  // -----------------------------------------------------------------------
  // Remote MCP：group scope 已授权产线 → 动态物化会话（非 isError）
  // -----------------------------------------------------------------------
  it('Remote MCP agent_spawn 传 group scope 已授权产线 → 动态物化会话', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    // customer 角色默认 mcpTools 仅 ['agentx_whoami']（角色模板 + 用户/key grants 是并集再交集），
    // 需先把用户级 grants 补上 agent_spawn 等工具，key 才能再narrow 到同一集合。
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });
    const aliceKey = await started.userStore.addMcpKey(started.alice.id, 'alice remote', {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });

    const { client } = await connectMcpClient(started.baseUrl, aliceKey.key);
    try {
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: '请问氛围灯产线的主要参数',
          sessionMode: 'conversation',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        }
      });
      expect(result).not.toMatchObject({ isError: true });
      const session = parseMcpToolText(result);
      expect(session.sessionId).toMatch(/^session-dyn-/);
    } finally {
      await client.close();
    }

    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams).toBeDefined();
    expect(spawnParams.chipId).toBeUndefined();
    expect(typeof spawnParams.cwd).toBe('string');
    expect(spawnParams.cwd).toContain('scope-workspaces');
  });

  it('Remote MCP group scope 物化后附带未授权 documentId → 拒绝且立即清理工作区', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });
    const aliceKey = await started.userStore.addMcpKey(started.alice.id, 'alice remote', {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });
    const previousDataDir = process.env.AGENTX_DATA_DIR;
    process.env.AGENTX_DATA_DIR = dataDir;
    const { client } = await connectMcpClient(started.baseUrl, aliceKey.key);
    try {
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: 'valid scope with an unauthorized sibling document',
          sessionMode: 'conversation',
          documentId: 'doc-not-authorized',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '氛围灯' }]
          }
        }
      });
      expect(result).toMatchObject({ isError: true });
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(readdir(join(dataDir, 'scope-workspaces'))).resolves.toEqual([]);
    } finally {
      await client.close();
      if (previousDataDir === undefined) delete process.env.AGENTX_DATA_DIR;
      else process.env.AGENTX_DATA_DIR = previousDataDir;
    }
  });

  // -----------------------------------------------------------------------
  // Remote MCP：越权（alice 请求未授权的 外饰灯 产线）→ isError:true / 拒绝
  // -----------------------------------------------------------------------
  it('Remote MCP agent_spawn 传 group scope 越权（alice 请求 外饰灯 产线）→ 拒绝', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });
    const aliceKey = await started.userStore.addMcpKey(started.alice.id, 'alice remote', {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });

    const { client } = await connectMcpClient(started.baseUrl, aliceKey.key);
    try {
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: '请问外饰灯参数',
          sessionMode: 'conversation',
          scope: {
            mode: 'group',
            groups: [{ dimension: 'productLine', value: '外饰灯' }]
          }
        }
      });
      expect(result).toMatchObject({ isError: true });
      // 必须是「越权被拒」而非「scope 字段被 schema 拒绝」——否则测试会在
      // scope 字段从未被真正处理的情况下也“碰巧”通过（假阳性）。
      expect((result.content[0] as { text: string }).text).toContain('not available to this identity');
    } finally {
      await client.close();
    }
    expect(started.manager.spawnCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Remote MCP：global scope，bob（两个 chip 授权）→ 动态物化会话
  // -----------------------------------------------------------------------
  it('Remote MCP agent_spawn 传 global scope + 有授权 chip → 动态物化会话', async () => {
    started = await startDynamicScopeServer();
    server = started.server;
    dataDir = started.dataDir;

    await started.userStore.updateUser(started.bob.id, {
      resourceGrants: { chipIds: ['E521.39', 'E522.94'], mcpTools: ALL_MCP_TOOLS }
    });
    const bobKey = await started.userStore.addMcpKey(started.bob.id, 'bob remote', {
      resourceGrants: { chipIds: ['E521.39', 'E522.94'], mcpTools: ALL_MCP_TOOLS }
    });

    const { client } = await connectMcpClient(started.baseUrl, bobKey.key);
    try {
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: '全库检索测试',
          sessionMode: 'conversation',
          scope: { mode: 'global' }
        }
      });
      expect(result).not.toMatchObject({ isError: true });
      const session = parseMcpToolText(result);
      expect(session.sessionId).toBeDefined();
    } finally {
      await client.close();
    }

    const spawnParams = started.manager.spawnCalls[0];
    expect(spawnParams.chipId).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // large 档回退：M3 两阶段托管会话尚未在 /rpc 接线，超阈值动态 scope 明确
  // 结构化拒绝（501 + SCOPE_TOO_LARGE_FOR_RPC），而非静默丢弃 scope 或误报 400。
  // -----------------------------------------------------------------------
  it('/rpc agent_spawn 传 group scope 超过 small 阈值（large 档）→ 501 结构化拒绝', async () => {
    const large = await startLargeScopeServer();
    server = large.server;
    dataDir = large.dataDir;

    const token = large.jwtService.sign(large.alice.id, 'alice-large', 'customer');
    const response = await fetch(`${large.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: '氛围灯产线检索',
          sessionMode: 'conversation',
          chatMode: 'standard',
          scope: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
        }
      })
    });

    expect(response.status).toBe(501);
    const body = await jsonResponse(response);
    expect(body.code).toBe('SCOPE_TOO_LARGE_FOR_RPC');
    expect(body.error).toContain('not yet supported on /rpc');
  });

  // -----------------------------------------------------------------------
  // large 档回退：Remote MCP 同款——结构化拒绝而非静默丢弃。
  // -----------------------------------------------------------------------
  it('Remote MCP agent_spawn 传 group scope 超过 small 阈值（large 档）→ 结构化拒绝', async () => {
    const large = await startLargeScopeServer();
    server = large.server;
    dataDir = large.dataDir;

    await large.userStore.updateUser(large.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS },
      modelGrants: ['haiku'],
      credits: { balanceUnits: 50 }
    });
    const aliceKey = await large.userStore.addMcpKey(large.alice.id, 'alice remote', {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ALL_MCP_TOOLS }
    });

    const { client } = await connectMcpClient(large.baseUrl, aliceKey.key);
    try {
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: '氛围灯产线检索',
          sessionMode: 'conversation',
          chatMode: 'standard',
          scope: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
        }
      });
      expect(result).toMatchObject({ isError: true });
      expect((result.content[0] as { text: string }).text).toContain('not yet supported on Remote MCP');
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// M3 T3/T4：large 档动态 scope → 托管会话 + 后台两阶段引擎
//
// 与上面用例的关键差异：large 路径走 manager.createManagedSession（真实 registry），
// 因此必须用真实 SessionManager，而非 mock manager。
// 用 scope.smallThreshold=0 + 注入假 largeQueryFactory 强制 large 档、避免跑真实 CC。
// ---------------------------------------------------------------------------
async function startLargeScopeServer(options: {
  manager?: SessionManager;
  modelRouting?: HttpServerOptions['modelRouting'];
  aliceModelGrants?: string[];
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-large-scope-'));
  const kbRoot = join(dataDir, 'kb');
  // 给 E521.39 放 1 个真实 md，使 countChipScopeFiles ≥ 1；smallThreshold=0 时 1 > 0 → large。
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.39', 'overview.md'), '# E521.39\n氛围灯参数', 'utf-8');

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();

  const aliceGrants = { chipIds: ['E521.39'] };
  const alice = await userStore.createUser('alice-large', 'alice-secret', 'customer', {
    resourceGrants: aliceGrants,
    modelGrants: options.aliceModelGrants ?? ['haiku'],
    credits: { balanceUnits: 50 }
  });

  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(
    userAccessFile,
    JSON.stringify({ users: { [alice.id]: ['E521.39'] } }, null, 2),
    'utf-8'
  );

  const chipCatalog = {
    knowledgeBaseRoot: kbRoot,
    chips: [
      {
        id: 'E521.39',
        label: 'E521.39 氛围灯',
        description: '氛围灯芯片',
        queryHint: '氛围灯问题',
        workspaceDir: 'E521.39',
        productLines: ['氛围灯'],
        brand: 'E521'
      }
    ]
  };

  // 真实 SessionManager：large 路径依赖 createManagedSession + registry。
  const manager = options.manager ?? new SessionManager({ exitOnLastSession: false });
  const jwtService = new JwtService(config);

  // T18-d：启用真实持久化，验证 large 托管会话 complete 后 reload 历史可读。
  const persistenceRuntime = createPersistenceRuntime({ dataDir });
  await persistenceRuntime.init();

  // 注入假 largeQueryFactory：触发 stage trace + 返回固定答案，不跑真实 CC。
  const largeQueryCalls: RunScopeQueryLargeOptions[] = [];
  const largeQueryFactory = async (opts: RunScopeQueryLargeOptions): Promise<TwoStageResult> => {
    largeQueryCalls.push(opts);
    opts.onTrace?.('cc.stage1', {});
    opts.onTrace?.('cc.stage2', {});
    return {
      answer: '逐芯片命中…',
      usedChipIds: opts.allowedChipIds.slice(0, 1),
      droppedChipIds: [],
      cleanup: async () => {}
    };
  };

  const server = createHttpServer({
    manager,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: true, userAccessFile, catalog: chipCatalog },
    resources: {
      enabled: true,
      catalog: {
        documents: [
          {
            documentId: 'doc-e52139',
            label: 'E521.39 Datasheet',
            visibility: 'public',
            status: 'approved',
            chipIds: ['E521.39']
          }
        ],
        scopePresets: []
      }
    },
    persistence: { runtime: persistenceRuntime, dataDir },
    scope: { smallThreshold: 0, largeQueryFactory },
    modelRouting: options.modelRouting,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    } as never
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    alice,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    userStore,
    largeQueryCalls,
    persistence: persistenceRuntime,
    server,
    jwtService
  };
}

/** 轮询托管会话直到 completed（或超时）。 */
async function waitForSessionCompletion(
  manager: SessionManager,
  sessionId: string,
  timeoutMs = 5000
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = manager.getSession(sessionId);
    if (session && session.status !== 'running') {
      return session.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`session ${sessionId} did not complete within ${timeoutMs}ms`);
}

async function waitForCreditLedgerEntry(
  creditLedger: CreditLedger,
  userId: string,
  sessionId: string,
  timeoutMs = 5000
): Promise<Awaited<ReturnType<CreditLedger['query']>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const credits = await creditLedger.query({ userId, sessionId });
    if (credits.items.length > 0) {
      return credits;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return creditLedger.query({ userId, sessionId });
}

describe('POST /sessions 动态 scope large 档（M3 T3/T4）', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let manager: SessionManager | undefined;
  let started: Awaited<ReturnType<typeof startLargeScopeServer>> | undefined;

  afterEach(async () => {
    manager?.destroy();
    manager = undefined;
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    started = undefined;
    vi.restoreAllMocks();
  });

  it('large 档 group scope → 201 running + 后台两阶段流式答案', async () => {
    started = await startLargeScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    manager = started.manager;

    const token = started.jwtService.sign(started.alice.id, 'alice-large', 'customer');

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '哪些芯片支持X',
        // standard 档（customer 默认授权）；mode 授权与本测试无关，避免触发 search-mode 闸。
        chatMode: 'standard',
        sessionMode: 'conversation',
        scope: {
          mode: 'group',
          groups: [{ dimension: 'productLine', value: '氛围灯' }]
        }
      })
    });

    // 立即 201，不阻塞等后台两阶段。
    expect(response.status).toBe(201);
    const body = await jsonResponse(response);
    expect(body.status).toBe('running');
    expect(typeof body.sessionId).toBe('string');
    expect(body.sessionId.length).toBeGreaterThan(0);
    // 201 响应体不得泄露任何路径。
    expect(JSON.stringify(body)).not.toContain(started.dataDir);

    // 后台两阶段引擎确实被调用，且拿到授权 chip 交集。
    // （轮询完成后断言更稳，先等会话结束。）
    const status = await waitForSessionCompletion(started.manager, body.sessionId);
    expect(status).toBe('completed');

    // 聚合输出含假引擎的最终答案。
    const log = started.manager.log(body.sessionId);
    expect(log.output).toContain('逐芯片命中…');

    // 注入工厂被调用一次，参数须同时满足 allowedChipIds + question（防止两次调用各传不同参数时误过）。
    expect(started.largeQueryCalls).toHaveLength(1);
    expect(started.largeQueryCalls[0]).toMatchObject({
      allowedChipIds: ['E521.39'],
      allowedDocumentIds: ['doc-e52139'],
      question: '哪些芯片支持X'
    });
    await expect(started.largeQueryCalls[0]?.reauthorize?.()).resolves.toEqual({
      allowedChipIds: ['E521.39'],
      allowedDocumentIds: ['doc-e52139']
    });

    const questions = await started.persistence.questionLedger.queryQuestions({ sessionId: body.sessionId });
    expect(questions.items).toHaveLength(1);
    expect(questions.items[0]).toMatchObject({
      text: '哪些芯片支持X',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      source: 'web'
    });

    const events = await started.persistence.sessionStore.readEvents(body.sessionId);
    expect(events.some((event) =>
      event.event === 'agent_spawn' &&
      event.details?.chatMode === 'standard' &&
      event.details?.modelId === 'haiku' &&
      event.details?.creditUnits === 50 &&
      typeof event.details?.creditReservation?.reservationId === 'string'
    )).toBe(true);

    const creditLedger = new CreditLedger({ dataDir: started.dataDir });
    const credits = await waitForCreditLedgerEntry(creditLedger, started.alice.id, body.sessionId);
    expect(credits.items).toHaveLength(1);
    expect(credits.items[0]).toMatchObject({
      status: 'charged',
      modelId: 'haiku',
      units: 50,
      balanceBeforeUnits: 50,
      balanceAfterUnits: 0
    });
    await expect(started.userStore.getCreditBalanceUnits(started.alice.id)).resolves.toBe(0);
  });

  it('large 档使用运行时 mode -> Claude role 映射', async () => {
    started = await startLargeScopeServer({
      aliceModelGrants: ['fable'],
      modelRouting: {
        config: {
          modeRoleMapping: { standard: 'fable', enhanced: 'sonnet', multimodal: 'opus' }
        }
      }
    });
    server = started.server;
    dataDir = started.dataDir;
    manager = started.manager;

    const token = started.jwtService.sign(started.alice.id, 'alice-large', 'customer');
    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '哪些芯片支持X',
        chatMode: 'standard',
        scope: { mode: 'global' }
      })
    });
    const body = await jsonResponse(response);

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ status: 'running' });
    await waitForSessionCompletion(started.manager, body.sessionId);
    await expect(started.persistence.sessionStore.readSessionMeta(body.sessionId)).resolves.toMatchObject({
      modelId: 'fable',
      claudeModelRole: 'fable',
      creditUnits: 50
    });
    expect(started.largeQueryCalls[0]).toMatchObject({ claudeModelRole: 'fable' });
  });

  it('large 档预扣后 createManagedSession 失败会退款', async () => {
    const limitedManager = new SessionManager({ exitOnLastSession: false, maxConcurrentSessions: 0 });
    started = await startLargeScopeServer({ manager: limitedManager });
    server = started.server;
    dataDir = started.dataDir;
    manager = started.manager;

    const token = started.jwtService.sign(started.alice.id, 'alice-large', 'customer');
    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '哪些芯片支持X',
        chatMode: 'standard',
        scope: { mode: 'global' }
      })
    });

    expect(response.status).toBe(500);
    await expect(started.userStore.getCreditBalanceUnits(started.alice.id)).resolves.toBe(50);
    const creditLedger = new CreditLedger({ dataDir: started.dataDir });
    const credits = await creditLedger.query({ userId: started.alice.id });
    expect(credits.items).toHaveLength(0);
  });

  it('large 托管会话 complete 后 reload 历史可读（T18-d）', async () => {
    started = await startLargeScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    manager = started.manager;
    // standard 档（customer 默认授权），避免触发 search-mode 闸（与上面的大档测试一致）。
    const token = started.jwtService.sign(started.alice.id, 'alice-large', 'customer');
    const res = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '哪些支持 LIN',
        sessionMode: 'conversation',
        scope: { mode: 'global' },
        chatMode: 'standard'
      })
    });
    expect(res.status).toBe(201);
    const { sessionId } = await res.json() as { sessionId: string };
    await waitForSessionCompletion(started.manager, sessionId);

    // 用持久化层（落盘 meta + transcript）读取，模拟进程重启后的 reload。
    // assistant 转写由 exit→recordSessionExit 异步写入（fire-and-forget，与既有 bridge 一致），
    // status 翻转后可能稍晚落盘，因此轮询直到 user + assistant 两条都到位。
    let lastBody: { transcript: Array<{ role: string; text?: string }> } | undefined;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const hist = await fetch(`${started.baseUrl}/sessions/${sessionId}/history`, {
        headers: { authorization: `Bearer ${token}` }
      });
      lastStatus = hist.status;
      if (hist.status === 200) {
        lastBody = await hist.json() as { transcript: Array<{ role: string; text?: string }> };
        const hasUser = lastBody.transcript.some((t) => t.role === 'user');
        const hasAssistant = lastBody.transcript.some((t) => t.role === 'assistant');
        if (hasUser && hasAssistant) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(lastStatus).toBe(200); // 修复前为 404（large 路径绕过 agent_spawn，从未落 session-created）
    expect(lastBody?.transcript.some((t) => t.role === 'user')).toBe(true);
    expect(lastBody?.transcript.some((t) => t.role === 'assistant')).toBe(true);
  });
});
