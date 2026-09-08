import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ServerResponse } from 'node:http';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAuthConfig, type AuthConfig } from '../src/auth/config.js';
import { requireAdmin, requireAuth, requireUsableAdmin, requireUsableAuth } from '../src/auth/auth-middleware.js';
import { JwtService } from '../src/auth/jwt-service.js';
import { getUserLocalePreference, getUserOnboardingState, UserStore } from '../src/auth/user-store.js';
import {
  getEffectiveMcpKeyExpiresAt,
  getMcpKeyAvailability,
  getUserAvailability
} from '../src/auth/user-governance.js';
import type { AuthenticatedRequest, McpKey, User } from '../src/auth/types.js';
import {
  ROLE_AUTHORIZATION_TEMPLATES,
  authorizeResourceAccess,
  computeEffectiveAuthorizationSummary,
  mapAllowedChipsToResourceGrants,
  normalizeResourceGrantSet,
  redactAuthorizationMetadata
} from '../src/security/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

interface MockResponse extends Pick<ServerResponse, 'setHeader' | 'end'> {
  statusCode: number;
  headers: Record<string, string | number | readonly string[]>;
  body: string;
}

function makeRequest(authorization?: string): AuthenticatedRequest {
  return {
    headers: authorization ? { authorization } : {}
  } as AuthenticatedRequest;
}

function makeResponse(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = value;
      return this as unknown as ServerResponse;
    },
    end(chunk?: unknown) {
      this.body = chunk === undefined ? '' : String(chunk);
      return this as unknown as ServerResponse;
    }
  };
}

async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentx-auth-core-'));
}

async function userStoreConfig(dataDir: string) {
  return {
    dataDir,
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10)
  };
}

async function readUsersFile(dataDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dataDir, 'users.json'), 'utf8')) as unknown;
}

describe('auth config', () => {
  it('validates required env and applies safe defaults', () => {
    const config = loadAuthConfig({
      JWT_SECRET,
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    expect(config).toEqual({
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
      dataDir: resolve('data')
    } satisfies AuthConfig);
  });

  it('uses AGENTX_DATA_DIR for dataDir and falls back to DATA_DIR', () => {
    const base = resolve('workspace');

    expect(
      loadAuthConfig({
        JWT_SECRET,
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
        AGENTX_DATA_DIR: join(base, 'agentx-data'),
        DATA_DIR: join(base, 'legacy-data')
      }).dataDir
    ).toBe(join(base, 'agentx-data'));

    expect(
      loadAuthConfig({
        JWT_SECRET,
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
        DATA_DIR: join(base, 'legacy-data')
      }).dataDir
    ).toBe(join(base, 'legacy-data'));
  });

  it('rejects unsafe JWT and admin configuration', () => {
    expect(() =>
      loadAuthConfig({
        JWT_SECRET: 'too-short',
        ADMIN_USER: 'admin',
        ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
      })
    ).toThrow(/JWT_SECRET/);

    expect(() =>
      loadAuthConfig({
        JWT_SECRET,
        ADMIN_PASSWORD_HASH: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
      })
    ).toThrow(/ADMIN_USER/);

    expect(() =>
      loadAuthConfig({
        JWT_SECRET,
        ADMIN_USER: 'admin'
      })
    ).toThrow(/ADMIN_PASSWORD_HASH/);
  });
});

describe('JwtService', () => {
  it('signs a three-segment JWT and verifies the user payload with expiry claims', () => {
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });

    const token = service.sign('user-1', 'alice');
    const payload = service.verify(token);

    expect(token.split('.')).toHaveLength(3);
    expect(payload).toMatchObject({ userId: 'user-1', username: 'alice' });
    expect(payload.iat).toEqual(expect.any(Number));
    expect(payload.exp).toEqual(expect.any(Number));
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});

describe('UserStore', () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createStore(): Promise<{ dataDir: string; store: UserStore }> {
    const dataDir = await tempDataDir();
    dataDirs.push(dataDir);
    const store = new UserStore(await userStoreConfig(dataDir));
    await store.init();
    return { dataDir, store };
  }

  it('initializes users.json with the configured admin user when missing', async () => {
    const { dataDir, store } = await createStore();

    const admin = await store.findByUsername('admin');
    const users = await readUsersFile(dataDir);

    expect(admin).toMatchObject({ username: 'admin', mcpKeys: [] });
    expect(Array.isArray(users)).toBe(true);
    expect(JSON.stringify(users)).not.toContain('"password"');
  });

  it('creates users with bcrypt hashes and never persists plaintext passwords', async () => {
    const { dataDir, store } = await createStore();

    const user = await store.createUser('alice', 'correct-horse-battery-staple');
    const usersJson = await readFile(join(dataDir, 'users.json'), 'utf8');

    expect(user.passwordHash).not.toBe('correct-horse-battery-staple');
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(usersJson).toContain('"passwordHash"');
    expect(usersJson).not.toContain('"password"');
    expect(usersJson).not.toContain('correct-horse-battery-staple');
  });

  it('creates active customers from existing bcrypt hashes without MCP keys', async () => {
    const { store } = await createStore();
    const passwordHash = await bcrypt.hash('hash-created-secret', 10);

    const user = await store.createUserWithPasswordHash('hash-user', passwordHash, 'customer', { status: 'active' });

    expect(user).toMatchObject({ username: 'hash-user', role: 'customer', status: 'active' });
    expect(user.passwordHash).toBe(passwordHash);
    expect(user.mcpKeys).toHaveLength(0);
    await expect(store.verifyLogin('hash-user', 'hash-created-secret')).resolves.toMatchObject({ username: 'hash-user' });
    await expect(store.createUserWithPasswordHash('hash-user', passwordHash)).rejects.toThrow('User already exists');
    await expect(store.createUserWithPasswordHash('bad-hash-user', 'not-a-bcrypt-hash')).rejects.toThrow(
      'Invalid password hash'
    );
  });

  it('accepts valid login credentials and rejects invalid credentials safely', async () => {
    const { store } = await createStore();
    await store.createUser('alice', 'correct-password');

    await expect(store.verifyLogin('alice', 'correct-password')).resolves.toMatchObject({ username: 'alice' });
    await expect(store.verifyLogin('alice', 'wrong-password')).resolves.toBeNull();
    await expect(store.verifyLogin('missing', 'correct-password')).resolves.toBeNull();
  });

  it('keeps old users without lifecycle fields usable', async () => {
    const dataDir = await tempDataDir();
    dataDirs.push(dataDir);
    const passwordHash = await bcrypt.hash('correct-password', 10);
    await writeFile(
      join(dataDir, 'users.json'),
      JSON.stringify(
        [
          {
            id: 'old-user',
            username: 'legacy',
            passwordHash,
            mcpKeys: [],
            createdAt: '2026-05-01T00:00:00.000Z',
            role: 'customer'
          }
        ],
        null,
        2
      ),
      'utf8'
    );

    const store = new UserStore(await userStoreConfig(dataDir));
    await store.init();

    await expect(store.verifyLogin('legacy', 'correct-password')).resolves.toMatchObject({ username: 'legacy' });
    expect(store.getAllUsersForAdmin().find((user) => user.id === 'old-user')).toMatchObject({
      username: 'legacy',
      status: undefined,
      expiresAt: undefined,
      profile: undefined
    });
  });

  it('rejects disabled and expired users at login', async () => {
    const { store } = await createStore();
    const disabled = await store.createUser('disabled-user', 'correct-password');
    const expired = await store.createUser('expired-user', 'correct-password');

    await store.updateUser(disabled.id, { status: 'disabled' });
    await store.updateUser(expired.id, { expiresAt: '2000-01-01T00:00:00.000Z' });

    await expect(store.verifyLogin('disabled-user', 'correct-password')).resolves.toBeNull();
    await expect(store.verifyLogin('expired-user', 'correct-password')).resolves.toBeNull();
  });

  it('generates UUID v4 MCP keys, verifies them, and updates lastUsed', async () => {
    const { store } = await createStore();
    const user = await store.createUser('alice', 'correct-password');

    const mcpKey = await store.addMcpKey(user.id, 'laptop');
    const before = mcpKey.lastUsed;
    const verified = await store.verifyMcpKey(mcpKey.key);
    const storedUser = await store.findById(user.id);
    const storedKey = storedUser?.mcpKeys.find((key) => key.id === mcpKey.id);

    expect(mcpKey.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(verified).toMatchObject({ id: user.id, username: 'alice' });
    expect(storedKey?.lastUsed).toEqual(expect.any(String));
    expect(storedKey?.lastUsed).not.toBe(before);
    await expect(store.verifyMcpKey('00000000-0000-4000-8000-000000000000')).resolves.toBeNull();
  });

  it('looks up MCP keys without updating lastUsed and throttles touchMcpKey by minIntervalMs', async () => {
    const { dataDir, store } = await createStore();
    const user = await store.createUser('alice', 'correct-password');
    const mcpKey = await store.addMcpKey(user.id, 'laptop');
    const beforeLookup = await readFile(join(dataDir, 'users.json'), 'utf8');

    const lookup = await store.lookupMcpKey(mcpKey.key);
    const afterLookup = await readFile(join(dataDir, 'users.json'), 'utf8');
    const firstTouch = await store.touchMcpKey(user.id, mcpKey.id);
    const afterFirstTouch = await store.findById(user.id);
    const lastUsed = afterFirstTouch?.mcpKeys.find((key) => key.id === mcpKey.id)?.lastUsed;
    const secondTouch = await store.touchMcpKey(user.id, mcpKey.id, { minIntervalMs: 60_000 });
    const afterSecondTouch = await store.findById(user.id);

    expect(lookup?.user.id).toBe(user.id);
    expect(lookup?.key.id).toBe(mcpKey.id);
    expect(afterLookup).toBe(beforeLookup);
    expect(firstTouch).toBe(true);
    expect(lastUsed).toEqual(expect.any(String));
    expect(secondTouch).toBe(false);
    expect(afterSecondTouch?.mcpKeys.find((key) => key.id === mcpKey.id)?.lastUsed).toBe(lastUsed);
  });

  it('rejects unusable MCP keys without updating lastUsed', async () => {
    const { store } = await createStore();
    const user = await store.createUser('alice', 'correct-password');
    const mcpKey = await store.addMcpKey(user.id, 'short-lived', { expiresAt: '2000-01-01T00:00:00.000Z' });

    await expect(store.lookupUsableMcpKey(mcpKey.key)).resolves.toBeNull();
    await expect(store.verifyMcpKey(mcpKey.key)).resolves.toBeNull();

    const storedUser = await store.findById(user.id);
    expect(storedUser?.mcpKeys.find((key) => key.id === mcpKey.id)?.lastUsed).toBeUndefined();
  });

  it('updates governance fields and protects the last admin role', async () => {
    const { store } = await createStore();
    const user = await store.createUser('alice', 'correct-password');

    const updated = await store.updateUser(user.id, {
      status: 'disabled',
      expiresAt: '2026-12-31T00:00:00.000Z',
      profile: {
        realName: 'Alice',
        company: 'AgentX',
        userType: 'customer_engineer',
        email: 'alice@example.com',
        note: 'Phase 20 test user'
      }
    });
    const key = await store.addMcpKey(user.id, 'laptop');
    const updatedKey = await store.updateMcpKey(user.id, key.id, {
      name: 'workstation',
      expiresAt: '2026-06-01T00:00:00.000Z'
    });

    expect(updated).toMatchObject({ status: 'disabled', expiresAt: '2026-12-31T00:00:00.000Z' });
    expect(updated.profile).toMatchObject({ userType: 'customer_engineer', company: 'AgentX' });
    expect(updatedKey).toMatchObject({ name: 'workstation', expiresAt: '2026-06-01T00:00:00.000Z' });
    await expect(store.updateUserRole((await store.findByUsername('admin'))!.id, 'customer')).rejects.toThrow(
      /Cannot remove the last admin/
    );
  });

  it('merges MCP key resourceGrants on update instead of wiping unrelated narrowing dimensions (V7)', async () => {
    const { store } = await createStore();
    const user = await store.createUser('alice', 'correct-password');
    const key = await store.addMcpKey(user.id, 'narrowed-key', {
      resourceGrants: { brands: ['elmos'], productLines: ['氛围灯'], chipIds: ['E521.31'] }
    });

    // Editing only the name (e.g. via admin UI) must not wipe brands/productLines narrowing.
    const renamed = await store.updateMcpKey(user.id, key.id, { name: 'renamed' });
    expect(renamed.name).toBe('renamed');
    expect(renamed.resourceGrants).toMatchObject({
      brands: ['elmos'],
      productLines: ['氛围灯'],
      chipIds: ['E521.31']
    });

    // Editing only chipIds must narrow that dimension while leaving brands/productLines intact.
    const chipIdsUpdated = await store.updateMcpKey(user.id, key.id, {
      resourceGrants: { chipIds: ['E521.39'] }
    });
    expect(chipIdsUpdated.resourceGrants).toMatchObject({
      brands: ['elmos'],
      productLines: ['氛围灯'],
      chipIds: ['E521.39']
    });

    // Explicit null must still clear the whole grants object.
    const cleared = await store.updateMcpKey(user.id, key.id, { resourceGrants: null });
    expect(cleared.resourceGrants).toBeUndefined();
  });

  it('applies default locale and onboarding values for legacy users', async () => {
    const dataDir = await tempDataDir();
    dataDirs.push(dataDir);
    const passwordHash = await bcrypt.hash('correct-password', 10);
    await writeFile(
      join(dataDir, 'users.json'),
      JSON.stringify([
        {
          id: 'legacy-user',
          username: 'legacy',
          passwordHash,
          mcpKeys: [],
          createdAt: '2026-05-01T00:00:00.000Z',
          role: 'customer'
        }
      ])
    );
    const store = new UserStore(await userStoreConfig(dataDir));
    await store.init();

    const legacy = await store.findByUsername('legacy');
    expect(legacy).not.toBeNull();
    expect(getUserLocalePreference(legacy!)).toBe('zh-CN');
    expect(getUserOnboardingState(legacy!)).toMatchObject({
      status: 'not_started',
      completedSteps: [],
      dismissedHints: []
    });
    expect(store.toPublicUser(legacy!)).toMatchObject({
      localePreference: 'zh-CN',
      preferredLanguage: 'zh-CN',
      onboarding: { status: 'not_started', completedSteps: [], dismissedHints: [] }
    });
  });

  it('persists locale and onboarding updates without changing grants', async () => {
    const { store } = await createStore();
    const user = await store.createUser('alice', 'correct-password', 'customer', {
      modelGrants: ['haiku'],
      resourceGrants: { chipIds: ['e522'] }
    });

    await store.updateOwnLocale(user.id, 'en-US');
    await store.updateOwnOnboarding(user.id, {
      status: 'completed',
      completedSteps: ['profile', 'mcp_access'],
      dismissedHints: ['welcome.banner']
    });
    const updated = await store.findById(user.id);

    expect(updated).toMatchObject({
      localePreference: 'en-US',
      preferredLanguage: 'en-US',
      modelGrants: ['haiku'],
      resourceGrants: { chipIds: ['e522'] }
    });
    expect(updated?.onboarding).toMatchObject({
      status: 'completed',
      completedSteps: ['profile', 'mcp_access'],
      dismissedHints: ['welcome.banner'],
      completedAt: expect.any(String)
    });
  });
});

describe('user governance', () => {
  const now = new Date('2026-05-14T00:00:00.000Z');
  const baseKey: McpKey = {
    id: 'key-1',
    key: 'secret',
    name: 'laptop',
    createdAt: '2026-05-01T00:00:00.000Z'
  };
  const baseUser: User = {
    id: 'user-1',
    username: 'alice',
    passwordHash: 'hash',
    mcpKeys: [baseKey],
    createdAt: '2026-05-01T00:00:00.000Z',
    role: 'customer'
  };

  it('defaults missing lifecycle fields to usable', () => {
    expect(getUserAvailability(baseUser, now)).toMatchObject({ usable: true });
    expect(getMcpKeyAvailability(baseUser, baseKey, now)).toMatchObject({ usable: true });
  });

  it('reports disabled, user expired, key expired, and invalid date states', () => {
    expect(getUserAvailability({ ...baseUser, status: 'disabled' }, now)).toMatchObject({
      usable: false,
      reason: 'user_disabled'
    });
    expect(getUserAvailability({ ...baseUser, expiresAt: '2026-05-13T23:59:59.000Z' }, now)).toMatchObject({
      usable: false,
      reason: 'user_expired'
    });
    expect(
      getMcpKeyAvailability(baseUser, { ...baseKey, expiresAt: '2026-05-13T23:59:59.000Z' }, now)
    ).toMatchObject({ usable: false, reason: 'mcp_key_expired' });
    expect(getUserAvailability({ ...baseUser, expiresAt: 'not-a-date' }, now)).toMatchObject({
      usable: false,
      reason: 'invalid_expiry'
    });
  });

  it('uses the earlier user/key expiry as the effective MCP key expiry', () => {
    expect(
      getEffectiveMcpKeyExpiresAt(
        { ...baseUser, expiresAt: '2026-06-01T00:00:00.000Z' },
        { ...baseKey, expiresAt: '2026-05-20T00:00:00.000Z' }
      )
    ).toBe('2026-05-20T00:00:00.000Z');
    expect(getEffectiveMcpKeyExpiresAt({ ...baseUser, expiresAt: '2026-06-01T00:00:00.000Z' }, baseKey)).toBe(
      '2026-06-01T00:00:00.000Z'
    );
  });
});

describe('authorization domain foundation', () => {
  const now = new Date('2026-05-30T00:00:00.000Z');

  it('defines conservative built-in role templates for admin/internal/partner/customer/public', () => {
    expect(Object.keys(ROLE_AUTHORIZATION_TEMPLATES)).toEqual(['admin', 'internal', 'partner', 'customer', 'public']);
    expect(ROLE_AUTHORIZATION_TEMPLATES.admin.visibilityCeiling).toBe('adminOnly');
    expect(ROLE_AUTHORIZATION_TEMPLATES.internal.visibilityCeiling).toBe('internal');
    expect(ROLE_AUTHORIZATION_TEMPLATES.customer.visibilityCeiling).toBe('customer');
    expect(ROLE_AUTHORIZATION_TEMPLATES.public.visibilityCeiling).toBe('public');
    expect(ROLE_AUTHORIZATION_TEMPLATES.customer.defaultGrants.modelIds).toEqual(['haiku']);
  });

  it('maps legacy role allowedChips into chip resource grants without changing wildcard semantics', () => {
    expect(mapAllowedChipsToResourceGrants(['*'])).toEqual({ chipIds: ['*'] });
    expect(mapAllowedChipsToResourceGrants([' E521.39 ', 'E521.39', 'E522.94'])).toEqual({
      chipIds: ['E521.39', 'E522.94']
    });
  });

  it('computes effective grants from role/user grants and narrows them by MCP key grants', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          grants: {
            chipIds: ['E521.39', 'E522.94'],
            documentIds: ['doc-allowed'],
            modelIds: ['haiku', 'sonnet'],
            mcpTools: ['agentx_whoami', 'agent_spawn']
          },
          modelGrants: ['haiku', 'sonnet']
        },
        key: {
          id: 'key-1',
          fingerprint: 'abcdef123456',
          grants: {
            chipIds: ['E521.39'],
            documentIds: ['doc-allowed'],
            mcpTools: ['agentx_whoami']
          },
          modelGrants: ['sonnet']
        }
      },
      now
    );

    expect(summary.usable).toBe(true);
    expect(summary.grants.chipIds).toEqual(['E521.39']);
    expect(summary.grants.documentIds).toEqual(['doc-allowed']);
    expect(summary.grants.modelIds).toEqual(['sonnet']);
    expect(summary.grants.mcpTools).toEqual(['agentx_whoami']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'E521.39' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'E522.94' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
    expect(authorizeResourceAccess(summary, { type: 'model', id: 'haiku' })).toMatchObject({
      allowed: false,
      reasonCode: 'model_not_granted'
    });
  });

  it('folds derived chip grants when user chipIds are missing', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'customer-derived',
          role: 'customer',
          grants: { productLines: ['Lighting'] }
        },
        roleGrants: { chipIds: ['ROLE-ONLY'] }
      },
      now,
      {
        deriveChipIds: (grants) => (grants.productLines.includes('Lighting') ? ['DERIVED-A', 'DERIVED-B'] : [])
      }
    );

    expect(summary.grants.chipIds).toEqual(['ROLE-ONLY', 'DERIVED-A', 'DERIVED-B']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'DERIVED-A' })).toMatchObject({ allowed: true });
  });

  it('treats explicit empty user chipIds as full deny for non-admin users', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'customer-deny',
          role: 'customer',
          grants: { productLines: ['Lighting'], chipIds: [] }
        },
        roleGrants: { chipIds: ['ROLE-ONLY'] }
      },
      now,
      {
        deriveChipIds: () => ['DERIVED-A']
      }
    );

    expect(summary.grants.chipIds).toEqual([]);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'ROLE-ONLY' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'DERIVED-A' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
  });

  it('treats explicit non-empty user chipIds as the chip override set', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'customer-override',
          role: 'customer',
          grants: { productLines: ['Lighting'], chipIds: ['USER-ONLY'] }
        },
        roleGrants: { chipIds: ['ROLE-ONLY'] }
      },
      now,
      {
        deriveChipIds: () => ['DERIVED-A']
      }
    );

    expect(summary.grants.chipIds).toEqual(['USER-ONLY']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'USER-ONLY' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'ROLE-ONLY' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'DERIVED-A' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
  });

  it('keeps admin chip grants wildcard despite explicit user chip arrays', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'admin-explicit-empty',
          role: 'admin',
          grants: { productLines: ['Lighting'], chipIds: [] }
        }
      },
      now,
      {
        deriveChipIds: () => ['DERIVED-A']
      }
    );

    expect(summary.grants.chipIds).toEqual(['*']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'ANY-CHIP' })).toMatchObject({ allowed: true });
  });

  it('narrows derived chip grants with MCP key grants after derivation', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'customer-key-narrowed',
          role: 'customer',
          grants: { productLines: ['Lighting'] }
        },
        key: {
          id: 'key-1',
          grants: { chipIds: ['DERIVED-B', 'OUTSIDE'] }
        }
      },
      now,
      {
        deriveChipIds: () => ['DERIVED-A', 'DERIVED-B']
      }
    );

    expect(summary.grants.chipIds).toEqual(['DERIVED-B']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'DERIVED-B' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'DERIVED-A' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'OUTSIDE' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
  });

  it('narrows derived user chip grants with MCP key product-line grants', () => {
    const summary = computeEffectiveAuthorizationSummary(
      {
        user: {
          id: 'customer-key-group-narrowed',
          role: 'customer',
          grants: { productLines: ['Lighting', 'Motor'] }
        },
        key: {
          id: 'key-product-line',
          grants: { productLines: ['Lighting'] }
        }
      },
      now,
      {
        deriveChipIds: (grants) => {
          const chips: string[] = [];
          if (grants.productLines.includes('Lighting')) chips.push('LIGHT-A');
          if (grants.productLines.includes('Motor')) chips.push('MOTOR-A');
          return chips;
        }
      }
    );

    expect(summary.grants.productLines).toEqual(['Lighting']);
    expect(summary.grants.chipIds).toEqual(['LIGHT-A']);
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'LIGHT-A' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(summary, { type: 'chip', id: 'MOTOR-A' })).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
  });

  it('denies disabled, expired user, and expired key subjects before resource grants are considered', () => {
    expect(
      computeEffectiveAuthorizationSummary(
        { user: { id: 'disabled', role: 'customer', status: 'disabled', grants: { chipIds: ['*'] } } },
        now
      )
    ).toMatchObject({ usable: false, reasonCode: 'user_disabled' });
    expect(
      computeEffectiveAuthorizationSummary(
        { user: { id: 'expired-user', role: 'customer', expiresAt: '2026-05-29T23:59:59.000Z', grants: { chipIds: ['*'] } } },
        now
      )
    ).toMatchObject({ usable: false, reasonCode: 'user_expired' });
    const expiredKeySummary = computeEffectiveAuthorizationSummary(
      {
        user: { id: 'user-1', role: 'customer', grants: { chipIds: ['*'] } },
        key: { id: 'expired-key', expiresAt: '2026-05-29T23:59:59.000Z', grants: { chipIds: ['*'] } }
      },
      now
    );
    expect(expiredKeySummary).toMatchObject({ usable: false, reasonCode: 'mcp_key_expired' });
    expect(authorizeResourceAccess(expiredKeySummary, { type: 'chip', id: 'E521.39' })).toMatchObject({
      allowed: false,
      reasonCode: 'mcp_key_expired'
    });
  });

  it('supports wildcard and explicit grants while defaulting unknown resources to deny', () => {
    const wildcard = computeEffectiveAuthorizationSummary({
      user: { id: 'admin-1', role: 'admin' }
    });
    const explicit = computeEffectiveAuthorizationSummary({
      user: { id: 'customer-1', role: 'customer', grants: { chipIds: ['E521.39'] } }
    });

    expect(authorizeResourceAccess(wildcard, { type: 'chip', id: 'any-chip' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(explicit, { type: 'chip', id: 'E521.39' })).toMatchObject({ allowed: true });
    expect(authorizeResourceAccess(explicit, { type: 'chip', id: 'E522.94' }).safeMessage).not.toContain('E522.94');
  });

  it('enforces document visibility ceilings separately from explicit document grants', () => {
    const internal = computeEffectiveAuthorizationSummary({
      user: { id: 'internal-1', role: 'internal', grants: { documentIds: ['internal-doc', 'admin-doc'] } }
    });
    const customer = computeEffectiveAuthorizationSummary({
      user: { id: 'customer-1', role: 'customer', grants: { documentIds: ['customer-doc', 'restricted-doc'] } }
    });

    expect(authorizeResourceAccess(internal, { type: 'document', id: 'internal-doc', visibility: 'internal' })).toMatchObject({
      allowed: true
    });
    expect(authorizeResourceAccess(internal, { type: 'document', id: 'admin-doc', visibility: 'adminOnly' })).toMatchObject({
      allowed: false,
      reasonCode: 'visibility_denied'
    });
    expect(authorizeResourceAccess(customer, { type: 'document', id: 'restricted-doc', visibility: 'restricted' })).toMatchObject({
      allowed: false,
      reasonCode: 'visibility_denied'
    });
  });

  it('checks document and scope preset required grants without echoing requested ids in denial messages', () => {
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'partner-1',
        role: 'partner',
        grants: {
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          documentIds: ['doc-explicit'],
          scopePresetIds: ['scope-lighting']
        }
      }
    });

    expect(
      authorizeResourceAccess(summary, {
        type: 'document',
        id: 'doc-explicit',
        visibility: 'partner',
        requiredGrants: { brands: ['ELMOS'], productLines: ['Lighting'] }
      })
    ).toMatchObject({ allowed: true });
    expect(
      authorizeResourceAccess(summary, {
        type: 'scopePreset',
        id: 'scope-lighting',
        visibility: 'partner',
        requiredGrants: { brands: ['ELMOS'], productLines: ['Motor'] }
      })
    ).toMatchObject({ allowed: false, reasonCode: 'resource_not_granted' });
    expect(
      authorizeResourceAccess(summary, {
        type: 'document',
        id: 'doc-secret',
        visibility: 'partner',
        requiredGrants: { documentIds: ['doc-secret'] }
      }).safeMessage
    ).not.toContain('doc-secret');
  });

  it('keeps authorization summaries and audit metadata free of complete key or secret fields', () => {
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-1',
        username: 'alice',
        role: 'customer',
        grants: normalizeResourceGrantSet({ chipIds: ['E521.39'] })
      },
      key: {
        id: 'key-1',
        fingerprint: '123456abcdef',
        grants: { chipIds: ['E521.39'] }
      }
    });
    const denied = authorizeResourceAccess(summary, { type: 'chip', id: 'E522.94' });
    const redacted = redactAuthorizationMetadata({
      ...summary,
      token: 'fake-token-for-test',
      mcpKey: 'fake-complete-mcp-key',
      nested: { systemPrompt: 'fake prompt', workspaceDir: 'D:\\private\\kb' }
    });
    const serialized = JSON.stringify({ summary, denied, redacted });

    expect(serialized).toContain('123456abcdef');
    expect(serialized).not.toContain('fake-token-for-test');
    expect(serialized).not.toContain('fake-complete-mcp-key');
    expect(serialized).not.toContain('fake prompt');
    expect(serialized).not.toContain('D:\\private\\kb');
    expect(serialized).not.toMatch(/passwordHash|authorization/i);
  });
});

describe('auth middleware', () => {
  it('returns 401 for missing and invalid bearer tokens', () => {
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });

    const missingReq = makeRequest();
    const missingRes = makeResponse();
    expect(requireAuth(missingReq, missingRes as unknown as ServerResponse, service)).toBe(false);
    expect(missingRes.statusCode).toBe(401);

    const invalidReq = makeRequest('Bearer not-a-token');
    const invalidRes = makeResponse();
    expect(requireAuth(invalidReq, invalidRes as unknown as ServerResponse, service)).toBe(false);
    expect(invalidRes.statusCode).toBe(401);
  });

  it('returns 401 for expired tokens', () => {
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '-1s' });
    const token = service.sign('user-1', 'alice');
    const req = makeRequest(`Bearer ${token}`);
    const res = makeResponse();

    expect(requireAuth(req, res as unknown as ServerResponse, service)).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it('attaches user payload for valid bearer tokens', () => {
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });
    const token = service.sign('user-1', 'alice');
    const req = makeRequest(`Bearer ${token}`);
    const res = makeResponse();

    expect(requireAuth(req, res as unknown as ServerResponse, service)).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(req.user).toMatchObject({ userId: 'user-1', username: 'alice' });
  });

  it('checks admin requests against the token role', () => {
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });
    const adminToken = service.sign('admin-id', 'admin', 'admin');
    const userToken = service.sign('user-id', 'alice');
    const config = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
      dataDir: './data'
    } satisfies AuthConfig;

    const adminReq = makeRequest(`Bearer ${adminToken}`);
    const adminRes = makeResponse();
    expect(requireAdmin(adminReq, adminRes as unknown as ServerResponse, service, config)).toBe(true);

    const userReq = makeRequest(`Bearer ${userToken}`);
    const userRes = makeResponse();
    expect(requireAdmin(userReq, userRes as unknown as ServerResponse, service, config)).toBe(false);
    expect(userRes.statusCode).toBe(403);
  });

  it('usable auth rejects deleted, disabled, and expired users', async () => {
    const dataDir = await tempDataDir();
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });
    const store = new UserStore(await userStoreConfig(dataDir));
    await store.init();
    const disabled = await store.createUser('disabled-web', 'secret');
    const expired = await store.createUser('expired-web', 'secret');
    await store.updateUser(disabled.id, { status: 'disabled' });
    await store.updateUser(expired.id, { expiresAt: '2000-01-01T00:00:00.000Z' });

    try {
      for (const token of [
        service.sign('deleted-user', 'ghost'),
        service.sign(disabled.id, disabled.username),
        service.sign(expired.id, expired.username)
      ]) {
        const req = makeRequest(`Bearer ${token}`);
        const res = makeResponse();

        await expect(requireUsableAuth(req, res as unknown as ServerResponse, service, store)).resolves.toBe(false);
        expect(res.statusCode).toBe(401);
        expect(req.user).toBeUndefined();
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('usable auth overwrites stale token role and admin guard uses the current role', async () => {
    const dataDir = await tempDataDir();
    const store = new UserStore(await userStoreConfig(dataDir));
    await store.init();
    const user = await store.createUser('alice-role', 'secret', 'customer');
    const service = new JwtService({ jwtSecret: JWT_SECRET, jwtExpiresIn: '24h' });
    const staleAdminToken = service.sign(user.id, user.username, 'admin');

    try {
      const authReq = makeRequest(`Bearer ${staleAdminToken}`);
      const authRes = makeResponse();
      await expect(requireUsableAuth(authReq, authRes as unknown as ServerResponse, service, store)).resolves.toBe(true);
      expect(authReq.user).toMatchObject({ userId: user.id, username: user.username, role: 'customer' });

      const adminReq = makeRequest(`Bearer ${staleAdminToken}`);
      const adminRes = makeResponse();
      await expect(requireUsableAdmin(adminReq, adminRes as unknown as ServerResponse, service, store)).resolves.toBe(false);
      expect(adminRes.statusCode).toBe(403);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
