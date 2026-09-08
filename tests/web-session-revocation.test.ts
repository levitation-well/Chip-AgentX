import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

// V2：会话创建之后被撤权（chip/document/scopePreset/model 任一维度），Web REST（/sessions/:id/log、
// /sessions/:id/send、DELETE /sessions/:id）与 /rpc 都必须当场复验并拒绝读写，但不主动强杀正在跑
// 的进程（由既有无输出超时回收）。本文件覆盖 Web 侧三条真实路由 + /rpc，与
// tests/mcp-http-revocation.test.ts 的 Remote MCP 覆盖互为镜像，确保 HTTP↔MCP 复验口径一致。

function createManager() {
  const sessions: any[] = [];
  return {
    sessions,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: `session-${sessions.length + 1}`,
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? process.cwd(),
        task: params.task,
        totalOutputChars: 0,
        chipId: params.chipId,
        documentId: params.documentId,
        scopePresetId: params.scopePresetId,
        allowedChipIds: params.allowedChipIds,
        allowedDocumentIds: params.allowedDocumentIds,
        modelId: params.modelId
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: 'log output', truncated: false, totalChars: 10, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'log output', truncated: false, totalChars: 10, offset: 0 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    on: vi.fn(),
    off: vi.fn()
  };
}

function createSilentLogger() {
  const record = (level: string, event: string, message: string, context?: { metadata?: unknown }) => ({
    timestamp: '2026-07-06T00:00:00.000Z',
    level,
    event,
    message,
    metadata: context?.metadata
  });
  return {
    debug: vi.fn((event: string, message: string, context?: { metadata?: unknown }) => record('debug', event, message, context)),
    info: vi.fn((event: string, message: string, context?: { metadata?: unknown }) => record('info', event, message, context)),
    warn: vi.fn((event: string, message: string, context?: { metadata?: unknown }) => record('warn', event, message, context)),
    error: vi.fn((event: string, message: string, context?: { metadata?: unknown }) => record('error', event, message, context)),
    log: vi.fn()
  };
}

const ALL_MCP_TOOLS = ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill'];

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-web-revocation-'));
  const kbRoot = join(dataDir, 'kb');
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.39', 'datasheet.md'), 'safe datasheet', 'utf-8');
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(userAccessFile, JSON.stringify({ users: {} }, null, 2), 'utf-8');

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const resourceGrants = {
    chipIds: ['E521.39'],
    documentIds: ['doc-1'],
    scopePresetIds: ['preset-1'],
    mcpTools: ALL_MCP_TOOLS
  };
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants, modelGrants: ['haiku'] });

  const jwtService = new JwtService(config);
  const manager = createManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    persistence: { enabled: false },
    logger: createSilentLogger() as never,
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [{ id: 'E521.39', label: 'Allowed chip', workspaceDir: join(kbRoot, 'E521.39'), public: true }]
      }
    },
    prompts: { enabled: false },
    resources: {
      enabled: true,
      catalog: {
        documents: [
          {
            documentId: 'doc-1',
            label: 'Doc 1',
            visibility: 'customer',
            status: 'approved',
            chipIds: ['E521.39']
          }
        ],
        scopePresets: [
          {
            scopePresetId: 'preset-1',
            label: 'Preset 1',
            visibility: 'customer',
            status: 'approved',
            chipIds: ['E521.39'],
            documentIds: ['doc-1']
          }
        ]
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    alice,
    aliceToken: `Bearer ${jwtService.sign(alice.id, alice.username, alice.role)}`,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    server,
    userStore
  };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('V2: Web REST and /rpc re-verify session grants on log/poll/send/kill without hard-killing', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      dataDir = undefined;
    }
  });

  it('GET /sessions/:id/log denies (403) once the chip grant is revoked, without killing the session', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'chip revocation regression' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string };
    expect(spawnResponse.status).toBe(201);

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const logResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/log`, {
      headers: { Authorization: started.aliceToken }
    });

    expect(logResponse.status).toBe(403);
    expect(started.manager.log).not.toHaveBeenCalled();
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.manager.sessions.map((session: any) => session.id)).toContain(spawned.sessionId);
  });

  it('hides revoked sessions from both Web and /rpc agent_list results', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'list revocation regression' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string };
    expect(spawnResponse.status).toBe(201);

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const webList = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: started.aliceToken }
    });
    const webPayload = await webList.json() as { sessions: unknown[] };
    expect(webList.status).toBe(200);
    expect(webPayload.sessions).toEqual([]);

    const webStatus = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}`, {
      headers: { Authorization: started.aliceToken }
    });
    expect(webStatus.status).toBe(404);
    await expect(webStatus.json()).resolves.toMatchObject({ error: 'Session not found' });

    const rpcList = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_list', params: {} })
    });
    const rpcPayload = await rpcList.json() as { result: { sessions: unknown[] } };
    expect(rpcList.status).toBe(200);
    expect(rpcPayload.result.sessions).toEqual([]);
  });

  it('POST /sessions/:id/send denies (403) once the chip grant is revoked', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'chip revocation regression' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string };

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const sendResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/send`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'still there?' })
    });

    expect(sendResponse.status).toBe(403);
    expect(started.manager.submit).not.toHaveBeenCalled();
    expect(started.manager.kill).not.toHaveBeenCalled();
  });

  it('DELETE /sessions/:id denies (403) once the chip grant is revoked and does not call manager.kill', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'chip revocation regression' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string };

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const killResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}`, {
      method: 'DELETE',
      headers: { Authorization: started.aliceToken }
    });

    expect(killResponse.status).toBe(403);
    expect(started.manager.kill).not.toHaveBeenCalled();
  });

  it('POST /rpc agent_log denies once the chip grant is revoked', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnRpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'rpc chip revocation regression', chipId: 'E521.39' }
      })
    });
    const spawnPayload = await spawnRpc.json() as { result: { sessionId: string } };

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const logRpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'agent_log',
        params: { sessionId: spawnPayload.result.sessionId }
      })
    });

    // /rpc surfaces thrown errors from the JSON-RPC handler by re-throwing, which the outer
    // route dispatcher converts to an HTTP-level error response (not a JSON-RPC error envelope).
    expect(logRpc.status).toBe(403);
    expect(started.manager.log).not.toHaveBeenCalled();
    expect(started.manager.kill).not.toHaveBeenCalled();
  });

  it('GET /sessions/:id/log denies once the model grant tied to the session is revoked', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'model revocation regression', chatMode: 'standard' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string; modelId: string };
    expect(spawned.modelId).toBe('haiku');

    await started.userStore.updateUser(started.alice.id, { modelGrants: [] });

    const logResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/log`, {
      headers: { Authorization: started.aliceToken }
    });

    expect(logResponse.status).toBe(403);
    expect(started.manager.log).not.toHaveBeenCalled();
    expect(started.manager.kill).not.toHaveBeenCalled();
  });

  it('allows GET /sessions/:id/log while grants remain unchanged (regression guard)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', chipId: 'E521.39', task: 'still authorized' })
    });
    const spawned = await spawnResponse.json() as { sessionId: string };

    const logResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/log`, {
      headers: { Authorization: started.aliceToken }
    });

    expect(logResponse.status).toBe(200);
    expect(started.manager.log).toHaveBeenCalled();
  });
});

// 动态 scope（group/global 检索解析出一组 chip，没有真实目录预设）会话把
// scopePresetId 存成 dynamic-group / dynamic-global 合成标记，且没有 chipId/documentId。
// 修复前，复验按普通 scopePreset 去查资源目录（查不到）再落到 adminOnly 通用拒绝，
// 导致所有非 admin 用户的动态范围会话每次 log/poll/send/kill 都被误判 403（fail-closed
// 但是错误地拒绝了本应放行的请求）。这里用真实 POST /sessions（scope: {mode:'global'})
// 走完整的 prepareAuthorizedDynamicScopeSession 物化路径，覆盖 Web + /rpc 两条入口。
describe('V2 x V11: Web REST and /rpc allow dynamic-scope sessions to survive re-verify', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      dataDir = undefined;
    }
  });

  it('POST /sessions scope:global spawns a dynamic session, and GET .../log succeeds while the chip grant still holds (reproduces then fixes the V2 x V11 bug)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'dynamic global scope regression',
        sessionMode: 'conversation',
        scope: { mode: 'global' }
      })
    });
    expect(spawnResponse.status).toBe(201);
    const spawned = await spawnResponse.json() as { sessionId: string };
    const session = started.manager.sessions.find((candidate: any) => candidate.id === spawned.sessionId);
    // Confirms the exact bug precondition: a synthetic scopePresetId with no chipId/documentId.
    expect(session.scopePresetId).toBe('dynamic-global');
    expect(session.chipId).toBeUndefined();
    expect(session.allowedChipIds).toEqual(['E521.39']);

    const logResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/log`, {
      headers: { Authorization: started.aliceToken }
    });

    expect(logResponse.status).toBe(200);
    expect(started.manager.log).toHaveBeenCalled();
  });

  it('POST /rpc agent_spawn scope:global then agent_log succeeds while the chip grant still holds', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnRpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'rpc dynamic global scope regression', scope: { mode: 'global' } }
      })
    });
    expect(spawnRpc.status).toBe(200);
    const spawnPayload = await spawnRpc.json() as { result: { sessionId: string } };

    const logRpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'agent_log',
        params: { sessionId: spawnPayload.result.sessionId }
      })
    });

    expect(logRpc.status).toBe(200);
    expect(started.manager.log).toHaveBeenCalled();
  });

  it('GET /sessions/:id/log on a dynamic-scope (global) session denies (403) once the underlying chip grant is revoked (revocation still enforced)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const spawnResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'dynamic global scope revocation regression',
        sessionMode: 'conversation',
        scope: { mode: 'global' }
      })
    });
    expect(spawnResponse.status).toBe(201);
    const spawned = await spawnResponse.json() as { sessionId: string };

    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });

    const logResponse = await fetch(`${started.baseUrl}/sessions/${spawned.sessionId}/log`, {
      headers: { Authorization: started.aliceToken }
    });

    expect(logResponse.status).toBe(403);
    expect(started.manager.log).not.toHaveBeenCalled();
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.manager.sessions.map((session: any) => session.id)).toContain(spawned.sessionId);
  });
});
