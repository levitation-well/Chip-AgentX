import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { writeJsonAtomic } from '../persistence/json-file.js';
import type {
  McpKey,
  LocalePreference,
  OnboardingStep,
  UserOnboardingState,
  PublicMcpKey,
  PublicUser,
  PublicUserCredits,
  User,
  UserCreditReservation,
  UserCredits,
  UserProfile,
  UserRole,
  UserSelfServicePolicy,
  UserStatus
} from './types.js';
import { getMcpKeyAvailability, getUserAvailability } from './user-governance.js';
import type { ResourceGrantInput } from '../security/index.js';
import {
  getEffectiveModelGrants,
  isModelId,
  normalizeModelGrants,
  validateModelGrants,
  type ModelId
} from '../model-catalog.js';
import type { AuditLogger } from '../logging/index.js';

export const DEFAULT_CREDIT_UNITS = 999900;
export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = 'zh-CN';
export const SUPPORTED_LOCALE_PREFERENCES = ['zh-CN', 'en-US'] as const;
export const ONBOARDING_STEPS = [
  'profile',
  'permissions',
  'mcp_key',
  'mcp_access',
  'whoami',
  'first_chat',
  'upload_disclaimer'
] as const satisfies readonly OnboardingStep[];

type NormalizedOnboardingState = Required<Pick<UserOnboardingState, 'status' | 'completedSteps' | 'dismissedHints'>> &
  Pick<UserOnboardingState, 'dismissedAt' | 'completedAt' | 'updatedAt'>;

export type AdminPublicMcpKey = PublicMcpKey;
export type AdminPublicUser = Omit<PublicUser, 'mcpKeys'> & { mcpKeys: AdminPublicMcpKey[] };
export interface McpKeyLookupResult {
  user: User;
  key: McpKey;
}

export interface CreateUserOptions {
  status?: UserStatus;
  expiresAt?: string;
  profile?: UserProfile;
  modelGrants?: ModelId[];
  resourceGrants?: ResourceGrantInput;
  credits?: UserCredits;
  selfService?: UserSelfServicePolicy;
  localePreference?: LocalePreference;
  preferredLanguage?: LocalePreference;
  onboarding?: UserOnboardingState;
}

export interface UpdateUserPatch {
  role?: UserRole;
  status?: UserStatus | null;
  expiresAt?: string | null;
  profile?: UserProfile | null;
  modelGrants?: ModelId[] | null;
  resourceGrants?: ResourceGrantInput | null;
  credits?: UserCredits | null;
  selfService?: UserSelfServicePolicy | null;
  localePreference?: LocalePreference | null;
  preferredLanguage?: LocalePreference | null;
  onboarding?: UserOnboardingState | null;
}

export interface UpdateMcpKeyPatch {
  name?: string;
  expiresAt?: string | null;
  modelGrants?: ModelId[] | null;
  resourceGrants?: ResourceGrantInput | null;
}

export interface CreateSelfServiceMcpKeyOptions {
  name: string;
  expiresAt?: string | null;
}

export interface CreateSelfServiceMcpKeyResult {
  key: PublicMcpKey;
  secret: string;
}

export interface UserStoreConfig {
  dataDir: string;
  adminUser: string;
  adminPasswordHash: string;
}

export interface LegacyChipAccessMigrationOptions {
  legacyFile: string;
  auditLogger?: AuditLogger;
  now?: () => Date;
}

export interface LegacyChipAccessMigrationResult {
  migrated: boolean;
  changedUsers: number;
  markerFile: string;
  usersBackupFile?: string;
  legacyBackupFile?: string;
}

interface LegacyChipAccessCatalog {
  users: Record<string, string[]>;
}

interface UserStoreMigrationMarker {
  d4ChipAccessMerge?: {
    completedAt: string;
    changedUsers: number;
    legacyFile: string;
    usersBackupFile?: string;
    legacyBackupFile?: string;
  };
  [key: string]: unknown;
}

const D4_CHIP_ACCESS_MERGE_MIGRATION = 'd4ChipAccessMerge';
const RESOURCE_GRANT_KEYS = [
  'brands',
  'productLines',
  'chipIds',
  'documentIds',
  'scopePresetIds',
  'modelIds',
  'mcpTools'
] as const;

export class UserStore {
  private readonly usersPath: string;
  private initPromise: Promise<void> | undefined;
  private initialized = false;
  private users: User[] = [];
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(private readonly config: UserStoreConfig) {
    this.usersPath = path.join(config.dataDir, 'users.json');
  }

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    try {
      await this.initPromise;
      this.initialized = true;
    } finally {
      this.initPromise = undefined;
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    this.users = await this.loadUsers();

    if (!this.users.some((user) => user.username === this.config.adminUser)) {
      const now = new Date().toISOString();
      this.users.push({
        id: crypto.randomUUID(),
        username: this.config.adminUser,
        passwordHash: this.config.adminPasswordHash,
        mcpKeys: [],
        createdAt: now,
        role: 'admin',  // ADDED: default admin role per D-07
        credits: { balanceUnits: DEFAULT_CREDIT_UNITS }
      });
      await this.saveUsers();
    }
  }

  async createUser(username: string, password: string, role: UserRole = 'customer', options: CreateUserOptions = {}): Promise<User> {
    this.ensureReady();
    if (this.users.some((user) => user.username === username)) {
      throw new Error('User already exists');
    }

    const user: User = {
      id: crypto.randomUUID(),
      username,
      passwordHash: await bcrypt.hash(password, 10),
      mcpKeys: [],
      createdAt: new Date().toISOString(),
      role,  // ADDED: default to customer per D-07/D-08
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.modelGrants !== undefined ? { modelGrants: validateModelGrants(options.modelGrants) } : {}),
      ...(options.resourceGrants !== undefined ? { resourceGrants: normalizeResourceGrantInput(options.resourceGrants) } : {}),
      ...(options.selfService !== undefined ? { selfService: normalizeSelfServicePolicy(options.selfService) } : {}),
      ...(options.localePreference !== undefined ? { localePreference: normalizeLocalePreference(options.localePreference) } : {}),
      ...(options.preferredLanguage !== undefined ? { preferredLanguage: normalizeLocalePreference(options.preferredLanguage) } : {}),
      ...(options.onboarding !== undefined ? { onboarding: normalizeOnboardingState(options.onboarding) } : {}),
      credits: options.credits ?? { balanceUnits: DEFAULT_CREDIT_UNITS }
    };
    this.users.push(user);
    await this.saveUsers();

    return user;
  }

  async createUserWithPasswordHash(
    username: string,
    passwordHash: string,
    role: UserRole = 'customer',
    options: CreateUserOptions = {}
  ): Promise<User> {
    this.ensureReady();
    if (this.users.some((user) => user.username === username)) {
      throw new Error('User already exists');
    }
    if (!/^\$2[aby]\$\d{2}\$/.test(passwordHash)) {
      throw new Error('Invalid password hash');
    }

    const user: User = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      mcpKeys: [],
      createdAt: new Date().toISOString(),
      role,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
      ...(options.modelGrants !== undefined ? { modelGrants: validateModelGrants(options.modelGrants) } : {}),
      ...(options.resourceGrants !== undefined ? { resourceGrants: normalizeResourceGrantInput(options.resourceGrants) } : {}),
      ...(options.selfService !== undefined ? { selfService: normalizeSelfServicePolicy(options.selfService) } : {}),
      ...(options.localePreference !== undefined ? { localePreference: normalizeLocalePreference(options.localePreference) } : {}),
      ...(options.preferredLanguage !== undefined ? { preferredLanguage: normalizeLocalePreference(options.preferredLanguage) } : {}),
      ...(options.onboarding !== undefined ? { onboarding: normalizeOnboardingState(options.onboarding) } : {}),
      credits: options.credits ?? { balanceUnits: DEFAULT_CREDIT_UNITS }
    };
    this.users.push(user);
    await this.saveUsers();

    return user;
  }

  async findByUsername(username: string): Promise<User | null> {
    this.ensureReady();
    return this.users.find((user) => user.username === username) ?? null;
  }

  async findById(userId: string): Promise<User | null> {
    this.ensureReady();
    return this.users.find((user) => user.id === userId) ?? null;
  }

  async verifyLogin(username: string, password: string): Promise<User | null> {
    const user = await this.findByUsername(username);
    if (!user) {
      return null;
    }

    if (!getUserAvailability(user).usable) {
      return null;
    }

    return (await bcrypt.compare(password, user.passwordHash)) ? user : null;
  }

  async addMcpKey(
    userId: string,
    name: string,
    options: { expiresAt?: string; modelGrants?: ModelId[]; resourceGrants?: ResourceGrantInput } = {}
  ): Promise<McpKey> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error('User not found');
    }

    const key: McpKey = {
      id: crypto.randomUUID(),
      key: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.modelGrants !== undefined ? { modelGrants: validateModelGrants(options.modelGrants) } : {}),
      ...(options.resourceGrants !== undefined ? { resourceGrants: normalizeResourceGrantInput(options.resourceGrants) } : {})
    };
    user.mcpKeys.push(key);
    await this.saveUsers();

    return key;
  }

  async removeMcpKey(userId: string, keyId: string): Promise<boolean> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      return false;
    }

    const before = user.mcpKeys.length;
    user.mcpKeys = user.mcpKeys.filter((key) => key.id !== keyId);
    if (user.mcpKeys.length === before) {
      return false;
    }

    await this.saveUsers();
    return true;
  }

  async updateUser(userId: string, patch: UpdateUserPatch): Promise<User> {
    this.ensureReady();
    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = this.users[index]!;
    const nextUser: User = {
      ...user,
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined && patch.status !== null ? { status: patch.status } : {}),
      ...(patch.expiresAt !== undefined && patch.expiresAt !== null ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.profile !== undefined && patch.profile !== null ? { profile: patch.profile } : {}),
      ...(patch.modelGrants !== undefined && patch.modelGrants !== null
        ? { modelGrants: validateModelGrants(patch.modelGrants) }
        : {}),
      ...(patch.resourceGrants !== undefined && patch.resourceGrants !== null
        ? { resourceGrants: normalizeResourceGrantInput(patch.resourceGrants) }
        : {}),
      ...(patch.credits !== undefined && patch.credits !== null ? { credits: patch.credits } : {}),
      ...(patch.selfService !== undefined && patch.selfService !== null
        ? { selfService: normalizeSelfServicePolicy(patch.selfService) }
        : {}),
      ...(patch.localePreference !== undefined && patch.localePreference !== null
        ? { localePreference: normalizeLocalePreference(patch.localePreference), preferredLanguage: normalizeLocalePreference(patch.localePreference) }
        : {}),
      ...(patch.preferredLanguage !== undefined && patch.preferredLanguage !== null
        ? { preferredLanguage: normalizeLocalePreference(patch.preferredLanguage), localePreference: normalizeLocalePreference(patch.preferredLanguage) }
        : {}),
      ...(patch.onboarding !== undefined && patch.onboarding !== null
        ? { onboarding: normalizeOnboardingState(patch.onboarding, user.onboarding) }
        : {})
    };
    if (patch.status === null) {
      delete nextUser.status;
    }
    if (patch.expiresAt === null) {
      delete nextUser.expiresAt;
    }
    if (patch.profile === null) {
      delete nextUser.profile;
    }
    if (patch.modelGrants === null) {
      delete nextUser.modelGrants;
    }
    if (patch.resourceGrants === null) {
      delete nextUser.resourceGrants;
    }
    if (patch.credits === null) {
      delete nextUser.credits;
    }
    if (patch.selfService === null) {
      delete nextUser.selfService;
    }
    if (patch.localePreference === null) {
      delete nextUser.localePreference;
    }
    if (patch.preferredLanguage === null) {
      delete nextUser.preferredLanguage;
    }
    if (patch.onboarding === null) {
      delete nextUser.onboarding;
    }
    const nextUsers = [...this.users];
    nextUsers[index] = nextUser;
    this.ensureUsableAdminRemains(nextUsers);
    this.users[index] = nextUser;
    await this.saveUsers();
    return this.users[index]!;
  }

  async updateOwnProfile(userId: string, profile: UserProfile | null): Promise<User> {
    return this.updateUser(userId, { profile });
  }

  async updateOwnLocale(userId: string, localePreference: LocalePreference): Promise<User> {
    return this.updateUser(userId, { localePreference });
  }

  async updateOwnOnboarding(userId: string, onboarding: UserOnboardingState): Promise<User> {
    const user = await this.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }
    return this.updateUser(userId, { onboarding: normalizeOnboardingState(onboarding, user.onboarding) });
  }

  async updateUserRole(userId: string, role: string): Promise<User> {
    return this.updateUser(userId, { role: role as UserRole });
  }

  async verifyPassword(userId: string, password: string): Promise<boolean> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      return false;
    }
    return bcrypt.compare(password, user.passwordHash);
  }

  async updatePassword(userId: string, password: string): Promise<User> {
    this.ensureReady();
    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = this.users[index]!;
    this.users[index] = {
      ...user,
      passwordHash: await bcrypt.hash(password, 10)
    };
    await this.saveUsers();
    return this.users[index]!;
  }

  async getCreditBalanceUnits(userId: string): Promise<number> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error('User not found');
    }
    return getUserCreditBalanceUnits(user);
  }

  async setCreditBalanceUnits(userId: string, balanceUnits: number): Promise<User> {
    this.ensureReady();
    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }
    if (!Number.isInteger(balanceUnits) || balanceUnits < 0) {
      throw new Error('Credit balance must be a non-negative integer');
    }

    this.users[index] = {
      ...this.users[index]!,
      credits: {
        ...this.users[index]!.credits,
        balanceUnits
      }
    };
    await this.saveUsers();
    return this.users[index]!;
  }

  async debitCreditBalanceUnits(
    userId: string,
    units: number
  ): Promise<{ user: User; balanceBeforeUnits: number; balanceAfterUnits: number }> {
    this.ensureReady();
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Credit debit units must be a non-negative integer');
    }

    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = this.users[index]!;
    const balanceBeforeUnits = getUserCreditBalanceUnits(user);
    if (balanceBeforeUnits < units) {
      throw new Error('Insufficient credits');
    }

    const balanceAfterUnits = balanceBeforeUnits - units;
    this.users[index] = {
      ...user,
      credits: {
        ...user.credits,
        balanceUnits: balanceAfterUnits
      }
    };
    await this.saveUsers();
    return { user: this.users[index]!, balanceBeforeUnits, balanceAfterUnits };
  }

  async creditCreditBalanceUnits(
    userId: string,
    units: number
  ): Promise<{ user: User; balanceBeforeUnits: number; balanceAfterUnits: number }> {
    this.ensureReady();
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Credit refund units must be a non-negative integer');
    }

    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }

    const user = this.users[index]!;
    const balanceBeforeUnits = getUserCreditBalanceUnits(user);
    const balanceAfterUnits = balanceBeforeUnits + units;
    this.users[index] = {
      ...user,
      credits: {
        ...user.credits,
        balanceUnits: balanceAfterUnits
      }
    };
    await this.saveUsers();
    return { user: this.users[index]!, balanceBeforeUnits, balanceAfterUnits };
  }

  async reserveCreditBalanceUnits(
    userId: string,
    reservationId: string,
    units: number
  ): Promise<{ user: User; reservationId: string; balanceBeforeUnits: number; balanceAfterUnits: number }> {
    this.ensureReady();
    if (!reservationId.trim()) {
      throw new Error('Credit reservation id is required');
    }
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Credit reservation units must be a non-negative integer');
    }
    if (this.findCreditReservation(reservationId)) {
      throw new Error('Credit reservation already exists');
    }

    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      throw new Error('User not found');
    }
    const user = this.users[index]!;
    const balanceBeforeUnits = getUserCreditBalanceUnits(user);
    if (balanceBeforeUnits < units) {
      throw new Error('Insufficient credits');
    }
    const balanceAfterUnits = balanceBeforeUnits - units;
    this.users[index] = {
      ...user,
      credits: {
        ...user.credits,
        balanceUnits: balanceAfterUnits,
        reservations: {
          ...user.credits?.reservations,
          [reservationId]: {
            units,
            balanceBeforeUnits,
            balanceAfterUnits,
            createdAt: new Date().toISOString()
          }
        }
      }
    };
    await this.saveUsers();
    return { user: this.users[index]!, reservationId, balanceBeforeUnits, balanceAfterUnits };
  }

  async commitCreditReservation(reservationId: string): Promise<boolean> {
    this.ensureReady();
    const match = this.findCreditReservation(reservationId);
    if (!match) {
      return false;
    }
    const { index, user } = match;
    const reservations = { ...user.credits!.reservations };
    delete reservations[reservationId];
    this.users[index] = {
      ...user,
      credits: {
        ...user.credits!,
        ...(Object.keys(reservations).length > 0 ? { reservations } : { reservations: undefined })
      }
    };
    await this.saveUsers();
    return true;
  }

  async releaseCreditReservation(reservationId: string): Promise<boolean> {
    this.ensureReady();
    const match = this.findCreditReservation(reservationId);
    if (!match) {
      return false;
    }
    const { index, user, reservation } = match;
    const reservations = { ...user.credits!.reservations };
    delete reservations[reservationId];
    this.users[index] = {
      ...user,
      credits: {
        ...user.credits!,
        balanceUnits: getUserCreditBalanceUnits(user) + reservation.units,
        ...(Object.keys(reservations).length > 0 ? { reservations } : { reservations: undefined })
      }
    };
    await this.saveUsers();
    return true;
  }

  listCreditReservations(): Array<{ reservationId: string; userId: string; reservation: UserCreditReservation }> {
    this.ensureReady();
    return this.users.flatMap((user) => Object.entries(user.credits?.reservations ?? {}).map(
      ([reservationId, reservation]) => ({ reservationId, userId: user.id, reservation: { ...reservation } })
    ));
  }

  async deleteUser(userId: string): Promise<boolean> {
    this.ensureReady();
    const index = this.users.findIndex((candidate) => candidate.id === userId);
    if (index === -1) {
      return false;
    }

    const nextUsers = this.users.filter((_, candidateIndex) => candidateIndex !== index);
    this.ensureUsableAdminRemains(nextUsers);
    this.users = nextUsers;
    await this.saveUsers();
    return true;
  }

  async verifyMcpKey(keyValue: string): Promise<User | null> {
    const found = await this.lookupUsableMcpKey(keyValue);
    if (!found) {
      return null;
    }

    await this.touchMcpKey(found.user.id, found.key.id);
    return found.user;
  }

  async lookupMcpKey(keyValue: string): Promise<McpKeyLookupResult | null> {
    this.ensureReady();
    for (const user of this.users) {
      const key = user.mcpKeys.find((candidate) => candidate.key === keyValue);
      if (key) {
        return { user, key };
      }
    }
    return null;
  }

  async lookupUsableMcpKey(keyValue: string, now: Date = new Date()): Promise<McpKeyLookupResult | null> {
    const found = await this.lookupMcpKey(keyValue);
    if (!found) {
      return null;
    }
    return getMcpKeyAvailability(found.user, found.key, now).usable ? found : null;
  }

  async updateMcpKey(userId: string, keyId: string, patch: UpdateMcpKeyPatch): Promise<McpKey> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    const key = user?.mcpKeys.find((candidate) => candidate.id === keyId);
    if (!user || !key) {
      throw new Error('MCP key not found');
    }

    if (patch.name !== undefined) {
      key.name = patch.name;
    }
    if (patch.expiresAt === null) {
      delete key.expiresAt;
    } else if (patch.expiresAt !== undefined) {
      key.expiresAt = patch.expiresAt;
    }
    if (patch.modelGrants === null) {
      delete key.modelGrants;
    } else if (patch.modelGrants !== undefined) {
      key.modelGrants = validateModelGrants(patch.modelGrants);
    }
    if (patch.resourceGrants === null) {
      delete key.resourceGrants;
    } else if (patch.resourceGrants !== undefined) {
      // Merge over the existing grants so dimensions absent from the patch (e.g. an admin
      // edit that only touches name/expiry/chipIds) keep their prior narrowing instead of
      // being silently wiped.
      const incoming = normalizeResourceGrantInput(patch.resourceGrants);
      key.resourceGrants = { ...(key.resourceGrants ?? {}), ...incoming };
    }

    await this.saveUsers();
    return key;
  }

  getSelfServicePolicy(user: User): Required<UserSelfServicePolicy> {
    const policy = normalizeSelfServicePolicy(user.selfService);
    return {
      allowMcpKeySelfCreate: policy.allowMcpKeySelfCreate ?? false,
      maxMcpKeys: policy.maxMcpKeys ?? 0,
      defaultMcpKeyTtlDays: policy.defaultMcpKeyTtlDays ?? 0,
      allowMcpKeyRegenerate: policy.allowMcpKeyRegenerate ?? false
    };
  }

  async listOwnMcpKeys(userId: string): Promise<PublicMcpKey[]> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error('User not found');
    }
    return user.mcpKeys.map(toPublicMcpKey);
  }

  async createSelfServiceMcpKey(
    userId: string,
    options: CreateSelfServiceMcpKeyOptions,
    now: Date = new Date()
  ): Promise<CreateSelfServiceMcpKeyResult> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    if (!user) {
      throw new Error('User not found');
    }
    const policy = this.getSelfServicePolicy(user);
    if (!policy.allowMcpKeySelfCreate) {
      throw new Error('MCP key self-service is disabled');
    }
    if (user.mcpKeys.length >= policy.maxMcpKeys) {
      throw new Error('MCP key limit reached');
    }

    const expiresAt = resolveSelfServiceExpiry(options.expiresAt, policy, now);
    const key = await this.addMcpKey(userId, options.name, { expiresAt });
    return { key: toPublicMcpKey(key), secret: key.key };
  }

  async updateOwnMcpKey(userId: string, keyId: string, patch: UpdateMcpKeyPatch): Promise<PublicMcpKey> {
    const key = await this.updateMcpKey(userId, keyId, patch);
    return toPublicMcpKey(key);
  }

  async regenerateSelfServiceMcpKey(userId: string, keyId: string): Promise<CreateSelfServiceMcpKeyResult> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    const key = user?.mcpKeys.find((candidate) => candidate.id === keyId);
    if (!user || !key) {
      throw new Error('MCP key not found');
    }
    const policy = this.getSelfServicePolicy(user);
    if (!policy.allowMcpKeySelfCreate || !policy.allowMcpKeyRegenerate) {
      throw new Error('MCP key regeneration is disabled');
    }
    key.key = crypto.randomUUID();
    key.createdAt = new Date().toISOString();
    delete key.lastUsed;
    await this.saveUsers();
    return { key: toPublicMcpKey(key), secret: key.key };
  }

  async touchMcpKey(userId: string, keyId: string, options: { minIntervalMs?: number } = {}): Promise<boolean> {
    this.ensureReady();
    const user = this.users.find((candidate) => candidate.id === userId);
    const key = user?.mcpKeys.find((candidate) => candidate.id === keyId);
    if (!user || !key) {
      return false;
    }

    const now = Date.now();
    const minIntervalMs = options.minIntervalMs ?? 0;
    if (key.lastUsed && minIntervalMs > 0) {
      const lastUsedTime = Date.parse(key.lastUsed);
      if (Number.isFinite(lastUsedTime) && now - lastUsedTime < minIntervalMs) {
        return false;
      }
    }

    key.lastUsed = new Date(now).toISOString();
    await this.saveUsers();
    return true;
  }

  getAllUsers(): PublicUser[] {
    this.ensureReady();
    return this.users.map(toPublicUser);
  }

  getAllUsersForAdmin(): AdminPublicUser[] {
    this.ensureReady();
    return this.users.map(toAdminPublicUser);
  }

  toPublicUser(user: User): PublicUser {
    return toPublicUser(user);
  }

  toAdminPublicUser(user: User): AdminPublicUser {
    return toAdminPublicUser(user);
  }

  getAuthorizedModelIdsForUser(user: User): ModelId[] {
    return normalizeModelGrants(user.modelGrants, user.role);
  }

  getAuthorizedModelIdsForMcpKey(user: User, key: McpKey): ModelId[] {
    return getEffectiveModelGrants({
      role: user.role,
      userModelGrants: user.modelGrants,
      mcpKeyModelGrants: key.modelGrants
    });
  }

  async migrateLegacyChipAccess(options: LegacyChipAccessMigrationOptions): Promise<LegacyChipAccessMigrationResult> {
    this.ensureReady();
    await this.saveQueue.catch(() => undefined);

    const markerFile = path.join(this.config.dataDir, 'users.json.migrations.json');
    const marker = await readMigrationMarker(markerFile);

    const legacy = await readLegacyChipAccessCatalog(options.legacyFile);
    if (!legacy) {
      return { migrated: false, changedUsers: 0, markerFile };
    }

    if (marker[D4_CHIP_ACCESS_MERGE_MIGRATION]) {
      const normalizedUsers = normalizeStaleEmptyChipGrantInheritance(this.users, legacy.users);
      if (normalizedUsers.changedUsers > 0) {
        this.users = normalizedUsers.users;
        await this.saveUsers();
      }
      return { migrated: false, changedUsers: 0, markerFile };
    }

    const completedAt = (options.now?.() ?? new Date()).toISOString();
    const timestamp = formatMigrationTimestamp(completedAt);
    const usersBackupFile = `${this.usersPath}.pre-d4-migration-${timestamp}.bak`;
    const legacyBackupFile = `${options.legacyFile}.pre-d4-migration-${timestamp}.bak`;
    await copyFile(this.usersPath, usersBackupFile);
    await copyFile(options.legacyFile, legacyBackupFile);

    let changedUsers = 0;
    const nextUsers = this.users.map((user) => {
      const migration = migrateUserChipGrants(user, legacy.users);
      if (!migration.changed) {
        return user;
      }
      changedUsers += 1;
      options.auditLogger?.log('authorization_chip_access_migration', 'Legacy chip access migrated to user grants', {
        userId: user.id,
        metadata: {
          previousChipIds: migration.previousChipIds,
          nextChipIds: migration.nextChipIds,
          hadLegacyEntry: migration.hadLegacyEntry
        }
      });
      return migration.user;
    });

    if (changedUsers > 0) {
      this.users = nextUsers;
      await this.saveUsers();
    }

    marker[D4_CHIP_ACCESS_MERGE_MIGRATION] = {
      completedAt,
      changedUsers,
      legacyFile: path.resolve(options.legacyFile),
      usersBackupFile,
      legacyBackupFile
    };
    await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

    return {
      migrated: true,
      changedUsers,
      markerFile,
      usersBackupFile,
      legacyBackupFile
    };
  }

  /**
   * V3 芯片删除级联清理：从每个用户的 resourceGrants.chipIds 与其每把 MCP key 的
   * resourceGrants.chipIds 中剔除已删除的 chip id（不影响其它未删除的 chip、不影响
   * 其它授权维度）。仅当至少一处发生变化时才写盘一次。返回真实计数：removedGrants 为
   * 被剔除的 grant 条目数（用户维度一条 + 每把受影响的 mcp key 各一条），affectedUsers
   * 为发生过变化的去重用户数。
   */
  async removeChipGrantsForDeletedChips(deletedChipIds: readonly string[]): Promise<{ removedGrants: number; affectedUsers: number }> {
    this.ensureReady();
    if (deletedChipIds.length === 0) {
      return { removedGrants: 0, affectedUsers: 0 };
    }
    const deleted = new Set(deletedChipIds);
    let removedGrants = 0;
    let affectedUsers = 0;
    let changed = false;

    const nextUsers = this.users.map((user) => {
      let userChanged = false;
      let nextUser = user;

      const userChipIds = user.resourceGrants?.chipIds;
      if (Array.isArray(userChipIds) && userChipIds.some((chipId) => deleted.has(chipId))) {
        const filtered = userChipIds.filter((chipId) => !deleted.has(chipId));
        nextUser = { ...nextUser, resourceGrants: { ...nextUser.resourceGrants, chipIds: filtered } };
        removedGrants += 1;
        userChanged = true;
      }

      let mcpKeysChanged = false;
      const nextMcpKeys = user.mcpKeys.map((key) => {
        const keyChipIds = key.resourceGrants?.chipIds;
        if (Array.isArray(keyChipIds) && keyChipIds.some((chipId) => deleted.has(chipId))) {
          const filtered = keyChipIds.filter((chipId) => !deleted.has(chipId));
          removedGrants += 1;
          mcpKeysChanged = true;
          return { ...key, resourceGrants: { ...key.resourceGrants, chipIds: filtered } };
        }
        return key;
      });
      if (mcpKeysChanged) {
        nextUser = { ...nextUser, mcpKeys: nextMcpKeys };
        userChanged = true;
      }

      if (userChanged) {
        affectedUsers += 1;
        changed = true;
      }
      return nextUser;
    });

    if (changed) {
      this.users = nextUsers;
      await this.saveUsers();
    }

    return { removedGrants, affectedUsers };
  }

  private async loadUsers(): Promise<User[]> {
    try {
      const raw = await readFile(this.usersPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter(isUser) : [];
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        await writeFile(this.usersPath, '[]\n', 'utf8');
        return [];
      }
      throw error;
    }
  }

  private async saveUsers(): Promise<void> {
    // P1-4 (multi-agent audit): atomic write via temp + rename with Windows EBUSY retry.
    // Direct writeFile can leave a torn JSON file on crash/power-loss, taking the entire
    // auth system offline until manual recovery.
    this.saveQueue = this.saveQueue
      .catch(() => undefined)
      .then(() => writeJsonAtomic(this.usersPath, this.users));
    await this.saveQueue;
  }

  private ensureReady(): void {
    if (!Array.isArray(this.users)) {
      throw new Error('UserStore is not initialized');
    }
  }

  private findCreditReservation(reservationId: string): {
    index: number;
    user: User;
    reservation: NonNullable<NonNullable<User['credits']>['reservations']>[string];
  } | null {
    for (let index = 0; index < this.users.length; index += 1) {
      const user = this.users[index]!;
      const reservation = user.credits?.reservations?.[reservationId];
      if (reservation) {
        return { index, user, reservation };
      }
    }
    return null;
  }

  private ensureUsableAdminRemains(users: User[]): void {
    if (this.usableAdminCount(users) <= 0) {
      throw new Error('Cannot remove the last admin');
    }
  }

  private usableAdminCount(users: User[] = this.users): number {
    return users.filter((user) => user.role === 'admin' && getUserAvailability(user).usable).length;
  }
}

function normalizeStaleEmptyChipGrantInheritance(
  users: User[],
  legacyUsers: Record<string, string[]>
): { users: User[]; changedUsers: number } {
  let changedUsers = 0;
  const nextUsers = users.map((user) => {
    const grants = normalizeResourceGrantInput(user.resourceGrants ?? {});
    const hasStaleEmptyChipIds =
      !hasOwn(legacyUsers, user.id) &&
      hasOwn(user.resourceGrants ?? {}, 'chipIds') &&
      (grants.chipIds ?? []).length === 0;
    if (!hasStaleEmptyChipIds) {
      return user;
    }
    changedUsers += 1;
    delete grants.chipIds;
    const nextUser: User = { ...user };
    if (Object.keys(grants).length > 0) {
      nextUser.resourceGrants = grants;
    } else {
      delete nextUser.resourceGrants;
    }
    return nextUser;
  });
  return { users: nextUsers, changedUsers };
}

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    mcpKeys: user.mcpKeys.map(toPublicMcpKey),
    role: user.role,  // ADDED: PublicUser includes role
    status: user.status,
    expiresAt: user.expiresAt,
    profile: user.profile,
    authorizedModels: normalizeModelGrants(user.modelGrants, user.role),
    resourceGrants: user.resourceGrants,
    credits: toPublicUserCredits(user.credits),
    selfService: user.selfService,
    localePreference: getUserLocalePreference(user),
    preferredLanguage: getUserLocalePreference(user),
    onboarding: getUserOnboardingState(user)
  };
}

interface UserChipGrantMigration {
  user: User;
  changed: boolean;
  previousChipIds?: string[];
  nextChipIds?: string[];
  hadLegacyEntry: boolean;
}

function migrateUserChipGrants(user: User, legacyUsers: Record<string, string[]>): UserChipGrantMigration {
  const grants = normalizeResourceGrantInput(user.resourceGrants ?? {});
  const hadChipField = hasOwn(user.resourceGrants ?? {}, 'chipIds');
  const previousChipIds = hadChipField ? [...(grants.chipIds ?? [])] : undefined;
  const hadLegacyEntry = hasOwn(legacyUsers, user.id);
  const legacyChipIds = hadLegacyEntry ? normalizeGrantValues(legacyUsers[user.id] ?? []) : undefined;
  let changed = false;

  if (hadLegacyEntry && legacyChipIds) {
    if (legacyChipIds.length === 0) {
      if (!hadChipField || (grants.chipIds ?? []).length > 0) {
        grants.chipIds = [];
        changed = true;
      }
    } else {
      const nextChipIds = mergeGrantValues(grants.chipIds ?? [], legacyChipIds);
      if (!hadChipField || !sameStringArray(grants.chipIds ?? [], nextChipIds)) {
        grants.chipIds = nextChipIds;
        changed = true;
      }
    }
  }
  if (!hadLegacyEntry && hadChipField && (grants.chipIds ?? []).length === 0) {
    delete grants.chipIds;
    changed = true;
  }

  if (!changed) {
    return {
      user,
      changed: false,
      previousChipIds,
      nextChipIds: hadChipField ? [...(grants.chipIds ?? [])] : undefined,
      hadLegacyEntry
    };
  }

  const nextUser: User = { ...user };
  if (Object.keys(grants).length > 0) {
    nextUser.resourceGrants = grants;
  } else {
    delete nextUser.resourceGrants;
  }

  return {
    user: nextUser,
    changed: true,
    previousChipIds,
    nextChipIds: hasOwn(grants, 'chipIds') ? [...(grants.chipIds ?? [])] : undefined,
    hadLegacyEntry
  };
}

function normalizeResourceGrantInput(grants: ResourceGrantInput): ResourceGrantInput {
  const normalized: Record<string, string[]> = {};
  for (const key of RESOURCE_GRANT_KEYS) {
    const values = grants[key];
    if (values !== undefined) {
      normalized[key] = normalizeGrantValues(values);
    }
  }
  return normalized as ResourceGrantInput;
}

function normalizeGrantValues(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))];
}

function mergeGrantValues(existing: readonly string[], incoming: readonly string[]): string[] {
  return normalizeGrantValues([...existing, ...incoming]);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function readMigrationMarker(markerFile: string): Promise<UserStoreMigrationMarker> {
  try {
    const parsed = JSON.parse(await readFile(markerFile, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as UserStoreMigrationMarker)
      : {};
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    throw error;
  }
}

async function readLegacyChipAccessCatalog(legacyFile: string): Promise<LegacyChipAccessCatalog | null> {
  try {
    const parsed = JSON.parse(await readFile(legacyFile, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const users = (parsed as { users?: unknown }).users;
    if (typeof users !== 'object' || users === null || Array.isArray(users)) {
      return null;
    }
    const normalized: Record<string, string[]> = {};
    for (const [userId, chipIds] of Object.entries(users)) {
      if (!Array.isArray(chipIds)) {
        return null;
      }
      normalized[userId] = normalizeGrantValues(chipIds);
    }
    if (Object.keys(normalized).length === 0) {
      return null;
    }
    return { users: normalized };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function formatMigrationTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, '-');
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function getUserCreditBalanceUnits(user: User): number {
  return isUserCredits(user.credits) ? user.credits.balanceUnits : DEFAULT_CREDIT_UNITS;
}

function toPublicUserCredits(credits: UserCredits | undefined): PublicUserCredits {
  return { balanceUnits: isUserCredits(credits) ? credits.balanceUnits : DEFAULT_CREDIT_UNITS };
}

function toPublicMcpKey(key: McpKey): PublicMcpKey {
  return {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    lastUsed: key.lastUsed,
    expiresAt: key.expiresAt,
    modelGrants: key.modelGrants,
    resourceGrants: key.resourceGrants,
    fingerprint: fingerprintMcpKey(key.key),
    maskedKey: maskMcpKey(key.key)
  };
}

function toAdminPublicUser(user: User): AdminPublicUser {
  return {
    ...toPublicUser(user),
    mcpKeys: user.mcpKeys.map(toAdminPublicMcpKey)
  };
}

function toAdminPublicMcpKey(key: McpKey): AdminPublicMcpKey {
  return toPublicMcpKey(key);
}

function isUser(value: unknown): value is User {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<User>;
  return (
    typeof record.id === 'string' &&
    typeof record.username === 'string' &&
    typeof record.passwordHash === 'string' &&
    Array.isArray(record.mcpKeys) &&
    record.mcpKeys.every(isMcpKey) &&
    typeof record.createdAt === 'string' &&
    typeof record.role === 'string' &&
    record.role.length > 0 &&
    (record.status === undefined || record.status === 'active' || record.status === 'disabled') &&
    (record.expiresAt === undefined || typeof record.expiresAt === 'string') &&
    (record.profile === undefined || isUserProfile(record.profile)) &&
    (record.modelGrants === undefined || isModelGrantArray(record.modelGrants)) &&
    (record.resourceGrants === undefined || isResourceGrantInput(record.resourceGrants)) &&
    (record.credits === undefined || isUserCredits(record.credits)) &&
    (record.selfService === undefined || isUserSelfServicePolicy(record.selfService)) &&
    (record.localePreference === undefined || isLocalePreference(record.localePreference)) &&
    (record.preferredLanguage === undefined || isLocalePreference(record.preferredLanguage)) &&
    (record.onboarding === undefined || isUserOnboardingState(record.onboarding))
  );
}

function isUserCredits(value: unknown): value is UserCredits {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<UserCredits>;
  return (
    typeof record.balanceUnits === 'number' &&
    Number.isInteger(record.balanceUnits) &&
    record.balanceUnits >= 0 &&
    (record.reservations === undefined || isUserCreditReservations(record.reservations))
  );
}

function isUserCreditReservations(value: unknown): value is NonNullable<UserCredits['reservations']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((reservation) => {
    if (typeof reservation !== 'object' || reservation === null) {
      return false;
    }
    const record = reservation as Record<string, unknown>;
    return (
      typeof record.units === 'number' && Number.isInteger(record.units) && record.units >= 0 &&
      typeof record.balanceBeforeUnits === 'number' && Number.isInteger(record.balanceBeforeUnits) && record.balanceBeforeUnits >= 0 &&
      typeof record.balanceAfterUnits === 'number' && Number.isInteger(record.balanceAfterUnits) && record.balanceAfterUnits >= 0 &&
      typeof record.createdAt === 'string'
    );
  });
}

function isMcpKey(value: unknown): value is McpKey {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<McpKey>;
  return (
    typeof record.id === 'string' &&
    typeof record.key === 'string' &&
    typeof record.name === 'string' &&
    typeof record.createdAt === 'string' &&
    (record.lastUsed === undefined || typeof record.lastUsed === 'string') &&
    (record.expiresAt === undefined || typeof record.expiresAt === 'string') &&
    (record.modelGrants === undefined || isModelGrantArray(record.modelGrants)) &&
    (record.resourceGrants === undefined || isResourceGrantInput(record.resourceGrants))
  );
}

function isModelGrantArray(value: unknown): value is ModelId[] {
  if (!Array.isArray(value)) {
    return false;
  }
  return value.every(isModelId);
}

function isUserProfile(value: unknown): value is UserProfile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as UserProfile;
  return (
    (record.realName === undefined || typeof record.realName === 'string') &&
    (record.company === undefined || typeof record.company === 'string') &&
    (record.email === undefined || typeof record.email === 'string') &&
    (record.note === undefined || typeof record.note === 'string') &&
    (record.jobTitle === undefined || typeof record.jobTitle === 'string') &&
    (record.contact === undefined || typeof record.contact === 'string') &&
    (record.usagePurpose === undefined || typeof record.usagePurpose === 'string') &&
    (record.focusBrands === undefined || isStringArray(record.focusBrands)) &&
    (record.focusProductLines === undefined || isStringArray(record.focusProductLines)) &&
    (record.focusChipDirections === undefined || isStringArray(record.focusChipDirections)) &&
    (record.userType === undefined ||
      record.userType === 'internal_engineer' ||
      record.userType === 'factory_fae' ||
      record.userType === 'agent_fae' ||
      record.userType === 'agent_engineer' ||
      record.userType === 'customer_engineer' ||
      record.userType === 'external_partner' ||
      record.userType === 'other')
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isResourceGrantInput(value: unknown): value is ResourceGrantInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const validKeys = new Set(['brands', 'productLines', 'chipIds', 'documentIds', 'scopePresetIds', 'modelIds', 'mcpTools']);
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) => validKeys.has(key) && isStringArray(nested)
  );
}

function isUserSelfServicePolicy(value: unknown): value is UserSelfServicePolicy {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<UserSelfServicePolicy>;
  return (
    (record.allowMcpKeySelfCreate === undefined || typeof record.allowMcpKeySelfCreate === 'boolean') &&
    (record.maxMcpKeys === undefined || (Number.isInteger(record.maxMcpKeys) && record.maxMcpKeys >= 0)) &&
    (record.defaultMcpKeyTtlDays === undefined ||
      (Number.isInteger(record.defaultMcpKeyTtlDays) && record.defaultMcpKeyTtlDays >= 0)) &&
    (record.allowMcpKeyRegenerate === undefined || typeof record.allowMcpKeyRegenerate === 'boolean')
  );
}

function normalizeSelfServicePolicy(policy: UserSelfServicePolicy | undefined): UserSelfServicePolicy {
  if (!policy) {
    return {};
  }
  const normalized: UserSelfServicePolicy = {};
  if (policy.allowMcpKeySelfCreate !== undefined) {
    normalized.allowMcpKeySelfCreate = policy.allowMcpKeySelfCreate;
  }
  if (policy.maxMcpKeys !== undefined) {
    normalized.maxMcpKeys = Math.max(0, Math.floor(policy.maxMcpKeys));
  }
  if (policy.defaultMcpKeyTtlDays !== undefined) {
    normalized.defaultMcpKeyTtlDays = Math.max(0, Math.floor(policy.defaultMcpKeyTtlDays));
  }
  if (policy.allowMcpKeyRegenerate !== undefined) {
    normalized.allowMcpKeyRegenerate = policy.allowMcpKeyRegenerate;
  }
  return normalized;
}

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === 'zh-CN' || value === 'en-US';
}

export function normalizeLocalePreference(value: unknown): LocalePreference {
  if (!isLocalePreference(value)) {
    throw new Error('Unsupported locale');
  }
  return value;
}

export function getUserLocalePreference(user: Pick<User, 'localePreference' | 'preferredLanguage'>): LocalePreference {
  if (isLocalePreference(user.localePreference)) {
    return user.localePreference;
  }
  if (isLocalePreference(user.preferredLanguage)) {
    return user.preferredLanguage;
  }
  return DEFAULT_LOCALE_PREFERENCE;
}

export function getUserOnboardingState(
  user: Pick<User, 'onboarding'>
): NormalizedOnboardingState {
  return normalizeOnboardingState(user.onboarding);
}

export function normalizeOnboardingState(
  value: UserOnboardingState | undefined,
  previous?: UserOnboardingState
): NormalizedOnboardingState {
  const previousState = previous ? normalizeOnboardingState(previous) : undefined;
  const status = value?.status ?? previousState?.status ?? 'not_started';
  if (!isOnboardingStatus(status)) {
    throw new Error('Unsupported onboarding status');
  }
  const completedSteps = normalizeOnboardingSteps(value?.completedSteps ?? previousState?.completedSteps ?? []);
  const dismissedHints = normalizeDismissedHints(value?.dismissedHints ?? previousState?.dismissedHints ?? []);
  const now = value?.updatedAt ?? new Date().toISOString();
  const normalized: NormalizedOnboardingState = {
    status,
    completedSteps,
    dismissedHints,
    updatedAt: now
  };
  const dismissedAt = value?.dismissedAt ?? previousState?.dismissedAt;
  const completedAt = value?.completedAt ?? previousState?.completedAt;
  if (status === 'skipped') {
    normalized.dismissedAt = dismissedAt ?? now;
  } else if (dismissedAt) {
    normalized.dismissedAt = dismissedAt;
  }
  if (status === 'completed') {
    normalized.completedAt = completedAt ?? now;
  } else if (completedAt) {
    normalized.completedAt = completedAt;
  }
  return normalized;
}

function isUserOnboardingState(value: unknown): value is UserOnboardingState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<UserOnboardingState>;
  try {
    return (
      (record.status === undefined || isOnboardingStatus(record.status)) &&
      (record.completedSteps === undefined || normalizeOnboardingSteps(record.completedSteps).length === record.completedSteps.length) &&
      (record.dismissedHints === undefined || isDismissedHintArray(record.dismissedHints)) &&
      (record.dismissedAt === undefined || typeof record.dismissedAt === 'string') &&
      (record.completedAt === undefined || typeof record.completedAt === 'string') &&
      (record.updatedAt === undefined || typeof record.updatedAt === 'string')
    );
  } catch {
    return false;
  }
}

function isOnboardingStatus(value: unknown): value is UserOnboardingState['status'] {
  return value === 'not_started' || value === 'in_progress' || value === 'skipped' || value === 'completed';
}

function normalizeOnboardingSteps(values: unknown): OnboardingStep[] {
  if (!Array.isArray(values)) {
    throw new Error('completedSteps must be an array');
  }
  const allowed = new Set<string>(ONBOARDING_STEPS);
  return [...new Set(values.map((value) => {
    if (typeof value !== 'string' || !allowed.has(value)) {
      throw new Error('Unsupported onboarding step');
    }
    return value as OnboardingStep;
  }))];
}

function normalizeDismissedHints(values: unknown): string[] {
  if (!Array.isArray(values)) {
    throw new Error('dismissedHints must be an array');
  }
  return [
    ...new Set(
      values.map((value) => {
        if (typeof value !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(value)) {
          throw new Error('Unsupported dismissed hint');
        }
        return value;
      })
    )
  ].slice(0, 50);
}

function isDismissedHintArray(values: unknown): values is string[] {
  try {
    normalizeDismissedHints(values);
    return true;
  } catch {
    return false;
  }
}

function resolveSelfServiceExpiry(
  expiresAt: string | null | undefined,
  policy: Required<UserSelfServicePolicy>,
  now: Date
): string {
  if (expiresAt === null) {
    throw new Error('Self-service MCP keys require an expiry');
  }
  if (expiresAt !== undefined) {
    return expiresAt;
  }
  if (policy.defaultMcpKeyTtlDays <= 0) {
    throw new Error('Self-service MCP keys require an expiry');
  }
  return new Date(now.getTime() + policy.defaultMcpKeyTtlDays * 24 * 60 * 60 * 1000).toISOString();
}

function fingerprintMcpKey(keyValue: string): string {
  return crypto.createHash('sha256').update(keyValue).digest('hex').slice(0, 12);
}

function maskMcpKey(keyValue: string): string {
  if (keyValue.length <= 8) {
    return '*'.repeat(Math.max(8, keyValue.length));
  }
  return `${keyValue.slice(0, 4)}...${keyValue.slice(-4)}`;
}
