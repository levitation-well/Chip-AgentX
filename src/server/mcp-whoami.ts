import type { PublicChip } from '../chips/index.js';
import type { McpKey, User } from '../auth/index.js';
import type { McpHttpSecurityConfig } from './mcp-http-security.js';
import type { ModelCapability, ModelId } from '../model-catalog.js';
import type { DocumentVisibility, ScopePresetVisibility } from '../security/index.js';
import type { SearchModeAvailabilityEntry } from '../search-modes.js';

export type McpWhoamiTransport = 'remote' | 'stdio';

export interface McpWhoamiResource {
  type: 'chip' | 'document' | 'scopePreset';
  id: string;
  label: string;
  description?: string;
  queryHint?: string;
  brand?: string;
  brandAliases?: string[];
  productLines?: string[];
  applicationTags?: string[];
  permissionTags?: string[];
  visibility?: DocumentVisibility | ScopePresetVisibility;
  brands?: string[];
  chipIds?: string[];
  documentIds?: string[];
  sourceLabels?: string[];
}

export interface McpWhoamiAllowedModel {
  id: ModelId;
  label: string;
  capabilities: readonly ModelCapability[];
  creditUnits: number;
}

export interface McpWhoamiCredits {
  balanceUnits: number;
}

export interface McpWhoamiContext {
  transport: McpWhoamiTransport;
  authEnabled: boolean;
  user?: Pick<User, 'id' | 'username' | 'role'> | null;
  key?: Pick<McpKey, 'id'> | null;
  keyFingerprint?: string;
  allowedActions: readonly string[];
  allowedModels?: readonly McpWhoamiAllowedModel[];
  allowedModes?: readonly SearchModeAvailabilityEntry[];
  searchModes?: readonly SearchModeAvailabilityEntry[];
  credits?: McpWhoamiCredits;
  resources?: McpWhoamiResource[];
  limits?: Partial<Pick<
    McpHttpSecurityConfig,
    'maxBodyBytes' | 'maxOutputChars' | 'maxPollTimeoutMs' | 'rateLimitMax' | 'verifyRateLimitMax' | 'maxTransports' | 'maxTransportsPerUser'
  >>;
  capabilityNotes?: string[];
}

export interface McpWhoamiResponse {
  transport: McpWhoamiTransport;
  auth: {
    enabled: boolean;
  };
  user: {
    id: string;
    username: string;
    role: string;
  } | null;
  mcp: {
    authenticated: boolean;
    keyId?: string;
    fingerprint?: string;
  };
  permissions: {
    allowedActions: string[];
    allowedAgentTypes: string[];
    cwdExposed: false;
    resources: McpWhoamiResource[];
    canDeploy: false;
    capabilityNotes: string[];
  };
  allowedModels: McpWhoamiAllowedModel[];
  allowedModes: SearchModeAvailabilityEntry[];
  searchModes: SearchModeAvailabilityEntry[];
  credits: McpWhoamiCredits | null;
  limits: Record<string, number>;
  summary: string;
}

export function publicChipToWhoamiResource(chip: PublicChip): McpWhoamiResource {
  return {
    type: 'chip',
    id: chip.id,
    label: chip.label,
    ...(chip.description !== undefined ? { description: chip.description } : {}),
    ...(chip.queryHint !== undefined ? { queryHint: chip.queryHint } : {}),
    ...(chip.brand !== undefined ? { brand: chip.brand } : {}),
    ...(chip.brandAliases !== undefined ? { brandAliases: [...chip.brandAliases] } : {}),
    ...(chip.productLines !== undefined ? { productLines: [...chip.productLines] } : {}),
    ...(chip.applicationTags !== undefined ? { applicationTags: [...chip.applicationTags] } : {}),
    ...(chip.documentIds !== undefined ? { documentIds: [...chip.documentIds] } : {}),
    ...(chip.permissionTags !== undefined ? { permissionTags: [...chip.permissionTags] } : {}),
    ...(chip.sourceLabels !== undefined ? { sourceLabels: [...chip.sourceLabels] } : {})
  };
}

export function buildMcpWhoamiResponse(context: McpWhoamiContext): McpWhoamiResponse {
  const user = context.user
    ? {
        id: context.user.id,
        username: context.user.username,
        role: context.user.role
      }
    : null;
  const authenticated = Boolean(context.authEnabled && user && context.key?.id);
  const capabilityNotes = context.capabilityNotes ?? [];
  const searchModes = (context.searchModes ?? context.allowedModes ?? []).map(copySearchMode);

  return {
    transport: context.transport,
    auth: {
      enabled: context.authEnabled
    },
    user,
    mcp: {
      authenticated,
      ...(context.key?.id ? { keyId: context.key.id } : {}),
      ...(context.keyFingerprint ? { fingerprint: context.keyFingerprint } : {})
    },
    permissions: {
      allowedActions: [...context.allowedActions],
      allowedAgentTypes: ['codex', 'opencode', 'pi', 'claude-code'],
      cwdExposed: false,
      resources: context.resources ?? [],
      canDeploy: false,
      capabilityNotes
    },
    allowedModels: (context.allowedModels ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      capabilities: [...model.capabilities],
      creditUnits: model.creditUnits
    })),
    allowedModes: searchModes,
    searchModes,
    credits: context.credits ? { balanceUnits: context.credits.balanceUnits } : null,
    limits: Object.fromEntries(
      Object.entries(context.limits ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    ),
    summary: buildMcpWhoamiSummary({
      transport: context.transport,
      authEnabled: context.authEnabled,
      username: user?.username,
      role: user?.role,
      resourceCount: context.resources?.length ?? 0,
      authenticated
    })
  };
}

function copySearchMode(mode: SearchModeAvailabilityEntry): SearchModeAvailabilityEntry {
  return {
    ...mode,
    capabilities: [...mode.capabilities],
    entryRequirements: { ...mode.entryRequirements },
    disabledReasons: mode.disabledReasons.map((reason) => ({ ...reason }))
  };
}

export function buildMcpWhoamiSummary(input: {
  transport: McpWhoamiTransport;
  authEnabled: boolean;
  authenticated: boolean;
  username?: string;
  role?: string;
  resourceCount: number;
}): string {
  if (!input.authEnabled) {
    return `${input.transport} MCP authentication is disabled; no key identity is attached.`;
  }
  if (!input.authenticated) {
    return `${input.transport} MCP key is not authenticated.`;
  }
  return `${input.username} (${input.role}) is connected over ${input.transport} MCP with ${input.resourceCount} visible resource(s).`;
}
