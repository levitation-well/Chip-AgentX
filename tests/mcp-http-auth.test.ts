import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  return {
    spawn: vi.fn().mockResolvedValue({
      id: 'session-1',
      userId: 'user-a',
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: process.cwd(),
      task: 'hello'
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

function createCaptureLogger(records: any[]) {
  const record = (level: string, event: string, message: string, context?: { metadata?: unknown; userId?: string }) => {
    const entry = {
      timestamp: '2026-05-09T00:00:00.000Z',
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

async function startAuthMcpServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-http-auth-'));
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
  const jwtService = new JwtService(config);
  const manager = createFakeManager();
  const logs: any[] = [];
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
    mcpHttpSecurity: { corsOrigins: ['https://allowed.example'] }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    dataDir,
    jwtService,
    logs,
    manager,
    mcpKey,
    server,
    user,
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

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentx-test', version: '1.0.0' }
    }
  };
}

async function postInitialize(baseUrl: string, authorization?: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(initializeBody())
  });
}

async function json(response: Response) {
  return (await response.json()) as any;
}

async function loginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = await json(response);
  return body.token;
}

describe('remote MCP HTTP authentication', () => {
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

  it('rejects missing Authorization without creating sessions', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await postInitialize(started.baseUrl);
    const body = await json(response);

    expect(response.status).toBe(401);
    expect(body.error.message).toContain('Unauthorized');
    expect(started.manager.spawn).not.toHaveBeenCalled();
    expect(started.logs.some((record) => record.event === 'mcp_request_error')).toBe(true);
  });

  it('rejects invalid Authorization: Bearer values without creating sessions', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await postInitialize(started.baseUrl, 'Bearer invalid');

    expect(response.status).toBe(401);
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('accepts a valid Authorization: Bearer MCP key, exposes the MCP session header, and updates lastUsed', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`, { Origin: 'https://allowed.example' });
    const blocked = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`, { Origin: 'https://blocked.example' });
    const storedUser = await started.userStore.findById(started.user.id);
    const storedKey = storedUser?.mcpKeys.find((key) => key.id === started.mcpKey.id);

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toMatch(/[0-9a-f-]{36}/i);
    expect(response.headers.get('access-control-expose-headers')).toContain('Mcp-Session-Id');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    expect(storedKey?.lastUsed).toBeTruthy();
  });

  it('rejects revoked keys for new /mcp initialize requests', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');

    const deleted = await fetch(`${started.baseUrl}/admin/users/${started.user.id}/keys/${started.mcpKey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(deleted.status).toBe(204);

    const response = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`);

    expect(response.status).toBe(401);
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('rejects disabled users, expired users, and expired keys for new /mcp initialize requests', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;

    await started.userStore.updateUser(started.user.id, { status: 'disabled' });
    const disabled = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`);
    await started.userStore.updateUser(started.user.id, { status: 'active', expiresAt: '2000-01-01T00:00:00.000Z' });
    const userExpired = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`);
    await started.userStore.updateUser(started.user.id, { expiresAt: '2999-01-01T00:00:00.000Z' });
    await started.userStore.updateMcpKey(started.user.id, started.mcpKey.id, { expiresAt: '2000-01-01T00:00:00.000Z' });
    const keyExpired = await postInitialize(started.baseUrl, `Bearer ${started.mcpKey.key}`);
    const storedUser = await started.userStore.findById(started.user.id);
    const storedKey = storedUser?.mcpKeys.find((key) => key.id === started.mcpKey.id);

    expect(disabled.status).toBe(401);
    expect(userExpired.status).toBe(401);
    expect(keyExpired.status).toBe(401);
    expect(storedKey?.lastUsed).toBeUndefined();
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('keeps /mcp/verify on the auth route and does not log full MCP key', async () => {
    const started = await startAuthMcpServer();
    server = started.server;
    dataDir = started.dataDir;

    const verify = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: started.mcpKey.key })
    });
    await postInitialize(started.baseUrl, 'Bearer invalid');

    expect(verify.status).toBe(200);
    expect(await json(verify)).toMatchObject({ valid: true, userId: started.user.id });
    expect(JSON.stringify(started.logs)).not.toContain(started.mcpKey.key);
    expect(JSON.stringify(started.logs)).not.toContain('Bearer invalid');
  });
});
