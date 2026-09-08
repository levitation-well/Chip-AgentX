import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ZodError } from 'zod';
import { SessionManager } from './session-manager.js';
import type { AdapterState, ChatMode, LogResult, ProcessSession, TurnState } from './types.js';
import {
  AgentActionSchemas,
  assertDynamicScopeChipsStillAuthorized,
  assertScopeWorkspaceStillAuthorized,
  createSessionActions,
  isSessionAuthorizationSnapshotCurrent
} from './server/session-actions.js';
import { AGENTX_MCP_TOOL_NAMES, createMcpServer, type McpActions } from './mcp-server.js';
import { buildMcpWhoamiResponse, publicChipToWhoamiResource } from './server/mcp-whoami.js';
import {
  AuthRouteError,
  JwtService,
  UserStore,
  createAuthRoutes,
  extractMcpBearerKey,
  getAuthConfig,
  getMcpKeyAvailability,
  getUserLocalePreference,
  isLocalePreference,
  ONBOARDING_STEPS,
  requireUsableAdmin,
  requireUsableAuth,
  RolesService,
  type AuthConfig,
  type AuthRoutes,
  type McpKey,
  type OnboardingStatus,
  type OnboardingStep,
  type PublicMcpKey,
  type PublicUser,
  type User,
  type UserProfile,
  type UserSelfServicePolicy
} from './auth/index.js';
import { RolesServiceError } from './auth/roles.js';
import type { AuthenticatedRequest } from './auth/types.js';
import {
  ChipCatalog,
  loadChipCatalogFromFile,
  listPublicChips,
  parseChipCatalog,
  resolveChipWorkspace,
  ChipConfigError,
  ChipNotFoundError,
  ChipWorkspaceError
} from './chips/index.js';
import { getDefaultChipConfigPath, getDefaultUserChipAccessPath } from './chips/config.js';
import { isConfiguredAbsolutePath } from './chips/types.js';
import {
  loadRoleConfig,
  loadPromptCatalog,
  buildSessionSystemPrompt,
  createInjectorState,
  injectSystemPrompt,
  getInjectionPolicy,
  type RoleCatalog,
  type PromptCatalog,
  type InjectorState
} from './prompts/index.js';
import { PromptGovernanceStore, type PromptHistoryActor } from './prompt-governance-store.js';
import {
  createPersistenceRuntime,
  assertSafeSessionId,
  resolveDataDir,
  type PersistenceRuntime,
  type SessionMeta,
  type SessionSource
} from './persistence/index.js';
import { LOG_EVENTS, createLogger, type Logger } from './logging/index.js';
import {
  listAdminSessions,
  queryAdminQuestions,
  readAdminSessionDetail,
  readSessionAnalysisPackage
} from './admin/session-history-reader.js';
import {
  DEFAULT_MCP_HTTP_SECURITY_CONFIG,
  fingerprintMcpKey,
  getAllowedCorsOrigin,
  isCorsOriginAllowed,
  resolveMcpHttpSecurityConfig,
  type McpHttpSecurityConfig,
  type McpHttpSecurityOptions
} from './server/mcp-http-security.js';
import {
  normalizeAssistantOutput as normalizeProjectedAssistantOutput,
  projectAssistantOutput,
  sanitizePersistedAssistantText as sanitizeProjectedAssistantText
} from './server/assistant-output-protocol.js';
import { getEffectiveModelGrants, listEnabledModels, type ModelId } from './model-catalog.js';
import {
  containsChatImageInput,
  resolveSearchModeAvailability,
  resolveSearchModeSelection,
  type SearchModeEntryPoint
} from './search-modes.js';
import {
  authorizeResourceAccess,
  computeEffectiveAuthorizationSummary,
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  mapAllowedChipsToResourceGrants,
  normalizeResourceGrantSet,
  findDocumentContract,
  findScopePresetContract,
  listVisibleResourceSummaries,
  loadResourceVisibilityCatalogFromFile,
  normalizeDocumentVisibilityContract,
  normalizeScopePresetContract,
  parseResourceVisibilityCatalog,
  redactAuthorizationMetadata,
  removeChipIdsFromResourceCatalog,
  serializeResourceVisibilityCatalog,
  writeResourceVisibilityCatalogToFile,
  type AuthorizationDecision,
  type DocumentVisibilityContract,
  type EffectiveAuthorizationSummary,
  type ResourceReviewStatus,
  type ResourceVisibilityCatalog,
  type ResourceGrantInput,
  type ResourceGrantSet,
  type ScopePresetContract
} from './security/index.js';
import { decideScopeScale, DEFAULT_SCOPE_SMALL_THRESHOLD, InvalidChipWorkspaceTargetError, isDynamicScopePresetId, prepareChipLaunch, prepareDynamicScopeSession, prepareScopeSession, runScopeQueryLarge, scopeLaunchHardening, scopeOutputContractInstructions, ScopeSessionDeniedError, ScopeTooLargeError, streamLargeScopeDiscovery, sweepExpiredScopeWorkspaces, validateHistoricalChipWorkspaceTarget, validatePresetReferences, type LargeScopeSink, type PreparedScopeSession } from './scope/index.js';
import { buildScopeOptions, countChipScopeFiles, listAuthorizedChipIds, resolveDynamicScopeSelection, type ScopeDescriptor, type ScopeOptionsResponse } from './scope/scope-options.js';
import { filterWholeWorkspaceAuthorizedChipIds } from './scope/document-chip-map.js';
import { chipIdsForGroupGrants } from './scope/group-grants.js';
import { getUserCreditBalanceUnits } from './auth/user-store.js';
import { CreditLedger } from './credits.js';
import type { SessionActionOptions } from './server/session-actions.js';
import {
  DEFAULT_MODEL_ROUTING_CONFIG,
  loadModelRoutingConfigSync,
  normalizeModelRoutingConfig,
  saveModelRoutingConfig,
  type ModelRoutingConfig
} from './model-routing.js';
import { assertContextBudget } from './context-budget.js';
import { buildObservabilityMetrics } from './observability/metrics.js';
import { DiscoveryTraceStore, recordScopeTrace } from './observability/discovery-trace.js';
import type { DiscoveryTraceEvent } from './observability/discovery-trace.js';
import type { SessionDebugBundleType, SessionDebugFileEntry } from './observability/session-debug-bundle.js';
import { redactDebugText } from './observability/redaction.js';
import { RateLimiter, type RateLimitResult } from './server/rate-limit.js';
import {
  getProductVersionSummary,
  loadProductConfig,
  readChangelog,
  toProductPublicSummary,
  type ProductConfig,
  type ProductVersionSummary
} from './product/index.js';
import {
  createFingerprintMarker,
  createFingerprintRuntimeConfig,
  toFingerprintPublicSummary
} from './fingerprint/index.js';
import {
  cleanupExpiredPendingTicketAttachments,
  cleanupUploadedFiles,
  createAccountApplicationTicket,
  buildDatasheetUploadReview,
  finalizeTicketAttachments,
  parseAccountApplicationRequest,
  parseDatasheetSubmissionMultipart,
  parseFeedbackTicketMultipart,
  resolveTicketAttachmentDownload,
  resolveTicketAttachmentPreview,
  TicketAttachmentUploadError,
  TicketNotFoundError,
  TicketStore,
  TicketValidationError,
  UnsafeTicketNoError,
  isTicketType,
  sanitizeTicketText,
  toAdminTicketDto,
  type AccountApplicationPayload,
  type DatasheetAdminReviewUpdate,
  type DatasheetCandidateResolution,
  type DatasheetMetadataCandidate,
  type DatasheetUploadReviewState,
  type TemporaryTicketAttachment,
  type TicketAdminUpdate,
  type TicketListFilters
} from './tickets/index.js';
import {
  ChatUploadError,
  cleanupExpiredChatImages,
  parseAndStoreChatImages,
  resolveChatImageDownload
} from './chat-uploads.js';
import { materializeChatImagesIntoWorkspace } from './chat-image-workspace.js';
import {
  buildFeedbackContextSnapshot,
  normalizeFeedbackContextInput
} from './source-citations/feedback-context.js';
import {
  AnnouncementStore,
  evaluateAnnouncementVisibility,
  normalizeAnnouncementContentItem,
  toPublicAnnouncementDto,
  validateAnnouncementContentItem,
  type AnnouncementContentItem,
  type AnnouncementContentStatus,
  type AnnouncementContentType,
  type AnnouncementLocale,
  type AnnouncementReadStateSummary,
  type AnnouncementSourceRef,
  type AnnouncementViewerContext
} from './announcements/index.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_MCP_HTTP_BODY_BYTES = DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxBodyBytes;
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip'
};
const MCP_TEMPLATE_ASSET_ROUTES = new Set([
  '/mcp-templates/opencode.json',
  '/mcp-templates/codex.md',
  '/mcp-templates/claude-code.md',
  '/mcp-templates/agent-spawn.example.json'
]);
const DOWNLOAD_ASSET_ROUTES = new Set<string>([]);
const MCP_ACCESS_CENTER_TEMPLATES = [
  {
    id: 'opencode',
    label: 'opencode Remote MCP config',
    clientType: 'opencode',
    downloadUrl: '/mcp-templates/opencode.json',
    contentType: 'application/json'
  },
  {
    id: 'codex',
    label: 'Codex Remote MCP handoff',
    clientType: 'codex',
    downloadUrl: '/mcp-templates/codex.md',
    contentType: 'text/markdown'
  },
  {
    id: 'claude-code',
    label: 'Claude Code Remote MCP handoff',
    clientType: 'claude-code',
    downloadUrl: '/mcp-templates/claude-code.md',
    contentType: 'text/markdown'
  },
  {
    id: 'agent-spawn',
    label: 'agent_spawn request example',
    clientType: 'remote-mcp',
    downloadUrl: '/mcp-templates/agent-spawn.example.json',
    contentType: 'application/json'
  }
] as const;
const MCP_ACCESS_CENTER_DOWNLOADS: readonly { id: string; label: string; downloadUrl: string; contentType: string }[] = [];
const SSE_EVENTS = {
  snapshot: 'event: snapshot',
  output: 'event: output',
  result: 'event: result',
  state: 'event: state',
  exit: 'event: exit'
} as const;
const SSE_KEEPALIVE_FRAME = ': ping\n\n';
const ADMIN_SECTION_PAGE_ROUTES = new Set([
  '/admin/sections/users',
  '/admin/sections/roles',
  '/admin/sections/model-routing',
  '/admin/sections/prompts',
  '/admin/sections/chips',
  '/admin/sections/sessions',
  '/admin/sections/questions',
  '/admin/sections/observability',
  '/admin/sections/discovery-traces',
  '/admin/sections/announcements',
  '/admin/sections/resources',
  '/admin/sections/feedback'
]);

type ActionName = keyof typeof AgentActionSchemas;
type SessionActions = ReturnType<typeof createSessionActions>;

interface RemoteMcpSession {
  transport: StreamableHTTPServerTransport;
  userId: string;
  username: string;
  role: string;
  createdAt: string;
  createdAtMs: number;
  lastSeenAt: string;
  lastSeenAtMs: number;
  expiresAt: string;
  expiresAtMs: number;
  lastKeyTouchAtMs: number;
  keyId: string;
  keyName: string;
  keyFingerprint: string;
}

type RemoteMcpIdentity = {
  user: User;
  key: McpKey;
};

type TransportLimitResult = RateLimitResult & {
  limitName: string;
};

export interface HttpServerOptions {
  host?: string;
  port?: number;
  manager?: SessionManager;
  publicDir?: string;
  auth?: {
    enabled?: boolean;
    config?: AuthConfig;
    userStore?: UserStore;
    jwtService?: JwtService;
    rolesFile?: string;
  };
  chips?: {
    enabled?: boolean;
    configFile?: string;
    userAccessFile?: string;
    catalog?: ChipCatalog;
  };
  prompts?: {
    enabled?: boolean;
    configFile?: string;
    rolesFile?: string;
    dataDir?: string;
  };
  resources?: {
    enabled?: boolean;
    configFile?: string;
    catalog?: ResourceVisibilityCatalog;
  };
  persistence?: {
    enabled?: boolean;
    dataDir?: string;
    fileLogging?: boolean;
    retentionDays?: number;
    runtime?: PersistenceRuntime;
  };
  logger?: Logger;
  mcpHttpSecurity?: McpHttpSecurityOptions;
  product?: {
    config?: Partial<ProductConfig>;
    configFile?: string;
  };
  tickets?: {
    store?: TicketStore;
  };
  announcements?: {
    store?: AnnouncementStore;
  };
  scope?: {
    /** 注入点：默认 runScopeQueryLarge；测试可注入假实现避免跑真实 CC。 */
    largeQueryFactory?: typeof runScopeQueryLarge;
    /** small/large 阈值（文件数）；默认 DEFAULT_SCOPE_SMALL_THRESHOLD=200。测试可设 0 强制 large。 */
    smallThreshold?: number;
  };
  modelRouting?: {
    configFile?: string;
    config?: Partial<ModelRoutingConfig>;
  };
}

interface AuthRuntime {
  config: AuthConfig;
  jwtService: JwtService;
  routes: AuthRoutes;
  userStore: UserStore;
  rolesService?: RolesService;
}

interface ChipRuntime {
  catalog: ChipCatalog;
  configFile?: string;
  legacyUserAccessFile: string;
  /**
   * 已保存芯片目录的并发守卫标记（ETag）。GET 在响应头回传，PUT 经 If-Match 校验。
   * 初始为 undefined（按当前运行时目录现算）；每次成功保存后刷新为新落库内容的哈希，
   * 使「读 → 改 → 写」之间发生过另一次保存时，旧 ETag 立即失配并返回 409。
   */
  catalogEtag?: string;
}

interface PromptRuntime {
  catalog: PromptCatalog;
  roleConfig: RoleCatalog;
  rolesFile: string;
  sessionStates: Map<string, InjectorState>;
}

interface ResourceRuntime {
  catalog: ResourceVisibilityCatalog;
  configFile?: string;
}

interface ProductRuntime {
  config: ProductConfig;
  version: ProductVersionSummary;
}

interface DiscoveryTraceConfigStatusItem {
  name: string;
  /**
   * ok      = 运行时存在且其配置文件确实落地在磁盘上（或本就是内存模式）；
   * fallback = 运行时存在但配置文件缺失，正跑在内存默认值上（批次C 后 resources 的 ENOENT 降级即此态）；
   * missing = 运行时未启用。
   */
  status: 'ok' | 'fallback' | 'missing';
  /** 配置文件绝对路径或状态说明，便于快速定位加载来源。 */
  detail?: string;
}

interface DiscoveryTraceSystemInfo {
  nodeVersion: string;
  agentBackend: string;
  dataDir: string;
  /** @deprecated 逗号拼接串，仅为旧前端兼容保留；结构化清单见 configStatusItems。 */
  configStatus: string;
  configStatusItems: DiscoveryTraceConfigStatusItem[];
  claudeCodeCliVersion: string;
  platform: string;
}

interface ModelRoutingRuntime {
  configFile?: string;
  config: ModelRoutingConfig;
}

interface ConversationInput {
  text: string;
  outputStart: number;
}

type ConversationHistory = Map<string, ConversationInput[]>;
type ConversationMessage = {
  role: 'user' | 'assistant';
  text: string;
  turnId?: string;
  sourceCitationSummary?: SessionMeta['sourceCitationSummary'];
};

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

class AuthorizationHttpError extends HttpError {
  constructor(
    message: string,
    readonly decision?: AuthorizationDecision
  ) {
    super(403, message);
  }
}

export function createHttpServer(options: HttpServerOptions = {}): http.Server {
  const manager = options.manager ?? new SessionManager({ exitOnLastSession: false });
  const publicDir = path.resolve(options.publicDir ?? path.join(process.cwd(), 'public'));
  const dataDir = options.persistence?.dataDir ?? resolveDataDir();
  const logger =
    options.logger ??
    createLogger({
      dataDir,
      fileLogging: options.persistence?.fileLogging
    });
  const persistenceRuntime =
    !options.persistence || options.persistence.enabled === false
      ? undefined
      : options.persistence?.runtime ??
        createPersistenceRuntime({
          dataDir,
          fileLogging: options.persistence?.fileLogging,
          retentionDays: options.persistence?.retentionDays,
          logger
        });
  const conversationHistory: ConversationHistory = new Map();
  const remoteMcpTransports = new Map<string, RemoteMcpSession>();
  const mcpHttpSecurity = resolveMcpHttpSecurityConfig(options.mcpHttpSecurity);
  const mcpRateLimiter = new RateLimiter(mcpHttpSecurity.rateLimitWindowMs);
  const authRuntime = initializeAuthRuntime(options.auth);
  const chipRuntime = initializeChipRuntime(options.chips);
  // Only an explicitly enabled catalog is a production dependency. Tests and
  // local generic-agent mode may deliberately set enabled:false; by contrast,
  // enabled:true plus a load failure must fail closed instead of exposing the
  // server working directory as an unrestricted customer workspace.
  const chipCatalogRequired = options.chips?.enabled === true;
  const promptsRuntime = initializePromptRuntime(options.prompts);
  const resourceRuntime = initializeResourceRuntime(options.resources);
  const productRuntime = initializeProductRuntime(options.product);
  const modelRoutingRuntime = initializeModelRoutingRuntime(options.modelRouting);
  const actions = createSessionActions(manager, {
    persistence: persistenceRuntime,
    source: 'rpc',
    modeRoleMapping: modelRoutingRuntime.config.modeRoleMapping
  });
  const ticketStore = options.tickets?.store ?? new TicketStore({ dataDir: persistenceRuntime?.dataDir ?? dataDir });
  const announcementStore =
    options.announcements?.store ?? new AnnouncementStore({ dataDir: persistenceRuntime?.dataDir ?? dataDir });
  const creditLedger = persistenceRuntime ? new CreditLedger({ dataDir: persistenceRuntime.dataDir }) : undefined;
  // A reservation is only safe when the persistence bridge can eventually
  // commit or release it. Without persistence, reserving directly in
  // users.json would leave successful turns permanently held with no exit
  // settlement path. In that explicitly non-durable mode billing is disabled
  // and surfaced as a startup warning instead of corrupting balances.
  const creditReservations = persistenceRuntime
    ? createCreditReservationProvider(authRuntime)
    : undefined;
  if (!persistenceRuntime) {
    void authRuntime.then((auth) => {
      if (auth) {
        logger.warn(LOG_EVENTS.persistError, 'Credit billing is disabled because persistence is unavailable', {
          metadata: { billingMode: 'disabled', reason: 'persistence_unavailable' }
        });
      }
    }).catch(() => {});
  }
  const creditRecoveryReady = persistenceRuntime && creditLedger
    ? authRuntime.then(async (auth) => {
        if (!auth) return;
        await reconcilePersistedCreditReservations({
          persistence: persistenceRuntime,
          userStore: auth.userStore,
          creditLedger,
          activeSessionIds: new Set(
            (typeof manager.list === 'function' ? manager.list() : [])
              .filter((session) => session.status === 'running' && session.turnState === 'running')
              .map((session) => session.id)
          ),
          logger
        });
      })
    : Promise.resolve();
  // M3 large 档注入点：默认 runScopeQueryLarge + DEFAULT_SCOPE_SMALL_THRESHOLD；测试可覆盖。
  const scopeLargeQueryFactory = options.scope?.largeQueryFactory ?? runScopeQueryLarge;
  const scopeSmallThreshold = options.scope?.smallThreshold ?? DEFAULT_SCOPE_SMALL_THRESHOLD;
  let authorizationMergeReady: Promise<void> | undefined;
  const ensureAuthorizationMergeReady = async (): Promise<void> => {
    authorizationMergeReady ??= authRuntime.then(async (auth) => {
      if (!auth) {
        return;
      }
      const legacyChipAccessFile = path.resolve(
        options.chips?.userAccessFile ?? getDefaultUserChipAccessPath(auth.config.dataDir)
      );
      await auth.userStore.migrateLegacyChipAccess({
        legacyFile: legacyChipAccessFile,
        auditLogger: persistenceRuntime?.auditLogger
      });
    });
    await authorizationMergeReady;
  };

  void cleanupExpiredPendingTicketAttachments({ ticketStore, dataDir: persistenceRuntime?.dataDir ?? dataDir })
    .catch((error) => {
      logger.error(LOG_EVENTS.persistError, 'Ticket attachment retention cleanup failed', {
        metadata: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
  void cleanupExpiredChatImages({ dataDir: persistenceRuntime?.dataDir ?? dataDir })
    .catch((error) => {
      logger.error(LOG_EVENTS.persistError, 'Chat image retention cleanup failed', {
        metadata: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });

  // Scope 工作区 TTL 回收：启动时扫一次，删除超过 24h 的过期隔离副本（M2 Task 5）
  const SCOPE_WORKSPACE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
  void sweepExpiredScopeWorkspaces({ dataDir: persistenceRuntime?.dataDir ?? dataDir, maxAgeMs: SCOPE_WORKSPACE_TTL_MS })
    .catch((error) => {
      logger.error(LOG_EVENTS.persistError, 'Scope workspace TTL cleanup failed', {
        metadata: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });

  if (persistenceRuntime) {
    wirePersistenceBridge(manager, persistenceRuntime, logger, {
      creditLedger: creditLedger!,
      resolveUserStore: async () => (await authRuntime)?.userStore ?? null,
      commitCreditReservation: async (reservationId) => {
        await creditReservations!.commit?.(reservationId);
      },
      releaseCreditReservation: async (reservationId) => {
        await creditReservations!.release(reservationId);
      }
    });
  }

  // Discovery Trace 最小落点（spec §6.9）：订阅 SessionManager 的 'launch'（加固 claude-code 启动）
  // 与非零退出的 'exit'，落结构化 cc.launch / error 事件，供 Task 5 的 /admin/discovery-traces 读取。
  const discoveryTraceStore = new DiscoveryTraceStore({
    dataDir: persistenceRuntime?.dataDir ?? dataDir,
    logger
  });
  manager.on('launch', (sessionId: string, detail: Record<string, unknown>) => {
    void discoveryTraceStore.record({ sessionId, stage: 'cc.launch', status: 'ok', detail });
  });
  manager.on('exit', (sessionId: string, code: number) => {
    if (code !== 0) {
      void discoveryTraceStore.record({ sessionId, stage: 'error', status: 'error', detail: { exitCode: code } });
      const session = typeof manager.getSession === 'function' ? manager.getSession(sessionId) : undefined;
      void persistenceRuntime?.sessionDebugBundles.write(sessionId, {
        failure: {
          stage: 'error',
          error: `Session exited with code ${code}`,
          ...(session?.cwd ? { partialWorkspaceTree: [] } : {})
        },
        stages: [{ stage: 'error', status: 'error', detail: { exitCode: code } }]
      });
      if (session?.cwd) {
        void listPartialWorkspaceTree(session.cwd)
          .then((partialWorkspaceTree) =>
            persistenceRuntime?.sessionDebugBundles.write(sessionId, {
              failure: {
                stage: 'error',
                error: `Session exited with code ${code}`,
                partialWorkspaceTree
              }
            })
          )
          .catch(() => {});
      }
    }
  });

  return http.createServer(async (request, response) => {
    if (!applyCors(request, response, mcpHttpSecurity)) {
      sendJson(response, 403, { error: 'CORS origin not allowed' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      await creditRecoveryReady;
      await ensureAuthorizationMergeReady();
      await handleRequest(
        request,
        response,
        manager,
        actions,
        publicDir,
        conversationHistory,
        await authRuntime,
        await chipRuntime,
        chipCatalogRequired,
        await promptsRuntime,
        await resourceRuntime,
        await productRuntime,
        modelRoutingRuntime,
        ticketStore,
        announcementStore,
        creditLedger,
        persistenceRuntime,
        persistenceRuntime?.dataDir ?? dataDir,
        logger,
        remoteMcpTransports,
        mcpHttpSecurity,
        mcpRateLimiter,
        creditReservations,
        discoveryTraceStore,
        scopeLargeQueryFactory,
        scopeSmallThreshold
      );
    } catch (error) {
      handleHttpError(response, error);
    }
  });
}

export async function startHttpServer(options: HttpServerOptions = {}): Promise<http.Server> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const dataDir = options.persistence?.dataDir ?? resolveDataDir();
  const logger = options.logger ?? createLogger({
    dataDir,
    fileLogging: options.persistence?.fileLogging
  });

  let persistenceRuntime = options.persistence?.runtime;
  if (options.persistence?.enabled !== false) {
    persistenceRuntime = persistenceRuntime ?? createPersistenceRuntime({
      dataDir,
      fileLogging: options.persistence?.fileLogging,
      retentionDays: options.persistence?.retentionDays,
      logger
    });
    try {
      await persistenceRuntime.init();
    } catch (error) {
      logger.error(LOG_EVENTS.persistError, 'Persistence runtime initialization failed', {
        metadata: {
          dataDir: persistenceRuntime.dataDir,
          error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  }

  const server = createHttpServer({
    ...options,
    persistence: {
      ...options.persistence,
      runtime: persistenceRuntime
    },
    logger
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.listen(port, host, handleListening);
  });

  // Report actual bound port (important when port=0 for auto-assignment)
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;
  logger.info(LOG_EVENTS.serverStarted, 'AgentX server listening', {
    metadata: { host, port: boundPort, url: `http://${host}:${boundPort}` }
  });

  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  actions: SessionActions,
  publicDir: string,
  conversationHistory: ConversationHistory,
  auth: AuthRuntime | null,
  chips: ChipRuntime | null,
  chipCatalogRequired: boolean,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  product: ProductRuntime,
  modelRouting: ModelRoutingRuntime,
  ticketStore: TicketStore,
  announcementStore: AnnouncementStore,
  creditLedger: CreditLedger | undefined,
  persistence: PersistenceRuntime | undefined,
  uploadDataDir: string,
  logger: Logger,
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  mcpHttpSecurity: McpHttpSecurityConfig,
  mcpRateLimiter: RateLimiter,
  creditReservations: SessionActionOptions['creditReservations'],
  // Task 5 /admin/discovery-traces 只读接口，透传进 handleAdminRequest。
  discoveryTraceStore: DiscoveryTraceStore,
  // M3 large 档：两阶段引擎工厂 + small/large 阈值，透传进 handleSessionCreate。
  scopeLargeQueryFactory: typeof runScopeQueryLarge = runScopeQueryLarge,
  scopeSmallThreshold: number = DEFAULT_SCOPE_SMALL_THRESHOLD
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_HOST}`);
  const method = request.method ?? 'GET';
  const pathname = url.pathname;

  if (
    (method === 'GET' || method === 'HEAD') &&
    (await tryServeStaticAsset(pathname, url.searchParams, response, publicDir, product.config))
  ) {
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && isUnknownAdminSectionPageRoute(pathname)) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/version') {
    const fingerprintRuntime = createFingerprintRuntimeConfig(product.config, product.version);
    const fingerprintMarker = createFingerprintMarker(fingerprintRuntime);
    sendJson(response, 200, {
      ...product.version,
      ...toProductPublicSummary(product.config),
      fingerprint: toFingerprintPublicSummary(fingerprintRuntime, fingerprintMarker)
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/changelog') {
    sendJson(response, 200, await readChangelog());
    return;
  }

  if (pathname === '/api/announcements/home' || pathname === '/api/announcements/feed' || pathname.startsWith('/api/announcements/')) {
    await handleAnnouncementRequest(
      request as AuthenticatedRequest,
      response,
      auth,
      method,
      pathname,
      url,
      announcementStore
    );
    return;
  }

  if (method === 'GET' && pathname === '/api/search-modes') {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (auth) {
      if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
        return;
      }
    }
    sendJsonNoStore(response, 200, {
      modes: listSearchModesForRequest(authenticatedRequest, 'web-chat', false, modelRouting)
    });
    return;
  }

  const chatImageMatch = /^\/api\/chat-uploads\/([^/]+)\/([^/]+)$/.exec(pathname);
  if ((method === 'GET' || method === 'HEAD') && chatImageMatch) {
    const download = await resolveChatImageDownload({
      dataDir: uploadDataDir,
      imageId: decodeURIComponent(chatImageMatch[1] ?? ''),
      storedName: decodeURIComponent(chatImageMatch[2] ?? ''),
      token: url.searchParams.get('token') ?? undefined
    });
    response.statusCode = 200;
    response.setHeader('Content-Type', download.contentType);
    response.setHeader('Content-Length', String(download.sizeBytes));
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (method === 'HEAD') {
      response.end();
      return;
    }
    download.stream.pipe(response);
    return;
  }

  if (method === 'POST' && pathname === '/api/chat-uploads/images') {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (auth) {
      if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
        return;
      }
    }
    const userId = authenticatedRequest.user?.userId;
    if (!userId) {
      throw new ChatUploadError(401, 'Authentication required');
    }
    assertSearchModeSelectableForRequest(authenticatedRequest, 'web-upload', 'multimodal', undefined, true, modelRouting);
    sendJson(
      response,
      201,
      await parseAndStoreChatImages(request, {
        dataDir: uploadDataDir,
        userId,
        requiredChatMode: 'multimodal'
      })
    );
    return;
  }

  const publicTicketMatch = /^\/api\/tickets\/([^/]+)\/public$/.exec(pathname);
  if (method === 'GET' && publicTicketMatch) {
    const ticketNo = decodeURIComponent(publicTicketMatch[1] ?? '');
    sendJson(response, 200, { ticket: await ticketStore.getPublicTicket(ticketNo) });
    return;
  }

  if (method === 'POST' && pathname === '/api/tickets/feedback') {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (auth) {
      if (authenticatedRequest.headers.authorization) {
        if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
          return;
        }
      }
    }

    let uploadedAttachments: TemporaryTicketAttachment[] = [];
    try {
      const ticketDataDir = persistence?.dataDir ?? path.dirname(ticketStore.ticketsDir);
      const parsed = await parseFeedbackTicketMultipart(request, { dataDir: ticketDataDir });
      uploadedAttachments = parsed.attachments;
      const user = authenticatedRequest.user;
      const created = await ticketStore.createTicket({
        type: 'feedback',
        title: parsed.fields.title,
        status: 'submitted',
        source: 'public-feedback-form',
        contact: parsed.fields.contact ? { raw: parsed.fields.contact } : undefined,
        accountBinding: user?.userId
          ? { userId: user.userId, username: user.username, role: user.role }
          : undefined,
        payload: {
          content: parsed.fields.content,
          category: parsed.fields.category,
          hasAttachments: parsed.fields.hasAttachments || parsed.attachments.length > 0
        }
      });
      const attachments = await finalizeTicketAttachments(parsed.attachments, {
        dataDir: ticketDataDir,
        ticketNo: created.ticketNo
      });
      if (attachments.length > 0) {
        await ticketStore.replaceTicketAttachments(created.ticketNo, attachments);
      }
      sendJson(response, 201, { ticket: await ticketStore.getPublicTicket(created.ticketNo) });
    } catch (error) {
      await cleanupUploadedFiles(uploadedAttachments);
      throw error;
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/tickets/datasheet') {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (auth) {
      if (authenticatedRequest.headers.authorization) {
        if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
          return;
        }
      }
    }

    let uploadedAttachments: TemporaryTicketAttachment[] = [];
    try {
      const ticketDataDir = persistence?.dataDir ?? path.dirname(ticketStore.ticketsDir);
      const parsed = await parseDatasheetSubmissionMultipart(request, { dataDir: ticketDataDir });
      uploadedAttachments = parsed.attachments;
      const user = authenticatedRequest.user;
      const created = await ticketStore.createTicket({
        type: 'datasheet_submission',
        title: parsed.fields.title,
        status: 'submitted',
        source: 'public-datasheet-submission-form',
        contact: parsed.fields.contact ? { raw: parsed.fields.contact } : undefined,
        accountBinding: user?.userId
          ? { userId: user.userId, username: user.username, role: user.role }
          : undefined,
        payload: {
          vendor: parsed.fields.vendor,
          partNumberOrKeywords: parsed.fields.partNumberOrKeywords,
          sourceNote: parsed.fields.sourceNote,
          sourceDeclaration: parsed.fields.sourceDeclaration,
          note: parsed.fields.note
        }
      });
      const attachments = await finalizeTicketAttachments(parsed.attachments, {
        dataDir: ticketDataDir,
        ticketNo: created.ticketNo
      });
      const uploadReview = buildDatasheetUploadReview(parsed.fields, attachments);
      if (attachments.length > 0) {
        await ticketStore.replaceTicketAttachments(created.ticketNo, attachments);
      }
      const reviewed = await ticketStore.replaceTicketPayload(created.ticketNo, {
        ...(await ticketStore.getTicket(created.ticketNo)).payload,
        uploadReview
      }, {
        userId: user?.userId,
        username: user?.username,
        role: user?.role
      });
      if (reviewed.status !== uploadReview.state) {
        await ticketStore.updateTicket(reviewed.ticketNo, { status: uploadReview.state }, {
          userId: user?.userId,
          username: user?.username,
          role: user?.role
        });
      }
      sendJson(response, 201, {
        ticket: await ticketStore.getPublicTicket(created.ticketNo),
        uploadReview: {
          state: uploadReview.state,
          securityScanStatus: uploadReview.securityScan.status,
          securityScanSummary: uploadReview.securityScan.summary
        }
      });
    } catch (error) {
      await cleanupUploadedFiles(uploadedAttachments);
      throw error;
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/tickets/account-application') {
    if (!isJsonRequest(request)) {
      throw new HttpError(400, 'Expected JSON account application request');
    }
    const authenticatedRequest = request as AuthenticatedRequest;
    if (auth) {
      if (authenticatedRequest.headers.authorization) {
        if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
          return;
        }
      }
    }
    const user = authenticatedRequest.user;
    const fields = await parseAccountApplicationRequest(await readJsonObject(request));
    const created = await createAccountApplicationTicket({
      ticketStore,
      fields,
      accountBinding: user?.userId ? { userId: user.userId, username: user.username, role: user.role } : undefined,
      now: new Date()
    });
    sendJson(response, 201, { ticket: await ticketStore.getPublicTicket(created.ticketNo) });
    return;
  }

  if (auth && method === 'POST' && pathname === '/auth/login') {
    sendJson(response, 200, await auth.routes.login(await readJsonObject(request)));
    return;
  }

  if (auth && method === 'GET' && pathname === '/auth/me') {
    const authenticatedRequest = request as AuthenticatedRequest;
    if (!(await requireUsableAuth(authenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
    const currentUser = await auth.userStore.findById(authenticatedRequest.user!.userId);
    if (!currentUser) {
      throw new HttpError(401, 'Authentication required', 'AUTHENTICATION_REQUIRED');
    }
    const locale = getUserLocalePreference(currentUser);
    sendJsonNoStore(response, 200, {
      user: {
        userId: authenticatedRequest.user!.userId,
        username: authenticatedRequest.user!.username,
        role: authenticatedRequest.user!.role,
        localePreference: locale,
        preferredLanguage: locale
      }
    });
    return;
  }

  if (auth && method === 'POST' && pathname === '/mcp/verify') {
    const body = await readJsonObject(request, mcpHttpSecurity.maxBodyBytes);
    const keyValue = typeof body.key === 'string' ? body.key : undefined;
    const rateLimit = consumeMcpRateLimit(
      mcpRateLimiter,
      request,
      'mcp:verify',
      fingerprintMcpKey(keyValue),
      mcpHttpSecurity.verifyRateLimitMax
    );
    if (!rateLimit.allowed) {
      logMcpRateLimited(logger, request, pathname, method, 'mcp:verify', rateLimit, fingerprintMcpKey(keyValue));
      sendJson(response, 429, { valid: false });
      return;
    }
    const result = await auth.routes.verifyMcpKey(body);
    logger.info(LOG_EVENTS.mcpVerify, 'MCP key verify requested', {
      metadata: remoteMcpLogMetadata(request, pathname, method, {
        valid: result.valid,
        keyFingerprint: fingerprintMcpKey(keyValue)
      })
    });
    sendJson(response, 200, result);
    return;
  }

  if (method === 'GET' && pathname === '/api/mcp/access-center') {
    await handleMcpAccessCenterRequest(request as AuthenticatedRequest, response, auth, url, chips, prompts, resources, mcpHttpSecurity, modelRouting);
    return;
  }

  if (auth && method === 'GET' && pathname === '/api/scope-presets') {
    if (!(await requireUsableAuth(request as AuthenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
    const summary = await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips);
    const allPresets = resources?.catalog.scopePresets ?? [];
    const visiblePresets = summary
      ? allPresets
          .filter((preset) => preset.status === 'approved')
          .filter((preset) => evaluateScopePresetVisibility(summary, preset).allowed)
          .map((preset) => ({
            scopePresetId: preset.scopePresetId,
            label: preset.label,
            brands: [...preset.brands],
            productLines: [...preset.productLines],
            applicationTags: [...preset.applicationTags]
          }))
      : [];
    sendJson(response, 200, { presets: visiblePresets });
    return;
  }

  if (auth && method === 'GET' && pathname === '/api/scope-options') {
    if (!(await requireUsableAuth(request as AuthenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
    // chips 未配置时返回空结构，不崩溃
    if (!chips) {
      const emptyOptions: ScopeOptionsResponse = {
        single: { chips: [] },
        group: { productLines: [], brands: [], applications: [] },
        global: { chipIds: [], fileCount: 0, tooLarge: false }
      };
      sendJson(response, 200, emptyOptions);
      return;
    }
    const summary = await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips);
    if (!summary) {
      sendJson(response, 200, {
        single: { chips: [] },
        group: { productLines: [], brands: [], applications: [] },
        global: { chipIds: [], fileCount: 0, tooLarge: false }
      } satisfies ScopeOptionsResponse);
      return;
    }
    const chipAuthorizedIds = listAuthorizedChipIds(chips.catalog, (chipId) => canRequestAccessChip(summary, chipId));
    const authorizedDocumentIds = resources?.catalog.documents
      .filter((document) => evaluateDocumentVisibility(summary, document).allowed)
      .map((document) => document.documentId) ?? [];
    // Keep the picker honest with the physical copy gate: if one catalogued
    // sibling document is hidden/draft, the whole-chip workspace is not a
    // selectable scope until file-level mapping exists.
    const authorizedChipIds = filterWholeWorkspaceAuthorizedChipIds(
      resources?.catalog,
      chipAuthorizedIds,
      authorizedDocumentIds
    );
    // 对每个授权芯片统计可检索文件数，失败则记 0
    const fileCountByChipId = new Map<string, number>();
    await Promise.all(
      authorizedChipIds.map(async (chipId) => {
        try {
          const resolved = await resolveChipWorkspace(chips.catalog, chipId);
          const count = await countChipScopeFiles(resolved.cwd);
          fileCountByChipId.set(chipId, count);
        } catch {
          fileCountByChipId.set(chipId, 0);
        }
      })
    );
    const options = buildScopeOptions({ catalog: chips.catalog, authorizedChipIds, fileCountByChipId });
    sendJson(response, 200, options);
    return;
  }

  if (pathname === '/mcp' && (method === 'POST' || method === 'GET' || method === 'DELETE')) {
    await handleRemoteMcpRequest(
      request as AuthenticatedRequest,
      response,
      method,
      pathname,
      manager,
      auth,
      persistence,
      logger,
      remoteMcpTransports,
      mcpHttpSecurity,
      mcpRateLimiter,
      chips,
      prompts,
      resources,
      modelRouting,
      scopeSmallThreshold,
      creditReservations
    );
    return;
  }

  if (chips && method === 'GET' && pathname === '/chips') {
    if (auth && !(await requireUsableAuth(request as AuthenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
    const summary = await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips);
    sendJson(response, 200, {
      chips: listPublicChips(filterChipCatalogForRequest(chips, request as AuthenticatedRequest, summary))
    });
    return;
  }

  if (auth && method === 'GET' && pathname === '/api/my/tickets') {
    if (!(await requireUsableAuth(request as AuthenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
    const userId = (request as AuthenticatedRequest).user?.userId;
    if (!userId) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    sendJson(response, 200, await ticketStore.listTicketsForAccount(userId, parseTicketListFilters(url)));
    return;
  }

  if (auth && isAccountApiPath(pathname)) {
    await handleAccountRequest(
      request as AuthenticatedRequest,
      response,
      auth,
      method,
      pathname,
      url,
      persistence,
      logger,
      creditLedger,
      chips,
      prompts,
      resources
    );
    return;
  }

  if (auth && pathname.startsWith('/admin/')) {
    await handleAdminRequest(
      request as AuthenticatedRequest,
      response,
      auth,
      method,
      pathname,
      chips,
      prompts,
      resources,
      persistence,
      logger,
      uploadDataDir,
      ticketStore,
      announcementStore,
      creditLedger,
      discoveryTraceStore,
      modelRouting
    );
    return;
  }

  if (auth && isProtectedApiRoute(pathname)) {
    if (!(await requireUsableAuth(request as AuthenticatedRequest, response, auth.jwtService, auth.userStore))) {
      return;
    }
  }

  // POST /sessions �?chip-aware path
  if (method === 'POST' && pathname === '/api/feedback/messages') {
    if (!persistence) {
      throw new HttpError(503, 'Feedback context storage is unavailable');
    }

    const body = normalizeFeedbackContextInput(await readJsonBody(request));
    const meta = await persistence.sessionStore.readSessionMeta(body.sessionId);
    const user = (request as AuthenticatedRequest).user;
    if (!meta || (meta.userId && meta.userId !== user?.userId)) {
      sendJson(response, 404, { error: 'Session or message not found' });
      return;
    }

    const transcript = await persistence.sessionStore.readTranscript(body.sessionId);
    const liveOutput = manager.log(body.sessionId).output;
    const persistedOutput = liveOutput ? liveOutput : (await persistence.sessionStore.tailOutput(body.sessionId, meta.outputSize)).output;
    const snapshot = buildFeedbackContextSnapshot({
      meta,
      transcript,
      output: persistedOutput,
      input: body,
      entry: 'web'
    });
    const created = await ticketStore.createTicket({
      type: 'feedback',
      title: `Chat feedback ${body.sessionId}`,
      status: 'submitted',
      source: 'message-feedback',
      accountBinding: user?.userId
        ? { userId: user.userId, username: user.username, role: user.role }
        : undefined,
      payload: {
        feedbackSnapshot: snapshot,
        feedbackTypes: snapshot.feedbackTypes,
        reviewSignal: snapshot.reviewSignal,
        note: snapshot.note
      }
    });
    await persistence.recordSessionEvent(body.sessionId, {
      event: 'feedback_snapshot_created',
      turnId: snapshot.turnId,
      details: {
        ticketNo: created.ticketNo,
        feedbackTypes: snapshot.feedbackTypes,
        reviewSignal: snapshot.reviewSignal,
        answerTextHash: snapshot.answerTextHash
      }
    });

    sendJson(response, 201, {
      ticket: await ticketStore.getPublicTicket(created.ticketNo),
      feedback: {
        ticketNo: created.ticketNo,
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
        reviewSignal: snapshot.reviewSignal
      }
    });
    return;
  }

  if (method === 'POST' && pathname === '/sessions') {
    const body = await readJsonBody(request);
    await handleSessionCreate(request, response, manager, actions, conversationHistory, auth, chips, chipCatalogRequired, prompts, resources, persistence, logger, modelRouting, body, discoveryTraceStore, scopeLargeQueryFactory, scopeSmallThreshold, creditReservations);
    return;
  }

  if (method === 'GET' && pathname === '/sessions') {
    const listResult = await getRequestActions(
      request as AuthenticatedRequest,
      manager,
      actions,
      persistence,
      'web',
      creditReservations,
      modelRouting,
      auth,
      chips,
      resources
    ).agent_list({});
    sendJson(
      response,
      200,
      {
        ...listResult,
        sessions: listResult.sessions.map(redactExternalSessionResult)
      }
    );
    return;
  }

  if (method === 'GET' && pathname === '/sessions/history') {
    if (!persistence) {
      sendJson(response, 200, { sessions: [], total: 0, offset: 0, limit: 0 });
      return;
    }
    const user = (request as AuthenticatedRequest).user;
    if (!user?.userId) {
      throw new HttpError(401, 'Authentication required');
    }
    const authorizationSummary = chips || resources
      ? await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips)
      : undefined;
    const result = await persistence.sessionStore.listUserSessions(
      user.userId,
      parsePagination(url),
      authorizationSummary
        ? (meta) => isSessionAuthorizationSnapshotCurrent(meta, authorizationSummary, resources?.catalog ?? null)
        : undefined
    );
    const liveConversationSessions = mapOwnedLiveConversationSessions(manager.list(), user.userId);
    sendJson(response, 200, {
      sessions: result.items.map((session) => {
        const liveSession = liveConversationSessions.get(session.sessionId);
        const projected = projectLiveConversationTurnState(session, liveSession);
        return {
          ...projected,
          id: projected.sessionId,
          requiresNewScopeQuery: isScopeHistorySessionRestartOnly(projected) && !liveSession
        };
      }),
      total: result.total,
      offset: result.offset,
      limit: result.limit
    });
    return;
  }

  // Chat reconnect/visibility recovery needs an immediate, side-effect-free
  // status projection for the active session. Reuse agent_list so ownership,
  // current authorization, and the public redaction contract stay identical
  // to GET /sessions instead of introducing a parallel lookup path.
  const sessionStatusMatch = matchSessionRoute(pathname);
  if (method === 'GET' && sessionStatusMatch) {
    const listResult = await getRequestActions(
      request as AuthenticatedRequest,
      manager,
      actions,
      persistence,
      'web',
      creditReservations,
      modelRouting,
      auth,
      chips,
      resources
    ).agent_list({});
    const session = listResult.sessions.find((candidate) => candidate.id === sessionStatusMatch.sessionId);
    if (!session) {
      sendJsonNoStore(response, 404, { error: 'Session not found' });
      return;
    }
    sendJsonNoStore(response, 200, redactExternalSessionResult(session));
    return;
  }

  // POST /rpc
  if (method === 'POST' && pathname === '/rpc') {
    const requestActions = getRequestActions(request as AuthenticatedRequest, manager, actions, persistence, 'rpc', creditReservations, modelRouting, auth, chips, resources);
    await handleJsonRpc(
      request,
      response,
      createWebRpcActions(request as AuthenticatedRequest, manager, requestActions, auth, chips, chipCatalogRequired, prompts, resources, persistence, logger, modelRouting, scopeSmallThreshold)
    );
    return;
  }

  const streamMatch = matchSessionRoute(pathname, 'stream');
  if (method === 'GET' && streamMatch) {
    const requestActions = getRequestActions(request as AuthenticatedRequest, manager, actions, persistence, 'web', creditReservations, modelRouting, auth, chips, resources);
    const snapshot = await requestActions.agent_log({ sessionId: streamMatch.sessionId });
    const persistedMessages = await loadPersistedConversationMessages(persistence, streamMatch.sessionId);
    // P2-1 (multi-agent audit): re-check authorization on every SSE event so the
    // stream closes when grants are revoked mid-session (chip / document / scope).
    const assertStillAuthorized = buildSseAuthorizationChecker(
      auth,
      request as AuthenticatedRequest,
      manager,
      chips,
      resources,
      streamMatch.sessionId
    );
    handleSseStream(
      request as AuthenticatedRequest,
      response,
      manager,
      conversationHistory,
      streamMatch.sessionId,
      snapshot,
      persistedMessages,
      assertStillAuthorized
    );
    return;
  }

  // GET /sessions/:id/log
  const logMatch = matchSessionRoute(pathname, 'log');
  if (method === 'GET' && logMatch) {
    const params = Object.fromEntries(url.searchParams.entries());
    sendJson(
      response,
      200,
      await getRequestActions(request as AuthenticatedRequest, manager, actions, persistence, 'web', creditReservations, modelRouting, auth, chips, resources).agent_log(
        AgentActionSchemas.agent_log.parse({ ...params, sessionId: logMatch.sessionId })
      ).then(async (payload) => {
        const liveLog = params.tail === undefined && params.offset === undefined && params.limit === undefined
          ? manager.log(logMatch.sessionId)
          : {
              output: payload.output,
              truncated: payload.truncated,
              totalChars: payload.totalChars,
              offset: payload.offset,
              limit: payload.limit
            };
        const liveMessages = buildConversationMessages(
          manager,
          conversationHistory,
          logMatch.sessionId,
          liveLog
        );
        const persistedMessages = await loadPersistedConversationMessages(persistence, logMatch.sessionId);
        return {
          ...payload,
          assistantResult: payload.result,
          messages: mergeConversationMessages(persistedMessages, liveMessages),
          rawOutputExposed: false
        };
      })
    );
    return;
  }

  const historyMatch = matchSessionRoute(pathname, 'history');
  if (method === 'GET' && historyMatch) {
    if (!persistence) {
      sendJson(response, 404, { error: 'Session not found' });
      return;
    }
    const user = (request as AuthenticatedRequest).user;
    if (!user?.userId) {
      throw new HttpError(401, 'Authentication required');
    }
    const meta = await persistence.sessionStore.readSessionMeta(historyMatch.sessionId);
    if (!meta || meta.userId !== user.userId) {
      sendJson(response, 404, { error: 'Session not found' });
      return;
    }
    const authorizationSummary = chips || resources
      ? await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips)
      : undefined;
    if (authorizationSummary && !isSessionAuthorizationSnapshotCurrent(meta, authorizationSummary, resources?.catalog ?? null)) {
      throw new HttpError(403, 'Access to this session has been revoked.');
    }
    const detail = await persistence.sessionStore.readUserSessionHistory(
      user.userId,
      historyMatch.sessionId,
      parsePagination(url)
    );
    if (!detail) {
      sendJson(response, 404, { error: 'Session not found' });
      return;
    }
    const liveSession = mapOwnedLiveConversationSessions(manager.list(), user.userId).get(detail.summary.sessionId);
    const projectedSummary = projectLiveConversationTurnState(detail.summary, liveSession);
    sendJson(response, 200, {
      ...projectedSummary,
      id: projectedSummary.sessionId,
      sessionId: projectedSummary.sessionId,
      requiresNewScopeQuery: isScopeHistorySessionRestartOnly(projectedSummary) && !liveSession,
      messages: injectAssistantMessages(detail.transcript),
      transcript: detail.transcript
    });
    return;
  }

  const sendMatch = matchSessionRoute(pathname, 'send');
  if (method === 'POST' && sendMatch) {
    const body = await readJsonObject(request);
    const locale = parseOptionalWebLocale(body.locale);
    const authenticatedRequest = request as AuthenticatedRequest;
    const requestUser = authenticatedRequest.user;
    const userRole = requestUser?.role;
    const displayData = typeof body.data === 'string' ? body.data : '';

    // Authorize the live session before any request-controlled side effect.
    // Prompt-state mutation and image materialization both happen before
    // agent_send, so relying only on agent_send's ownership check would let a
    // cross-tenant request mutate another user's prompt state or write files
    // into that session's isolated workspace before eventually returning 404.
    const session = manager.list().find((s) => s.id === sendMatch.sessionId);
    if (session && requestUser?.userId && session.userId !== requestUser.userId) {
      throw new HttpError(404, 'Session not found');
    }
    if (session && (chips || resources)) {
      const summary = await buildRequestAuthorizationSummary(auth, authenticatedRequest, chips);
      if (summary && !isSessionAuthorizationSnapshotCurrent(session, summary, resources?.catalog ?? null)) {
        throw new HttpError(403, 'Access to this session has been revoked.');
      }
    }
    const liveConversationSession = session?.status === 'running' && session.sessionMode === 'conversation'
      ? session
      : undefined;

    // Handle every_turn system prompt injection for subsequent turns only
    // after ownership and current authorization have been established.
    let processedBody = { ...body };
    if (prompts && userRole) {
      if (liveConversationSession) {
        const effectiveRole = userRole;
        const chipId = liveConversationSession.chipId ?? '';
        const policy = getInjectionPolicy(effectiveRole, prompts.roleConfig);

        if (policy === 'every_turn') {
          // Retrieve or create session state
          let state = prompts.sessionStates.get(sendMatch.sessionId);
          if (!state) {
            state = createInjectorState();
            prompts.sessionStates.set(sendMatch.sessionId, state);
          }

          // Rebuild composed prompt for this session
          const composed = await buildSessionSystemPrompt(prompts.catalog, effectiveRole, chipId);
          // session.cwd is the isolated execution copy; the workspace label must stay the stable
          // source chip directory, so re-resolve it from the catalog instead of leaking the copy.
          let workspaceLabelCwd = liveConversationSession.cwd;
          if (chipId && chips) {
            try {
              workspaceLabelCwd = (await resolveChipWorkspace(chips.catalog, chipId)).cwd;
            } catch {
              workspaceLabelCwd = liveConversationSession.cwd;
            }
          }
          const promptForTurn = chipId
            ? withWorkspaceSystemContext(composed, { chipId, cwd: workspaceLabelCwd })
            : composed;
          const injected = injectSystemPrompt(state, policy, promptForTurn);

          if (injected) {
            // Prepend system prompt to user data for every_turn policy
            processedBody = {
              ...processedBody,
              data: injected + '\n\n' + (processedBody.data ?? '')
            };
          }
        }
      }
    }

    // Every multimodal turn must materialize its uploads into the session's
    // isolated cwd. Passing the signed HTTP URL to Claude Code only gives it
    // text; rewriting to ./chat-images/... lets the Read tool inspect pixels.
    if (
      liveConversationSession?.chatMode === 'multimodal' &&
      liveConversationSession.cwd &&
      typeof processedBody.data === 'string' &&
      containsChatImageInput(processedBody.data)
    ) {
      const materialized = await materializeChatImagesIntoWorkspace({
        task: processedBody.data,
        cwd: liveConversationSession.cwd,
        dataDir: persistence?.dataDir ?? resolveDataDir(),
        userId: requestUser?.userId
      });
      if (containsChatImageInput(materialized.task)) {
        throw new HttpError(410, 'One or more chat images are unavailable or expired.', 'CHAT_IMAGE_UNAVAILABLE');
      }
      processedBody = { ...processedBody, data: materialized.task };
    }
    const requestActions = getRequestActions(
      authenticatedRequest,
      manager,
      actions,
      persistence,
      'web',
      creditReservations,
      modelRouting,
      auth,
      chips,
      resources,
      locale
    );
    const runningSession = liveConversationSession;
    const conversationOutputStart = runningSession ? manager.log(sendMatch.sessionId).totalChars : undefined;
    const payload = runningSession
      ? await requestActions.agent_send(
          AgentActionSchemas.agent_send.parse({
            sessionId: sendMatch.sessionId,
            data: typeof processedBody.data === 'string' ? processedBody.data : '',
            displayData,
            submit: typeof body.submit === 'boolean' ? body.submit : undefined
          })
        )
      : await resumeHistoricalSession(
          request as AuthenticatedRequest,
          manager,
          auth,
          logger,
          persistence,
          chips,
          prompts,
          creditReservations,
          sendMatch.sessionId,
          processedBody,
          displayData,
          locale
        );
    if (displayData) {
      recordConversationInput(manager, conversationHistory, sendMatch.sessionId, displayData, conversationOutputStart);
    }
    sendJson(response, 200, payload);
    return;
  }

  // DELETE /sessions/:id
  const sessionMatch = matchSessionRoute(pathname);
  if (method === 'DELETE' && sessionMatch) {
    await getRequestActions(request as AuthenticatedRequest, manager, actions, persistence, 'web', creditReservations, modelRouting, auth, chips, resources).agent_kill({
      sessionId: sessionMatch.sessionId
    });
    response.statusCode = 204;
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

function getRequestActions(
  request: AuthenticatedRequest,
  manager: SessionManager,
  fallbackActions: SessionActions,
  persistence?: PersistenceRuntime,
  source: SessionSource = 'rpc',
  creditReservations?: SessionActionOptions['creditReservations'],
  modelRouting?: ModelRoutingRuntime,
  auth?: AuthRuntime | null,
  chips?: ChipRuntime | null,
  resources?: ResourceRuntime | null,
  responseLocale?: AnnouncementLocale
): SessionActions {
  return request.user?.userId
    ? createSessionActions(manager, {
        scopeUserId: request.user.userId,
        userSnapshot: request.user,
        persistence,
        source,
        creditReservations,
        modeRoleMapping: modelRouting?.config.modeRoleMapping,
        responseLocale,
        ...buildSessionRevocationRecheckOptions(auth, request, chips, resources)
      })
    : persistence || source !== 'rpc'
      ? createSessionActions(manager, {
          persistence,
          source,
          creditReservations,
          modeRoleMapping: modelRouting?.config.modeRoleMapping,
          responseLocale
        })
      : fallbackActions;
}

// V2：把「按会话复验」用的授权摘要提供者 + 资源目录 getter 抽成一处，供 Web REST（/log,
// /stream,/send,DELETE）与 /rpc 共用，避免各路由各写一份。resources.catalog 是内存中随
// admin 编辑同步更新的对象，取当下引用即可，不需要每次都重新解析文件。
function buildSessionRevocationRecheckOptions(
  auth: AuthRuntime | null | undefined,
  request: AuthenticatedRequest,
  chips: ChipRuntime | null | undefined,
  resources: ResourceRuntime | null | undefined
): Pick<SessionActionOptions, 'getAuthorizationSummary' | 'resourceCatalog'> {
  if (!auth) {
    return {};
  }
  return {
    getAuthorizationSummary: () => buildRequestAuthorizationSummary(auth, request, chips ?? null),
    resourceCatalog: () => resources?.catalog ?? null
  };
}

// P2-1 (multi-agent audit): build an authorization re-check closure suitable for
// use by the SSE stream handler. Returns true while the requesting user is still
// allowed to see the given session's outputs; returns false once grants have
// been revoked. We delegate the actual check to assertSessionStillAuthorized
// via a transient SessionActions instance so that the SSE path uses the same
// revocation semantics as agent_log / agent_send / agent_poll / agent_kill.
//
// Without this, the SSE stream only noticed revocation when the entire session
// was removed from the manager registry (e.g. user deletion). Grant revocation
// (chip / document / scopePreset) leaves the session in place, so before this
// fix the stream would keep streaming output to a user whose grants had been
// taken away.
// F4: cache the dynamic import resolution at module scope so the per-event
// authorization check doesn't pay the cost of re-awaiting import() on every
// output/state/keepalive event.
let _sessionActionsModulePromise: Promise<typeof import('./server/session-actions.js')> | null = null;
function loadSessionActionsModule() {
  if (!_sessionActionsModulePromise) {
    _sessionActionsModulePromise = import('./server/session-actions.js');
  }
  return _sessionActionsModulePromise;
}

function buildSseAuthorizationChecker(
  auth: AuthRuntime | null | undefined,
  request: AuthenticatedRequest,
  manager: SessionManager,
  chips: ChipRuntime | null | undefined,
  resources: ResourceRuntime | null | undefined,
  sessionId: string
): () => Promise<boolean> {
  if (!auth) {
    // No auth context: auth already gated entry; assume authorized.
    return async () => true;
  }
  // We can't import createSessionActions / assertSessionStillAuthorized at
  // module scope without an import cycle (session-actions.ts would need to
  // import from http-server.ts), so use a lazy require to break the cycle.
  // The promise is cached at module scope (F4) so we only pay the import
  // cost once per process, not once per SSE event.
  const modulePromise = loadSessionActionsModule();
  return async () => {
    try {
      const { assertSessionStillAuthorizedForUser: assert } = await modulePromise;
      const summary = await buildRequestAuthorizationSummary(auth, request, chips ?? null);
      if (!summary) {
        return true;
      }
      // We rely on a per-request closure that resolves the session lazily and
      // calls the same revocation predicate that the rest of the action layer
      // uses. assertSessionStillAuthorizedForUser is the public counterpart of
      // the private assertSessionStillAuthorized inside createSessionActions.
      return await assert(manager, sessionId, summary, resources?.catalog ?? null);
    } catch {
      // Fail closed: treat unexpected errors as revocation so the stream ends.
      return false;
    }
  };
}

function createCreditReservationProvider(authRuntime: Promise<AuthRuntime | null>): NonNullable<SessionActionOptions['creditReservations']> {
  return {
    async reserve(userId, units) {
      const auth = await authRuntime;
      if (!auth) {
        throw new Error('Credit reservations require authentication');
      }
      const reservationId = crypto.randomUUID();
      const debit = await auth.userStore.reserveCreditBalanceUnits(userId, reservationId, units);
      return {
        reservationId,
        balanceBeforeUnits: debit.balanceBeforeUnits,
        balanceAfterUnits: debit.balanceAfterUnits
      };
    },
    async commit(reservationId) {
      const auth = await authRuntime;
      await auth?.userStore.commitCreditReservation(reservationId);
    },
    async release(reservationId) {
      const auth = await authRuntime;
      if (!auth) {
        return;
      }
      await auth.userStore.releaseCreditReservation(reservationId);
    }
  };
}

export async function reconcilePersistedCreditReservations(input: {
  persistence: PersistenceRuntime;
  userStore: Pick<
    AuthRuntime['userStore'],
    'commitCreditReservation' | 'releaseCreditReservation' | 'getCreditBalanceUnits' | 'listCreditReservations'
  >;
  creditLedger: CreditLedger;
  activeSessionIds?: ReadonlySet<string>;
  logger?: Logger;
}): Promise<{ committed: string[]; released: string[]; missing: string[] }> {
  const committed: string[] = [];
  const released: string[] = [];
  const missing: string[] = [];
  const entries = await input.persistence.sessionStore.readSessionIndex();
  const referencedReservationIds = new Set<string>();

  for (const entry of entries) {
    const meta = await input.persistence.sessionStore.readSessionMeta(entry.sessionId);
    if (!meta?.creditReservation || !meta.userId) {
      continue;
    }
    const reservation = meta.creditReservation;
    referencedReservationIds.add(reservation.reservationId);
    if (input.activeSessionIds?.has(entry.sessionId)) {
      continue;
    }
    const requestId = reservation.requestId ?? `${meta.sessionId}:recovered`;
    const existingLedgerRecord = (await input.creditLedger.queryAll({ sessionId: meta.sessionId }))
      .some((record) => record.requestId === requestId);
    const units = meta.creditUnits ?? Math.max(0, reservation.balanceBeforeUnits - reservation.balanceAfterUnits);
    const shouldCommit = meta.lastTurnResult?.status === 'done';

    if (shouldCommit) {
      if (!existingLedgerRecord) {
        await input.creditLedger.append({
          userId: meta.userId,
          username: meta.username,
          entry: meta.source ?? 'web',
          modelId: meta.modelId,
          units,
          status: 'charged',
          reason: 'recovered_completed_turn',
          balanceBeforeUnits: reservation.balanceBeforeUnits,
          balanceAfterUnits: reservation.balanceAfterUnits,
          sessionId: meta.sessionId,
          requestId
        });
      }
      const found = await input.userStore.commitCreditReservation(reservation.reservationId);
      (found ? committed : missing).push(meta.sessionId);
    } else {
      const found = await input.userStore.releaseCreditReservation(reservation.reservationId);
      if (found) {
        released.push(meta.sessionId);
        if (!existingLedgerRecord) {
          const balanceUnits = await input.userStore.getCreditBalanceUnits(meta.userId);
          await input.creditLedger.append({
            userId: meta.userId,
            username: meta.username,
            entry: meta.source ?? 'web',
            modelId: meta.modelId,
            units: 0,
            status: 'failure',
            reason: 'recovered_interrupted_turn',
            balanceBeforeUnits: balanceUnits,
            balanceAfterUnits: balanceUnits,
            sessionId: meta.sessionId,
            requestId
          });
        }
      } else {
        missing.push(meta.sessionId);
      }
    }

    await input.persistence.sessionStore.updateSessionMeta(meta.sessionId, { creditReservation: undefined });
    await input.persistence.recordSessionEvent(meta.sessionId, {
      event: 'credit_reservation_reconciled',
      details: {
        requestId,
        action: shouldCommit ? 'commit' : 'release',
        reservationFound: !missing.includes(meta.sessionId)
      }
    });
  }

  // A crash can occur after users.json persisted a hold but before SessionMeta
  // recorded its reservation id. Such holds have no request that can ever
  // commit them, so release them on startup after collecting every durable
  // SessionMeta reference.
  let orphanReleasedCount = 0;
  for (const hold of input.userStore.listCreditReservations()) {
    if (referencedReservationIds.has(hold.reservationId)) continue;
    if (await input.userStore.releaseCreditReservation(hold.reservationId)) {
      orphanReleasedCount += 1;
    }
  }

  if (committed.length || released.length || missing.length || orphanReleasedCount) {
    input.logger?.info('credit_reservations_reconciled', 'Persisted credit reservations reconciled', {
      metadata: {
        committedCount: committed.length,
        releasedCount: released.length,
        missingCount: missing.length,
        orphanReleasedCount
      }
    });
  }
  return { committed, released, missing };
}

async function reserveHttpCredits(
  reservations: NonNullable<SessionActionOptions['creditReservations']>,
  userId: string,
  creditUnits: number
): Promise<{ reservationId: string; balanceBeforeUnits: number; balanceAfterUnits: number }> {
  try {
    return await reservations.reserve(userId, creditUnits);
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient credits') {
      throw new HttpError(402, 'Insufficient credits for this mode.', 'INSUFFICIENT_CREDITS', { creditUnits });
    }
    throw error;
  }
}

async function recordSpawnRecords(
  persistence: PersistenceRuntime,
  sessionId: string,
  meta: {
    sessionId: string;
    userId?: string;
    username?: string;
    userRole?: string;
    role?: string;
    agentType: string;
    chipId?: string;
    documentId?: string;
    scopePresetId?: string;
    allowedChipIds?: string[];
    allowedDocumentIds?: string[];
    scopeDescriptor?: ScopeDescriptor;
    scopeWorkspace?: unknown;
    cwd: string;
    task: string;
    sessionMode?: 'oneshot' | 'conversation';
    chatMode?: ChatMode;
    modelId?: string;
    claudeModelRole?: import('./model-routing.js').ClaudeModelRole;
    creditUnits?: number;
    creditReservation?: SessionMeta['creditReservation'];
    source: SessionSource;
    turnId: string;
  }
): Promise<void> {
  const role = meta.role ?? meta.userRole;
  await persistence.recordSessionCreated({
    sessionId,
    userId: meta.userId,
    username: meta.username,
    role,
    agentType: meta.agentType,
    chipId: meta.chipId,
    documentId: meta.documentId,
    scopePresetId: meta.scopePresetId,
    allowedChipIds: meta.allowedChipIds,
    allowedDocumentIds: meta.allowedDocumentIds,
    scopeDescriptor: meta.scopeDescriptor,
    scopeWorkspace: meta.scopeWorkspace as never,
    cwd: meta.cwd,
    task: meta.task,
    sessionMode: meta.sessionMode,
    chatMode: meta.chatMode,
    modelId: meta.modelId,
    claudeModelRole: meta.claudeModelRole,
    creditUnits: meta.creditUnits,
    creditReservation: meta.creditReservation,
    source: meta.source
  });
  await persistence.recordUserTurn(sessionId, {
    role: 'user',
    turnId: meta.turnId,
    text: meta.task,
    createdAt: new Date().toISOString(),
    outputStart: 0,
    chatMode: meta.chatMode,
    modelId: meta.modelId,
    claudeModelRole: meta.claudeModelRole,
    creditUnits: meta.creditUnits,
    question: {
      sessionId,
      turnId: meta.turnId,
      userId: meta.userId,
      username: meta.username,
      role,
      chipId: meta.chipId,
      chatMode: meta.chatMode,
      modelId: meta.modelId,
      claudeModelRole: meta.claudeModelRole,
      creditUnits: meta.creditUnits,
      source: meta.source
    }
  });
  await persistence.recordSessionEvent(sessionId, {
    event: 'agent_spawn',
    turnId: meta.turnId,
    details: {
      source: meta.source,
      userId: meta.userId,
      username: meta.username,
      role,
      agentType: meta.agentType,
      sessionMode: meta.sessionMode,
      chatMode: meta.chatMode,
      modelId: meta.modelId,
      claudeModelRole: meta.claudeModelRole,
      creditUnits: meta.creditUnits,
      creditReservation: meta.creditReservation,
      chipId: meta.chipId,
      documentId: meta.documentId,
      scopePresetId: meta.scopePresetId,
      allowedChipIds: meta.allowedChipIds,
      allowedDocumentIds: meta.allowedDocumentIds,
      scopeDescriptor: meta.scopeDescriptor,
      scopeWorkspace: meta.scopeWorkspace
    }
  });
}

function createWebRpcActions(
  request: AuthenticatedRequest,
  manager: SessionManager,
  actions: SessionActions,
  auth: AuthRuntime | null,
  chips: ChipRuntime | null,
  chipCatalogRequired: boolean,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  modelRouting: ModelRoutingRuntime,
  scopeSmallThreshold: number = DEFAULT_SCOPE_SMALL_THRESHOLD
): SessionActions {
  return {
    ...actions,
    async agent_spawn(input) {
      assertPublicSpawnControlsAbsent(input, 'web-rpc');
      assertSearchModeSelectableForRequest(
        request,
        'web-rpc',
        input.chatMode,
        input.model,
        containsChatImageInput(input.task),
        modelRouting
      );
      if (!chips) {
        if (auth && chipCatalogRequired) {
          throw new HttpError(
            503,
            'The datasheet resource catalog is unavailable. Session creation is temporarily disabled.',
            'RESOURCE_CATALOG_UNAVAILABLE'
          );
        }
        // Explicit local --no-auth development mode may still use the generic
        // agent runner, but the public trusted-field guard above always applies.
        return actions.agent_spawn(input);
      }
      const summary = await buildRequestAuthorizationSummary(auth, request, chips);
      let scopeSession = await prepareAuthorizedScopeSession({
        summary,
        chips,
        resources,
        persistence,
        input,
        entryPoint: 'rpc'
      });

      // V11：/sessions 已支持动态 scope 描述符（group/global）路由到
      // prepareAuthorizedDynamicScopeSession；/rpc 补齐同款平价，仅在 preset/单芯片
      // 路径未命中时才尝试（与 /sessions 的顺序一致）。
      if (!scopeSession && input.scope && (input.scope.mode === 'group' || input.scope.mode === 'global')) {
        const routing = await prepareAuthorizedDynamicScopeSession({
          summary,
          chips,
          resources,
          persistence,
          descriptor: input.scope,
          request,
          prompts,
          entryPoint: 'rpc',
          threshold: scopeSmallThreshold
        });
        if (routing?.kind === 'large') {
          // M3 两阶段大档托管会话尚未在 /rpc 接线（仅 /sessions 支持后台流式）；
          // 明确结构化拒绝，而非静默丢弃 scope 或误报 400 chipId-required。
          throw new HttpError(
            501,
            'Large dynamic scope (file count exceeds the small-scope threshold) is not yet supported on /rpc. Use POST /sessions for this scope, or narrow the scope so it resolves within the small-scope threshold.',
            'SCOPE_TOO_LARGE_FOR_RPC'
          );
        }
        if (routing?.kind === 'small') {
          scopeSession = routing.session;
        }
      }

      if (scopeSession) {
        let ownershipTransferred = false;
        try {
          if (summary) {
            if (typeof input.documentId === 'string') {
              assertAuthorizedDocument(summary, resources, input.documentId, persistence, logger, {
                entry: 'rpc',
                action: 'agent_spawn'
              });
            }
            if (typeof input.scopePresetId === 'string') {
              assertAuthorizedScopePreset(summary, resources, input.scopePresetId, persistence, logger, {
                entry: 'rpc',
                action: 'agent_spawn'
              });
            }
          }
          const originalTask = input.task;
          const task = await materializePublicChatTask({
            task: originalTask,
            cwd: scopeSession.cwd,
            dataDir: persistence?.dataDir ?? resolveDataDir(),
            userId: request.user?.userId
          });
          const scopedPrompt = withScopeWorkspaceSystemContext(input.systemPrompt, scopeSession);
          const scopeHardening = await scopeLaunchHardening(chips.catalog.knowledgeBaseRoot);
          ownershipTransferred = true;
          return await actions.agent_spawn({
            ...input,
            task,
            displayTask: originalTask,
            cwd: scopeSession.cwd,
            chipId: undefined,
            documentId: scopeSession.documentId,
            scopePresetId: scopeSession.scopePresetId,
            allowedChipIds: scopeSession.allowedChipIds,
            allowedDocumentIds: scopeSession.allowedDocumentIds,
            scopeWorkspace: scopeSession.safeSummary,
            usedSources: scopeSession.safeSummary.usedSources,
            sourceCitationSummary: scopeSession.safeSummary.sourceCitationSummary,
            scopeWorkspaceCleanup: scopeSession.cleanup,
            denyReadRoots: scopeHardening.denyReadRoots,
            allowedTools: scopeHardening.allowedTools,
            permissionMode: scopeHardening.permissionMode,
            systemPrompt: scopedPrompt
          });
        } finally {
          if (!ownershipTransferred) {
            await scopeSession.cleanup().catch(() => undefined);
          }
        }
      }
      if (typeof input.chipId !== 'string' || input.chipId.trim() === '') {
        throw new HttpError(400, 'chipId is required when chips are configured');
      }
      if (summary) {
        assertAuthorizedChipResource(summary, chips, request.user, input.chipId, prompts, persistence, logger, {
          entry: 'rpc',
          action: 'agent_spawn'
        });
        if (typeof input.documentId === 'string') {
          assertAuthorizedDocument(summary, resources, input.documentId, persistence, logger, {
            entry: 'rpc',
            action: 'agent_spawn'
          });
        }
        if (typeof input.scopePresetId === 'string') {
          assertAuthorizedScopePreset(summary, resources, input.scopePresetId, persistence, logger, {
            entry: 'rpc',
            action: 'agent_spawn'
          });
        }
      }
      const resolved = await resolveChipWorkspace(chips.catalog, input.chipId as string);
      if (summary && !canRequestAccessChip(summary, resolved.chipId)) {
        throw new HttpError(403, 'The requested resource is not available to this identity.');
      }

      const role = request.user?.role ?? 'customer';
      let systemPrompt = input.systemPrompt;
      if (prompts) {
        const composed = await buildSessionSystemPrompt(prompts.catalog, role, resolved.chipId);
        const policy = getInjectionPolicy(role, prompts.roleConfig);
        const state = createInjectorState();
        systemPrompt = injectSystemPrompt(state, policy, withWorkspaceSystemContext(composed, resolved)) ?? systemPrompt;
      } else {
        systemPrompt = withWorkspaceSystemContext(systemPrompt, resolved);
      }

      const dataDir = persistence?.dataDir ?? resolveDataDir();
      const launch = await prepareChipLaunch({
        chipSourceCwd: resolved.cwd,
        knowledgeBaseRoot: chips.catalog.knowledgeBaseRoot,
        dataDir
      });
      let ownershipTransferred = false;
      try {
        const originalTask = input.task;
        const task = await materializePublicChatTask({
          task: originalTask,
          cwd: launch.cwd,
          dataDir,
          userId: request.user?.userId
        });
        ownershipTransferred = true;
        return await actions.agent_spawn({
          ...input,
          task,
          displayTask: originalTask,
          cwd: launch.cwd,
          chipId: resolved.chipId,
          scopeWorkspace: undefined,
          denyReadRoots: launch.denyReadRoots,
          allowedTools: launch.allowedTools,
          permissionMode: launch.permissionMode,
          scopeWorkspaceCleanup: launch.cleanup,
          systemPrompt
        });
      } finally {
        if (!ownershipTransferred) {
          await launch.cleanup().catch(() => undefined);
        }
      }
    },
    async agent_send(input) {
      // Authenticate ownership and current resource grants before writing an
      // uploaded image into the live workspace.
      await actions.agent_log({ sessionId: input.sessionId, limit: 1 });
      const session = manager.list().find((candidate) => candidate.id === input.sessionId);
      if (containsChatImageInput(input.data)) {
        if (!session || session.chatMode !== 'multimodal') {
          throw new HttpError(400, 'Image input requires a multimodal session.', 'CHAT_MODE_MISMATCH');
        }
        const data = await materializePublicChatTask({
          task: input.data,
          cwd: session.cwd,
          dataDir: persistence?.dataDir ?? resolveDataDir(),
          userId: request.user?.userId
        });
        return actions.agent_send({ ...input, data, displayData: input.data });
      }
      return actions.agent_send(input);
    }
  };
}

async function materializePublicChatTask(input: {
  task: string;
  cwd: string;
  dataDir: string;
  userId?: string;
  cleanupOnError?: () => Promise<void>;
}): Promise<string> {
  if (!containsChatImageInput(input.task)) {
    return input.task;
  }
  try {
    const materialized = await materializeChatImagesIntoWorkspace(input);
    if (containsChatImageInput(materialized.task)) {
      throw new HttpError(410, 'One or more chat images are unavailable or expired.', 'CHAT_IMAGE_UNAVAILABLE');
    }
    return materialized.task;
  } catch (error) {
    await input.cleanupOnError?.().catch(() => undefined);
    throw error;
  }
}

function parsePagination(url: URL): { offset?: number; limit?: number } {
  return {
    offset: parseOptionalNonNegativeInt(url.searchParams.get('offset')),
    limit: parseOptionalPositiveInt(url.searchParams.get('limit'))
  };
}

function parseSessionHistoryQuery(url: URL): {
  userId?: string;
  username?: string;
  role?: string;
  chipId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
} {
  return {
    userId: optionalQueryString(url, 'userId'),
    username: optionalQueryString(url, 'username'),
    role: optionalQueryString(url, 'role'),
    chipId: optionalQueryString(url, 'chipId'),
    from: optionalQueryString(url, 'from'),
    to: optionalQueryString(url, 'to'),
    keyword: optionalQueryString(url, 'keyword'),
    ...parsePagination(url)
  };
}

function parseQuestionQuery(url: URL): {
  sessionId?: string;
  userId?: string;
  username?: string;
  role?: string;
  chipId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
} {
  return {
    sessionId: optionalQueryString(url, 'sessionId'),
    userId: optionalQueryString(url, 'userId'),
    username: optionalQueryString(url, 'username'),
    role: optionalQueryString(url, 'role'),
    chipId: optionalQueryString(url, 'chipId'),
    from: optionalQueryString(url, 'from'),
    to: optionalQueryString(url, 'to'),
    keyword: optionalQueryString(url, 'keyword'),
    ...parsePagination(url)
  };
}

function optionalQueryString(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function resolveObservabilityRange(value: string | null): { ok: true; window: { from: string; to: string } } | { ok: false } {
  const range = value?.trim() || '7d';
  const durations: Record<string, number> = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  };
  const durationMs = durations[range];
  if (durationMs === undefined) {
    return { ok: false };
  }
  const now = Date.now();
  return {
    ok: true,
    window: {
      from: new Date(now - durationMs).toISOString(),
      to: new Date(now).toISOString()
    }
  };
}

function parseOptionalNonNegativeInt(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

function parseOptionalPositiveInt(value: string | null): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : undefined;
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Session not found:');
}

async function resumeHistoricalSession(
  request: AuthenticatedRequest,
  manager: SessionManager,
  auth: AuthRuntime | null,
  logger: Logger,
  persistence: PersistenceRuntime | undefined,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  creditReservations: SessionActionOptions['creditReservations'] | undefined,
  sessionId: string,
  body: Record<string, unknown>,
  displayData: string,
  responseLocale?: AnnouncementLocale
): Promise<{
  sessionId: string;
  sent: true;
  submitted: true;
  resumed: true;
  status: string;
  turnState?: string;
  chatMode?: string;
  modelId?: string;
  creditUnits?: number;
  claudeSessionId?: string;
}> {
  if (!persistence) {
    throw new HttpError(404, 'Session not found');
  }
  const user = request.user;
  if (!user?.userId) {
    throw new HttpError(401, 'Authentication required');
  }
  const data = typeof body.data === 'string' ? body.data : '';
  if (!data.trim()) {
    throw new HttpError(400, 'data is required');
  }
  const meta = await persistence.sessionStore.readSessionMeta(sessionId);
  if (!meta || meta.userId !== user.userId) {
    throw new HttpError(404, 'Session not found');
  }
  if (meta.creditReservation) {
    throw new HttpError(
      409,
      'The previous turn is still settling. Retry after settlement recovery.',
      'TURN_SETTLEMENT_INCOMPLETE'
    );
  }
  if (meta.scopePresetId || meta.scopeWorkspace || meta.scopeDescriptor?.mode === 'group' || meta.scopeDescriptor?.mode === 'global') {
    throw new HttpError(
      409,
      'Scope search sessions are one-shot. Start a new search to apply current scope authorization.',
      'SCOPE_SESSION_RESTART_REQUIRED'
    );
  }
  if (!meta.claudeSessionId) {
    throw new HttpError(409, 'Historical session cannot be resumed without claudeSessionId');
  }
  const summary = await buildRequestAuthorizationSummary(auth, request, chips);
  if (summary) {
    if (chips && meta.chipId) {
      assertAuthorizedChipResource(summary, chips, request.user, meta.chipId, prompts, persistence, logger, {
        entry: 'web',
        action: 'agent_resume'
      });
    }
    if (meta.modelId) {
      assertAuthorizedResource(summary, { type: 'model', id: meta.modelId }, persistence, logger, {
        entry: 'web',
        action: 'agent_resume'
      });
    }
  }
  if (chips && summary && meta.chipId && !canRequestAccessChip(summary, meta.chipId)) {
    throw new HttpError(403, 'The requested resource is not available to this identity.');
  }
  if (containsChatImageInput(data) && meta.chatMode !== 'multimodal') {
    throw new HttpError(400, 'Image input requires multimodal mode');
  }
  if (meta.chipId) {
    if (!chips) {
      throw new HttpError(
        409,
        'This historical chat cannot be resumed safely. Start a new chat.',
        'CHAT_SESSION_RESTART_REQUIRED'
      );
    }
    try {
      validateHistoricalChipWorkspaceTarget(persistence.dataDir ?? resolveDataDir(), meta.cwd);
    } catch (error) {
      if (error instanceof InvalidChipWorkspaceTargetError) {
        throw new HttpError(
          409,
          'This historical chat cannot be resumed safely. Start a new chat.',
          'CHAT_SESSION_RESTART_REQUIRED'
        );
      }
      throw error;
    }
  }

  const releaseHistoricalResume = await manager.claimHistoricalResume(sessionId);
  try {
  const systemPrompt = await buildResumeSystemPrompt(meta, user.role, prompts, chips);
  assertContextBudget({
    entry: 'web',
    role: user.role,
    userId: user.userId,
    modelId: meta.modelId,
    task: data,
    systemPrompt
  });
  const turnId = `turn-${crypto.randomUUID()}`;
  // Single-chip resume rehydrates the authorized copy at the original cwd so
  // Claude Code can resolve the persisted conversation in its cwd-keyed store.
  let resumeCwd = meta.cwd;
  let launchTask = data;
  let resumeHardening: {
    denyReadRoots?: string[];
    allowedTools?: string[];
    permissionMode?: 'default' | 'acceptEdits' | 'plan';
  } = {};
  let resumeCleanup: (() => Promise<void>) | undefined;
  if (meta.chipId && chips) {
    const resolved = await resolveChipWorkspace(chips.catalog, meta.chipId);
    const dataDir = persistence.dataDir ?? resolveDataDir();
    let launch: Awaited<ReturnType<typeof prepareChipLaunch>>;
    try {
      launch = await prepareChipLaunch({
        chipSourceCwd: resolved.cwd,
        knowledgeBaseRoot: chips.catalog.knowledgeBaseRoot,
        dataDir,
        targetCwd: meta.cwd
      });
    } catch (error) {
      if (error instanceof InvalidChipWorkspaceTargetError) {
        throw new HttpError(
          409,
          'This historical chat cannot be resumed safely. Start a new chat.',
          'CHAT_SESSION_RESTART_REQUIRED'
        );
      }
      throw error;
    }
    resumeCwd = launch.cwd;
    resumeHardening = {
      denyReadRoots: launch.denyReadRoots,
      allowedTools: launch.allowedTools,
      permissionMode: launch.permissionMode
    };
    resumeCleanup = launch.cleanup;
  }
  let creditReservation: Awaited<ReturnType<typeof reserveHttpCredits>> | undefined;
  try {
    if (containsChatImageInput(launchTask)) {
      const materialized = await materializeChatImagesIntoWorkspace({
        task: launchTask,
        cwd: resumeCwd,
        dataDir: persistence.dataDir,
        userId: user.userId
      });
      if (containsChatImageInput(materialized.task)) {
        throw new HttpError(410, 'One or more chat images are unavailable or expired.', 'CHAT_IMAGE_UNAVAILABLE');
      }
      launchTask = materialized.task;
    }

    creditReservation = meta.creditUnits && creditReservations
      ? await reserveHttpCredits(creditReservations, user.userId, meta.creditUnits)
      : undefined;
  } catch (error) {
    await resumeCleanup?.().catch(() => {});
    throw error;
  }
  const persistedCreditReservation = creditReservation
    ? { ...creditReservation, requestId: turnId }
    : undefined;
  const displayText = displayData || data;

  try {
    if (persistedCreditReservation) {
      await persistence.sessionStore.updateSessionMeta(sessionId, {
        creditReservation: persistedCreditReservation
      });
    }
    await persistence.recordUserTurn(sessionId, {
      role: 'user',
      turnId,
      text: displayText,
      createdAt: new Date().toISOString(),
      outputStart: 0,
      chatMode: meta.chatMode,
      modelId: meta.modelId,
      creditUnits: meta.creditUnits,
      question: {
        sessionId,
        turnId,
        userId: user.userId,
        username: user.username,
        role: user.role,
        chipId: meta.chipId,
        chatMode: meta.chatMode,
        modelId: meta.modelId,
        creditUnits: meta.creditUnits,
        source: 'web'
      }
    });
  } catch (error) {
    if (creditReservation) {
      await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined }).catch(() => {});
      await creditReservations?.release(creditReservation.reservationId).catch(() => {});
    }
    await resumeCleanup?.().catch(() => {});
    throw error;
  }

  let session;
  let spawnedByThisRequest = false;
  try {
    session = await manager.spawn({
      sessionId,
      agentType: AgentActionSchemas.agent_spawn.parse({ agentType: meta.agentType, task: launchTask }).agentType,
      task: withResponseLanguageTurnContext(launchTask, responseLocale),
      displayTask: displayText,
      userId: user.userId,
      cwd: resumeCwd,
      chipId: meta.chipId,
      sessionMode: meta.sessionMode ?? 'conversation',
      chatMode: meta.chatMode,
      modelId: meta.modelId as ModelId | undefined,
      claudeModelRole: meta.claudeModelRole,
      creditUnits: meta.creditUnits,
      creditReservation,
      claudeSessionId: meta.claudeSessionId,
      initialTurnCount: meta.turnCount,
      resume: true,
      systemPrompt,
      ...resumeHardening,
      ...(resumeCleanup ? { scopeWorkspaceCleanup: resumeCleanup } : {})
    });
    spawnedByThisRequest = true;
    await persistence.sessionStore.updateSessionMeta(sessionId, {
      turnState: session.turnState,
      turnCount: session.turnCount,
      claudeSessionId: session.claudeSessionId,
      lastMessageAt: new Date().toISOString()
    });
    await persistence.recordSessionEvent(sessionId, {
      event: 'agent_resume',
      turnId,
      details: {
        source: 'web',
        userId: user.userId,
        username: user.username,
        role: user.role,
        chipId: meta.chipId,
        chatMode: meta.chatMode,
        modelId: meta.modelId,
        creditUnits: meta.creditUnits,
        creditReservation: persistedCreditReservation
      }
    });
  } catch (error) {
    if (spawnedByThisRequest) {
      await manager.kill(sessionId).catch(() => {});
    }
    if (creditReservation) {
      await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined }).catch(() => {});
      await creditReservations?.release(creditReservation.reservationId).catch(() => {});
    }
    await resumeCleanup?.().catch(() => {});
    throw error;
  }

  return {
    sessionId,
    sent: true,
    submitted: true,
    resumed: true,
    status: session.status,
    turnState: session.turnState,
    chatMode: session.chatMode,
    modelId: session.modelId,
    creditUnits: session.creditUnits,
    claudeSessionId: session.claudeSessionId
  };
  } finally {
    releaseHistoricalResume();
  }
}

async function buildResumeSystemPrompt(
  meta: SessionMeta,
  role: string,
  prompts: PromptRuntime | null,
  chips: ChipRuntime | null
): Promise<string | undefined> {
  // meta.cwd may be the isolated execution copy; the workspace label must stay the stable source
  // chip directory, so re-resolve it from the catalog when possible instead of leaking the copy.
  let workspaceLabelCwd = meta.cwd;
  if (meta.chipId && chips) {
    try {
      workspaceLabelCwd = (await resolveChipWorkspace(chips.catalog, meta.chipId)).cwd;
    } catch {
      workspaceLabelCwd = meta.cwd;
    }
  }
  if (!prompts) {
    return meta.chipId ? withWorkspaceSystemContext(undefined, { chipId: meta.chipId, cwd: workspaceLabelCwd }) : undefined;
  }
  const composed = await buildSessionSystemPrompt(prompts.catalog, role, meta.chipId ?? '');
  return meta.chipId ? withWorkspaceSystemContext(composed, { chipId: meta.chipId, cwd: workspaceLabelCwd }) : composed;
}

async function handleJsonRpc(
  request: IncomingMessage,
  response: ServerResponse,
  actions: SessionActions
): Promise<void> {
  const payload = await readJsonBody(request);
  const id = isRecord(payload) && 'id' in payload ? payload.id : null;
  const method = isRecord(payload) ? payload.method : undefined;

  if (!isActionName(method)) {
    sendJson(response, 200, {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' }
    });
    return;
  }

  try {
    const params = isRecord(payload) && 'params' in payload ? payload.params : {};
    const result = redactExternalActionResult(method, await callAction(actions, method, params));
    sendJson(response, 200, { jsonrpc: '2.0', id, result });
  } catch (error) {
    if (error instanceof ZodError) {
      sendJson(response, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Invalid params' }
      });
      return;
    }

    throw error;
  }
}

function callAction(actions: SessionActions, method: ActionName, params: unknown): Promise<unknown> {
  switch (method) {
    case 'agent_spawn':
      return actions.agent_spawn(AgentActionSchemas.agent_spawn.parse(params ?? {}));
    case 'agent_log':
      return actions.agent_log(AgentActionSchemas.agent_log.parse(params ?? {}));
    case 'agent_send':
      return actions.agent_send(AgentActionSchemas.agent_send.parse(params ?? {}));
    case 'agent_poll':
      return actions.agent_poll(AgentActionSchemas.agent_poll.parse(params ?? {}));
    case 'agent_kill':
      return actions.agent_kill(AgentActionSchemas.agent_kill.parse(params ?? {}));
    case 'agent_list':
      return actions.agent_list(AgentActionSchemas.agent_list.parse(params ?? {}));
  }
}

async function handleRemoteMcpRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  method: string,
  pathname: string,
  manager: SessionManager,
  auth: AuthRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  mcpHttpSecurity: McpHttpSecurityConfig,
  mcpRateLimiter: RateLimiter,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  modelRouting: ModelRoutingRuntime,
  scopeSmallThreshold: number = DEFAULT_SCOPE_SMALL_THRESHOLD,
  // P1-2 (multi-agent audit): credit reservation provider shared with HTTP path.
  // Without this, Remote MCP agent_spawn / agent_send skip credit reservation
  // entirely and only debit on exit — letting a long-lived transport over-spend.
  creditReservations?: SessionActionOptions['creditReservations']
): Promise<void> {
  cleanupExpiredRemoteMcpTransports(remoteMcpTransports, logger, request, pathname, method, mcpHttpSecurity);

  if (method === 'POST') {
    const body = await readJsonBody(request, mcpHttpSecurity.maxBodyBytes);
    const sessionId = getMcpSessionId(request);

    if (sessionId) {
      const session = remoteMcpTransports.get(sessionId);
      if (!session) {
        logRemoteMcpError(logger, request, pathname, method, 'invalid session ID', { mcpSessionId: sessionId });
        sendMcpJsonRpcError(response, 404, -32000, 'invalid session ID');
        return;
      }

      if (
        !(await validateRemoteMcpSessionAuth(
          request,
          response,
          auth,
          session,
          sessionId,
          remoteMcpTransports,
          logger,
          pathname,
          method,
          mcpHttpSecurity
        ))
      ) {
        return;
      }

      const rateLimit = consumeMcpRateLimit(
        mcpRateLimiter,
        request,
        'mcp:request',
        session.keyFingerprint,
        mcpHttpSecurity.rateLimitMax
      );
      if (!rateLimit.allowed) {
        logMcpRateLimited(logger, request, pathname, method, 'mcp:request', rateLimit, session.keyFingerprint, session);
        sendMcpJsonRpcError(response, 429, -32029, 'Rate limit exceeded');
        return;
      }
      logRemoteMcpToolCall(logger, request, pathname, method, body, sessionId, session);
      await session.transport.handleRequest(request, response, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      logRemoteMcpError(logger, request, pathname, method, 'missing session ID');
      sendMcpJsonRpcError(response, 400, -32000, 'Bad Request: missing session ID');
      return;
    }

    const bearerKey = extractMcpBearerKey(request);
    const keyFingerprint = fingerprintMcpKey(bearerKey);
    const initRateLimit = consumeMcpRateLimit(
      mcpRateLimiter,
      request,
      'mcp:init',
      keyFingerprint,
      mcpHttpSecurity.rateLimitMax
    );
    if (!initRateLimit.allowed) {
      logMcpRateLimited(logger, request, pathname, method, 'mcp:init', initRateLimit, keyFingerprint);
      sendMcpJsonRpcError(response, 429, -32029, 'Rate limit exceeded');
      return;
    }

    const identity = await resolveRemoteMcpIdentity(request, auth, mcpHttpSecurity);
    if (!identity) {
      const authFailureLimit = consumeMcpRateLimit(
        mcpRateLimiter,
        request,
        'mcp:auth-failure',
        keyFingerprint,
        mcpHttpSecurity.verifyRateLimitMax
      );
      if (!authFailureLimit.allowed) {
        logMcpRateLimited(logger, request, pathname, method, 'mcp:auth-failure', authFailureLimit, keyFingerprint);
        sendMcpJsonRpcError(response, 429, -32029, 'Rate limit exceeded');
        return;
      }
      logRemoteMcpAuthFailure(logger, request, pathname, method, 'missing MCP key', {
        hasAuthorization: Boolean(request.headers.authorization)
      });
      sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
      return;
    }

    const { user, key } = identity;
    const transportLimit = checkRemoteMcpTransportLimit(remoteMcpTransports, user.id, mcpHttpSecurity);
    if (transportLimit) {
      logMcpRateLimited(logger, request, pathname, method, transportLimit.limitName, transportLimit, keyFingerprint, {
        userId: user.id,
        username: user.username,
        role: user.role,
        keyFingerprint,
        keyId: key.id,
        keyName: key.name
      });
      sendMcpJsonRpcError(response, 429, -32029, 'Rate limit exceeded');
      return;
    }

    let transport: StreamableHTTPServerTransport;
    const createdAtMs = Date.now();
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAtMs = createdAtMs + mcpHttpSecurity.transportAbsoluteTtlMs;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (mcpSessionId) => {
        remoteMcpTransports.set(mcpSessionId, {
          transport,
          userId: user.id,
          username: user.username,
          role: user.role,
          createdAt,
          createdAtMs,
          lastSeenAt: createdAt,
          lastSeenAtMs: createdAtMs,
          expiresAt: new Date(expiresAtMs).toISOString(),
          expiresAtMs,
          lastKeyTouchAtMs: createdAtMs,
          keyId: key.id,
          keyName: key.name,
          keyFingerprint
        });
        logger.info(LOG_EVENTS.mcpTransportOpen, 'Remote MCP transport opened', {
          userId: user.id,
          metadata: remoteMcpLogMetadata(request, pathname, method, {
            userId: user.id,
            username: user.username,
            role: user.role,
            mcpSessionId,
            createdAt,
            expiresAt: new Date(expiresAtMs).toISOString(),
            keyId: key.id,
            keyName: key.name,
            keyFingerprint
          })
        });
      },
      onsessionclosed: (mcpSessionId) => {
        cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'client_close');
      }
    });
    transport.onclose = () => {
      const mcpSessionId = transport.sessionId;
      if (mcpSessionId) {
        cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'client_close');
      }
    };

    const mcpServer = createMcpServer({
      manager,
      toolProfile: 'remote-customer',
      resolveActions: async () => {
        const currentIdentity = await loadCurrentMcpIdentity(auth!, user.id, key.id);
        return { actions: createRemoteMcpActions(
          manager,
          auth,
          persistence,
          logger,
          currentIdentity.user,
          currentIdentity.key,
          mcpHttpSecurity,
          chips,
          prompts,
          resources,
          modelRouting,
          request,
          scopeSmallThreshold,
          creditReservations
        ) };
      },
      resolveWhoami: async () => {
        const currentIdentity = await loadCurrentMcpIdentity(auth!, user.id, key.id);
        const summary = await buildCurrentMcpAuthorizationSummary(auth!, currentIdentity.user.id, currentIdentity.key.id, chips);
        return {
          whoami: buildMcpWhoamiResponse({
          transport: 'remote',
          authEnabled: true,
          user: currentIdentity.user,
          key: currentIdentity.key,
          keyFingerprint: fingerprintMcpKey(currentIdentity.key.key),
          allowedActions: filterAllowedMcpActions(summary),
          allowedModels: listModelsForAuthorization(summary),
          allowedModes: listSearchModesForAuthorization(summary, 'remote-mcp', getUserCreditBalanceUnits(currentIdentity.user), modelRouting),
          credits: { balanceUnits: getUserCreditBalanceUnits(currentIdentity.user) },
          resources: listVisibleResources(chips, resources, summary, prompts),
          limits: {
            maxBodyBytes: mcpHttpSecurity.maxBodyBytes,
            maxOutputChars: mcpHttpSecurity.maxOutputChars,
            maxPollTimeoutMs: mcpHttpSecurity.maxPollTimeoutMs,
            rateLimitMax: mcpHttpSecurity.rateLimitMax,
            verifyRateLimitMax: mcpHttpSecurity.verifyRateLimitMax,
            maxTransports: mcpHttpSecurity.maxTransports,
            maxTransportsPerUser: mcpHttpSecurity.maxTransportsPerUser
          },
          capabilityNotes: chips
            ? ['Visible resources come from the chip catalog and are resolved server-side.']
            : ['No chip catalog resources are enabled for this Remote MCP endpoint.']
          })
        };
      }
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response, body);
    return;
  }

  const sessionId = getMcpSessionId(request);
  if (!sessionId) {
    logRemoteMcpError(logger, request, pathname, method, 'invalid or missing session');
    sendMcpJsonRpcError(response, 400, -32000, 'invalid or missing session');
    return;
  }

  const session = remoteMcpTransports.get(sessionId);
  if (!session) {
    logRemoteMcpError(logger, request, pathname, method, 'invalid session ID', { mcpSessionId: sessionId });
    sendMcpJsonRpcError(response, 404, -32000, 'invalid session ID');
    return;
  }

  if (
    !(await validateRemoteMcpSessionAuth(
      request,
      response,
      auth,
      session,
      sessionId,
      remoteMcpTransports,
      logger,
      pathname,
      method,
      mcpHttpSecurity
    ))
  ) {
    return;
  }

  const rateLimit = consumeMcpRateLimit(
    mcpRateLimiter,
    request,
    'mcp:request',
    session.keyFingerprint,
    mcpHttpSecurity.rateLimitMax
  );
  if (!rateLimit.allowed) {
    logMcpRateLimited(logger, request, pathname, method, 'mcp:request', rateLimit, session.keyFingerprint, session);
    sendMcpJsonRpcError(response, 429, -32029, 'Rate limit exceeded');
    return;
  }

  await session.transport.handleRequest(request, response);
}

async function resolveRemoteMcpIdentity(
  request: AuthenticatedRequest,
  auth: AuthRuntime | null,
  _mcpHttpSecurity: McpHttpSecurityConfig
): Promise<RemoteMcpIdentity | null> {
  if (!auth) {
    return null;
  }

  const mcpKey = extractMcpBearerKey(request);
  if (!mcpKey) {
    return null;
  }

  const identity = await auth.userStore.lookupUsableMcpKey(mcpKey);
  if (!identity) {
    return null;
  }
  await auth.userStore.touchMcpKey(identity.user.id, identity.key.id);
  return identity;
}

function createRemoteMcpActions(
  manager: SessionManager,
  auth: AuthRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  user: User,
  key: McpKey,
  mcpHttpSecurity: McpHttpSecurityConfig,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  modelRouting: ModelRoutingRuntime,
  request: IncomingMessage,
  scopeSmallThreshold: number = DEFAULT_SCOPE_SMALL_THRESHOLD,
  // P1-2 (multi-agent audit): credit reservation provider. Wired through so
  // agent_spawn / agent_send reserve+commit the same way the HTTP path does,
  // preventing a long-lived Remote MCP transport from over-spending credits.
  creditReservations?: SessionActionOptions['creditReservations']
): McpActions {
  const actions = createSessionActions(manager, {
    scopeUserId: user.id,
    persistence,
    source: 'mcp',
    mcpKeyFingerprint: fingerprintMcpKey(key.key),
    creditReservations,
    userSnapshot: {
      userId: user.id,
      username: user.username,
      role: user.role,
      authorizedModels: getEffectiveModelGrants({
        role: user.role,
        userModelGrants: user.modelGrants,
        mcpKeyModelGrants: key.modelGrants
      }),
      credits: { balanceUnits: getUserCreditBalanceUnits(user) }
    },
    modeRoleMapping: modelRouting.config.modeRoleMapping,
    getAuthorizationSummary: () => auth
      ? buildCurrentMcpAuthorizationSummary(auth, user.id, key.id, chips)
      : buildEffectiveAuthorizationSummaryForMcpFallback(user, key, chips),
    resourceCatalog: () => resources?.catalog ?? null
  });

  return {
    ...actions,
    async agent_spawn(input) {
      assertRemoteMcpCustomerSpawnInput(input);
      const summary = auth
        ? await buildCurrentMcpAuthorizationSummary(auth, user.id, key.id, chips)
        : await buildEffectiveAuthorizationSummaryForMcpFallback(user, key, chips);
      assertAuthorizedResource(summary, { type: 'mcpTool', id: 'agent_spawn' }, persistence, logger, {
        entry: 'mcp',
        action: 'agent_spawn'
      });
      const mode = resolveRemoteMcpSearchMode(user, key, input.chatMode, input.model, input.task, modelRouting);
      assertAuthorizedResource(summary, { type: 'model', id: mode.modelId }, persistence, logger, {
        entry: 'mcp',
        action: 'agent_spawn'
      });
      if (!chips) {
        throw new HttpError(
          400,
          'chipId is required for public Remote MCP. Call agentx_whoami first and use permissions.resources[].id as agent_spawn.chipId; no chip resources are configured for this endpoint, so ask the provider to configure authorized resources.'
        );
      }

      let scopeSession = await prepareAuthorizedScopeSession({
        summary,
        chips,
        resources,
        persistence,
        input,
        entryPoint: 'mcp'
      });

      // V11：Remote MCP 补齐动态 scope 描述符（group/global）平价，与 /sessions、/rpc
      // 同款——仅在 preset/单芯片路径未命中时才尝试。
      if (!scopeSession && input.scope && (input.scope.mode === 'group' || input.scope.mode === 'global')) {
        const routing = await prepareAuthorizedDynamicScopeSession({
          summary,
          chips,
          resources,
          persistence,
          descriptor: input.scope,
          request,
          prompts,
          entryPoint: 'mcp',
          threshold: scopeSmallThreshold
        });
        if (routing?.kind === 'large') {
          // M3 两阶段大档托管会话尚未在 Remote MCP 接线（仅 /sessions 支持后台流式）；
          // 明确结构化拒绝，而非静默丢弃 scope 或误报 400 chipId-required。
          throw new HttpError(
            501,
            'Large dynamic scope (file count exceeds the small-scope threshold) is not yet supported on Remote MCP. Use WebChat POST /sessions for this scope, or narrow the scope so it resolves within the small-scope threshold.',
            'SCOPE_TOO_LARGE_FOR_MCP'
          );
        }
        if (routing?.kind === 'small') {
          scopeSession = routing.session;
        }
      }

      const userScope = { userId: user.id, username: user.username, role: user.role, iat: 0, exp: 0 };
      if (scopeSession) {
        let ownershipTransferred = false;
        try {
          if (typeof input.documentId === 'string') {
            assertAuthorizedDocument(summary, resources, input.documentId, persistence, logger, {
              entry: 'mcp',
              action: 'agent_spawn'
            });
          }
          if (typeof input.scopePresetId === 'string') {
            assertAuthorizedScopePreset(summary, resources, input.scopePresetId, persistence, logger, {
              entry: 'mcp',
              action: 'agent_spawn'
            });
          }
          const originalTask = input.task;
          const task = await materializePublicChatTask({
            task: originalTask,
            cwd: scopeSession.cwd,
            dataDir: persistence?.dataDir ?? resolveDataDir(),
            userId: user.id
          });
          const scopeHardening = await scopeLaunchHardening(chips.catalog.knowledgeBaseRoot);
          ownershipTransferred = true;
          const spawnResult = await actions.agent_spawn({
            agentType: input.agentType,
            task,
            displayTask: originalTask,
            sessionMode: input.sessionMode,
            chatMode: mode.chatMode,
            model: mode.modelId,
            scope: input.scope,
            cwd: scopeSession.cwd,
            documentId: scopeSession.documentId,
            scopePresetId: scopeSession.scopePresetId,
            allowedChipIds: scopeSession.allowedChipIds,
            allowedDocumentIds: scopeSession.allowedDocumentIds,
            scopeWorkspace: scopeSession.safeSummary,
            usedSources: scopeSession.safeSummary.usedSources,
            sourceCitationSummary: scopeSession.safeSummary.sourceCitationSummary,
            scopeWorkspaceCleanup: scopeSession.cleanup,
            denyReadRoots: scopeHardening.denyReadRoots,
            allowedTools: scopeHardening.allowedTools,
            permissionMode: scopeHardening.permissionMode,
            systemPrompt: withScopeWorkspaceSystemContext(undefined, scopeSession)
          });
          return redactExternalSessionResult(spawnResult);
        } finally {
          if (!ownershipTransferred) {
            await scopeSession.cleanup().catch(() => undefined);
          }
        }
      }
      if (typeof input.chipId !== 'string' || input.chipId.trim() === '') {
        throw new HttpError(400, 'chipId or scopePresetId is required for public Remote MCP. Call agentx_whoami first and use permissions.resources[].id as agent_spawn.chipId or agent_spawn.scopePresetId.');
      }
      // HTTP↔MCP 一致：单芯片 MCP 也走与 web 同款的 assertAuthorizedChipResource，
      // group 推导已并入 summary.grants.chipIds，零越权仍由安全层 + scope 交集保证。
      assertAuthorizedChipResource(summary, chips, userScope, input.chipId, prompts, persistence, logger, {
        entry: 'mcp',
        action: 'agent_spawn'
      });
      if (typeof input.documentId === 'string') {
        assertAuthorizedDocument(summary, resources, input.documentId, persistence, logger, {
          entry: 'mcp',
          action: 'agent_spawn'
        });
      }
      if (typeof input.scopePresetId === 'string') {
        assertAuthorizedScopePreset(summary, resources, input.scopePresetId, persistence, logger, {
          entry: 'mcp',
          action: 'agent_spawn'
        });
      }
      const resolved = await resolveChipWorkspace(chips.catalog, input.chipId as string);
      if (!canRequestAccessChip(summary, resolved.chipId)) {
        throw new HttpError(403, 'The requested resource is not available to this identity.');
      }
      let systemPrompt: string | undefined;
      if (prompts) {
        const composed = await buildSessionSystemPrompt(prompts.catalog, user.role, resolved.chipId);
        const policy = getInjectionPolicy(user.role, prompts.roleConfig);
        const state = createInjectorState();
        systemPrompt = injectSystemPrompt(state, policy, withPublicRemoteMcpWorkspaceContext(composed, resolved)) ?? undefined;
      } else {
        systemPrompt = withPublicRemoteMcpWorkspaceContext(undefined, resolved);
      }

      const dataDir = persistence?.dataDir ?? resolveDataDir();
      const launch = await prepareChipLaunch({
        chipSourceCwd: resolved.cwd,
        knowledgeBaseRoot: chips.catalog.knowledgeBaseRoot,
        dataDir
      });
      let ownershipTransferred = false;
      try {
        const originalTask = input.task;
        const task = await materializePublicChatTask({
          task: originalTask,
          cwd: launch.cwd,
          dataDir,
          userId: user.id
        });
        ownershipTransferred = true;
        const spawnResult = await actions.agent_spawn({
          agentType: input.agentType,
          task,
          displayTask: originalTask,
          sessionMode: input.sessionMode,
          chatMode: mode.chatMode,
          model: mode.modelId,
          cwd: launch.cwd,
          chipId: resolved.chipId,
          denyReadRoots: launch.denyReadRoots,
          allowedTools: launch.allowedTools,
          permissionMode: launch.permissionMode,
          scopeWorkspaceCleanup: launch.cleanup,
          systemPrompt
        });
        return redactExternalSessionResult(spawnResult);
      } finally {
        if (!ownershipTransferred) {
          await launch.cleanup().catch(() => undefined);
        }
      }
    },
    async agent_log(input) {
      await assertCurrentMcpToolAndSession(auth, persistence, logger, user, key, manager, 'agent_log', input.sessionId, chips, prompts, resources);
      return actions.agent_log({
        ...input,
        limit: input.limit === undefined ? undefined : Math.min(input.limit, mcpHttpSecurity.maxOutputChars),
        tail: input.tail === undefined ? undefined : Math.min(input.tail, mcpHttpSecurity.maxOutputChars)
      });
    },
    async agent_poll(input) {
      await assertCurrentMcpToolAndSession(auth, persistence, logger, user, key, manager, 'agent_poll', input.sessionId, chips, prompts, resources);
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
      return actions.agent_poll({
        ...input,
        timeoutMs: timeoutMs === undefined ? undefined : Math.min(timeoutMs, mcpHttpSecurity.maxPollTimeoutMs)
      });
    },
    async agent_send(input) {
      await assertCurrentMcpToolAndSession(auth, persistence, logger, user, key, manager, 'agent_send', input.sessionId, chips, prompts, resources);
      const session = manager.list().find((candidate) => candidate.id === input.sessionId && candidate.userId === user.id);
      if (containsChatImageInput(input.data)) {
        if (!session || session.chatMode !== 'multimodal') {
          throw new HttpError(400, 'Image input requires a multimodal session.', 'CHAT_MODE_MISMATCH');
        }
        const data = await materializePublicChatTask({
          task: input.data,
          cwd: session.cwd,
          dataDir: persistence?.dataDir ?? resolveDataDir(),
          userId: user.id
        });
        return actions.agent_send({ ...input, data, displayData: input.data });
      }
      return actions.agent_send(input);
    },
    async agent_kill(input) {
      await assertCurrentMcpToolAndSession(auth, persistence, logger, user, key, manager, 'agent_kill', input.sessionId, chips, prompts, resources);
      return actions.agent_kill(input);
    },
    async agent_list(input = {}) {
      const summary = auth
        ? await buildCurrentMcpAuthorizationSummary(auth, user.id, key.id, chips)
        : await buildEffectiveAuthorizationSummaryForMcpFallback(user, key, chips);
      assertAuthorizedResource(summary, { type: 'mcpTool', id: 'agent_list' }, persistence, logger, {
        entry: 'mcp',
        action: 'agent_list'
      });
      const listResult = await actions.agent_list(input);
      return {
        ...listResult,
        sessions: listResult.sessions.map(redactExternalSessionResult)
      };
    }
  };
}

async function buildEffectiveAuthorizationSummaryForMcpFallback(
  user: User,
  key: McpKey,
  chips: ChipRuntime | null
): Promise<EffectiveAuthorizationSummary> {
  return computeEffectiveAuthorizationSummary({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      expiresAt: user.expiresAt,
      grants: user.resourceGrants,
      modelGrants: user.modelGrants
    },
    key: {
      id: key.id,
      fingerprint: fingerprintMcpKey(key.key),
      expiresAt: key.expiresAt,
      grants: key.resourceGrants,
      modelGrants: key.modelGrants
    }
  }, new Date(), {
    deriveChipIds: chips ? (grants) => chipIdsForGroupGrants(grants, chips.catalog) : undefined
  });
}

async function assertCurrentMcpToolAndSession(
  auth: AuthRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  user: User,
  key: McpKey,
  manager: SessionManager,
  toolName: string,
  sessionId: string | undefined,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null = null
): Promise<void> {
  const summary = auth
    ? await buildCurrentMcpAuthorizationSummary(auth, user.id, key.id, chips)
    : await buildEffectiveAuthorizationSummaryForMcpFallback(user, key, chips);
  assertAuthorizedResource(summary, { type: 'mcpTool', id: toolName }, persistence, logger, {
    entry: 'mcp',
    action: toolName
  });
  if (!sessionId) {
    return;
  }
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  if (!session || session.userId !== user.id) {
    throw new Error('Session not found');
  }
  if (session?.chipId) {
    // HTTP↔MCP 一致：会话级单芯片复核也走 assertAuthorizedChipResource。
    // chips 为空（未配置芯片库）时退回安全层通用资源闸。
    if (chips) {
      const sessionUserScope = { userId: user.id, username: user.username, role: user.role, iat: 0, exp: 0 };
      assertAuthorizedChipResource(summary, chips, sessionUserScope, session.chipId, prompts, persistence, logger, {
        entry: 'mcp',
        action: toolName
      });
    } else {
      assertAuthorizedResource(summary, { type: 'chip', id: session.chipId }, persistence, logger, {
        entry: 'mcp',
        action: toolName
      });
    }
  }
  // V2：此前这里漏了 documentId 复验（chip/scopePreset/model 都验了，唯独 document 没有）。
  // 补齐后与 evaluateDocumentVisibility 单一事实源一致（同 assertAuthorizedDocument）。
  if (session?.documentId) {
    assertAuthorizedDocument(summary, resources, session.documentId, persistence, logger, {
      entry: 'mcp',
      action: toolName
    });
  }
  if (session?.scopePresetId) {
    if (session.allowedChipIds) {
      assertScopeWorkspaceStillAuthorized(
        summary,
        resources?.catalog ?? null,
        session.allowedChipIds,
        session.allowedDocumentIds
      );
    }
    if (isDynamicScopePresetId(session.scopePresetId)) {
      // 动态 scope（group/global 检索解析出的一组 chip）没有真实目录预设，
      // scopePresetId 只是 dynamic-group / dynamic-global 这样的合成标记。目录里查不到，
      // assertAuthorizedResource({type:'scopePreset'}) 必然当作未授权拒绝所有非 admin 用户
      // ——这是 bug，不是安全特性。改为逐个核对 spawn 时持久化在 session.allowedChipIds
      // 上的 chip 列表，与 session-actions.ts 的 assertSessionStillAuthorized 共用同一份
      // 判定逻辑（assertDynamicScopeChipsStillAuthorized），保持 HTTP↔MCP 复验口径一致。
      if (!session.allowedChipIds) {
        assertDynamicScopeChipsStillAuthorized(summary, session.allowedChipIds);
      }
    } else {
      assertAuthorizedResource(summary, { type: 'scopePreset', id: session.scopePresetId }, persistence, logger, {
        entry: 'mcp',
        action: toolName
      });
    }
  }
  if (session?.modelId) {
    assertAuthorizedResource(summary, { type: 'model', id: session.modelId }, persistence, logger, {
      entry: 'mcp',
      action: toolName
    });
  }
}

function assertRemoteMcpCustomerSpawnInput(input: {
  cwd?: unknown;
  env?: unknown;
  systemPrompt?: unknown;
  chatMode?: unknown;
  model?: unknown;
  cols?: unknown;
  rows?: unknown;
  timeoutMs?: unknown;
  noOutputTimeoutMs?: unknown;
}): void {
  assertPublicSpawnControlsAbsent(input, 'remote-mcp');
}

export function isScopeHistorySessionRestartOnly(session: {
  scopePresetId?: string;
  scopeDescriptor?: { mode?: string };
  scopeWorkspace?: { scopePresetId?: string };
}): boolean {
  return Boolean(session.scopePresetId) ||
    Boolean(session.scopeWorkspace) ||
    session.scopeDescriptor?.mode === 'group' ||
    session.scopeDescriptor?.mode === 'global';
}

function mapOwnedLiveConversationSessions(
  sessions: readonly ProcessSession[],
  userId: string
): Map<string, ProcessSession> {
  return new Map(
    sessions
      .filter((session) =>
        session.userId === userId &&
        session.status === 'running' &&
        session.sessionMode === 'conversation'
      )
      .map((session) => [session.id, session])
  );
}

function projectLiveConversationTurnState<T extends { turnState?: TurnState }>(
  summary: T,
  liveSession: ProcessSession | undefined
): T {
  if (liveSession?.turnState === undefined || liveSession.turnState === summary.turnState) {
    return summary;
  }
  return { ...summary, turnState: liveSession.turnState };
}

function assertPublicSpawnControlsAbsent(input: Record<string, unknown>, entryPoint: string): void {
  const trustedServerFields = [
    'cwd',
    'env',
    'systemPrompt',
    'denyReadRoots',
    'allowedTools',
    'permissionMode',
    'scopeWorkspace',
    'scopeWorkspaceCleanup',
    'allowedChipIds',
    'allowedDocumentIds',
    'usedSources',
    'sourceCitationSummary',
    'displayTask',
    'responseLocale',
    'turnContext',
    'cols',
    'rows',
    'timeoutMs',
    'noOutputTimeoutMs'
  ];
  const supplied = trustedServerFields.find((key) => input[key] !== undefined);
  if (supplied) {
    const fieldMessage = supplied === 'cwd'
      ? 'cwd must not be supplied directly; it is provider-controlled'
      : `${supplied} is provider-controlled`;
    throw new HttpError(
      400,
      `${fieldMessage} and must not be supplied through ${entryPoint}. Select an authorized chip or scope instead.`,
      'UNTRUSTED_SESSION_OVERRIDE'
    );
  }
}

function resolveRemoteMcpSearchMode(
  user: User,
  key: McpKey,
  requestedMode: unknown,
  requestedModelId: unknown,
  task: string,
  modelRouting: ModelRoutingRuntime
): { chatMode: 'standard' | 'enhanced' | 'multimodal'; modelId: ModelId; creditUnits: number } {
  const selection = resolveSearchModeSelection({
    entryPoint: 'remote-mcp',
    includesImageInput: containsChatImageInput(task),
    requestedMode,
    requestedModelId,
    role: user.role,
    userModelGrants: user.modelGrants,
    mcpKeyModelGrants: key.modelGrants,
    creditBalanceUnits: getUserCreditBalanceUnits(user),
    modeRoleMapping: modelRouting.config.modeRoleMapping
  });
  if (!selection.ok) {
    throw new HttpError(selection.statusCode, selection.message, selection.code, selection.details);
  }
  return {
    chatMode: selection.chatMode,
    modelId: selection.modelId,
    creditUnits: selection.creditUnits
  };
}

function withPublicRemoteMcpWorkspaceContext(
  systemPrompt: string | undefined,
  resolved: { chipId: string; label?: string }
): string {
  const workspaceContext = [
    '=== AGENTX AUTHORIZED RESOURCE ===',
    `Selected chip: ${resolved.chipId}`,
    resolved.label ? `Resource label: ${resolved.label}` : undefined,
    'This public Remote MCP session is scoped to a provider-resolved workspace.',
    'Do not disclose server filesystem paths, configured workspace directories, cwd values, or internal deployment paths.',
    'When asked about the current workspace, answer with the selected chip id and resource label instead of a filesystem path.'
  ].filter(Boolean).join('\n');

  return [systemPrompt?.trim(), workspaceContext].filter(Boolean).join('\n\n');
}

function withScopeWorkspaceSystemContext(
  systemPrompt: string | undefined,
  scopeSession: PreparedScopeSession
): string {
  const summary = scopeSession.safeSummary;
  const workspaceContext = [
    '=== AGENTX AUTHORIZED SCOPE ===',
    `Scope preset: ${summary.scopePresetId}`,
    `Workspace mode: ${summary.mode}`,
    `Authorized files: ${summary.fileCount}`,
    `Authorized chips: ${summary.allowedChipCount}`,
    `Authorized documents: ${summary.allowedDocumentCount}`,
    'This session is scoped to a temporary copy workspace containing only authorized material.',
    'Do not disclose server filesystem paths, source paths, internal manifest paths, cwd values, or internal deployment paths.',
    'When asked about the current workspace, answer with the scope preset id and safe scope counts instead of a filesystem path.',
    '',
    scopeOutputContractInstructions()
  ].join('\n');

  return [systemPrompt?.trim(), workspaceContext].filter(Boolean).join('\n\n');
}

async function prepareAuthorizedScopeSession(input: {
  summary: EffectiveAuthorizationSummary | undefined;
  chips: ChipRuntime;
  resources: ResourceRuntime | null;
  persistence: PersistenceRuntime | undefined;
  input: { scopePresetId?: unknown; documentId?: unknown };
  entryPoint: 'web' | 'rpc' | 'mcp';
}): Promise<PreparedScopeSession | undefined> {
  if (typeof input.input.scopePresetId !== 'string' || input.input.scopePresetId.trim() === '') {
    return undefined;
  }
  if (!input.summary || !input.resources) {
    throw new HttpError(403, 'The requested resource is not available to this identity.');
  }
  try {
    return await prepareScopeSession({
      authorization: input.summary,
      chips: input.chips.catalog,
      resources: input.resources.catalog,
      dataDir: input.persistence?.dataDir ?? resolveDataDir(),
      scopePresetId: input.input.scopePresetId,
      documentId: typeof input.input.documentId === 'string' ? input.input.documentId : undefined,
      entryPoint: input.entryPoint
    });
  } catch (error) {
    if (error instanceof ScopeSessionDeniedError) {
      throw new HttpError(403, error.message);
    }
    throw error;
  }
}

/**
 * 动态 scope 路由结果（M3 T3/T4）。
 * - small：文件数 ≤ 阈值，已物化为隔离副本，走原 streaming spawn 路径（零回归）。
 * - large：文件数 > 阈值，不物化；上层创建托管会话 + 后台两阶段引擎。
 */
type DynamicScopeRouting =
  | { kind: 'small'; session: PreparedScopeSession }
  | {
      kind: 'large';
      allowedChipIds: string[];
      allowedDocumentIds: string[];
      allowedDocumentCount: number;
      scopePresetId: string;
      scopeId: string;
      fileCount: number;
    };

/**
 * 动态 scope 描述符（group / global）路由（C2 + M3 T3/T4）。
 *
 * 仿照 prepareAuthorizedScopeSession 的模式，但在物化前先定标：
 * - descriptor.mode 非 group/global → 返回 undefined（不接管，让后续单芯片路径处理）。
 * - 无 summary（未认证）→ 抛 HttpError 403。
 * - 先 resolveDynamicScopeSelection 解析授权 chip 交集（零越权），再统计文件数 decideScopeScale：
 *   - large（> 阈值）→ 不物化，返回 { kind: 'large', allowedChipIds, ... } 交上层后台两阶段。
 *   - small（≤ 阈值）→ prepareDynamicScopeSession 物化为隔离副本，返回 { kind: 'small', session }。
 * - 错误映射：ScopeSessionDeniedError → 403，ScopeTooLargeError → 413。
 */
async function prepareAuthorizedDynamicScopeSession(input: {
  summary: EffectiveAuthorizationSummary | undefined;
  chips: ChipRuntime;
  resources: ResourceRuntime | null;
  persistence: PersistenceRuntime | undefined;
  descriptor: ScopeDescriptor;
  request: IncomingMessage;
  prompts: PromptRuntime | null;
  entryPoint: 'web' | 'rpc' | 'mcp';
  threshold: number;
}): Promise<DynamicScopeRouting | undefined> {
  if (input.descriptor.mode !== 'group' && input.descriptor.mode !== 'global') {
    return undefined;
  }
  if (!input.summary) {
    throw new HttpError(403, 'The requested resource is not available to this identity.');
  }
  const authorizedChipIds = listAuthorizedChipIds(
    input.chips.catalog,
    (chipId) => canRequestAccessChip(input.summary, chipId)
  );
  const dataDir = input.persistence?.dataDir ?? resolveDataDir();
  // 动态范围现在与预设路径共用同一份资源目录（documents[].chipIds 权威映射 +
  // evaluateDocumentVisibility 审批校验）；resources runtime 未启用时才降级为空 catalog。
  const resourcesCatalog = input.resources?.catalog ?? parseResourceVisibilityCatalog({ documents: [], scopePresets: [] });
  try {
    // 先解析授权 chip 交集（越权 / 空交集会 throw ScopeSessionDeniedError）；
    // 同时对每个 chip 名下的目录文档跑审批可见性校验，只保留已批准文档（V1，只剔文档不整体拒绝）。
    const selection = resolveDynamicScopeSelection({
      authorization: input.summary,
      catalog: input.chips.catalog,
      resources: resourcesCatalog,
      authorizedChipIds,
      descriptor: input.descriptor,
      // 与 prepareScopeSession 保持一致：rpc → web 映射
      entryPoint: input.entryPoint === 'rpc' ? 'web' : input.entryPoint
    });
    const copyableChipIds = filterWholeWorkspaceAuthorizedChipIds(
      resourcesCatalog,
      selection.allowedChipIds,
      selection.allowedDocumentIds
    );
    if (copyableChipIds.length === 0) {
      throw new ScopeSessionDeniedError('The requested resource is not available to this identity.');
    }
    const copyableChipSet = new Set(copyableChipIds);
    const copyableDocumentIds = selection.allowedDocumentIds.filter((documentId) => {
      const document = findDocumentContract(resourcesCatalog, documentId);
      return document?.chipIds.some((chipId) => copyableChipSet.has(chipId)) ?? false;
    });
    // 物化前先统计文件数，避免大范围跑 materialize 才发现超阈值。
    // 并行统计各 chip 文件数（countChipScopeFiles 内部已 catch 自身错误，并行安全）。
    const fileCounts = await Promise.all(
      copyableChipIds.map(async (chipId) => {
        const resolved = await resolveChipWorkspace(input.chips.catalog, chipId).catch(() => undefined);
        return resolved ? countChipScopeFiles(resolved.cwd) : 0;
      })
    );
    const fileCount = fileCounts.reduce((sum, n) => sum + n, 0);
    const scale = decideScopeScale(fileCount, { threshold: input.threshold });
    if (scale.tier === 'large') {
      return {
        kind: 'large',
        allowedChipIds: copyableChipIds,
        allowedDocumentIds: copyableDocumentIds,
        allowedDocumentCount: copyableDocumentIds.length,
        scopePresetId: selection.scopePresetId,
        scopeId: selection.scopeId,
        fileCount
      };
    }
    const session = await prepareDynamicScopeSession({
      authorization: input.summary,
      chips: input.chips.catalog,
      resources: resourcesCatalog,
      dataDir,
      authorizedChipIds,
      descriptor: input.descriptor,
      // 与 prepareScopeSession 保持一致：rpc → web 映射
      entryPoint: input.entryPoint === 'rpc' ? 'web' : input.entryPoint
    });
    if (!session) {
      return undefined;
    }
    return { kind: 'small', session };
  } catch (error) {
    if (error instanceof ScopeSessionDeniedError) {
      throw new HttpError(403, error.message);
    }
    if (error instanceof ScopeTooLargeError) {
      throw new HttpError(413, error.message);
    }
    throw error;
  }
}

function redactExternalSessionResult<T extends { cwd?: string; allowedChipIds?: string[]; allowedDocumentIds?: string[] }>(session: T): T {
  const redacted = { ...session };
  delete redacted.cwd;
  // allowedChipIds 是动态 scope 撤权复验用的内部字段（见
  // assertDynamicScopeChipsStillAuthorized），不是给客户端的公开字段，比照 cwd 一并剔除。
  delete redacted.allowedChipIds;
  delete redacted.allowedDocumentIds;
  return redacted;
}

function redactExternalActionResult(method: ActionName, result: unknown): unknown {
  if (method === 'agent_spawn' && isRecord(result)) {
    return redactExternalSessionResult(result);
  }
  if (method === 'agent_list' && isRecord(result) && Array.isArray(result.sessions)) {
    return {
      ...result,
      sessions: result.sessions.map((session) => isRecord(session) ? redactExternalSessionResult(session) : session)
    };
  }
  return result;
}

function getMcpSessionId(request: IncomingMessage): string | undefined {
  const value = request.headers['mcp-session-id'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function consumeMcpRateLimit(
  mcpRateLimiter: RateLimiter,
  request: IncomingMessage,
  limitName: string,
  keyFingerprint: string,
  limit: number
): RateLimitResult {
  return mcpRateLimiter.consume(`${getRemoteAddress(request)}:${keyFingerprint}`, limitName, limit);
}

function logMcpRateLimited(
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  limitName: string,
  rateLimit: RateLimitResult,
  keyFingerprint: string,
  session?: Partial<RemoteMcpSession> & { userId?: string; username?: string; role?: string }
): void {
  logger.warn(LOG_EVENTS.mcpRateLimited, 'Remote MCP request rate limited', {
    userId: session?.userId,
    metadata: remoteMcpLogMetadata(request, pathname, method, {
      userId: session?.userId,
      username: session?.username,
      role: session?.role,
      keyFingerprint,
      limitName,
      currentCount: rateLimit.count,
      limit: rateLimit.limit,
      resetAt: rateLimit.resetAt
    })
  });
}

function logRemoteMcpToolCall(
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  body: unknown,
  mcpSessionId: string,
  session: RemoteMcpSession
): void {
  logger.info(LOG_EVENTS.mcpToolCall, 'Remote MCP tool request', {
    userId: session.userId,
    metadata: remoteMcpLogMetadata(request, pathname, method, {
      userId: session.userId,
      username: session.username,
      role: session.role,
      mcpSessionId,
      keyId: session.keyId,
      keyName: session.keyName,
      keyFingerprint: session.keyFingerprint,
      rpcMethod: isRecord(body) ? body.method : undefined
    })
  });
}

function logRemoteMcpAuthFailure(
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  logger.warn(LOG_EVENTS.mcpAuthFailure, 'Remote MCP authentication failed', {
    metadata: remoteMcpLogMetadata(request, pathname, method, {
      reason,
      ...extra
    })
  });
  logRemoteMcpError(logger, request, pathname, method, reason, extra);
}

async function validateRemoteMcpSessionAuth(
  request: AuthenticatedRequest,
  response: ServerResponse,
  auth: AuthRuntime | null,
  session: RemoteMcpSession,
  mcpSessionId: string,
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  logger: Logger,
  pathname: string,
  method: string,
  mcpHttpSecurity: McpHttpSecurityConfig
): Promise<boolean> {
  const mcpKey = extractMcpBearerKey(request);
  if (!auth || !mcpKey) {
    logRemoteMcpAuthFailure(logger, request, pathname, method, 'missing MCP key', {
      userId: session.userId,
      mcpSessionId,
      keyFingerprint: session.keyFingerprint
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'auth_revoked');
    sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
    return false;
  }

  const identity = await auth.userStore.lookupUsableMcpKey(mcpKey);
  const keyFingerprint = fingerprintMcpKey(mcpKey);
  if (!identity) {
    logRemoteMcpAuthFailure(logger, request, pathname, method, 'revoked or invalid MCP key', {
      userId: session.userId,
      mcpSessionId,
      keyFingerprint
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'auth_revoked');
    sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
    return false;
  }

  if (identity.user.id !== session.userId) {
    logRemoteMcpAuthFailure(logger, request, pathname, method, 'MCP key user mismatch', {
      userId: session.userId,
      mcpSessionId,
      keyFingerprint,
      requestUserId: identity.user.id
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'user_mismatch');
    sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
    return false;
  }

  if (identity.key.id !== session.keyId) {
    logRemoteMcpAuthFailure(logger, request, pathname, method, 'MCP key mismatch', {
      userId: session.userId,
      mcpSessionId,
      keyFingerprint,
      requestKeyId: identity.key.id
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'key_mismatch');
    sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
    return false;
  }

  if (identity.user.role !== session.role) {
    logRemoteMcpAuthFailure(logger, request, pathname, method, 'MCP user role changed', {
      userId: session.userId,
      mcpSessionId,
      keyFingerprint,
      sessionRole: session.role,
      currentRole: identity.user.role
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, 'role_changed');
    sendMcpJsonRpcError(response, 401, -32001, 'Unauthorized: valid MCP key required');
    return false;
  }

  const now = Date.now();
  session.lastSeenAtMs = now;
  session.lastSeenAt = new Date(now).toISOString();
  const touched = await auth.userStore.touchMcpKey(identity.user.id, identity.key.id, {
    minIntervalMs: mcpHttpSecurity.keyTouchMinIntervalMs
  });
  if (touched) {
    session.lastKeyTouchAtMs = now;
  }
  return true;
}

function cleanupExpiredRemoteMcpTransports(
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  mcpHttpSecurity: McpHttpSecurityConfig
): void {
  const now = Date.now();
  for (const [mcpSessionId, session] of remoteMcpTransports) {
    const idleExpired = now - session.lastSeenAtMs > mcpHttpSecurity.transportIdleTtlMs;
    const absoluteExpired = now >= session.expiresAtMs;
    if (!idleExpired && !absoluteExpired) {
      continue;
    }

    const reason = absoluteExpired ? 'absolute_ttl' : 'idle_timeout';
    logger.info(LOG_EVENTS.mcpTransportExpired, 'Remote MCP transport expired', {
      userId: session.userId,
      metadata: remoteMcpLogMetadata(request, pathname, method, {
        userId: session.userId,
        username: session.username,
        role: session.role,
        mcpSessionId,
        reason,
        ttlMs: reason === 'absolute_ttl' ? mcpHttpSecurity.transportAbsoluteTtlMs : mcpHttpSecurity.transportIdleTtlMs,
        keyFingerprint: session.keyFingerprint
      })
    });
    cleanupRemoteMcpTransport(remoteMcpTransports, logger, request, pathname, method, mcpSessionId, reason);
  }
}

function checkRemoteMcpTransportLimit(
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  userId: string,
  mcpHttpSecurity: McpHttpSecurityConfig
): TransportLimitResult | null {
  if (remoteMcpTransports.size >= mcpHttpSecurity.maxTransports) {
    return {
      allowed: false,
      count: remoteMcpTransports.size + 1,
      limit: mcpHttpSecurity.maxTransports,
      resetAt: 0,
      limitName: 'mcp:transport_limit'
    };
  }

  const userTransportCount = Array.from(remoteMcpTransports.values()).filter((session) => session.userId === userId).length;
  if (userTransportCount >= mcpHttpSecurity.maxTransportsPerUser) {
    return {
      allowed: false,
      count: userTransportCount + 1,
      limit: mcpHttpSecurity.maxTransportsPerUser,
      resetAt: 0,
      limitName: 'mcp:transport_limit_per_user'
    };
  }

  return null;
}

function cleanupRemoteMcpTransport(
  remoteMcpTransports: Map<string, RemoteMcpSession>,
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  mcpSessionId: string,
  reason = 'client_close'
): void {
  const session = remoteMcpTransports.get(mcpSessionId);
  if (!session) {
    return;
  }

  remoteMcpTransports.delete(mcpSessionId);
  if (reason !== 'client_close') {
    void session.transport.close().catch(() => undefined);
  }
  logger.info(LOG_EVENTS.mcpTransportClose, 'Remote MCP transport closed', {
    userId: session.userId,
    metadata: remoteMcpLogMetadata(request, pathname, method, {
      userId: session.userId,
      username: session.username,
      role: session.role,
      mcpSessionId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      reason,
      keyId: session.keyId,
      keyName: session.keyName,
      keyFingerprint: session.keyFingerprint
    })
  });
}

function logRemoteMcpError(
  logger: Logger,
  request: IncomingMessage,
  pathname: string,
  method: string,
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  logger.warn(LOG_EVENTS.mcpRequestError, 'Remote MCP request failed', {
    metadata: remoteMcpLogMetadata(request, pathname, method, {
      reason,
      ...extra
    })
  });
}

function remoteMcpLogMetadata(
  request: IncomingMessage,
  pathName: string,
  method: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    path: pathName,
    method,
    remoteAddress: getRemoteAddress(request),
    hasAuthorization: Boolean(request.headers.authorization),
    ...extra
  };
}

function getRemoteAddress(request: IncomingMessage): string {
  const forwardedFor = request.headers['x-forwarded-for'];
  const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return forwardedValue?.split(',')[0]?.trim() || request.socket.remoteAddress || 'unknown';
}

function sendMcpJsonRpcError(
  response: ServerResponse,
  statusCode: number,
  code: number,
  message: string
): void {
  if (response.headersSent) {
    return;
  }

  sendJson(response, statusCode, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null
  });
}

async function handleMcpAccessCenterRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  auth: AuthRuntime | null,
  url: URL,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  mcpHttpSecurity: McpHttpSecurityConfig,
  modelRouting: ModelRoutingRuntime
): Promise<void> {
  let user: User | null = null;

  if (auth && request.headers.authorization) {
    if (!(await requireUsableAuth(request, response, auth.jwtService, auth.userStore))) {
      return;
    }
    const userId = request.user?.userId;
    user = userId ? (await auth.userStore.findById(userId)) ?? null : null;
    if (!user) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
  }

  sendJson(response, 200, await buildMcpAccessCenterPayload(request, url, auth, user, chips, prompts, resources, mcpHttpSecurity, modelRouting));
}

async function buildMcpAccessCenterPayload(
  request: AuthenticatedRequest,
  url: URL,
  auth: AuthRuntime | null,
  user: User | null,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  mcpHttpSecurity: McpHttpSecurityConfig,
  modelRouting: ModelRoutingRuntime
) {
  const origin = getRequestOrigin(request, url);
  const publicPayload = {
    auth: {
      enabled: Boolean(auth),
      mode: 'bearer-mcp-key',
      authenticated: Boolean(user),
      requiredForUserData: true
    },
    server: {
      remoteHttpUrl: `${origin}/mcp`,
      verifyUrl: `${origin}/mcp/verify`,
      authMode: 'bearer-mcp-key',
      transports: [
        {
          id: 'remote-http',
          label: 'Remote MCP over Streamable HTTP',
          endpointUrl: `${origin}/mcp`,
          recommended: true,
          authMode: 'bearer-mcp-key'
        },
        {
          id: 'stdio',
          label: 'Local stdio MCP',
          recommended: false,
          authMode: 'local-env-mcp-api-key'
        }
      ]
    },
    templates: MCP_ACCESS_CENTER_TEMPLATES.map((template) => ({
      ...template,
      downloadUrl: `${origin}${template.downloadUrl}`
    })),
    downloads: MCP_ACCESS_CENTER_DOWNLOADS.map((download) => ({
      ...download,
      downloadUrl: `${origin}${download.downloadUrl}`
    })),
    securityNotes: [
      'Full MCP keys are only shown once by the Account key create or regenerate APIs.',
      'Access Center APIs return key ids, names, masked keys, fingerprints, expiry, models, resources, and limits only.',
      'Remote MCP clients should call agentx_whoami first and use returned resource ids instead of passing cwd, env, or systemPrompt.'
    ],
    capabilities: {
      remoteHttp: true,
      stdio: true,
      selfServiceKeyManagement: Boolean(user && auth?.userStore.getSelfServicePolicy(user).allowMcpKeySelfCreate),
      keyRegeneration: Boolean(user && auth?.userStore.getSelfServicePolicy(user).allowMcpKeyRegenerate),
      whoamiTool: true,
      smokeTest: true,
      templateDownloads: true,
      exposesCwd: false,
      exposesSecrets: false
    },
    limits: {
      maxBodyBytes: mcpHttpSecurity.maxBodyBytes,
      maxOutputChars: mcpHttpSecurity.maxOutputChars,
      maxPollTimeoutMs: mcpHttpSecurity.maxPollTimeoutMs,
      rateLimitMax: mcpHttpSecurity.rateLimitMax,
      verifyRateLimitMax: mcpHttpSecurity.verifyRateLimitMax,
      maxTransports: mcpHttpSecurity.maxTransports,
      maxTransportsPerUser: mcpHttpSecurity.maxTransportsPerUser
    }
  };

  if (!user || !auth) {
    return {
      ...publicPayload,
      user: null,
      permissions: {
        allowedModels: [],
        searchModes: [],
        allowedModes: [],
        resources: [],
        mcpKeyPolicy: null
      },
      keySummaries: [],
      availableKeys: []
    };
  }

  const publicUser = auth.userStore.toPublicUser(user);
  const authorizationSummary = await buildEffectiveAuthorizationSummary(auth, user, chips);
  const visibleResources = listVisibleResources(chips, resources, authorizationSummary, prompts);
  const scopeCatalog = listSafeScopeCatalogMetadata(chips, resources, visibleResources);
  const allowedModels = listModelsForAuthorization(authorizationSummary);
  const searchModes = listSearchModesForAuthorization(authorizationSummary, 'remote-mcp', getUserCreditBalanceUnits(user), modelRouting);
  const keySummaries = await Promise.all(
    publicUser.mcpKeys.map((key) => buildMcpAccessCenterKeySummary(auth, user, key, chips, prompts, resources, modelRouting))
  );

  return {
    ...publicPayload,
    user: {
      id: publicUser.id,
      username: publicUser.username,
      role: publicUser.role,
      status: publicUser.status ?? 'active',
      expiresAt: publicUser.expiresAt
    },
    permissions: {
      role: publicUser.role,
      allowedModels,
      searchModes,
      allowedModes: searchModes,
      resources: visibleResources,
      scopeCatalog,
      authorizedTools: authorizationSummary.grants.mcpTools,
      authorizationSummary,
      mcpKeyPolicy: auth.userStore.getSelfServicePolicy(user)
    },
    keySummaries,
    availableKeys: keySummaries.filter((key) => key.usable)
  };
}

async function buildMcpAccessCenterKeySummary(
  auth: AuthRuntime,
  user: User,
  key: PublicMcpKey,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  modelRouting: ModelRoutingRuntime
) {
  const rawKey = user.mcpKeys.find((candidate) => candidate.id === key.id);
  const availability = getMcpKeyAvailability(user, rawKey);
  const authorizationSummary = rawKey
    ? await buildEffectiveAuthorizationSummary(auth, user, chips, rawKey)
    : await buildEffectiveAuthorizationSummary(auth, user, chips);
  const allowedModels = listModelsForAuthorization(authorizationSummary);
  const searchModes = listSearchModesForAuthorization(authorizationSummary, 'remote-mcp', getUserCreditBalanceUnits(user), modelRouting);

  return {
    keyId: key.id,
    name: key.name,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsed,
    expiresAt: availability.expiresAt ?? key.expiresAt,
    maskedKey: key.maskedKey,
    fingerprint: key.fingerprint,
    usable: availability.usable,
    status: availability.usable ? 'usable' : 'unavailable',
    unavailableReason: availability.reason,
    allowedModels,
    searchModes,
    allowedModes: searchModes,
    resources: listVisibleResources(chips, resources, authorizationSummary, prompts),
    authorizedTools: authorizationSummary.grants.mcpTools,
    authorizationSummary
  };
}

async function buildEffectiveAuthorizationSummary(
  auth: AuthRuntime,
  user: User,
  chips: ChipRuntime | null,
  key?: McpKey
): Promise<EffectiveAuthorizationSummary> {
  const configuredRoleGrants = await getRoleResourceGrants(auth, user.role);
  const roleGrants =
    key && user.resourceGrants === undefined && key.resourceGrants === undefined
      ? {
          ...configuredRoleGrants,
          mcpTools: [...AGENTX_MCP_TOOL_NAMES]
        }
      : configuredRoleGrants;
  const summary = computeEffectiveAuthorizationSummary({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      expiresAt: user.expiresAt,
      grants: user.resourceGrants,
      modelGrants: user.modelGrants
    },
    ...(key
      ? {
          key: {
            id: key.id,
            fingerprint: fingerprintMcpKey(key.key),
            expiresAt: key.expiresAt,
            grants: key.resourceGrants,
            modelGrants: key.modelGrants
          }
        }
      : {}),
    roleGrants
  }, new Date(), {
    deriveChipIds: chips ? (grants) => chipIdsForGroupGrants(grants, chips.catalog) : undefined
  });
  const hasExplicitChipOverride = user.role !== 'admin' && Object.keys(user.resourceGrants ?? {}).includes('chipIds');
  if (hasExplicitChipOverride && (user.resourceGrants?.chipIds?.length ?? 0) === 0) {
    return {
      ...summary,
      grants: {
        ...summary.grants,
        chipIds: []
      }
    };
  }
  return summary;
}

type EffectiveAuthorizationSource = 'role_default' | 'user_override' | 'product_line_derived';

interface EffectiveAuthorizationItem {
  id: string;
  source: EffectiveAuthorizationSource;
}

function effectiveItems(
  effectiveIds: readonly string[],
  userOverrideIds: ReadonlySet<string>,
  derivedIds: ReadonlySet<string>,
  roleDefaultIds: ReadonlySet<string>,
  sourceOrder: readonly EffectiveAuthorizationSource[] = ['user_override', 'product_line_derived', 'role_default']
): EffectiveAuthorizationItem[] {
  return [...new Set(effectiveIds)]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const availableSources = new Set<EffectiveAuthorizationSource>();
      if (userOverrideIds.has(id)) {
        availableSources.add('user_override');
      }
      if (derivedIds.has(id)) {
        availableSources.add('product_line_derived');
      }
      if (roleDefaultIds.has(id)) {
        availableSources.add('role_default');
      }
      return {
        id,
        source: sourceOrder.find((source) => availableSources.has(source)) ?? 'role_default'
      };
    });
}

function expandChipGrantIds(ids: readonly string[], chips: ChipRuntime | null): string[] {
  if (ids.includes('*')) {
    return chips?.catalog.chips.map((chip) => chip.id) ?? ['*'];
  }
  return [...ids];
}

async function buildAdminEffectiveAuthorizationResponse(
  auth: AuthRuntime,
  chips: ChipRuntime | null,
  userId: string
) {
  const user = await auth.userStore.findById(userId);
  if (!user) {
    throw new HttpError(404, 'User not found');
  }
  const summary = await buildEffectiveAuthorizationSummary(auth, user, chips);
  const roleGrants = normalizeResourceGrantSet(await getRoleResourceGrants(auth, user.role));
  const userGrants = normalizeResourceGrantSet(user.resourceGrants);
  const chipOverridePresent = user.role !== 'admin' && Object.keys(user.resourceGrants ?? {}).includes('chipIds');
  const userChipOverrides = chipOverridePresent ? new Set(userGrants.chipIds ?? []) : new Set<string>();
  const derivedChipIds = chips
    ? new Set(chipIdsForGroupGrants(summary.grants, chips.catalog))
    : new Set<string>();
  const effectiveChipIds = expandChipGrantIds(summary.grants.chipIds, chips);
  const userModelOverrides = user.role === 'admin' ? new Set<string>() : new Set(user.modelGrants ?? []);
  const roleDefaultModelIds = new Set(getEffectiveModelGrants({ role: user.role }));
  return {
    userId: user.id,
    dimensions: {
      brands: effectiveItems(summary.grants.brands, new Set(userGrants.brands), new Set(), new Set(roleGrants.brands)),
      productLines: effectiveItems(summary.grants.productLines, new Set(userGrants.productLines), new Set(), new Set(roleGrants.productLines)),
      chipIds: effectiveItems(effectiveChipIds, userChipOverrides, derivedChipIds, new Set(expandChipGrantIds(roleGrants.chipIds, chips))),
      // 批次D（2.2.27）：文档维度是真实生效的授权（authorization.ts normalize/merge），此前生效总览漏了它，
      // 导致管理员能编辑、能保存 documentIds 却在总览看不到是否生效。文档无产品线推导，故 derived 传空。
      documentIds: effectiveItems(summary.grants.documentIds, new Set(userGrants.documentIds), new Set(), new Set(roleGrants.documentIds)),
      modelIds: effectiveItems(summary.grants.modelIds, userModelOverrides, new Set(), roleDefaultModelIds),
      scopePresetIds: effectiveItems(summary.grants.scopePresetIds, new Set(userGrants.scopePresetIds), new Set(), new Set(roleGrants.scopePresetIds)),
      mcpTools: effectiveItems(summary.grants.mcpTools, new Set(userGrants.mcpTools), new Set(), new Set(roleGrants.mcpTools))
    },
    overrides: { systemBChipOverride: chipOverridePresent },
    computedAt: new Date().toISOString()
  };
}

async function buildRequestAuthorizationSummary(
  auth: AuthRuntime | null,
  request: AuthenticatedRequest,
  chips: ChipRuntime | null
): Promise<EffectiveAuthorizationSummary | undefined> {
  const userId = request.user?.userId;
  if (!auth || !userId) {
    return undefined;
  }
  const user = await auth.userStore.findById(userId);
  if (!user) {
    throw new HttpError(401, 'Authentication required');
  }
  return buildEffectiveAuthorizationSummary(auth, user, chips);
}

async function handleAnnouncementRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  auth: AuthRuntime | null,
  method: string,
  pathname: string,
  url: URL,
  announcementStore: AnnouncementStore
): Promise<void> {
  const identity = await resolveAnnouncementViewer(auth, request, response);
  if (!identity) {
    return;
  }
  const locale = parseAnnouncementLocale(url.searchParams.get('locale'));

  if (method === 'GET' && pathname === '/api/announcements/home') {
    sendJson(response, 200, await announcementStore.getHome(identity.context, identity.userId, locale));
    return;
  }

  if (method === 'GET' && pathname === '/api/announcements/feed') {
    sendJson(response, 200, await announcementStore.getFeed(identity.context, identity.userId, locale));
    return;
  }

  const detailMatch = /^\/api\/announcements\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && detailMatch) {
    const item = await safeGetAnnouncementItem(announcementStore, decodeURIComponent(detailMatch[1] ?? ''));
    if (!item || !evaluateAnnouncementVisibility(item, identity.context).allowed) {
      sendJson(response, 404, { error: 'Not found', code: 'ANNOUNCEMENT_NOT_FOUND' });
      return;
    }
    const state = identity.userId ? await announcementStore.getUserState(identity.userId) : undefined;
    sendJson(response, 200, { item: toPublicAnnouncementDto(item, state?.items[item.id], locale) });
    return;
  }

  const stateMatch = /^\/api\/announcements\/([^/]+)\/(read|dismiss)$/.exec(pathname);
  if (method === 'POST' && stateMatch) {
    await readJsonBody(request);
    const item = await safeGetAnnouncementItem(announcementStore, decodeURIComponent(stateMatch[1] ?? ''));
    const action = stateMatch[2];
    if (item && identity.userId && evaluateAnnouncementVisibility(item, identity.context).allowed) {
      if (action === 'read') {
        await announcementStore.markRead(identity.userId, item);
      } else {
        await announcementStore.markDismissed(identity.userId, item);
      }
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function resolveAnnouncementViewer(
  auth: AuthRuntime | null,
  request: AuthenticatedRequest,
  response: ServerResponse
): Promise<{ context: AnnouncementViewerContext; userId?: string } | null> {
  if (!auth || !request.headers.authorization) {
    return { context: {} };
  }
  if (!(await requireUsableAuth(request, response, auth.jwtService, auth.userStore))) {
    return null;
  }
  const authorization = await buildRequestAuthorizationSummary(auth, request, null);
  return {
    context: authorization ? { authorization } : {},
    ...(request.user?.userId ? { userId: request.user.userId } : {})
  };
}

async function safeGetAnnouncementItem(
  announcementStore: AnnouncementStore,
  id: string
): Promise<Awaited<ReturnType<AnnouncementStore['getItem']>>> {
  try {
    return await announcementStore.getItem(id);
  } catch {
    return undefined;
  }
}

async function handleAdminAnnouncementRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  method: string,
  pathname: string,
  url: URL,
  announcementStore: AnnouncementStore
): Promise<void> {
  if (method === 'GET' && pathname === '/admin/announcements') {
    const items = filterAdminAnnouncements(await announcementStore.listItems(), url);
    const summaries = await announcementStore.getReadStateSummaries(items);
    sendJson(response, 200, {
      items: items.map((item) => toAdminAnnouncementDto(item, summaries[item.id])),
      total: items.length
    });
    return;
  }

  if (method === 'POST' && pathname === '/admin/announcements') {
    const item = buildAdminAnnouncementItem(await readJsonObject(request), undefined, adminAnnouncementActor(request), new Date());
    const created = await announcementStore.upsertItem(item);
    sendJson(response, 201, {
      item: toAdminAnnouncementDto(created, await announcementStore.getReadStateSummary(created))
    });
    return;
  }

  const match = /^\/admin\/announcements\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match) {
    sendJson(response, 404, { error: 'Not found', code: 'ANNOUNCEMENT_NOT_FOUND' });
    return;
  }

  const id = decodeURIComponent(match[1] ?? '');
  const action = match[2];
  const existing = await safeGetAnnouncementItem(announcementStore, id);
  if (!existing) {
    sendJson(response, 404, { error: 'Announcement not found', code: 'ANNOUNCEMENT_NOT_FOUND' });
    return;
  }

  if (!action && method === 'GET') {
    sendJson(response, 200, {
      item: toAdminAnnouncementDto(existing, await announcementStore.getReadStateSummary(existing))
    });
    return;
  }

  if (!action && method === 'PATCH') {
    const updated = buildAdminAnnouncementItem(
      await readJsonObject(request),
      existing,
      adminAnnouncementActor(request),
      new Date()
    );
    const saved = await announcementStore.upsertItem(updated);
    sendJson(response, 200, {
      item: toAdminAnnouncementDto(saved, await announcementStore.getReadStateSummary(saved))
    });
    return;
  }

  if (method === 'POST' && action) {
    await readJsonBody(request);
    const now = new Date();
    const actor = adminAnnouncementActor(request);
    const changed = await applyAdminAnnouncementAction(existing, action, actor, now);
    const saved = await announcementStore.upsertItem(changed);
    sendJson(response, action === 'duplicate' ? 201 : 200, {
      item: toAdminAnnouncementDto(saved, await announcementStore.getReadStateSummary(saved))
    });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

function filterAdminAnnouncements(items: AnnouncementContentItem[], url: URL): AnnouncementContentItem[] {
  const type = nonEmptyQuery(url.searchParams.get('type')) as AnnouncementContentType | undefined;
  const status = nonEmptyQuery(url.searchParams.get('status')) as AnnouncementContentStatus | undefined;
  const visibility = nonEmptyQuery(url.searchParams.get('visibility'));
  const pinned = parseOptionalBoolean(url.searchParams.get('pinned'));
  const active = parseOptionalBoolean(url.searchParams.get('active') ?? url.searchParams.get('currentlyActive'));
  const keyword = nonEmptyQuery(url.searchParams.get('q') ?? url.searchParams.get('keyword'), 120)?.toLowerCase();
  const now = new Date();
  return items.filter((item) => {
    if (type && item.type !== type) return false;
    if (status && item.status !== status) return false;
    if (visibility && item.visibility !== visibility) return false;
    if (pinned !== undefined && item.pinned !== pinned) return false;
    if (active !== undefined) {
      const isActive =
        item.status === 'published' &&
        (!item.startsAt || Date.parse(item.startsAt) <= now.getTime()) &&
        (!item.endsAt || Date.parse(item.endsAt) >= now.getTime());
      if (isActive !== active) return false;
    }
    if (keyword) {
      const translatedText = item.translations
        ? Object.values(item.translations).map((translation) => `${translation.title} ${translation.summary} ${translation.body}`).join(' ')
        : '';
      const haystack = `${item.id} ${item.type} ${item.status} ${item.title} ${item.summary} ${item.body} ${translatedText}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    return true;
  });
}

function buildAdminAnnouncementItem(
  body: Record<string, unknown>,
  existing: AnnouncementContentItem | undefined,
  actor: string,
  now: Date
): AnnouncementContentItem {
  if (existing?.status === 'archived') {
    throw new HttpError(
      409,
      'Archived announcements cannot be edited; duplicate as a new draft first',
      'ANNOUNCEMENT_ARCHIVED'
    );
  }
  const nowIso = now.toISOString();
  const base: AnnouncementContentItem = existing
    ? { ...existing }
    : {
        id: typeof body.id === 'string' && body.id.trim() ? body.id.trim() : createAnnouncementId(body.type, now),
        type: 'announcement',
        status: 'draft',
        title: '',
        summary: '',
        body: '',
        visibility: 'restricted',
        requiresLogin: true,
        roleAllowList: [],
        requiredGrants: {},
        pinned: false,
        priority: 0,
        modalBehavior: 'none',
        revision: 1,
        createdAt: nowIso,
        updatedAt: nowIso,
        createdBy: actor,
        updatedBy: actor
      };

  const before = announcementRevisionFingerprint(base);
  for (const field of ADMIN_ANNOUNCEMENT_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      (base as unknown as Record<string, unknown>)[field] = body[field];
    }
  }
  synchronizeAnnouncementTranslations(base, body, existing);
  if (!existing) {
    base.status = 'draft';
  }
  if (Object.prototype.hasOwnProperty.call(body, 'sourceRef')) {
    const sourceRef = normalizeAdminAnnouncementSourceRef(body.sourceRef);
    if (sourceRef) {
      base.sourceRef = sourceRef;
    } else {
      delete base.sourceRef;
    }
  }
  base.updatedAt = nowIso;
  base.updatedBy = actor;
  if (existing && announcementRevisionFingerprint(base) !== before) {
    base.revision = existing.revision + 1;
  }

  return normalizeAdminAnnouncementOrThrow(base);
}

async function applyAdminAnnouncementAction(
  existing: AnnouncementContentItem,
  action: string,
  actor: string,
  now: Date
): Promise<AnnouncementContentItem> {
  const nowIso = now.toISOString();
  if (action === 'publish') {
    const next = normalizeAdminAnnouncementOrThrow({
      ...existing,
      status: 'published',
      publishedAt: existing.publishedAt ?? nowIso,
      updatedAt: nowIso,
      updatedBy: actor
    });
    validateAnnouncementPublishOrThrow(next, now);
    return next;
  }
  if (action === 'offline') {
    return normalizeAdminAnnouncementOrThrow({
      ...existing,
      status: 'offline',
      updatedAt: nowIso,
      updatedBy: actor
    });
  }
  if (action === 'archive') {
    return normalizeAdminAnnouncementOrThrow({
      ...existing,
      status: 'archived',
      updatedAt: nowIso,
      updatedBy: actor
    });
  }
  if (action === 'duplicate') {
    const translations = existing.translations
      ? {
          ...existing.translations,
          'zh-CN': {
            ...existing.translations['zh-CN'],
            title: `${existing.translations['zh-CN'].title} Copy`.slice(0, 160)
          },
          ...(existing.translations['en-US']
            ? {
                'en-US': {
                  ...existing.translations['en-US'],
                  title: `${existing.translations['en-US'].title} Copy`.slice(0, 160)
                }
              }
            : {})
        }
      : undefined;
    return normalizeAdminAnnouncementOrThrow({
      ...existing,
      id: createAnnouncementId(existing.type, now),
      status: 'draft',
      title: `${existing.title} Copy`.slice(0, 160),
      translations,
      revision: 1,
      publishedAt: undefined,
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: actor,
      updatedBy: actor
    });
  }
  throw new HttpError(404, 'Not found', 'ANNOUNCEMENT_ACTION_NOT_FOUND');
}

const ADMIN_ANNOUNCEMENT_EDITABLE_FIELDS = [
  'type',
  'title',
  'summary',
  'body',
  'translations',
  'visibility',
  'requiresLogin',
  'roleAllowList',
  'requiredGrants',
  'pinned',
  'priority',
  'modalBehavior',
  'startsAt',
  'endsAt'
] as const;

function validateAnnouncementPublishOrThrow(item: AnnouncementContentItem, now: Date): void {
  try {
    validateAnnouncementContentItem(item);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : 'Invalid announcement',
      'ANNOUNCEMENT_INVALID'
    );
  }
  if (item.modalBehavior === 'force_until_expiry') {
    const startsAt = Date.parse(item.startsAt ?? now.toISOString());
    const endsAt = item.endsAt ? Date.parse(item.endsAt) : Number.NaN;
    if (!Number.isFinite(endsAt) || endsAt <= startsAt) {
      throw new HttpError(400, 'endsAt must be after startsAt');
    }
    if (endsAt - startsAt > 7 * 24 * 60 * 60 * 1000) {
      throw new HttpError(400, 'force_until_expiry duration must not exceed 7 days');
    }
  }
  const zh = item.translations?.['zh-CN'];
  const en = item.translations?.['en-US'];
  if (!isCompleteAnnouncementTranslation(zh) || !isCompleteAnnouncementTranslation(en)) {
    throw new HttpError(
      400,
      'Published content requires complete zh-CN and en-US translations',
      'ANNOUNCEMENT_TRANSLATIONS_REQUIRED'
    );
  }
  const text = `${zh.title}\n${zh.summary}\n${zh.body}\n${en.title}\n${en.summary}\n${en.body}`;
  if (containsUnsafePublishText(text)) {
    throw new HttpError(400, 'Published announcement body contains internal path or secret-like text');
  }
}

function containsUnsafePublishText(text: string): boolean {
  return (
    /\b(api[_-]?key|token|jwt|cookie|password|mcp[_-]?key|secret)\s*[:=]/i.test(text) ||
    /(^|[\s"'(])([A-Za-z]:\\|\.planning[\\/]|\/opt\/|\/root\/|\/var\/lib\/)/i.test(text) ||
    /\b(phase\s+\d+|uat|review|closeout|internal note)\b/i.test(text)
  );
}

function normalizeAdminAnnouncementOrThrow(value: AnnouncementContentItem): AnnouncementContentItem {
  try {
    const normalized = normalizeAnnouncementContentItem(value);
    validateAnnouncementContentItem(normalized);
    return normalized;
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid announcement');
  }
}

function announcementRevisionFingerprint(item: AnnouncementContentItem): string {
  const material: Record<string, unknown> = {};
  for (const field of ADMIN_ANNOUNCEMENT_EDITABLE_FIELDS) {
    material[field] = (item as unknown as Record<string, unknown>)[field];
  }
  material.sourceRef = item.sourceRef;
  return JSON.stringify(material);
}

function normalizeAdminAnnouncementSourceRef(value: unknown): AnnouncementSourceRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind !== 'manual' && kind !== 'phase_release_note' && kind !== 'phase_changelog') {
    return undefined;
  }
  return {
    kind,
    ...(typeof value.phase === 'number' && Number.isInteger(value.phase) && value.phase > 0 ? { phase: value.phase } : {}),
    ...(typeof value.version === 'string' && value.version.trim() ? { version: value.version.trim().slice(0, 80) } : {}),
    ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim().slice(0, 500) } : {})
  };
}

function toAdminAnnouncementDto(
  item: AnnouncementContentItem,
  readStateSummary?: AnnouncementReadStateSummary
): AnnouncementContentItem & { readStateSummary: AnnouncementReadStateSummary } {
  return {
    ...item,
    readStateSummary: readStateSummary ?? { revision: item.revision, readCount: 0, dismissedCount: 0 }
  };
}

function createAnnouncementId(type: unknown, now: Date): string {
  const normalizedType =
    type === 'announcement' || type === 'news' || type === 'release_note' || type === 'changelog' ? type : 'announcement';
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  return `${normalizedType}-${date}-${crypto.randomUUID().slice(0, 8)}`;
}

function adminAnnouncementActor(request: AuthenticatedRequest): string {
  return request.user?.username || request.user?.userId || 'admin';
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  if (value === 'true' || value === '1') {
    return true;
  }
  if (value === 'false' || value === '0') {
    return false;
  }
  return undefined;
}

async function buildCurrentMcpAuthorizationSummary(
  auth: AuthRuntime,
  userId: string,
  keyId: string,
  chips: ChipRuntime | null
): Promise<EffectiveAuthorizationSummary> {
  const user = await auth.userStore.findById(userId);
  const key = user?.mcpKeys.find((candidate) => candidate.id === keyId);
  if (!user || !key) {
    throw new AuthorizationHttpError('Access is not available for this key.');
  }
  return buildEffectiveAuthorizationSummary(auth, user, chips, key);
}

function assertAuthorizedResource(
  summary: EffectiveAuthorizationSummary,
  resource: Parameters<typeof authorizeResourceAccess>[1],
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  context: Record<string, unknown> = {}
): void {
  const decision = authorizeResourceAccess(summary, resource);
  if (decision.allowed) {
    return;
  }
  logAuthorizationDenied(persistence, logger, decision, context);
  throw new AuthorizationHttpError(decision.safeMessage, decision);
}

function assertAuthorizedChipResource(
  summary: EffectiveAuthorizationSummary,
  _chips: ChipRuntime,
  _user: AuthenticatedRequest['user'],
  chipId: string,
  _prompts: PromptRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  context: Record<string, unknown> = {}
): void {
  const decision = authorizeResourceAccess(summary, { type: 'chip', id: chipId });
  if (decision.allowed) {
    return;
  }
  logAuthorizationDenied(persistence, logger, decision, context);
  throw new AuthorizationHttpError(decision.safeMessage, decision);
}

// V6：不再手搓 authorizeResourceAccess 入参（只喂 visibility + requiredGrants、从不看 status），
// 改为直接复用 evaluateDocumentVisibility 这一单一事实源（与列表/解析器口径一致）。
// 非 approved 的文档会被评估器短路为 adminOnly 可见性，从而对非 admin 用户一致拒绝，
// 即便其 visibility 字段本身是 public。
function assertAuthorizedDocument(
  summary: EffectiveAuthorizationSummary,
  resources: ResourceRuntime | null,
  documentId: string,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  context: Record<string, unknown> = {}
): void {
  const document = findDocumentContract(resources?.catalog, documentId);
  if (!document) {
    denyUnknownAuthorizedResource(summary, 'document', persistence, logger, context);
    return;
  }
  const decision = evaluateDocumentVisibility(summary, document);
  if (decision.allowed) {
    return;
  }
  logAuthorizationDenied(persistence, logger, decision, context);
  throw new AuthorizationHttpError(decision.safeMessage, decision);
}

// V6：同上，scopePreset 断言改走 evaluateScopePresetVisibility 单一事实源。
function assertAuthorizedScopePreset(
  summary: EffectiveAuthorizationSummary,
  resources: ResourceRuntime | null,
  scopePresetId: string,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  context: Record<string, unknown> = {}
): void {
  const scopePreset = findScopePresetContract(resources?.catalog, scopePresetId);
  if (!scopePreset) {
    denyUnknownAuthorizedResource(summary, 'scopePreset', persistence, logger, context);
    return;
  }
  const decision = evaluateScopePresetVisibility(summary, scopePreset);
  if (decision.allowed) {
    return;
  }
  logAuthorizationDenied(persistence, logger, decision, context);
  throw new AuthorizationHttpError(decision.safeMessage, decision);
}

function denyUnknownAuthorizedResource(
  summary: EffectiveAuthorizationSummary,
  resourceType: 'document' | 'scopePreset',
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  context: Record<string, unknown> = {}
): never {
  const decision: AuthorizationDecision = {
    allowed: false,
    reasonCode: 'resource_not_granted',
    safeMessage: 'The requested resource is not available to this identity.',
    audit: {
      ...summary.audit,
      resourceType,
      reasonCode: 'resource_not_granted'
    },
    matchedGrants: []
  };
  logAuthorizationDenied(persistence, logger, decision, context);
  throw new AuthorizationHttpError(decision.safeMessage, decision);
}

function logAuthorizationDenied(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  decision: AuthorizationDecision,
  context: Record<string, unknown>
): void {
  const metadata = redactAuthorizationMetadata({
    ...context,
    reasonCode: decision.reasonCode,
    resourceType: decision.audit.resourceType,
    visibility: decision.audit.visibility,
    userId: decision.audit.userId,
    role: decision.audit.role,
    keyFingerprint: decision.audit.keyFingerprint
  });
  logger.warn(LOG_EVENTS.authorizationDenied, 'Authorization denied', {
    userId: decision.audit.userId,
    metadata
  });
  persistence?.auditLogger.log(LOG_EVENTS.authorizationDenied, 'Authorization denied', {
    userId: decision.audit.userId,
    metadata
  });
}

async function getRoleResourceGrants(auth: AuthRuntime, roleName: string): Promise<ResourceGrantInput | undefined> {
  if (!auth.rolesService) {
    return undefined;
  }
  try {
    const role = await auth.rolesService.getRole(roleName);
    return mergeResourceGrantInputs(mapAllowedChipsToResourceGrants(role.access.allowedChips), role.access.grants);
  } catch {
    return undefined;
  }
}

function mergeResourceGrantInputs(...inputs: Array<ResourceGrantInput | undefined>): ResourceGrantSet {
  const normalized = inputs.map((input) => normalizeResourceGrantSet(input));
  return {
    brands: mergeGrantList(normalized.map((input) => input.brands)),
    productLines: mergeGrantList(normalized.map((input) => input.productLines)),
    chipIds: mergeGrantList(normalized.map((input) => input.chipIds)),
    documentIds: mergeGrantList(normalized.map((input) => input.documentIds)),
    scopePresetIds: mergeGrantList(normalized.map((input) => input.scopePresetIds)),
    modelIds: mergeGrantList(normalized.map((input) => input.modelIds)) as ResourceGrantSet['modelIds'],
    mcpTools: mergeGrantList(normalized.map((input) => input.mcpTools))
  };
}

function mergeGrantList<T extends string>(sets: T[][]): T[] {
  const merged: T[] = [];
  for (const set of sets) {
    if (set.includes('*' as T)) {
      return ['*' as T];
    }
    for (const item of set) {
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
  }
  return merged;
}

function listModelsForAuthorization(summary: EffectiveAuthorizationSummary) {
  if (!summary.usable) {
    return [];
  }
  if (summary.grants.modelIds.includes('*')) {
    return listEnabledModels();
  }
  return listEnabledModels().filter((model) => summary.grants.modelIds.includes(model.id));
}

function listSearchModesForAuthorization(
  summary: EffectiveAuthorizationSummary,
  entryPoint: SearchModeEntryPoint,
  creditBalanceUnits?: number,
  modelRouting?: ModelRoutingRuntime
) {
  return resolveSearchModeAvailability({
    entryPoint,
    authorizedModelIds: listModelsForAuthorization(summary).map((model) => model.id),
    creditBalanceUnits,
    modeRoleMapping: modelRouting?.config.modeRoleMapping
  });
}

function listSearchModesForRequest(
  request: AuthenticatedRequest,
  entryPoint: SearchModeEntryPoint,
  includesImageInput = false,
  modelRouting?: ModelRoutingRuntime
) {
  return resolveSearchModeAvailability({
    entryPoint,
    includesImageInput,
    role: request.user?.role ?? (request.user?.userId ? undefined : 'admin'),
    userModelGrants: request.user?.authorizedModels,
    creditBalanceUnits: request.user?.credits?.balanceUnits,
    modeRoleMapping: modelRouting?.config.modeRoleMapping
  });
}

function assertSearchModeSelectableForRequest(
  request: AuthenticatedRequest,
  entryPoint: SearchModeEntryPoint,
  requestedMode: unknown,
  requestedModelId?: unknown,
  includesImageInput = false,
  modelRouting?: ModelRoutingRuntime
): void {
  const selection = resolveSearchModeSelection({
    entryPoint,
    includesImageInput,
    requestedMode,
    requestedModelId,
    role: request.user?.role ?? (request.user?.userId ? undefined : 'admin'),
    userModelGrants: request.user?.authorizedModels,
    creditBalanceUnits: request.user?.credits?.balanceUnits,
    modeRoleMapping: modelRouting?.config.modeRoleMapping
  });
  if (!selection.ok) {
    throw new HttpError(selection.statusCode, selection.message, selection.code, selection.details);
  }
}

function filterAllowedMcpActions(summary: EffectiveAuthorizationSummary): string[] {
  if (!summary.usable) {
    return [];
  }
  if (summary.grants.mcpTools.includes('*')) {
    return [...AGENTX_MCP_TOOL_NAMES];
  }
  const allowed = new Set(summary.grants.mcpTools);
  return AGENTX_MCP_TOOL_NAMES.filter((toolName) => allowed.has(toolName));
}

function listAuthorizedPublicChips(
  chips: ChipRuntime,
  summary: EffectiveAuthorizationSummary,
  _prompts: PromptRuntime | null
) {
  const publicChips = listPublicChips(chips.catalog);
  if (!summary.usable) {
    return [];
  }
  return publicChips.filter((chip) => canRequestAccessChip(summary, chip.id));
}

function listAuthorizedChipResources(
  chips: ChipRuntime,
  summary: EffectiveAuthorizationSummary,
  prompts: PromptRuntime | null
) {
  return listAuthorizedPublicChips(chips, summary, prompts).map(publicChipToWhoamiResource);
}

function listVisibleResources(
  chips: ChipRuntime | null,
  resources: ResourceRuntime | null,
  summary: EffectiveAuthorizationSummary,
  prompts: PromptRuntime | null
) {
  return [
    ...(chips ? listAuthorizedChipResources(chips, summary, prompts) : []),
    ...listVisibleResourceSummaries(resources?.catalog, summary)
  ];
}

function listSafeScopeCatalogMetadata(
  chips: ChipRuntime | null,
  resources: ResourceRuntime | null,
  visibleResources: Array<{ type: string; id: string }>
) {
  const visibleIds = new Set(visibleResources.map((resource) => `${resource.type}:${resource.id}`));
  const visibleChips = chips ? listPublicChips(chips.catalog).filter((chip) => visibleIds.has(`chip:${chip.id}`)) : [];
  const visibleScopePresets = (resources?.catalog.scopePresets ?? [])
    .filter((preset) => visibleIds.has(`scopePreset:${preset.scopePresetId}`))
    .map((preset) => ({
      id: preset.scopePresetId,
      label: preset.label,
      brands: [...preset.brands],
      productLines: [...preset.productLines],
      applicationTags: [...preset.applicationTags],
      chipCount: preset.chipIds.length,
      documentCount: preset.documentIds.length,
      sourceLabels: [...preset.sourceLabels]
    }));
  return {
    brands: summarizeMetadataValues(visibleChips.flatMap((chip) => chip.brand ? [chip.brand] : [])),
    productLines: summarizeMetadataValues(visibleChips.flatMap((chip) => chip.productLines ?? [])),
    applications: summarizeMetadataValues(visibleChips.flatMap((chip) => chip.applicationTags ?? [])),
    scopePresets: visibleScopePresets
  };
}

function summarizeMetadataValues(values: string[]) {
  return [...new Set(values)].map((id) => ({ id, label: id }));
}

function getRequestOrigin(request: IncomingMessage, url: URL): string {
  const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
  const proto = forwardedProto?.split(',')[0]?.trim() || url.protocol.replace(':', '') || 'http';
  const host = forwardedHost?.split(',')[0]?.trim() || firstHeaderValue(request.headers.host) || url.host || DEFAULT_HOST;
  return `${proto}://${host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isAccountApiPath(pathname: string): boolean {
  return pathname === '/api/account' || pathname.startsWith('/api/account/');
}

function stripAccountApiPrefix(pathname: string): string {
  if (pathname === '/api/account' || pathname === '/account') {
    return '';
  }
  if (pathname.startsWith('/api/account/')) {
    return pathname.slice('/api/account'.length);
  }
  if (pathname.startsWith('/account/')) {
    return pathname.slice('/account'.length);
  }
  return pathname;
}

async function handleAccountRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  auth: AuthRuntime,
  method: string,
  pathname: string,
  url: URL,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  creditLedger?: CreditLedger,
  chips?: ChipRuntime | null,
  prompts?: PromptRuntime | null,
  resources?: ResourceRuntime | null
): Promise<void> {
  if (!(await requireUsableAuth(request, response, auth.jwtService, auth.userStore))) {
    return;
  }

  const userId = request.user?.userId;
  if (!userId) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const accountPath = stripAccountApiPrefix(pathname);
  const user = await auth.userStore.findById(userId);
  if (!user) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  if (method === 'GET' && accountPath === '') {
    sendJson(response, 200, await buildAccountOverview(auth, user, creditLedger, chips, prompts, resources));
    return;
  }

  if (method === 'PUT' && accountPath === '/profile') {
    const body = await readJsonObject(request);
    const profileInput = isRecord(body.profile) || body.profile === null ? body.profile : body;
    const updated = await auth.userStore.updateOwnProfile(userId, normalizeAccountProfile(profileInput));
    logAccountAuditEvent(persistence, logger, request, LOG_EVENTS.accountProfileUpdate, 'Account profile updated', {
      actorUserId: userId,
      actorUsername: request.user?.username
    });
    sendJson(response, 200, { user: toAccountUserDto(auth.userStore.toPublicUser(updated)) });
    return;
  }

  if (method === 'PUT' && accountPath === '/locale') {
    const body = await readJsonObject(request);
    const locale = parseAccountLocaleInput(body);
    const updated = await auth.userStore.updateOwnLocale(userId, locale);
    logAccountAuditEvent(persistence, logger, request, LOG_EVENTS.accountLocaleUpdate, 'Account locale updated', {
      actorUserId: userId,
      actorUsername: request.user?.username,
      locale,
      preferredLanguage: locale
    });
    sendJson(response, 200, { user: toAccountUserDto(auth.userStore.toPublicUser(updated)) });
    return;
  }

  if (method === 'PUT' && accountPath === '/onboarding') {
    const body = await readJsonObject(request);
    const onboarding = parseAccountOnboardingInput(body);
    const updated = await auth.userStore.updateOwnOnboarding(userId, onboarding);
    const publicUser = auth.userStore.toPublicUser(updated);
    logAccountAuditEvent(persistence, logger, request, LOG_EVENTS.accountOnboardingUpdate, 'Account onboarding updated', {
      actorUserId: userId,
      actorUsername: request.user?.username,
      status: publicUser.onboarding.status,
      completedSteps: publicUser.onboarding.completedSteps,
      dismissedHints: publicUser.onboarding.dismissedHints
    });
    sendJson(response, 200, { user: toAccountUserDto(publicUser) });
    return;
  }

  if (method === 'PUT' && accountPath === '/password') {
    const body = await readJsonObject(request);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword) {
      sendJson(response, 400, { error: 'currentPassword and newPassword are required' });
      return;
    }
    if (!(await auth.userStore.verifyPassword(userId, currentPassword))) {
      sendJson(response, 401, { error: 'Current password is incorrect' });
      return;
    }
    const updated = await auth.userStore.updatePassword(userId, newPassword);
    logAccountAuditEvent(persistence, logger, request, LOG_EVENTS.accountPasswordChange, 'Account password changed', {
      actorUserId: userId,
      actorUsername: request.user?.username
    });
    sendJson(response, 200, { user: toAccountUserDto(auth.userStore.toPublicUser(updated)) });
    return;
  }

  if (method === 'GET' && accountPath === '/credits') {
    const limit = Math.min(parseOptionalPositiveInt(url.searchParams.get('limit')) ?? 20, 100);
    const credits = creditLedger ? await creditLedger.query({ userId, limit }) : { items: [], total: 0, offset: 0, limit };
    sendJson(response, 200, {
      balanceUnits: await auth.userStore.getCreditBalanceUnits(userId),
      ledger: credits
    });
    return;
  }

  if (method === 'GET' && accountPath === '/mcp-keys') {
    sendJson(response, 200, { keys: await auth.userStore.listOwnMcpKeys(userId) });
    return;
  }

  if (method === 'POST' && accountPath === '/mcp-keys') {
    const body = await readJsonObject(request);
    try {
      const created = await auth.userStore.createSelfServiceMcpKey(userId, parseAccountMcpKeyInput(body));
      logAccountKeyEvent(persistence, logger, request, LOG_EVENTS.accountMcpKeyCreate, 'Account MCP key created', created.key);
      sendJson(response, 201, created);
      return;
    } catch (error) {
      sendAccountStoreError(response, error);
      return;
    }
  }

  const regenerateMatch = /^\/mcp-keys\/([^/]+)\/regenerate$/.exec(accountPath);
  if (method === 'POST' && regenerateMatch?.[1]) {
    try {
      const regenerated = await auth.userStore.regenerateSelfServiceMcpKey(userId, decodeURIComponent(regenerateMatch[1]));
      logAccountKeyEvent(persistence, logger, request, LOG_EVENTS.accountMcpKeyRegenerate, 'Account MCP key regenerated', regenerated.key);
      sendJson(response, 200, regenerated);
      return;
    } catch (error) {
      sendAccountStoreError(response, error);
      return;
    }
  }

  const keyMatch = /^\/mcp-keys\/([^/]+)$/.exec(accountPath);
  if (keyMatch?.[1] && method === 'PUT') {
    const body = await readJsonObject(request);
    try {
      const key = await auth.userStore.updateOwnMcpKey(userId, decodeURIComponent(keyMatch[1]), parseAccountMcpKeyPatch(body));
      logAccountKeyEvent(persistence, logger, request, LOG_EVENTS.accountMcpKeyUpdate, 'Account MCP key updated', key);
      sendJson(response, 200, { key });
      return;
    } catch (error) {
      sendAccountStoreError(response, error);
      return;
    }
  }

  if (keyMatch?.[1] && method === 'DELETE') {
    const keyId = decodeURIComponent(keyMatch[1]);
    const existing = (await auth.userStore.listOwnMcpKeys(userId)).find((key) => key.id === keyId);
    if (!existing) {
      sendJson(response, 404, { error: 'MCP key not found' });
      return;
    }
    const removed = await auth.userStore.removeMcpKey(userId, keyId);
    if (!removed) {
      sendJson(response, 404, { error: 'MCP key not found' });
      return;
    }
    logAccountKeyEvent(persistence, logger, request, LOG_EVENTS.accountMcpKeyRevoke, 'Account MCP key revoked', existing);
    response.statusCode = 204;
    response.end();
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

async function buildAccountOverview(
  auth: AuthRuntime,
  user: User,
  creditLedger?: CreditLedger,
  chips?: ChipRuntime | null,
  prompts?: PromptRuntime | null,
  resources?: ResourceRuntime | null
) {
  const userStore = auth.userStore;
  const publicUser = userStore.toPublicUser(user);
  const policy = userStore.getSelfServicePolicy(user);
  const authorizationSummary = await buildEffectiveAuthorizationSummary(auth, user, chips ?? null);
  const availableModels = listModelsForAuthorization(authorizationSummary);
  const recentCredits = creditLedger
    ? await creditLedger.query({ userId: user.id, limit: 5 })
    : { items: [], total: 0, offset: 0, limit: 5 };
  const visibleResources = listVisibleResources(chips ?? null, resources ?? null, authorizationSummary, prompts ?? null);
  const scopeCatalog = listSafeScopeCatalogMetadata(chips ?? null, resources ?? null, visibleResources);
  const mcpKeys = await Promise.all(
    publicUser.mcpKeys.map(async (key) => {
      const rawKey = user.mcpKeys.find((candidate) => candidate.id === key.id);
      const keySummary = rawKey
        ? await buildEffectiveAuthorizationSummary(auth, user, chips ?? null, rawKey)
        : authorizationSummary;
      return {
        ...key,
        authorizedModels: keySummary.grants.modelIds.filter((modelId): modelId is ModelId => modelId !== '*'),
        resources: listVisibleResources(chips ?? null, resources ?? null, keySummary, prompts ?? null),
        authorizedTools: keySummary.grants.mcpTools,
        authorizationSummary: keySummary
      };
    })
  );

  return {
    user: toAccountUserDto({ ...publicUser, mcpKeys, authorizationSummary }),
    permissions: {
      role: publicUser.role,
      authorizedModels: authorizationSummary.grants.modelIds,
      availableModels,
      searchModes: resolveSearchModeAvailability({
        entryPoint: 'web-chat',
        role: publicUser.role,
        authorizedModelIds: availableModels.map((model) => model.id),
        creditBalanceUnits: publicUser.credits?.balanceUnits
      }),
      authorizedTools: authorizationSummary.grants.mcpTools,
      authorizationSummary,
      mcpKeyPolicy: policy,
      selfService: {
        profile: true,
        password: true,
        mcpKeys: policy.allowMcpKeySelfCreate,
        mcpKeyRegenerate: policy.allowMcpKeyRegenerate
      },
      resources: visibleResources,
      scopeCatalog
    },
    credits: {
      ...publicUser.credits,
      recentLedger: recentCredits
    },
    mcpKeys
  };
}

function toAccountUserDto(user: PublicUser): PublicUser {
  const profile = user.profile ? { ...user.profile } : undefined;
  if (profile) {
    delete profile.note;
  }
  return {
    ...user,
    profile,
    mcpKeys: user.mcpKeys
  };
}

function parseAccountMcpKeyInput(body: Record<string, unknown>): { name: string; expiresAt?: string | null } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    throw new HttpError(400, 'name is required');
  }
  return { name, expiresAt: parseOptionalIsoDateInput(body.expiresAt, 'expiresAt') };
}

function parseAccountMcpKeyPatch(body: Record<string, unknown>): { name?: string; expiresAt?: string | null } {
  const patch: { name?: string; expiresAt?: string | null } = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new HttpError(400, 'name must be a non-empty string');
    }
    patch.name = body.name.trim();
  }
  if (body.expiresAt !== undefined) {
    const expiresAt = parseOptionalIsoDateInput(body.expiresAt, 'expiresAt');
    if (expiresAt === null) {
      throw new HttpError(400, 'Self-service MCP keys require an expiry');
    }
    patch.expiresAt = expiresAt;
  }
  return patch;
}

function parseOptionalIsoDateInput(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isIsoDateString(value)) {
    throw new HttpError(400, fieldName + ' must be an ISO date');
  }
  return value;
}

function normalizeAccountProfile(value: unknown): UserProfile | null {
  if (value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new HttpError(400, 'profile must be an object');
  }
  const profile: UserProfile = {};
  for (const field of ['realName', 'company', 'email', 'jobTitle', 'contact', 'usagePurpose'] as const) {
    const raw = value[field];
    if (typeof raw === 'string' && raw.trim()) {
      profile[field] = raw.trim();
    }
  }
  if (typeof value.userType === 'string') {
    profile.userType = value.userType as UserProfile['userType'];
  }
  for (const field of ['focusBrands', 'focusProductLines', 'focusChipDirections'] as const) {
    const raw = value[field];
    if (Array.isArray(raw)) {
      const normalized = [...new Set(raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
      if (normalized.length > 0) {
        profile[field] = normalized;
      }
    }
  }
  return Object.keys(profile).length > 0 ? profile : null;
}

function parseAccountLocaleInput(body: Record<string, unknown>): 'zh-CN' | 'en-US' {
  const raw = body.locale ?? body.localePreference ?? body.preferredLanguage;
  if (!isLocalePreference(raw)) {
    throw new HttpError(400, 'locale must be one of zh-CN or en-US');
  }
  return raw;
}

function parseAccountOnboardingInput(body: Record<string, unknown>): {
  status?: OnboardingStatus;
  completedSteps?: OnboardingStep[];
  dismissedHints?: string[];
  updatedAt?: string;
} {
  const patch: {
    status?: OnboardingStatus;
    completedSteps?: OnboardingStep[];
    dismissedHints?: string[];
    updatedAt?: string;
  } = {};
  if (body.status !== undefined) {
    if (
      body.status !== 'not_started' &&
      body.status !== 'in_progress' &&
      body.status !== 'skipped' &&
      body.status !== 'completed'
    ) {
      throw new HttpError(400, 'Unsupported onboarding status');
    }
    patch.status = body.status;
  }
  const completedSteps = body.completedSteps ?? body.steps;
  if (completedSteps !== undefined) {
    patch.completedSteps = parseOnboardingSteps(completedSteps);
  }
  if (body.completeStep !== undefined) {
    const existing = patch.completedSteps ?? [];
    patch.completedSteps = [...new Set([...existing, parseOnboardingStep(body.completeStep)])];
  }
  if (body.dismissedHints !== undefined) {
    patch.dismissedHints = parseDismissedHints(body.dismissedHints);
  }
  patch.updatedAt = new Date().toISOString();
  return patch;
}

function parseOnboardingSteps(value: unknown): OnboardingStep[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'completedSteps must be an array');
  }
  return [...new Set(value.map(parseOnboardingStep))];
}

function parseOnboardingStep(value: unknown): OnboardingStep {
  if (typeof value !== 'string' || !(ONBOARDING_STEPS as readonly string[]).includes(value)) {
    throw new HttpError(400, 'Unsupported onboarding step');
  }
  return value as OnboardingStep;
}

function parseDismissedHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, 'dismissedHints must be an array');
  }
  return [
    ...new Set(
      value.map((item) => {
        if (typeof item !== 'string' || !/^[a-z0-9_.:-]{1,64}$/i.test(item)) {
          throw new HttpError(400, 'Unsupported dismissed hint');
        }
        return item;
      })
    )
  ].slice(0, 50);
}

function logAccountKeyEvent(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  request: AuthenticatedRequest,
  event: string,
  message: string,
  key: PublicMcpKey
): void {
  logAccountAuditEvent(persistence, logger, request, event, message, {
    actorUserId: request.user?.userId,
    actorUsername: request.user?.username,
    keyId: key.id,
    keyFingerprint: key.fingerprint,
    path: request.url
  });
}

function logAccountAuditEvent(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  request: AuthenticatedRequest,
  event: string,
  message: string,
  metadata: Record<string, unknown>
): void {
  const context = {
    userId: request.user?.userId,
    metadata
  };
  if (persistence) {
    persistence.auditLogger.log(event, message, context);
    return;
  }
  logger.info(event, message, context);
}

function logAdminSelfServicePolicyUpdate(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  request: AuthenticatedRequest,
  previous: User | null,
  nextPolicy: UserSelfServicePolicy | undefined
): void {
  const metadata = {
    actorUserId: request.user?.userId,
    actorUsername: request.user?.username,
    targetUserId: previous?.id,
    targetUsername: previous?.username,
    previousPolicy: sanitizeSelfServicePolicyForAudit(previous?.selfService),
    nextPolicy: sanitizeSelfServicePolicyForAudit(nextPolicy),
    source: 'admin'
  };
  logAccountAuditEvent(
    persistence,
    logger,
    request,
    LOG_EVENTS.adminSelfServicePolicyUpdate,
    'Admin self-service policy updated',
    metadata
  );
}

function logAdminAuthorizationPolicyUpdate(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  request: AuthenticatedRequest,
  previous: User | null,
  next: PublicUser,
  changedCategories: string[]
): void {
  const metadata = {
    actorUserId: request.user?.userId,
    actorUsername: request.user?.username,
    targetUserId: previous?.id,
    targetUsername: previous?.username,
    changedCategories,
    previousResourceGrants: sanitizeResourceGrantsForAudit(previous?.resourceGrants),
    nextResourceGrants: sanitizeResourceGrantsForAudit(next.resourceGrants),
    previousModelGrants: previous?.modelGrants ?? [],
    nextModelGrants: next.authorizedModels,
    source: 'admin'
  };
  logAccountAuditEvent(
    persistence,
    logger,
    request,
    LOG_EVENTS.adminAuthorizationPolicyUpdate,
    'Admin authorization policy updated',
    metadata
  );
}

function logAdminKeyAuthorizationPolicyUpdate(
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  request: AuthenticatedRequest,
  targetUserId: string,
  key: PublicMcpKey,
  changedCategories: string[]
): void {
  logAccountAuditEvent(
    persistence,
    logger,
    request,
    LOG_EVENTS.adminAuthorizationPolicyUpdate,
    'Admin MCP key authorization policy updated',
    {
      actorUserId: request.user?.userId,
      actorUsername: request.user?.username,
      targetUserId,
      keyId: key.id,
      keyFingerprint: key.fingerprint,
      changedCategories,
      nextResourceGrants: sanitizeResourceGrantsForAudit(key.resourceGrants),
      nextModelGrants: key.modelGrants ?? [],
      source: 'admin'
    }
  );
}

function getAdminAuthorizationChangedCategories(body: Record<string, unknown>): string[] {
  const categories: string[] = [];
  if (body.role !== undefined) {
    categories.push('role');
  }
  if (body.modelGrants !== undefined) {
    categories.push('modelGrants');
  }
  if (body.resourceGrants !== undefined) {
    categories.push('resourceGrants');
  }
  return categories;
}

function sanitizeSelfServicePolicyForAudit(
  policy: UserSelfServicePolicy | null | undefined
): UserSelfServicePolicy {
  const safe: UserSelfServicePolicy = {};
  if (!policy) {
    return safe;
  }
  if (policy.allowMcpKeySelfCreate !== undefined) {
    safe.allowMcpKeySelfCreate = policy.allowMcpKeySelfCreate;
  }
  if (policy.maxMcpKeys !== undefined) {
    safe.maxMcpKeys = policy.maxMcpKeys;
  }
  if (policy.defaultMcpKeyTtlDays !== undefined) {
    safe.defaultMcpKeyTtlDays = policy.defaultMcpKeyTtlDays;
  }
  if (policy.allowMcpKeyRegenerate !== undefined) {
    safe.allowMcpKeyRegenerate = policy.allowMcpKeyRegenerate;
  }
  return safe;
}

function sanitizeResourceGrantsForAudit(grants: ResourceGrantInput | null | undefined): ResourceGrantSet {
  return normalizeResourceGrantSet(grants ?? {});
}
function sendAccountStoreError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {})
    });
    return;
  }
  if (error instanceof Error) {
    if (error.message === 'MCP key not found') {
      sendJson(response, 404, { error: 'MCP key not found' });
      return;
    }
    if (error.message === 'MCP key self-service is disabled' || error.message === 'MCP key regeneration is disabled') {
      sendJson(response, 403, { error: error.message });
      return;
    }
    if (error.message === 'MCP key limit reached') {
      sendJson(response, 409, { error: error.message });
      return;
    }
    if (error.message === 'Self-service MCP keys require an expiry') {
      sendJson(response, 400, { error: error.message });
      return;
    }
  }
  throw error;
}

function isIsoDateString(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function enrichDiscoveryTraces(
  traces: DiscoveryTraceEvent[],
  persistence: PersistenceRuntime | undefined,
  discoveryTraceStore?: DiscoveryTraceStore
): Promise<Array<DiscoveryTraceEvent & { type: SessionDebugBundleType; sessionId: string }>> {
  const hasStage1 = new Set(traces.filter((trace) => trace.stage === 'cc.stage1').map((trace) => trace.sessionId));
  const metaCache = new Map<string, SessionMeta | undefined>();
  const stage1Cache = new Map<string, boolean>();

  async function readMeta(sessionId: string): Promise<SessionMeta | undefined> {
    if (!persistence) return undefined;
    if (!metaCache.has(sessionId)) {
      metaCache.set(sessionId, await persistence.sessionStore.readSessionMeta(sessionId).catch(() => undefined));
    }
    return metaCache.get(sessionId);
  }

  async function sessionHasStage1(sessionId: string): Promise<boolean> {
    if (hasStage1.has(sessionId)) return true;
    if (!discoveryTraceStore) return false;
    if (!stage1Cache.has(sessionId)) {
      const sessionTraces = await discoveryTraceStore.list({ sessionId }).catch(() => []);
      stage1Cache.set(sessionId, sessionTraces.some((trace) => trace.stage === 'cc.stage1'));
    }
    return stage1Cache.get(sessionId) ?? false;
  }

  const enriched: Array<DiscoveryTraceEvent & { type: SessionDebugBundleType; sessionId: string }> = [];
  for (const trace of traces) {
    const meta = await readMeta(trace.sessionId);
    enriched.push({
      ...trace,
      sessionId: trace.sessionId,
      type: deriveSessionDebugType(meta, await sessionHasStage1(trace.sessionId))
    });
  }
  return enriched;
}

function deriveSessionDebugType(meta: SessionMeta | undefined, hasStage1: boolean): SessionDebugBundleType {
  if (meta?.chipId && !meta.scopePresetId && !meta.scopeWorkspace) {
    return '单芯片';
  }
  if ((meta?.scopePresetId || meta?.scopeWorkspace) && hasStage1) {
    return '跨档两步';
  }
  return '全局';
}

/**
 * 模式与模型档位卡片的积分倍率需要按模型档位真实 creditUnits 动态计算（而非写死 ×1.0/×4.0/×8.0）。
 * 这里把模型目录以 { id, label, mode, creditUnits } 的精简形式带给前端，前端据此换算相对标准档的倍率。
 */
function buildModelRoutingCatalog(): Array<{ id: string; label: string; mode: string; creditUnits: number }> {
  return listEnabledModels().map((model) => ({
    id: model.id,
    label: model.label,
    mode: model.mode,
    creditUnits: model.creditUnits
  }));
}

let claudeCodeCliVersionCache: Promise<string> | undefined;

/**
 * 判定一个「文件支撑的目录运行时」（chips / resources）的真实加载状态，供运行诊断卡片如实展示：
 * 只看 runtime 对象是否为真会误报——batch C 后 resources 缺文件时也返回一个空 catalog 运行时，
 * 若仍报「已加载」就是骗人。这里对配置文件做一次磁盘探测，区分「文件确实落地」与「跑在内存默认上」。
 */
async function resolveCatalogFileStatus(
  runtime: { configFile?: string } | null | undefined,
  configFile: string | undefined
): Promise<{ status: 'ok' | 'fallback' | 'missing'; detail?: string }> {
  if (!runtime) {
    return { status: 'missing' };
  }
  if (!configFile) {
    return { status: 'ok', detail: '内存模式（无配置文件）' };
  }
  try {
    await stat(configFile);
    return { status: 'ok', detail: configFile };
  } catch {
    return { status: 'fallback', detail: `${configFile}（文件缺失，使用内存默认）` };
  }
}

async function buildDiscoveryTraceSystemInfo(options: {
  auth: AuthRuntime | null;
  chips: ChipRuntime | null;
  prompts: PromptRuntime | null;
  resources: ResourceRuntime | null;
  persistence: PersistenceRuntime | undefined;
  dataDir: string;
}): Promise<DiscoveryTraceSystemInfo> {
  const chipsStatus = await resolveCatalogFileStatus(options.chips, options.chips?.configFile);
  const resourcesStatus = await resolveCatalogFileStatus(options.resources, options.resources?.configFile);
  const configStatusItems: DiscoveryTraceConfigStatusItem[] = [
    { name: 'auth', status: options.auth ? 'ok' : 'missing' },
    { name: 'chips', ...chipsStatus },
    { name: 'prompts', status: options.prompts ? 'ok' : 'missing' },
    { name: 'resources', ...resourcesStatus },
    {
      name: 'persistence',
      status: options.persistence ? 'ok' : 'missing',
      detail: options.persistence ? (options.persistence.dataDir ?? options.dataDir) : undefined
    }
  ];
  return {
    nodeVersion: process.version,
    agentBackend: 'claude-code',
    dataDir: options.persistence?.dataDir ?? options.dataDir,
    // 旧字符串字段保留兼容；结构化清单见 configStatusItems（D5：拆分系统信息/配置文件加载状态两卡）。
    configStatus: [
      `auth:${options.auth ? 'enabled' : 'disabled'}`,
      `chips:${options.chips ? 'loaded' : 'disabled'}`,
      `prompts:${options.prompts ? 'loaded' : 'disabled'}`,
      `resources:${options.resources ? 'loaded' : 'disabled'}`,
      `persistence:${options.persistence ? 'enabled' : 'disabled'}`
    ].join(', '),
    configStatusItems,
    claudeCodeCliVersion: await resolveClaudeCodeCliVersion(),
    platform: `${process.platform}/${process.arch}`
  };
}

function resolveClaudeCodeCliVersion(): Promise<string> {
  claudeCodeCliVersionCache ??= new Promise((resolve) => {
    execFile('claude', ['--version'], { timeout: 1500, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        resolve(code === 'ENOENT' ? 'not-found' : `unavailable: ${redactDebugText(error.message).text}`);
        return;
      }
      const output = `${stdout}${stderr}`.trim();
      resolve(output ? redactDebugText(output).text.split(/\r?\n/)[0] ?? 'unavailable: empty output' : 'unavailable: empty output');
    });
  });
  return claudeCodeCliVersionCache;
}

function auditAdminDebugRead(
  persistence: PersistenceRuntime,
  request: AuthenticatedRequest,
  sessionId: string,
  metadata: {
    outcome: 'ok' | 'not_found' | 'error';
    path: string;
    reason?: string;
    targetUserId?: string;
    error?: string;
  }
): void {
  persistence.auditLogger.log(LOG_EVENTS.adminAnalysisRead, 'Admin read session debug bundle', {
    sessionId,
    userId: request.user?.userId,
    metadata: {
      adminUserId: request.user?.userId,
      targetSessionId: sessionId,
      ...metadata
    }
  });
}

async function listPartialWorkspaceTree(cwd: string, maxEntries = 80): Promise<SessionDebugFileEntry[]> {
  const root = path.resolve(cwd);
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [{ path: '.', error: 'workspace is not a directory' }];
  }

  const out: SessionDebugFileEntry[] = [];
  async function walk(directory: string, rel: string): Promise<void> {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      out.push({ path: rel || '.', error: error instanceof Error ? error.message : String(error) });
      return;
    }

    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const safeRel = childRel.replace(/\\/g, '/');
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        out.push({ path: `${safeRel}/` });
        await walk(fullPath, childRel);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath).catch((error) => error);
        out.push({
          path: safeRel,
          ...(fileStat && !(fileStat instanceof Error) ? { size: fileStat.size } : {}),
          ...(fileStat instanceof Error ? { error: fileStat.message } : {})
        });
      }
    }
  }

  await walk(root, '');
  return out;
}

async function handleAdminRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  auth: AuthRuntime,
  method: string,
  pathname: string,
  chips: ChipRuntime | null,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  dataDir: string,
  ticketStore: TicketStore,
  announcementStore: AnnouncementStore,
  creditLedger?: CreditLedger,
  discoveryTraceStore?: DiscoveryTraceStore,
  modelRouting?: ModelRoutingRuntime
): Promise<void> {
  if (!(await requireUsableAdmin(request, response, auth.jwtService, auth.userStore))) {
    if (persistence && /^\/admin\/sessions\/([^/]+)\/debug$/.test(pathname)) {
      auditAdminDebugRead(persistence, request, 'unknown', {
        outcome: 'error',
        reason: response.statusCode === 401 ? 'unauthorized' : 'forbidden',
        path: pathname
      });
    }
    return;
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_HOST}`);

  if (pathname === '/admin/model-routing') {
    if (!modelRouting) {
      throw new HttpError(500, 'Model routing runtime is not configured');
    }
    if (method === 'GET') {
      sendJson(response, 200, { config: modelRouting.config, catalog: buildModelRoutingCatalog() });
      return;
    }
    if (method === 'PUT') {
      const body = await readJsonObject(request);
      try {
        const config = await saveModelRoutingConfig(body, { configFile: modelRouting.configFile });
        modelRouting.config = config;
        sendJson(response, 200, { config, catalog: buildModelRoutingCatalog() });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid model routing config');
      }
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/admin/announcements' || pathname.startsWith('/admin/announcements/')) {
    await handleAdminAnnouncementRequest(request, response, method, pathname, url, announcementStore);
    return;
  }

  if (method === 'GET' && pathname === '/admin/credits') {
    if (!creditLedger) {
      throw new HttpError(500, 'Credit ledger is not configured');
    }
    const userId = nonEmptyQuery(url.searchParams.get('userId'), 160);
    if (!userId) {
      throw new HttpError(400, 'userId is required');
    }
    const user = await auth.userStore.findById(userId);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    const limit = Math.min(parseOptionalPositiveInt(url.searchParams.get('limit')) ?? 20, 100);
    sendJson(response, 200, {
      userId: user.id,
      username: user.username,
      balanceUnits: await auth.userStore.getCreditBalanceUnits(user.id),
      ledger: await creditLedger.query({ userId: user.id, limit })
    });
    return;
  }

  if (method === 'POST' && pathname === '/admin/credits/adjust') {
    if (!creditLedger) {
      throw new HttpError(500, 'Credit ledger is not configured');
    }
    const body = await readJsonObject(request);
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    if (!userId) {
      throw new HttpError(400, 'userId is required');
    }
    const user = await auth.userStore.findById(userId);
    if (!user) {
      throw new HttpError(404, 'User not found');
    }
    const reason = normalizeAdminCreditsAuditText(body.reason, 160, 'reason is required');
    const note = normalizeAdminCreditsOptionalText(body.note, 500);
    const deltaUnits = body.deltaUnits;
    const balanceUnitsInput = body.balanceUnits;
    const hasDelta = typeof deltaUnits === 'number';
    const hasBalance = typeof balanceUnitsInput === 'number';
    if (!hasDelta && !hasBalance) {
      throw new HttpError(400, 'deltaUnits or balanceUnits is required');
    }
    if (hasDelta && !Number.isInteger(deltaUnits)) {
      throw new HttpError(400, 'deltaUnits must be an integer');
    }
    if (hasBalance && (!Number.isInteger(balanceUnitsInput) || balanceUnitsInput < 0)) {
      throw new HttpError(400, 'balanceUnits must be a non-negative integer');
    }

    const balanceBeforeUnits = await auth.userStore.getCreditBalanceUnits(user.id);
    const balanceAfterUnits = hasBalance ? balanceUnitsInput : balanceBeforeUnits + (deltaUnits as number);
    if (!Number.isInteger(balanceAfterUnits) || balanceAfterUnits < 0) {
      throw new HttpError(400, 'Resulting credit balance must be a non-negative integer');
    }
    const adjustmentDeltaUnits = balanceAfterUnits - balanceBeforeUnits;
    const updated = await auth.userStore.setCreditBalanceUnits(user.id, balanceAfterUnits);
    const ledgerRecord = await creditLedger.append({
      userId: updated.id,
      username: updated.username,
      entry: 'admin',
      units: Math.abs(adjustmentDeltaUnits),
      status: 'free',
      reason,
      balanceBeforeUnits,
      balanceAfterUnits,
      requestId: request.headers['x-request-id'] ? String(request.headers['x-request-id']) : undefined,
      metadata: {
        adjustmentDeltaUnits,
        actorUserId: request.user?.userId,
        actorUsername: request.user?.username,
        actorRole: request.user?.role,
        note
      }
    });
    logAccountAuditEvent(
      persistence,
      logger,
      request,
      'admin_credit_adjust',
      'Admin credit balance adjusted',
      {
        actorUserId: request.user?.userId,
        actorUsername: request.user?.username,
        targetUserId: updated.id,
        targetUsername: updated.username,
        reason,
        note,
        deltaUnits: adjustmentDeltaUnits,
        balanceBeforeUnits,
        balanceAfterUnits
      }
    );
    sendJson(response, 200, {
      userId: updated.id,
      username: updated.username,
      balanceBeforeUnits,
      balanceAfterUnits,
      deltaUnits: adjustmentDeltaUnits,
      reason,
      note,
      ledgerRecord
    });
    return;
  }

  if (method === 'GET' && pathname === '/admin/tickets') {
    sendJson(response, 200, await ticketStore.listTickets(parseTicketListFilters(url, { includeKeyword: true })));
    return;
  }

  const ticketAttachmentDownloadMatch = /^\/admin\/tickets\/([^/]+)\/attachments\/([^/]+)\/download$/.exec(pathname);
  if (ticketAttachmentDownloadMatch && method === 'GET') {
    const download = await resolveTicketAttachmentDownload({
      ticketStore,
      dataDir: persistence?.dataDir ?? path.dirname(ticketStore.ticketsDir),
      ticketNo: decodeURIComponent(ticketAttachmentDownloadMatch[1] ?? ''),
      attachmentId: decodeURIComponent(ticketAttachmentDownloadMatch[2] ?? '')
    });
    response.statusCode = 200;
    response.setHeader('Content-Type', download.contentType);
    const asciiDownloadName = download.downloadName.replace(/[^\x20-\x7E]/g, '_');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiDownloadName}"; filename*=UTF-8''${encodeURIComponent(download.downloadName)}`
    );
    if (download.sizeBytes !== undefined) {
      response.setHeader('Content-Length', String(download.sizeBytes));
    }
    const stream = createReadStream(download.absolutePath);
    stream.on('error', (error) => {
      response.destroy(error);
    });
    stream.pipe(response);
    return;
  }

  const ticketAttachmentPreviewMatch = /^\/admin\/tickets\/([^/]+)\/attachments\/([^/]+)\/preview$/.exec(pathname);
  if (ticketAttachmentPreviewMatch && method === 'GET') {
    const preview = await resolveTicketAttachmentPreview({
      ticketStore,
      dataDir: persistence?.dataDir ?? path.dirname(ticketStore.ticketsDir),
      ticketNo: decodeURIComponent(ticketAttachmentPreviewMatch[1] ?? ''),
      attachmentId: decodeURIComponent(ticketAttachmentPreviewMatch[2] ?? '')
    });
    sendJson(response, 200, preview);
    return;
  }

  const accountApplicationApproveMatch = /^\/admin\/tickets\/([^/]+)\/account-application\/approve$/.exec(pathname);
  if (accountApplicationApproveMatch && method === 'POST') {
    const ticketNo = decodeURIComponent(accountApplicationApproveMatch[1] ?? '');
    const ticket = await ticketStore.getTicket(ticketNo);
    const application = getApprovableAccountApplication(ticket);
    const existing = await auth.userStore.findByUsername(application.application.username);
    if (existing) {
      throw new HttpError(409, 'User already exists');
    }

    let user: User;
    try {
      user = await auth.userStore.createUserWithPasswordHash(
        application.application.username,
        application.credentialDraft.passwordHash,
        'customer',
        {
          status: 'active',
          profile: {
            company: application.application.company,
            email: application.application.contact,
            note: application.application.reason
          }
        }
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'User already exists') {
        throw new HttpError(409, 'User already exists');
      }
      throw error;
    }

    let updated;
    try {
      updated = await ticketStore.approveAccountApplicationTicket(
        ticket.ticketNo,
        {
          userId: user.id,
          username: user.username,
          result: 'Account application approved'
        },
        request.user
      );
    } catch (error) {
      await auth.userStore.updateUser(user.id, { status: 'disabled' }).catch(() => undefined);
      throw error;
    }
    sendJson(response, 200, {
      ticket: toAdminTicketDto(updated),
      user: auth.userStore.toPublicUser(user)
    });
    return;
  }

  const datasheetReviewMatch = /^\/admin\/tickets\/([^/]+)\/datasheet-review$/.exec(pathname);
  if (datasheetReviewMatch && method === 'PUT') {
    const ticketNo = decodeURIComponent(datasheetReviewMatch[1] ?? '');
    const body = await readJsonObject(request);
    const patch = buildDatasheetAdminReviewPatch(body, chips, resources);
    sendJson(response, 200, {
      ticket: toAdminTicketDto(await ticketStore.updateDatasheetReview(ticketNo, patch, request.user))
    });
    return;
  }

  const ticketMessageMatch = /^\/admin\/tickets\/([^/]+)\/messages$/.exec(pathname);
  if (ticketMessageMatch && method === 'POST') {
    const ticketNo = decodeURIComponent(ticketMessageMatch[1] ?? '');
    const body = await readJsonObject(request);
    const text = typeof body.text === 'string' ? body.text : '';
    // 默认 audience='user'（admin 回复对用户可见）；admin 也可发 internal 内部备注。
    const audience = body.audience === 'internal' ? 'internal' : 'user';
    sendJson(response, 200, {
      ticket: toAdminTicketDto(
        await ticketStore.addTicketMessage(
          ticketNo,
          {
            text,
            authorRole: request.user?.role ?? 'admin',
            authorLabel: request.user?.username,
            audience
          },
          request.user
        )
      )
    });
    return;
  }

  const ticketMatch = /^\/admin\/tickets\/([^/]+)$/.exec(pathname);
  if (ticketMatch && method === 'GET') {
    sendJson(response, 200, { ticket: toAdminTicketDto(await ticketStore.getTicket(decodeURIComponent(ticketMatch[1] ?? ''))) });
    return;
  }

  if (ticketMatch && method === 'PATCH') {
    const body = await readJsonObject(request);
    const patch: TicketAdminUpdate = {};
    if (typeof body.status === 'string') {
      patch.status = body.status as TicketAdminUpdate['status'];
    }
    if (typeof body.publicNote === 'string') {
      patch.publicNote = body.publicNote;
    }
    if (typeof body.internalNote === 'string') {
      patch.internalNote = body.internalNote;
    }
    if (typeof body.result === 'string') {
      patch.result = body.result;
    }
    if (typeof body.needsMoreInfo === 'boolean') {
      patch.needsMoreInfo = body.needsMoreInfo;
    }
    sendJson(response, 200, {
      ticket: toAdminTicketDto(await ticketStore.updateTicket(decodeURIComponent(ticketMatch[1] ?? ''), patch, request.user))
    });
    return;
  }

  if (persistence && method === 'GET' && pathname === '/admin/sessions/history') {
    sendJsonNoStore(response, 200, await listAdminSessions(persistence.sessionStore, parseSessionHistoryQuery(url)));
    return;
  }

  const adminHistoryMatch = /^\/admin\/sessions\/([^/]+)\/history$/.exec(pathname);
  if (persistence && method === 'GET' && adminHistoryMatch) {
    const sessionId = decodeURIComponent(adminHistoryMatch[1] ?? '');
    let detail: Awaited<ReturnType<typeof readAdminSessionDetail>>;
    try {
      detail = await readAdminSessionDetail(persistence.sessionStore, sessionId, {
        ...parsePagination(url),
        includeOutputTail: parseOptionalPositiveInt(url.searchParams.get('outputTail'))
      });
    } catch (error) {
      if (isMissingSessionError(error)) {
        sendJsonNoStore(response, 404, { error: 'Session not found' });
        return;
      }
      throw error;
    }
    persistence.auditLogger.log(LOG_EVENTS.adminCrossUserRead, 'Admin read session history detail', {
      sessionId,
      userId: request.user?.userId,
      metadata: {
        adminUserId: request.user?.userId,
        targetSessionId: sessionId,
        targetUserId: detail.meta.userId,
        path: pathname,
        includeOutputTail: url.searchParams.has('outputTail')
      }
    });
    sendJsonNoStore(response, 200, detail);
    return;
  }

  if (persistence && method === 'GET' && pathname === '/admin/questions') {
    const query = parseQuestionQuery(url);
    const result = await queryAdminQuestions(persistence.questionLedger, query);
    persistence.auditLogger.log(LOG_EVENTS.adminQuestionLedgerRead, 'Admin queried question ledger', {
      userId: request.user?.userId,
      metadata: {
        adminUserId: request.user?.userId,
        path: pathname,
        query
      }
    });
    sendJsonNoStore(response, 200, result);
    return;
  }

  if (persistence && method === 'GET' && pathname === '/admin/observability') {
    const range = resolveObservabilityRange(url.searchParams.get('range'));
    if (!range.ok) {
      sendJsonNoStore(response, 400, { error: 'Invalid observability range' });
      return;
    }
    const credits = creditLedger ? await creditLedger.queryAll({ from: range.window.from, to: range.window.to }) : [];
    sendJsonNoStore(response, 200, await buildObservabilityMetrics({
      sessionStore: persistence.sessionStore,
      creditRecords: credits,
      window: range.window
    }));
    return;
  }

  // GET /admin/discovery-traces — spec §6.9 Discovery Trace 只读视图
  if (method === 'GET' && pathname === '/admin/discovery-traces') {
    const limit = parseOptionalPositiveInt(url.searchParams.get('limit'));
    const sessionId = url.searchParams.get('sessionId') ?? undefined;
    const traces = discoveryTraceStore
      ? await discoveryTraceStore.list({ limit, sessionId })
      : [];
    sendJsonNoStore(response, 200, {
      traces: await enrichDiscoveryTraces(traces, persistence, discoveryTraceStore),
      systemInfo: await buildDiscoveryTraceSystemInfo({
        auth,
        chips,
        prompts,
        resources,
        persistence,
        dataDir: persistence?.dataDir ?? dataDir
      })
    });
    return;
  }

  const debugMatch = /^\/admin\/sessions\/([^/]+)\/debug$/.exec(pathname);
  if (persistence && method === 'GET' && debugMatch) {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.setHeader('Pragma', 'no-cache');
    let sessionId: string;
    try {
      sessionId = assertSafeSessionId(decodeURIComponent(debugMatch[1] ?? ''));
    } catch {
      auditAdminDebugRead(persistence, request, 'unknown', { outcome: 'not_found', reason: 'invalid_session_id', path: pathname });
      sendJson(response, 404, { error: 'Session debug bundle not found' });
      return;
    }
    const meta = await persistence.sessionStore.readSessionMeta(sessionId);
    if (!meta) {
      auditAdminDebugRead(persistence, request, sessionId, { outcome: 'not_found', reason: 'missing_session', path: pathname });
      sendJson(response, 404, { error: 'Session debug bundle not found' });
      return;
    }
    let bundle;
    try {
      bundle = await persistence.sessionDebugBundles.get(sessionId);
    } catch (error) {
      auditAdminDebugRead(persistence, request, sessionId, {
        outcome: 'error',
        reason: 'invalid_debug_bundle',
        path: pathname,
        targetUserId: meta.userId,
        error: redactDebugText(error instanceof Error ? error.message : String(error)).text
      });
      sendJson(response, 422, { error: 'Session debug bundle is unreadable' });
      return;
    }
    if (!bundle) {
      auditAdminDebugRead(persistence, request, sessionId, {
        outcome: 'not_found',
        reason: 'missing_debug_bundle',
        path: pathname,
        targetUserId: meta.userId
      });
      sendJson(response, 404, { error: 'Session debug bundle not found' });
      return;
    }
    auditAdminDebugRead(persistence, request, sessionId, {
      outcome: 'ok',
      path: pathname,
      targetUserId: meta.userId
    });
    sendJson(response, 200, bundle);
    return;
  }

  const analysisMatch = /^\/admin\/sessions\/([^/]+)\/analysis$/.exec(pathname);
  if (persistence && method === 'GET' && analysisMatch) {
    const sessionId = decodeURIComponent(analysisMatch[1] ?? '');
    let result: Awaited<ReturnType<typeof readSessionAnalysisPackage>>;
    try {
      result = await readSessionAnalysisPackage(persistence.sessionStore, persistence.questionLedger, sessionId, {
        ...parsePagination(url),
        includeOutputTail: parseOptionalPositiveInt(url.searchParams.get('outputTail'))
      });
    } catch (error) {
      if (isMissingSessionError(error)) {
        sendJsonNoStore(response, 404, { error: 'Session not found' });
        return;
      }
      throw error;
    }
    persistence.auditLogger.log(LOG_EVENTS.adminAnalysisRead, 'Admin read session analysis package', {
      sessionId,
      userId: request.user?.userId,
      metadata: {
        adminUserId: request.user?.userId,
        targetSessionId: sessionId,
        targetUserId: result.meta.userId,
        path: pathname,
        includeOutputTail: url.searchParams.has('outputTail')
      }
    });
    sendJsonNoStore(response, 200, result);
    return;
  }

  // B7 资源治理：documents + scope presets 的 admin CRUD。
  // 写操作始终更新内存 catalog；若配置了 configFile，则额外经 writeJsonAtomic 落盘。
  // 整段位于 handleAdminRequest 内，已由 requireUsableAdmin 守卫，故均为 admin-only。
  if (pathname === '/admin/resources' || pathname.startsWith('/admin/resources/')) {
    await handleAdminResourceRequest(request, response, method, pathname, resources);
    return;
  }

  if (method === 'GET' && pathname === '/admin/chips' && chips) {
    response.setHeader('ETag', currentChipCatalogEtag(chips));
    sendJson(response, 200, await toAdminChipCatalogWithWorkspaceStatus(chips.catalog));
    return;
  }

  if (method === 'PUT' && pathname === '/admin/chips' && chips) {
    if (!chips.configFile) {
      throw new HttpError(400, 'Chip config file is not available for saving');
    }
    // 并发守卫：若客户端带了 If-Match，必须与当前已保存目录的 ETag 一致，否则 409（目录已被改写）。
    // 不带 If-Match 的旧调用方仍放行（向后兼容），守卫只在 admin UI 显式带头时生效。
    const ifMatch = request.headers['if-match'];
    if (typeof ifMatch === 'string' && ifMatch.trim() !== '') {
      if (ifMatch.trim() !== currentChipCatalogEtag(chips)) {
        throw new HttpError(409, 'Chip catalog has changed since it was loaded. Reload and reapply your edits.');
      }
    }
    const rawBody = await readJsonObject(request);
    const deletedIds = parseDeletedChipIds(rawBody.deletedIds);
    const parsedCatalog = parseAdminChipCatalog(rawBody);
    // 既有 chip 不得改名（改名会让已保存的 user.resourceGrants.chipIds 历史引用失效）。
    // 按位置比对当前已加载目录：某位置上既有 chip 的 id 变了且旧 id 不再出现在新目录任何位置 → 改名 → 409。
    const renamed = detectRenamedChipIds(chips.catalog.chips, parsedCatalog.chips);
    if (renamed.length > 0) {
      throw new HttpError(
        409,
        `Renaming an existing chip id is not allowed: ${renamed
          .map((entry) => `${entry.from} -> ${entry.to}`)
          .join(', ')}. Delete the chip and create a new one instead.`
      );
    }
    const catalog = await normalizeAdminChipCatalogForSave(parsedCatalog);
    try {
      await writeJsonAtomic(chips.configFile, catalog);
    } catch (error) {
      throw new HttpError(500, chipCatalogSaveErrorMessage(chips.configFile, error));
    }
    const accessCleanup = await summarizeDeletedChipGrants(deletedIds, auth, resources);
    // V13：区分「纯元数据编辑」与「结构性变更」。结构性变更（新增/删除 chip、或既有 chip 的
    // workspaceDir/knowledgeBaseRoot 变化——物理工作区改动，热替换有风险）仍走重启闸，仅写盘、
    // 不热替换内存 catalog；纯元数据编辑（brand/productLines/applicationTags/documentIds/summary 等）
    // 立即热更新 chips.catalog（镜像 POST /admin/chips/ingest 的做法），使 /chips、scope、授权、
    // 新会话即时生效，无需重启。
    const isStructuralChange = isStructuralChipCatalogChange(toAdminChipCatalog(chips.catalog), catalog);
    if (!isStructuralChange) {
      chips.catalog = catalog;
    }
    // 刷新并发守卫标记为新落库内容的 ETag，并随响应回传，供前端更新本地 If-Match 基线。
    const nextEtag = computeChipCatalogEtag(catalog);
    chips.catalogEtag = nextEtag;
    response.setHeader('ETag', nextEtag);
    sendJson(response, 200, {
      knowledgeBaseRoot: catalog.knowledgeBaseRoot,
      chips: catalog.chips,
      restartRequired: isStructuralChange,
      message: isStructuralChange
        ? 'Chip catalog saved. Restart the service for changes to affect new sessions.'
        : 'Chip catalog saved and applied immediately.',
      accessCleanup
    });
    return;
  }

  // B11 Task 2.6 数据孵化入库：把已抽取的 datasheet 草稿（summary/applicationTags/brand/productLines）
  // 一键并入芯片目录，复用既有的 normalize + writeJsonAtomic 写回路径与并发/改名规则。
  // 新 chipId 视为插入（需带 label + 已存在的 workspaceDir）；既有 chipId 仅合并草稿提供的元数据字段，
  // 不动其它字段、不动其它芯片。写盘成功后刷新内存目录与 ETag，使后续 GET /admin/chips 即时可见。
  if (method === 'POST' && pathname === '/admin/chips/ingest' && chips) {
    if (!chips.configFile) {
      throw new HttpError(400, 'Chip config file is not available for saving');
    }
    const draft = parseChipIngestDraft(await readJsonObject(request));
    // 在「已绝对化」的目录上合并，使既有 chip 的相对 workspaceDir（按 knowledgeBaseRoot 解析）
    // 与 normalizeAdminChipCatalogForSave 的绝对路径要求一致，沿用 GET→PUT 往返的同一规范化。
    const merged = mergeChipDraftIntoCatalog(toAdminChipCatalog(chips.catalog), draft);
    const catalog = await normalizeAdminChipCatalogForSave(merged);
    try {
      await writeJsonAtomic(chips.configFile, catalog);
    } catch (error) {
      throw new HttpError(500, chipCatalogSaveErrorMessage(chips.configFile, error));
    }
    // 入库刷新内存目录（不同于 PUT 的 restart-gated 行为）：让 admin 立即看到入库结果，
    // 不必重启服务，落地「LLM 抽取 → 人审 → 写库」最后一跳搬进 admin 的设计意图。
    chips.catalog = catalog;
    const nextEtag = computeChipCatalogEtag(catalog);
    chips.catalogEtag = nextEtag;
    response.setHeader('ETag', nextEtag);
    const ingested = catalog.chips.find((chip) => chip.id === draft.chipId);
    sendJson(response, 200, {
      chip: ingested,
      knowledgeBaseRoot: catalog.knowledgeBaseRoot,
      chips: catalog.chips,
      message: 'Datasheet metadata ingested into the chip catalog.'
    });
    return;
  }

  if ((method === 'GET' || method === 'PUT') && pathname === '/admin/chip-access') {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  // Prompt file management APIs
  const promptsDir = path.resolve(process.cwd(), 'prompts');
  const promptHistory = new PromptGovernanceStore({ dataDir });

  if (method === 'GET' && pathname === '/admin/prompts') {
    const files = await listPromptFiles(promptsDir, chips?.catalog);
    sendJson(response, 200, { files });
    return;
  }

  const promptHistoryMatch = /^\/admin\/prompts\/(.+)\/history$/.exec(pathname);
  if (promptHistoryMatch && method === 'GET') {
    const filePath = decodeURIComponent(promptHistoryMatch[1] ?? '');
    if (!filePath || filePath.includes('..')) {
      sendJson(response, 400, { error: 'Invalid file path' });
      return;
    }
    validatePromptPath(promptsDir, filePath);
    const entries = await promptHistory.list(filePath);
    sendJson(response, 200, { entries });
    return;
  }

  const promptRollbackMatch = /^\/admin\/prompts\/(.+)\/rollback$/.exec(pathname);
  if (promptRollbackMatch && method === 'POST') {
    const filePath = decodeURIComponent(promptRollbackMatch[1] ?? '');
    if (!filePath || filePath.includes('..')) {
      sendJson(response, 400, { error: 'Invalid file path' });
      return;
    }
    const validated = validatePromptPath(promptsDir, filePath);
    const previous = await promptHistory.latest(filePath);
    if (!previous) {
      sendJson(response, 409, { error: 'No prompt history available' });
      return;
    }
    let currentContent = '';
    try {
      currentContent = await readFile(validated, 'utf-8');
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }
    await promptHistory.append(filePath, currentContent, promptHistoryActor(request));
    await writePromptFileAtomic(validated, previous.content);
    sendJson(response, 200, { rolledBack: true, content: previous.content, restoredHash: previous.hash });
    return;
  }

  if (pathname.startsWith('/admin/prompts/') && (method === 'GET' || method === 'PUT')) {
    const filePath = decodeURIComponent(pathname.slice('/admin/prompts/'.length));
    if (!filePath || filePath.includes('..')) {
      sendJson(response, 400, { error: 'Invalid file path' });
      return;
    }

    const validated = validatePromptPath(promptsDir, filePath);

    if (method === 'GET') {
      let content: string;
      try {
        content = await readFile(validated, 'utf-8');
      } catch (error) {
        if (isMissingFileError(error) && isKnownChipPromptPath(chips?.catalog, filePath)) {
          content = defaultChipPromptContent(filePath);
          sendJson(response, 200, { content, missing: true });
          return;
        }
        if (isMissingFileError(error)) {
          sendJson(response, 404, { error: 'Prompt file not found' });
          return;
        }
        throw error;
      }
      sendJson(response, 200, { content });
      return;
    }

    if (method === 'PUT') {
      const body = await readJsonObject(request);
      const content = body.content;
      if (typeof content !== 'string') {
        sendJson(response, 400, { error: 'Content must be a string' });
        return;
      }
      try {
        const previousContent = await readFile(validated, 'utf-8');
        await promptHistory.append(filePath, previousContent, promptHistoryActor(request));
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
      }
      await writePromptFileAtomic(validated, content);
      sendJson(response, 200, { saved: true });
      return;
    }
  }

  // Check reload before matchRolesRoute since /admin/roles/reload would match as a role
  if (pathname === '/admin/roles/reload' && method === 'POST') {
    await auth.routes.roles.reload();
    await refreshPromptRoleConfig(prompts);
    sendJson(response, 200, { reloaded: true });
    return;
  }

  const rolesRoute = auth.routes.matchRolesRoute(pathname);
  if (rolesRoute) {
    if (rolesRoute.kind === 'roles' && method === 'GET') {
      sendJson(response, 200, await auth.routes.roles.list());
      return;
    }
    if (rolesRoute.kind === 'roles' && method === 'POST') {
      const body = await readJsonObject(request);
      validateRoleAccessChipIds(body, chips);
      const payload = await auth.routes.roles.create(body);
      await refreshPromptRoleConfig(prompts);
      sendJson(response, 201, payload);
      return;
    }
    if (rolesRoute.kind === 'role' && method === 'GET') {
      sendJson(response, 200, await auth.routes.roles.get(rolesRoute.name));
      return;
    }
    if (rolesRoute.kind === 'role' && method === 'PUT') {
      const body = await readJsonObject(request);
      validateRoleAccessChipIds(body, chips);
      const payload = await auth.routes.roles.update(rolesRoute.name, body);
      await refreshPromptRoleConfig(prompts);
      sendJson(response, 200, payload);
      return;
    }
    if (rolesRoute.kind === 'role' && method === 'DELETE') {
      await auth.routes.roles.delete(rolesRoute.name);
      await refreshPromptRoleConfig(prompts);
      response.statusCode = 204;
      response.end();
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  // User role update: PUT /admin/users/:userId/role
  if (method === 'PUT' && pathname.match(/^\/admin\/users\/[^/]+\/role$/)) {
    const match = /^\/admin\/users\/([^/]+)\/role$/.exec(pathname);
    if (match) {
      const userId = decodeURIComponent(match[1]);
      sendJson(response, 200, await auth.routes.updateUserRole(userId, await readJsonObject(request)));
      return;
    }
  }

  const effectiveAuthorizationMatch = /^\/admin\/users\/([^/]+)\/effective-authorization$/.exec(pathname);
  if (effectiveAuthorizationMatch && method === 'GET') {
    sendJson(
      response,
      200,
      await buildAdminEffectiveAuthorizationResponse(auth, chips, decodeURIComponent(effectiveAuthorizationMatch[1] ?? ''))
    );
    return;
  }

  const route = auth.routes.matchAdminRoute(pathname);
  if (!route) {
    sendJson(response, 404, { error: 'Not found' });
    return;
  }

  if (route.kind === 'users' && method === 'GET') {
    sendJson(response, 200, await auth.routes.listUsers());
    return;
  }

  if (route.kind === 'users' && method === 'POST') {
    sendJson(response, 201, await auth.routes.createUser(await readJsonObject(request)));
    return;
  }

  if (route.kind === 'user' && method === 'GET') {
    sendJson(response, 200, await auth.routes.getUser(route.userId));
    return;
  }

  if (route.kind === 'user' && method === 'PUT') {
    const body = await readJsonObject(request);
    const previous = await auth.userStore.findById(route.userId);
    const payload = await auth.routes.updateUser(route.userId, body);
    if (isRecord(body) && body.selfService !== undefined) {
      logAdminSelfServicePolicyUpdate(persistence, logger, request, previous, payload.user.selfService);
    }
    if (isRecord(body)) {
      const changedCategories = getAdminAuthorizationChangedCategories(body);
      if (changedCategories.length > 0) {
        logAdminAuthorizationPolicyUpdate(persistence, logger, request, previous, payload.user, changedCategories);
      }
    }
    sendJson(response, 200, payload);
    return;
  }

  if (route.kind === 'user' && method === 'DELETE') {
    await auth.routes.deleteUser(route.userId);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (route.kind === 'userPassword' && method === 'PUT') {
    sendJson(response, 200, await auth.routes.updateUserPassword(route.userId, await readJsonObject(request)));
    return;
  }

  if (route.kind === 'userKeys' && method === 'POST') {
    sendJson(response, 201, await auth.routes.addMcpKey(route.userId, await readJsonObject(request)));
    return;
  }

  if (route.kind === 'userKey' && method === 'DELETE') {
    await auth.routes.removeMcpKey(route.userId, route.keyId);
    response.statusCode = 204;
    response.end();
    return;
  }

  if (route.kind === 'userKey' && method === 'PUT') {
    const body = await readJsonObject(request);
    const payload = await auth.routes.updateMcpKey(route.userId, route.keyId, body);
    if (isRecord(body)) {
      const changedCategories = getAdminAuthorizationChangedCategories(body);
      if (changedCategories.length > 0) {
        logAdminKeyAuthorizationPolicyUpdate(persistence, logger, request, route.userId, payload.key, changedCategories);
      }
    }
    sendJson(response, 200, payload);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

/**
 * B7 资源治理 admin CRUD（documents + scope presets）。
 *
 * 路由：
 *  - GET    /admin/resources                              概览（documents + scope presets + counts）
 *  - GET    /admin/resources/documents[?status=&visibility=]   列表（可按状态/可见性过滤）
 *  - POST   /admin/resources/documents                    新建 document
 *  - PUT    /admin/resources/documents/:documentId        更新（status 流转到 approved/rejected 时盖审批人/时间）
 *  - DELETE /admin/resources/documents/:documentId[?force=true]   删除（被 preset 引用且未带 force 时返回 409 + 引用的 preset id 并阻断；带 force 时删除并同一次写入剥离所有引用预设里的孤儿 documentId）
 *  - GET/POST/PUT/DELETE /admin/resources/scope-presets[/:id]   scope preset CRUD
 *  - POST   /admin/resources/scope-presets/:id/validate   返回孤儿 documentIds/chipIds
 *
 * 写操作始终更新内存 catalog；configFile 存在时额外原子落盘。configFile 缺省（内存模式）不报错。
 */
async function handleAdminResourceRequest(
  request: AuthenticatedRequest,
  response: ServerResponse,
  method: string,
  pathname: string,
  resources: ResourceRuntime | null
): Promise<void> {
  if (!resources) {
    throw new HttpError(500, 'Resource catalog is not configured');
  }
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? DEFAULT_HOST}`);

  // GET /admin/resources — overview with counts.
  if (method === 'GET' && pathname === '/admin/resources') {
    sendJson(response, 200, {
      documents: resources.catalog.documents,
      scopePresets: resources.catalog.scopePresets,
      counts: {
        documents: resources.catalog.documents.length,
        scopePresets: resources.catalog.scopePresets.length
      }
    });
    return;
  }

  // -------- Documents --------
  if (pathname === '/admin/resources/documents') {
    if (method === 'GET') {
      const statusFilter = nonEmptyQuery(url.searchParams.get('status'), 40);
      const visibilityFilter = nonEmptyQuery(url.searchParams.get('visibility'), 40);
      const documents = resources.catalog.documents.filter(
        (document) =>
          (!statusFilter || document.status === statusFilter) &&
          (!visibilityFilter || document.visibility === visibilityFilter)
      );
      sendJson(response, 200, { documents });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonObject(request);
      let document: DocumentVisibilityContract;
      try {
        document = normalizeDocumentVisibilityContract(body);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid document');
      }
      if (findDocumentContract(resources.catalog, document.documentId)) {
        throw new HttpError(409, `Document ${document.documentId} already exists`);
      }
      const nextCatalog: ResourceVisibilityCatalog = {
        documents: [...resources.catalog.documents, document],
        scopePresets: resources.catalog.scopePresets
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 201, { document });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const documentIdMatch = /^\/admin\/resources\/documents\/([^/]+)$/.exec(pathname);
  if (documentIdMatch) {
    const documentId = decodeURIComponent(documentIdMatch[1] ?? '');
    const existing = findDocumentContract(resources.catalog, documentId);
    if (!existing) {
      throw new HttpError(404, 'Document not found');
    }
    if (method === 'PUT') {
      const body = await readJsonObject(request);
      let updated: DocumentVisibilityContract;
      try {
        // Merge onto the existing contract so partial updates keep untouched fields.
        updated = normalizeDocumentVisibilityContract({
          ...serializeResourceVisibilityCatalog({ documents: [existing], scopePresets: [] }).documents[0],
          ...body,
          documentId
        });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid document');
      }
      stampReviewAudit(existing.status, updated, request);
      const nextCatalog: ResourceVisibilityCatalog = {
        documents: resources.catalog.documents.map((document) =>
          document.documentId === documentId ? updated : document
        ),
        scopePresets: resources.catalog.scopePresets
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 200, { document: updated });
      return;
    }
    if (method === 'DELETE') {
      const referencingScopePresetIds = resources.catalog.scopePresets
        .filter((preset) => preset.documentIds.includes(documentId))
        .map((preset) => preset.scopePresetId);
      const forceQuery = nonEmptyQuery(url.searchParams.get('force'), 10);
      const forceBody = await readJsonObject(request).catch(() => ({}) as Record<string, unknown>);
      const force = forceQuery === 'true' || forceBody.force === true;

      if (referencingScopePresetIds.length > 0 && !force) {
        throw new HttpError(
          409,
          `Document ${documentId} is still referenced by ${referencingScopePresetIds.length} scope preset(s).`,
          'DOCUMENT_REFERENCED',
          { referencingScopePresetIds }
        );
      }

      const nextCatalog: ResourceVisibilityCatalog = {
        documents: resources.catalog.documents.filter((document) => document.documentId !== documentId),
        scopePresets:
          referencingScopePresetIds.length > 0
            ? resources.catalog.scopePresets.map((preset) =>
                referencingScopePresetIds.includes(preset.scopePresetId)
                  ? { ...preset, documentIds: preset.documentIds.filter((id) => id !== documentId) }
                  : preset
              )
            : resources.catalog.scopePresets
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 200, {
        deleted: true,
        referencingScopePresetIds
      });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  // -------- Scope presets --------
  if (pathname === '/admin/resources/scope-presets') {
    if (method === 'GET') {
      const statusFilter = nonEmptyQuery(url.searchParams.get('status'), 40);
      const visibilityFilter = nonEmptyQuery(url.searchParams.get('visibility'), 40);
      const scopePresets = resources.catalog.scopePresets.filter(
        (preset) =>
          (!statusFilter || preset.status === statusFilter) &&
          (!visibilityFilter || preset.visibility === visibilityFilter)
      );
      sendJson(response, 200, { scopePresets });
      return;
    }
    if (method === 'POST') {
      const body = await readJsonObject(request);
      let preset: ScopePresetContract;
      try {
        preset = normalizeScopePresetContract(body);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid scope preset');
      }
      if (findScopePresetContract(resources.catalog, preset.scopePresetId)) {
        throw new HttpError(409, `Scope preset ${preset.scopePresetId} already exists`);
      }
      const nextCatalog: ResourceVisibilityCatalog = {
        documents: resources.catalog.documents,
        scopePresets: [...resources.catalog.scopePresets, preset]
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 201, { scopePreset: preset });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  const scopeValidateMatch = /^\/admin\/resources\/scope-presets\/([^/]+)\/validate$/.exec(pathname);
  if (scopeValidateMatch && method === 'POST') {
    const scopePresetId = decodeURIComponent(scopeValidateMatch[1] ?? '');
    const preset = findScopePresetContract(resources.catalog, scopePresetId);
    if (!preset) {
      throw new HttpError(404, 'Scope preset not found');
    }
    sendJson(response, 200, validatePresetReferences(preset, resources.catalog));
    return;
  }

  const scopeIdMatch = /^\/admin\/resources\/scope-presets\/([^/]+)$/.exec(pathname);
  if (scopeIdMatch) {
    const scopePresetId = decodeURIComponent(scopeIdMatch[1] ?? '');
    const existing = findScopePresetContract(resources.catalog, scopePresetId);
    if (!existing) {
      throw new HttpError(404, 'Scope preset not found');
    }
    if (method === 'PUT') {
      const body = await readJsonObject(request);
      let updated: ScopePresetContract;
      try {
        updated = normalizeScopePresetContract({
          ...serializeResourceVisibilityCatalog({ documents: [], scopePresets: [existing] }).scopePresets[0],
          ...body,
          scopePresetId
        });
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid scope preset');
      }
      stampReviewAudit(existing.status, updated, request);
      const nextCatalog: ResourceVisibilityCatalog = {
        documents: resources.catalog.documents,
        scopePresets: resources.catalog.scopePresets.map((preset) =>
          preset.scopePresetId === scopePresetId ? updated : preset
        )
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 200, { scopePreset: updated });
      return;
    }
    if (method === 'DELETE') {
      const nextCatalog: ResourceVisibilityCatalog = {
        documents: resources.catalog.documents,
        scopePresets: resources.catalog.scopePresets.filter((preset) => preset.scopePresetId !== scopePresetId)
      };
      await persistResourceCatalog(resources, nextCatalog);
      sendJson(response, 200, { deleted: true });
      return;
    }
    sendJson(response, 405, { error: 'Method not allowed' });
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

/**
 * 状态流转到 approved/rejected 时盖审批人/时间。仅当本次 PUT 把状态从非该值改成 approved/rejected
 * 才覆盖（避免重复 PUT 反复刷新时间）。审批人取自当前 admin 请求身份。
 */
function stampReviewAudit(
  previousStatus: ResourceReviewStatus,
  next: { status: ResourceReviewStatus; approvedBy?: string; approvedAt?: string },
  request: AuthenticatedRequest
): void {
  const becameDecided =
    (next.status === 'approved' || next.status === 'rejected') && previousStatus !== next.status;
  if (!becameDecided) {
    return;
  }
  const actor = request.user?.username || request.user?.userId;
  if (actor) {
    next.approvedBy = actor;
  }
  next.approvedAt = new Date().toISOString();
}

/**
 * 更新内存 catalog，并在配置了 configFile 时原子落盘。内存模式（无 configFile）不落盘、不报错。
 */
async function persistResourceCatalog(
  resources: ResourceRuntime,
  nextCatalog: ResourceVisibilityCatalog
): Promise<void> {
  // 复用 normalize* 保证写入形状一致（parse 已在 normalize* 内完成；此处再过一遍 serialize→parse 的等价规范化）。
  const normalized = parseResourceVisibilityCatalog(serializeResourceVisibilityCatalog(nextCatalog));
  // V4：先落盘、盘写成功后再更新内存，避免写盘失败时内存已被污染（运行时授权/解析用新目录、磁盘仍是旧文件、重启后又回退，三方不一致）。
  if (resources.configFile) {
    try {
      await writeResourceVisibilityCatalogToFile(resources.configFile, normalized);
    } catch (error) {
      throw new HttpError(500, `Failed to persist resource catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  resources.catalog = normalized;
}

function safeOff(manager: object, event: string, handler: (...args: never[]) => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (manager as any).off === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).off(event, handler);
  }
}

function handleSseStream(
  request: AuthenticatedRequest,
  response: ServerResponse,
  manager: SessionManager,
  conversationHistory: ConversationHistory,
  sessionId: string,
  snapshot: ReturnType<SessionActions['agent_log']> extends Promise<infer T> ? T : never,
  persistedMessages: ConversationMessage[],
  // P2-1 (multi-agent audit) hardening: re-check authorization on every SSE event
  // so that revoking a chip grant / disabling a user mid-session closes the stream.
  // Auth revocation removes the session from the manager registry, but revocation
  // of a grant (chip / scopePreset) does NOT remove the session — without this
  // check the SSE would keep streaming output for a session whose grants have
  // since been revoked. Returns true if still authorized; false if stream must end.
  assertStillAuthorized?: () => Promise<boolean>
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const initialLog = manager.log(sessionId);
  const liveMessages = buildConversationMessages(
    manager,
    conversationHistory,
    sessionId,
    initialLog
  );
  writeSse(response, 'snapshot', {
    ...snapshot,
    messages: mergeConversationMessages(persistedMessages, liveMessages),
    assistantResult: snapshot.result,
    rawOutputExposed: false
  });

  let lastResultTurnCount = -1;
  // F2: closed-flag so that a `checkAuthorization` callback resolving after
  // closeStream() has already ended the response is dropped on the floor
  // instead of triggering a write-after-end on `response`.
  let closed = false;

  const closeStream = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    safeOff(manager, 'output', outputHandler);
    safeOff(manager, 'state', stateHandler);
    safeOff(manager, 'exit', exitHandler);
    response.end();
  };

  // B1/P2-1: re-check session alive + authorization on every event. The keepalive
  // also performs the authorization check so that revocations that occur during
  // a quiet period (no manager events for the session) are still detected within
  // ~30s.
  const checkSessionAlive = (): boolean => {
    if (closed) return false;
    if (typeof manager.getSession === 'function' && !manager.getSession(sessionId)) {
      closeStream();
      return false;
    }
    return true;
  };

  const checkAuthorization = async (): Promise<boolean> => {
    if (!assertStillAuthorized) {
      return true;
    }
    try {
      return await assertStillAuthorized();
    } catch {
      // Treat any throw as revocation to fail closed.
      return false;
    }
  };

  const outputHandler = (eventSessionId: string, data: string) => {
    if (eventSessionId === sessionId) {
      if (!checkSessionAlive()) return;
      void checkAuthorization().then((ok) => {
        if (closed || !ok) {
          closeStream();
          return;
        }
        writeSse(response, 'output', { sessionId, hasOutput: data.length > 0, rawOutputExposed: false });
      });
    }
  };
  const stateHandler = (eventSessionId: string, state: AdapterState) => {
    if (eventSessionId === sessionId) {
      if (!checkSessionAlive()) return;
      void checkAuthorization().then((ok) => {
        if (closed || !ok) {
          closeStream();
          return;
        }
        if (state.turnState === 'idle' && typeof state.turnCount === 'number' && state.turnCount !== lastResultTurnCount) {
          const log = manager.log(sessionId);
          const result = normalizeLatestAssistantOutput(manager, conversationHistory, sessionId, log, {
            allowAssistantFallback: true
          });
          if (result.text) {
            lastResultTurnCount = state.turnCount;
            writeSse(response, 'result', {
              sessionId,
              data: result.text,
              assistantResult: result.text,
              outputMeta: result.metadata,
              rawOutputExposed: false
            });
          }
        }
        // Deliver the final answer before advertising idle. The browser may
        // close an idle stream after refreshing persisted history, while that
        // persistence intentionally trails the in-memory result.
        writeSse(response, 'state', { sessionId, state });
      });
    }
  };
  // F1: exitHandler now also re-checks authorization before flushing the final
  // result / exit frames. Without this, a grant revocation that coincides with
  // the agent's exit would leak the final assistant text to a user whose
  // grants have been revoked.
  const exitHandler = (eventSessionId: string, code: number, signal: string) => {
    if (eventSessionId === sessionId) {
      if (!checkSessionAlive()) return;
      void checkAuthorization().then((ok) => {
        if (closed || !ok) {
          closeStream();
          return;
        }
        const log = manager.log(sessionId);
        const result = normalizeLatestAssistantOutput(manager, conversationHistory, sessionId, log, {
          allowAssistantFallback: true
        });
        if (result.text) {
          writeSse(response, 'result', {
            sessionId,
            data: result.text,
            assistantResult: result.text,
            outputMeta: result.metadata,
            rawOutputExposed: false
          });
        }
        writeSse(response, 'exit', { sessionId, code, signal });
      });
    }
  };
  const keepalive = setInterval(() => {
    if (!checkSessionAlive()) return;
    void checkAuthorization().then((ok) => {
      if (closed || !ok) {
        closeStream();
        return;
      }
      response.write(SSE_KEEPALIVE_FRAME);
    });
  }, 30_000);
  keepalive.unref();

  manager.on('output', outputHandler);
  manager.on('state', stateHandler);
  manager.on('exit', exitHandler);

  response.on('error', () => closeStream());
  request.on('close', () => closeStream());
}

interface CreditPersistenceBridgeOptions {
  creditLedger: CreditLedger;
  resolveUserStore: () => Promise<UserStore | null>;
  commitCreditReservation?: (reservationId: string) => Promise<void>;
  releaseCreditReservation?: (reservationId: string) => Promise<void>;
}

function wirePersistenceBridge(
  manager: SessionManager,
  persistence: PersistenceRuntime,
  logger: Logger,
  creditOptions?: CreditPersistenceBridgeOptions
): void {
  manager.enableTurnSettlementBarrier?.();
  const recordedSuccessfulTurnIds = new Map<string, string>();
  const inFlightSuccessfulTurns = new Set<string>();
  const recordedCreditRequests = new Set<string>();
  const persistenceQueues = new Map<string, Promise<void>>();

  const enqueuePersistence = (sessionId: string, label: string, operation: () => Promise<void>): Promise<void> => {
    const previous = persistenceQueues.get(sessionId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(() => retryMissingSessionPersistence(operation));
    persistenceQueues.set(sessionId, queued);
    void queued
      .catch((error) => logPersistError(logger, sessionId, label, error))
      .finally(() => {
        if (persistenceQueues.get(sessionId) === queued) {
          persistenceQueues.delete(sessionId);
        }
      });
    return queued;
  };

  manager.on('output', (sessionId: string, data: string) => {
    void enqueuePersistence(sessionId, 'recordOutputChunk', () => persistence.recordOutputChunk(sessionId, data).then(() => undefined));
  });

  manager.on('state', (sessionId: string, state: AdapterState) => {
    // Claude Code can emit its initial state synchronously inside spawn(), a
    // few milliseconds before agent_spawn has created meta.json. Serialize
    // state writes per session and retry only that expected creation race so a
    // delayed "running" state can never overwrite a later "idle" state.
    const queued = enqueuePersistence(sessionId, 'recordState', () => persistSessionStateWithRetry(persistence, sessionId, state));

    if (state.turnState === 'idle' && typeof state.turnCount === 'number') {
      void queued.then(() => queueSuccessfulConversationTurnRecord(
          manager,
          persistence,
          logger,
          recordedSuccessfulTurnIds,
          inFlightSuccessfulTurns,
          recordedCreditRequests,
          creditOptions,
          sessionId,
          state.turnCount!
        )).catch(() => manager.failTurnSettlement?.(sessionId, state.turnCount!));
    }
  });

  manager.on('exit', (sessionId: string, code: number, signal: string) => {
    void enqueuePersistence(
      sessionId,
      'recordTurnFinished',
      () => recordSessionExit(manager, persistence, recordedCreditRequests, creditOptions, sessionId, code, signal)
    );
  });
}

function synchronizeAnnouncementTranslations(
  item: AnnouncementContentItem,
  body: Record<string, unknown>,
  existing: AnnouncementContentItem | undefined
): void {
  const supplied = body.translations;
  if (isRecord(supplied)) {
    const previous = existing?.translations;
    item.translations = {
      'zh-CN': mergeAnnouncementTranslation(previous?.['zh-CN'], supplied['zh-CN']),
      ...(isRecord(supplied['en-US']) || previous?.['en-US']
        ? { 'en-US': mergeAnnouncementTranslation(previous?.['en-US'], supplied['en-US']) }
        : {})
    };
    const primary = item.translations['zh-CN'];
    item.title = primary.title;
    item.summary = primary.summary;
    item.body = primary.body;
    return;
  }

  item.translations = {
    'zh-CN': {
      title: item.title,
      summary: item.summary,
      body: item.body
    },
    ...(existing?.translations?.['en-US'] ? { 'en-US': existing.translations['en-US'] } : {})
  };
}

function mergeAnnouncementTranslation(
  previous: { title: string; summary: string; body: string } | undefined,
  input: unknown
): { title: string; summary: string; body: string } {
  const supplied = isRecord(input) ? input : {};
  return {
    title: typeof supplied.title === 'string' ? supplied.title : previous?.title ?? '',
    summary: typeof supplied.summary === 'string' ? supplied.summary : previous?.summary ?? '',
    body: typeof supplied.body === 'string' ? supplied.body : previous?.body ?? ''
  };
}

function isCompleteAnnouncementTranslation(
  translation: { title: string; summary: string; body: string } | undefined
): translation is { title: string; summary: string; body: string } {
  return Boolean(
    translation?.title.trim() &&
    translation.summary.trim() &&
    translation.body.trim()
  );
}

async function loadCurrentMcpIdentity(
  auth: AuthRuntime,
  userId: string,
  keyId: string
): Promise<{ user: User; key: McpKey }> {
  const user = await auth.userStore.findById(userId);
  const key = user?.mcpKeys.find((candidate) => candidate.id === keyId);
  if (!user || !key || !getMcpKeyAvailability(user, key).usable) {
    throw new AuthorizationHttpError('Access is not available for this key.');
  }
  return { user, key };
}

async function retryMissingSessionPersistence(
  operation: () => Promise<void>,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 40);
  const delayMs = Math.max(0, options.delayMs ?? 25);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      if (!isMissingSessionError(error) || attempt === attempts - 1) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function persistSessionStateWithRetry(
  persistence: PersistenceRuntime,
  sessionId: string,
  state: AdapterState,
  options: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const delayMs = Math.max(0, options.delayMs ?? 25);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await Promise.all([
        persistence.sessionStore.updateSessionMeta(sessionId, {
          turnState: state.turnState,
          turnCount: state.turnCount,
          claudeSessionId: state.claudeSessionId
        }),
        persistence.recordSessionEvent(sessionId, {
          event: 'agent_state',
          details: { ...state }
        })
      ]);
      return;
    } catch (error) {
      if (!isMissingSessionError(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function queueSuccessfulConversationTurnRecord(
  manager: SessionManager,
  persistence: PersistenceRuntime,
  logger: Logger,
  recordedSuccessfulTurnIds: Map<string, string>,
  inFlightSuccessfulTurns: Set<string>,
  recordedCreditRequests: Set<string>,
  creditOptions: CreditPersistenceBridgeOptions | undefined,
  sessionId: string,
  turnCount: number,
  attempt = 0
): void {
  const settlementKey = `${sessionId}:${turnCount}`;
  if (inFlightSuccessfulTurns.has(settlementKey)) return;
  inFlightSuccessfulTurns.add(settlementKey);

  setTimeout(() => {
    const session = manager.list().find((candidate) => candidate.id === sessionId);
    if (
      !session ||
      session.status !== 'running' ||
      session.sessionMode !== 'conversation' ||
      session.turnState !== 'idle' ||
      session.turnCount !== turnCount
    ) {
      inFlightSuccessfulTurns.delete(settlementKey);
      manager.completeTurnSettlement?.(sessionId, turnCount);
      return;
    }

    recordSuccessfulConversationTurn(
      manager,
      persistence,
      recordedSuccessfulTurnIds,
      recordedCreditRequests,
      creditOptions,
      sessionId,
      turnCount
    ).then((turnIdentity) => {
      recordedSuccessfulTurnIds.set(sessionId, turnIdentity);
      inFlightSuccessfulTurns.delete(settlementKey);
      manager.completeTurnSettlement?.(sessionId, turnCount);
    }).catch((error) => {
      if (isMissingSessionError(error) && attempt < 5) {
        inFlightSuccessfulTurns.delete(settlementKey);
        queueSuccessfulConversationTurnRecord(
          manager,
          persistence,
          logger,
          recordedSuccessfulTurnIds,
          inFlightSuccessfulTurns,
          recordedCreditRequests,
          creditOptions,
          sessionId,
          turnCount,
          attempt + 1
        );
        return;
      }
      inFlightSuccessfulTurns.delete(settlementKey);
      logPersistError(logger, sessionId, 'recordSuccessfulTurn', error);
      manager.failTurnSettlement?.(sessionId, turnCount);
    });
  }, attempt === 0 ? 0 : 25).unref?.();
}

async function recordSuccessfulConversationTurn(
  manager: SessionManager,
  persistence: PersistenceRuntime,
  recordedSuccessfulTurnIds: Map<string, string>,
  recordedCreditRequests: Set<string>,
  creditOptions: CreditPersistenceBridgeOptions | undefined,
  sessionId: string,
  turnCount: number
): Promise<string> {
  const transcript = await persistence.sessionStore.readTranscript(sessionId);
  const lastUser = [...transcript].reverse().find((entry) => entry.role === 'user');
  const turnIdentity = lastUser?.turnId ?? `${sessionId}:legacy-turn:${turnCount}`;
  if (recordedSuccessfulTurnIds.get(sessionId) === turnIdentity) {
    await recordCreditLedgerForTurn(persistence, recordedCreditRequests, creditOptions, sessionId, {
      status: 'charged',
      requestId: turnIdentity
    });
    return turnIdentity;
  }
  const log = manager.log(sessionId);
  await appendAssistantTranscriptFromOutput(persistence, sessionId, log);
  await persistence.recordTurnFinished(sessionId, {
    status: 'done',
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    signal: null,
    totalOutputChars: log.totalChars
  });
  await persistence.recordSessionEvent(sessionId, {
    event: 'turn_finished',
    details: {
      status: 'done',
      totalOutputChars: log.totalChars
    }
  });
  await recordCreditLedgerForTurn(persistence, recordedCreditRequests, creditOptions, sessionId, {
    status: 'charged',
    requestId: turnIdentity
  });
  return turnIdentity;
}

async function recordSessionExit(
  manager: SessionManager,
  persistence: PersistenceRuntime,
  recordedCreditRequests: Set<string>,
  creditOptions: CreditPersistenceBridgeOptions | undefined,
  sessionId: string,
  code: number,
  signal: string
): Promise<void> {
  const accepted = await manager.waitForSessionSettlementAcceptance?.(sessionId) ?? true;
  const log = manager.log(sessionId);
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  // Registry emits exitCode 0 when a managed session is explicitly killed
  // without a process exit code. The final registry status is authoritative:
  // only an actual completed session may be persisted and charged as success.
  const completed = accepted && code === 0 && session?.status === 'completed';
  await appendAssistantTranscriptFromOutput(persistence, sessionId, log);
  await persistence.recordTurnFinished(sessionId, {
    status: completed ? 'done' : 'error',
    finishedAt: new Date().toISOString(),
    exitCode: code,
    signal: signal || null,
    totalOutputChars: log.totalChars,
    ...(completed ? {} : { error: session?.status === 'killed'
      ? 'Agent session was cancelled'
      : `Agent exited with code ${code}${signal ? ` (${signal})` : ''}` })
  });
  await persistence.recordSessionEvent(sessionId, {
    event: 'agent_exit',
    details: {
      code,
      signal,
      totalOutputChars: log.totalChars
    }
  });
  const shouldChargeOnExit = completed && session?.sessionMode !== 'conversation';
  await recordCreditLedgerForTurn(persistence, recordedCreditRequests, creditOptions, sessionId, {
    status: shouldChargeOnExit ? 'charged' : 'failure',
    requestId: `${sessionId}:exit`,
    reason: shouldChargeOnExit ? 'agent_success' : 'agent_exit_failure'
  });
}

async function recordCreditLedgerForTurn(
  persistence: PersistenceRuntime,
  recordedCreditRequests: Set<string>,
  creditOptions: CreditPersistenceBridgeOptions | undefined,
  sessionId: string,
  input: { status: 'charged' | 'failure'; requestId: string; reason?: string }
): Promise<void> {
  if (!creditOptions) return;
  const meta = await persistence.sessionStore.readSessionMeta(sessionId);
  if (!meta) return;
  if (!meta.userId || !meta.modelId || !meta.creditUnits) {
    // There is nothing to settle unless a malformed/legacy record still owns
    // a durable hold, in which case fail safe by releasing it below.
    if (!meta.creditReservation) return;
  }
  const userStore = await creditOptions.resolveUserStore();
  if (!userStore) return;
  const requestId = meta.creditReservation?.requestId ?? input.requestId;
  if (recordedCreditRequests.has(requestId)) {
    // The ledger write may have succeeded while reservation commit/release did
    // not. A repeated terminal state must finish that hold.
    if (meta.creditReservation) {
      if (input.status === 'charged') {
        await (creditOptions.commitCreditReservation
          ? creditOptions.commitCreditReservation(meta.creditReservation.reservationId)
          : userStore.commitCreditReservation(meta.creditReservation.reservationId));
      } else {
        await (creditOptions.releaseCreditReservation
          ? creditOptions.releaseCreditReservation(meta.creditReservation.reservationId)
          : userStore.releaseCreditReservation(meta.creditReservation.reservationId));
      }
      await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined });
    }
    return;
  }
  if (!meta.userId || !meta.modelId || !meta.creditUnits) {
    if (meta.creditReservation) {
      await (creditOptions.releaseCreditReservation
        ? creditOptions.releaseCreditReservation(meta.creditReservation.reservationId)
        : userStore.releaseCreditReservation(meta.creditReservation.reservationId));
      await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined });
    }
    return;
  }
  if (input.status === 'charged') {
    const reservationId = meta.creditReservation?.reservationId;
    const debit = meta.creditReservation
      ? {
          balanceBeforeUnits: meta.creditReservation.balanceBeforeUnits,
          balanceAfterUnits: meta.creditReservation.balanceAfterUnits
        }
      : await userStore.debitCreditBalanceUnits(meta.userId, meta.creditUnits);
    await creditOptions.creditLedger.append({
      userId: meta.userId,
      username: meta.username,
      entry: meta.source ?? 'web',
      modelId: meta.modelId,
      units: meta.creditUnits,
      status: 'charged',
      reason: input.reason ?? 'agent_success',
      balanceBeforeUnits: debit.balanceBeforeUnits,
      balanceAfterUnits: debit.balanceAfterUnits,
      sessionId,
      requestId
    });
    recordedCreditRequests.add(requestId);
    if (reservationId) {
      await (creditOptions.commitCreditReservation
        ? creditOptions.commitCreditReservation(reservationId)
        : userStore.commitCreditReservation(reservationId));
      await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined });
    }
    await persistence.recordSessionEvent(sessionId, {
      event: 'credits_charged',
      details: {
        modelId: meta.modelId,
        creditUnits: meta.creditUnits,
        requestId
      }
    });
    return;
  }

  if (meta.creditReservation) {
    await (creditOptions.releaseCreditReservation
      ? creditOptions.releaseCreditReservation(meta.creditReservation.reservationId)
      : userStore.releaseCreditReservation(meta.creditReservation.reservationId));
    await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined });
  }
  const balanceUnits = await userStore.getCreditBalanceUnits(meta.userId);
  await creditOptions.creditLedger.append({
    userId: meta.userId,
    username: meta.username,
    entry: meta.source ?? 'web',
    modelId: meta.modelId,
    units: 0,
    status: 'failure',
    reason: input.reason ?? 'agent_failure',
    balanceBeforeUnits: balanceUnits,
    balanceAfterUnits: balanceUnits,
    sessionId,
    requestId
  });
  recordedCreditRequests.add(requestId);
}

async function appendAssistantTranscriptFromOutput(
  persistence: PersistenceRuntime,
  sessionId: string,
  log: LogResult
): Promise<void> {
  const transcript = await persistence.sessionStore.readTranscript(sessionId);
  const lastUser = [...transcript].reverse().find((entry) => entry.role === 'user');
  if (!lastUser) {
    return;
  }
  const existingAssistant = transcript.some((entry) => entry.role === 'assistant' && entry.turnId === lastUser.turnId);
  if (existingAssistant) {
    return;
  }
  const meta = await persistence.sessionStore.readSessionMeta(sessionId);
  const projection = projectAssistantOutput(sliceRetainedLog(log, lastUser.outputStart ?? 0), {
    allowAssistantFallback: true,
    ...(meta?.usedSources ? { usedSources: meta.usedSources } : {}),
    ...(meta?.sourceCitationSummary ? { sourceCitationSummary: meta.sourceCitationSummary } : {})
  });
  if (!projection.text) {
    return;
  }
  await persistence.sessionStore.appendTranscript(sessionId, {
    role: 'assistant',
    turnId: lastUser.turnId,
    text: projection.text,
    createdAt: new Date().toISOString(),
    chatMode: meta?.chatMode,
    modelId: meta?.modelId,
    creditUnits: meta?.creditUnits,
    ...(meta?.usedSources ? { usedSources: meta.usedSources } : {}),
    sourceCitationSummary: projection.metadata.citations
  });
}

function logPersistError(logger: Logger, sessionId: string, operation: string, error: unknown): void {
  logger.error(LOG_EVENTS.persistError, 'Session persistence write failed', {
    sessionId,
    metadata: {
      operation,
      error: error instanceof Error ? error.message : String(error)
    }
  });
}

async function initializeAuthRuntime(options: HttpServerOptions['auth']): Promise<AuthRuntime | null> {
  if (options?.enabled === false) {
    return null;
  }

  const config = options?.config ?? getAuthConfig();
  const userStore = options?.userStore ?? new UserStore(config);
  await userStore.init();
  const jwtService = options?.jwtService ?? new JwtService(config);

  // Only initialize RolesService if a rolesFile path is provided
  const rolesFile = options?.rolesFile;
  const rolesService = rolesFile
    ? new RolesService({
        rolesFile,
        usersFile: config.dataDir
          ? path.resolve(config.dataDir, 'users.json')
          : path.resolve(process.cwd(), 'config', 'users.json')
      })
    : undefined;

  return {
    config,
    jwtService,
    routes: createAuthRoutes({ userStore, jwtService, config, rolesService }),
    userStore,
    rolesService: rolesService!
  };
}

async function initializeChipRuntime(options: HttpServerOptions['chips']): Promise<ChipRuntime | null> {
  if (!options || options.enabled === false) {
    return null;
  }

  const legacyUserAccessFile = path.resolve(options?.userAccessFile ?? getDefaultUserChipAccessPath());

  if (options?.catalog) {
    return {
      catalog: options.catalog,
      legacyUserAccessFile
    };
  }

  if (!options.configFile && options.enabled !== true) {
    return null;
  }

  try {
    const configFile = path.resolve(options?.configFile ?? getDefaultChipConfigPath());
    const catalog = await loadChipCatalogFromFile(configFile);
    return {
      catalog,
      configFile,
      legacyUserAccessFile
    };
  } catch {
    return null;
  }
}

async function initializePromptRuntime(options: HttpServerOptions['prompts']): Promise<PromptRuntime | null> {
  if (options?.enabled === false) {
    return null;
  }

  try {
    const rolesFile = options?.rolesFile ?? path.resolve(process.cwd(), 'config', 'roles.json');
    const [catalog, roleConfig] = await Promise.all([
      loadPromptCatalog(options?.configFile ?? path.resolve(process.cwd(), 'config', 'prompts.json')),
      loadRoleConfig(rolesFile)
    ]);

    return {
      catalog,
      roleConfig,
      rolesFile,
      sessionStates: new Map()
    };
  } catch (error) {
    console.warn('Prompt runtime initialization failed:', error);
    return null;
  }
}

async function initializeResourceRuntime(options: HttpServerOptions['resources']): Promise<ResourceRuntime | null> {
  if (!options || options.enabled === false) {
    return null;
  }
  if (options.catalog) {
    return { catalog: parseResourceVisibilityCatalog(options.catalog) };
  }
  if (!options.configFile && options.enabled !== true) {
    return null;
  }
  const configFile = path.resolve(options.configFile ?? path.resolve(process.cwd(), 'config', 'resource-visibility.json'));
  try {
    return {
      catalog: await loadResourceVisibilityCatalogFromFile(configFile),
      configFile
    };
  } catch (error) {
    // 批次C（2.2.27）：显式区分「配置文件缺失」与「配置文件损坏」，不再一律静默降级为 null → 通用 500。
    // - ENOENT（未落地正式的 resource-visibility.json）→ 降级为空 catalog：让「文档与 Scope」以空态可用、
    //   可继续新建并在首次写操作时落盘生成该文件，而不是整块面板 500（此前本地/新环境的必现故障根因）。
    // - 其它错误（JSON 解析失败等真正的配置错误）→ 保持返回 null（handler 返回 500），交由人工修复。
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return {
        catalog: parseResourceVisibilityCatalog({ documents: [], scopePresets: [] }),
        configFile
      };
    }
    return null;
  }
}

async function initializeProductRuntime(options: HttpServerOptions['product']): Promise<ProductRuntime> {
  const version = getProductVersionSummary();
  return {
    config: await loadProductConfig({
      config: options?.config,
      configFile: options?.configFile
    }),
    version
  };
}

function initializeModelRoutingRuntime(options: HttpServerOptions['modelRouting']): ModelRoutingRuntime {
  const configFile = options?.configFile
    ? path.resolve(options.configFile)
    : path.resolve(process.cwd(), 'config', 'model-routing.json');
  const config = options?.config
    ? normalizeModelRoutingConfig({ ...DEFAULT_MODEL_ROUTING_CONFIG, ...options.config })
    : loadModelRoutingConfigSync({ configFile });
  return { configFile, config };
}

async function refreshPromptRoleConfig(prompts: PromptRuntime | null): Promise<void> {
  if (!prompts) {
    return;
  }
  prompts.roleConfig = await loadRoleConfig(prompts.rolesFile);
}

async function handleSessionCreate(
  request: IncomingMessage,
  response: ServerResponse,
  manager: SessionManager,
  actions: SessionActions,
  conversationHistory: ConversationHistory,
  auth: AuthRuntime | null,
  chips: ChipRuntime | null,
  chipCatalogRequired: boolean,
  prompts: PromptRuntime | null,
  resources: ResourceRuntime | null,
  persistence: PersistenceRuntime | undefined,
  logger: Logger,
  modelRouting: ModelRoutingRuntime,
  rawBody: unknown,
  discoveryTraceStore?: DiscoveryTraceStore,
  scopeLargeQueryFactory: typeof runScopeQueryLarge = runScopeQueryLarge,
  scopeSmallThreshold: number = DEFAULT_SCOPE_SMALL_THRESHOLD,
  creditReservations?: SessionActionOptions['creditReservations']
): Promise<void> {
  if (!isRecord(rawBody)) {
    throw new HttpError(400, 'Expected JSON object');
  }
  const locale = parseOptionalWebLocale(rawBody.locale);
  const { locale: _locale, ...body } = rawBody;
  assertPublicSpawnControlsAbsent(body, 'web-chat');
  // Validate the complete client payload before resolving or materializing any
  // scope workspace. This prevents invalid sibling fields from leaking a
  // freshly copied scope directory before the later trusted-field injection.
  AgentActionSchemas.agent_spawn.parse(body);

  const userRole = (request as AuthenticatedRequest).user?.role;
  assertSearchModeSelectableForRequest(
    request as AuthenticatedRequest,
    'web-chat',
    body.chatMode,
    body.model,
    typeof body.task === 'string' && containsChatImageInput(body.task),
    modelRouting
  );

  if (auth && chipCatalogRequired && !chips) {
    throw new HttpError(
      503,
      'The datasheet resource catalog is unavailable. Session creation is temporarily disabled.',
      'RESOURCE_CATALOG_UNAVAILABLE'
    );
  }

  if (chips) {
    if ('cwd' in body && typeof body.cwd === 'string' && body.cwd.trim() !== '') {
      throw new HttpError(400, 'cwd must not be supplied directly; use chipId to select workspace');
    }

    const chipId = body.chipId;
    const summary = await buildRequestAuthorizationSummary(auth, request as AuthenticatedRequest, chips);
    let scopeSession = await prepareAuthorizedScopeSession({
      summary,
      chips,
      resources,
      persistence,
      input: body,
      entryPoint: 'web'
    });

    // C2 + M3 T3/T4：动态 scope 描述符（group / global）接入——仅在 preset 路径未命中时才尝试。
    // small → 物化 + 原 streaming spawn（零回归）；large → 托管会话 + 后台两阶段，201 即返回。
    const bodyScope = isRecord(body.scope) ? body.scope as unknown as ScopeDescriptor : undefined;
    if (!scopeSession && bodyScope && (bodyScope.mode === 'group' || bodyScope.mode === 'global')) {
      const routing = await prepareAuthorizedDynamicScopeSession({
        summary,
        chips,
        resources,
        persistence,
        descriptor: bodyScope,
        request,
        prompts,
        entryPoint: 'web',
        threshold: scopeSmallThreshold
      });
      if (routing?.kind === 'large') {
        const parsed = AgentActionSchemas.agent_spawn.parse(body);
        const question = parsed.task;
        const agentQuestion = withResponseLanguageTurnContext(question, locale);
        const modeRouting = resolveSearchModeSelection({
          requestedMode: parsed.chatMode,
          requestedModelId: parsed.model,
          entryPoint: 'web-chat',
          includesImageInput: containsChatImageInput(question),
          role: (request as AuthenticatedRequest).user?.role ?? ((request as AuthenticatedRequest).user?.userId ? undefined : 'admin'),
          userModelGrants: (request as AuthenticatedRequest).user?.authorizedModels,
          creditBalanceUnits: (request as AuthenticatedRequest).user?.credits?.balanceUnits,
          modeRoleMapping: modelRouting.config.modeRoleMapping
        });
        if (!modeRouting.ok) {
          throw new HttpError(modeRouting.statusCode, modeRouting.message, modeRouting.code, modeRouting.details);
        }
        const largeUser = (request as AuthenticatedRequest).user;
        const largeCreditReservation = largeUser?.userId && creditReservations
          ? await reserveHttpCredits(creditReservations, largeUser.userId, modeRouting.creditUnits)
          : undefined;
        let handle: ReturnType<SessionManager['createManagedSession']>;
        try {
          handle = manager.createManagedSession({
            userId: largeUser?.userId,
            task: question,
            chatMode: modeRouting.chatMode,
            modelId: modeRouting.modelId,
            claudeModelRole: modeRouting.modelId,
            creditUnits: modeRouting.creditUnits,
            creditReservation: largeCreditReservation,
            // P1-3 (multi-agent audit): pass large-scope auth-recheck inputs so
            // revocation of any allowed chip fires SessionAuthorizationRevokedError
            // on subsequent /log /poll /send /kill. Dynamic-group/global sessions
            // are scoped by allowedChipIds + scopePresetId (no single chipId here).
            documentId: typeof body.documentId === 'string' ? body.documentId : undefined,
            scopePresetId: routing.scopePresetId,
            allowedChipIds: routing.allowedChipIds,
            allowedDocumentIds: routing.allowedDocumentIds,
            scopeDescriptor: bodyScope
          });
        } catch (error) {
          if (largeCreditReservation) {
            await creditReservations?.release(largeCreditReservation.reservationId).catch(() => {});
          }
          throw error;
        }
        // T18-d/F3-obs：large 路径绕过 agent_spawn，必须在 201 前手动落
        // session-created + user-turn + question-ledger + agent_spawn event。
        if (persistence) {
          const largeTurnId = `turn-${crypto.randomUUID()}`;
          try {
            await recordSpawnRecords(persistence, handle.sessionId, {
              sessionId: handle.sessionId,
              userId: largeUser?.userId,
              username: largeUser?.username,
              role: largeUser?.role,
              agentType: 'claude-code',
              scopePresetId: routing.scopePresetId,
              allowedChipIds: routing.allowedChipIds,
              allowedDocumentIds: routing.allowedDocumentIds,
              cwd: '',
              task: question,
              sessionMode: 'oneshot',
              chatMode: modeRouting.chatMode,
              modelId: modeRouting.modelId,
              claudeModelRole: modeRouting.modelId,
              creditUnits: modeRouting.creditUnits,
              creditReservation: largeCreditReservation
                ? { ...largeCreditReservation, requestId: largeTurnId }
                : undefined,
              scopeDescriptor: bodyScope,
              source: 'web',
              turnId: largeTurnId,
              userRole: largeUser?.role
            });
          } catch (error) {
            if (largeCreditReservation) {
              await persistence.sessionStore.updateSessionMeta(handle.sessionId, { creditReservation: undefined }).catch(() => {});
              await creditReservations?.release(largeCreditReservation.reservationId).catch(() => {});
            }
            logPersistError(logger, handle.sessionId, 'recordSessionCreated', error);
            handle.fail('Failed to persist large-scope session metadata.');
            throw new HttpError(500, 'Failed to persist session records', 'PERSISTENCE_ERROR');
          }
        }
        // admin Discovery Trace：large 档未物化，仅落 scope.resolve（跳过 scope.materialize）。
        // 使用真实 allowedDocumentCount（文档数），而非 chip 数。
        if (discoveryTraceStore) {
          recordScopeTrace(discoveryTraceStore, handle.sessionId, {
            scopePresetId: routing.scopePresetId,
            safeSummary: {
              scopeId: routing.scopeId,
              scopePresetId: routing.scopePresetId,
              fileCount: routing.fileCount,
              allowedChipCount: routing.allowedChipIds.length,
              allowedDocumentCount: routing.allowedDocumentCount,
              mode: 'index'
            }
          }, { emitMaterialize: false });
        }
        void persistence?.sessionDebugBundles.write(handle.sessionId, {
          type: '跨档两步',
          stages: [{
            stage: 'scope.resolve',
            status: 'ok',
            detail: {
              scopePresetId: routing.scopePresetId,
              scopeId: routing.scopeId,
              allowedChipCount: routing.allowedChipIds.length,
              allowedDocumentCount: routing.allowedDocumentCount,
              fileCount: routing.fileCount
            }
          }]
        });
        // A4：把 debug bundle 的流水线类型同步落到 SessionMeta，供 admin 会话列表「类型」列展示。
        void persistence?.sessionStore.updateSessionMeta(handle.sessionId, { pipelineType: '跨档两步' }).catch(() => {});
        const largeDataDir = persistence?.dataDir ?? resolveDataDir();
        // T18-d：包一层 sink，complete 时先把 usedSources/citation 写回落盘 meta（reload 可见来源），
        // 再调用 handle.complete（触发 finish→exit→recordSessionExit，此时 meta 已就位）。
        const largeSink: LargeScopeSink = persistence
          ? {
              appendOutput: (chunk) => handle.appendOutput(chunk),
              complete: (meta) => {
                void (async () => {
                  if (meta) {
                    await persistence.sessionStore
                      .updateSessionMeta(handle.sessionId, {
                        usedSources: meta.usedSources,
                        sourceCitationSummary: meta.sourceCitationSummary
                      })
                      .catch((error) => logPersistError(logger, handle.sessionId, 'updateScopeMeta', error));
                  }
                  handle.complete(meta);
                })();
              },
              fail: (message) => handle.fail(message)
            }
          : handle;
        // 后台两阶段引擎：进度行 + 答案流式注入托管会话；不阻塞 201。
        void streamLargeScopeDiscovery({
          sink: largeSink,
          scopePresetId: routing.scopePresetId,
          runQuery: (onTrace, signal) =>
            scopeLargeQueryFactory({
              catalog: chips.catalog,
              dataDir: largeDataDir,
              knowledgeBaseRoot: chips.catalog.knowledgeBaseRoot,
              allowedChipIds: routing.allowedChipIds,
              allowedDocumentIds: routing.allowedDocumentIds,
              userId: largeUser?.userId,
              getResourceCatalog: () => resources?.catalog ?? null,
              reauthorize: async () => {
                const currentSummary = await buildRequestAuthorizationSummary(
                  auth,
                  request as AuthenticatedRequest,
                  chips
                );
                if (!currentSummary) {
                  return { allowedChipIds: [], allowedDocumentIds: [] };
                }
                const currentAuthorizedChipIds = listAuthorizedChipIds(
                  chips.catalog,
                  (candidateChipId) => canRequestAccessChip(currentSummary, candidateChipId)
                );
                try {
                  const currentSelection = resolveDynamicScopeSelection({
                    authorization: currentSummary,
                    catalog: chips.catalog,
                    resources: resources?.catalog ?? parseResourceVisibilityCatalog({ documents: [], scopePresets: [] }),
                    authorizedChipIds: currentAuthorizedChipIds,
                    descriptor: bodyScope,
                    entryPoint: 'web'
                  });
                  return {
                    allowedChipIds: currentSelection.allowedChipIds,
                    allowedDocumentIds: currentSelection.allowedDocumentIds
                  };
                } catch (error) {
                  if (error instanceof ScopeSessionDeniedError) {
                    return { allowedChipIds: [], allowedDocumentIds: [] };
                  }
                  throw error;
                }
              },
              question: agentQuestion,
              claudeModelRole: modeRouting.modelId,
              onTrace,
              signal
            }),
          recordTrace: (stage, detail, artifact, durationMs) => {
            if (discoveryTraceStore) {
              void discoveryTraceStore.record({
                  sessionId: handle.sessionId,
                  traceId: handle.sessionId,
                  stage,
                  status: 'ok',
                  detail
                });
            }
            void persistence?.sessionDebugBundles.write(handle.sessionId, {
              type: '跨档两步',
              stages: [{ stage, status: 'ok', durationMs, detail, artifact }]
            });
          },
          onError: (err) =>
            logger.error(LOG_EVENTS.sessionSpawn, 'large-scope discovery failed', {
              sessionId: handle.sessionId,
              metadata: { error: String(err) }
            }),
          chipLabelOf: (chipId) => chips.catalog.chips.find((chip) => chip.id === chipId)?.label ?? chipId,
          signal: handle.signal
        });
        recordConversationInput(manager, conversationHistory, handle.sessionId, question, 0);
        sendJson(response, 201, { sessionId: handle.sessionId, status: 'running' });
        return;
      }
      if (routing?.kind === 'small') {
        scopeSession = routing.session;
      }
    }

    if (scopeSession) {
      let ownershipTransferred = false;
      try {
        if (summary) {
          if (typeof body.documentId === 'string') {
            assertAuthorizedDocument(summary, resources, body.documentId, persistence, logger, {
              entry: 'web',
              action: 'agent_spawn'
            });
          }
          if (typeof body.scopePresetId === 'string') {
            assertAuthorizedScopePreset(summary, resources, body.scopePresetId, persistence, logger, {
              entry: 'web',
              action: 'agent_spawn'
            });
          }
        }
        const scopeHardening = await scopeLaunchHardening(chips.catalog.knowledgeBaseRoot);
        const parsedScopeSpawn = AgentActionSchemas.agent_spawn.parse(body);
        const displayTask = parsedScopeSpawn.task;
        if (containsChatImageInput(parsedScopeSpawn.task)) {
          const materialized = await materializeChatImagesIntoWorkspace({
            task: parsedScopeSpawn.task,
            cwd: scopeSession.cwd,
            dataDir: persistence?.dataDir ?? resolveDataDir(),
            userId: (request as AuthenticatedRequest).user?.userId
          });
          if (containsChatImageInput(materialized.task)) {
            throw new HttpError(410, 'One or more chat images are unavailable or expired.', 'CHAT_IMAGE_UNAVAILABLE');
          }
          parsedScopeSpawn.task = materialized.task;
        }
        const spawnParams = {
          ...parsedScopeSpawn,
          displayTask,
          cwd: scopeSession.cwd,
          chipId: undefined,
          documentId: scopeSession.documentId,
          scopePresetId: scopeSession.scopePresetId,
          allowedChipIds: scopeSession.allowedChipIds,
          allowedDocumentIds: scopeSession.allowedDocumentIds,
          scopeWorkspace: scopeSession.safeSummary,
          usedSources: scopeSession.safeSummary.usedSources,
          sourceCitationSummary: scopeSession.safeSummary.sourceCitationSummary,
          scopeWorkspaceCleanup: scopeSession.cleanup,
          denyReadRoots: scopeHardening.denyReadRoots,
          allowedTools: scopeHardening.allowedTools,
          permissionMode: scopeHardening.permissionMode,
          systemPrompt: withScopeWorkspaceSystemContext(undefined, scopeSession)
        };

        const requestActions = getRequestActions(
          request as AuthenticatedRequest,
          manager,
          actions,
          persistence,
          'web',
          creditReservations,
          modelRouting,
          auth,
          chips,
          resources,
          locale
        );
        ownershipTransferred = true;
        const spawnResult = await requestActions.agent_spawn(spawnParams);
        // M2 Task 3: scope 分支落 scope.resolve / scope.materialize trace
        if (discoveryTraceStore) {
          recordScopeTrace(discoveryTraceStore, spawnResult.sessionId, scopeSession);
        }
        void persistence?.sessionDebugBundles.write(spawnResult.sessionId, {
          type: '全局',
          systemPrompt: { text: spawnParams.systemPrompt ?? '' },
          stages: [
            {
              stage: 'scope.resolve',
              status: 'ok',
              detail: {
                scopePresetId: scopeSession.scopePresetId,
                scopeId: scopeSession.safeSummary.scopeId,
                fileCount: scopeSession.safeSummary.fileCount,
                allowedChipCount: scopeSession.safeSummary.allowedChipCount,
                allowedDocumentCount: scopeSession.safeSummary.allowedDocumentCount
              }
            },
            {
              stage: 'scope.materialize',
              status: 'ok',
              detail: {
                scopeId: scopeSession.safeSummary.scopeId,
                fileCount: scopeSession.safeSummary.fileCount,
                mode: scopeSession.safeSummary.mode
              },
              artifact: {
                workspace: {
                  scopeId: scopeSession.safeSummary.scopeId,
                  mode: scopeSession.safeSummary.mode,
                  files: scopeSession.safeSummary.labels
                }
              }
            }
          ]
        });
        // A4：把 debug bundle 的流水线类型同步落到 SessionMeta，供 admin 会话列表「类型」列展示。
        void persistence?.sessionStore.updateSessionMeta(spawnResult.sessionId, { pipelineType: '全局' }).catch(() => {});
        recordConversationInput(manager, conversationHistory, spawnResult.sessionId, displayTask, 0);
        sendJson(response, 201, redactExternalSessionResult(spawnResult));
        return;
      } finally {
        if (!ownershipTransferred) {
          await scopeSession.cleanup().catch(() => undefined);
        }
      }
    }
    if (typeof chipId !== 'string' || chipId.trim() === '') {
      throw new HttpError(400, 'chipId is required when chips are configured');
    }
    if (summary) {
      assertAuthorizedChipResource(summary, chips, (request as AuthenticatedRequest).user, chipId, prompts, persistence, logger, {
        entry: 'web',
        action: 'agent_spawn'
      });
      if (typeof body.documentId === 'string') {
        assertAuthorizedDocument(summary, resources, body.documentId, persistence, logger, {
          entry: 'web',
          action: 'agent_spawn'
        });
      }
      if (typeof body.scopePresetId === 'string') {
        assertAuthorizedScopePreset(summary, resources, body.scopePresetId, persistence, logger, {
          entry: 'web',
          action: 'agent_spawn'
        });
      }
    }
    const resolved = await resolveChipWorkspace(chips.catalog, chipId as string);

    if (summary && !canRequestAccessChip(summary, resolved.chipId)) {
      throw new HttpError(403, 'The requested resource is not available to this identity.');
    }

    // Build system prompt based on role
    let systemPrompt: string | undefined;
    let sessionIdForState: string | undefined;
    if (prompts) {
      const effectiveRole = userRole ?? 'customer';
      const composed = await buildSessionSystemPrompt(prompts.catalog, effectiveRole, resolved.chipId);
      const policy = getInjectionPolicy(effectiveRole, prompts.roleConfig);
      const state = createInjectorState();
      const injected = injectSystemPrompt(state, policy, withWorkspaceSystemContext(composed, resolved));
      systemPrompt = injected ?? undefined;
      // Store state key as placeholder; will update with actual sessionId after spawn
      sessionIdForState = crypto.randomUUID();
      prompts.sessionStates.set(sessionIdForState, state);
    } else {
      systemPrompt = withWorkspaceSystemContext(undefined, resolved);
    }

    const dataDir = persistence?.dataDir ?? resolveDataDir();
    const launch = await prepareChipLaunch({
      chipSourceCwd: resolved.cwd,
      knowledgeBaseRoot: chips.catalog.knowledgeBaseRoot,
      dataDir
    });
    let ownershipTransferred = false;
    try {
    // M4 多模态修复（spec §6.8）：把 task 引用的上传图片 copy 进隔离工作区，
    // 并把 URL 重写成本地相对路径，让多模态模型用 Read 读图（真多模态）。
    const parsedSpawn = AgentActionSchemas.agent_spawn.parse(body);
    const displayTask = parsedSpawn.task;
    let chatImageFiles: Array<{ path: string; size?: number }> = [];
    if (typeof parsedSpawn.task === 'string' && containsChatImageInput(parsedSpawn.task)) {
      const { task: rewrittenTask, files } = await materializeChatImagesIntoWorkspace({
        task: parsedSpawn.task,
        cwd: launch.cwd,
        dataDir,
        userId: (request as AuthenticatedRequest).user?.userId
      });
      if (containsChatImageInput(rewrittenTask)) {
        throw new HttpError(410, 'One or more chat images are unavailable or expired.', 'CHAT_IMAGE_UNAVAILABLE');
      }
      parsedSpawn.task = rewrittenTask;
      chatImageFiles = files;
    }
    const spawnParams = {
      ...parsedSpawn,
      displayTask,
      cwd: launch.cwd,
      chipId: resolved.chipId,
      scopeWorkspace: undefined,
      denyReadRoots: launch.denyReadRoots,
      allowedTools: launch.allowedTools,
      permissionMode: launch.permissionMode,
      scopeWorkspaceCleanup: launch.cleanup,
      systemPrompt
    };

    const requestActions = getRequestActions(
      request as AuthenticatedRequest,
      manager,
      actions,
      persistence,
      'web',
      creditReservations,
      modelRouting,
      auth,
      chips,
      resources,
      locale
    );
    ownershipTransferred = true;
    const spawnResult = await requestActions.agent_spawn(spawnParams);
    void persistence?.sessionDebugBundles.write(spawnResult.sessionId, {
      type: '单芯片',
      systemPrompt: { text: systemPrompt ?? '' },
      stages: [{
        stage: 'workspace.snapshot',
        status: 'ok',
        detail: {
          chipId: resolved.chipId,
          fileCount: launch.files.length,
          chatImageCount: chatImageFiles.length
        },
        artifact: {
          chipId: resolved.chipId,
          files: launch.files,
          ...(chatImageFiles.length > 0 ? { chatImages: chatImageFiles } : {})
        }
      }]
    });
    // A4：把 debug bundle 的流水线类型同步落到 SessionMeta，供 admin 会话列表「类型」列展示。
    void persistence?.sessionStore.updateSessionMeta(spawnResult.sessionId, { pipelineType: '单芯片' }).catch(() => {});
    recordConversationInput(manager, conversationHistory, spawnResult.sessionId, displayTask, 0);

    // Update session state key with actual sessionId for future every_turn injection
    if (prompts && sessionIdForState && spawnResult.sessionId !== sessionIdForState) {
      const state = prompts.sessionStates.get(sessionIdForState);
      if (state) {
        prompts.sessionStates.delete(sessionIdForState);
        prompts.sessionStates.set(spawnResult.sessionId, state);
      }
    }

    sendJson(response, 201, redactExternalSessionResult(spawnResult));
    return;
    } finally {
      if (!ownershipTransferred) {
        await launch.cleanup().catch(() => undefined);
      }
    }
  }

  // No chips configured path
  let systemPrompt: string | undefined;
  let sessionIdForState: string | undefined;
  if (prompts) {
    const effectiveRole = userRole ?? 'customer';
    const composed = await buildSessionSystemPrompt(prompts.catalog, effectiveRole, '');
    const policy = getInjectionPolicy(effectiveRole, prompts.roleConfig);
    const state = createInjectorState();
    const injected = injectSystemPrompt(state, policy, composed);
    systemPrompt = injected ?? undefined;
    sessionIdForState = crypto.randomUUID();
    prompts.sessionStates.set(sessionIdForState, state);
  }

  const parsedSpawn = AgentActionSchemas.agent_spawn.parse(body);
  const displayTask = parsedSpawn.task;
  const spawnResult = await getRequestActions(
    request as AuthenticatedRequest,
    manager,
    actions,
    persistence,
    'web',
    creditReservations,
    modelRouting,
    auth,
    chips,
    resources,
    locale
  ).agent_spawn({
    ...parsedSpawn,
    displayTask,
    scopeWorkspace: undefined,
    scopeWorkspaceCleanup: undefined,
    systemPrompt
  });
  recordConversationInput(manager, conversationHistory, spawnResult.sessionId, displayTask, 0);

  // Update session state key with actual sessionId for future every_turn injection
  if (prompts && sessionIdForState && spawnResult.sessionId !== sessionIdForState) {
    const state = prompts.sessionStates.get(sessionIdForState);
    if (state) {
      prompts.sessionStates.delete(sessionIdForState);
      prompts.sessionStates.set(spawnResult.sessionId, state);
    }
  }

  sendJson(response, 201, redactExternalSessionResult(spawnResult));
}

function isProtectedApiRoute(pathname: string): boolean {
  return pathname === '/sessions' ||
    pathname.startsWith('/sessions/') ||
    pathname === '/rpc' ||
    pathname === '/api/feedback/messages';
}

function parseTicketListFilters(url: URL, options: { includeKeyword?: boolean } = {}): TicketListFilters {
  const type = url.searchParams.get('type') ?? undefined;
  const needsMoreInfo = url.searchParams.get('needsMoreInfo');
  return {
    type: isTicketType(type) ? type : undefined,
    status: nonEmptyQuery(url.searchParams.get('status')),
    needsMoreInfo: needsMoreInfo === 'true' ? true : needsMoreInfo === 'false' ? false : undefined,
    keyword: options.includeKeyword ? nonEmptyQuery(url.searchParams.get('q') ?? url.searchParams.get('keyword'), 120) : undefined,
    feedbackType: nonEmptyQuery(url.searchParams.get('feedbackType'), 80),
    chipId: nonEmptyQuery(url.searchParams.get('chipId'), 120),
    documentId: nonEmptyQuery(url.searchParams.get('documentId'), 160),
    scopePresetId: nonEmptyQuery(url.searchParams.get('scopePresetId'), 160),
    modelId: nonEmptyQuery(url.searchParams.get('modelId'), 120),
    reviewSignal: nonEmptyQuery(url.searchParams.get('reviewSignal'), 80),
    offset: parseOptionalNonNegativeInt(url.searchParams.get('offset')),
    limit: parseOptionalPositiveInt(url.searchParams.get('limit'))
  };
}

function isJsonRequest(request: IncomingMessage): boolean {
  const contentType = Array.isArray(request.headers['content-type'])
    ? request.headers['content-type'][0]
    : request.headers['content-type'];
  return Boolean(contentType?.toLowerCase().includes('application/json'));
}

function getApprovableAccountApplication(ticket: { type: string; payload: Record<string, unknown> }): AccountApplicationPayload {
  if (ticket.type !== 'account_application') {
    throw new HttpError(400, 'Ticket is not an account application');
  }
  const payload = ticket.payload;
  if (!isRecord(payload.application) || !isRecord(payload.credentialDraft)) {
    throw new HttpError(409, 'Account application credential draft is missing');
  }
  const application = payload.application;
  const draft = payload.credentialDraft;
  if (typeof application.username !== 'string' || typeof draft.passwordHash !== 'string') {
    throw new HttpError(409, 'Account application credential draft is missing');
  }
  if (draft.status !== 'pending') {
    throw new HttpError(409, 'Account application credential draft is not pending');
  }
  if (typeof draft.expiresAt !== 'string' || Date.parse(draft.expiresAt) <= Date.now()) {
    throw new HttpError(409, 'Account application credential draft has expired');
  }
  return payload as unknown as AccountApplicationPayload;
}

function buildDatasheetAdminReviewPatch(
  body: Record<string, unknown>,
  chips: ChipRuntime | null,
  resources: ResourceRuntime | null
): DatasheetAdminReviewUpdate {
  const status = typeof body.status === 'string' ? normalizeDatasheetReviewStatus(body.status) : undefined;
  const candidateInput = isRecord(body.metadataCandidate) ? body.metadataCandidate : undefined;
  const metadataCandidate = candidateInput ? buildDatasheetMetadataCandidate(candidateInput, chips, resources) : undefined;
  return {
    status,
    publicNote: typeof body.publicNote === 'string' ? body.publicNote : undefined,
    internalNote: typeof body.internalNote === 'string' ? body.internalNote : undefined,
    result: typeof body.result === 'string' ? body.result : undefined,
    needsMoreInfo: typeof body.needsMoreInfo === 'boolean' ? body.needsMoreInfo : status === 'needs_more_info' ? true : undefined,
    bindingNote: typeof body.bindingNote === 'string' ? body.bindingNote : undefined,
    metadataCandidate
  };
}

function normalizeDatasheetReviewStatus(value: string): DatasheetUploadReviewState {
  if (
    value === 'submitted' ||
    value === 'scanning' ||
    value === 'quarantined' ||
    value === 'reviewing' ||
    value === 'needs_more_info' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'linked'
  ) {
    return value;
  }
  throw new HttpError(400, 'Invalid datasheet review status');
}

function buildDatasheetMetadataCandidate(
  input: Record<string, unknown>,
  chips: ChipRuntime | null,
  resources: ResourceRuntime | null
): DatasheetMetadataCandidate {
  const candidate: DatasheetMetadataCandidate = {
    vendor: readCandidateString(input.vendor),
    partNumber: readCandidateString(input.partNumber ?? input.partNumberOrKeywords),
    brand: readCandidateString(input.brand),
    productLine: readCandidateString(input.productLine),
    application: readCandidateString(input.application),
    chipId: readCandidateString(input.chipId),
    documentId: readCandidateString(input.documentId),
    scopePresetId: readCandidateString(input.scopePresetId),
    applicationTags: readCandidateStringList(input.applicationTags ?? input.applications),
    resolution: {}
  };
  candidate.resolution = {
    brand: resolveKnown(candidate.brand, listKnownBrands(chips)),
    productLine: resolveKnown(candidate.productLine, listKnownProductLines(chips)),
    application: resolveKnown(candidate.application, listKnownApplications(chips)),
    chipId: resolveKnown(candidate.chipId, chips?.catalog.chips.map((chip) => chip.id) ?? []),
    documentId: resolveKnown(candidate.documentId, resources?.catalog.documents.map((document) => document.documentId) ?? []),
    scopePresetId: resolveKnown(candidate.scopePresetId, resources?.catalog.scopePresets.map((preset) => preset.scopePresetId) ?? [])
  };
  return candidate;
}

function resolveKnown(value: string | undefined, knownValues: string[]): DatasheetCandidateResolution {
  if (!value) {
    return 'empty';
  }
  return knownValues.includes(value) ? 'known' : 'proposed';
}

function listKnownBrands(chips: ChipRuntime | null): string[] {
  return uniqueStrings((chips?.catalog.chips ?? []).flatMap((chip) => [chip.brand, ...(chip.brandAliases ?? [])]));
}

function listKnownProductLines(chips: ChipRuntime | null): string[] {
  return uniqueStrings((chips?.catalog.chips ?? []).flatMap((chip) => chip.productLines ?? []));
}

function listKnownApplications(chips: ChipRuntime | null): string[] {
  return uniqueStrings((chips?.catalog.chips ?? []).flatMap((chip) => chip.applicationTags ?? []));
}

function readCandidateString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim().slice(0, 240);
  if (!trimmed || isPathLikeText(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function readCandidateStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return uniqueStrings(values.flatMap((entry) => {
    const safe = readCandidateString(entry);
    return safe ? [safe] : [];
  })).slice(0, 20);
}

function isPathLikeText(value: string): boolean {
  return /^[a-z]:\\/i.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.includes('\\');
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))];
}

function nonEmptyQuery(value: string | null, limit?: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, limit) : undefined;
}

function normalizeAdminCreditsAuditText(value: unknown, limit: number, errorMessage: string): string {
  const text = sanitizeTicketText(value, limit);
  if (!text) {
    throw new HttpError(400, errorMessage);
  }
  return text;
}

function normalizeAdminCreditsOptionalText(value: unknown, limit: number): string | undefined {
  return sanitizeTicketText(value, limit);
}

function writeSse(response: ServerResponse, event: keyof typeof SSE_EVENTS, data: unknown): void {
  response.write(`${SSE_EVENTS[event]}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function filterChipCatalogForRequest(
  chips: ChipRuntime,
  request: AuthenticatedRequest,
  summary: EffectiveAuthorizationSummary | undefined
): ChipCatalog {
  return filterChipCatalogForUser(chips, request.user, summary);
}

function filterChipCatalogForUser(
  chips: ChipRuntime,
  user: AuthenticatedRequest['user'],
  summary: EffectiveAuthorizationSummary | undefined
): ChipCatalog {
  if (!user || !summary) {
    return chips.catalog;
  }
  return {
    ...chips.catalog,
    chips: chips.catalog.chips.filter((chip) => canRequestAccessChip(summary, chip.id))
  };
}

function canRequestAccessChip(
  summary: EffectiveAuthorizationSummary | undefined,
  chipId: string
): boolean {
  if (!summary) {
    return true;
  }
  return authorizeResourceAccess(summary, { type: 'chip', id: chipId }).allowed;
}

function withWorkspaceSystemContext(
  systemPrompt: string | undefined,
  resolved: { chipId: string; cwd: string }
): string {
  // Never put resolved.cwd (the source datasheet dir) into the prompt: the isolation gate
  // adds it to denyReadRoots (src/scope/chip-launch.ts), so if CC follows that path it hits
  // the deny wall and ends up asking the user to authorize the directory. The datasheet is
  // copied into CC's current working directory (the isolated replica); point CC at the cwd.
  const workspaceContext = [
    '=== AGENTX WORKSPACE ===',
    `Selected chip: ${resolved.chipId}`,
    'The datasheet files for this chip are already in your current working directory. Use the Read and Grep tools on the files in your current working directory (including its subdirectories) to answer the question. Do not request access to any other path, and do not ask the user to authorize a directory.',
    'When the user asks for the current workspace, working directory, cwd, or chip folder, answer with the selected chip id above. Do not disclose server filesystem paths or internal execution directories.'
  ].join('\n');

  return [systemPrompt?.trim(), workspaceContext].filter(Boolean).join('\n\n');
}

function parseOptionalWebLocale(value: unknown): AnnouncementLocale | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'zh-CN' || value === 'en-US') {
    return value;
  }
  throw new HttpError(400, 'locale must be zh-CN or en-US', 'INVALID_LOCALE');
}

function parseAnnouncementLocale(value: string | null): AnnouncementLocale {
  return parseOptionalWebLocale(value) ?? 'zh-CN';
}

function withResponseLanguageTurnContext(
  userText: string,
  locale: AnnouncementLocale | undefined
): string {
  if (!locale) {
    return userText;
  }
  const language = locale === 'en-US' ? 'English' : 'Simplified Chinese';
  return [
    userText,
    '',
    '=== AGENTX RESPONSE LANGUAGE ===',
    `Respond in ${language} for this turn unless the user explicitly requests another language in the message above.`
  ].join('\n');
}

function recordConversationInput(
  manager: SessionManager,
  history: ConversationHistory,
  sessionId: string,
  text: string,
  outputStart?: number
): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  const existing = history.get(sessionId) ?? [];
  existing.push({
    text: trimmed,
    outputStart: outputStart ?? manager.log(sessionId).totalChars
  });
  history.set(sessionId, existing);
}

async function loadPersistedConversationMessages(
  persistence: PersistenceRuntime | undefined,
  sessionId: string
): Promise<ConversationMessage[]> {
  if (!persistence) return [];
  try {
    const transcript = await persistence.sessionStore.readTranscript(sessionId);
    return transcript.flatMap((entry) =>
      entry.role === 'user' || entry.role === 'assistant'
        ? [{
            role: entry.role,
            text: entry.text,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
            ...(entry.role === 'assistant' && entry.sourceCitationSummary
              ? { sourceCitationSummary: entry.sourceCitationSummary }
              : {})
          }]
        : []);
  } catch (error) {
    if (isMissingSessionError(error)) return [];
    throw error;
  }
}

function mergeConversationMessages(
  persisted: ConversationMessage[],
  live: ConversationMessage[]
): ConversationMessage[] {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const maxOverlap = Math.min(persisted.length, live.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const persistedStart = persisted.length - overlap;
    const matches = live.slice(0, overlap).every((message, index) => {
      const candidate = persisted[persistedStart + index];
      return candidate?.role === message.role && candidate.text === message.text;
    });
    if (matches) return [...persisted, ...live.slice(overlap)];
  }
  return [...persisted, ...live];
}

function buildConversationMessages(
  manager: SessionManager,
  history: ConversationHistory,
  sessionId: string,
  log: LogResult
): Array<{ role: 'user' | 'assistant'; text: string }> {
  let turns = history.get(sessionId);
  if (!turns || turns.length === 0) {
    const session = manager.list().find((candidate) => candidate.id === sessionId);
    if (session?.task) {
      turns = [{ text: session.task, outputStart: 0 }];
    }
  }

  if (!turns || turns.length === 0) {
    return log.output ? injectAssistantMessages([{ role: 'assistant', text: log.output }]) : [];
  }

  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!;
    messages.push({ role: 'user', text: turn.text });
    const nextTurn = turns[index + 1];
    const assistantText = normalizeProjectedAssistantOutput(sliceRetainedLog(log, turn.outputStart, nextTurn?.outputStart), {
      // A following user turn is definitive proof that the preceding turn
      // finished, even while the newest turn is still running. Do not hide
      // already-completed plain-text answers merely because the live session
      // is currently processing a later turn.
      allowAssistantFallback: Boolean(nextTurn) || isSessionTurnComplete(manager, sessionId)
    });
    if (assistantText) {
      messages.push({ role: 'assistant', text: assistantText });
    }
  }

  return messages;
}

function normalizeLatestAssistantOutput(
  manager: SessionManager,
  history: ConversationHistory,
  sessionId: string,
  log: LogResult,
  options: { allowAssistantFallback?: boolean } = {}
): ReturnType<typeof projectAssistantOutput> {
  const turns = history.get(sessionId);
  const latestTurn = turns && turns.length > 0 ? turns[turns.length - 1] : undefined;
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  return projectAssistantOutput(sliceRetainedLog(log, latestTurn?.outputStart ?? 0), {
    ...options,
    ...(session?.usedSources ? { usedSources: session.usedSources } : {}),
    ...(session?.sourceCitationSummary ? { sourceCitationSummary: session.sourceCitationSummary } : {})
  });
}

function sliceRetainedLog(log: LogResult, absoluteStart: number, absoluteEnd?: number): string {
  const retainedStart = log.offset;
  const retainedEnd = retainedStart + log.output.length;
  if (absoluteStart >= retainedEnd || (absoluteEnd !== undefined && absoluteEnd <= retainedStart)) {
    return '';
  }

  const relativeStart = Math.max(0, absoluteStart - retainedStart);
  const relativeEnd = absoluteEnd === undefined
    ? undefined
    : Math.max(0, Math.min(log.output.length, absoluteEnd - retainedStart));
  return log.output.slice(relativeStart, relativeEnd);
}

function isSessionTurnComplete(manager: SessionManager, sessionId: string): boolean {
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  return !session || session.status !== 'running' || session.turnState === 'idle';
}

function injectAssistantMessages<T extends { role: string; text: string }>(messages: T[]): T[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return message;
    }
    return {
      ...message,
      text: sanitizeProjectedAssistantText(message.text)
    };
  });
}

function validateRoleAccessChipIds(body: unknown, chips: ChipRuntime | null): void {
  if (!chips || !isRecord(body) || !isRecord(body.access) || !Array.isArray(body.access.allowedChips)) {
    return;
  }

  const allowedChipIds = new Set(chips.catalog.chips.map((chip) => chip.id));
  for (const chipId of body.access.allowedChips) {
    if (chipId === '*') {
      continue;
    }
    if (typeof chipId !== 'string' || !allowedChipIds.has(chipId)) {
      throw new HttpError(400, `Unknown role chip grant '${String(chipId)}'`);
    }
  }
}

function parseAdminChipCatalog(value: unknown): ChipCatalog {
  try {
    return parseChipCatalog(value, 'admin /admin/chips');
  } catch (error) {
    if (error instanceof ChipConfigError) {
      throw new HttpError(400, error.message);
    }
    throw error;
  }
}

function toAdminChipCatalog(catalog: ChipCatalog): ChipCatalog {
  return {
    knowledgeBaseRoot: catalog.knowledgeBaseRoot,
    chips: catalog.chips.map((chip) => ({
      ...chip,
      workspaceDir: toAbsoluteWorkspaceDir(catalog, chip.workspaceDir)
    }))
  };
}

async function toAdminChipCatalogWithWorkspaceStatus(catalog: ChipCatalog): Promise<Record<string, unknown>> {
  const adminCatalog = toAdminChipCatalog(catalog);
  const chips = await Promise.all(adminCatalog.chips.map(async (chip) => {
    const status = await readWorkspaceStatus(chip.workspaceDir);
    return {
      ...chip,
      workspaceExists: status.exists,
      workspaceStatus: status.status
    };
  }));
  return { ...adminCatalog, chips };
}

async function readWorkspaceStatus(workspaceDir: string): Promise<{ exists: boolean; status: 'exists' | 'missing' | 'not_directory' }> {
  try {
    const stats = await stat(workspaceDir);
    if (stats.isDirectory()) return { exists: true, status: 'exists' };
    return { exists: false, status: 'not_directory' };
  } catch {
    return { exists: false, status: 'missing' };
  }
}

function toAbsoluteWorkspaceDir(catalog: ChipCatalog, workspaceDir: string): string {
  if (isConfiguredAbsolutePath(workspaceDir)) {
    return path.resolve(workspaceDir);
  }
  return path.resolve(catalog.knowledgeBaseRoot, workspaceDir);
}

/**
 * 按位置比对当前已加载目录与待保存目录，检测「既有 chip 被改名」。
 *
 * 改名的判定条件（三者同时满足）：
 *  1. 目录长度未变（典型「逐行编辑」保存：每个既有行原样回写，仅个别 id 被改）；
 *  2. 位置 i 上当前 id 与待保存 id 不同；
 *  3. 当前 id 不再出现在待保存目录任何位置（确实「消失」而非位置挪动）。
 *
 * 长度变化（整表删除/新增、批量替换）不按改名处理——前端的「逐行可编辑 + chipId 只读」
 * 才是改名的真实入口，本服务端守卫拦的是那条路径；整表替换属删+建，另有用途。
 */
function detectRenamedChipIds(
  currentChips: ReadonlyArray<{ id: string }>,
  nextChips: ReadonlyArray<{ id: string }>
): Array<{ from: string; to: string }> {
  if (currentChips.length !== nextChips.length) {
    return [];
  }
  const nextIds = new Set(nextChips.map((chip) => chip.id));
  const renamed: Array<{ from: string; to: string }> = [];
  for (let i = 0; i < currentChips.length; i += 1) {
    const current = currentChips[i];
    const next = nextChips[i];
    if (current.id !== next.id && !nextIds.has(current.id)) {
      renamed.push({ from: current.id, to: next.id });
    }
  }
  return renamed;
}

/**
 * V13：判定 PUT /admin/chips 的这次保存是否属于「结构性变更」——
 * 新增/删除 chip，或 knowledgeBaseRoot / 既有 chip 的 workspaceDir（均已在保存前
 * 规范化为绝对路径）发生变化。这些是物理工作区层面的改动，热替换运行时 catalog
 * 有风险（正在运行的会话可能仍持有旧工作区句柄），故仍需重启才生效。
 *
 * 除此之外的字段差异（brand/productLines/applicationTags/documentIds/summary/
 * label/description/queryHint 等纯元数据）视为「纯元数据变更」，可安全热替换。
 */
function isStructuralChipCatalogChange(currentCatalog: ChipCatalog, nextCatalog: ChipCatalog): boolean {
  if (currentCatalog.knowledgeBaseRoot !== nextCatalog.knowledgeBaseRoot) {
    return true;
  }
  if (currentCatalog.chips.length !== nextCatalog.chips.length) {
    return true;
  }
  const currentById = new Map(currentCatalog.chips.map((chip) => [chip.id, chip]));
  for (const nextChip of nextCatalog.chips) {
    const currentChip = currentById.get(nextChip.id);
    if (!currentChip) {
      // 新增 chip id（与既有目录无重叠）。
      return true;
    }
    if (currentChip.workspaceDir !== nextChip.workspaceDir) {
      return true;
    }
  }
  return false;
}

/**
 * 由芯片目录内容算出稳定的 ETag（内容哈希，带引号符合 HTTP ETag 语法）。
 * 同一目录内容恒得同一 ETag，内容一变 ETag 即变，用于保存并发守卫。
 */
function computeChipCatalogEtag(catalog: ChipCatalog): string {
  const serialized = JSON.stringify({
    knowledgeBaseRoot: catalog.knowledgeBaseRoot,
    chips: catalog.chips
  });
  const hash = crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

/**
 * 取芯片运行时当前应回传/校验的 ETag：优先用上次保存刷新的 catalogEtag，
 * 否则按当前已加载的运行时目录现算（首次 GET 尚未保存过时）。
 */
function currentChipCatalogEtag(chips: ChipRuntime): string {
  return chips.catalogEtag ?? computeChipCatalogEtag(toAdminChipCatalog(chips.catalog));
}

/**
 * 解析 PUT /admin/chips body 里可选的 deletedIds（被删芯片 id 列表），用于级联清理孤儿授权。
 * 非数组、非字符串项一律忽略，去重后返回；缺省 → 空数组（不做任何清理）。
 */
function parseDeletedChipIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = value.filter((id): id is string => typeof id === 'string' && id.trim() !== '');
  return [...new Set(ids)];
}

/**
 * 已抽取的 datasheet 元数据草稿（数据孵化入库 POST /admin/chips/ingest 的请求体形态）。
 * chipId 必填；其余字段均可选——既有 chip 仅合并草稿提供的字段，新 chip 需带 label + workspaceDir。
 */
interface ChipIngestDraft {
  chipId: string;
  label?: string;
  brand?: string;
  productLines?: string[];
  summary?: string;
  applicationTags?: string[];
  workspaceDir?: string;
}

function normalizeIngestStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item, index, all) => item !== '' && all.indexOf(item) === index);
  return items;
}

function normalizeIngestString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 解析并校验 POST /admin/chips/ingest 请求体为 ChipIngestDraft。
 * chipId 缺失/空 → 400；列表字段过滤空项；其余非法类型一律忽略为缺省。
 */
function parseChipIngestDraft(value: Record<string, unknown>): ChipIngestDraft {
  const chipId = normalizeIngestString(value.chipId);
  if (!chipId) {
    throw new HttpError(400, 'chipId is required to ingest datasheet metadata');
  }
  return {
    chipId,
    label: normalizeIngestString(value.label),
    brand: normalizeIngestString(value.brand),
    productLines: normalizeIngestStringList(value.productLines),
    summary: normalizeIngestString(value.summary),
    applicationTags: normalizeIngestStringList(value.applicationTags),
    workspaceDir: normalizeIngestString(value.workspaceDir)
  };
}

/**
 * 把草稿并入当前芯片目录，产出新的（未持久化、未规范化的）目录对象。
 * 既有 chipId → 仅覆盖草稿提供的字段，其它字段与其它芯片原样保留；
 * 新 chipId → 插入新条目（需草稿带 label 与 workspaceDir，否则 400）。
 * 不在此做 workspaceDir 存在性校验（交给 normalizeAdminChipCatalogForSave 统一处理）。
 */
function mergeChipDraftIntoCatalog(catalog: ChipCatalog, draft: ChipIngestDraft): ChipCatalog {
  const index = catalog.chips.findIndex((chip) => chip.id === draft.chipId);
  const overrides: Partial<ChipCatalog['chips'][number]> = {};
  if (draft.label !== undefined) overrides.label = draft.label;
  if (draft.brand !== undefined) overrides.brand = draft.brand;
  if (draft.productLines !== undefined) overrides.productLines = draft.productLines;
  if (draft.summary !== undefined) overrides.summary = draft.summary;
  if (draft.applicationTags !== undefined) overrides.applicationTags = draft.applicationTags;
  if (draft.workspaceDir !== undefined) overrides.workspaceDir = draft.workspaceDir;

  if (index >= 0) {
    const next = catalog.chips.map((chip, i) => (i === index ? { ...chip, ...overrides } : chip));
    return { knowledgeBaseRoot: catalog.knowledgeBaseRoot, chips: next };
  }

  if (!draft.label) {
    throw new HttpError(400, `A new chip '${draft.chipId}' requires a label to be ingested.`);
  }
  if (!draft.workspaceDir) {
    throw new HttpError(400, `A new chip '${draft.chipId}' requires an absolute workspaceDir to be ingested.`);
  }
  const created = {
    id: draft.chipId,
    label: draft.label,
    workspaceDir: draft.workspaceDir,
    ...overrides
  } as ChipCatalog['chips'][number];
  return { knowledgeBaseRoot: catalog.knowledgeBaseRoot, chips: [...catalog.chips, created] };
}

/**
 * V3 删除芯片授权级联清理：单一共享函数，供 HTTP（及未来 MCP admin）复用。deletedIds 非空时，
 * 从 users.json 的 resourceGrants.chipIds（含每个 user 各把 MCP key 的 grants）、roles.json 的
 * access.allowedChips/access.grants.chipIds、resource-visibility.json 的 document/scopePreset
 * chipIds 引用中剔除这些 chipId，返回真实聚合计数。历史 session/debug 审计与 prompt 文件不在
 * 本函数触及范围内（用户明确保留，不属本次清理对象）。
 */
async function summarizeDeletedChipGrants(
  deletedIds: string[],
  auth: AuthRuntime | null,
  resources: ResourceRuntime | null
): Promise<{ removedGrants: number; affectedUsers: number }> {
  if (deletedIds.length === 0) {
    return { removedGrants: 0, affectedUsers: 0 };
  }

  let removedGrants = 0;
  let affectedUsers = 0;

  if (auth) {
    const userCleanup = await auth.userStore.removeChipGrantsForDeletedChips(deletedIds);
    removedGrants += userCleanup.removedGrants;
    affectedUsers += userCleanup.affectedUsers;

    if (auth.rolesService) {
      const roleCleanup = await auth.rolesService.removeChipIdsFromAllRoles(deletedIds);
      removedGrants += roleCleanup.affectedRoles;
    }
  }

  if (resources) {
    const { catalog: nextCatalog, affectedEntries } = removeChipIdsFromResourceCatalog(resources.catalog, deletedIds);
    if (affectedEntries > 0) {
      await persistResourceCatalog(resources, nextCatalog);
      removedGrants += affectedEntries;
    }
  }

  return { removedGrants, affectedUsers };
}

async function normalizeAdminChipCatalogForSave(catalog: ChipCatalog): Promise<ChipCatalog> {
  const chips: ChipCatalog['chips'] = [];
  for (const chip of catalog.chips) {
    if (!isConfiguredAbsolutePath(chip.workspaceDir)) {
      throw new HttpError(400, `workspaceDir must be an absolute path for chip '${chip.id}'`);
    }

    let realWorkspace: string;
    try {
      realWorkspace = await realpath(chip.workspaceDir);
    } catch {
      throw new HttpError(400, `workspaceDir does not exist for chip '${chip.id}': ${chip.workspaceDir}`);
    }

    const stats = await stat(realWorkspace);
    if (!stats.isDirectory()) {
      throw new HttpError(400, `workspaceDir must be a directory for chip '${chip.id}': ${chip.workspaceDir}`);
    }

    chips.push({ ...chip, workspaceDir: realWorkspace });
  }

  return { knowledgeBaseRoot: catalog.knowledgeBaseRoot, chips };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function chipCatalogSaveErrorMessage(filePath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (isNodeError(error) && (error.code === 'EACCES' || error.code === 'EPERM')) {
    return `Cannot save chip catalog: config file is not writable by AgentX service (${filePath}).`;
  }
  return `Cannot save chip catalog (${filePath}): ${detail}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

async function readJsonObject(request: IncomingMessage, maxBodyBytes?: number): Promise<Record<string, unknown>> {
  const value = await readJsonBody(request, maxBodyBytes);
  if (!isRecord(value)) {
    throw new HttpError(400, 'Expected JSON object');
  }

  return value;
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes?: number): Promise<unknown> {
  const body = await readBody(request, maxBodyBytes);
  if (body.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function readBody(request: IncomingMessage, maxBodyBytes = DEFAULT_MCP_HTTP_BODY_BYTES): Promise<string> {
  let body = '';

  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
      throw new HttpError(413, 'Request body too large');
    }
  }

  return body;
}

function matchSessionRoute(
  pathname: string,
  child?: 'log' | 'send' | 'stream' | 'history'
): { sessionId: string } | undefined {
  const expression =
    child === undefined
      ? /^\/sessions\/([^/]+)$/
      : new RegExp(`^/sessions/([^/]+)/${child}$`);
  const match = expression.exec(pathname);
  if (!match) {
    return undefined;
  }

  return { sessionId: decodeURIComponent(match[1] ?? '') };
}

async function tryServeStaticAsset(
  pathname: string,
  searchParams: URLSearchParams,
  response: ServerResponse,
  publicDir: string,
  productConfig: ProductConfig
): Promise<boolean> {
  const route = getStaticAssetRoute(pathname, productConfig);
  if (route?.redirectTo) {
    response.statusCode = 302;
    response.setHeader('Location', route.redirectTo);
    response.end();
    return true;
  }

  const requestedPath = route?.filePath;
  if (!requestedPath) {
    return false;
  }

  const resolvedPublicDir = path.resolve(publicDir);
  const resolvedFile = path.resolve(resolvedPublicDir, requestedPath);
  if (!isPathInside(resolvedFile, resolvedPublicDir)) {
    sendJson(response, 404, { error: 'Not found' });
    return true;
  }

  try {
    const contents = await readFile(resolvedFile);
    response.statusCode = 200;
    response.setHeader('Content-Type', STATIC_CONTENT_TYPES[path.extname(resolvedFile)] ?? 'application/octet-stream');
    setStaticCacheHeaders(response, requestedPath, searchParams);
    response.end(contents);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }

  return true;
}

function setStaticCacheHeaders(response: ServerResponse, filePath: string, searchParams: URLSearchParams): void {
  const ext = path.extname(filePath);
  if (ext === '.html') {
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.setHeader('Pragma', 'no-cache');
    return;
  }

  if (ext !== '.css' && ext !== '.js') {
    return;
  }

  const assetVersion = searchParams.get('v');
  if (assetVersion && /^[A-Za-z0-9._-]{1,32}$/.test(assetVersion)) {
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }

  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
}

function getStaticAssetRoute(
  pathname: string,
  productConfig: ProductConfig
): { filePath?: string; redirectTo?: string } | undefined {
  if (pathname === '/' || pathname === '/index.html') {
    return { redirectTo: '/home' };
  }

  if (pathname === '/home' || pathname === '/home.html') {
    if (productConfig.landingMode === 'disabled') {
      return { redirectTo: '/login' };
    }
    return { filePath: 'index.html' };
  }

  if (pathname === '/login') {
    return { filePath: 'login.html' };
  }

  if (pathname === '/mcp-access' || pathname === '/mcp-access.html' || pathname === '/mcp-client' || pathname === '/mcp-client.html') {
    return { filePath: 'mcp-access.html' };
  }

  if (pathname === '/tickets' || pathname === '/tickets.html' || pathname === '/ticket-system') {
    return { filePath: 'tickets.html' };
  }

  if (pathname === '/feedback' || pathname === '/feedback.html') {
    return { filePath: 'feedback.html' };
  }

  if (pathname === '/datasheet-submit' || pathname === '/datasheet-submit.html') {
    return { filePath: 'datasheet-submit.html' };
  }

  if (pathname === '/updates' || pathname === '/updates.html') {
    return { filePath: 'updates.html' };
  }

  if (pathname === '/join-application' || pathname === '/join-application.html') {
    return { filePath: 'join-application.html' };
  }

  if (pathname === '/donation-support' || pathname === '/donation-support.html') {
    return { filePath: 'donation-support.html' };
  }

  if (pathname === '/account' || pathname === '/account.html') {
    return { filePath: 'account.html' };
  }

  if (MCP_TEMPLATE_ASSET_ROUTES.has(pathname)) {
    return { filePath: pathname.slice(1) };
  }

  if (DOWNLOAD_ASSET_ROUTES.has(pathname)) {
    return { filePath: pathname.slice(1) };
  }

  if (pathname.startsWith('/assets/') && !pathname.includes('..')) {
    return { filePath: pathname.slice(1) };
  }

  if (
    pathname === '/styles.css' ||
    pathname === '/auth.js' ||
    pathname === '/chat.js' ||
    pathname === '/admin.js' ||
    pathname === '/account.js' ||
    pathname === '/ui-kit.js' ||
    pathname === '/announcements.js' ||
    pathname === '/i18n.js' ||
    pathname === '/mcp-access.js' ||
    pathname === '/updates.js' ||
    pathname === '/tickets.js' ||
    pathname === '/product-shell.js'
  ) {
    return { filePath: pathname.slice(1) };
  }

  if (pathname === '/chat') {
    return { filePath: 'chat.html' };
  }

  if (pathname === '/admin' || pathname === '/admin/' || ADMIN_SECTION_PAGE_ROUTES.has(pathname)) {
    return { filePath: 'admin.html' };
  }

  return undefined;
}

function isUnknownAdminSectionPageRoute(pathname: string): boolean {
  return (pathname === '/admin/sections' || pathname.startsWith('/admin/sections/')) && !ADMIN_SECTION_PAGE_ROUTES.has(pathname);
}

function validatePromptPath(promptsDir: string, filePath: string): string {
  const resolved = path.resolve(promptsDir, filePath);
  if (!isPathInside(resolved, promptsDir)) {
    throw new HttpError(403, 'Path traversal detected');
  }
  return resolved;
}

function promptHistoryActor(request: AuthenticatedRequest): PromptHistoryActor {
  return {
    userId: request.user?.userId ?? '',
    username: request.user?.username ?? '',
    role: request.user?.role ?? ''
  };
}

async function writePromptFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, content, 'utf-8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

interface PromptFileInfo {
  path: string;
  name: string;
  type: 'global' | 'role' | 'chip';
  exists?: boolean;
}

async function listPromptFiles(promptsDir: string, chipCatalog?: ChipCatalog): Promise<PromptFileInfo[]> {
  const files: PromptFileInfo[] = [];
  const { readdir, stat } = await import('node:fs/promises');

  async function walk(dir: string, prefix = ''): Promise<void> {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        const relPath = prefix ? `${prefix}/${entry}` : entry;
        try {
          const stats = await stat(fullPath);
          if (stats.isDirectory()) {
            await walk(fullPath, relPath);
          } else if (entry.endsWith('.md')) {
            files.push({
              path: relPath,
              name: entry.replace('.md', ''),
              type: getPromptFileType(relPath),
              exists: true
            });
          }
        } catch {
          // Skip inaccessible entries
        }
      }
    } catch {
      // Directory doesn't exist or is inaccessible
    }
  }

  await walk(promptsDir);
  const knownPaths = new Set(files.map((file) => file.path));
  for (const chip of chipCatalog?.chips ?? []) {
    const chipPromptPath = `chips/${chip.id}.md`;
    if (!knownPaths.has(chipPromptPath)) {
      files.push({
        path: chipPromptPath,
        name: chip.id,
        type: 'chip',
        exists: false
      });
    }
  }
  return files;
}

function getPromptFileType(relPath: string): 'global' | 'role' | 'chip' {
  if (relPath === 'global.md') return 'global';
  if (relPath.startsWith('roles/')) return 'role';
  if (relPath.startsWith('chips/')) return 'chip';
  return 'global';
}

function isPathInside(candidatePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isKnownChipPromptPath(catalog: ChipCatalog | undefined, filePath: string): boolean {
  return Boolean(catalog?.chips.some((chip) => filePath === `chips/${chip.id}.md`));
}

function defaultChipPromptContent(filePath: string): string {
  const chipId = path.basename(filePath, '.md');
  return [
    `# ${chipId} Chip Prompt`,
    '',
    `You are a specialized assistant for the ${chipId} chip platform.`,
    '',
    '## Knowledge Base',
    '- Use the chip documentation in the configured workspace for accurate information.',
    '',
    '## When Answering Questions',
    '- First check relevant documentation files.',
    '- Provide specific references when possible.',
    ''
  ].join('\n');
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isActionName(value: unknown): value is ActionName {
  return typeof value === 'string' && Object.hasOwn(AgentActionSchemas, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function applyCors(request: IncomingMessage, response: ServerResponse, mcpHttpSecurity: McpHttpSecurityConfig): boolean {
  const origin = Array.isArray(request.headers.origin) ? request.headers.origin[0] : request.headers.origin;
  if (isSameOriginRequest(origin, request.headers.host)) {
    return true;
  }

  if (!isCorsOriginAllowed(origin, mcpHttpSecurity)) {
    return false;
  }

  const allowedOrigin = getAllowedCorsOrigin(origin, mcpHttpSecurity);
  if (allowedOrigin) {
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID'
  );
  response.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  return true;
}

function isSameOriginRequest(origin: string | undefined, host: string | string[] | undefined): boolean {
  if (!origin || !host) {
    return false;
  }

  const requestHost = Array.isArray(host) ? host[0] : host;
  if (!requestHost) {
    return false;
  }

  try {
    return new URL(origin).host === requestHost;
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

// V9：admin 只读接口统一防缓存。单一事实源——凡是 admin 侧读取跨用户数据（会话历史、
// 问题账本、观测指标、discovery trace）的响应，都必须经这个包装，禁止各处再散落设置
// Cache-Control 头（历史上只有 debug 接口手动设置，其余 5 个接口裸调 sendJson，浏览器/
// 中间层缓存可能把 admin-only 数据留在磁盘/共享缓存里）。
function sendJsonNoStore(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.setHeader('Pragma', 'no-cache');
  sendJson(response, statusCode, payload);
}

function handleHttpError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy(error instanceof Error ? error : undefined);
    return;
  }

  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {})
    });
    return;
  }

  if (error instanceof TicketNotFoundError) {
    sendJson(response, error.statusCode, { error: 'Ticket not found' });
    return;
  }

  if (error instanceof UnsafeTicketNoError || error instanceof TicketValidationError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof TicketAttachmentUploadError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof AuthRouteError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof RolesServiceError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof ChipNotFoundError || error instanceof ChipWorkspaceError) {
    sendJson(response, error.statusCode, { error: error.message });
    return;
  }

  if (error instanceof ZodError) {
    sendJson(response, 400, { error: formatZodError(error) });
    return;
  }

  if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number') {
    sendJson(response, error.statusCode, {
      error: error.message,
      ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
      ...('details' in error && isRecord(error.details) ? { details: error.details } : {})
    });
    return;
  }

  sendJson(response, 500, { error: 'Internal server error' });
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}
