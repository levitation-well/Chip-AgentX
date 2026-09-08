import type { ChatMode } from './types.js';
import type { ModeRoleMapping } from './model-routing.js';
import {
  CHAT_MODE_DEFAULT_MODELS,
  getEffectiveModelGrants,
  getModelById,
  type ModelCapability,
  type ModelCatalogEntry,
  type RuntimeModelId
} from './model-catalog.js';
import { hasSufficientCredits } from './credits.js';

export type SearchModeId = ChatMode;
export type SearchModeEntryPoint = 'web-chat' | 'web-upload' | 'web-rpc' | 'remote-mcp' | 'stdio-mcp' | 'rpc' | 'cli';

export type SearchModeDisabledReasonCode =
  | 'UNKNOWN_MODE'
  | 'UNKNOWN_MODEL'
  | 'MODE_MODEL_MISMATCH'
  | 'MODEL_DISABLED'
  | 'MODEL_NOT_AUTHORIZED'
  | 'INSUFFICIENT_CREDITS'
  | 'ENTRY_NOT_SUPPORTED'
  | 'IMAGE_INPUT_NOT_ALLOWED';

export interface SearchModeDisabledReason {
  code: SearchModeDisabledReasonCode;
  message: string;
}

export interface SearchModeCatalogEntry {
  id: SearchModeId;
  label: string;
  description: string;
  capabilities: readonly ModelCapability[];
  defaultModelId: RuntimeModelId;
  creditUnits: number;
  entryRequirements: {
    requiresImageCapableEntry: boolean;
  };
}

export interface SearchModeAvailabilityEntry extends SearchModeCatalogEntry {
  modelLabel: string;
  visible: boolean;
  selectable: boolean;
  available: boolean;
  allowsImageInput: boolean;
  locked: boolean;
  disabledReasons: SearchModeDisabledReason[];
  disabledReason?: string;
}

export interface SearchModeAuthorizationContext {
  role?: string;
  userModelGrants?: readonly string[] | null;
  mcpKeyModelGrants?: readonly string[] | null;
  authorizedModelIds?: readonly RuntimeModelId[];
  creditBalanceUnits?: number;
  modeRoleMapping?: ModeRoleMapping;
}

export interface SearchModeResolveContext extends SearchModeAuthorizationContext {
  entryPoint: SearchModeEntryPoint;
  includesImageInput?: boolean;
  lockedMode?: SearchModeId;
}

export type SearchModeSelectionResult =
  | {
      ok: true;
      mode: SearchModeAvailabilityEntry;
      chatMode: SearchModeId;
      model: ModelCatalogEntry;
      modelId: RuntimeModelId;
      creditUnits: number;
      authorizedModelIds: RuntimeModelId[];
    }
  | {
      ok: false;
      statusCode: number;
      code: SearchModeDisabledReasonCode;
      message: string;
      details: Record<string, unknown>;
      authorizedModelIds: RuntimeModelId[];
    };

export const SEARCH_MODE_CATALOG = [
  {
    id: 'standard',
    label: 'Standard',
    description: 'Default text Q&A for concise answers.',
    capabilities: ['text'],
    defaultModelId: CHAT_MODE_DEFAULT_MODELS.standard,
    creditUnits: 50,
    entryRequirements: {
      requiresImageCapableEntry: false
    }
  },
  {
    id: 'enhanced',
    label: 'Enhanced',
    description: 'Long-context and multi-document answers with scoped search.',
    capabilities: ['text', 'long-context', 'multi-doc', 'scope-search'],
    defaultModelId: CHAT_MODE_DEFAULT_MODELS.enhanced,
    creditUnits: 100,
    entryRequirements: {
      requiresImageCapableEntry: false
    }
  },
  {
    id: 'multimodal',
    label: 'Multimodal',
    description: 'Image-aware answers for chat image inputs.',
    capabilities: ['text', 'image-input', 'multimodal'],
    defaultModelId: CHAT_MODE_DEFAULT_MODELS.multimodal,
    creditUnits: 150,
    entryRequirements: {
      requiresImageCapableEntry: true
    }
  }
] as const satisfies readonly SearchModeCatalogEntry[];

export function isSearchModeId(value: unknown): value is SearchModeId {
  return value === 'standard' || value === 'enhanced' || value === 'multimodal';
}

export function listSearchModeCatalog(): SearchModeCatalogEntry[] {
  return SEARCH_MODE_CATALOG.map((mode) => ({
    ...mode,
    capabilities: [...mode.capabilities],
    entryRequirements: { ...mode.entryRequirements }
  }));
}

export function getSearchModeById(modeId: SearchModeId): SearchModeCatalogEntry {
  return SEARCH_MODE_CATALOG.find((mode) => mode.id === modeId)!;
}

export function resolveSearchModeAvailability(context: SearchModeResolveContext): SearchModeAvailabilityEntry[] {
  const authorizedModelIds = resolveAuthorizedModelIds(context);

  return SEARCH_MODE_CATALOG.map((mode) => {
    const defaultModelId = resolveDefaultModelId(mode.id, context);
    const model = getModelById(defaultModelId);
    const disabledReasons: SearchModeDisabledReason[] = [];
    const entryAllowsImageInput = entryPointAllowsImageInput(context.entryPoint);
    const allowsImageInput = Boolean(
      entryAllowsImageInput && (mode.capabilities as readonly ModelCapability[]).includes('image-input')
    );

    if (!model) {
      disabledReasons.push(reason('UNKNOWN_MODEL', 'The requested model is not available.'));
    } else {
      if (!model.enabled) {
        disabledReasons.push(reason('MODEL_DISABLED', 'The requested model is not available.'));
      }
      if (!authorizedModelIds.includes(model.id)) {
        disabledReasons.push(reason('MODEL_NOT_AUTHORIZED', 'This mode is not available to this identity.'));
      }
      if (
        context.creditBalanceUnits !== undefined &&
        !hasSufficientCredits(context.creditBalanceUnits, model.creditUnits)
      ) {
        disabledReasons.push(reason('INSUFFICIENT_CREDITS', 'Insufficient credits for this mode.'));
      }
    }

    if (mode.entryRequirements.requiresImageCapableEntry && !entryAllowsImageInput) {
      disabledReasons.push(reason('ENTRY_NOT_SUPPORTED', 'This entry point does not support image input.'));
    }
    if (context.includesImageInput && !allowsImageInput) {
      disabledReasons.push(reason('IMAGE_INPUT_NOT_ALLOWED', 'Image input requires multimodal mode.'));
    }
    if (context.lockedMode && context.lockedMode !== mode.id) {
      disabledReasons.push(reason('ENTRY_NOT_SUPPORTED', 'This session is already locked to another mode.'));
    }

    const selectable = disabledReasons.length === 0;

    return {
      ...mode,
      defaultModelId,
      capabilities: [...mode.capabilities],
      entryRequirements: { ...mode.entryRequirements },
      creditUnits: model?.creditUnits ?? mode.creditUnits,
      modelLabel: model?.label ?? defaultModelId,
      visible: true,
      selectable,
      available: selectable,
      allowsImageInput,
      locked: Boolean(context.lockedMode),
      disabledReasons,
      ...(disabledReasons[0] ? { disabledReason: disabledReasons[0].message } : {})
    };
  });
}

export function resolveSearchModeSelection(options: SearchModeResolveContext & {
  requestedMode?: unknown;
  requestedModelId?: unknown;
}): SearchModeSelectionResult {
  const authorizedModelIds = resolveAuthorizedModelIds(options);
  const requestedMode = options.requestedMode;
  const requestedModelId = typeof options.requestedModelId === 'string' ? options.requestedModelId : undefined;

  if (requestedMode !== undefined && !isSearchModeId(requestedMode)) {
    return selectionError('UNKNOWN_MODE', 400, 'The requested mode is not available.', {
      chatMode: String(requestedMode)
    }, authorizedModelIds);
  }

  const requestedModel = requestedModelId ? getModelById(requestedModelId) : undefined;
  if (requestedModelId && !requestedModel) {
    return selectionError('UNKNOWN_MODEL', 400, 'The requested model is not available.', {
      modelId: requestedModelId
    }, authorizedModelIds);
  }

  const chatMode = requestedMode ?? requestedModel?.mode ?? 'standard';
  if (requestedModel && requestedModel.mode !== chatMode) {
    return selectionError('MODE_MODEL_MISMATCH', 400, 'The requested model is not valid for this mode.', {
      chatMode,
      modelId: requestedModel.id
    }, authorizedModelIds);
  }

  const defaultModelId = resolveDefaultModelId(chatMode, options);
  const model = requestedModel ?? getModelById(defaultModelId);
  if (!model) {
    return selectionError('UNKNOWN_MODEL', 400, 'The requested model is not available.', {
      modelId: requestedModelId ?? defaultModelId
    }, authorizedModelIds);
  }

  const mode = resolveSearchModeAvailability({
    ...options,
    authorizedModelIds
  }).find((candidate) => candidate.id === chatMode);
  const disabledReason = mode?.disabledReasons[0];
  if (!mode || disabledReason) {
    const code = disabledReason?.code ?? 'UNKNOWN_MODE';
    return selectionError(code, statusCodeForDisabledReason(code), disabledReason?.message ?? 'The requested mode is not available.', {
      chatMode,
      modelId: model.id,
      creditUnits: model.creditUnits,
      balanceUnits: options.creditBalanceUnits,
      disabledReasons: mode?.disabledReasons
    }, authorizedModelIds);
  }

  return {
    ok: true,
    mode,
    chatMode,
    model,
    modelId: model.id,
    creditUnits: model.creditUnits,
    authorizedModelIds
  };
}

export function entryPointAllowsImageInput(entryPoint: SearchModeEntryPoint): boolean {
  return entryPoint === 'web-chat' || entryPoint === 'web-upload';
}

export function sourceToSearchModeEntryPoint(source: 'web' | 'mcp' | 'rpc' | 'cli'): SearchModeEntryPoint {
  if (source === 'web') return 'web-chat';
  if (source === 'mcp') return 'remote-mcp';
  if (source === 'rpc') return 'web-rpc';
  return 'cli';
}

export function containsChatImageInput(value: string | undefined): boolean {
  return Boolean(value && /\/api\/chat-uploads\/[a-f0-9-]{36}\//i.test(value));
}

function resolveAuthorizedModelIds(context: SearchModeAuthorizationContext): RuntimeModelId[] {
  if (context.authorizedModelIds) {
    return [...context.authorizedModelIds];
  }
  return getEffectiveModelGrants({
    role: context.role,
    userModelGrants: context.userModelGrants,
    mcpKeyModelGrants: context.mcpKeyModelGrants
  });
}

function resolveDefaultModelId(mode: SearchModeId, context: SearchModeAuthorizationContext): RuntimeModelId {
  return context.modeRoleMapping?.[mode] ?? CHAT_MODE_DEFAULT_MODELS[mode];
}

function reason(code: SearchModeDisabledReasonCode, message: string): SearchModeDisabledReason {
  return { code, message };
}

function selectionError(
  code: SearchModeDisabledReasonCode,
  statusCode: number,
  message: string,
  details: Record<string, unknown>,
  authorizedModelIds: RuntimeModelId[]
): Extract<SearchModeSelectionResult, { ok: false }> {
  return {
    ok: false,
    statusCode,
    code,
    message,
    details: {
      ...details,
      authorizedModelIds
    },
    authorizedModelIds
  };
}

function statusCodeForDisabledReason(code: SearchModeDisabledReasonCode): number {
  if (code === 'INSUFFICIENT_CREDITS') return 402;
  if (code === 'UNKNOWN_MODE' || code === 'UNKNOWN_MODEL' || code === 'MODE_MODEL_MISMATCH' || code === 'IMAGE_INPUT_NOT_ALLOWED') {
    return 400;
  }
  return 403;
}
