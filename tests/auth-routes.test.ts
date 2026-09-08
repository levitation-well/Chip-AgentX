import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthRoutes, matchAdminRoute, AuthRouteError } from '../src/auth/routes.js';
import { JwtService } from '../src/auth/jwt-service.js';
import { UserStore } from '../src/auth/user-store.js';
import type { AuthConfig } from '../src/auth/types.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

async function createRouteHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-auth-routes-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const routes = createAuthRoutes({
    userStore,
    jwtService: new JwtService(config),
    config
  });

  return { config, dataDir, routes, userStore };
}

describe('auth routes', () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('normalizes create-user and MCP key input while login responses stay secret-free', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: '  alice  ',
      password: 'correct-password'
    });
    const { key } = await routes.addMcpKey(user.id, { name: '  laptop  ' });
    const fetched = await routes.getUser(user.id);
    const login = await routes.login({ username: 'alice', password: 'correct-password' });

    expect(user).toMatchObject({ username: 'alice' });
    expect(key).toMatchObject({ name: 'laptop' });
    expect(key.key).toEqual(expect.any(String));
    expect(JSON.stringify(fetched.user)).not.toContain(key.key);
    expect(fetched.user.mcpKeys[0]).toMatchObject({ fingerprint: expect.any(String), maskedKey: expect.any(String) });
    expect(JSON.stringify(login.user)).not.toContain(key.key);
    expect(JSON.stringify(fetched.user)).not.toContain('passwordHash');
  });

  it('creates and updates user governance fields and key expiry', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password',
      status: 'active',
      expiresAt: '2026-12-31T00:00:00.000Z',
      profile: {
        realName: 'Alice',
        company: 'AgentX',
        userType: 'customer_engineer',
        email: 'alice@example.com',
        note: 'pilot'
      }
    });
    const updated = await routes.updateUser(user.id, {
      role: 'internal',
      status: 'disabled',
      expiresAt: null,
      profile: { company: 'Elmos', userType: 'internal_engineer' }
    });
    const key = await routes.addMcpKey(user.id, { name: 'remote', expiresAt: '2026-06-01T00:00:00.000Z' });
    const updatedKey = await routes.updateMcpKey(user.id, key.key.id, {
      name: 'remote-updated',
      expiresAt: null
    });

    expect(user).toMatchObject({
      status: 'active',
      expiresAt: '2026-12-31T00:00:00.000Z',
      profile: { userType: 'customer_engineer', company: 'AgentX' }
    });
    expect(updated.user).toMatchObject({
      role: 'internal',
      status: 'disabled',
      expiresAt: undefined,
      profile: { userType: 'internal_engineer', company: 'Elmos' }
    });
    expect(key.key).toMatchObject({ name: 'remote', expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(updatedKey.key).toMatchObject({ name: 'remote-updated', expiresAt: undefined });
    expect(JSON.stringify(updated.user)).not.toContain('passwordHash');
  });

  it('preserves MCP key resourceGrants narrowing when the admin route only patches name/expiry (V7)', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: 'bob',
      password: 'correct-password'
    });
    const key = await routes.addMcpKey(user.id, {
      name: 'narrowed-key',
      resourceGrants: { brands: ['elmos'], productLines: ['氛围灯'], chipIds: ['E521.31'] }
    });

    const renamed = await routes.updateMcpKey(user.id, key.key.id, {
      name: 'renamed-key',
      expiresAt: '2026-06-01T00:00:00.000Z'
    });

    expect(renamed.key).toMatchObject({ name: 'renamed-key', expiresAt: '2026-06-01T00:00:00.000Z' });
    expect(renamed.key.resourceGrants).toMatchObject({
      brands: ['elmos'],
      productLines: ['氛围灯'],
      chipIds: ['E521.31']
    });
  });

  it('allows admins to save user self-service MCP key policy', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password',
      selfService: {
        allowMcpKeySelfCreate: true,
        maxMcpKeys: 2,
        defaultMcpKeyTtlDays: 14,
        allowMcpKeyRegenerate: true
      }
    });
    const updated = await routes.updateUser(user.id, {
      selfService: {
        allowMcpKeySelfCreate: false,
        maxMcpKeys: 1,
        defaultMcpKeyTtlDays: 7,
        allowMcpKeyRegenerate: false
      }
    });

    expect(user.selfService).toMatchObject({ allowMcpKeySelfCreate: true, maxMcpKeys: 2 });
    expect(updated.user.selfService).toMatchObject({
      allowMcpKeySelfCreate: false,
      maxMcpKeys: 1,
      defaultMcpKeyTtlDays: 7,
      allowMcpKeyRegenerate: false
    });
  });

  it('rejects invalid route payloads before mutating users or keys', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);
    const before = await routes.listUsers();

    await expect(routes.createUser({ username: 'shorty', password: '' })).rejects.toThrow('password is required');
    await expect(routes.createUser({ username: '   ', password: 'correct-password' })).rejects.toThrow();

    const { user } = await routes.createUser({ username: 'alice', password: 'correct-password' });
    await expect(routes.addMcpKey(user.id, { name: '   ' })).rejects.toThrow();
    await expect(routes.createUser({ username: 'bad-status', password: 'x', status: 'locked' })).rejects.toThrow();
    await expect(
      routes.createUser({ username: 'bad-expiry', password: 'x', expiresAt: '2026-05-14' })
    ).rejects.toThrow();
    await expect(
      routes.createUser({ username: 'bad-type', password: 'x', profile: { userType: 'vendor' } })
    ).rejects.toThrow();

    const after = await routes.listUsers();
    expect(after.users.map((candidate) => candidate.username)).toEqual([
      ...before.users.map((candidate) => candidate.username),
      'alice'
    ]);
    expect(after.users.find((candidate) => candidate.id === user.id)?.mcpKeys).toHaveLength(0);
  });

  it('allows short non-empty passwords and rejects duplicate usernames clearly', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({ username: 'shorty', password: '123' });
    expect(user.username).toBe('shorty');

    await expect(routes.createUser({ username: 'shorty', password: '456' })).rejects.toMatchObject({
      statusCode: 400,
      message: 'User already exists'
    });
  });

  it('maps missing users and missing MCP keys to 404 route errors', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);
    const { user } = await routes.createUser({ username: 'alice', password: 'correct-password' });

    await expect(routes.getUser('missing-user')).rejects.toBeInstanceOf(AuthRouteError);
    await expect(routes.getUser('missing-user')).rejects.toMatchObject({ statusCode: 404 });
    await expect(routes.removeMcpKey(user.id, 'missing-key')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updates user passwords without exposing password hashes', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);
    const { user } = await routes.createUser({ username: 'alice', password: 'old-password' });

    const updated = await routes.updateUserPassword(user.id, { password: 'new-password' });

    expect(updated.user.username).toBe('alice');
    expect(JSON.stringify(updated.user)).not.toContain('passwordHash');
    await expect(routes.login({ username: 'alice', password: 'old-password' })).rejects.toMatchObject({ statusCode: 401 });
    await expect(routes.login({ username: 'alice', password: 'new-password' })).resolves.toMatchObject({
      user: { username: 'alice' }
    });
  });

  it('deletes users and rejects missing users', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);
    const { user } = await routes.createUser({ username: 'alice', password: 'correct-password' });

    await expect(routes.deleteUser(user.id)).resolves.toEqual({ deleted: true });
    await expect(routes.getUser(user.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(routes.deleteUser(user.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('prevents deleting or demoting the last admin', async () => {
    const { dataDir, routes, userStore } = await createRouteHarness();
    dataDirs.push(dataDir);
    const admin = await userStore.findByUsername('admin');

    await expect(routes.updateUserRole(admin!.id, { role: 'customer' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(routes.deleteUser(admin!.id)).rejects.toMatchObject({ statusCode: 409 });

    await routes.createUser({ username: 'backup-admin', password: 'secret', role: 'admin' });
    await expect(routes.updateUserRole(admin!.id, { role: 'customer' })).resolves.toMatchObject({
      user: { role: 'customer' }
    });
  });

  it('prevents disabling, expiring, deleting, or demoting the last usable admin', async () => {
    const { dataDir, routes, userStore } = await createRouteHarness();
    dataDirs.push(dataDir);
    const admin = await userStore.findByUsername('admin');

    await expect(routes.updateUser(admin!.id, { status: 'disabled' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(routes.updateUser(admin!.id, { expiresAt: '2000-01-01T00:00:00.000Z' })).rejects.toMatchObject({
      statusCode: 409
    });

    await routes.createUser({
      username: 'disabled-admin',
      password: 'secret',
      role: 'admin',
      status: 'disabled'
    });
    await expect(routes.deleteUser(admin!.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(routes.updateUserRole(admin!.id, { role: 'customer' })).rejects.toMatchObject({ statusCode: 409 });

    const backup = (await userStore.findByUsername('disabled-admin'))!;
    await routes.updateUser(backup.id, { status: 'active' });
    await expect(routes.updateUser(admin!.id, { status: 'disabled' })).resolves.toMatchObject({
      user: { status: 'disabled' }
    });
  });
});

describe('admin route matching', () => {
  it('matches and decodes supported admin user and MCP key paths', () => {
    expect(matchAdminRoute('/admin/users')).toEqual({ kind: 'users' });
    expect(matchAdminRoute('/admin/users/user%201')).toEqual({ kind: 'user', userId: 'user 1' });
    expect(matchAdminRoute('/admin/users/user%201/password')).toEqual({ kind: 'userPassword', userId: 'user 1' });
    expect(matchAdminRoute('/admin/users/user%201/keys')).toEqual({ kind: 'userKeys', userId: 'user 1' });
    expect(matchAdminRoute('/admin/users/user%201/keys/key%202')).toEqual({
      kind: 'userKey',
      userId: 'user 1',
      keyId: 'key 2'
    });
  });

  it('ignores unsupported admin paths', () => {
    expect(matchAdminRoute('/admin')).toBeUndefined();
    expect(matchAdminRoute('/admin/users/user-1/keys/key-1/extra')).toBeUndefined();
    expect(matchAdminRoute('/admin/keys')).toBeUndefined();
  });
});

describe('auth routes — role field in responses', () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('login() response includes user.role field', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    // Admin user is initialized by UserStore.init() with role 'admin'
    const adminLogin = await routes.login({ username: 'admin', password: 'admin-secret' });

    expect(adminLogin.user).toHaveProperty('role');
    expect(adminLogin.user.role).toBe('admin');
  });

  it('login() response role is customer for newly created user', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    // createUser() defaults to 'customer' role
    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password'
    });
    expect(user.role).toBe('customer');

    // Login should reflect the customer's role
    const customerLogin = await routes.login({ username: 'alice', password: 'correct-password' });
    expect(customerLogin.user.role).toBe('customer');
  });

  it('createUser() sets default role to customer', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password'
    });

    expect(user.role).toBe('customer');
  });

  it('createUser() accepts explicit customer, internal, and admin roles', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    await expect(routes.createUser({ username: 'alice', password: '123', role: 'customer' })).resolves.toMatchObject({
      user: { role: 'customer' }
    });
    await expect(routes.createUser({ username: 'ian', password: '123', role: 'internal' })).resolves.toMatchObject({
      user: { role: 'internal' }
    });
    await expect(routes.createUser({ username: 'ada', password: '123', role: 'admin' })).resolves.toMatchObject({
      user: { role: 'admin' }
    });
  });

  it('PublicUser includes role field (visible to client)', async () => {
    const { dataDir, routes } = await createRouteHarness();
    dataDirs.push(dataDir);

    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password'
    });

    const fetched = await routes.getUser(user.id);
    expect(fetched.user).toHaveProperty('role');
    expect(fetched.user.role).toBe('customer');
  });

  it('verifyMcpKey() response includes role field', async () => {
    const { dataDir, routes, userStore } = await createRouteHarness();
    dataDirs.push(dataDir);

    // Create a customer user and add an MCP key
    const { user } = await routes.createUser({
      username: 'alice',
      password: 'correct-password'
    });
    const mcpKey = await userStore.addMcpKey(user.id, 'test-key');

    const result = await routes.verifyMcpKey({ key: mcpKey.key });
    expect(result.valid).toBe(true);
    expect(result).toHaveProperty('role');
    expect(result.role).toBe('customer');
  });
});
