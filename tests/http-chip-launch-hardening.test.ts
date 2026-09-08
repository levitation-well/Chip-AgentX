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
import { scopeLaunchHardening } from '../src/scope/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

// Fake manager: records spawn params so we can assert the hardening triple reaches manager.spawn.
function createScopedManager() {
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
        chipId: params.chipId
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: 'owned log', truncated: false, totalChars: 9, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'log', truncated: false, totalChars: 9, offset: 6 }),
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
    timestamp: '2026-05-09T00:00:00.000Z',
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
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-chip-launch-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const allTools = ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill'];
  const aliceGrants = { chipIds: ['E521.39'], mcpTools: allTools };
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants: aliceGrants });
  const aliceKey = await userStore.addMcpKey(alice.id, 'alice remote', { resourceGrants: aliceGrants });
  const kbRoot = join(dataDir, 'kb');
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(
    userAccessFile,
    JSON.stringify({ users: { [alice.id]: ['E521.39'] } }, null, 2),
    'utf-8'
  );
  const manager = createScopedManager();
  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService
    },
    persistence: { enabled: false },
    logger: createSilentLogger() as never,
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'Alice scoped resource',
            queryHint: 'Ask E521 questions',
            workspaceDir: 'E521.39'
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
    aliceKey,
    aliceToken: `Bearer ${jwtService.sign(alice.id, alice.username, alice.role)}`,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    kbRoot,
    manager,
    server
  };
}

async function connectClient(baseUrl: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'agentx-chip-launch-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function isWindows() {
  return process.platform === 'win32';
}

function pathContains(haystack: string, needle: string): boolean {
  if (isWindows()) {
    return haystack.toLowerCase().includes(needle.toLowerCase());
  }
  return haystack.includes(needle);
}

/**
 * Shared assertion: the recorded manager.spawn params for a single-chip session must show the
 * shared isolation gate was applied (copy to an isolated workspace + deny/tool/permission triple).
 */
function expectSingleChipHardening(params: any, kbRoot: string) {
  // cwd is the isolated copy, NOT inside the knowledge base root.
  expect(typeof params.cwd).toBe('string');
  expect(pathContains(params.cwd, kbRoot)).toBe(false);
  expect(pathContains(params.cwd, 'scope-workspaces')).toBe(true);

  // denyReadRoots contains the realpath of the KB root.
  expect(Array.isArray(params.denyReadRoots)).toBe(true);
  const denyHasKb = (params.denyReadRoots as string[]).some((root) => pathContains(root, kbRoot) || pathContains(kbRoot, root));
  expect(denyHasKb).toBe(true);

  // Read-only tool set (Glob removed to close enumeration leak), strict permission mode, cleanup callback.
  expect(params.allowedTools).toEqual(['Read', 'Grep']);
  expect(params.permissionMode).toBe('default');
  expect(typeof params.scopeWorkspaceCleanup).toBe('function');
}

describe('three http entry points route single chip through the shared isolation gate', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it('entry (1) WebChat POST /sessions hardens single chip', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: started.aliceToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'hi', chipId: 'E521.39' })
    });
    expect(response.status).toBe(201);

    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
    const params = started.manager.spawn.mock.calls[0][0];
    expect(params.chipId).toBe('E521.39');
    expectSingleChipHardening(params, started.kbRoot);
  });

  it('entry (3) /rpc agent_spawn hardens single chip', async () => {
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
        params: { agentType: 'claude-code', task: 'hi', chipId: 'E521.39' }
      })
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.error).toBeUndefined();

    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
    const params = started.manager.spawn.mock.calls[0][0];
    expect(params.chipId).toBe('E521.39');
    expectSingleChipHardening(params, started.kbRoot);
  });

  it('entry (2) Remote MCP agent_spawn hardens single chip', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const alice = await connectClient(started.baseUrl, started.aliceKey.key);
    try {
      await alice.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'hi', chipId: 'E521.39' }
      });
    } finally {
      await alice.client.close();
    }

    expect(started.manager.spawn).toHaveBeenCalledTimes(1);
    const params = started.manager.spawn.mock.calls[0][0];
    expect(params.chipId).toBe('E521.39');
    expectSingleChipHardening(params, started.kbRoot);
  });

  // Scope-branch contract: the scope launch hardening triple is what the scope branch injects into
  // agent_spawn. A full scope-preset integration session is not constructable from this harness
  // (no resources/scope-preset runtime), so we lock the contract its three entry points all rely on.
  it('scope branch contract: scopeLaunchHardening yields the deny/tool/permission triple', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const hardening = await scopeLaunchHardening(started.kbRoot);
    const denyHasKb = hardening.denyReadRoots.some((root) => pathContains(root, started.kbRoot) || pathContains(started.kbRoot, root));
    expect(denyHasKb).toBe(true);
    expect(hardening.allowedTools).toEqual(['Read', 'Grep']);
    expect(hardening.permissionMode).toBe('default');
  });
});
