import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG,
  authorizeModelAccess,
  getDefaultModelForChatMode,
  getDefaultModelGrantsForRole,
  getEffectiveModelGrants,
  listEnabledModels
} from '../src/model-catalog.js';
import { UserStore } from '../src/auth/user-store.js';

const dataDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-model-catalog-'));
  dataDirs.push(dataDir);
  return dataDir;
}

async function createStore(dataDir?: string): Promise<UserStore> {
  const store = new UserStore({
    dataDir: dataDir ?? (await makeDataDir()),
    adminUser: 'admin',
    adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
  });
  await store.init();
  return store;
}

describe('model catalog', () => {
  afterEach(async () => {
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('defines the trusted enabled server catalog without provider secrets', () => {
    expect(MODEL_CATALOG.map((model) => model.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(listEnabledModels()).toEqual([
      expect.objectContaining({
        id: 'haiku',
        provider: 'claude-code',
        capabilities: ['text'],
        creditUnits: 50,
        enabled: true
      }),
      expect.objectContaining({
        id: 'sonnet',
        provider: 'claude-code',
        capabilities: ['text', 'long-context', 'multi-doc', 'scope-search'],
        creditUnits: 100,
        enabled: true
      }),
      expect.objectContaining({
        id: 'opus',
        provider: 'claude-code',
        capabilities: ['text', 'image-input', 'multimodal'],
        creditUnits: 150,
        enabled: true
      }),
      expect.objectContaining({
        id: 'fable',
        provider: 'claude-code',
        capabilities: ['text'],
        creditUnits: 50,
        enabled: true
      })
    ]);
    expect(JSON.stringify(MODEL_CATALOG)).not.toMatch(/key|token|secret/i);
  });

  it('maps chat modes to conservative server defaults', () => {
    expect(getDefaultModelForChatMode(undefined)).toBe('haiku');
    expect(getDefaultModelForChatMode('standard')).toBe('haiku');
    expect(getDefaultModelForChatMode('enhanced')).toBe('sonnet');
    expect(getDefaultModelForChatMode('multimodal')).toBe('opus');
  });

  it('rejects unknown model ids with a structured error', () => {
    const result = authorizeModelAccess({
      requestedModelId: 'not-a-real-model',
      role: 'admin'
    });

    expect(result).toEqual({
      ok: false,
      authorizedModelIds: ['haiku', 'sonnet', 'opus', 'fable'],
      error: {
        code: 'UNKNOWN_MODEL',
        message: 'Unknown model: not-a-real-model',
        modelId: 'not-a-real-model'
      }
    });
  });

  it('applies role default grants conservatively', () => {
    expect(getDefaultModelGrantsForRole('admin')).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(getDefaultModelGrantsForRole('internal')).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    expect(getDefaultModelGrantsForRole('partner')).toEqual(['haiku']);
    expect(getDefaultModelGrantsForRole('customer')).toEqual(['haiku']);
    expect(getDefaultModelGrantsForRole('public')).toEqual(['haiku']);
    expect(getDefaultModelGrantsForRole('custom-role')).toEqual(['haiku']);
  });

  it('lets MCP key grants narrow user grants', () => {
    expect(
      getEffectiveModelGrants({
        role: 'admin',
        mcpKeyModelGrants: ['sonnet']
      })
    ).toEqual(['sonnet']);

    const result = authorizeModelAccess({
      requestedModelId: 'haiku',
      role: 'admin',
      mcpKeyModelGrants: ['sonnet']
    });

    expect(result).toMatchObject({
      ok: false,
      authorizedModelIds: ['sonnet'],
      error: { code: 'MODEL_NOT_AUTHORIZED', modelId: 'haiku' }
    });
  });

  it('keeps admins on every model even with stale narrowed user grants', () => {
    // 管理员默认拥有全部权限：即便用户记录里残留被收窄的 modelGrants，也解析为全部模型
    expect(
      getEffectiveModelGrants({
        role: 'admin',
        userModelGrants: ['haiku']
      })
    ).toEqual(['haiku', 'sonnet', 'opus', 'fable']);

    // MCP key 仍可在管理员之上按 key 收窄
    expect(
      getEffectiveModelGrants({
        role: 'admin',
        userModelGrants: ['haiku'],
        mcpKeyModelGrants: ['sonnet']
      })
    ).toEqual(['sonnet']);
  });

  it('keeps old user data compatible and exposes effective authorized models', async () => {
    const dataDir = await makeDataDir();
    await writeFile(
      join(dataDir, 'users.json'),
      JSON.stringify(
        [
          {
            id: 'legacy-user',
            username: 'legacy',
            passwordHash: 'hash',
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
    const store = await createStore(dataDir);

    const legacy = await store.findByUsername('legacy');
    expect(legacy?.modelGrants).toBeUndefined();
    expect(store.toPublicUser(legacy!).authorizedModels).toEqual(['haiku']);
  });

  it('stores explicit user and MCP key model grants without exposing key secrets in public DTOs', async () => {
    const store = await createStore();
    const user = await store.createUser('alice', 'correct-password', 'admin', {
      modelGrants: ['haiku', 'sonnet']
    });
    const key = await store.addMcpKey(user.id, 'workstation', { modelGrants: ['sonnet'] });
    const found = await store.findById(user.id);

    expect(found?.modelGrants).toEqual(['haiku', 'sonnet']);
    expect(store.getAuthorizedModelIdsForMcpKey(found!, key)).toEqual(['sonnet']);
    expect(store.toPublicUser(found!)).toMatchObject({
      authorizedModels: ['haiku', 'sonnet'],
      mcpKeys: [expect.objectContaining({ modelGrants: ['sonnet'] })]
    });
    expect(JSON.stringify(store.toPublicUser(found!))).not.toContain(key.key);
  });
});
