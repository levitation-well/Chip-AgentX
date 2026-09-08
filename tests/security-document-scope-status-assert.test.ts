import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

// V6：assertAuthorizedDocument / assertAuthorizedScopePreset 曾手搓 authorizeResourceAccess
// 入参、从不看 status，于是一篇 status:'draft' 但 visibility:'public' 的文档会绕过直接断言
// 通过，却被 evaluateDocumentVisibility（列表/解析器口径）拒绝——口径分叉。本文件在三入口
// （/sessions、/rpc、Remote MCP）分别验证：非 admin 用户直接指定该 documentId 一致被拒；
// 已批准文档照常放行；admin 仍可通过（因为 evaluateDocumentVisibility 对非 approved 资源
// 短路成 adminOnly 可见性，admin 的 visibilityCeiling 正是 adminOnly）。

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
        scopePresetId: params.scopePresetId
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: vi.fn(),
    send: vi.fn(),
    submit: vi.fn(),
    poll: vi.fn(),
    kill: vi.fn(),
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

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-v6-status-assert-'));
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
  const allMcpTools = ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill'];
  const resourceGrants = {
    chipIds: ['E521.39'],
    documentIds: ['doc-safe', 'doc-draft-public'],
    scopePresetIds: ['lighting'],
    mcpTools: allMcpTools
  };
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants });
  const aliceKey = await userStore.addMcpKey(alice.id, 'alice remote', { resourceGrants });
  const admin = await userStore.createUser('root-admin', 'root-admin-secret', 'admin');

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
            documentId: 'doc-safe',
            label: 'Safe datasheet',
            visibility: 'customer',
            status: 'approved',
            chipIds: ['E521.39'],
            sourceLabels: ['safe datasheet']
          },
          {
            documentId: 'doc-draft-public',
            label: 'Draft public datasheet',
            visibility: 'public',
            status: 'draft',
            sourceLabels: ['draft public datasheet']
          }
        ],
        scopePresets: [
          {
            scopePresetId: 'lighting',
            label: 'Lighting scope',
            visibility: 'customer',
            status: 'approved',
            chipIds: ['E521.39'],
            documentIds: ['doc-safe']
          }
        ]
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    admin,
    adminToken: `Bearer ${jwtService.sign(admin.id, admin.username, admin.role)}`,
    alice,
    aliceKey,
    aliceToken: `Bearer ${jwtService.sign(alice.id, alice.username, alice.role)}`,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    server
  };
}

async function connectClient(baseUrl: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'agentx-v6-status-assert-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function parseToolText(result: any) {
  return JSON.parse((result.content[0] as { text: string }).text) as any;
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('V6: document/scope-preset asserts route through visibility evaluators (status-aware) across all three entry points', () => {
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

  it('entry (1) WebChat POST /sessions denies a draft-but-public documentId for a non-admin user', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        chipId: 'E521.39',
        task: 'reach draft document',
        documentId: 'doc-draft-public'
      })
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('The requested resource is not available to this identity.');
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('entry (1) WebChat POST /sessions allows an approved documentId for a non-admin user (regression guard)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        chipId: 'E521.39',
        task: 'reach approved document',
        documentId: 'doc-safe'
      })
    });

    expect(response.status).toBe(201);
    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
  });

  it('entry (1) WebChat POST /sessions still allows admin to reach the draft-but-public documentId', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        chipId: 'E521.39',
        task: 'admin reaches draft document',
        documentId: 'doc-draft-public'
      })
    });

    expect(response.status).toBe(201);
  });

  it('entry (3) POST /rpc agent_spawn denies a draft-but-public documentId for a non-admin user', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'reach draft document', chipId: 'E521.39', documentId: 'doc-draft-public' }
      })
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe('The requested resource is not available to this identity.');
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('entry (3) POST /rpc agent_spawn allows an approved documentId for a non-admin user (regression guard)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'reach approved document', chipId: 'E521.39', documentId: 'doc-safe' }
      })
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.error).toBeUndefined();
    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
  });

  it('entry (2) Remote MCP agent_spawn denies a draft-but-public documentId for a non-admin user', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const alice = await connectClient(started.baseUrl, started.aliceKey.key);
    try {
      const rejected = await alice.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'reach draft document', chipId: 'E521.39', documentId: 'doc-draft-public' }
      });
      expect(rejected).toMatchObject({ isError: true });
      expect((rejected.content[0] as { text: string }).text).toContain('not available to this identity');
    } finally {
      await alice.client.close();
    }
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('entry (2) Remote MCP agent_spawn allows an approved documentId for a non-admin user (regression guard)', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const alice = await connectClient(started.baseUrl, started.aliceKey.key);
    try {
      const allowed = parseToolText(await alice.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'reach approved document', chipId: 'E521.39', documentId: 'doc-safe' }
      }));
      expect(allowed.sessionId).toBeDefined();
    } finally {
      await alice.client.close();
    }
    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
  });
});
