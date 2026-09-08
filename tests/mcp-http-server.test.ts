import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { createSessionActions } from '../src/server/session-actions.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const TOOL_NAMES = [
  'agentx_whoami',
  'agent_spawn',
  'agent_log',
  'agent_send',
  'agent_poll',
  'agent_kill',
  'agent_list'
] as const;

function createFakeManager() {
  const sessions: any[] = [];
  return {
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: `session-${sessions.length + 1}`,
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? process.cwd(),
        task: params.task,
        totalOutputChars: 0
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
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

async function startMcpHttpServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-http-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const user = await userStore.createUser('alice', 'alice-secret');
  const mcpKey = await userStore.addMcpKey(user.id, 'remote');
  const manager = createFakeManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService: new JwtService(config)
    },
    persistence: { enabled: false },
    logger: createSilentLogger() as never
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    mcpKey,
    server,
    user
  };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('remote MCP Streamable HTTP server', () => {
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

  it('initializes /mcp, lists customer-mode agent tools, and rejects spawn when resources are unavailable', async () => {
    const started = await startMcpHttpServer();
    server = started.server;
    dataDir = started.dataDir;
    const transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${started.mcpKey.key}`
        }
      }
    });
    const client = new Client({ name: 'agentx-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const spawnTool = tools.tools.find((tool) => tool.name === 'agent_spawn');
      const spawnSchema = spawnTool?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: unknown;
      };
      const result = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: 'inspect project',
          chipId: 'E521.39'
        }
      });

      expect(transport.sessionId).toMatch(/[0-9a-f-]{36}/i);
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(spawnTool?.description).toContain('agentx_whoami');
      expect(spawnTool?.description).toContain('chipId');
      expect(spawnTool?.description).toContain('scopePresetId');
      expect(spawnSchema.required).not.toContain('chipId');
      expect(spawnSchema.properties).toHaveProperty('chipId');
      expect(spawnSchema.properties).toHaveProperty('scopePresetId');
      expect(spawnSchema.properties).not.toHaveProperty('cwd');
      expect(spawnSchema.properties).not.toHaveProperty('env');
      expect(spawnSchema.properties).not.toHaveProperty('systemPrompt');
      expect(spawnSchema.properties).not.toHaveProperty('cols');
      expect(spawnSchema.properties).not.toHaveProperty('rows');
      expect(spawnSchema.properties).not.toHaveProperty('timeoutMs');
      expect(spawnSchema.properties).not.toHaveProperty('noOutputTimeoutMs');
      expect(spawnSchema.additionalProperties).not.toBe(true);
      expect(result).toMatchObject({ isError: true });
      expect((result.content[0] as { text: string }).text).toContain('agentx_whoami');
      expect((result.content[0] as { text: string }).text).toContain('chipId');
      expect(started.manager.spawn).not.toHaveBeenCalled();

      const lifecycleOverride = await client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: 'override lifecycle',
          chipId: 'E521.39',
          cols: 999,
          rows: 99,
          timeoutMs: 999_999,
          noOutputTimeoutMs: 999_999
        }
      });
      expect(lifecycleOverride).toMatchObject({ isError: true });
      expect((lifecycleOverride.content[0] as { text: string }).text).toContain('Unrecognized key');
      expect(started.manager.spawn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it('keeps internal session actions compatible with direct cwd outside public Remote MCP', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any, { scopeUserId: 'user-a' });

    const result = await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project',
      cwd: 'D:/workspace'
    });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'claude-code',
      task: 'inspect project',
      cwd: 'D:/workspace',
      userId: 'user-a'
    }));
    expect(result).toMatchObject({
      sessionId: 'session-1',
      userId: 'user-a'
    });
  });
});
