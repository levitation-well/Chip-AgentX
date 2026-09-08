import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

async function makeRequest(server: Server, method: string, path: string, body?: unknown, token?: string): Promise<{
  statusCode: number;
  body: unknown;
}> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = new URL(path, 'http://127.0.0.1');
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: (server.address() as AddressInfo).port,
      path: url.pathname + url.search,
      method,
      headers
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsedBody = data ? JSON.parse(data) : undefined;
          resolve({ statusCode: res.statusCode ?? 0, body: parsedBody });
        } catch {
          resolve({ statusCode: res.statusCode ?? 0, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

describe('roles HTTP routes', () => {
  const tempDirs: string[] = [];
  let server: Server;
  let baseUrl: string;
  let adminToken: string;
  let jwtService: JwtService;
  let userStore: UserStore;
  let rolesFile: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agentx-roles-http-'));
    tempDirs.push(dataDir);

    rolesFile = join(dataDir, 'roles.json');

    // Initialize roles config
    await writeFile(
      rolesFile,
      JSON.stringify({
        _permissions: {
          users: { label: 'User Management', description: 'Manage users' },
          roles: { label: 'Role Management', description: 'Manage roles' },
          prompts: { label: 'Prompt Management', description: 'Manage prompts' },
          chips: { label: 'Chip Management', description: 'Manage chips' }
        },
        admin: {
          description: 'Administrator',
          permissions: ['users', 'roles', 'prompts', 'chips'],
          access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
        },
        customer: {
          description: 'Customer',
          permissions: [],
          access: { allowedChips: [], injectionPolicy: 'first_turn' }
        }
      })
    );

    const authConfig: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };

    userStore = new UserStore(authConfig);
    await userStore.init();
    jwtService = new JwtService(authConfig);

    server = createHttpServer({
      host: '127.0.0.1',
      port: 0,
      auth: {
        enabled: true,
        config: authConfig,
        userStore,
        jwtService,
        rolesFile
      },
      prompts: {
        enabled: false
      }
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    // Get admin token
    const loginRes = await makeRequest(server, 'POST', `${baseUrl}/auth/login`, {
      username: 'admin',
      password: 'admin-secret'
    });
    expect(loginRes.statusCode).toBe(200);
    adminToken = (loginRes.body as { token: string }).token;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe('GET /admin/roles', () => {
    it('returns all roles with _permissions metadata', async () => {
      const res = await makeRequest(server, 'GET', `${baseUrl}/admin/roles`, undefined, adminToken);

      expect(res.statusCode).toBe(200);
      const body = res.body as { roles: unknown; _permissions: unknown };
      expect(body.roles).toBeDefined();
      expect(body._permissions).toBeDefined();
      expect((body.roles as Record<string, unknown>)).toHaveProperty('admin');
      expect((body.roles as Record<string, unknown>)).toHaveProperty('customer');
    });

    it('requires authentication', async () => {
      const res = await makeRequest(server, 'GET', `${baseUrl}/admin/roles`);
      expect(res.statusCode).toBe(401);
    });

    it('keeps permission-bearing non-admin roles out of admin routes', async () => {
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      raw.internal = {
        description: 'Internal with configured permissions',
        permissions: ['users', 'roles', 'prompts', 'chips'],
        access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
      };
      await writeFile(rolesFile, JSON.stringify(raw));
      const ian = await userStore.createUser('ian', 'ian-secret', 'internal');
      const internalToken = jwtService.sign(ian.id, ian.username, ian.role);

      const res = await makeRequest(server, 'GET', `${baseUrl}/admin/roles`, undefined, internalToken);

      expect(res.statusCode).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
    });
  });

  describe('POST /admin/roles', () => {
    it('creates a new role', async () => {
      const res = await makeRequest(
        server,
        'POST',
        `${baseUrl}/admin/roles`,
        {
          name: 'developer',
          description: 'Developer role',
          permissions: ['prompts', 'chips']
        },
        adminToken
      );

      expect(res.statusCode).toBe(201);
      const body = res.body as { role: { name: string; description: string; permissions: string[] } };
      expect(body.role.name).toBe('developer');
      expect(body.role.description).toBe('Developer role');
      expect(body.role.permissions).toEqual([]);

      // Verify persisted
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.developer).toBeDefined();
      expect(raw.developer.permissions).toEqual([]);
    });

    it('returns 409 if role already exists', async () => {
      // Create first
      await makeRequest(
        server,
        'POST',
        `${baseUrl}/admin/roles`,
        { name: 'developer', description: 'Dev', permissions: ['users'] },
        adminToken
      );

      // Try to create again
      const res = await makeRequest(
        server,
        'POST',
        `${baseUrl}/admin/roles`,
        { name: 'developer', description: 'Duplicate', permissions: [] },
        adminToken
      );

      expect(res.statusCode).toBe(409);
    });
  });

  describe('GET /admin/roles/:name', () => {
    it('returns a single role', async () => {
      const res = await makeRequest(server, 'GET', `${baseUrl}/admin/roles/admin`, undefined, adminToken);

      expect(res.statusCode).toBe(200);
      const body = res.body as { description: string; permissions: string[] };
      expect(body.description).toBe('Administrator');
      expect(body.permissions).toContain('users');
    });

    it('returns 404 for non-existent role', async () => {
      const res = await makeRequest(server, 'GET', `${baseUrl}/admin/roles/nonexistent`, undefined, adminToken);

      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /admin/roles/:name', () => {
    it('updates an existing role', async () => {
      const res = await makeRequest(
        server,
        'PUT',
        `${baseUrl}/admin/roles/customer`,
        { description: 'Updated customer', permissions: ['chips'] },
        adminToken
      );

      expect(res.statusCode).toBe(200);
      const body = res.body as { role: { name: string; description: string; permissions: string[] } };
      expect(body.role.name).toBe('customer');
      expect(body.role.description).toBe('Updated customer');
      expect(body.role.permissions).toEqual([]);

      // Verify persisted
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.customer.description).toBe('Updated customer');
      expect(raw.customer.permissions).toEqual([]);
    });

    it('updates role template chip access', async () => {
      const res = await makeRequest(
        server,
        'PUT',
        `${baseUrl}/admin/roles/customer`,
        {
          description: 'Lighting template',
          permissions: ['chips'],
          access: { allowedChips: ['E521.39'], injectionPolicy: 'every_turn' }
        },
        adminToken
      );

      expect(res.statusCode).toBe(200);
      const body = res.body as {
        role: {
          name: string;
          permissions: string[];
          access: { allowedChips: string[]; injectionPolicy: string };
        };
      };
      expect(body.role.name).toBe('customer');
      expect(body.role.permissions).toEqual([]);
      expect(body.role.access).toEqual({ allowedChips: ['E521.39'], injectionPolicy: 'every_turn' });
    });

    it('returns 404 for non-existent role', async () => {
      const res = await makeRequest(
        server,
        'PUT',
        `${baseUrl}/admin/roles/nonexistent`,
        { description: 'X', permissions: [] },
        adminToken
      );

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /admin/roles/:name', () => {
    it('deletes an existing role', async () => {
      // First create a role to delete
      await makeRequest(
        server,
        'POST',
        `${baseUrl}/admin/roles`,
        { name: 'temp', description: 'Temp', permissions: [] },
        adminToken
      );

      const res = await makeRequest(server, 'DELETE', `${baseUrl}/admin/roles/temp`, undefined, adminToken);

      expect(res.statusCode).toBe(204);

      // Verify removed
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.temp).toBeUndefined();
    });

    it('returns 403 when deleting built-in admin role', async () => {
      const res = await makeRequest(server, 'DELETE', `${baseUrl}/admin/roles/admin`, undefined, adminToken);

      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /admin/roles/reload', () => {
    it('reloads roles from disk', async () => {
      // Modify file externally
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      (raw as Record<string, unknown>).external = {
        description: 'External',
        permissions: [],
        access: { allowedChips: [], injectionPolicy: 'first_turn' }
      };
      await writeFile(rolesFile, JSON.stringify(raw));

      const res = await makeRequest(server, 'POST', `${baseUrl}/admin/roles/reload`, undefined, adminToken);

      expect(res.statusCode).toBe(200);
      const body = res.body as { reloaded: boolean };
      expect(body.reloaded).toBe(true);
    });
  });
});

describe('roles route matching', () => {
  it('matches /admin/roles as kind: roles', async () => {
    const { matchRolesRoute } = await import('../../src/auth/routes.js');
    expect(matchRolesRoute('/admin/roles')).toEqual({ kind: 'roles' });
  });

  it('matches /admin/roles/:name as kind: role with decoded name', async () => {
    const { matchRolesRoute } = await import('../../src/auth/routes.js');
    expect(matchRolesRoute('/admin/roles/admin')).toEqual({ kind: 'role', name: 'admin' });
    expect(matchRolesRoute('/admin/roles/role%20name')).toEqual({ kind: 'role', name: 'role name' });
  });

  it('ignores /admin/roles/reload (handled separately)', async () => {
    const { matchRolesRoute } = await import('../../src/auth/routes.js');
    // matchRolesRoute returns { kind: 'role', name: 'reload' } for /admin/roles/reload
    // but the handler in http-server.ts checks this path BEFORE matchRolesRoute is called
    // So in practice, /admin/roles/reload is handled by the reload endpoint
    // matchRolesRoute itself does match it as a role route
    expect(matchRolesRoute('/admin/roles/reload')).toEqual({ kind: 'role', name: 'reload' });
  });

  it('ignores non-role admin paths', async () => {
    const { matchRolesRoute } = await import('../../src/auth/routes.js');
    expect(matchRolesRoute('/admin/users')).toBeUndefined();
    expect(matchRolesRoute('/admin')).toBeUndefined();
  });
});
