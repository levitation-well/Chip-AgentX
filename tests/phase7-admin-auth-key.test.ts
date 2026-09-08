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
    spawn: vi.fn(),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    listWithPid: vi.fn().mockReturnValue([]),
    on: vi.fn(),
    off: vi.fn()
  };
}

async function startAdminHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-phase7-admin-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'root',
    adminPasswordHash: await bcrypt.hash('root-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const alice = await userStore.createUser('alice', 'alice-secret');
  const secondAdmin = await userStore.createUser('not-root', 'admin-secret', 'admin');
  const root = await userStore.findByUsername('root');
  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: createFakeManager() as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService
    },
    chips: { enabled: false },
    prompts: { enabled: false }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    jwtService,
    server,
    userStore,
    alice,
    root,
    secondAdmin
  };
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

describe('phase 7 admin authorization and MCP KEY contract', () => {
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

  it('authorizes /admin APIs by JWT role instead of configured username', async () => {
    const started = await startAdminHarness();
    server = started.server;
    dataDir = started.dataDir;

    const roleAdminToken = started.jwtService.sign(started.secondAdmin.id, started.secondAdmin.username, 'customer');
    const userToken = started.jwtService.sign(started.alice.id, started.alice.username, 'admin');

    const allowed = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${roleAdminToken}` }
    });
    expect(allowed.status).toBe(200);

    const forbidden = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    expect(forbidden.status).toBe(403);
    expect(await json(forbidden)).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 for non-admin JWTs before every admin API family', async () => {
    const started = await startAdminHarness();
    server = started.server;
    dataDir = started.dataDir;
    const userToken = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    for (const request of [
      { method: 'GET', path: '/admin/users' },
      { method: 'GET', path: '/admin/users/user-1' },
      { method: 'PUT', path: '/admin/users/user-1/role', body: { role: 'admin' } },
      { method: 'POST', path: '/admin/users/user-1/keys', body: { name: 'blocked' } },
      { method: 'DELETE', path: '/admin/users/user-1/keys/key-1' },
      { method: 'GET', path: '/admin/chips' },
      { method: 'GET', path: '/admin/chip-access' },
      { method: 'GET', path: '/admin/roles' },
      { method: 'GET', path: '/admin/prompts' }
    ]) {
      const response = await fetch(`${started.baseUrl}${request.path}`, {
        method: request.method,
        headers: {
          Authorization: `Bearer ${userToken}`,
          ...(request.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: request.body ? JSON.stringify(request.body) : undefined
      });
      expect(response.status, `${request.method} ${request.path}`).toBe(403);
    }
  });

  it('returns full MCP KEY values only from admin user payloads and rejects revoked keys', async () => {
    const started = await startAdminHarness();
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = started.jwtService.sign(started.root!.id, started.root!.username, started.root!.role);

    const createdUser = await fetch(`${started.baseUrl}/admin/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username: 'bob', password: 'bob-secret' })
    });
    const createdUserBody = await json(createdUser);

    const createdKey = await fetch(`${started.baseUrl}/admin/users/${createdUserBody.user.id}/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'local-dev' })
    });
    const createdKeyBody = await json(createdKey);
    const fullKey = createdKeyBody.key.key;
    expect(fullKey).toEqual(expect.any(String));

    const listed = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const listedBody = await json(listed);
    const bob = listedBody.users.find((user: any) => user.id === createdUserBody.user.id);
    expect(bob.mcpKeys[0]).toMatchObject({
      id: createdKeyBody.key.id,
      name: 'local-dev',
      fingerprint: expect.any(String),
      maskedKey: expect.any(String)
    });
    expect(JSON.stringify(listedBody)).not.toContain(fullKey);
    expect(JSON.stringify(listedBody)).not.toContain('passwordHash');

    const publicLogin = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'bob-secret' })
    });
    const publicLoginBody = await json(publicLogin);
    expect(JSON.stringify(publicLoginBody.user)).not.toContain(fullKey);

    const valid = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: fullKey })
    });
    expect(await json(valid)).toMatchObject({ valid: true, username: 'bob' });

    const deleted = await fetch(
      `${started.baseUrl}/admin/users/${createdUserBody.user.id}/keys/${createdKeyBody.key.id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` }
      }
    );
    expect(deleted.status).toBe(204);

    const revoked = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: fullKey })
    });
    expect(await json(revoked)).toEqual({ valid: false });
  });
});
