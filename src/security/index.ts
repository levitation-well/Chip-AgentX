export {
  ROLE_AUTHORIZATION_TEMPLATES,
  authorizeResourceAccess,
  canReadVisibility,
  computeEffectiveAuthorizationSummary,
  getRoleAuthorizationTemplate,
  mapAllowedChipsToResourceGrants,
  normalizeResourceGrantSet
} from './authorization.js';
export { getSafeAuthorizationMessage, redactAuthorizationMetadata } from './safe-errors.js';
export {
  canSummarizeVisibility,
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  normalizeDocumentVisibilityContract,
  normalizeScopePresetContract,
  toSafeDocumentSummary,
  toSafeScopePresetSummary
} from './document-visibility.js';
export {
  findDocumentContract,
  findScopePresetContract,
  listVisibleResourceSummaries,
  loadResourceVisibilityCatalogFromFile,
  parseResourceVisibilityCatalog,
  removeChipIdsFromResourceCatalog,
  serializeResourceVisibilityCatalog,
  writeResourceVisibilityCatalogToFile
} from './resource-catalog.js';
export type {
  AuthorizationDecision,
  AuthorizationReasonCode,
  AuthorizationResource,
  AuthorizationResourceType,
  AuthorizationSubject,
  AuthorizationSubjectMcpKey,
  AuthorizationSubjectUser,
  BuiltInAuthorizationRole,
  DocumentVisibility,
  EffectiveAuthorizationSummary,
  ResourceGrantInput,
  ResourceGrantSet,
  RoleAuthorizationTemplate,
  ScopePresetVisibility
} from './types.js';
export type {
  DocumentVisibilityContract,
  ResourceReviewAudit,
  ResourceReviewStatus,
  SafeDocumentSummary,
  SafeResourceVisibilitySummary,
  SafeScopePresetSummary,
  ScopePresetContract
} from './document-visibility.js';
export type { ResourceVisibilityCatalog, ResourceVisibilityCatalogInput } from './resource-catalog.js';
