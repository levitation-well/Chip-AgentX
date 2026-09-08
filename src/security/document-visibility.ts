import { authorizeResourceAccess, canReadVisibility } from './authorization.js';
import { getSafeAuthorizationMessage } from './safe-errors.js';
import type {
  AuthorizationDecision,
  DocumentVisibility,
  EffectiveAuthorizationSummary,
  ResourceGrantInput,
  ScopePresetVisibility
} from './types.js';

export type ResourceReviewStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'archived' | 'disabled';

/**
 * Review/approval audit fields shared by document and scope-preset contracts.
 * All optional and backward-compatible: legacy JSON without these still parses,
 * and normalize* leaves missing fields as `undefined`. These are admin-only
 * provenance metadata and MUST NOT leak into Safe*Summary views.
 */
export interface ResourceReviewAudit {
  requestedBy?: string;
  requestedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalNotes?: string;
}

export interface DocumentVisibilityContract extends ResourceReviewAudit {
  documentId: string;
  label: string;
  visibility: DocumentVisibility;
  status: ResourceReviewStatus;
  brands: string[];
  productLines: string[];
  applicationTags: string[];
  chipIds: string[];
  requiredGrants: ResourceGrantInput;
  sourceLabels: string[];
}

export interface ScopePresetContract extends ResourceReviewAudit {
  scopePresetId: string;
  label: string;
  visibility: ScopePresetVisibility;
  status: ResourceReviewStatus;
  brands: string[];
  productLines: string[];
  applicationTags: string[];
  chipIds: string[];
  documentIds: string[];
  requiredGrants: ResourceGrantInput;
  sourceLabels: string[];
}

export interface SafeDocumentSummary {
  type: 'document';
  id: string;
  label: string;
  visibility: DocumentVisibility;
  brands: string[];
  productLines: string[];
  applicationTags: string[];
  chipIds: string[];
  sourceLabels: string[];
}

export interface SafeScopePresetSummary {
  type: 'scopePreset';
  id: string;
  label: string;
  visibility: ScopePresetVisibility;
  brands: string[];
  productLines: string[];
  applicationTags: string[];
  chipIds: string[];
  documentIds: string[];
  sourceLabels: string[];
}

export type SafeResourceVisibilitySummary = SafeDocumentSummary | SafeScopePresetSummary;

export function normalizeDocumentVisibilityContract(input: unknown): DocumentVisibilityContract {
  const record = asRecord(input);
  const documentId = normalizeRequiredId(record.documentId, 'documentId');
  const visibility = normalizeVisibility(record.visibility);
  const brands = normalizeStringList(record.brands ?? record.brand);
  const productLines = normalizeStringList(record.productLines ?? record.productLine);
  const chipIds = normalizeStringList(record.chipIds ?? record.chipId);
  return {
    documentId,
    label: normalizeLabel(record.label ?? record.title ?? record.name, documentId),
    visibility,
    status: normalizeReviewStatus(record.status),
    brands,
    productLines,
    applicationTags: normalizeStringList(record.applicationTags ?? record.applications ?? record.application),
    chipIds,
    requiredGrants: normalizeRequiredGrants(record.requiredGrants, {
      documentIds: visibility === 'public' ? [] : [documentId]
    }),
    sourceLabels: normalizeStringList(record.sourceLabels ?? record.sourceLabel),
    ...normalizeReviewAudit(record)
  };
}

export function normalizeScopePresetContract(input: unknown): ScopePresetContract {
  const record = asRecord(input);
  const scopePresetId = normalizeRequiredId(record.scopePresetId, 'scopePresetId');
  const visibility = normalizeVisibility(record.visibility);
  return {
    scopePresetId,
    label: normalizeLabel(record.label ?? record.title ?? record.name, scopePresetId),
    visibility,
    status: normalizeReviewStatus(record.status),
    brands: normalizeStringList(record.brands ?? record.brand),
    productLines: normalizeStringList(record.productLines ?? record.productLine),
    applicationTags: normalizeStringList(record.applicationTags ?? record.applications ?? record.application),
    chipIds: normalizeStringList(record.chipIds ?? record.chipId),
    documentIds: normalizeStringList(record.documentIds ?? record.documentId),
    requiredGrants: normalizeRequiredGrants(record.requiredGrants, {
      scopePresetIds: visibility === 'public' ? [] : [scopePresetId]
    }),
    sourceLabels: normalizeStringList(record.sourceLabels ?? record.sourceLabel),
    ...normalizeReviewAudit(record)
  };
}

export function evaluateDocumentVisibility(
  summary: EffectiveAuthorizationSummary,
  document: DocumentVisibilityContract
): AuthorizationDecision {
  if (document.status !== 'approved') {
    return authorizeResourceAccess(summary, {
      type: 'document',
      id: document.documentId,
      visibility: 'adminOnly'
    });
  }
  if (document.visibility === 'public' && summary.usable && canReadVisibility(summary.visibilityCeiling, 'public')) {
    return allowPublic(summary, 'document', document.documentId, 'public');
  }
  return authorizeResourceAccess(summary, {
    type: 'document',
    id: document.documentId,
    visibility: document.visibility,
    requiredGrants: document.requiredGrants
  });
}

export function evaluateScopePresetVisibility(
  summary: EffectiveAuthorizationSummary,
  scopePreset: ScopePresetContract
): AuthorizationDecision {
  if (scopePreset.status !== 'approved') {
    return authorizeResourceAccess(summary, {
      type: 'scopePreset',
      id: scopePreset.scopePresetId,
      visibility: 'adminOnly'
    });
  }
  if (scopePreset.visibility === 'public' && summary.usable && canReadVisibility(summary.visibilityCeiling, 'public')) {
    return allowPublic(summary, 'scopePreset', scopePreset.scopePresetId, 'public');
  }
  return authorizeResourceAccess(summary, {
    type: 'scopePreset',
    id: scopePreset.scopePresetId,
    visibility: scopePreset.visibility,
    requiredGrants: scopePreset.requiredGrants
  });
}

function allowPublic(
  summary: EffectiveAuthorizationSummary,
  resourceType: 'document' | 'scopePreset',
  id: string,
  visibility: DocumentVisibility
): AuthorizationDecision {
  return {
    allowed: true,
    reasonCode: 'allowed',
    safeMessage: getSafeAuthorizationMessage('allowed'),
    audit: {
      ...summary.audit,
      resourceType,
      visibility,
      reasonCode: 'allowed'
    },
    matchedGrants: [id]
  };
}

export function toSafeDocumentSummary(document: DocumentVisibilityContract): SafeDocumentSummary {
  return {
    type: 'document',
    id: document.documentId,
    label: document.label,
    visibility: document.visibility,
    brands: [...document.brands],
    productLines: [...document.productLines],
    applicationTags: [...document.applicationTags],
    chipIds: [...document.chipIds],
    sourceLabels: [...document.sourceLabels]
  };
}

export function toSafeScopePresetSummary(scopePreset: ScopePresetContract): SafeScopePresetSummary {
  return {
    type: 'scopePreset',
    id: scopePreset.scopePresetId,
    label: scopePreset.label,
    visibility: scopePreset.visibility,
    brands: [...scopePreset.brands],
    productLines: [...scopePreset.productLines],
    applicationTags: [...scopePreset.applicationTags],
    chipIds: [...scopePreset.chipIds],
    documentIds: [...scopePreset.documentIds],
    sourceLabels: [...scopePreset.sourceLabels]
  };
}

export function canSummarizeVisibility(summary: EffectiveAuthorizationSummary, visibility: DocumentVisibility): boolean {
  return summary.usable && canReadVisibility(summary.visibilityCeiling, visibility);
}

/**
 * Preserve optional review/audit fields when present. Missing fields are omitted
 * entirely (not set to `undefined`) so that deep-equality round-trips stay clean
 * and legacy JSON without audit fields normalizes to the same shape it serializes back to.
 */
function normalizeReviewAudit(record: Record<string, unknown>): ResourceReviewAudit {
  const audit: ResourceReviewAudit = {};
  const requestedBy = normalizeOptionalText(record.requestedBy);
  if (requestedBy !== undefined) {
    audit.requestedBy = requestedBy;
  }
  const requestedAt = normalizeOptionalText(record.requestedAt);
  if (requestedAt !== undefined) {
    audit.requestedAt = requestedAt;
  }
  const approvedBy = normalizeOptionalText(record.approvedBy);
  if (approvedBy !== undefined) {
    audit.approvedBy = approvedBy;
  }
  const approvedAt = normalizeOptionalText(record.approvedAt);
  if (approvedAt !== undefined) {
    audit.approvedAt = approvedAt;
  }
  const approvalNotes = normalizeOptionalText(record.approvalNotes);
  if (approvalNotes !== undefined) {
    audit.approvalNotes = approvalNotes;
  }
  return audit;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeRequiredGrants(input: unknown, fallback: ResourceGrantInput): ResourceGrantInput {
  if (!isRecord(input)) {
    return fallback;
  }
  return {
    brands: normalizeStringList(input.brands),
    productLines: normalizeStringList(input.productLines),
    chipIds: normalizeStringList(input.chipIds),
    documentIds: normalizeStringList(input.documentIds),
    scopePresetIds: normalizeStringList(input.scopePresetIds),
    modelIds: normalizeStringList(input.modelIds) as ResourceGrantInput['modelIds'],
    mcpTools: normalizeStringList(input.mcpTools)
  };
}

function normalizeVisibility(value: unknown): DocumentVisibility {
  return value === 'public' ||
    value === 'customer' ||
    value === 'partner' ||
    value === 'internal' ||
    value === 'adminOnly' ||
    value === 'restricted'
    ? value
    : 'restricted';
}

function normalizeReviewStatus(value: unknown): ResourceReviewStatus {
  return value === 'draft' ||
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'archived' ||
    value === 'disabled'
    ? value
    : 'approved';
}

function normalizeRequiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function normalizeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed && !isPathLike(trimmed) ? trimmed : fallback;
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const normalized: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || isPathLike(trimmed) || normalized.includes(trimmed)) {
      continue;
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function isPathLike(value: string): boolean {
  return /^[a-z]:\\/i.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.includes('\\');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('resource visibility entry must be an object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
