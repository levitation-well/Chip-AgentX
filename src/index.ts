// Re-export all public types
export type {
  AgentType,
  ProcessSession,
  RunningSession,
  FinishedSession,
  PollResult,
  LogResult,
  SpawnParams,
  SessionManagerOptions,
  ProcessAdapter,
  SessionStatus,
  ChatMode
} from './types.js';

// Re-export model catalog primitives
export {
  CHAT_MODE_DEFAULT_MODELS,
  DEFAULT_MODEL_ID,
  MODEL_CATALOG,
  authorizeModelAccess,
  getDefaultModelForChatMode,
  getDefaultModelGrantsForRole,
  getEffectiveModelGrants,
  getModelById,
  isModelId,
  listEnabledModels,
  listKnownModelIds,
  listModelCatalog,
  normalizeModelGrants,
  validateModelGrants
} from './model-catalog.js';
export type {
  ModelAuthorizationResult,
  ModelCapability,
  ModelCatalogEntry,
  ModelCatalogErrorPayload,
  ModelId,
  ModelProvider
} from './model-catalog.js';

// Re-export search mode catalog and resolver primitives
export {
  SEARCH_MODE_CATALOG,
  containsChatImageInput,
  entryPointAllowsImageInput,
  getSearchModeById,
  isSearchModeId,
  listSearchModeCatalog,
  resolveSearchModeAvailability,
  resolveSearchModeSelection,
  sourceToSearchModeEntryPoint
} from './search-modes.js';
export type {
  SearchModeAvailabilityEntry,
  SearchModeCatalogEntry,
  SearchModeDisabledReason,
  SearchModeDisabledReasonCode,
  SearchModeEntryPoint,
  SearchModeId,
  SearchModeResolveContext,
  SearchModeSelectionResult
} from './search-modes.js';

// Re-export chip config types and functions
export {
  type ChipConfig,
  type ChipCatalog,
  type PublicChip,
  type ResolvedChipWorkspace,
  ChipCatalogSchema,
  ChipConfigSchema,
  ChipConfigError,
  ChipNotFoundError,
  ChipWorkspaceError,
  loadChipCatalogFromFile,
  parseChipCatalog,
  listPublicChips,
  getDefaultChipConfigPath,
  resolveChipWorkspace,
  isPathInside
} from './chips/index.js';

// Re-export SessionManager
export { SessionManager } from './session-manager.js';

// Re-export HTTP and MCP transports
export { createHttpServer, startHttpServer } from './http-server.js';
export { createMcpServer, startMcpServer } from './mcp-server.js';
export type { HttpServerOptions } from './http-server.js';
export type { McpServerOptions } from './mcp-server.js';

// Re-export authentication primitives
export {
  AuthRouteError,
  JwtService,
  UserStore,
  authenticateRequest,
  createAuthRoutes,
  extractBearerToken,
  getAuthConfig,
  loadAuthConfig,
  matchAdminRoute,
  requireAdmin,
  requireAuth,
  resetAuthConfigForTests,
  sendUnauthorized
} from './auth/index.js';
export type {
  AdminRouteMatch,
  AuthConfig,
  AuthRoutes,
  AuthenticatedRequest,
  JwtPayload,
  LoginRequest,
  LoginResponse,
  McpKey,
  McpVerifyRequest,
  McpVerifyResponse,
  PublicMcpKey,
  PublicUser,
  PublicUserCredits,
  User,
  UserCredits,
  UserStoreConfig
} from './auth/index.js';

// Re-export credits primitives
export * from './credits.js';

// Re-export scope catalog primitives
export * from './scope/index.js';

// Re-export announcement content primitives
export * from './announcements/index.js';

// Re-export persistence primitives
export * from './persistence/index.js';

// Re-export logging primitives
export * from './logging/index.js';

// Re-export i18n message catalog primitives
export * from './i18n/index.js';

// Re-export admin read-only helpers
export * from './admin/session-history-reader.js';

// Re-export core components for advanced usage
export { ProcessRegistry } from './registry.js';
export { Supervisor } from './supervisor.js';
export { PtyAdapter } from './adapters/pty-adapter.js';
export { ChildAdapter } from './adapters/child-adapter.js';

// Re-export utilities
export { chunkedWrite, truncateOutput, generateSessionId, mapExitStatus } from './utils.js';

// Default export
export { SessionManager as default } from './session-manager.js';
