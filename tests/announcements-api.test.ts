import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnnouncementStore,
  type AnnouncementContentItem
} from '../src/announcements/index.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function content(overrides: Partial<AnnouncementContentItem> = {}): AnnouncementContentItem {
  return {
    id: 'announcement-1',
    type: 'announcement',
    status: 'published',
    title: 'Public announcement',
    summary: 'Summary',
    body: 'Body',
    visibility: 'public',
    requiresLogin: false,
    roleAllowList: [],
    requiredGrants: {},
    pinned: false,
    priority: 0,
    modalBehavior: 'once_per_version',
    revision: 1,
    publishedAt: '2026-05-30T07:00:00.000Z',
    createdAt: '2026-05-30T06:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    createdBy: 'admin',
    updatedBy: 'admin',
    ...overrides
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-announcements-api-'));
}

async function startServer(options: Parameters<typeof createHttpServer>[0]) {
  const server = createHttpServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server
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

describe('announcement user API', () => {
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

  it('serves anonymous home and feed from published public content only', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({ id: 'public-announcement', priority: 10, sourceRef: { kind: 'manual', note: 'internal note' } }),
      content({ id: 'public-news', type: 'news', title: 'Public news', modalBehavior: 'none' }),
      content({ id: 'login-required', requiresLogin: true }),
      content({ id: 'draft-announcement', status: 'draft', publishedAt: undefined })
    ]);
    const started = await startServer({
      auth: { enabled: false },
      announcements: { store },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;

    const home = await fetch(`${started.baseUrl}/api/announcements/home`);
    const feed = await fetch(`${started.baseUrl}/api/announcements/feed`);
    const homeBody = await json(home);
    const feedBody = await json(feed);
    const serialized = JSON.stringify({ homeBody, feedBody });

    expect(home.status).toBe(200);
    expect(homeBody.modalCandidate).toMatchObject({ id: 'public-announcement', status: 'published' });
    expect(feedBody.items.map((item: any) => item.id)).toEqual(['public-announcement', 'public-news']);
    expect(serialized).not.toContain('login-required');
    expect(serialized).not.toContain('draft-announcement');
    expect(serialized).not.toContain('sourceRef');
    expect(serialized).not.toContain('internal note');
  });

  it('serves visible detail only and genericizes unauthorized or unpublished detail ids', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({ id: 'public-announcement' }),
      content({ id: 'internal-announcement', visibility: 'internal', requiresLogin: true }),
      content({ id: 'admin-announcement', visibility: 'adminOnly', requiresLogin: true }),
      content({ id: 'draft-announcement', status: 'draft', publishedAt: undefined })
    ]);
    const started = await startServer({
      auth: { enabled: false },
      announcements: { store },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;

    const visible = await json(await fetch(`${started.baseUrl}/api/announcements/public-announcement`));
    expect(visible.item).toMatchObject({ id: 'public-announcement', status: 'published' });
    expect(JSON.stringify(visible)).not.toContain('createdBy');

    for (const id of ['unknown-announcement', 'internal-announcement', 'admin-announcement', 'draft-announcement']) {
      const response = await fetch(`${started.baseUrl}/api/announcements/${id}`);
      expect(response.status).toBe(404);
      expect(await json(response)).toEqual({
        error: 'Not found',
        code: 'ANNOUNCEMENT_NOT_FOUND'
      });
    }
  });

  it('uses logged-in visibility and stores read/dismiss by id plus revision', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({
        id: 'customer-announcement',
        visibility: 'customer',
        requiresLogin: true,
        requiredGrants: { brands: ['ELMOS'] },
        priority: 100
      })
    ]);
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const user = await userStore.createUser('alice', 'alice-secret', 'customer', {
      resourceGrants: { brands: ['ELMOS'] }
    });
    const started = await startServer({
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      announcements: { store },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;

    const login = await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-secret' })
    });
    const token = (await json(login)).token;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    expect((await json(await fetch(`${started.baseUrl}/api/announcements/feed`, { headers }))).items).toEqual([
      expect.objectContaining({ id: 'customer-announcement' })
    ]);

    const dismiss = await fetch(`${started.baseUrl}/api/announcements/customer-announcement/dismiss`, {
      method: 'POST',
      headers
    });
    expect(dismiss.status).toBe(200);
    expect(await json(dismiss)).toEqual({ ok: true });
    expect((await json(await fetch(`${started.baseUrl}/api/announcements/home`, { headers }))).modalCandidate).toBeNull();

    await store.upsertItem(content({
      id: 'customer-announcement',
      visibility: 'customer',
      requiresLogin: true,
      requiredGrants: { brands: ['ELMOS'] },
      priority: 100,
      revision: 2,
      updatedAt: '2026-05-30T09:00:00.000Z'
    }));

    const revisedHome = await json(await fetch(`${started.baseUrl}/api/announcements/home`, { headers }));
    expect(revisedHome.modalCandidate).toMatchObject({ id: 'customer-announcement', revision: 2 });
    expect((await store.getUserState(user.id)).items['customer-announcement']).toMatchObject({
      lastDismissedRevision: 1
    });
  });

  it('genericizes unknown, unauthorized, and unpublished read/dismiss requests', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({ id: 'public-announcement' }),
      content({ id: 'private-announcement', visibility: 'customer', requiresLogin: true, requiredGrants: { brands: ['ELMOS'] } }),
      content({ id: 'draft-announcement', status: 'draft', publishedAt: undefined })
    ]);
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const user = await userStore.createUser('bob', 'bob-secret', 'customer');
    const started = await startServer({
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      announcements: { store },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;

    const token = (await json(await fetch(`${started.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'bob-secret' })
    }))).token;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    for (const id of ['unknown-announcement', 'private-announcement', 'draft-announcement']) {
      const response = await fetch(`${started.baseUrl}/api/announcements/${id}/read`, { method: 'POST', headers });
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ ok: true });
    }

    expect((await store.getUserState(user.id)).items).toEqual({});
  });

  it('keeps public, customer, internal, and admin feeds within each role visibility ceiling', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({ id: 'public-announcement' }),
      content({ id: 'customer-announcement', visibility: 'customer', requiresLogin: true }),
      content({ id: 'internal-announcement', visibility: 'internal', requiresLogin: true }),
      content({ id: 'admin-announcement', visibility: 'adminOnly', requiresLogin: true })
    ]);
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
    await userStore.createUser('internal', 'internal-secret', 'internal');
    const started = await startServer({
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      announcements: { store },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    server = started.server;

    async function login(username: string, password: string) {
      const response = await fetch(`${started.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      return (await json(response)).token;
    }
    async function feedIds(token?: string) {
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
      const body = await json(await fetch(`${started.baseUrl}/api/announcements/feed`, { headers }));
      return body.items.map((item: any) => item.id);
    }

    expect(await feedIds()).toEqual(['public-announcement']);
    expect(await feedIds(await login('customer', 'customer-secret'))).toEqual([
      'public-announcement',
      'customer-announcement'
    ]);
    expect(await feedIds(await login('internal', 'internal-secret'))).toEqual([
      'public-announcement',
      'customer-announcement',
      'internal-announcement'
    ]);
    expect(await feedIds(await login('admin', 'admin-secret'))).toEqual([
      'public-announcement',
      'customer-announcement',
      'internal-announcement',
      'admin-announcement'
    ]);
  });
});
