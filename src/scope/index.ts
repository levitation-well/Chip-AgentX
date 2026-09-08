export { createDefaultElmosScopeSeed, parseScopeCatalogFoundation } from './catalog.js';
export { createLiveTwoStageDeps } from './two-stage-live.js';
export type { LiveTwoStageDeps, LiveTwoStageDepsOptions } from './two-stage-live.js';
export { runScopeQueryLarge } from './run-scope-query.js';
export type { RunScopeQueryLargeOptions } from './run-scope-query.js';
export { buildScopeIndex, parseCandidateChipIds, parseCandidateChipIdsDetailed, reauthorizeCandidates } from './index-retrieval.js';
export type { CandidateParseResult, ScopeIndexRow, ReauthorizeResult } from './index-retrieval.js';
export { runTwoStageDiscovery, DEFAULT_STAGE1_CANDIDATE_LIMIT } from './two-stage.js';
export type { TwoStageDeps, TwoStageResult } from './two-stage.js';
export { decideScopeScale, DEFAULT_SCOPE_SMALL_THRESHOLD, ScopeTooLargeError } from './scale.js';
export type { ScopeScaleDecision } from './scale.js';
export { prepareChipLaunch, scopeLaunchHardening } from './chip-launch.js';
export type { ChipLaunchHardening } from './chip-launch.js';
export { InvalidChipWorkspaceTargetError, materializeChipWorkspace, validateHistoricalChipWorkspaceTarget } from './chip-workspace.js';
export type { MaterializedChipWorkspace } from './chip-workspace.js';
export { resolveScopeSelection, validatePresetReferences } from './resolver.js';
export type { PresetReferenceValidation } from './resolver.js';
export { chipIdsForGroupGrants } from './group-grants.js';
export type { GroupGrantInput } from './group-grants.js';
export { cleanupScopeWorkspace, isPathInsideOrEqual, sweepExpiredScopeWorkspaces } from './workspace-cleanup.js';
export {
  materializeScopeWorkspace,
  probeReadOnlyLinkSupport,
  readScopeWorkspaceSafeManifest
} from './workspace.js';
export { sanitizeWorkspaceFileName, toSafeWorkspaceDto } from './workspace-redaction.js';
export { buildSafeScopeSessionSummary, scopeOutputContractInstructions } from './answer-contract.js';
export { createScopeShards } from './sharding.js';
export { prepareScopeSession, prepareDynamicScopeSession, ScopeSessionDeniedError } from './query-runner.js';
export type { PrepareDynamicScopeSessionInput } from './query-runner.js';
export {
  assertNoUnsafeSourceCitationFields,
  createSourceCitationSummary,
  createUsedSourceRecord,
  toPublicSourceCitationDto
} from '../source-citations/index.js';
export type {
  ApplicationMetadata,
  BrandMetadata,
  CatalogMetadataFoundation,
  CatalogMetadataStatus,
  ProductLineMetadata,
  ScopeCatalogDocument,
  ScopeCatalogFoundation,
  ScopeCatalogInput,
  ScopeCatalogPreset
} from './types.js';
export type {
  ResolveScopeSelectionInput,
  ScopeDeniedReason,
  ScopeResolverAudit,
  ScopeResolverEntryPoint,
  ScopeRequiredGrantCounts,
  ScopeSelection,
  ScopeSelectionAllowed,
  ScopeSelectionDenied,
  ScopeSelectionStatus,
  ScopeWorkspaceModeCandidate
} from './resolver.js';
export type { ScopeWorkspaceCleanupResult, SweepExpiredScopeWorkspacesResult } from './workspace-cleanup.js';
export type {
  ScopeLinkSupportDecision,
  ScopeSourceFileManifest,
  ScopeSourceFileManifestEntry,
  ScopeWorkspaceMaterialization,
  ScopeWorkspaceMaterializerOptions
} from './workspace.js';
export type {
  ScopeWorkspaceMode,
  ScopeWorkspaceSafeDto,
  ScopeWorkspaceSafeFileLabel,
  ScopeWorkspaceStatus
} from './workspace-redaction.js';
export type { SafeScopeSessionSummary } from './answer-contract.js';
export type { ScopeShard } from './sharding.js';
export type { PreparedScopeSession, PrepareScopeSessionInput } from './query-runner.js';
export type {
  PublicSourceCitationDto,
  SourceCitationMetadataInput,
  SourceCitationSummary,
  UsedSourceCaptureKind,
  UsedSourceRecord
} from '../source-citations/index.js';
export { streamLargeScopeDiscovery } from './large-scope-stream.js';
export type { LargeScopeSink, TwoStageStage, TwoStageTrace } from './large-scope-stream.js';
export { DYNAMIC_SCOPE_PRESET_PREFIX, isDynamicScopePresetId } from './scope-options.js';
export type { ScopeDescriptor } from './scope-options.js';
