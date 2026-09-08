import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnouncementStore, type AnnouncementContentItem } from '../src/announcements/index.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function content(overrides: Partial<AnnouncementContentItem> = {}): AnnouncementContentItem {
  return {
    id: 'announcement-admin-1',
    type: 'announcement',
    status: 'draft',
    title: 'Admin announcement',
    summary: 'Summary',
    body: 'Body',
    visibility: 'public',
    requiresLogin: false,
    roleAllowList: [],
    requiredGrants: {},
    pinned: false,
    priority: 0,
    modalBehavior: 'none',
    revision: 1,
    createdAt: '2026-05-30T06:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    createdBy: 'admin',
    updatedBy: 'admin',
    ...overrides
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-announcements-admin-api-'));
}

async function startServer(options: Parameters<typeof createHttpServer>[0]) {
  const server = createHttpServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('announcement admin API', () => {
  let dataDir: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  async function boot() {
    dataDir = await tempDir();
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    await userStore.createUser('customer', 'customer-secret', 'customer');
    const store = new AnnouncementStore({ dataDir, now: () => new Date('2026-05-30T08:00:00.000Z') });
    const started = await startServer({
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      announcements: { store },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;
    const adminToken = (await json(await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret' })
    }))).token;
    const customerToken = (await json(await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'customer', password: 'customer-secret' })
    }))).token;
    return {
      ...started,
      store,
      adminHeaders: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      customerHeaders: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' }
    };
  }

  it('requires admin auth and keeps draft/offline items out of the public feed', async () => {
    const started = await boot();
    await started.store.replaceItems([
      content({ id: 'draft-announcement', status: 'draft' }),
      content({ id: 'offline-announcement', status: 'offline' }),
      content({ id: 'published-announcement', status: 'published', publishedAt: '2026-05-30T07:00:00.000Z' })
    ]);

    expect((await fetch(`${started.baseUrl}/admin/announcements`, { headers: started.customerHeaders })).status).toBe(403);

    const adminList = await json(await fetch(`${started.baseUrl}/admin/announcements`, { headers: started.adminHeaders }));
    expect(adminList.items.map((item: any) => item.id).sort()).toEqual([
      'draft-announcement',
      'offline-announcement',
      'published-announcement'
    ]);

    const feed = await json(await fetch(`${started.baseUrl}/api/announcements/feed`, { headers: started.customerHeaders }));
    expect(feed.items.map((item: any) => item.id)).toEqual(['published-announcement']);
  });

  it('creates, edits, publishes, offlines, archives, duplicates, and reports aggregate read state', async () => {
    const started = await boot();
    const tooLongEndsAt = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const publishableEndsAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const create = await fetch(`${started.baseUrl}/admin/announcements`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: JSON.stringify({
        id: 'admin-announcement-1',
        type: 'announcement',
        title: 'Service notice',
        summary: 'Short summary',
        body: 'Safe body',
        translations: {
          'zh-CN': {
            title: '服务通知',
            summary: '简短摘要',
            body: '安全正文'
          },
          'en-US': {
            title: 'Service notice',
            summary: 'Short summary',
            body: 'Safe body'
          }
        },
        visibility: 'public',
        requiresLogin: false,
        modalBehavior: 'force_until_expiry',
        endsAt: tooLongEndsAt,
        sourceRef: { kind: 'phase_release_note', phase: 42, note: 'internal candidate' }
      })
    });
    expect(create.status).toBe(201);
    expect((await json(create)).item).toMatchObject({ id: 'admin-announcement-1', status: 'draft', sourceRef: { phase: 42 } });

    const tooLongPublish = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1/publish`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    expect(tooLongPublish.status).toBe(400);
    expect((await json(tooLongPublish)).error).toContain('7 days');

    const patch = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1`, {
      method: 'PATCH',
      headers: started.adminHeaders,
      body: JSON.stringify({
        priority: 9,
        endsAt: publishableEndsAt,
        requiredGrants: { brands: ['ELMOS'] }
      })
    });
    expect(patch.status).toBe(200);
    expect((await json(patch)).item.revision).toBe(2);

    const publish = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1/publish`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    expect(publish.status).toBe(200);
    expect((await json(publish)).item.status).toBe('published');

    await started.store.setUserState({
      userId: 'reader-1',
      items: { 'admin-announcement-1': { lastReadRevision: 2, lastDismissedRevision: 2 } }
    });
    await started.store.setUserState({
      userId: 'reader-2',
      items: { 'admin-announcement-1': { lastReadRevision: 1, lastDismissedRevision: 2 } }
    });

    const detail = await json(await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1`, { headers: started.adminHeaders }));
    expect(detail.item.readStateSummary).toEqual({ revision: 2, readCount: 1, dismissedCount: 2 });
    expect(JSON.stringify(detail)).not.toContain('reader-1');

    expect((await json(await fetch(`${started.baseUrl}/admin/announcements?type=announcement&status=published&active=true&q=service`, {
      headers: started.adminHeaders
    }))).items).toHaveLength(1);

    const offline = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1/offline`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    expect((await json(offline)).item.status).toBe('offline');

    const duplicate = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1/duplicate`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    const duplicateBody = await json(duplicate);
    expect(duplicate.status).toBe(201);
    expect(duplicateBody.item).toMatchObject({ status: 'draft', revision: 1 });
    expect(duplicateBody.item.id).not.toBe('admin-announcement-1');

    const archive = await fetch(`${started.baseUrl}/admin/announcements/admin-announcement-1/archive`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    expect((await json(archive)).item.status).toBe('archived');
  });

  it('rejects unsafe publish text before it reaches the user feed', async () => {
    const started = await boot();
    await started.store.replaceItems([content({
      id: 'unsafe-announcement',
      title: 'Unsafe',
      body: 'token: should never be published',
      translations: {
        'zh-CN': {
          title: '不安全公告',
          summary: '摘要',
          body: 'token: should never be published'
        },
        'en-US': {
          title: 'Unsafe announcement',
          summary: 'Summary',
          body: 'token: should never be published'
        }
      },
      modalBehavior: 'none'
    })]);

    const publish = await fetch(`${started.baseUrl}/admin/announcements/unsafe-announcement/publish`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: '{}'
    });
    expect(publish.status).toBe(400);
    expect((await json(publish)).error).toContain('secret-like');
  });
});
