import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService } from '../src/auth/jwt-service.js';
import { UserStore, type AuthConfig, type User } from '../src/auth/index.js';
import { createTestManager } from './mcp-http-test-helpers.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

interface StartedServer {
  admin: User;
  adminFetch: (path: string) => Promise<Response>;
  baseUrl: string;
  configDir: string;
  customer: User;
  dataDir: string;
  emptyOverrideCustomer: User;
  kbRoot: string;
  nonAdminFetch: (path: string) => Promise<Response>;
  server: Server;
  systemAOverrideCustomer: User;
  userStore: UserStore;
}

async function startAdminAuthorizationServer(): Promise<StartedServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'admin-effective-auth-data-'));
  const configDir = await mkdtemp(join(tmpdir(), 'admin-effective-auth-config-'));
  const kbRoot = await mkdtemp(join(tmpdir(), 'admin-effective-auth-kb-'));
  for (const chipId of ['E521.39', 'DERIVED-BY-LINE', 'ROLE-ONLY', 'E522.94', 'ADMIN-ONLY']) {
    await mkdir(join(kbRoot, chipId), { recursive: true });
  }

  const rolesFile = join(configDir, 'roles.json');
  const chipConfigFile = join(configDir, 'chips.json');
  await writeFile(
    rolesFile,
    JSON.stringify(
      {
        admin: {
          description: 'Administrator',
          permissions: ['users', 'roles', 'prompts', 'chips'],
          access: {
            allowedChips: ['*'],
            injectionPolicy: 'every_turn',
            grants: {
              brands: ['*'],
              productLines: ['*'],
              chipIds: ['*'],
              documentIds: ['*'],
              scopePresetIds: ['*'],
              mcpTools: ['*']
            }
          }
        },
        customer: {
          description: 'Customer',
          permissions: [],
          access: {
            allowedChips: ['ROLE-ONLY'],
            injectionPolicy: 'first_turn',
            grants: {
              brands: ['ELMOS'],
              productLines: ['Lighting'],
              scopePresetIds: ['scope-role'],
              mcpTools: ['agentx_whoami']
            }
          }
        }
      },
      null,
      2
    ),
    'utf-8'
  );
  await writeFile(
    chipConfigFile,
    JSON.stringify(
      {
        knowledgeBaseRoot: kbRoot,
        chips: [
          { id: 'E521.39', label: 'E521.39', brand: 'ELMOS', productLines: ['Lighting'], workspaceDir: 'E521.39' },
          {
            id: 'DERIVED-BY-LINE',
            label: 'Derived by product line',
            brand: 'ELMOS',
            productLines: ['Lighting'],
            workspaceDir: 'DERIVED-BY-LINE'
          },
          { id: 'ROLE-ONLY', label: 'Role only chip', brand: 'Other', productLines: ['Other'], workspaceDir: 'ROLE-ONLY' },
          { id: 'E522.94', label: 'E522.94', brand: 'ELMOS', productLines: ['Motor'], workspaceDir: 'E522.94' },
          { id: 'ADMIN-ONLY', label: 'Admin only chip', brand: 'Admin', productLines: ['Admin'], workspaceDir: 'ADMIN-ONLY' }
        ]
      },
      null,
      2
    ),
    'utf-8'
  );

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const admin = (await userStore.findByUsername('admin'))!;
  const customer = await userStore.createUser('customer@example.com', 'customer-secret', 'customer', {
    modelGrants: ['sonnet'],
    resourceGrants: { chipIds: ['E522.94', 'E521.39'], documentIds: ['doc-customer'] }
  });
  const emptyOverrideCustomer = await userStore.createUser('empty@example.com', 'customer-secret', 'customer', {
    resourceGrants: { chipIds: [], productLines: ['Lighting'] }
  });
  const systemAOverrideCustomer = await userStore.createUser('system-a@example.com', 'customer-secret', 'customer', {
    resourceGrants: { chipIds: ['ADMIN-ONLY'] }
  });

  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: createTestManager() as any,
    auth: { enabled: true, config, userStore, jwtService, rolesFile },
    chips: { enabled: true, configFile: chipConfigFile }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const adminToken = jwtService.sign(admin.id, admin.username, admin.role);
  const customerToken = jwtService.sign(customer.id, customer.username, customer.role);

  return {
    admin,
    adminFetch: (path: string) => fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${adminToken}` } }),
    baseUrl,
    configDir,
    customer,
    dataDir,
    emptyOverrideCustomer,
    kbRoot,
    nonAdminFetch: (path: string) => fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${customerToken}` } }),
    server,
    systemAOverrideCustomer,
    userStore
  };
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function readBody(response: Response): Promise<any> {
  return response.json();
}

function expectEffectiveAuthorizationShape(body: any): void {
  expect(Object.keys(body).sort()).toEqual(['computedAt', 'dimensions', 'overrides', 'userId']);
  expect(Object.keys(body.dimensions).sort()).toEqual([
    'brands',
    'chipIds',
    'documentIds',
    'mcpTools',
    'modelIds',
    'productLines',
    'scopePresetIds'
  ]);
  for (const items of Object.values(body.dimensions)) {
    expect(Array.isArray(items)).toBe(true);
    for (const item of items as any[]) {
      expect(Object.keys(item).sort()).toEqual(['id', 'source']);
    }
  }
  expect(Object.keys(body.overrides).sort()).toEqual(['systemBChipOverride']);
}

describe('GET /admin/users/:userId/effective-authorization', () => {
  let started: StartedServer | undefined;

  afterEach(async () => {
    await closeServer(started?.server);
    if (started?.dataDir) {
      await rm(started.dataDir, { recursive: true, force: true });
    }
    if (started?.configDir) {
      await rm(started.configDir, { recursive: true, force: true });
    }
    if (started?.kbRoot) {
      await rm(started.kbRoot, { recursive: true, force: true });
    }
    started = undefined;
  });

  it('returns role defaults and derived chip sources for a customer without an explicit chip override', async () => {
    started = await startAdminAuthorizationServer();
    const roleOnlyCustomer = await started.userStore.createUser('role-only@example.com', 'customer-secret', 'customer');

    const response = await started.adminFetch(`/admin/users/${roleOnlyCustomer.id}/effective-authorization`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expectEffectiveAuthorizationShape(body);
    expect(body).toMatchObject({
      userId: roleOnlyCustomer.id,
      dimensions: {
        brands: expect.arrayContaining([{ id: 'ELMOS', source: 'role_default' }]),
        productLines: expect.arrayContaining([{ id: 'Lighting', source: 'role_default' }]),
        chipIds: expect.arrayContaining([
          { id: 'E521.39', source: 'product_line_derived' },
          { id: 'ROLE-ONLY', source: 'role_default' }
        ]),
        modelIds: expect.arrayContaining([{ id: 'haiku', source: 'role_default' }]),
        scopePresetIds: expect.arrayContaining([{ id: 'scope-role', source: 'role_default' }]),
        mcpTools: expect.arrayContaining([{ id: 'agentx_whoami', source: 'role_default' }])
      },
      overrides: { systemBChipOverride: false }
    });
    expect(new Date(body.computedAt).toISOString()).toBe(body.computedAt);
  });

  it('marks explicit user chip and model grants as overrides', async () => {
    started = await startAdminAuthorizationServer();

    const response = await started.adminFetch(`/admin/users/${started.customer.id}/effective-authorization`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expectEffectiveAuthorizationShape(body);
    expect(body).toMatchObject({
      userId: started.customer.id,
      dimensions: {
        brands: expect.arrayContaining([{ id: 'ELMOS', source: 'role_default' }]),
        productLines: expect.arrayContaining([{ id: 'Lighting', source: 'role_default' }]),
        chipIds: expect.arrayContaining([
          { id: 'E521.39', source: 'user_override' },
          { id: 'E522.94', source: 'user_override' }
        ]),
        modelIds: expect.arrayContaining([{ id: 'sonnet', source: 'user_override' }])
      },
      overrides: { systemBChipOverride: true }
    });
    expect(body.dimensions.chipIds.filter((item: any) => item.id === 'E522.94')).toHaveLength(1);
    expect(body.dimensions.chipIds.filter((item: any) => item.id === 'E521.39')).toHaveLength(1);
    expect(body.dimensions.chipIds).not.toContainEqual({ id: 'ROLE-ONLY', source: 'role_default' });
    // 批次D（2.2.27）：文档维度进入生效总览，用户显式授权的文档标记为 user_override。
    expect(body.dimensions.documentIds).toContainEqual({ id: 'doc-customer', source: 'user_override' });
  });

  it('treats explicit empty chipIds as a full deny for non-admin users', async () => {
    started = await startAdminAuthorizationServer();

    const response = await started.adminFetch(`/admin/users/${started.emptyOverrideCustomer.id}/effective-authorization`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expectEffectiveAuthorizationShape(body);
    expect(body.overrides.systemBChipOverride).toBe(true);
    expect(body.dimensions.chipIds).not.toContainEqual({ id: 'ROLE-ONLY', source: 'role_default' });
    expect(body.dimensions.chipIds).not.toContainEqual({ id: 'DERIVED-BY-LINE', source: 'product_line_derived' });
    expect(body.dimensions.chipIds).toEqual([]);
  });

  it('keeps explicit non-empty chip overrides effective', async () => {
    started = await startAdminAuthorizationServer();

    const response = await started.adminFetch(`/admin/users/${started.systemAOverrideCustomer.id}/effective-authorization`);
    const body = await readBody(response);

    expect(response.status).toBe(200);
    expectEffectiveAuthorizationShape(body);
    expect(body.overrides.systemBChipOverride).toBe(true);
    expect(body.dimensions.chipIds).toContainEqual({ id: 'ADMIN-ONLY', source: 'user_override' });
  });

  it('returns 404 for a missing user', async () => {
    started = await startAdminAuthorizationServer();

    const response = await started.adminFetch('/admin/users/missing/effective-authorization');

    expect(response.status).toBe(404);
  });

  it('returns 403 for a non-admin caller', async () => {
    started = await startAdminAuthorizationServer();

    const response = await started.nonAdminFetch(`/admin/users/${started.customer.id}/effective-authorization`);

    expect(response.status).toBe(403);
  });
});
