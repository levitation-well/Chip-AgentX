import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';
import {
  loadResourceVisibilityCatalogFromFile,
  parseResourceVisibilityCatalog,
  serializeResourceVisibilityCatalog,
  writeResourceVisibilityCatalogToFile,
  type ResourceVisibilityCatalog
} from '../src/security/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-admin-resources-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function seedCatalog(): ResourceVisibilityCatalog {
  return parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'doc-seed',
        label: 'Seed doc',
        visibility: 'restricted',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['CHIP-SEED'],
        requiredGrants: { documentIds: ['doc-seed'] },
        sourceLabels: ['seed']
      }
    ],
    scopePresets: [
      {
        scopePresetId: 'scope-seed',
        label: 'Seed scope',
        visibility: 'restricted',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['CHIP-SEED'],
        documentIds: ['doc-seed'],
        requiredGrants: { scopePresetIds: ['scope-seed'] },
        sourceLabels: ['seed']
      }
    ]
  });
}

async function startResourceServer(options: { configFile?: string; catalog?: ResourceVisibilityCatalog } = {}) {
  const dataDir = await tempDir();
  const authDir = await tempDir();
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir: authDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer');
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  const resources = options.configFile
    ? { enabled: true as const, configFile: options.configFile }
    : { enabled: true as const, catalog: options.catalog ?? seedCatalog() };
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: false },
    prompts: { enabled: false },
    resources,
    persistence: { dataDir },
    product: { config: { edition: 'public' } }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    userStore,
    jwtService,
    alice,
    admin: admin!
  };
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function token(
  started: Awaited<ReturnType<typeof startResourceServer>>,
  user: { id: string; username: string; role: string }
): string {
  return started.jwtService.sign(user.id, user.username, user.role);
}

async function readJson(response: Response): Promise<any> {
  return (await response.json()) as any;
}

describe('Task 5.1 — resource catalog JSON atomic write-back + audit fields', () => {
  it('round-trips a document with status/visibility/requiredGrants and audit fields through serialize -> write -> load', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'resource-visibility.json');
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-e52295',
          label: 'E522.95 Datasheet',
          visibility: 'restricted',
          status: 'approved',
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          applicationTags: ['Automotive lighting'],
          chipIds: ['E522.95'],
          requiredGrants: { documentIds: ['doc-e52295'] },
          sourceLabels: ['E522.95 datasheet'],
          requestedBy: 'alice',
          requestedAt: '2026-06-24T08:00:00.000Z',
          approvedBy: 'admin',
          approvedAt: '2026-06-24T09:00:00.000Z',
          approvalNotes: 'Reviewed for public release'
        }
      ],
      scopePresets: [
        {
          scopePresetId: 'scope-lighting',
          label: 'Lighting scope',
          visibility: 'customer',
          status: 'pending',
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          applicationTags: ['Automotive lighting'],
          chipIds: ['E522.95'],
          documentIds: ['doc-e52295'],
          requiredGrants: { scopePresetIds: ['scope-lighting'] },
          sourceLabels: ['lighting'],
          requestedBy: 'bob',
          requestedAt: '2026-06-24T10:00:00.000Z'
        }
      ]
    });

    await writeResourceVisibilityCatalogToFile(configFile, catalog);
    const reloaded = await loadResourceVisibilityCatalogFromFile(configFile);

    expect(reloaded).toEqual(catalog);

    const doc = reloaded.documents[0];
    expect(doc.requestedBy).toBe('alice');
    expect(doc.requestedAt).toBe('2026-06-24T08:00:00.000Z');
    expect(doc.approvedBy).toBe('admin');
    expect(doc.approvedAt).toBe('2026-06-24T09:00:00.000Z');
    expect(doc.approvalNotes).toBe('Reviewed for public release');

    const preset = reloaded.scopePresets[0];
    expect(preset.requestedBy).toBe('bob');
    expect(preset.approvedBy).toBeUndefined();
    expect(preset.approvedAt).toBeUndefined();
  });

  it('serialize(parse(x)) is a deep round-trip', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-1',
          label: 'Doc one',
          visibility: 'internal',
          status: 'draft',
          chipIds: ['CHIP1'],
          requiredGrants: {},
          approvedBy: 'admin',
          approvedAt: '2026-06-24T00:00:00.000Z'
        }
      ],
      scopePresets: []
    });
    const reparsed = parseResourceVisibilityCatalog(serializeResourceVisibilityCatalog(catalog));
    expect(reparsed).toEqual(catalog);
  });

  it('tolerates legacy JSON with no audit fields (missing -> undefined)', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'legacy.json');
    // Legacy on-disk shape without any audit fields.
    const legacy: unknown = {
      documents: [
        {
          documentId: 'doc-legacy',
          label: 'Legacy doc',
          visibility: 'restricted',
          status: 'approved',
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          applicationTags: [],
          chipIds: ['E522.95'],
          requiredGrants: { documentIds: ['doc-legacy'] },
          sourceLabels: []
        }
      ]
    };
    await writeResourceVisibilityCatalogToFile(configFile, parseResourceVisibilityCatalog(legacy));
    const reloaded = await loadResourceVisibilityCatalogFromFile(configFile);
    const doc = reloaded.documents[0];
    expect(doc.documentId).toBe('doc-legacy');
    expect(doc.requestedBy).toBeUndefined();
    expect(doc.requestedAt).toBeUndefined();
    expect(doc.approvedBy).toBeUndefined();
    expect(doc.approvedAt).toBeUndefined();
    expect(doc.approvalNotes).toBeUndefined();
  });

  it('serialized shape includes audit fields when present and omits them when absent', () => {
    const catalog: ResourceVisibilityCatalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-audit',
          label: 'Audit doc',
          visibility: 'restricted',
          status: 'approved',
          chipIds: [],
          requiredGrants: {},
          approvedBy: 'admin',
          approvedAt: '2026-06-24T09:00:00.000Z'
        },
        {
          documentId: 'doc-plain',
          label: 'Plain doc',
          visibility: 'restricted',
          status: 'approved',
          chipIds: [],
          requiredGrants: {}
        }
      ],
      scopePresets: []
    });
    const serialized = serializeResourceVisibilityCatalog(catalog) as {
      documents: Array<Record<string, unknown>>;
    };
    expect(serialized.documents[0].approvedBy).toBe('admin');
    expect(serialized.documents[0].approvedAt).toBe('2026-06-24T09:00:00.000Z');
    // Absent audit fields must NOT be serialized as keys.
    expect('approvedBy' in serialized.documents[1]).toBe(false);
    expect('requestedBy' in serialized.documents[1]).toBe(false);
  });
});

describe('Task 5.3 — admin resource CRUD endpoints', () => {
  it('rejects non-admin callers with 403', async () => {
    const started = await startResourceServer();
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources`, {
        headers: { authorization: `Bearer ${token(started, started.alice)}` }
      });
      expect(response.status).toBe(403);
    } finally {
      await closeServer(started.server);
    }
  });

  it('GET /admin/resources returns documents and scope presets with counts', async () => {
    const started = await startResourceServer();
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.counts.documents).toBe(1);
      expect(body.counts.scopePresets).toBe(1);
      expect(body.documents.map((d: any) => d.documentId)).toContain('doc-seed');
      expect(body.scopePresets.map((p: any) => p.scopePresetId)).toContain('scope-seed');
    } finally {
      await closeServer(started.server);
    }
  });

  it('POST a document then GET lists it', async () => {
    const started = await startResourceServer();
    try {
      const create = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          documentId: 'doc-new',
          label: 'New doc',
          visibility: 'internal',
          status: 'draft',
          chipIds: ['CHIP-NEW'],
          requiredGrants: { documentIds: ['doc-new'] }
        })
      });
      expect(create.status).toBe(201);

      const list = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const body = await readJson(list);
      expect(body.documents.map((d: any) => d.documentId)).toContain('doc-new');
    } finally {
      await closeServer(started.server);
    }
  });

  it('GET /admin/resources/documents filters by status and visibility', async () => {
    const started = await startResourceServer();
    try {
      await fetch(`${started.baseUrl}/admin/resources/documents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          documentId: 'doc-draft',
          label: 'Draft doc',
          visibility: 'internal',
          status: 'draft',
          chipIds: [],
          requiredGrants: {}
        })
      });
      const filtered = await fetch(`${started.baseUrl}/admin/resources/documents?status=draft`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const body = await readJson(filtered);
      expect(body.documents.map((d: any) => d.documentId)).toEqual(['doc-draft']);
    } finally {
      await closeServer(started.server);
    }
  });

  it('PUT status draft -> approved stamps approvedBy/approvedAt from the request user', async () => {
    const started = await startResourceServer();
    try {
      await fetch(`${started.baseUrl}/admin/resources/documents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          documentId: 'doc-pending',
          label: 'Pending doc',
          visibility: 'internal',
          status: 'draft',
          chipIds: [],
          requiredGrants: {}
        })
      });
      const update = await fetch(`${started.baseUrl}/admin/resources/documents/doc-pending`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(update.status).toBe(200);
      const body = await readJson(update);
      expect(body.document.status).toBe('approved');
      expect(body.document.approvedBy).toBe('admin');
      expect(typeof body.document.approvedAt).toBe('string');
      expect(body.document.approvedAt.length).toBeGreaterThan(0);
    } finally {
      await closeServer(started.server);
    }
  });

  it('DELETE a document referenced by a preset defaults to 409 and blocks the delete (V8)', async () => {
    const started = await startResourceServer();
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources/documents/doc-seed`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(response.status).toBe(409);
      const body = await readJson(response);
      const referencingIds = body.referencingScopePresetIds ?? body.details?.referencingScopePresetIds;
      expect(referencingIds).toContain('scope-seed');

      // The document must still be present — the delete was blocked, not applied.
      const list = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const listBody = await readJson(list);
      expect(listBody.documents.map((d: any) => d.documentId)).toContain('doc-seed');
    } finally {
      await closeServer(started.server);
    }
  });

  it('DELETE ?force=true a referenced document deletes it and strips the orphan reference from the preset (V8)', async () => {
    const started = await startResourceServer();
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources/documents/doc-seed?force=true`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.deleted).toBe(true);
      expect(body.referencingScopePresetIds).toContain('scope-seed');

      // The document is actually gone afterwards.
      const list = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const listBody = await readJson(list);
      expect(listBody.documents.map((d: any) => d.documentId)).not.toContain('doc-seed');

      // The referencing preset no longer lists the deleted document id — no orphan left behind.
      const presets = await fetch(`${started.baseUrl}/admin/resources/scope-presets`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const presetsBody = await readJson(presets);
      const scopeSeed = presetsBody.scopePresets.find((p: any) => p.scopePresetId === 'scope-seed');
      expect(scopeSeed.documentIds).not.toContain('doc-seed');
    } finally {
      await closeServer(started.server);
    }
  });

  it('POST /admin/resources/scope-presets/:id/validate reports orphan references', async () => {
    const started = await startResourceServer();
    try {
      // Create a preset that references a missing document and a missing chip.
      await fetch(`${started.baseUrl}/admin/resources/scope-presets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          scopePresetId: 'scope-orphan',
          label: 'Orphan scope',
          visibility: 'restricted',
          status: 'approved',
          chipIds: ['CHIP-MISSING'],
          documentIds: ['doc-missing'],
          requiredGrants: {}
        })
      });
      const validate = await fetch(`${started.baseUrl}/admin/resources/scope-presets/scope-orphan/validate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(validate.status).toBe(200);
      const body = await readJson(validate);
      expect(body.missingDocumentIds).toContain('doc-missing');
      expect(body.missingChipIds).toContain('CHIP-MISSING');
      expect(body.hasOrphans).toBe(true);
    } finally {
      await closeServer(started.server);
    }
  });

  it('persists changes to the config file when a configFile is configured', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'resource-visibility.json');
    await writeResourceVisibilityCatalogToFile(configFile, seedCatalog());
    const started = await startResourceServer({ configFile });
    try {
      const create = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token(started, started.admin)}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          documentId: 'doc-persisted',
          label: 'Persisted doc',
          visibility: 'internal',
          status: 'draft',
          chipIds: [],
          requiredGrants: {}
        })
      });
      expect(create.status).toBe(201);

      const onDisk = await loadResourceVisibilityCatalogFromFile(configFile);
      expect(onDisk.documents.map((d) => d.documentId)).toContain('doc-persisted');
    } finally {
      await closeServer(started.server);
    }
  });

  it('V4: does not mutate the in-memory catalog when the disk write fails (transactional persist)', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'resource-visibility.json');
    const seed = seedCatalog();
    await writeResourceVisibilityCatalogToFile(configFile, seed);
    const started = await startResourceServer({ configFile });
    try {
      const writeSpy = vi
        .spyOn(await import('../src/security/resource-catalog.js'), 'writeResourceVisibilityCatalogToFile')
        .mockRejectedValueOnce(new Error('simulated disk failure'));
      try {
        const create = await fetch(`${started.baseUrl}/admin/resources/documents`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token(started, started.admin)}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            documentId: 'doc-should-not-appear',
            label: 'Should not appear',
            visibility: 'internal',
            status: 'draft',
            chipIds: [],
            requiredGrants: {}
          })
        });
        expect(create.status).toBe(500);
      } finally {
        writeSpy.mockRestore();
      }

      // In-memory catalog must remain the pre-write value — no partial mutation on write failure.
      const list = await fetch(`${started.baseUrl}/admin/resources/documents`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      const body = await readJson(list);
      expect(body.documents.map((d: any) => d.documentId)).not.toContain('doc-should-not-appear');
      expect(body.documents.map((d: any) => d.documentId)).toEqual(seed.documents.map((d) => d.documentId));

      // Disk file must also remain untouched.
      const onDisk = await loadResourceVisibilityCatalogFromFile(configFile);
      expect(onDisk.documents.map((d) => d.documentId)).not.toContain('doc-should-not-appear');
    } finally {
      await closeServer(started.server);
    }
  });
});

describe('2.2.19 — CLI server command must wire the resources option', () => {
  it('reproduces the bug: omitting the resources option makes /admin/resources 500 even though the catalog file exists on disk', async () => {
    // 复现修复前的 CLI 行为：src/cli/commands/server.ts 从未向 startHttpServer 传 resources，
    // 于是 initializeResourceRuntime(undefined) 直接返回 null——即便磁盘上有真实的 catalog 文件。
    const dir = await tempDir();
    const configFile = path.join(dir, 'resource-visibility.json');
    await writeResourceVisibilityCatalogToFile(configFile, seedCatalog());

    const dataDir = await tempDir();
    const authDir = await tempDir();
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir: authDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const admin = await userStore.findByUsername('admin');
    const jwtService = new JwtService(config);
    const manager = new EventEmitter() as EventEmitter & Record<string, any>;
    manager.list = vi.fn().mockReturnValue([]);
    manager.listWithPid = vi.fn().mockReturnValue([]);

    const server = createHttpServer({
      manager: manager as any,
      auth: { enabled: true, config, userStore, jwtService },
      chips: { enabled: false },
      prompts: { enabled: false },
      // 关键点：resources 选项整个省略——正是修复前 src/cli/commands/server.ts 的行为。
      persistence: { dataDir },
      product: { config: { edition: 'public' } }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const response = await fetch(`${baseUrl}/admin/resources`, {
        headers: { authorization: `Bearer ${jwtService.sign(admin!.id, admin!.username, admin!.role)}` }
      });
      expect(response.status).toBe(500);
    } finally {
      await closeServer(server);
    }
  });

  it('fixed behavior: passing resources.configFile (as the CLI now does) makes /admin/resources return the on-disk catalog', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'resource-visibility.json');
    await writeResourceVisibilityCatalogToFile(configFile, seedCatalog());

    // resources: { enabled: true, configFile } 就是 src/cli/commands/server.ts 修复后传给
    // startHttpServer 的形状（configFile 来自 --resource-config / AGENTX_RESOURCE_CONFIG_FILE /
    // 默认 path.resolve(process.cwd(), 'config', 'resource-visibility.json')）。
    const started = await startResourceServer({ configFile });
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.counts.documents).toBe(1);
      expect(body.documents.map((d: any) => d.documentId)).toContain('doc-seed');
    } finally {
      await closeServer(started.server);
    }
  });

  it('batch C (2.2.27): enabled:true but configFile missing on disk degrades to an empty catalog (200), not 500', async () => {
    const dir = await tempDir();
    const configFile = path.join(dir, 'does-not-exist-resource-visibility.json');
    // 不写文件——模拟仓库/新环境尚未落地正式 config/resource-visibility.json 的真实状态。
    const started = await startResourceServer({ configFile });
    try {
      const response = await fetch(`${started.baseUrl}/admin/resources`, {
        headers: { authorization: `Bearer ${token(started, started.admin)}` }
      });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      expect(body.counts.documents).toBe(0);
      expect(body.counts.scopePresets).toBe(0);
    } finally {
      await closeServer(started.server);
    }
  });
});
