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
import { CreditLedger } from '../src/credits.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  return {
    spawn: vi.fn(),
    log: vi.fn(),
    tail: vi.fn(),
    send: vi.fn(),
    submit: vi.fn(),
    poll: vi.fn(),
    kill: vi.fn(),
    listWithPid: vi.fn(() => []),
    on: vi.fn(),
    off: vi.fn()
  };
}

async function startAccountServer(options: { persistence?: boolean; chips?: boolean; resources?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-account-routes-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', {
    profile: { realName: 'Alice', note: 'admin-only note' },
    selfService: {
      allowMcpKeySelfCreate: true,
      maxMcpKeys: 1,
      defaultMcpKeyTtlDays: 7,
      allowMcpKeyRegenerate: true
    }
  });
  const bob = await userStore.createUser('bob', 'bob-secret', 'customer', {
    selfService: {
      allowMcpKeySelfCreate: true,
      maxMcpKeys: 2,
      defaultMcpKeyTtlDays: 7,
      allowMcpKeyRegenerate: true
    }
  });
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
  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: createFakeManager() as any,
    auth: { enabled: true, config, userStore, jwtService },
    logger: logger as any,
    persistence: options.persistence ? { enabled: true, dataDir, fileLogging: false } : { enabled: false, dataDir },
    chips: options.chips
      ? {
          enabled: true,
          userAccessFile: join(dataDir, 'user-chip-access.json'),
          catalog: {
            knowledgeBaseRoot: 'D:\\private\\knowledge-base',
            chips: [
              {
                id: 'e522',
                label: 'E522 family',
                description: 'Lighting devices',
                queryHint: 'E522',
                workspaceDir: 'D:\\private\\knowledge-base\\E522'
              },
              {
                id: 'e521',
                label: 'E521 family',
                workspaceDir: 'D:\\private\\knowledge-base\\E521'
              }
            ]
          }
        }
      : { enabled: false },
    prompts: { enabled: false },
    resources: options.resources
      ? {
          enabled: true,
          catalog: {
            documents: [
              {
                documentId: 'doc-alice',
                label: 'Alice visible datasheet',
                visibility: 'customer',
                status: 'approved',
                sourceLabels: ['datasheet', 'D:\\private\\hidden.pdf']
              },
              {
                documentId: 'doc-hidden',
                label: 'Hidden workspace doc',
                visibility: 'restricted',
                status: 'approved',
                sourceLabels: ['D:\\private\\hidden-workspace.pdf']
              }
            ],
            scopePresets: [
              {
                scopePresetId: 'lighting',
                label: 'Lighting scope',
                visibility: 'customer',
                status: 'approved',
                sourceLabels: ['lighting preset']
              }
            ]
          }
        }
      : { enabled: false }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    alice,
    bob,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    jwtService,
    logs,
    server,
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

async function loginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return ((await response.json()) as any).token;
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('account self-service API', () => {
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

  it('returns current account details without password hashes, admin notes, or full MCP keys', async () => {
    const started = await startAccountServer({ chips: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const key = await started.userStore.addMcpKey(started.alice.id, 'existing', { modelGrants: ['sonnet'] });
    await started.userStore.updateUser(started.alice.id, {
      modelGrants: ['haiku'],
      resourceGrants: { chipIds: ['e522', 'e521'], documentIds: ['doc-alice'], scopePresetIds: ['lighting'], mcpTools: ['agentx_whoami'] }
    });

    const response = await fetch(`${started.baseUrl}/api/account`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({ id: started.alice.id, username: 'alice' });
    expect(body.user.localePreference).toBe('zh-CN');
    expect(body.user.preferredLanguage).toBe('zh-CN');
    expect(body.user.onboarding).toMatchObject({
      status: 'not_started',
      completedSteps: [],
      dismissedHints: []
    });
    expect(body.user.profile.note).toBeUndefined();
    expect(body.permissions.mcpKeyPolicy).toMatchObject({ allowMcpKeySelfCreate: true, maxMcpKeys: 1 });
    expect(body.permissions.selfService).toMatchObject({ profile: true, password: true, mcpKeys: true });
    expect(body.permissions.authorizedModels).toEqual(['haiku']);
    expect(body.permissions.availableModels).toEqual([
      expect.objectContaining({ id: 'haiku', label: expect.any(String), creditUnits: 50 })
    ]);
    expect(body.permissions.authorizationSummary).toMatchObject({
      subject: { userId: started.alice.id, role: 'customer' },
      usable: true,
      grants: expect.objectContaining({
        chipIds: ['e522', 'e521'],
        documentIds: ['doc-alice'],
        scopePresetIds: ['lighting'],
        mcpTools: ['agentx_whoami']
      })
    });
    expect(body.permissions.resources).toEqual([
      expect.objectContaining({ id: 'e522', label: 'E522 family' }),
      expect.objectContaining({ id: 'e521', label: 'E521 family' })
    ]);
    expect(body.mcpKeys[0]).toMatchObject({
      id: key.id,
      fingerprint: expect.any(String),
      maskedKey: expect.any(String),
      authorizedModels: []
    });
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(key.key);
    expect(serialized).not.toContain('workspaceDir');
    expect(serialized).not.toContain('knowledgeBaseRoot');
    expect(serialized).not.toContain('D:\\private');
  });

  it('updates only the authenticated user locale and onboarding state', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const locale = await fetch(`${started.baseUrl}/api/account/locale`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: started.bob.id,
        role: 'admin',
        locale: 'en-US'
      })
    });
    const localeBody = await json(locale);

    const onboarding = await fetch(`${started.baseUrl}/api/account/onboarding`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: started.bob.id,
        status: 'in_progress',
        completedSteps: ['profile', 'mcp_access', 'profile'],
        dismissedHints: ['welcome.banner']
      })
    });
    const onboardingBody = await json(onboarding);

    expect(locale.status).toBe(200);
    expect(localeBody.user).toMatchObject({ id: started.alice.id, localePreference: 'en-US', preferredLanguage: 'en-US' });
    expect(onboarding.status).toBe(200);
    expect(onboardingBody.user.onboarding).toMatchObject({
      status: 'in_progress',
      completedSteps: ['profile', 'mcp_access'],
      dismissedHints: ['welcome.banner']
    });
    expect((await started.userStore.findById(started.bob.id))?.localePreference).toBeUndefined();
    expect((await started.userStore.findById(started.bob.id))?.onboarding).toBeUndefined();
    expect((await started.userStore.findById(started.alice.id))?.role).toBe('customer');
  });

  it('rejects unsupported locale and unknown onboarding steps', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const locale = await fetch(`${started.baseUrl}/api/account/locale`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'fr-FR' })
    });
    const onboarding = await fetch(`${started.baseUrl}/api/account/onboarding`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ completedSteps: ['profile', 'unknown_step'] })
    });

    expect(locale.status).toBe(400);
    expect(onboarding.status).toBe(400);
    expect((await started.userStore.findById(started.alice.id))?.localePreference).toBeUndefined();
    expect((await started.userStore.findById(started.alice.id))?.onboarding).toBeUndefined();
  });

  it('returns admin user summaries with onboarding and locale but without secrets', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');
    const key = await started.userStore.addMcpKey(started.alice.id, 'alice-admin-summary');
    await started.userStore.updateOwnLocale(started.alice.id, 'en-US');
    await started.userStore.updateOwnOnboarding(started.alice.id, {
      status: 'completed',
      completedSteps: ['profile', 'mcp_key'],
      dismissedHints: ['welcome.banner']
    });

    const response = await fetch(`${started.baseUrl}/admin/users`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const body = await json(response);
    const alice = body.users.find((user: any) => user.id === started.alice.id);
    const serialized = JSON.stringify(alice);

    expect(response.status).toBe(200);
    expect(alice).toMatchObject({
      localePreference: 'en-US',
      preferredLanguage: 'en-US',
      onboarding: {
        status: 'completed',
        completedSteps: ['profile', 'mcp_key'],
        dismissedHints: ['welcome.banner']
      }
    });
    expect(serialized).not.toContain(key.key);
    expect(serialized).not.toContain('passwordHash');
    expect(alice.mcpKeys[0]).toMatchObject({ fingerprint: expect.any(String), maskedKey: expect.any(String) });
  });

  it('lets onboarding skip be reopened without leaking secrets to audit logs', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const bobToken = await loginToken(started.baseUrl, 'bob', 'bob-secret');

    await fetch(`${started.baseUrl}/api/account/onboarding`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'skipped',
        dismissedHints: ['mcp.key.tip'],
        token: 'fake-token',
        key: 'fake-mcp-key',
        password: 'fake-password'
      })
    });
    const reopened = await fetch(`${started.baseUrl}/api/account/onboarding`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress', completedSteps: ['profile'] })
    });
    const body = await json(reopened);

    expect(reopened.status).toBe(200);
    expect(body.user.onboarding.status).toBe('in_progress');
    expect(body.user.onboarding.dismissedHints).toEqual(['mcp.key.tip']);
    expect(JSON.stringify(started.logs)).not.toMatch(/fake-token|fake-mcp-key|fake-password/i);
    expect(started.logs.map((record) => record.event)).toContain('account_onboarding_update');
  });

  it('returns document and scope preset summaries without exposing workspace paths', async () => {
    const started = await startAccountServer({ resources: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { documentIds: ['doc-alice'], scopePresetIds: ['lighting'] }
    });

    const response = await fetch(`${started.baseUrl}/api/account`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const body = await json(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.permissions.resources).toEqual([
      expect.objectContaining({ type: 'document', id: 'doc-alice', label: 'Alice visible datasheet', visibility: 'customer' }),
      expect.objectContaining({ type: 'scopePreset', id: 'lighting', label: 'Lighting scope', visibility: 'customer' })
    ]);
    expect(serialized).not.toContain('doc-hidden');
    expect(serialized).not.toContain('Hidden workspace doc');
    expect(serialized).not.toMatch(/workspaceDir|serverPath|knowledgeBaseRoot|D:\\private|hidden\.pdf/i);
  });

  it('returns only the authenticated user credits ledger in account APIs', async () => {
    const started = await startAccountServer({ persistence: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const ledger = new CreditLedger({ dataDir });

    await ledger.append({
      userId: started.alice.id,
      username: 'alice',
      entry: 'chat',
      modelId: 'haiku',
      units: 50,
      status: 'charged',
      reason: 'completed',
      sessionId: 'alice-session',
      requestId: 'alice-request',
      metadata: { provider: 'deepseek', token: 'secret-token' }
    });
    await ledger.append({
      userId: started.bob.id,
      username: 'bob',
      entry: 'chat',
      modelId: 'sonnet',
      units: 100,
      status: 'charged',
      reason: 'completed',
      sessionId: 'bob-session',
      requestId: 'bob-request'
    });

    const credits = await fetch(`${started.baseUrl}/api/account/credits?limit=10`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const creditsBody = await json(credits);
    const overview = await fetch(`${started.baseUrl}/api/account`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const overviewBody = await json(overview);

    expect(credits.status).toBe(200);
    expect(creditsBody.ledger.items).toHaveLength(1);
    expect(creditsBody.ledger.items[0]).toMatchObject({
      userId: started.alice.id,
      entry: 'chat',
      modelId: 'haiku',
      units: 50,
      status: 'charged',
      reason: 'completed',
      sessionId: 'alice-session',
      requestId: 'alice-request',
      metadata: { provider: 'deepseek' }
    });
    expect(JSON.stringify(creditsBody)).not.toContain(started.bob.id);
    expect(JSON.stringify(creditsBody)).not.toContain('bob-session');
    expect(JSON.stringify(creditsBody)).not.toContain('secret-token');
    expect(overviewBody.credits.recentLedger.items).toHaveLength(1);
    expect(overviewBody.credits.recentLedger.items[0].userId).toBe(started.alice.id);
  });

  it('updates only the authenticated user profile even when body contains another userId', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const response = await fetch(`${started.baseUrl}/api/account/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: started.bob.id,
        profile: {
          realName: 'Alice Updated',
          focusBrands: [' ELMOS ', '', 'ELMOS', 'ADI']
        }
      })
    });

    expect(response.status).toBe(200);
    expect((await started.userStore.findById(started.alice.id))?.profile).toMatchObject({
      realName: 'Alice Updated',
      focusBrands: ['ELMOS', 'ADI']
    });
    expect((await started.userStore.findById(started.bob.id))?.profile?.realName).toBeUndefined();
  });

  it('ignores grant fields submitted through account profile updates', async () => {
    const started = await startAccountServer({ chips: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const response = await fetch(`${started.baseUrl}/api/account/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: { realName: 'Alice Safe' },
        resourceGrants: { chipIds: ['e522'] },
        modelGrants: ['sonnet']
      })
    });

    expect(response.status).toBe(200);
    const stored = await started.userStore.findById(started.alice.id);
    expect(stored?.profile?.realName).toBe('Alice Safe');
    expect(stored?.resourceGrants).toBeUndefined();
    expect(stored?.modelGrants).toBeUndefined();
  });

  it('requires current password before changing the authenticated user password', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const wrong = await fetch(`${started.baseUrl}/api/account/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'wrong-secret', newPassword: 'alice-new-secret' })
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${started.baseUrl}/api/account/password`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'alice-secret', newPassword: 'alice-new-secret' })
    });
    expect(ok.status).toBe(200);
    expect(await loginToken(started.baseUrl, 'alice', 'alice-new-secret')).toEqual(expect.any(String));
    expect(started.logs.some((record) => record.event === 'account_password_change')).toBe(true);
  });

  it('creates self-service MCP keys with one-time secret and never returns it from list', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

    const created = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'laptop' })
    });
    const createdBody = await json(created);
    expect(created.status).toBe(201);
    expect(createdBody.secret).toMatch(/^[0-9a-f-]{36}$/i);
    expect(createdBody.key).toMatchObject({ name: 'laptop', fingerprint: expect.any(String), maskedKey: expect.any(String) });
    expect(createdBody.key.key).toBeUndefined();

    const listed = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const listedBody = await json(listed);
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.secret);
    expect(listedBody.keys[0].key).toBeUndefined();
    expect(started.logs.some((record) => JSON.stringify(record).includes(createdBody.secret))).toBe(false);
  });

  it('enforces self-service policy disabled and max key limit without leaking existing keys', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const bobToken = await loginToken(started.baseUrl, 'bob', 'bob-secret');
    await started.userStore.updateUser(started.bob.id, { selfService: { allowMcpKeySelfCreate: false } });

    const disabled = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'blocked' })
    });
    expect(disabled.status).toBe(403);
    expect((await started.userStore.findById(started.bob.id))?.mcpKeys).toHaveLength(0);

    const first = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'first' })
    });
    const firstBody = await json(first);
    const limited = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second' })
    });
    expect(limited.status).toBe(409);
    expect(JSON.stringify(await json(limited))).not.toContain(firstBody.secret);
  });

  it('prevents cross-user revoke, regenerates with old secret invalidated, and revokes immediately', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const bobToken = await loginToken(started.baseUrl, 'bob', 'bob-secret');
    const aliceKey = await started.userStore.addMcpKey(started.alice.id, 'alice-only');

    const crossRevoke = await fetch(`${started.baseUrl}/api/account/mcp-keys/${aliceKey.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    expect(crossRevoke.status).toBe(404);
    expect(await started.userStore.lookupUsableMcpKey(aliceKey.key)).not.toBeNull();

    const created = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob-key' })
    });
    const createdBody = await json(created);
    const oldSecret = createdBody.secret;

    const regenerated = await fetch(`${started.baseUrl}/api/account/mcp-keys/${createdBody.key.id}/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    const regeneratedBody = await json(regenerated);
    expect(regenerated.status).toBe(200);
    expect(regeneratedBody.secret).not.toBe(oldSecret);
    expect(await started.userStore.lookupUsableMcpKey(oldSecret)).toBeNull();
    expect(await started.userStore.lookupUsableMcpKey(regeneratedBody.secret)).not.toBeNull();

    const revoked = await fetch(`${started.baseUrl}/api/account/mcp-keys/${createdBody.key.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    expect(revoked.status).toBe(204);
    expect(await started.userStore.lookupUsableMcpKey(regeneratedBody.secret)).toBeNull();
  });

  it('audits profile and MCP key updates without leaking generated secrets', async () => {
    const started = await startAccountServer();
    server = started.server;
    dataDir = started.dataDir;
    const bobToken = await loginToken(started.baseUrl, 'bob', 'bob-secret');

    await fetch(`${started.baseUrl}/api/account/profile`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ realName: 'Bob' })
    });
    const created = await fetch(`${started.baseUrl}/api/account/mcp-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob-key' })
    });
    const createdBody = await json(created);
    await fetch(`${started.baseUrl}/api/account/mcp-keys/${createdBody.key.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'bob-key-renamed' })
    });
    await fetch(`${started.baseUrl}/api/account/mcp-keys/${createdBody.key.id}/regenerate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bobToken}` }
    });
    await fetch(`${started.baseUrl}/api/account/mcp-keys/${createdBody.key.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bobToken}` }
    });

    const events = started.logs.map((record) => record.event);
    const serializedLogs = JSON.stringify(started.logs);
    expect(events).toEqual(
      expect.arrayContaining([
        'account_profile_update',
        'account_mcp_key_create',
        'account_mcp_key_update',
        'account_mcp_key_regenerate',
        'account_mcp_key_revoke'
      ])
    );
    expect(serializedLogs).not.toContain(createdBody.secret);
    expect(serializedLogs).not.toMatch(/password|authorization|token/i);
  });
});
