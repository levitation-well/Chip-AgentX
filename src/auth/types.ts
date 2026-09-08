import type { IncomingMessage } from 'node:http';
import type { ModelId } from '../model-catalog.js';
import type { EffectiveAuthorizationSummary, ResourceGrantInput } from '../security/types.js';

// RBAC role names are configured in config/roles.json. Built-ins include
// admin/internal/customer, and admins can add custom role names.
export type UserRole = string;

export type UserStatus = 'active' | 'disabled';

export type UserType =
  | 'internal_engineer'
  | 'factory_fae'
  | 'agent_fae'
  | 'agent_engineer'
  | 'customer_engineer'
  | 'external_partner'
  | 'other';

export interface UserProfile {
  realName?: string;
  company?: string;
  userType?: UserType;
  email?: string;
  note?: string;
  jobTitle?: string;
  contact?: string;
  usagePurpose?: string;
  focusBrands?: string[];
  focusProductLines?: string[];
  focusChipDirections?: string[];
}

export type LocalePreference = 'zh-CN' | 'en-US';

export type OnboardingStatus = 'not_started' | 'in_progress' | 'skipped' | 'completed';

export type OnboardingStep =
  | 'profile'
  | 'permissions'
  | 'mcp_key'
  | 'mcp_access'
  | 'whoami'
  | 'first_chat'
  | 'upload_disclaimer';

export interface UserOnboardingState {
  status?: OnboardingStatus;
  completedSteps?: OnboardingStep[];
  dismissedHints?: string[];
  dismissedAt?: string;
  completedAt?: string;
  updatedAt?: string;
}

export interface UserCredits {
  balanceUnits: number;
  /**
   * Internal, durable holds for in-flight requests. Keeping the hold and the
   * debited balance in the same atomic users.json write makes release/commit
   * idempotent across process restarts. This field is never exposed through
   * PublicUserCredits.
   */
  reservations?: Record<string, UserCreditReservation>;
}

export interface UserCreditReservation {
  units: number;
  balanceBeforeUnits: number;
  balanceAfterUnits: number;
  createdAt: string;
}

export interface PublicUserCredits {
  balanceUnits: number;
}

export interface McpKey {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  lastUsed?: string;
  expiresAt?: string;
  modelGrants?: ModelId[];
  resourceGrants?: ResourceGrantInput;
}

export interface UserSelfServicePolicy {
  allowMcpKeySelfCreate?: boolean;
  maxMcpKeys?: number;
  defaultMcpKeyTtlDays?: number;
  allowMcpKeyRegenerate?: boolean;
}

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  mcpKeys: McpKey[];
  createdAt: string;
  role: UserRole;  // ADDED: per D-07
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

export type PublicMcpKey = Omit<McpKey, 'key'> & {
  fingerprint: string;
  maskedKey: string;
  authorizationSummary?: EffectiveAuthorizationSummary;
};

export interface PublicUser {
  id: string;
  username: string;
  mcpKeys: PublicMcpKey[];
  createdAt: string;
  role: UserRole;  // ADDED: for client display
  status?: UserStatus;
  expiresAt?: string;
  profile?: UserProfile;
  authorizedModels: ModelId[];
  resourceGrants?: ResourceGrantInput;
  authorizationSummary?: EffectiveAuthorizationSummary;
  credits?: PublicUserCredits;
  selfService?: UserSelfServicePolicy;
  localePreference: LocalePreference;
  preferredLanguage: LocalePreference;
  onboarding: Required<Pick<UserOnboardingState, 'status' | 'completedSteps' | 'dismissedHints'>> &
    Pick<UserOnboardingState, 'dismissedAt' | 'completedAt' | 'updatedAt'>;
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: UserRole;  // ADDED: for session-scoped access
  authorizedModels?: ModelId[];
  credits?: PublicUserCredits;
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends IncomingMessage {
  user?: JwtPayload;
}

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  adminUser: string;
  adminPasswordHash: string;
  dataDir: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: PublicUser;
  expiresIn: string;
}

export interface McpVerifyRequest {
  key: string;
}

export interface McpVerifyResponse {
  valid: boolean;
  userId?: string;
  username?: string;
  role?: UserRole;  // ADDED: for MCP role-based access
  authorizedModels?: ModelId[];
}
