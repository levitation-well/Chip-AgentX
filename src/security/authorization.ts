import { getEffectiveModelGrants, isModelId, listKnownModelIds, type ModelId } from '../model-catalog.js';
import { getSafeAuthorizationMessage } from './safe-errors.js';
import type {
  AuthorizationDecision,
  AuthorizationReasonCode,
  AuthorizationResource,
  AuthorizationResourceType,
  AuthorizationSubject,
  BuiltInAuthorizationRole,
  ComputeEffectiveAuthorizationOptions,
  DocumentVisibility,
  EffectiveAuthorizationSummary,
  GrantValue,
  ResourceGrantInput,
  ResourceGrantSet,
  RoleAuthorizationTemplate
} from './types.js';

const EMPTY_GRANTS: ResourceGrantSet = {
  brands: [],
  productLines: [],
  chipIds: [],
  documentIds: [],
  scopePresetIds: [],
  modelIds: [],
  mcpTools: []
};

export const ROLE_AUTHORIZATION_TEMPLATES: Record<BuiltInAuthorizationRole, RoleAuthorizationTemplate> = {
  admin: {
    role: 'admin',
    label: 'Administrator',
    visibilityCeiling: 'adminOnly',
    defaultGrants: wildcardGrants(),
    deniedByDefault: false
  },
  internal: {
    role: 'internal',
    label: 'Internal user',
    visibilityCeiling: 'internal',
    defaultGrants: {
      ...wildcardGrants(),
      modelIds: listKnownModelIds(),
      documentIds: ['*'],
      scopePresetIds: ['*']
    },
    deniedByDefault: false
  },
  partner: {
    role: 'partner',
    label: 'Partner',
    visibilityCeiling: 'partner',
    defaultGrants: {
      ...EMPTY_GRANTS,
      modelIds: ['haiku'],
      mcpTools: ['agentx_whoami']
    },
    deniedByDefault: true
  },
  customer: {
    role: 'customer',
    label: 'Customer',
    visibilityCeiling: 'customer',
    defaultGrants: {
      ...EMPTY_GRANTS,
      modelIds: ['haiku'],
      mcpTools: ['agentx_whoami']
    },
    deniedByDefault: true
  },
  public: {
    role: 'public',
    label: 'Public',
    visibilityCeiling: 'public',
    defaultGrants: {
      ...EMPTY_GRANTS,
      modelIds: ['haiku']
    },
    deniedByDefault: true
  }
};

const VISIBILITY_RANK: Record<DocumentVisibility, number> = {
  public: 0,
  customer: 1,
  partner: 2,
  internal: 3,
  restricted: 4,
  adminOnly: 5
};

const GRANT_FIELD_BY_RESOURCE_TYPE: Record<AuthorizationResourceType, keyof ResourceGrantSet> = {
  brand: 'brands',
  productLine: 'productLines',
  chip: 'chipIds',
  document: 'documentIds',
  scopePreset: 'scopePresetIds',
  model: 'modelIds',
  mcpTool: 'mcpTools'
};

export function getRoleAuthorizationTemplate(role: string | undefined): RoleAuthorizationTemplate {
  const normalized = normalizeRole(role);
  return ROLE_AUTHORIZATION_TEMPLATES[normalized] ?? ROLE_AUTHORIZATION_TEMPLATES.customer;
}

export function normalizeResourceGrantSet(input: ResourceGrantInput | undefined): ResourceGrantSet {
  return {
    brands: normalizeGrantValues(input?.brands),
    productLines: normalizeGrantValues(input?.productLines),
    chipIds: normalizeGrantValues(input?.chipIds),
    documentIds: normalizeGrantValues(input?.documentIds),
    scopePresetIds: normalizeGrantValues(input?.scopePresetIds),
    modelIds: normalizeModelGrantValues(input?.modelIds),
    mcpTools: normalizeGrantValues(input?.mcpTools)
  };
}

export function mapAllowedChipsToResourceGrants(allowedChips: readonly string[] | undefined): ResourceGrantInput {
  return { chipIds: normalizeGrantValues(allowedChips) };
}

export function computeEffectiveAuthorizationSummary(
  subject: AuthorizationSubject,
  now: Date = new Date(),
  options: ComputeEffectiveAuthorizationOptions = {}
): EffectiveAuthorizationSummary {
  const template = getRoleAuthorizationTemplate(subject.user.role);
  const lifecycleReason = getLifecycleReason(subject, now);
  const roleGrants = normalizeResourceGrantSet(subject.roleGrants);
  const userInputGrants = subject.user.grants;
  const userGrantsInput = normalizeResourceGrantSet(userInputGrants);
  const userBase = mergeGrantSets(
    template.defaultGrants,
    roleGrants,
    userGrantsInput
  );
  userBase.chipIds = resolveEffectiveChipGrants({
    template,
    roleGrants,
    userGrants: userGrantsInput,
    userInputGrants,
    mergedGrants: userBase,
    options
  });
  const userGrants: ResourceGrantSet = {
    ...userBase,
    modelIds: getEffectiveModelGrants({
      role: subject.user.role,
      userModelGrants: subject.user.modelGrants
    })
  };
  const grants = subject.key
    ? narrowGrantsForKey(userGrants, subject.key.grants, subject.key.modelGrants, subject.user.role, options)
    : userGrants;
  const reasonCode = lifecycleReason ?? 'allowed';

  return {
    subject: {
      userId: subject.user.id,
      ...(subject.user.username ? { username: subject.user.username } : {}),
      role: subject.user.role,
      ...(subject.key?.id ? { keyId: subject.key.id } : {}),
      ...(subject.key?.fingerprint ? { keyFingerprint: subject.key.fingerprint } : {})
    },
    usable: reasonCode === 'allowed',
    reasonCode,
    safeMessage: getSafeAuthorizationMessage(reasonCode),
    visibilityCeiling: template.visibilityCeiling,
    grants,
    audit: {
      userId: subject.user.id,
      role: subject.user.role,
      ...(subject.key?.id ? { keyId: subject.key.id } : {}),
      ...(subject.key?.fingerprint ? { keyFingerprint: subject.key.fingerprint } : {}),
      reasonCode
    }
  };
}

function resolveEffectiveChipGrants(input: {
  template: RoleAuthorizationTemplate;
  roleGrants: ResourceGrantSet;
  userGrants: ResourceGrantSet;
  userInputGrants: ResourceGrantInput | undefined;
  mergedGrants: ResourceGrantSet;
  options: ComputeEffectiveAuthorizationOptions;
}): GrantValue[] {
  if (input.template.role === 'admin') {
    return [...input.template.defaultGrants.chipIds];
  }
  if (hasOwnGrantField(input.userInputGrants, 'chipIds')) {
    return [...input.userGrants.chipIds];
  }
  const inheritedChipIds = mergeGrantValues([input.template.defaultGrants.chipIds, input.roleGrants.chipIds]);
  const derivationInput: ResourceGrantSet = {
    ...input.mergedGrants,
    chipIds: inheritedChipIds
  };
  const derivedChipIds = normalizeGrantValues(input.options.deriveChipIds?.(derivationInput));
  return mergeGrantValues([inheritedChipIds, derivedChipIds]);
}

export function authorizeResourceAccess(
  summaryOrSubject: EffectiveAuthorizationSummary | AuthorizationSubject,
  resource: AuthorizationResource,
  now: Date = new Date()
): AuthorizationDecision {
  const summary = isEffectiveSummary(summaryOrSubject)
    ? summaryOrSubject
    : computeEffectiveAuthorizationSummary(summaryOrSubject, now);
  if (!summary.usable) {
    return deny(summary, resource, summary.reasonCode);
  }

  if (resource.visibility && !canReadVisibility(summary.visibilityCeiling, resource.visibility)) {
    return deny(summary, resource, 'visibility_denied');
  }

  const requiredGrantDecision = authorizeRequiredGrants(summary, resource);
  if (requiredGrantDecision) {
    return requiredGrantDecision;
  }

  const field = GRANT_FIELD_BY_RESOURCE_TYPE[resource.type];
  if (!field) {
    return deny(summary, resource, 'unknown_resource_type');
  }
  const grants = summary.grants[field];
  const allowed = grants.includes('*') || grants.includes(resource.id as ModelId);
  if (!allowed) {
    return deny(summary, resource, resource.type === 'model' ? 'model_not_granted' : 'resource_not_granted');
  }

  return {
    allowed: true,
    reasonCode: 'allowed',
    safeMessage: getSafeAuthorizationMessage('allowed'),
    audit: {
      ...summary.audit,
      resourceType: resource.type,
      ...(resource.visibility ? { visibility: resource.visibility } : {}),
      reasonCode: 'allowed'
    },
    matchedGrants: grants.includes('*') ? ['*'] : [resource.id]
  };
}

function authorizeRequiredGrants(
  summary: EffectiveAuthorizationSummary,
  resource: AuthorizationResource
): AuthorizationDecision | undefined {
  const requiredGrants = normalizeResourceGrantSet(resource.requiredGrants);
  for (const [resourceType, field] of Object.entries(GRANT_FIELD_BY_RESOURCE_TYPE) as Array<
    [AuthorizationResourceType, keyof ResourceGrantSet]
  >) {
    const requiredValues = requiredGrants[field];
    if (requiredValues.length === 0) {
      continue;
    }
    const grantedValues = summary.grants[field];
    if (!hasRequiredGrant(grantedValues, requiredValues)) {
      return deny(summary, { ...resource, type: resourceType }, resourceType === 'model' ? 'model_not_granted' : 'resource_not_granted');
    }
  }
  return undefined;
}

function hasRequiredGrant(grantedValues: GrantValue[], requiredValues: GrantValue[]): boolean {
  if (grantedValues.includes('*')) {
    return true;
  }
  if (requiredValues.includes('*')) {
    return grantedValues.includes('*');
  }
  return requiredValues.some((value) => grantedValues.includes(value));
}

export function canReadVisibility(ceiling: DocumentVisibility, visibility: DocumentVisibility): boolean {
  return VISIBILITY_RANK[visibility] <= VISIBILITY_RANK[ceiling];
}

function narrowGrantsForKey(
  userGrants: ResourceGrantSet,
  keyGrants: ResourceGrantInput | undefined,
  keyModelGrants: readonly string[] | null | undefined,
  role: string,
  options: ComputeEffectiveAuthorizationOptions
): ResourceGrantSet {
  const normalizedKeyGrants = normalizeResourceGrantSet(keyGrants);
  const chipIds = narrowChipGrantsForKey(userGrants, normalizedKeyGrants, keyGrants, options);
  return {
    brands: intersectIfKeyGrantPresent(userGrants.brands, normalizedKeyGrants.brands, keyGrants?.brands),
    productLines: intersectIfKeyGrantPresent(userGrants.productLines, normalizedKeyGrants.productLines, keyGrants?.productLines),
    chipIds,
    documentIds: intersectIfKeyGrantPresent(userGrants.documentIds, normalizedKeyGrants.documentIds, keyGrants?.documentIds),
    scopePresetIds: intersectIfKeyGrantPresent(
      userGrants.scopePresetIds,
      normalizedKeyGrants.scopePresetIds,
      keyGrants?.scopePresetIds
    ),
    modelIds:
      keyModelGrants === undefined || keyModelGrants === null
        ? userGrants.modelIds
        : getEffectiveModelGrants({
            role,
            userModelGrants: userGrants.modelIds.filter((modelId): modelId is ModelId => modelId !== '*'),
            mcpKeyModelGrants: keyModelGrants
          }),
    mcpTools: intersectIfKeyGrantPresent(userGrants.mcpTools, normalizedKeyGrants.mcpTools, keyGrants?.mcpTools)
  };
}

function narrowChipGrantsForKey(
  userGrants: ResourceGrantSet,
  normalizedKeyGrants: ResourceGrantSet,
  keyGrants: ResourceGrantInput | undefined,
  options: ComputeEffectiveAuthorizationOptions
): GrantValue[] {
  if (keyGrants?.chipIds !== undefined) {
    return intersectGrantValues(userGrants.chipIds, normalizedKeyGrants.chipIds);
  }
  if (keyGrants?.brands === undefined && keyGrants?.productLines === undefined) {
    return userGrants.chipIds;
  }
  const derivedKeyChipIds = normalizeGrantValues(options.deriveChipIds?.({
    ...normalizedKeyGrants,
    chipIds: []
  }));
  return intersectGrantValues(userGrants.chipIds, derivedKeyChipIds);
}

function mergeGrantSets(...sets: ResourceGrantSet[]): ResourceGrantSet {
  return {
    brands: mergeGrantValues(sets.map((set) => set.brands)),
    productLines: mergeGrantValues(sets.map((set) => set.productLines)),
    chipIds: mergeGrantValues(sets.map((set) => set.chipIds)),
    documentIds: mergeGrantValues(sets.map((set) => set.documentIds)),
    scopePresetIds: mergeGrantValues(sets.map((set) => set.scopePresetIds)),
    modelIds: mergeGrantValues(sets.map((set) => set.modelIds)) as Array<ModelId | '*'>,
    mcpTools: mergeGrantValues(sets.map((set) => set.mcpTools))
  };
}

function intersectIfKeyGrantPresent<T extends GrantValue>(
  userValues: T[],
  keyValues: T[],
  originalKeyValues: readonly T[] | undefined
): T[] {
  if (originalKeyValues === undefined) {
    return userValues;
  }
  return intersectGrantValues(userValues, keyValues);
}

function intersectGrantValues<T extends GrantValue>(left: T[], right: T[]): T[] {
  if (left.includes('*' as T)) {
    return right;
  }
  if (right.includes('*' as T)) {
    return left;
  }
  return left.filter((value) => right.includes(value));
}

function hasOwnGrantField(input: ResourceGrantInput | undefined, field: keyof ResourceGrantSet): boolean {
  return input !== undefined && Object.prototype.hasOwnProperty.call(input, field);
}

function mergeGrantValues<T extends GrantValue>(sets: T[][]): T[] {
  const merged: T[] = [];
  for (const set of sets) {
    for (const value of set) {
      if (value === '*') {
        return ['*' as T];
      }
      if (!merged.includes(value)) {
        merged.push(value);
      }
    }
  }
  return merged;
}

function normalizeGrantValues(values: readonly string[] | undefined): GrantValue[] {
  if (!values) {
    return [];
  }
  const normalized: GrantValue[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const grant = trimmed === '*' ? '*' : trimmed;
    if (!normalized.includes(grant)) {
      normalized.push(grant);
    }
  }
  return normalized;
}

function normalizeModelGrantValues(values: readonly string[] | undefined): Array<ModelId | '*'> {
  if (!values) {
    return [];
  }
  const normalized: Array<ModelId | '*'> = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === '*') {
      return ['*'];
    }
    if (isModelId(trimmed) && !normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function getLifecycleReason(subject: AuthorizationSubject, now: Date): AuthorizationReasonCode | undefined {
  if (subject.user.status === 'disabled') {
    return 'user_disabled';
  }
  const userExpiry = parseExpiry(subject.user.expiresAt);
  if (userExpiry.invalid) {
    return 'invalid_expiry';
  }
  if (userExpiry.value !== undefined && userExpiry.value < now.getTime()) {
    return 'user_expired';
  }
  const keyExpiry = parseExpiry(subject.key?.expiresAt);
  if (keyExpiry.invalid) {
    return 'invalid_expiry';
  }
  if (keyExpiry.value !== undefined && keyExpiry.value < now.getTime()) {
    return 'mcp_key_expired';
  }
  return undefined;
}

function parseExpiry(value: string | undefined): { value?: number; invalid?: true } {
  if (value === undefined) {
    return {};
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { value: parsed } : { invalid: true };
}

function wildcardGrants(): ResourceGrantSet {
  return {
    brands: ['*'],
    productLines: ['*'],
    chipIds: ['*'],
    documentIds: ['*'],
    scopePresetIds: ['*'],
    modelIds: ['*'],
    mcpTools: ['*']
  };
}

function normalizeRole(role: string | undefined): BuiltInAuthorizationRole {
  const normalized = (role ?? '').trim().toLowerCase();
  if (normalized === 'admin' || normalized === 'internal' || normalized === 'partner' || normalized === 'public') {
    return normalized;
  }
  return 'customer';
}

function isEffectiveSummary(value: EffectiveAuthorizationSummary | AuthorizationSubject): value is EffectiveAuthorizationSummary {
  return 'grants' in value && 'visibilityCeiling' in value && 'audit' in value;
}

function deny(
  summary: EffectiveAuthorizationSummary,
  resource: AuthorizationResource,
  reasonCode: AuthorizationReasonCode
): AuthorizationDecision {
  return {
    allowed: false,
    reasonCode,
    safeMessage: getSafeAuthorizationMessage(reasonCode),
    audit: {
      ...summary.audit,
      resourceType: resource.type,
      ...(resource.visibility ? { visibility: resource.visibility } : {}),
      reasonCode
    },
    matchedGrants: []
  };
}
