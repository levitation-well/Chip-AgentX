import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createManager() {
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
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    log: vi.fn().mockReturnValue({ output: 'ok', truncated: false, totalChars: 2, offset: 0 }),
    tail: vi.fn(),
    send: vi.fn(),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn(),
    kill: vi.fn(),
    on: vi.fn(),
    off: vi.fn()
  };
}

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-phase4-e2e-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const manager = createManager();
  const server = createHttpServer({ manager: manager as any, auth: { enabled: true, config, userStore } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, dataDir, manager, server };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function postJson(url: string, body: unknown, token?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

describe('Phase 4 auth E2E', () => {
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

  it('covers login, user creation, MCP KEY lifecycle, and cross-user session isolation', async () => {
    const started = await startServer();
    server = started.server;
    dataDir = started.dataDir;

    const adminLogin = await postJson(`${started.baseUrl}/auth/login`, {
      username: 'admin',
      password: 'admin-secret'
    });
    const admin = await adminLogin.json() as any;
    expect(adminLogin.status).toBe(200);
    expect(admin.token).toEqual(expect.any(String));

    const aliceCreate = await postJson(`${started.baseUrl}/admin/users`, {
      username: 'alice',
      password: 'alice-secret'
    }, admin.token);
    const alice = await aliceCreate.json() as any;
    expect(aliceCreate.status).toBe(201);

    const keyCreate = await postJson(`${started.baseUrl}/admin/users/${alice.user.id}/keys`, {
      name: 'alice-cli'
    }, admin.token);
    const key = await keyCreate.json() as any;
    expect(keyCreate.status).toBe(201);
    expect(key.key.key).toEqual(expect.any(String));

    const bobCreate = await postJson(`${started.baseUrl}/admin/users`, {
      username: 'bob',
      password: 'bob-secret'
    }, admin.token);
    expect(bobCreate.status).toBe(201);

    const aliceLogin = await postJson(`${started.baseUrl}/auth/login`, {
      username: 'alice',
      password: 'alice-secret'
    });
    const aliceAuth = await aliceLogin.json() as any;
    expect(aliceLogin.status).toBe(200);

    const createdSession = await postJson(`${started.baseUrl}/sessions`, {
      agentType: 'claude-code',
      task: 'hello'
    }, aliceAuth.token);
    const session = await createdSession.json() as any;
    expect(createdSession.status).toBe(201);

    const aliceSessions = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${aliceAuth.token}` }
    });
    expect((await aliceSessions.json() as any).sessions).toHaveLength(1);

    const bobLogin = await postJson(`${started.baseUrl}/auth/login`, {
      username: 'bob',
      password: 'bob-secret'
    });
    const bobAuth = await bobLogin.json() as any;
    const blockedLog = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`, {
      headers: { Authorization: `Bearer ${bobAuth.token}` }
    });
    expect(blockedLog.status).toBe(404);

    const validKey = await postJson(`${started.baseUrl}/mcp/verify`, { key: key.key.key });
    expect(await validKey.json()).toMatchObject({ valid: true, userId: alice.user.id, username: 'alice' });

    const deleted = await fetch(`${started.baseUrl}/admin/users/${alice.user.id}/keys/${key.key.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin.token}` }
    });
    expect(deleted.status).toBe(204);

    const invalidKey = await postJson(`${started.baseUrl}/mcp/verify`, { key: key.key.key });
    expect(await invalidKey.json()).toEqual({ valid: false });
  });
});
