import type { ChatMode } from './types.js';
import {
  ALLOWED_CLAUDE_MODEL_ROLES,
  DEFAULT_MODE_ROLE_MAPPING,
  normalizeClaudeModelRole,
  type ClaudeModelRole
} from './model-routing.js';

export type LegacyModelId = 'deepseek-v4-flash' | 'deepseek-v4-pro' | 'mimo-v2.5';
export type ModelId = ClaudeModelRole | LegacyModelId;
export type RuntimeModelId = ClaudeModelRole;
export type ModelProvider = 'claude-code';
export type ModelCapability = 'text' | 'long-context' | 'multi-doc' | 'scope-search' | 'image-input' | 'multimodal';

export interface ModelCatalogEntry {
  id: RuntimeModelId;
  label: string;
  mode: ChatMode;
  provider: ModelProvider;
  capabilities: readonly ModelCapability[];
  creditUnits: number;
  enabled: boolean;
}

export interface ModelCatalogErrorPayload {
  code: 'UNKNOWN_MODEL' | 'MODEL_DISABLED' | 'MODEL_NOT_AUTHORIZED';
  message: string;
  modelId: string;
}

export type ModelAuthorizationResult =
  | {
      ok: true;
      model: ModelCatalogEntry;
      modelId: RuntimeModelId;
      authorizedModelIds: RuntimeModelId[];
    }
  | {
      ok: false;
      error: ModelCatalogErrorPayload;
      authorizedModelIds: RuntimeModelId[];
    };

export const MODEL_CATALOG = [
  {
    id: 'haiku',
    label: 'Standard',
    mode: 'standard',
    provider: 'claude-code',
    capabilities: ['text'],
    creditUnits: 50,
    enabled: true
  },
  {
    id: 'sonnet',
    label: 'Enhanced',
    mode: 'enhanced',
    provider: 'claude-code',
    capabilities: ['text', 'long-context', 'multi-doc', 'scope-search'],
    creditUnits: 100,
    enabled: true
  },
  {
    id: 'opus',
    label: 'Multimodal',
    mode: 'multimodal',
    provider: 'claude-code',
    capabilities: ['text', 'image-input', 'multimodal'],
    creditUnits: 150,
    enabled: true
  },
  {
    id: 'fable',
    label: 'Balanced',
    mode: 'standard',
    provider: 'claude-code',
    capabilities: ['text'],
    creditUnits: 50,
    enabled: true
  }
] as const satisfies readonly ModelCatalogEntry[];

export const DEFAULT_MODEL_ID: RuntimeModelId = DEFAULT_MODE_ROLE_MAPPING.standard;

export const CHAT_MODE_DEFAULT_MODELS: Record<ChatMode, RuntimeModelId> = {
  ...DEFAULT_MODE_ROLE_MAPPING
};

export function listModelCatalog(): ModelCatalogEntry[] {
  return MODEL_CATALOG.map((model) => ({ ...model }));
}

export function listEnabledModels(): ModelCatalogEntry[] {
  return listModelCatalog().filter((model) => model.enabled);
}

export function listKnownModelIds(): RuntimeModelId[] {
  return MODEL_CATALOG.map((model) => model.id);
}

export function isModelId(value: unknown): value is ModelId {
  return normalizeClaudeModelRole(value) !== undefined;
}

export function getModelById(modelId: string): ModelCatalogEntry | undefined {
  const role = normalizeClaudeModelRole(modelId);
  return role ? MODEL_CATALOG.find((model) => model.id === role) : undefined;
}

export function getDefaultModelForChatMode(chatMode: ChatMode | undefined): RuntimeModelId {
  return chatMode ? CHAT_MODE_DEFAULT_MODELS[chatMode] : DEFAULT_MODEL_ID;
}

export function getDefaultModelGrantsForRole(role: string | undefined): RuntimeModelId[] {
  const normalizedRole = (role ?? '').trim().toLowerCase();
  if (normalizedRole === 'admin' || normalizedRole === 'internal') {
    return listKnownModelIds();
  }
  return [DEFAULT_MODEL_ID];
}

export function normalizeModelGrants(grants: readonly string[] | null | undefined, role?: string): RuntimeModelId[] {
  if (grants === undefined || grants === null) {
    return getDefaultModelGrantsForRole(role);
  }
  const normalized: RuntimeModelId[] = [];
  for (const grant of grants) {
    const roleGrant = normalizeClaudeModelRole(grant);
    if (roleGrant && !normalized.includes(roleGrant)) {
      normalized.push(roleGrant);
    }
  }
  return normalized;
}

export function validateModelGrants(grants: readonly string[]): RuntimeModelId[] {
  const normalized: RuntimeModelId[] = [];
  for (const grant of grants) {
    const role = normalizeClaudeModelRole(grant);
    if (!role) {
      throw new Error(`Unknown model grant: ${grant}`);
    }
    if (!normalized.includes(role)) {
      normalized.push(role);
    }
  }
  return normalized;
}

export function getEffectiveModelGrants(options: {
  role?: string;
  userModelGrants?: readonly string[] | null;
  mcpKeyModelGrants?: readonly string[] | null;
}): RuntimeModelId[] {
  const userGrants = (options.role ?? '').trim().toLowerCase() === 'admin'
    ? listKnownModelIds()
    : normalizeModelGrants(options.userModelGrants, options.role);
  if (options.mcpKeyModelGrants === undefined || options.mcpKeyModelGrants === null) {
    return userGrants;
  }
  const keyGrants = normalizeModelGrants(options.mcpKeyModelGrants, options.role);
  return keyGrants.filter((modelId) => userGrants.includes(modelId));
}

export function authorizeModelAccess(options: {
  requestedModelId?: string;
  chatMode?: ChatMode;
  role?: string;
  userModelGrants?: readonly string[] | null;
  mcpKeyModelGrants?: readonly string[] | null;
}): ModelAuthorizationResult {
  const requested = options.requestedModelId ?? getDefaultModelForChatMode(options.chatMode);
  const authorizedModelIds = getEffectiveModelGrants({
    role: options.role,
    userModelGrants: options.userModelGrants,
    mcpKeyModelGrants: options.mcpKeyModelGrants
  });
  const modelId = normalizeClaudeModelRole(requested);
  const model = modelId ? getModelById(modelId) : undefined;

  if (!model || !modelId) {
    return {
      ok: false,
      authorizedModelIds,
      error: {
        code: 'UNKNOWN_MODEL',
        message: `Unknown model: ${requested}`,
        modelId: requested
      }
    };
  }

  if (!model.enabled) {
    return {
      ok: false,
      authorizedModelIds,
      error: {
        code: 'MODEL_DISABLED',
        message: `Model is disabled: ${modelId}`,
        modelId
      }
    };
  }

  if (!authorizedModelIds.includes(model.id)) {
    return {
      ok: false,
      authorizedModelIds,
      error: {
        code: 'MODEL_NOT_AUTHORIZED',
        message: `Model is not authorized for this identity: ${requested}`,
        modelId: requested
      }
    };
  }

  return {
    ok: true,
    model,
    modelId: model.id,
    authorizedModelIds
  };
}

export function listAllowedClaudeModelRoles(): RuntimeModelId[] {
  return [...ALLOWED_CLAUDE_MODEL_ROLES];
}
