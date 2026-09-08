import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-admin-credits-api-'));
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

describe('admin credits API', () => {
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
    const customer = await userStore.createUser('credit-user', 'credit-secret', 'customer');
    await userStore.setCreditBalanceUnits(customer.id, 300);

    const started = await startServer({
      auth: {
        enabled: true,
        config,
        userStore,
        jwtService: new JwtService(config)
      },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { dataDir }
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
      body: JSON.stringify({ username: 'credit-user', password: 'credit-secret' })
    }))).token;

    return {
      ...started,
      userStore,
      customer,
      adminHeaders: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'X-Request-Id': 'req-credit-1' },
      customerHeaders: { Authorization: `Bearer ${customerToken}`, 'Content-Type': 'application/json' }
    };
  }

  it('supports admin credit lookup and adjustment with actor/reason/note audit metadata', async () => {
    const started = await boot();

    const before = await fetch(`${started.baseUrl}/admin/credits?userId=${encodeURIComponent(started.customer.id)}&limit=5`, {
      headers: started.adminHeaders
    });
    expect(before.status).toBe(200);
    expect(await json(before)).toMatchObject({
      userId: started.customer.id,
      username: 'credit-user',
      balanceUnits: 300,
      ledger: { total: 0, limit: 5 }
    });

    const adjust = await fetch(`${started.baseUrl}/admin/credits/adjust`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: JSON.stringify({
        userId: started.customer.id,
        deltaUnits: -40,
        reason: 'manual_reconcile',
        note: 'phase43-wave3'
      })
    });
    expect(adjust.status).toBe(200);
    const adjustedBody = await json(adjust);
    expect(adjustedBody).toMatchObject({
      userId: started.customer.id,
      username: 'credit-user',
      balanceBeforeUnits: 300,
      balanceAfterUnits: 260,
      deltaUnits: -40,
      reason: 'manual_reconcile',
      note: 'phase43-wave3',
      ledgerRecord: {
        entry: 'admin',
        status: 'free',
        units: 40,
        balanceBeforeUnits: 300,
        balanceAfterUnits: 260,
        requestId: 'req-credit-1',
        metadata: {
          adjustmentDeltaUnits: -40,
          actorUsername: 'admin',
          actorRole: 'admin',
          note: 'phase43-wave3'
        }
      }
    });

    const storedBalance = await started.userStore.getCreditBalanceUnits(started.customer.id);
    expect(storedBalance).toBe(260);

    const after = await fetch(`${started.baseUrl}/admin/credits?userId=${encodeURIComponent(started.customer.id)}&limit=5`, {
      headers: started.adminHeaders
    });
    expect(after.status).toBe(200);
    expect(await json(after)).toMatchObject({
      balanceUnits: 260,
      ledger: {
        total: 1,
        items: [expect.objectContaining({
          entry: 'admin',
          reason: 'manual_reconcile',
          metadata: expect.objectContaining({
            actorUsername: 'admin',
            note: 'phase43-wave3'
          })
        })]
      }
    });
  });

  it('rejects non-admin callers and invalid negative resulting balances', async () => {
    const started = await boot();

    expect((await fetch(`${started.baseUrl}/admin/credits?userId=${encodeURIComponent(started.customer.id)}`, {
      headers: started.customerHeaders
    })).status).toBe(403);

    expect((await fetch(`${started.baseUrl}/admin/credits/adjust`, {
      method: 'POST',
      headers: started.customerHeaders,
      body: JSON.stringify({
        userId: started.customer.id,
        deltaUnits: 10,
        reason: 'blocked'
      })
    })).status).toBe(403);

    const invalid = await fetch(`${started.baseUrl}/admin/credits/adjust`, {
      method: 'POST',
      headers: started.adminHeaders,
      body: JSON.stringify({
        userId: started.customer.id,
        deltaUnits: -999,
        reason: 'too_low'
      })
    });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).error).toContain('non-negative integer');
  });
});
