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

async function startScopeServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-http-scope-'));
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
  const bobGrants = { chipIds: ['E522.94'], mcpTools: allTools };
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants: aliceGrants });
  const bob = await userStore.createUser('bob', 'bob-secret', 'customer', { resourceGrants: bobGrants });
  const aliceKey = await userStore.addMcpKey(alice.id, 'alice remote', { resourceGrants: aliceGrants });
  const bobKey = await userStore.addMcpKey(bob.id, 'bob remote', { resourceGrants: bobGrants });
  const kbRoot = join(dataDir, 'kb');
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await mkdir(join(kbRoot, 'E522.94'), { recursive: true });
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(
    userAccessFile,
    JSON.stringify({ users: { [alice.id]: ['E521.39'], [bob.id]: ['E522.94'] } }, null, 2),
    'utf-8'
  );
  const manager = createScopedManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService: new JwtService(config)
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
          },
          {
            id: 'E522.94',
            label: 'E522.94 Chip',
            description: 'Bob scoped resource',
            queryHint: 'Ask E522 questions',
            workspaceDir: 'E522.94'
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
    baseUrl: `http://127.0.0.1:${address.port}`,
    bob,
    bobKey,
    dataDir,
    manager,
    server
  };
}

async function connectClient(baseUrl: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'agentx-scope-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function parseToolText(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content[0] as { text: string }).text) as any;
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('remote MCP cross-user session scope', () => {
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

  it('isolates alice and bob transports for agent_list, agent_log, agent_send, agent_poll, and agent_kill', async () => {
    const started = await startScopeServer();
    server = started.server;
    dataDir = started.dataDir;
    const alice = await connectClient(started.baseUrl, started.aliceKey.key);
    const bob = await connectClient(started.baseUrl, started.bobKey.key);

    try {
      const spawnResult = parseToolText(await alice.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'alice task', chipId: 'E521.39' }
      }));
      const aliceList = parseToolText(await alice.client.callTool({ name: 'agent_list', arguments: {} }));
      const bobList = parseToolText(await bob.client.callTool({ name: 'agent_list', arguments: {} }));

      expect(spawnResult.userId).toBe(started.alice.id);
      expect(aliceList.sessions.map((session: any) => session.id)).toEqual([spawnResult.sessionId]);
      expect(bobList.sessions).toEqual([]);

      const logError = await bob.client.callTool({ name: 'agent_log', arguments: { sessionId: spawnResult.sessionId } });
      const sendError = await bob.client.callTool({ name: 'agent_send', arguments: { sessionId: spawnResult.sessionId, data: 'nope' } });
      const pollError = await bob.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawnResult.sessionId } });
      const killError = await bob.client.callTool({ name: 'agent_kill', arguments: { sessionId: spawnResult.sessionId } });

      for (const errorResult of [logError, sendError, pollError, killError]) {
        expect(errorResult).toMatchObject({ isError: true });
        expect((errorResult.content[0] as { text: string }).text).toContain('Session not found');
      }

      expect(started.manager.log).not.toHaveBeenCalled();
      expect(started.manager.submit).not.toHaveBeenCalled();
      expect(started.manager.poll).not.toHaveBeenCalled();
      expect(started.manager.kill).not.toHaveBeenCalled();
    } finally {
      await alice.client.close();
      await bob.client.close();
    }
  });
});
