import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  return {
    spawn: () => undefined,
    log: () => ({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: () => ({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    send: async () => undefined,
    submit: async () => undefined,
    poll: async () => ({ hasOutput: false, exited: false }),
    kill: async () => undefined,
    listWithPid: () => [],
    on: () => undefined,
    off: () => undefined
  };
}

async function startAdminRouteHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-phase8-routes-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'root',
    adminPasswordHash: await bcrypt.hash('root-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const user = await userStore.createUser('alice', 'alice-secret', 'customer');
  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: createFakeManager() as any,
    auth: { enabled: true, config, userStore, jwtService },
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
    user
  };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('phase 8 admin static route contract', () => {
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

  it('serves admin.html for /admin and known section page routes, including downgraded deep links', async () => {
    const started = await startAdminRouteHarness();
    server = started.server;
    dataDir = started.dataDir;

    for (const path of [
      '/admin',
      '/admin/',
      '/admin/sections/users',
      '/admin/sections/roles',
      '/admin/sections/model-routing',
      '/admin/sections/prompts',
      '/admin/sections/chips',
      '/admin/sections/sessions',
      '/admin/sections/questions',
      '/admin/sections/observability',
      '/admin/sections/discovery-traces',
      '/admin/sections/announcements',
      '/admin/sections/resources',
      '/admin/sections/feedback'
    ]) {
      const response = await fetch(`${started.baseUrl}${path}`);
      const text = await response.text();

      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      expect(text, path).toContain('id="admin-operation-surface"');
      expect(text, path).toContain('id="admin-section-nav"');
    }
  });

  it('serves section routes for HEAD without expanding to unknown section paths', async () => {
    const started = await startAdminRouteHarness();
    server = started.server;
    dataDir = started.dataDir;

    const head = await fetch(`${started.baseUrl}/admin/sections/users`, { method: 'HEAD' });
    const unknown = await fetch(`${started.baseUrl}/admin/sections`);
    const unknownChild = await fetch(`${started.baseUrl}/admin/sections/settings`);

    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toContain('text/html');
    expect(await head.text()).toBe('');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'Not found' });
    expect(unknownChild.status).toBe(404);
    expect(await unknownChild.json()).toEqual({ error: 'Not found' });
  });

  it('keeps existing /admin/* API routes protected instead of serving static HTML', async () => {
    const started = await startAdminRouteHarness();
    server = started.server;
    dataDir = started.dataDir;
    const userToken = started.jwtService.sign(started.user.id, started.user.username, 'customer');

    const unauthenticatedUsers = await fetch(`${started.baseUrl}/admin/users`);
    expect(unauthenticatedUsers.status).toBe(401);
    expect(unauthenticatedUsers.headers.get('content-type')).toContain('application/json');
    expect(await unauthenticatedUsers.json()).toEqual({ error: 'Unauthorized' });

    for (const path of [
      '/admin/users',
      '/admin/roles',
      '/admin/prompts',
      '/admin/prompts/roles%2Fadmin.md/history',
      '/admin/prompts/roles%2Fadmin.md/rollback',
      '/admin/chips'
    ]) {
      const response = await fetch(`${started.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(response.status, path).toBe(403);
      expect(response.headers.get('content-type'), path).toContain('application/json');
      expect(await response.json(), path).toEqual({ error: 'Forbidden' });
    }
  });
});
