import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { UserStore } from '../src/auth/user-store.js';
import { JwtService } from '../src/auth/jwt-service.js';
import { createHttpServer } from '../src/http-server.js';
import type { AuditLogger } from '../src/logging/index.js';

const MIGRATION_NOW = new Date('2026-07-04T01:02:03.000Z');

const dataDirs: string[] = [];

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('authorization merge legacy chip access migration', () => {
  it('migrates legacy chip grants while preserving grant field presence', async () => {
    const { dataDir, legacyFile, store } = await createInitializedStore([
      userRecord('legacy-only', 'legacy-only', { resourceGrants: { brands: ['ELMOS'] } }),
      userRecord('legacy-empty', 'legacy-empty', { resourceGrants: { chipIds: ['EXISTING'] } }),
      userRecord('conflict', 'conflict', { resourceGrants: { chipIds: ['EXISTING', 'SHARED'] } }),
      userRecord('stale-empty', 'stale-empty', { resourceGrants: { chipIds: [], productLines: ['Lighting'] } })
    ]);
    await writeLegacyChipAccess(legacyFile, {
      'legacy-only': ['LEGACY-A'],
      'legacy-empty': [],
      conflict: ['SHARED', 'LEGACY-B']
    });
    const auditRecords: unknown[] = [];

    const result = await store.migrateLegacyChipAccess({
      legacyFile,
      auditLogger: captureAudit(auditRecords),
      now: () => MIGRATION_NOW
    });

    expect(result).toMatchObject({ migrated: true, changedUsers: 4 });
    const users = await readUsers(dataDir);
    expect(users.find((user) => user.id === 'legacy-only')?.resourceGrants).toEqual({
      brands: ['ELMOS'],
      chipIds: ['LEGACY-A']
    });
    expect(users.find((user) => user.id === 'legacy-empty')?.resourceGrants).toEqual({ chipIds: [] });
    expect(users.find((user) => user.id === 'conflict')?.resourceGrants).toEqual({
      chipIds: ['EXISTING', 'SHARED', 'LEGACY-B']
    });
    expect(users.find((user) => user.id === 'stale-empty')?.resourceGrants).toEqual({
      productLines: ['Lighting']
    });
    expect(JSON.stringify(users)).not.toContain('"documentIds":[]');
    expect(JSON.stringify(users)).not.toContain('"scopePresetIds":[]');
    expect(JSON.stringify(users)).not.toContain('"mcpTools":[]');
    expect(auditRecords).toHaveLength(4);
    await expectMigrationArtifacts(dataDir, legacyFile);
  });

  it('uses the sidecar marker to avoid overwriting manual grant changes on rerun', async () => {
    const { dataDir, legacyFile, store } = await createInitializedStore([
      userRecord('alice', 'alice', { resourceGrants: { chipIds: ['BEFORE'] } })
    ]);
    await writeLegacyChipAccess(legacyFile, { alice: ['LEGACY'] });

    await store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW });
    await store.updateUser('alice', { resourceGrants: { chipIds: ['MANUAL'] } });
    await writeLegacyChipAccess(legacyFile, { alice: [] });

    const result = await store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW });

    expect(result).toMatchObject({ migrated: false, changedUsers: 0 });
    const users = await readUsers(dataDir);
    expect(users.find((user) => user.id === 'alice')?.resourceGrants).toEqual({ chipIds: ['MANUAL'] });
    const marker = JSON.parse(await readFile(join(dataDir, 'users.json.migrations.json'), 'utf8')) as Record<string, unknown>;
    expect(marker).toHaveProperty('d4ChipAccessMerge');
  });

  it('normalizes stale empty chip grants even when the migration marker already exists', async () => {
    const { dataDir, legacyFile, store } = await createInitializedStore([
      userRecord('stale-empty', 'stale-empty', { resourceGrants: { chipIds: [], productLines: ['Lighting'] } }),
      userRecord('manual', 'manual', { resourceGrants: { chipIds: ['MANUAL'] } })
    ]);
    await writeLegacyChipAccess(legacyFile, { manual: [] });

    await store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW });
    const result = await store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW });

    expect(result).toMatchObject({ migrated: false, changedUsers: 0 });
    const users = await readUsers(dataDir);
    expect(users.find((user) => user.id === 'stale-empty')?.resourceGrants).toEqual({
      productLines: ['Lighting']
    });
    expect(users.find((user) => user.id === 'manual')?.resourceGrants).toEqual({ chipIds: [] });
  });

  it('does not mark migration complete for empty or malformed legacy catalogs', async () => {
    const { dataDir, legacyFile, store } = await createInitializedStore([
      userRecord('alice', 'alice', { resourceGrants: { productLines: ['Lighting'] } })
    ]);

    await writeFile(legacyFile, `${JSON.stringify({ users: {} }, null, 2)}\n`, 'utf8');
    await expect(store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW })).resolves.toMatchObject({
      migrated: false,
      changedUsers: 0
    });
    await expect(readFile(join(dataDir, 'users.json.migrations.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await writeFile(legacyFile, `${JSON.stringify({ notUsers: { alice: ['LEGACY'] } }, null, 2)}\n`, 'utf8');
    await expect(store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW })).resolves.toMatchObject({
      migrated: false,
      changedUsers: 0
    });
    await expect(readFile(join(dataDir, 'users.json.migrations.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not mark migration complete when any legacy user entry is malformed', async () => {
    const { dataDir, legacyFile, store } = await createInitializedStore([
      userRecord('alice', 'alice'),
      userRecord('bob', 'bob')
    ]);

    await writeFile(
      legacyFile,
      `${JSON.stringify({ users: { alice: ['LEGACY-A'], bob: 'LEGACY-B' } }, null, 2)}\n`,
      'utf8'
    );

    await expect(store.migrateLegacyChipAccess({ legacyFile, now: () => MIGRATION_NOW })).resolves.toMatchObject({
      migrated: false,
      changedUsers: 0
    });
    await expect(readFile(join(dataDir, 'users.json.migrations.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const users = await readUsers(dataDir);
    expect(users.find((user) => user.id === 'alice')?.resourceGrants).toBeUndefined();
    expect(users.find((user) => user.id === 'bob')?.resourceGrants).toBeUndefined();
  });

  it('runs migration during server startup before admin authorization reads and retires /admin/chip-access', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agentx-auth-merge-server-'));
    dataDirs.push(dataDir);
    const configDir = join(dataDir, 'config');
    const kbRoot = join(dataDir, 'kb');
    await mkdir(configDir, { recursive: true });
    await mkdir(join(kbRoot, 'LEGACY-A'), { recursive: true });

    const rolesFile = join(configDir, 'roles.json');
    const chipConfigFile = join(configDir, 'chips.json');
    const legacyFile = join(configDir, 'user-chip-access.json');
    await writeFile(
      rolesFile,
      JSON.stringify(
        {
          admin: {
            description: 'Administrator',
            permissions: ['users', 'roles', 'prompts', 'chips'],
            access: { allowedChips: ['*'], injectionPolicy: 'every_turn', grants: { chipIds: ['*'], mcpTools: ['*'] } }
          },
          customer: {
            description: 'Customer',
            permissions: [],
            access: { allowedChips: [], injectionPolicy: 'first_turn', grants: { mcpTools: ['agentx_whoami'] } }
          }
        },
        null,
        2
      ),
      'utf8'
    );
    await writeFile(
      chipConfigFile,
      JSON.stringify(
        {
          knowledgeBaseRoot: kbRoot,
          chips: [{ id: 'LEGACY-A', label: 'Legacy A', brand: 'ELMOS', workspaceDir: 'LEGACY-A' }]
        },
        null,
        2
      ),
      'utf8'
    );

    const config = {
      dataDir,
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10)
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const admin = (await userStore.findByUsername('admin'))!;
    const legacyUser = await userStore.createUser('legacy-user', 'legacy-secret', 'customer');
    await writeLegacyChipAccess(legacyFile, { [legacyUser.id]: ['LEGACY-A'] });

    let migrationCalls = 0;
    const originalMigrate = userStore.migrateLegacyChipAccess.bind(userStore);
    userStore.migrateLegacyChipAccess = async (...args) => {
      migrationCalls += 1;
      return originalMigrate(...args);
    };

    const jwtService = new JwtService(config);
    const server = createHttpServer({
      manager: {
        spawn: async () => ({ id: 'unused' }),
        log: () => ({ output: '', truncated: false, totalChars: 0, offset: 0 }),
        tail: () => ({ output: '', truncated: false, totalChars: 0, offset: 0 }),
        send: async () => undefined,
        submit: async () => undefined,
        poll: async () => ({ hasOutput: false, exited: false }),
        kill: async () => undefined,
        list: () => [],
        listWithPid: () => [],
        on: () => undefined,
        off: () => undefined
      } as any,
      auth: { enabled: true, config, userStore, jwtService, rolesFile },
      chips: { enabled: true, configFile: chipConfigFile, userAccessFile: legacyFile },
      prompts: { enabled: false },
      persistence: { enabled: false }
    });

    let startedServer: Server | undefined;
    try {
      startedServer = server;
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address() as AddressInfo;
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const adminToken = jwtService.sign(admin.id, admin.username, admin.role);

      const effective = await fetch(`${baseUrl}/admin/users/${legacyUser.id}/effective-authorization`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(effective.status).toBe(200);
      const body = await effective.json() as { dimensions: { chipIds: Array<{ id: string; source: string }> } };
      expect(body.dimensions.chipIds).toContainEqual({ id: 'LEGACY-A', source: 'user_override' });

      expect(migrationCalls).toBe(1);
      expect((await userStore.findById(legacyUser.id))?.resourceGrants).toEqual({ chipIds: ['LEGACY-A'] });

      const retiredGet = await fetch(`${baseUrl}/admin/chip-access`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(retiredGet.status).toBe(404);

      const retiredPut = await fetch(`${baseUrl}/admin/chip-access`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ users: { [legacyUser.id]: [] } })
      });
      expect(retiredPut.status).toBe(404);
    } finally {
      if (startedServer?.listening) {
        await new Promise<void>((resolve, reject) => startedServer.close((error) => (error ? reject(error) : resolve())));
      }
    }
  });
});

async function createInitializedStore(initialUsers: unknown[]): Promise<{
  dataDir: string;
  legacyFile: string;
  store: UserStore;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-auth-merge-'));
  dataDirs.push(dataDir);
  const configDir = join(dataDir, 'config');
  const legacyFile = join(configDir, 'user-chip-access.json');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(dataDir, 'users.json'), `${JSON.stringify(initialUsers, null, 2)}\n`, 'utf8');
  const store = new UserStore({
    dataDir,
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10)
  });
  await store.init();
  return { dataDir, legacyFile, store };
}

function userRecord(
  id: string,
  username: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    username,
    passwordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
    mcpKeys: [],
    createdAt: '2026-07-01T00:00:00.000Z',
    role: 'customer',
    ...extra
  };
}

async function writeLegacyChipAccess(legacyFile: string, users: Record<string, string[]>): Promise<void> {
  await writeFile(legacyFile, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8');
}

async function readUsers(dataDir: string): Promise<Array<{ id: string; resourceGrants?: Record<string, string[]> }>> {
  return JSON.parse(await readFile(join(dataDir, 'users.json'), 'utf8')) as Array<{
    id: string;
    resourceGrants?: Record<string, string[]>;
  }>;
}

function captureAudit(records: unknown[]): AuditLogger {
  return {
    log(event, message, context) {
      const record = { event, message, context };
      records.push(record);
      return {
        timestamp: MIGRATION_NOW.toISOString(),
        level: 'info',
        event,
        message,
        ...context
      };
    }
  };
}

async function expectMigrationArtifacts(dataDir: string, legacyFile: string): Promise<void> {
  const dataFiles = await readdir(dataDir);
  const configFiles = await readdir(join(dataDir, 'config'));
  expect(dataFiles).toContain('users.json.migrations.json');
  expect(dataFiles).toContain('users.json.pre-d4-migration-2026-07-04T01-02-03-000Z.bak');
  expect(configFiles).toContain('user-chip-access.json.pre-d4-migration-2026-07-04T01-02-03-000Z.bak');
  expect(JSON.parse(await readFile(join(dataDir, 'users.json.migrations.json'), 'utf8'))).toHaveProperty(
    'd4ChipAccessMerge'
  );
  await expect(readFile(join(dataDir, 'users.json.pre-d4-migration-2026-07-04T01-02-03-000Z.bak'), 'utf8')).resolves
    .toContain('legacy-only');
  await expect(readFile(`${legacyFile}.pre-d4-migration-2026-07-04T01-02-03-000Z.bak`, 'utf8')).resolves.toContain(
    'LEGACY-A'
  );
}
