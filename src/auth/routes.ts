import { z } from 'zod';
import type {
  AuthConfig,
  LoginResponse,
  McpVerifyResponse,
  PublicUser,
  UserProfile,
  UserSelfServicePolicy,
  UserStatus,
  UserType
} from './types.js';
import type { JwtService } from './jwt-service.js';
import type { UserStore } from './user-store.js';
import type { RolesService } from './roles.js';
import { isModelId, type ModelId } from '../model-catalog.js';
import type { ResourceGrantInput } from '../security/index.js';

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const UserStatusSchema = z.enum(['active', 'disabled']);
const UserTypeSchema = z.enum([
  'internal_engineer',
  'factory_fae',
  'agent_fae',
  'agent_engineer',
  'customer_engineer',
  'external_partner',
  'other'
]);
const OptionalExpirySchema = z
  .union([z.string().trim(), z.null()])
  .optional()
  .refine((value) => value === undefined || value === null || value === '' || isIsoDate(value), 'expiresAt must be an ISO date')
  .transform((value) => (value === undefined ? undefined : value === null || value === '' ? null : value));
const UserProfileSchema = z
  .object({
    realName: z.string().trim().optional(),
    company: z.string().trim().optional(),
    userType: UserTypeSchema.optional(),
    email: z.string().trim().optional(),
    note: z.string().trim().optional(),
    jobTitle: z.string().trim().optional(),
    contact: z.string().trim().optional(),
    usagePurpose: z.string().trim().optional(),
    focusBrands: z.array(z.string().trim()).optional(),
    focusProductLines: z.array(z.string().trim()).optional(),
    focusChipDirections: z.array(z.string().trim()).optional()
  })
  .partial()
  .optional();

const SelfServicePolicySchema = z
  .object({
    allowMcpKeySelfCreate: z.boolean().optional(),
    maxMcpKeys: z.number().int().min(0).optional(),
    defaultMcpKeyTtlDays: z.number().int().min(0).optional(),
    allowMcpKeyRegenerate: z.boolean().optional()
  })
  .partial()
  .optional();

const ModelGrantSchema = z
  .array(z.string().trim().refine((value) => isModelId(value), 'unknown model id'))
  .optional()
  .transform((values) => values as ModelId[] | undefined);

const ResourceGrantSchema = z
  .object({
    brands: z.array(z.string().trim().min(1)).optional(),
    productLines: z.array(z.string().trim().min(1)).optional(),
    chipIds: z.array(z.string().trim().min(1)).optional(),
    documentIds: z.array(z.string().trim().min(1)).optional(),
    scopePresetIds: z.array(z.string().trim().min(1)).optional(),
    modelIds: z.array(z.string().trim().min(1)).optional(),
    mcpTools: z.array(z.string().trim().min(1)).optional()
  })
  .partial()
  .optional()
  .transform((value) => value as ResourceGrantInput | undefined);

const CreateUserSchema = z.object({
  username: z.string().trim().min(1, 'username is required'),
  password: z.string().min(1, 'password is required'),
  role: z.string().trim().min(1, 'role name is required').default('customer'),
  status: UserStatusSchema.optional(),
  expiresAt: OptionalExpirySchema,
  profile: UserProfileSchema,
  modelGrants: ModelGrantSchema,
  resourceGrants: ResourceGrantSchema,
  selfService: SelfServicePolicySchema
});

const CreateMcpKeySchema = z.object({
  name: z.string().trim().min(1),
  expiresAt: OptionalExpirySchema,
  modelGrants: ModelGrantSchema,
  resourceGrants: ResourceGrantSchema
});

const VerifyMcpKeySchema = z.object({
  key: z.string().min(1)
});

const UpdateUserRoleSchema = z.object({
  role: z.string().trim().min(1, 'role name is required')
});

const UpdateUserSchema = z.object({
  role: z.string().trim().min(1, 'role name is required').optional(),
  status: UserStatusSchema.nullable().optional(),
  expiresAt: OptionalExpirySchema,
  profile: UserProfileSchema.nullable().optional(),
  modelGrants: ModelGrantSchema.nullable().optional(),
  resourceGrants: ResourceGrantSchema.nullable().optional(),
  selfService: SelfServicePolicySchema.nullable().optional()
});

const UpdateUserPasswordSchema = z.object({
  password: z.string().min(1, 'password is required')
});

const UpdateMcpKeySchema = z.object({
  name: z.string().trim().min(1).optional(),
  expiresAt: OptionalExpirySchema,
  modelGrants: ModelGrantSchema.nullable().optional(),
  resourceGrants: ResourceGrantSchema.nullable().optional()
});

export type AdminRouteMatch =
  | { kind: 'users' }
  | { kind: 'user'; userId: string }
  | { kind: 'userPassword'; userId: string }
  | { kind: 'userKeys'; userId: string }
  | { kind: 'userKey'; userId: string; keyId: string }
  | { kind: 'roles' }
  | { kind: 'role'; name: string };

export class AuthRouteError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

export interface AuthRoutes {
  login(body: unknown): Promise<LoginResponse>;
  listUsers(): Promise<{ users: ReturnType<UserStore['toAdminPublicUser']>[] }>;
  createUser(body: unknown): Promise<{ user: PublicUser }>;
  getUser(userId: string): Promise<{ user: ReturnType<UserStore['toAdminPublicUser']> }>;
  updateUser(userId: string, body: unknown): Promise<{ user: ReturnType<UserStore['toAdminPublicUser']> }>;
  updateUserRole(userId: string, body: unknown): Promise<{ user: ReturnType<UserStore['toAdminPublicUser']> }>;
  updateUserPassword(userId: string, body: unknown): Promise<{ user: ReturnType<UserStore['toAdminPublicUser']> }>;
  deleteUser(userId: string): Promise<{ deleted: true }>;
  addMcpKey(userId: string, body: unknown): Promise<{ key: PublicUser['mcpKeys'][number] & { key: string } }>;
  updateMcpKey(userId: string, keyId: string, body: unknown): Promise<{ key: PublicUser['mcpKeys'][number] }>;
  removeMcpKey(userId: string, keyId: string): Promise<{ removed: true }>;
  verifyMcpKey(body: unknown): Promise<McpVerifyResponse>;
  matchAdminRoute(pathname: string): AdminRouteMatch | undefined;
  matchRolesRoute(pathname: string): RolesRouteMatch | undefined;
  roles: {
    list(): Promise<{ roles: unknown; _permissions: unknown }>;
    get(name: string): Promise<unknown>;
    create(body: unknown): Promise<{ role: unknown }>;
    update(name: string, body: unknown): Promise<{ role: unknown }>;
    delete(name: string): Promise<{ deleted: true }>;
    reload(): Promise<{ reloaded: true }>;
  };
}

export function createAuthRoutes({
  userStore,
  jwtService,
  config,
  rolesService
}: {
  userStore: UserStore;
  jwtService: JwtService;
  config: AuthConfig;
  rolesService?: RolesService;
}): AuthRoutes {
  return {
    async login(body: unknown) {
      const params = LoginSchema.parse(body);
      const user = await userStore.verifyLogin(params.username, params.password);
      if (!user) {
        throw new AuthRouteError(401, 'Invalid username or password');
      }

      return {
        token: jwtService.sign(user.id, user.username, user.role),
        user: userStore.toPublicUser(user),
        expiresIn: config.jwtExpiresIn
      };
    },

    async listUsers() {
      return { users: userStore.getAllUsersForAdmin() };
    },

    async createUser(body: unknown) {
      const params = CreateUserSchema.parse(body);
      await ensureRoleExists(params.role, rolesService);
      let user: Awaited<ReturnType<UserStore['createUser']>>;
      try {
        user = await userStore.createUser(params.username, params.password, params.role, {
          status: params.status,
          expiresAt: params.expiresAt ?? undefined,
          profile: normalizeProfile(params.profile) ?? undefined,
          modelGrants: params.modelGrants,
          resourceGrants: params.resourceGrants,
          selfService: normalizeSelfServicePolicy(params.selfService) ?? undefined
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'User already exists') {
          throw new AuthRouteError(400, 'User already exists');
        }
        throw error;
      }
      return { user: userStore.toAdminPublicUser(user) };
    },

    async updateUser(userId: string, body: unknown) {
      const params = UpdateUserSchema.parse(body);
      if (params.role) {
        await ensureRoleExists(params.role, rolesService);
      }
      let user: Awaited<ReturnType<UserStore['updateUser']>>;
      try {
        user = await userStore.updateUser(userId, {
          role: params.role,
          status: params.status as UserStatus | null | undefined,
          expiresAt: params.expiresAt,
          profile: normalizeProfile(params.profile as UserProfile | null | undefined),
          modelGrants: params.modelGrants,
          resourceGrants: params.resourceGrants,
          selfService: normalizeSelfServicePolicy(params.selfService as UserSelfServicePolicy | null | undefined)
        });
      } catch (error) {
        throw mapUserStoreError(error);
      }
      return { user: userStore.toAdminPublicUser(user) };
    },

    async getUser(userId: string) {
      const user = await userStore.findById(userId);
      if (!user) {
        throw new AuthRouteError(404, 'User not found');
      }
      return { user: userStore.toAdminPublicUser(user) };
    },

    async updateUserRole(userId: string, body: unknown) {
      const params = UpdateUserRoleSchema.parse(body);
      await ensureRoleExists(params.role, rolesService);
      let user: Awaited<ReturnType<UserStore['updateUserRole']>>;
      try {
        user = await userStore.updateUserRole(userId, params.role);
      } catch (error) {
        throw mapUserStoreError(error);
      }
      return { user: userStore.toAdminPublicUser(user) };
    },

    async updateUserPassword(userId: string, body: unknown) {
      const params = UpdateUserPasswordSchema.parse(body);
      let user: Awaited<ReturnType<UserStore['updatePassword']>>;
      try {
        user = await userStore.updatePassword(userId, params.password);
      } catch (error) {
        throw mapUserStoreError(error);
      }
      return { user: userStore.toAdminPublicUser(user) };
    },

    async deleteUser(userId: string) {
      let deleted = false;
      try {
        deleted = await userStore.deleteUser(userId);
      } catch (error) {
        throw mapUserStoreError(error);
      }
      if (!deleted) {
        throw new AuthRouteError(404, 'User not found');
      }
      return { deleted: true };
    },

    async addMcpKey(userId: string, body: unknown) {
      const params = CreateMcpKeySchema.parse(body);
      const key = await userStore.addMcpKey(userId, params.name, {
        expiresAt: params.expiresAt ?? undefined,
        modelGrants: params.modelGrants,
        resourceGrants: params.resourceGrants
      });
      const publicKey = await getPublicMcpKey(userStore, userId, key.id);
      return {
        key: {
          ...publicKey,
          key: key.key,
        }
      };
    },

    async updateMcpKey(userId: string, keyId: string, body: unknown) {
      const params = UpdateMcpKeySchema.parse(body);
      let key: Awaited<ReturnType<UserStore['updateMcpKey']>>;
      try {
        key = await userStore.updateMcpKey(userId, keyId, {
          name: params.name,
          expiresAt: params.expiresAt,
          modelGrants: params.modelGrants,
          resourceGrants: params.resourceGrants
        });
      } catch (error) {
        throw mapUserStoreError(error);
      }
      const publicKey = await getPublicMcpKey(userStore, userId, key.id);
      return {
        key: publicKey
      };
    },

    async removeMcpKey(userId: string, keyId: string) {
      const removed = await userStore.removeMcpKey(userId, keyId);
      if (!removed) {
        throw new AuthRouteError(404, 'MCP key not found');
      }
      return { removed: true };
    },

    async verifyMcpKey(body: unknown) {
      const params = VerifyMcpKeySchema.parse(body);
      const user = await userStore.verifyMcpKey(params.key);
      if (!user) {
        return { valid: false };
      }

      return {
        valid: true,
        userId: user.id,
        username: user.username,
        role: user.role
      };
    },

    roles: rolesService
      ? {
          async list() {
            const roles = await rolesService.getAllRoles();
            const _permissions = await rolesService.getPermissionMetadata();
            return { roles, _permissions };
          },
          async get(name: string) {
            return rolesService.getRole(name);
          },
          async create(body: unknown) {
            const role = await rolesService.createRole(body as never);
            return { role };
          },
          async update(name: string, body: unknown) {
            const role = await rolesService.updateRole(name, body as never);
            return { role };
          },
          async delete(name: string) {
            await rolesService.deleteRole(name);
            return { deleted: true };
          },
          async reload() {
            await rolesService.reload();
            return { reloaded: true };
          }
        }
      : {
          async list() {
            throw new AuthRouteError(500, 'Roles service not configured');
          },
          async get(_name: string) {
            throw new AuthRouteError(500, 'Roles service not configured');
          },
          async create(_body: unknown) {
            throw new AuthRouteError(500, 'Roles service not configured');
          },
          async update(_name: string, _body: unknown) {
            throw new AuthRouteError(500, 'Roles service not configured');
          },
          async delete(_name: string) {
            throw new AuthRouteError(500, 'Roles service not configured');
          },
          async reload() {
            throw new AuthRouteError(500, 'Roles service not configured');
          }
        },

    matchAdminRoute,
    matchRolesRoute
  };
}

export function matchAdminRoute(pathname: string): AdminRouteMatch | undefined {
  if (pathname === '/admin/users') {
    return { kind: 'users' };
  }

  const passwordMatch = /^\/admin\/users\/([^/]+)\/password$/.exec(pathname);
  if (passwordMatch?.[1]) {
    return { kind: 'userPassword', userId: decodeURIComponent(passwordMatch[1]) };
  }

  const userMatch = /^\/admin\/users\/([^/]+)$/.exec(pathname);
  if (userMatch?.[1]) {
    return { kind: 'user', userId: decodeURIComponent(userMatch[1]) };
  }

  const keysMatch = /^\/admin\/users\/([^/]+)\/keys$/.exec(pathname);
  if (keysMatch?.[1]) {
    return { kind: 'userKeys', userId: decodeURIComponent(keysMatch[1]) };
  }

  const keyMatch = /^\/admin\/users\/([^/]+)\/keys\/([^/]+)$/.exec(pathname);
  if (keyMatch?.[1] && keyMatch[2]) {
    return {
      kind: 'userKey',
      userId: decodeURIComponent(keyMatch[1]),
      keyId: decodeURIComponent(keyMatch[2])
    };
  }

  return undefined;
}

async function ensureRoleExists(role: string, rolesService?: RolesService): Promise<void> {
  if (!rolesService) {
    return;
  }
  try {
    await rolesService.getRole(role);
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 404) {
      throw new AuthRouteError(400, `Role '${role}' does not exist`);
    }
    throw error;
  }
}

function mapUserStoreError(error: unknown): AuthRouteError | unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.message === 'User not found') {
    return new AuthRouteError(404, 'User not found');
  }
  if (error.message === 'MCP key not found') {
    return new AuthRouteError(404, 'MCP key not found');
  }
  if (error.message === 'Cannot remove the last admin') {
    return new AuthRouteError(409, 'Cannot remove the last admin');
  }
  return error;
}

function isIsoDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function normalizeProfile(profile: UserProfile | null | undefined): UserProfile | null | undefined {
  if (profile === null || profile === undefined) {
    return profile;
  }

  const normalized: UserProfile = {};
  for (const [key, value] of Object.entries(profile) as [
    keyof UserProfile,
    string | string[] | UserType | undefined
  ][]) {
    if (Array.isArray(value)) {
      const normalizedList = normalizeStringList(value);
      if (normalizedList.length > 0) {
        normalized[key] = normalizedList as never;
      }
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    if (typeof value === 'string') {
      normalized[key] = value.trim() as never;
    } else if (value !== undefined) {
      normalized[key] = value as never;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSelfServicePolicy(
  policy: UserSelfServicePolicy | null | undefined
): UserSelfServicePolicy | null | undefined {
  if (policy === null || policy === undefined) {
    return policy;
  }
  const normalized: UserSelfServicePolicy = {};
  if (policy.allowMcpKeySelfCreate !== undefined) {
    normalized.allowMcpKeySelfCreate = policy.allowMcpKeySelfCreate;
  }
  if (policy.maxMcpKeys !== undefined) {
    normalized.maxMcpKeys = policy.maxMcpKeys;
  }
  if (policy.defaultMcpKeyTtlDays !== undefined) {
    normalized.defaultMcpKeyTtlDays = policy.defaultMcpKeyTtlDays;
  }
  if (policy.allowMcpKeyRegenerate !== undefined) {
    normalized.allowMcpKeyRegenerate = policy.allowMcpKeyRegenerate;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function getPublicMcpKey(userStore: UserStore, userId: string, keyId: string): Promise<PublicUser['mcpKeys'][number]> {
  const user = await userStore.findById(userId);
  const publicKey = user ? userStore.toPublicUser(user).mcpKeys.find((candidate) => candidate.id === keyId) : undefined;
  if (!publicKey) {
    throw new AuthRouteError(404, 'MCP key not found');
  }
  return publicKey;
}

export type RolesRouteMatch = { kind: 'roles' } | { kind: 'role'; name: string };

export function matchRolesRoute(pathname: string): RolesRouteMatch | undefined {
  if (pathname === '/admin/roles') {
    return { kind: 'roles' };
  }

  const roleMatch = /^\/admin\/roles\/([^/]+)$/.exec(pathname);
  if (roleMatch?.[1]) {
    return { kind: 'role', name: decodeURIComponent(roleMatch[1]) };
  }

  return undefined;
}
