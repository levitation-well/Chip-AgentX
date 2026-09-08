import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnouncementStore } from '../src/announcements/index.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('announcement bilingual contracts', () => {
  let dataDir: string | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
    dataDir = undefined;
  });

  it('reads legacy flat content as zh-CN without rewriting the source file', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-announcement-i18n-'));
    const announcementsDir = path.join(dataDir, 'announcements');
    const contentFile = path.join(announcementsDir, 'content.json');
    await mkdir(announcementsDir, { recursive: true });
    const legacy = JSON.stringify({
      items: [{
        id: 'legacy-news',
        type: 'news',
        status: 'published',
        title: '旧版新闻',
        summary: '旧版摘要',
        body: '旧版正文',
        visibility: 'public',
        requiresLogin: false,
        roleAllowList: [],
        requiredGrants: {},
        pinned: false,
        priority: 0,
        modalBehavior: 'none',
        revision: 1,
        publishedAt: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        createdBy: 'admin',
        updatedBy: 'admin'
      }]
    }, null, 2);
    await writeFile(contentFile, legacy, 'utf8');

    const store = new AnnouncementStore({ dataDir });
    const [item] = await store.listItems();
    const englishFeed = await store.getFeed({}, undefined, 'en-US');

    expect(item?.translations?.['zh-CN']).toEqual({
      title: '旧版新闻',
      summary: '旧版摘要',
      body: '旧版正文'
    });
    expect(englishFeed.items[0]).toMatchObject({
      title: '旧版新闻',
      summary: '旧版摘要',
      body: '旧版正文'
    });
    expect(await readFile(contentFile, 'utf8')).toBe(legacy);
  });

  it('allows incomplete bilingual drafts but requires both locales to publish and flattens public locale output', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-announcement-i18n-api-'));
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const store = new AnnouncementStore({ dataDir });
    server = createHttpServer({
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      announcements: { store },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const token = (await json(await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin-secret' })
    }))).token;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const create = await fetch(`${baseUrl}/admin/announcements`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'bilingual-news',
        type: 'news',
        translations: {
          'zh-CN': { title: '产品更新', summary: '中文摘要', body: '中文正文' }
        },
        visibility: 'public',
        requiresLogin: false
      })
    });
    expect(create.status).toBe(201);

    const incompletePublish = await fetch(`${baseUrl}/admin/announcements/bilingual-news/publish`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    expect(incompletePublish.status).toBe(400);
    await expect(json(incompletePublish)).resolves.toMatchObject({
      code: 'ANNOUNCEMENT_TRANSLATIONS_REQUIRED'
    });

    const patch = await fetch(`${baseUrl}/admin/announcements/bilingual-news`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        translations: {
          'en-US': { title: 'Product update', summary: 'English summary', body: 'English body' }
        }
      })
    });
    expect(patch.status).toBe(200);
    const patched = await json(patch);
    expect(patched.item.translations).toMatchObject({
      'zh-CN': { title: '产品更新' },
      'en-US': { title: 'Product update' }
    });

    const publish = await fetch(`${baseUrl}/admin/announcements/bilingual-news/publish`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    expect(publish.status).toBe(200);

    const english = await json(await fetch(`${baseUrl}/api/announcements/bilingual-news?locale=en-US`));
    const chinese = await json(await fetch(`${baseUrl}/api/announcements/bilingual-news?locale=zh-CN`));
    expect(english.item).toMatchObject({
      title: 'Product update',
      summary: 'English summary',
      body: 'English body'
    });
    expect(chinese.item).toMatchObject({
      title: '产品更新',
      summary: '中文摘要',
      body: '中文正文'
    });
    expect(english.item).not.toHaveProperty('translations');

    const offline = await fetch(`${baseUrl}/admin/announcements/bilingual-news/offline`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    expect(offline.status).toBe(200);
    const removeEnglish = await fetch(`${baseUrl}/admin/announcements/bilingual-news`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        translations: {
          'en-US': { title: '', summary: '', body: '' }
        }
      })
    });
    expect(removeEnglish.status).toBe(200);
    const republish = await fetch(`${baseUrl}/admin/announcements/bilingual-news/publish`, {
      method: 'POST',
      headers,
      body: '{}'
    });
    expect(republish.status).toBe(400);
    await expect(json(republish)).resolves.toMatchObject({
      code: 'ANNOUNCEMENT_TRANSLATIONS_REQUIRED'
    });

    const notFound = await fetch(`${baseUrl}/api/announcements/not-found?locale=en-US`);
    expect(notFound.status).toBe(404);
    await expect(json(notFound)).resolves.toMatchObject({
      error: 'Not found',
      code: 'ANNOUNCEMENT_NOT_FOUND'
    });
  });
});
