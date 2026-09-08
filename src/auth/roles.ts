import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeResourceGrantSet, type ResourceGrantInput } from '../security/index.js';

// Types
export type Permission = 'users' | 'roles' | 'prompts' | 'chips';

export interface PermissionMeta {
  label: string;
  description: string;
}

export interface RoleDefinition {
  description: string;
  permissions: Permission[];
  access: {
    allowedChips: string[];
    injectionPolicy: 'first_turn' | 'every_turn';
    grants?: ResourceGrantInput;
  };
}

export interface RoleCatalog {
  _permissions?: Record<string, PermissionMeta>;
  [roleName: string]: unknown;
}

export class RolesServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

// Valid permissions
const VALID_PERMISSIONS: readonly Permission[] = ['users', 'roles', 'prompts', 'chips'];
const INJECTION_POLICIES = ['first_turn', 'every_turn'] as const;
type InjectionPolicy = (typeof INJECTION_POLICIES)[number];

interface RoleMutationInput {
  name?: string;
  description: string;
  permissions?: Permission[];
  access?: {
    allowedChips?: string[];
    injectionPolicy?: InjectionPolicy;
    grants?: ResourceGrantInput;
  };
}

export interface RolesServiceConfig {
  rolesFile: string;
  usersFile?: string;
}

export class RolesService {
  private readonly resolvedRolesFile: string;
  private readonly resolvedUsersFile: string | undefined;

  constructor(config: RolesServiceConfig) {
    // Resolve relative paths against cwd
    this.resolvedRolesFile = path.isAbsolute(config.rolesFile)
      ? config.rolesFile
      : path.resolve(process.cwd(), config.rolesFile);

    this.resolvedUsersFile = config.usersFile
      ? path.isAbsolute(config.usersFile)
        ? config.usersFile
        : path.resolve(process.cwd(), config.usersFile)
      : undefined;
  }

  private async readRolesConfig(): Promise<RoleCatalog> {
    const raw = await readFile(this.resolvedRolesFile, 'utf8');
    return JSON.parse(raw) as RoleCatalog;
  }

  private async saveRolesConfig(config: RoleCatalog): Promise<void> {
    // B5 fix: use unique temp file per request to avoid temp file collision
    // when two concurrent writers race the same fixed .tmp path.
    const tmpPath = `${this.resolvedRolesFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    await rename(tmpPath, this.resolvedRolesFile);
  }

  /**
   * B5 fix: serialize role mutations within the process via a chained mutex.
   * Each caller awaits the previous tail, then runs fn(), then advances the
   * tail. This prevents read-modify-write races and temp-file collisions.
   */
  private mutationTail: Promise<unknown> = Promise.resolve();

  private async withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      release();
    }
  }

  private validatePermissions(permissions: Permission[]): void {
    for (const p of permissions) {
      if (!VALID_PERMISSIONS.includes(p)) {
        throw new RolesServiceError(400, `Invalid permission '${p}'. Valid values: ${VALID_PERMISSIONS.join(', ')}`);
      }
    }
  }

  private normalizePermissions(roleName: string, permissions: Permission[] = []): Permission[] {
    this.validatePermissions(permissions);
    if (roleName === 'admin') {
      return [...VALID_PERMISSIONS];
    }
    return [];
  }

  private normalizeAccess(roleName: string, inputAccess?: RoleMutationInput['access'], existing?: RoleDefinition): RoleDefinition['access'] {
    if (roleName === 'admin') {
      return {
        allowedChips: ['*'],
        injectionPolicy: 'every_turn',
        grants: normalizeResourceGrantSet({
          brands: ['*'],
          productLines: ['*'],
          chipIds: ['*'],
          documentIds: ['*'],
          scopePresetIds: ['*'],
          modelIds: ['*'],
          mcpTools: ['*']
        })
      };
    }

    const allowedChips = inputAccess?.allowedChips ?? existing?.access.allowedChips ?? [];
    const injectionPolicy = inputAccess?.injectionPolicy ?? existing?.access.injectionPolicy ?? 'first_turn';
    const grants =
      inputAccess?.grants !== undefined
        ? normalizeResourceGrantSet(inputAccess.grants)
        : existing?.access.grants !== undefined
          ? normalizeResourceGrantSet(existing.access.grants)
          : undefined;

    if (!Array.isArray(allowedChips)) {
      throw new RolesServiceError(400, 'access.allowedChips must be an array');
    }
    if (!INJECTION_POLICIES.includes(injectionPolicy)) {
      throw new RolesServiceError(400, `Invalid injectionPolicy '${String(injectionPolicy)}'`);
    }
    if (!allowedChips.every((chipId) => typeof chipId === 'string' && chipId.trim() !== '')) {
      throw new RolesServiceError(400, 'access.allowedChips must contain non-empty strings');
    }

    const uniqueChipIds = [...new Set(allowedChips.map((chipId) => chipId.trim()))];
    if (uniqueChipIds.includes('*') && uniqueChipIds.length > 1) {
      throw new RolesServiceError(400, "access.allowedChips cannot combine '*' with explicit chip IDs");
    }

    return {
      allowedChips: uniqueChipIds,
      injectionPolicy,
      ...(grants !== undefined ? { grants } : {})
    };
  }

  private async getUsers(): Promise<{ role?: string }[]> {
    if (!this.resolvedUsersFile) {
      return [];
    }
    try {
      const raw = await readFile(this.resolvedUsersFile, 'utf8');
      return JSON.parse(raw) as { role?: string }[];
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async getAllRoles(): Promise<RoleCatalog> {
    return this.readRolesConfig();
  }

  async getPermissionMetadata(): Promise<Record<string, PermissionMeta>> {
    const config = await this.readRolesConfig();
    return config._permissions ?? {};
  }

  async getRole(name: string): Promise<RoleDefinition> {
    const config = await this.readRolesConfig();
    const role = config[name] as RoleDefinition | undefined;
    if (!role) {
      throw new RolesServiceError(404, `Role '${name}' not found`);
    }
    return role;
  }

  async createRole(input: RoleMutationInput & { name: string }): Promise<{ name: string } & RoleDefinition> {
    return this.withMutationLock(async () => {
      const config = await this.readRolesConfig();
      if (input.name in config) {
        throw new RolesServiceError(409, `Role '${input.name}' already exists`);
      }

      const newRole: RoleDefinition = {
        description: input.description,
        permissions: this.normalizePermissions(input.name, input.permissions),
        access: this.normalizeAccess(input.name, input.access)
      };

      (config as Record<string, unknown>)[input.name] = newRole;
      await this.saveRolesConfig(config);

      return {
        name: input.name,
        ...newRole
      };
    });
  }

  async updateRole(
    name: string,
    input: RoleMutationInput
  ): Promise<{ name: string } & RoleDefinition> {
    return this.withMutationLock(async () => {
      const config = await this.readRolesConfig();
      const existing = config[name] as RoleDefinition | undefined;
      if (!existing) {
        throw new RolesServiceError(404, `Role '${name}' not found`);
      }

      const updated: RoleDefinition = {
        ...existing,
        description: input.description,
        permissions: this.normalizePermissions(name, input.permissions ?? existing.permissions),
        access: this.normalizeAccess(name, input.access, existing)
      };

      (config as Record<string, unknown>)[name] = updated;
      await this.saveRolesConfig(config);

      return {
        name,
        ...updated
      };
    });
  }

  async deleteRole(name: string): Promise<boolean> {
    return this.withMutationLock(async () => {
      if (name === 'admin') {
        throw new RolesServiceError(403, `Cannot delete built-in role 'admin'`);
      }

      const config = await this.readRolesConfig();
      if (!(name in config)) {
        throw new RolesServiceError(404, `Role '${name}' not found`);
      }

      // Check user references
      const users = await this.getUsers();
      const referencingUsers = users.filter((u) => u.role === name);
      if (referencingUsers.length > 0) {
        throw new RolesServiceError(
          409,
          `Role '${name}' is still referenced by ${referencingUsers.length} user(s)`
        );
      }

      delete (config as Record<string, unknown>)[name];
      await this.saveRolesConfig(config);

      return true;
    });
  }

  async reload(): Promise<void> {
    // No-op: we always read fresh from disk
  }

  /**
   * V3 芯片删除级联清理：从每个角色的 access.allowedChips 与 access.grants.chipIds 中
   * 剔除已删除的 chip id（通配符 '*' 不是字面 chip id，从不剔除，保留 admin 类角色的全权）。
   * 仅当至少一个角色发生变化时才写盘一次。返回受影响的角色数（用于并入调用方的聚合计数）。
   */
  async removeChipIdsFromAllRoles(deletedChipIds: readonly string[]): Promise<{ affectedRoles: number }> {
    if (deletedChipIds.length === 0) {
      return { affectedRoles: 0 };
    }
    return this.withMutationLock(async () => {
      const deleted = new Set(deletedChipIds);
      const config = await this.readRolesConfig();
      let affectedRoles = 0;
      let changed = false;

    for (const [roleName, value] of Object.entries(config)) {
      if (roleName === '_permissions' || typeof value !== 'object' || value === null) {
        continue;
      }
      const role = value as RoleDefinition;
      const access = role.access;
      if (!access) {
        continue;
      }

      let roleChanged = false;
      let nextAllowedChips = access.allowedChips;
      if (Array.isArray(access.allowedChips) && access.allowedChips.some((chipId) => chipId !== '*' && deleted.has(chipId))) {
        nextAllowedChips = access.allowedChips.filter((chipId) => chipId === '*' || !deleted.has(chipId));
        roleChanged = true;
      }

      let nextGrantChipIds = access.grants?.chipIds;
      if (Array.isArray(access.grants?.chipIds) && access.grants.chipIds.some((chipId) => chipId !== '*' && deleted.has(chipId))) {
        nextGrantChipIds = access.grants.chipIds.filter((chipId) => chipId === '*' || !deleted.has(chipId));
        roleChanged = true;
      }

      if (roleChanged) {
        (config as Record<string, unknown>)[roleName] = {
          ...role,
          access: {
            ...access,
            allowedChips: nextAllowedChips,
            ...(access.grants !== undefined ? { grants: { ...access.grants, chipIds: nextGrantChipIds } } : {})
          }
        };
        affectedRoles += 1;
        changed = true;
      }
    }

    if (changed) {
      await this.saveRolesConfig(config);
    }

    return { affectedRoles };
    });
  }
}
