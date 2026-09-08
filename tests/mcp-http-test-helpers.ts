import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer, type HttpServerOptions } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig, type McpKey, type User } from '../src/auth/index.js';

export const JWT_SECRET = '0123456789abcdef0123456789abcdef';

export interface CapturedLog {
  timestamp: string;
  level: string;
  event: string;
  message: string;
  userId?: string;
  metadata?: unknown;
}

export function createTestManager() {
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
        scopeWorkspace: params.scopeWorkspace,
        sessionMode: params.sessionMode,
        chatMode: params.chatMode,
        modelId: params.modelId,
        creditUnits: params.creditUnits,
        turnState: 'idle',
        turnCount: 1,
        systemPrompt: params.systemPrompt
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: 'x'.repeat(20), truncated: false, totalChars: 20, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'tail', truncated: false, totalChars: 20, offset: 16 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn(() => () => undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    on: vi.fn(),
    off: vi.fn()
  };
}

export function createCaptureLogger(records: CapturedLog[]) {
  const record = (level: string, event: string, message: string, context?: { metadata?: unknown; userId?: string }) => {
    const entry = {
      timestamp: '2026-05-10T00:00:00.000Z',
      level,
      event,
      message,
      userId: context?.userId,
      metadata: context?.metadata
    };
    records.push(entry);
    return entry;
  };
  return {
    debug: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('debug', event, message, context)),
    info: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('info', event, message, context)),
    warn: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('warn', event, message, context)),
    error: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('error', event, message, context)),
    log: vi.fn()
  };
}

export async function startMcpHttpTestServer(options: Pick<HttpServerOptions, 'mcpHttpSecurity' | 'chips' | 'prompts' | 'resources' | 'modelRouting'> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-phase16-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const defaultResourceGrants = {
    chipIds: ['*'],
    mcpTools: ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill']
  };
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants: defaultResourceGrants });
  const bob = await userStore.createUser('bob', 'bob-secret', 'customer', { resourceGrants: defaultResourceGrants });
  const aliceKey = await userStore.addMcpKey(alice.id, 'alice remote', { resourceGrants: defaultResourceGrants });
  const bobKey = await userStore.addMcpKey(bob.id, 'bob remote', { resourceGrants: defaultResourceGrants });
  const logs: CapturedLog[] = [];
  const manager = createTestManager();
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
    logger: createCaptureLogger(logs) as never,
    mcpHttpSecurity: options.mcpHttpSecurity,
    chips: options.chips,
    prompts: options.prompts,
    resources: options.resources,
    modelRouting: options.modelRouting
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
    config,
    dataDir,
    jwtService,
    logs,
    manager,
    server,
    userStore
  };
}

export async function closeMcpHttpTestServer(server: Server | undefined, dataDir: string | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
}

export function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentx-phase16-test', version: '1.0.0' }
    }
  };
}

export function rpcBody(method = 'tools/list', params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 2,
    method,
    params
  };
}

export async function initializeRawTransport(baseUrl: string, key: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(initializeBody())
  });
  return response;
}

export async function postRpc(baseUrl: string, key: string, sessionId: string, body = rpcBody()) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId
    },
    body: JSON.stringify(body)
  });
}

export async function connectClient(baseUrl: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'agentx-phase16-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

export function parseToolText(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content[0] as { text: string }).text) as any;
}

export type TestUser = User;
export type TestMcpKey = McpKey;
