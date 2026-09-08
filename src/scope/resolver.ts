import {
  authorizeResourceAccess,
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  findDocumentContract,
  getSafeAuthorizationMessage,
  type AuthorizationDecision,
  type AuthorizationReasonCode,
  type EffectiveAuthorizationSummary,
  type ResourceGrantInput,
  type ResourceVisibilityCatalog,
  type ScopePresetContract
} from '../security/index.js';
import type { CatalogMetadataFoundation, ScopeCatalogFoundation } from './types.js';

export interface PresetReferenceValidation {
  /** documentIds referenced by the preset that do not resolve to any catalog document. */
  missingDocumentIds: string[];
  /**
   * chipIds referenced by the preset that are not declared by any catalog document
   * (neither directly nor through the preset's referenced documents).
   */
  missingChipIds: string[];
  hasOrphans: boolean;
}

/**
 * Surface orphan references inside a scope preset against a resource catalog.
 *
 * Previously the resolver silently fell back to the generic authorize path when a
 * preset referenced a documentId absent from the catalog, masking misconfiguration.
 * This reports those orphans (missing documentIds + chipIds) without changing the
 * allow/deny semantics for references that DO resolve.
 *
 * A chipId is considered resolved when it is declared by any catalog document
 * (so a chip covered only via a referenced document is not flagged as an orphan).
 */
export function validatePresetReferences(
  preset: ScopePresetContract,
  catalog: ScopeCatalogFoundation | ResourceVisibilityCatalog
): PresetReferenceValidation {
  const resources = getResourceCatalog(catalog);
  const knownChipIds = new Set<string>();
  for (const document of resources.documents) {
    for (const chipId of document.chipIds) {
      knownChipIds.add(chipId);
    }
  }

  const missingDocumentIds = uniqueStrings(
    preset.documentIds.filter((documentId) => !findDocumentContract(resources, documentId))
  );
  const missingChipIds = uniqueStrings(preset.chipIds.filter((chipId) => !knownChipIds.has(chipId)));

  return {
    missingDocumentIds,
    missingChipIds,
    hasOrphans: missingDocumentIds.length > 0 || missingChipIds.length > 0
  };
}

export type ScopeResolverEntryPoint = 'web' | 'mcp' | 'admin' | 'test';
export type ScopeSelectionStatus = 'allowed' | 'denied';
export type ScopeWorkspaceModeCandidate = 'none' | 'pendingWorkspace';

export interface ResolveScopeSelectionInput {
  authorization: EffectiveAuthorizationSummary;
  catalog: ScopeCatalogFoundation | ResourceVisibilityCatalog;
  scopePresetId?: string;
  brand?: string;
  productLine?: string;
  application?: string;
  chipId?: string;
  documentId?: string;
  entryPoint?: ScopeResolverEntryPoint;
}

export interface ScopeDeniedReason {
  category:
    | 'invalid_request'
    | 'unknown_preset'
    | 'preset_not_approved'
    | 'preset_not_visible'
    | 'filter_out_of_preset'
    | 'covered_chip_denied'
    | 'covered_document_denied';
  reasonCode: AuthorizationReasonCode;
  count: number;
  resourceType?: 'scopePreset' | 'chip' | 'document';
  safeMessage: string;
}

export interface ScopeRequiredGrantCounts {
  brands: number;
  productLines: number;
  chipIds: number;
  documentIds: number;
  scopePresetIds: number;
}

export interface ScopeResolverAudit {
  entryPoint: ScopeResolverEntryPoint;
  userId: string;
  role: string;
  keyFingerprint?: string;
  scopePresetId?: string;
  reasonCode: AuthorizationReasonCode;
  requestedFilters: {
    brand?: string;
    productLine?: string;
    application?: string;
    chipId?: string;
    documentId?: string;
  };
  coveredChipCount: number;
  coveredDocumentCount: number;
  deniedCount: number;
  /**
   * Orphan references detected on the resolved preset (documentIds/chipIds not present in
   * the catalog). Surfaced for observability; does not change allow/deny semantics here.
   * Absent when no preset was resolved or no orphans were found.
   */
  orphanReferences?: PresetReferenceValidation;
}

export interface ScopeSelectionAllowed {
  status: 'allowed';
  scopeId: string;
  scopePresetId: string;
  filters: {
    brands: string[];
    productLines: string[];
    applications: string[];
    chipIds: string[];
    documentIds: string[];
  };
  allowedChipIds: string[];
  allowedDocumentIds: string[];
  deniedReasons: [];
  requiredGrants: ResourceGrantInput;
  requiredGrantCounts: ScopeRequiredGrantCounts;
  authorizationDecision: AuthorizationDecision;
  workspaceModeCandidate: 'pendingWorkspace';
  audit: ScopeResolverAudit;
}

export interface ScopeSelectionDenied {
  status: 'denied';
  scopeId?: undefined;
  scopePresetId?: string;
  filters: {
    brands: string[];
    productLines: string[];
    applications: string[];
    chipIds: string[];
    documentIds: string[];
  };
  allowedChipIds: [];
  allowedDocumentIds: [];
  deniedReasons: ScopeDeniedReason[];
  requiredGrants?: undefined;
  requiredGrantCounts: ScopeRequiredGrantCounts;
  authorizationDecision: AuthorizationDecision;
  workspaceModeCandidate: 'none';
  audit: ScopeResolverAudit;
}

export type ScopeSelection = ScopeSelectionAllowed | ScopeSelectionDenied;

const EMPTY_FILTERS = {
  brands: [],
  productLines: [],
  applications: [],
  chipIds: [],
  documentIds: []
};

export function resolveScopeSelection(input: ResolveScopeSelectionInput): ScopeSelection {
  const resources = getResourceCatalog(input.catalog);
  const metadata = getMetadata(input.catalog);
  const entryPoint = input.entryPoint ?? 'web';
  const requestedFilters = {
    ...(input.brand ? { brand: input.brand } : {}),
    ...(input.productLine ? { productLine: input.productLine } : {}),
    ...(input.application ? { application: input.application } : {}),
    ...(input.chipId ? { chipId: input.chipId } : {}),
    ...(input.documentId ? { documentId: input.documentId } : {})
  };

  if (!input.scopePresetId) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      category: 'invalid_request',
      reasonCode: 'resource_not_granted',
      requestedFilters,
      filters: EMPTY_FILTERS,
      requiredGrantCounts: emptyRequiredGrantCounts(),
      coveredChipCount: 0,
      coveredDocumentCount: 0
    });
  }

  const preset = resources.scopePresets.find((candidate) => candidate.scopePresetId === input.scopePresetId);
  if (!preset) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: input.scopePresetId,
      category: 'unknown_preset',
      reasonCode: 'resource_not_granted',
      requestedFilters,
      filters: EMPTY_FILTERS,
      requiredGrantCounts: emptyRequiredGrantCounts(),
      coveredChipCount: 0,
      coveredDocumentCount: 0
    });
  }

  const filters = getPresetFilters(preset);
  const coveredChipIds = uniqueStrings([...preset.chipIds, ...chipsForDocuments(resources, preset.documentIds)]);
  const coveredDocumentIds = uniqueStrings(preset.documentIds);
  // Surface orphan references (previously the resolver silently fell back for unknown
  // documentIds). This is observability only — allow/deny semantics are unchanged.
  const orphanReferences = validatePresetReferences(preset, resources);
  const requiredGrantCounts = getRequiredGrantCounts({
    brands: preset.brands,
    productLines: preset.productLines,
    chipIds: coveredChipIds,
    documentIds: coveredDocumentIds,
    scopePresetIds: [preset.scopePresetId]
  });
  const presetDecision = evaluateScopePresetVisibility(input.authorization, preset);

  if (preset.status !== 'approved') {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: preset.scopePresetId,
      category: 'preset_not_approved',
      reasonCode: presetDecision.reasonCode,
      requestedFilters,
      filters,
      requiredGrantCounts,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      authorizationDecision: presetDecision,
      orphanReferences
    });
  }

  if (!presetDecision.allowed) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: preset.scopePresetId,
      category: 'preset_not_visible',
      reasonCode: presetDecision.reasonCode,
      requestedFilters,
      filters,
      requiredGrantCounts,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      authorizationDecision: presetDecision,
      orphanReferences
    });
  }

  if (!filtersMatchPreset(input, preset, coveredChipIds, coveredDocumentIds, metadata)) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: preset.scopePresetId,
      category: 'filter_out_of_preset',
      reasonCode: 'resource_not_granted',
      requestedFilters,
      filters,
      requiredGrantCounts,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      authorizationDecision: presetDecision,
      orphanReferences
    });
  }

  const chipDecisions = coveredChipIds.map((chipId) => authorizeResourceAccess(input.authorization, { type: 'chip', id: chipId }));
  const deniedChipCount = chipDecisions.filter((decision) => !decision.allowed).length;
  if (deniedChipCount > 0) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: preset.scopePresetId,
      category: 'covered_chip_denied',
      reasonCode: firstDeniedReasonCode(chipDecisions),
      resourceType: 'chip',
      deniedCount: deniedChipCount,
      requestedFilters,
      filters,
      requiredGrantCounts,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      authorizationDecision: chipDecisions.find((decision) => !decision.allowed) ?? presetDecision,
      orphanReferences
    });
  }

  const documentDecisions = coveredDocumentIds.map((documentId) => {
    const document = findDocumentContract(resources, documentId);
    return document
      ? evaluateDocumentVisibility(input.authorization, document)
      : authorizeResourceAccess(input.authorization, { type: 'document', id: documentId });
  });
  const deniedDocumentCount = documentDecisions.filter((decision) => !decision.allowed).length;
  if (deniedDocumentCount > 0) {
    return denySelection({
      summary: input.authorization,
      entryPoint,
      scopePresetId: preset.scopePresetId,
      category: 'covered_document_denied',
      reasonCode: firstDeniedReasonCode(documentDecisions),
      resourceType: 'document',
      deniedCount: deniedDocumentCount,
      requestedFilters,
      filters,
      requiredGrantCounts,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      authorizationDecision: documentDecisions.find((decision) => !decision.allowed) ?? presetDecision,
      orphanReferences
    });
  }

  return {
    status: 'allowed',
    scopeId: createScopeId(preset.scopePresetId, filters),
    scopePresetId: preset.scopePresetId,
    filters,
    allowedChipIds: coveredChipIds,
    allowedDocumentIds: coveredDocumentIds,
    deniedReasons: [],
    requiredGrants: {
      brands: uniqueStrings(preset.brands),
      productLines: uniqueStrings(preset.productLines),
      chipIds: coveredChipIds,
      documentIds: coveredDocumentIds,
      scopePresetIds: [preset.scopePresetId]
    },
    requiredGrantCounts,
    authorizationDecision: presetDecision,
    workspaceModeCandidate: 'pendingWorkspace',
    audit: {
      entryPoint,
      userId: input.authorization.audit.userId,
      role: input.authorization.audit.role,
      ...(input.authorization.audit.keyFingerprint ? { keyFingerprint: input.authorization.audit.keyFingerprint } : {}),
      scopePresetId: preset.scopePresetId,
      reasonCode: 'allowed',
      requestedFilters,
      coveredChipCount: coveredChipIds.length,
      coveredDocumentCount: coveredDocumentIds.length,
      deniedCount: 0,
      ...(orphanReferences.hasOrphans ? { orphanReferences } : {})
    }
  };
}

function denySelection(input: {
  summary: EffectiveAuthorizationSummary;
  entryPoint: ScopeResolverEntryPoint;
  scopePresetId?: string;
  category: ScopeDeniedReason['category'];
  reasonCode: AuthorizationReasonCode;
  resourceType?: ScopeDeniedReason['resourceType'];
  deniedCount?: number;
  requestedFilters: ScopeResolverAudit['requestedFilters'];
  filters: ScopeSelectionDenied['filters'];
  requiredGrantCounts: ScopeRequiredGrantCounts;
  coveredChipCount: number;
  coveredDocumentCount: number;
  authorizationDecision?: AuthorizationDecision;
  orphanReferences?: PresetReferenceValidation;
}): ScopeSelectionDenied {
  const decision =
    input.authorizationDecision && !input.authorizationDecision.allowed
      ? input.authorizationDecision
      : createDeniedAuthorizationDecision(input.summary, input.resourceType ?? 'scopePreset', input.reasonCode);
  const deniedCount = input.deniedCount ?? 1;
  return {
    status: 'denied',
    ...(input.scopePresetId ? { scopePresetId: input.scopePresetId } : {}),
    filters: {
      brands: input.filters.brands,
      productLines: input.filters.productLines,
      applications: input.filters.applications,
      chipIds: [],
      documentIds: []
    },
    allowedChipIds: [],
    allowedDocumentIds: [],
    deniedReasons: [
      {
        category: input.category,
        reasonCode: input.reasonCode,
        count: deniedCount,
        ...(input.resourceType ? { resourceType: input.resourceType } : {}),
        safeMessage: getSafeAuthorizationMessage(input.reasonCode)
      }
    ],
    requiredGrantCounts: input.requiredGrantCounts,
    authorizationDecision: decision,
    workspaceModeCandidate: 'none',
    audit: {
      entryPoint: input.entryPoint,
      userId: input.summary.audit.userId,
      role: input.summary.audit.role,
      ...(input.summary.audit.keyFingerprint ? { keyFingerprint: input.summary.audit.keyFingerprint } : {}),
      ...(input.scopePresetId ? { scopePresetId: input.scopePresetId } : {}),
      reasonCode: input.reasonCode,
      requestedFilters: input.requestedFilters,
      coveredChipCount: input.coveredChipCount,
      coveredDocumentCount: input.coveredDocumentCount,
      deniedCount,
      ...(input.orphanReferences?.hasOrphans ? { orphanReferences: input.orphanReferences } : {})
    }
  };
}

function createDeniedAuthorizationDecision(
  summary: EffectiveAuthorizationSummary,
  resourceType: 'scopePreset' | 'chip' | 'document',
  reasonCode: AuthorizationReasonCode
): AuthorizationDecision {
  return {
    allowed: false,
    reasonCode,
    safeMessage: getSafeAuthorizationMessage(reasonCode),
    audit: {
      ...summary.audit,
      resourceType,
      reasonCode
    },
    matchedGrants: []
  };
}

function getResourceCatalog(catalog: ScopeCatalogFoundation | ResourceVisibilityCatalog): ResourceVisibilityCatalog {
  return 'resources' in catalog ? catalog.resources : catalog;
}

function getMetadata(catalog: ScopeCatalogFoundation | ResourceVisibilityCatalog): CatalogMetadataFoundation | undefined {
  return 'metadata' in catalog ? catalog.metadata : undefined;
}

function getPresetFilters(preset: ScopePresetContract): ScopeSelectionAllowed['filters'] {
  return {
    brands: uniqueStrings(preset.brands),
    productLines: uniqueStrings(preset.productLines),
    applications: uniqueStrings(preset.applicationTags),
    chipIds: uniqueStrings(preset.chipIds),
    documentIds: uniqueStrings(preset.documentIds)
  };
}

function filtersMatchPreset(
  input: ResolveScopeSelectionInput,
  preset: ScopePresetContract,
  coveredChipIds: string[],
  coveredDocumentIds: string[],
  metadata: CatalogMetadataFoundation | undefined
): boolean {
  if (input.brand && !preset.brands.includes(input.brand)) {
    return false;
  }
  if (input.productLine && !preset.productLines.includes(input.productLine)) {
    return false;
  }
  if (input.application && !preset.applicationTags.includes(input.application)) {
    return false;
  }
  if (input.chipId && !coveredChipIds.includes(input.chipId)) {
    return false;
  }
  if (input.documentId && !coveredDocumentIds.includes(input.documentId)) {
    return false;
  }
  if (!metadata) {
    return true;
  }
  return coveredChipIds.every((chipId) => metadata.chips.some((chip) => chip.id === chipId));
}

function chipsForDocuments(resources: ResourceVisibilityCatalog, documentIds: string[]): string[] {
  const chips: string[] = [];
  for (const documentId of documentIds) {
    const document = findDocumentContract(resources, documentId);
    if (document) {
      chips.push(...document.chipIds);
    }
  }
  return uniqueStrings(chips);
}

function firstDeniedReasonCode(decisions: AuthorizationDecision[]): AuthorizationReasonCode {
  return decisions.find((decision) => !decision.allowed)?.reasonCode ?? 'resource_not_granted';
}

function getRequiredGrantCounts(input: {
  brands: string[];
  productLines: string[];
  chipIds: string[];
  documentIds: string[];
  scopePresetIds: string[];
}): ScopeRequiredGrantCounts {
  return {
    brands: uniqueStrings(input.brands).length,
    productLines: uniqueStrings(input.productLines).length,
    chipIds: uniqueStrings(input.chipIds).length,
    documentIds: uniqueStrings(input.documentIds).length,
    scopePresetIds: uniqueStrings(input.scopePresetIds).length
  };
}

function emptyRequiredGrantCounts(): ScopeRequiredGrantCounts {
  return {
    brands: 0,
    productLines: 0,
    chipIds: 0,
    documentIds: 0,
    scopePresetIds: 0
  };
}

function createScopeId(scopePresetId: string, filters: ScopeSelectionAllowed['filters']): string {
  const suffix = [
    ...filters.brands,
    ...filters.productLines,
    ...filters.applications,
    ...filters.chipIds,
    ...filters.documentIds
  ]
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return suffix ? `${scopePresetId}:${suffix}` : scopePresetId;
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}
