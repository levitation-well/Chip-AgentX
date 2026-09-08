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
  const sessions: any[] = [];
  const manager = {
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: `session-${sessions.length + 1}`,
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? process.cwd(),
        task: params.task,
        sessionMode: params.sessionMode,
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: '00000000-0000-4000-8000-000000000401'
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
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    on: vi.fn(),
    off: vi.fn()
  };

  return manager;
}

async function startAuthServer(options: { requireMissingChipCatalog?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-auth-http-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  await userStore.createUser('alice', 'alice-secret');
  const jwtService = new JwtService(config);
  const manager = createFakeManager();
  const logs: any[] = [];
  const logger = {
    debug: vi.fn(),
    info: vi.fn((event: string, message: string, context?: unknown) => {
      logs.push({ event, message, context });
      return { timestamp: new Date().toISOString(), level: 'info', event, message, ...(context as object) };
    }),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn()
  };
  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService
    },
    logger: logger as any,
    chips: options.requireMissingChipCatalog
      ? { enabled: true, configFile: join(dataDir, 'missing-chips.json') }
      : { enabled: false },
    prompts: { enabled: false }
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
    server,
    userStore
  };
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

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('HTTP authentication API', () => {
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

  it('logs in with username/password and hides credential details on failure', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const ok = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret' })
    });
    const okBody = await json(ok);

    expect(ok.status).toBe(200);
    expect(okBody.token.split('.')).toHaveLength(3);
    expect(okBody.user).toMatchObject({ username: 'admin' });
    expect(okBody.user.passwordHash).toBeUndefined();
    expect(okBody.expiresIn).toBe('24h');

    const bad = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'wrong' })
    });

    expect(bad.status).toBe(401);
    expect(await json(bad)).toEqual({ error: 'Invalid username or password' });
  });

  it('allows browser same-origin login requests without a CORS allowlist', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: started.baseUrl
      },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret' })
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({ username: 'admin', role: 'admin' });
  });

  it('returns the usable server-confirmed identity from GET /auth/me', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = await loginToken(started.baseUrl, 'admin', 'admin-secret');

    const response = await fetch(`${started.baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await json(response)).toEqual({
      user: expect.objectContaining({ username: 'admin', role: 'admin' })
    });
  });

  it('rejects GET /auth/me without a valid JWT', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const missing = await fetch(`${started.baseUrl}/auth/me`);
    const invalid = await fetch(`${started.baseUrl}/auth/me`, {
      headers: { Authorization: 'Bearer invalid-token' }
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
  });

  it('requires JWT for sessions and rpc APIs', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;

    const sessions = await fetch(`${started.baseUrl}/sessions`);
    const rpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_list', params: {} })
    });

    expect(sessions.status).toBe(401);
    expect(rpc.status).toBe(401);
  });

  it('allows JWT-authenticated session access', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const create = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentType: 'claude-code', task: 'hello' })
    });
    const list = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(create.status).toBe(201);
    expect((await json(create)).sessionId).toBe('session-1');
    expect(list.status).toBe(200);
    expect((await json(list)).sessions).toHaveLength(1);
  });

  it('fails closed when an explicitly enabled chip catalog cannot be loaded', async () => {
    const started = await startAuthServer({ requireMissingChipCatalog: true });
    server = started.server;
    dataDir = started.dataDir;
    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const web = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'must not escape into server cwd' })
    });
    const rpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'must not escape into server cwd' }
      })
    });

    expect(web.status).toBe(503);
    await expect(web.json()).resolves.toMatchObject({ code: 'RESOURCE_CATALOG_UNAVAILABLE' });
    expect(rpc.status).toBe(503);
    await expect(rpc.json()).resolves.toMatchObject({ code: 'RESOURCE_CATALOG_UNAVAILABLE' });
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('protects admin user and MCP KEY management with admin JWT', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');
    const userToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const forbidden = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(forbidden.status).toBe(403);

    const forbiddenPolicyUpdate = await fetch(`${started.baseUrl}/admin/users/${(await started.userStore.findByUsername('alice'))!.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ selfService: { allowMcpKeySelfCreate: true } })
    });
    expect(forbiddenPolicyUpdate.status).toBe(403);

    const createdUser = await fetch(`${started.baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username: 'bob', password: 'bob-secret' })
    });
    const createdUserBody = await json(createdUser);
    expect(createdUser.status).toBe(201);
    expect(createdUserBody.user).toMatchObject({ username: 'bob' });
    expect(createdUserBody.user.passwordHash).toBeUndefined();

    const users = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const usersBody = await json(users);
    expect(users.status).toBe(200);
    expect(usersBody.users.some((user: any) => user.username === 'bob')).toBe(true);
    expect(JSON.stringify(usersBody)).not.toContain('passwordHash');

    const key = await fetch(`${started.baseUrl}/admin/users/${createdUserBody.user.id}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'local-dev', expiresAt: '2026-06-01T00:00:00.000Z' })
    });
    const keyBody = await json(key);
    expect(key.status).toBe(201);
    expect(keyBody.key.key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(keyBody.key.expiresAt).toBe('2026-06-01T00:00:00.000Z');

    const updatedUser = await fetch(`${started.baseUrl}/admin/users/${createdUserBody.user.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        status: 'disabled',
        expiresAt: '2026-12-31T00:00:00.000Z',
        profile: { company: 'Elmos', userType: 'agent_engineer' },
        modelGrants: ['haiku'],
        resourceGrants: {
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-safe'],
          scopePresetIds: ['lighting'],
          mcpTools: ['agentx_whoami']
        },
        selfService: {
          allowMcpKeySelfCreate: true,
          maxMcpKeys: 3,
          defaultMcpKeyTtlDays: 14,
          allowMcpKeyRegenerate: true
        }
      })
    });
    expect(updatedUser.status).toBe(200);
    expect(await json(updatedUser)).toMatchObject({
      user: {
        status: 'disabled',
        expiresAt: '2026-12-31T00:00:00.000Z',
        profile: { company: 'Elmos', userType: 'agent_engineer' },
        authorizedModels: ['haiku'],
        resourceGrants: {
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-safe'],
          scopePresetIds: ['lighting'],
          mcpTools: ['agentx_whoami']
        },
        selfService: {
          allowMcpKeySelfCreate: true,
          maxMcpKeys: 3,
          defaultMcpKeyTtlDays: 14,
          allowMcpKeyRegenerate: true
        }
      }
    });
    const policyAudit = started.logs.find((record) => record.event === 'admin_self_service_policy_update');
    expect(policyAudit).toMatchObject({
      context: {
        metadata: {
          actorUsername: 'admin',
          targetUserId: createdUserBody.user.id,
          targetUsername: 'bob',
          nextPolicy: { allowMcpKeySelfCreate: true, maxMcpKeys: 3, defaultMcpKeyTtlDays: 14 }
        }
      }
    });
    expect(JSON.stringify(policyAudit)).not.toMatch(/password|authorization|token|cookie|secret/i);
    const authorizationAudit = started.logs.find((record) => record.event === 'admin_authorization_policy_update');
    expect(authorizationAudit).toMatchObject({
      context: {
        metadata: {
          actorUsername: 'admin',
          targetUserId: createdUserBody.user.id,
          targetUsername: 'bob',
          changedCategories: ['modelGrants', 'resourceGrants'],
          nextResourceGrants: expect.objectContaining({
            brands: ['ELMOS'],
            productLines: ['Lighting'],
            chipIds: ['E522.94'],
            documentIds: ['doc-safe'],
            scopePresetIds: ['lighting'],
            mcpTools: ['agentx_whoami']
          }),
          nextModelGrants: ['haiku']
        }
      }
    });
    expect(JSON.stringify(authorizationAudit)).not.toMatch(/password|bearer|jwt|token|cookie|secret/i);

    const updatedKey = await fetch(`${started.baseUrl}/admin/users/${createdUserBody.user.id}/keys/${keyBody.key.id}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'local-prod',
        expiresAt: null,
        modelGrants: ['haiku'],
        resourceGrants: { chipIds: ['E522.94'], mcpTools: ['agentx_whoami'] }
      })
    });
    expect(updatedKey.status).toBe(200);
    const updatedKeyBody = await json(updatedKey);
    expect(updatedKeyBody).toMatchObject({ key: { name: 'local-prod' } });
    expect(updatedKeyBody.key).not.toHaveProperty('expiresAt');
    expect(updatedKeyBody.key).toMatchObject({
      modelGrants: ['haiku'],
      resourceGrants: expect.objectContaining({ chipIds: ['E522.94'], mcpTools: ['agentx_whoami'] })
    });

    const deleted = await fetch(`${started.baseUrl}/admin/users/${createdUserBody.user.id}/keys/${keyBody.key.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(deleted.status).toBe(204);
  });

  it('updates passwords and deletes users through admin endpoints', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');
    const alice = await started.userStore.findByUsername('alice');

    const passwordUpdated = await fetch(`${started.baseUrl}/admin/users/${alice!.id}/password`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: 'alice-new-secret' })
    });
    const passwordBody = await json(passwordUpdated);
    expect(passwordUpdated.status).toBe(200);
    expect(passwordBody.user.passwordHash).toBeUndefined();

    const oldLogin = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-secret' })
    });
    const newLogin = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-new-secret' })
    });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);

    const deleted = await fetch(`${started.baseUrl}/admin/users/${alice!.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(deleted.status).toBe(204);

    const users = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const usersBody = await json(users);
    expect(usersBody.users.some((user: any) => user.id === alice!.id)).toBe(false);
  });

  it('verifies MCP keys without requiring JWT', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const alice = await started.userStore.findByUsername('alice');
    const mcpKey = await started.userStore.addMcpKey(alice!.id, 'mcp-client');

    const valid = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: mcpKey.key })
    });
    const invalid = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'missing' })
    });

    expect(valid.status).toBe(200);
    expect(await json(valid)).toMatchObject({ valid: true, userId: alice!.id, username: 'alice' });
    expect(invalid.status).toBe(200);
    expect(await json(invalid)).toEqual({ valid: false });
  });

  it('rejects stale JWTs after user deletion, disable, expiry, or role downgrade', async () => {
    const started = await startAuthServer();
    server = started.server;
    dataDir = started.dataDir;
    const alice = await started.userStore.findByUsername('alice');
    const admin = await started.userStore.findByUsername('admin');
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const staleAdminToken = started.jwtService.sign(admin!.id, admin!.username, 'admin');

    await started.userStore.updateUser(alice!.id, { status: 'disabled' });
    const disabledSessions = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    expect(disabledSessions.status).toBe(401);

    await started.userStore.updateUser(alice!.id, { status: 'active', expiresAt: '2000-01-01T00:00:00.000Z' });
    const expiredRpc = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aliceToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_list', params: {} })
    });
    expect(expiredRpc.status).toBe(401);

    await started.userStore.deleteUser(alice!.id);
    const deletedSessions = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    expect(deletedSessions.status).toBe(401);

    const secondAdmin = await started.userStore.createUser('second-admin', 'secret', 'admin');
    await started.userStore.updateUser(admin!.id, { role: 'customer' });
    const downgradedAdmin = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${staleAdminToken}` }
    });
    expect(downgradedAdmin.status).toBe(403);
    expect(secondAdmin.role).toBe('admin');
  });
});
