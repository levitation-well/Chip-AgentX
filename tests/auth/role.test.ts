import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { RolesService, RolesServiceError, type Permission } from '../../src/auth/roles.js';

describe('RolesService', () => {
  const tempDirs: string[] = [];

  async function createHarness() {
    const configDir = await mkdtemp(join(tmpdir(), 'agentx-roles-'));
    const rolesFile = join(configDir, 'roles.json');
    const usersFile = join(configDir, 'users.json');

    // Initialize with default roles
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

    // Initialize empty users
    await writeFile(usersFile, '[]');

    const service = new RolesService({ rolesFile, usersFile });

    return { configDir, rolesFile, usersFile, service };
  }

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe('getAllRoles()', () => {
    it('returns the full config including _permissions', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      const catalog = await service.getAllRoles();

      expect(catalog).toHaveProperty('_permissions');
      expect(catalog).toHaveProperty('admin');
      expect(catalog).toHaveProperty('customer');
      expect((catalog as any)._permissions).toHaveProperty('users');
    });

    it('reads fresh from disk on each call', async () => {
      const { configDir, rolesFile, service } = await createHarness();
      tempDirs.push(configDir);

      const first = await service.getAllRoles();
      expect((first as any).admin).toBeDefined();

      // Modify file externally
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      (raw as any).newRole = { description: 'New role', permissions: [], access: { allowedChips: [], injectionPolicy: 'first_turn' } };
      await writeFile(rolesFile, JSON.stringify(raw));

      const second = await service.getAllRoles();
      expect((second as any).newRole).toBeDefined();
    });
  });

  describe('getPermissionMetadata()', () => {
    it('returns only the _permissions object', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      const meta = await service.getPermissionMetadata();

      expect(meta).toHaveProperty('users');
      expect(meta).toHaveProperty('roles');
      expect(meta).toHaveProperty('prompts');
      expect(meta).toHaveProperty('chips');
      expect(meta).not.toHaveProperty('admin');
    });

    it('includes label and description for each permission', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      const meta = await service.getPermissionMetadata();

      expect(meta.users).toHaveProperty('label');
      expect(meta.users).toHaveProperty('description');
      expect(typeof meta.users.label).toBe('string');
    });
  });

  describe('getRole(name)', () => {
    it('returns a single role definition', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      const role = await service.getRole('admin');

      expect(role).toHaveProperty('description');
      expect(role).toHaveProperty('permissions');
      expect(role).toHaveProperty('access');
      expect(Array.isArray(role.permissions)).toBe(true);
    });

    it('returns role with correct permissions', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      const adminRole = await service.getRole('admin');
      expect(adminRole.permissions).toContain('users');
      expect(adminRole.permissions).toContain('roles');

      const customerRole = await service.getRole('customer');
      expect(customerRole.permissions).toEqual([]);
    });

    it('throws RolesServiceError(404) for non-existent role', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(service.getRole('nonexistent')).rejects.toMatchObject({
        statusCode: 404,
        message: expect.stringContaining('nonexistent')
      });
    });
  });

  describe('createRole(input)', () => {
    it('creates a new role with default access', async () => {
      const { configDir, service, rolesFile } = await createHarness();
      tempDirs.push(configDir);

      const created = await service.createRole({
        name: 'developer',
        description: 'Developer role',
        permissions: ['prompts', 'chips']
      });

      expect(created.name).toBe('developer');
      expect(created.description).toBe('Developer role');
      expect(created.permissions).toEqual([]);

      // Verify persisted
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.developer).toBeDefined();
      expect(raw.developer.permissions).toEqual([]);
      expect(raw.developer.access.allowedChips).toEqual([]);
      expect(raw.developer.access.injectionPolicy).toBe('first_turn');
    });

    it('throws RolesServiceError(409) if role already exists', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(
        service.createRole({ name: 'admin', description: 'Duplicate', permissions: [] })
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('admin')
      });
    });

    it('validates permission values', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(
        service.createRole({ name: 'bad', description: 'Bad', permissions: ['invalid' as Permission] })
      ).rejects.toThrow('Invalid permission');
    });

    it('saves atomically (write to tmp then rename)', async () => {
      const { configDir, service, rolesFile } = await createHarness();
      tempDirs.push(configDir);

      await service.createRole({
        name: 'testrole',
        description: 'Test',
        permissions: ['users']
      });

      // Check no .tmp file remains
      const fs = await import('node:fs/promises');
      const files = await fs.readdir(configDir);
      expect(files).not.toContain('roles.json.tmp');
    });
  });

  describe('updateRole(name, input)', () => {
    it('updates an existing role', async () => {
      const { configDir, service, rolesFile } = await createHarness();
      tempDirs.push(configDir);

      const updated = await service.updateRole('customer', {
        description: 'Updated customer',
        permissions: ['chips']
      });

      expect(updated.name).toBe('customer');
      expect(updated.description).toBe('Updated customer');
      expect(updated.permissions).toEqual([]);

      // Verify persisted
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.customer.description).toBe('Updated customer');
      expect(raw.customer.permissions).toEqual([]);
    });

    it('updates role template chip access', async () => {
      const { configDir, service, rolesFile } = await createHarness();
      tempDirs.push(configDir);

      const updated = await service.updateRole('customer', {
        description: 'Lighting FAE',
        permissions: ['chips'],
        access: { allowedChips: ['E521.39'], injectionPolicy: 'every_turn' }
      });

      expect(updated.permissions).toEqual([]);
      expect(updated.access).toEqual({ allowedChips: ['E521.39'], injectionPolicy: 'every_turn' });
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.customer.access).toEqual({ allowedChips: ['E521.39'], injectionPolicy: 'every_turn' });
    });

    it('throws RolesServiceError(404) for non-existent role', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(
        service.updateRole('nonexistent', { description: 'X', permissions: [] })
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it('validates permission values', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(
        service.updateRole('admin', { description: 'X', permissions: ['bad' as Permission] })
      ).rejects.toThrow('Invalid permission');
    });

    it('saves atomically', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await service.updateRole('customer', { description: 'Updated', permissions: [] });

      const fs = await import('node:fs/promises');
      const files = await fs.readdir(configDir);
      expect(files).not.toContain('roles.json.tmp');
    });
  });

  describe('deleteRole(name)', () => {
    it('deletes an existing role', async () => {
      const { configDir, service, rolesFile } = await createHarness();
      tempDirs.push(configDir);

      // First create a role to delete
      await service.createRole({ name: 'temp', description: 'Temp', permissions: [] });

      const result = await service.deleteRole('temp');
      expect(result).toBe(true);

      // Verify removed from disk
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      expect(raw.temp).toBeUndefined();
    });

    it('throws RolesServiceError(403) when deleting admin', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await expect(service.deleteRole('admin')).rejects.toMatchObject({
        statusCode: 403,
        message: expect.stringContaining('admin')
      });
    });

    it('throws RolesServiceError(409) when role is referenced by users', async () => {
      const { configDir, service, usersFile } = await createHarness();
      tempDirs.push(configDir);

      // Create a role
      await service.createRole({ name: 'developer', description: 'Dev', permissions: [] });

      // Add a user with that role
      const users = [{ id: 'u1', username: 'dev1', passwordHash: 'x', mcpKeys: [], createdAt: '2024', role: 'developer' }];
      await writeFile(usersFile, JSON.stringify(users));

      await expect(service.deleteRole('developer')).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('developer')
      });
    });

    it('allows deleting role when no users reference it', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await service.createRole({ name: 'orphan', description: 'Orphan', permissions: [] });

      // No users reference it, so deletion should succeed
      await expect(service.deleteRole('orphan')).resolves.toBe(true);
    });

    it('saves atomically', async () => {
      const { configDir, service } = await createHarness();
      tempDirs.push(configDir);

      await service.createRole({ name: 'to-delete', description: 'X', permissions: [] });
      await service.deleteRole('to-delete');

      const fs = await import('node:fs/promises');
      const files = await fs.readdir(configDir);
      expect(files).not.toContain('roles.json.tmp');
    });
  });

  describe('reload()', () => {
    it('re-reads config from disk', async () => {
      const { configDir, rolesFile, service } = await createHarness();
      tempDirs.push(configDir);

      // Modify file externally
      const raw = JSON.parse(await readFile(rolesFile, 'utf8'));
      (raw as any).external = { description: 'External', permissions: [], access: { allowedChips: [], injectionPolicy: 'first_turn' } };
      await writeFile(rolesFile, JSON.stringify(raw));

      await service.reload();

      const roles = await service.getAllRoles();
      expect((roles as any).external).toBeDefined();
    });
  });

  describe('RolesServiceError', () => {
    it('is a subclass of Error with statusCode', () => {
      const error = new RolesServiceError(404, 'Not found');

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(RolesServiceError);
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Not found');
    });
  });
});
