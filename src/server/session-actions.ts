import crypto from 'node:crypto';
import { z } from 'zod';
import { SessionBusyError, type SessionManager } from '../session-manager.js';
import type { PersistenceRuntime, QuestionSource, SessionSource } from '../persistence/index.js';
import type { ModelId } from '../model-catalog.js';
import type { ClaudeModelRole, ModeRoleMapping } from '../model-routing.js';
import { appendSourceCitationPromptGuardrails } from '../prompts/index.js';
import type { LocalePreference, PublicUserCredits } from '../auth/types.js';
import { projectAssistantOutput } from './assistant-output-protocol.js';
import { ContextBudgetExceededError, assertContextBudget } from '../context-budget.js';
import type { SafeScopeSessionSummary } from '../scope/index.js';
import { isDynamicScopePresetId } from '../scope/index.js';
import { filterWholeWorkspaceAuthorizedChipIds } from '../scope/document-chip-map.js';
import type { SourceCitationSummary, UsedSourceRecord } from '../source-citations/index.js';
import { createSourceCitationSummary, createUsedSourceRecord } from '../source-citations/index.js';
import {
  containsChatImageInput,
  resolveSearchModeSelection,
  sourceToSearchModeEntryPoint,
  type SearchModeDisabledReasonCode,
  type SearchModeId
} from '../search-modes.js';
import {
  authorizeResourceAccess,
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  findDocumentContract,
  findScopePresetContract,
  type EffectiveAuthorizationSummary,
  type ResourceVisibilityCatalog
} from '../security/index.js';

// Public AgentX actions currently expose only the hardened claude-code path.
// Legacy adapters remain in the codebase for future work, but must not be
// reachable through HTTP, RPC, or MCP because they do not apply the same
// allowedTools/denyReadRoots isolation contract.
const AgentTypeSchema = z.literal('claude-code');
const SessionModeSchema = z.enum(['oneshot', 'conversation']);
const ChatModeSchema = z.enum(['standard', 'enhanced', 'multimodal']);

export const AgentActionSchemas = {
  agent_spawn: z.object({
    agentType: AgentTypeSchema,
    task: z.string().min(1),
    /** Trusted display copy of task when task itself was rewritten to local image paths. */
    displayTask: z.string().min(1).optional(),
    cwd: z.string().optional(),
    cols: z.coerce.number().int().positive().optional(),
    rows: z.coerce.number().int().positive().optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.coerce.number().int().positive().optional(),
    noOutputTimeoutMs: z.coerce.number().int().positive().optional(),
    sessionMode: SessionModeSchema.optional(),
    chatMode: ChatModeSchema.optional(),
    model: z.string().min(1).optional(),
    chipId: z.string().min(1).optional(),
    documentId: z.string().min(1).optional(),
    scopePresetId: z.string().min(1).optional(),
    // 动态 scope（scopePresetId 为 dynamic-group/dynamic-global）会话在
    // spawn 时实际授权到的 chip 列表；供后续 log/poll/send/kill 复验逐个核对撤权
    // （见 assertSessionStillAuthorized 的 dynamic scope 分支）。
    allowedChipIds: z.array(z.string()).optional(),
    allowedDocumentIds: z.array(z.string()).optional(),
    scopeWorkspace: z.custom<SafeScopeSessionSummary>().optional(),
    usedSources: z.custom<UsedSourceRecord[]>().optional(),
    sourceCitationSummary: z.custom<SourceCitationSummary>().optional(),
    scopeWorkspaceCleanup: z.custom<() => Promise<void>>().optional(),
    systemPrompt: z.string().optional(),
    denyReadRoots: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    permissionMode: z.enum(['default', 'acceptEdits', 'plan']).optional(),
    // 动态 scope 描述符（C2）：WebChat 端通过此字段传递 group / global 范围请求。
    // agent_spawn 本身不消费该字段（http-server.ts 在 parse 之前已提取），此处声明以
    // 避免 .strict() 校验拒绝携带该字段的 body。
    scope: z.object({
      mode: z.enum(['single', 'group', 'global']),
      chipId: z.string().min(1).optional(),
      groups: z.array(
        z.object({
          dimension: z.enum(['productLine', 'brand', 'application']),
          value: z.string().min(1)
        })
      ).optional()
    }).optional()
  }).strict(),
  agent_log: z.object({
    sessionId: z.string().min(1),
    offset: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().optional(),
    tail: z.coerce.number().int().positive().optional()
  }),
  agent_send: z.object({
    sessionId: z.string().min(1),
    data: z.string(),
    displayData: z.string().optional(),
    submit: z.boolean().optional()
  }).strict(),
  agent_poll: z.object({
    sessionId: z.string().min(1),
    timeoutMs: z.coerce.number().int().nonnegative().default(5000)
  }),
  agent_kill: z.object({
    sessionId: z.string().min(1)
  }),
  agent_list: z.object({})
} as const;

type AgentSpawnInput = z.infer<typeof AgentActionSchemas.agent_spawn>;
type AgentLogInput = z.infer<typeof AgentActionSchemas.agent_log>;
type AgentSendInput = z.infer<typeof AgentActionSchemas.agent_send>;
type AgentPollInput = z.input<typeof AgentActionSchemas.agent_poll>;
type AgentKillInput = z.infer<typeof AgentActionSchemas.agent_kill>;
type AgentListInput = z.infer<typeof AgentActionSchemas.agent_list>;

export interface SessionActionOptions {
  scopeUserId?: string;
  persistence?: PersistenceRuntime;
  source?: SessionSource & QuestionSource;
  userSnapshot?: {
    id?: string;
    userId?: string;
    username?: string;
    role?: string;
    authorizedModels?: ModelId[];
    credits?: PublicUserCredits;
  };
  mcpKeyFingerprint?: string;
  modeRoleMapping?: ModeRoleMapping;
  /**
   * Provider-controlled WebChat response locale. This is deliberately absent
   * from the public action schemas so RPC, MCP, and CLI callers cannot inject
   * hidden turn instructions.
   */
  responseLocale?: LocalePreference;
  creditReservations?: {
    reserve(userId: string, units: number): Promise<{
      reservationId: string;
      balanceBeforeUnits: number;
      balanceAfterUnits: number;
    }>;
    commit?(reservationId: string): Promise<void>;
    release(reservationId: string): Promise<void>;
  };
  /**
   * V2（会话撤权后复验）：可选的授权摘要提供者。每次调用 log/poll/send/kill 时都会
   * 当场重新调用一次（不缓存），用于把该会话创建时校验过的 chipId/documentId/
   * scopePresetId/modelId 对照"此刻真实生效"的授权重新过一遍。不传则不复验，
   * 保持 v1.0 行为向后兼容（stdio MCP 当前未接线 chips/resources 运行时，天然落到此分支）。
   */
  getAuthorizationSummary?: () => Promise<EffectiveAuthorizationSummary | undefined> | EffectiveAuthorizationSummary | undefined;
  /**
   * 文档/scope 预设的可见性判定需要目录本身（status 是否 approved 等），目录在内存中
   * 随 admin 编辑同步更新，因此这里用同步 getter 现取即可，不需要异步刷新。
   */
  resourceCatalog?: () => ResourceVisibilityCatalog | null | undefined;
}

export type SessionModelRoutingErrorCode =
  | SearchModeDisabledReasonCode
  | 'MODEL_DISABLED'
  | 'MODEL_NOT_AUTHORIZED'
  | 'INSUFFICIENT_CREDITS';

export class SessionModelRoutingError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: SessionModelRoutingErrorCode,
    message: string,
    readonly details: Record<string, unknown>
  ) {
    super(message);
  }
}

export class SessionScopeError extends Error {
  readonly statusCode = 404;

  constructor(message = 'Session not found') {
    super(message);
  }
}

// V2：会话在创建之后被撤权（chip/document/scopePreset/model 任一维度）时，log/poll/send/kill
// 一律拒绝（读写都拒），但不主动强杀正在跑的进程——由既有无输出超时回收。403 而非 404：
// 会话归属仍是本用户的，只是权限已收回，与跨用户 404（资源"看不见"）语义不同。
export class SessionAuthorizationRevokedError extends Error {
  readonly statusCode = 403;

  constructor(message = 'Access to this session has been revoked.') {
    super(message);
  }
}

/**
 * 动态 scope 会话（scopePresetId 为 dynamic-group / dynamic-global，见
 * scope/scope-options.ts 的 isDynamicScopePresetId）的撤权复验单一事实源。
 *
 * 目录里没有这种合成 scopePresetId 对应的真实契约，所以不走
 * findScopePresetContract + evaluateScopePresetVisibility 那条路径——而是逐个核对
 * 该会话 spawn 时实际解析出的 chip 列表（session.allowedChipIds），复用与单芯片会话
 * 完全相同的 authorizeResourceAccess({type:'chip', id}) 判定。任何一个 chip 不再被
 * 授权就判撤权；chip 列表本身为空/缺失也判撤权（不可能出现"动态范围但一个 chip
 * 都没有"的合法会话，缺列表大概率意味着数据丢失，不能默认放行）。
 *
 * HTTP（session-actions.ts 内部）与 Remote MCP（http-server.ts 的
 * assertCurrentMcpToolAndSession）都调用这同一个函数，不 fork 第二套判定。
 */
export function assertDynamicScopeChipsStillAuthorized(
  summary: EffectiveAuthorizationSummary,
  allowedChipIds: string[] | undefined
): void {
  if (!allowedChipIds || allowedChipIds.length === 0) {
    throw new SessionAuthorizationRevokedError();
  }
  for (const chipId of allowedChipIds) {
    const decision = authorizeResourceAccess(summary, { type: 'chip', id: chipId });
    if (!decision.allowed) {
      throw new SessionAuthorizationRevokedError();
    }
  }
}

/**
 * Revalidate the exact resource snapshot behind a physical scope workspace.
 * Because files are copied at chip-workspace granularity, every catalog
 * document currently registered to each chip must still be part of the saved
 * document snapshot and remain visible under the current grants/status.
 */
export function assertScopeWorkspaceStillAuthorized(
  summary: EffectiveAuthorizationSummary,
  catalog: ResourceVisibilityCatalog | null | undefined,
  allowedChipIds: string[] | undefined,
  allowedDocumentIds: string[] | undefined
): void {
  assertDynamicScopeChipsStillAuthorized(summary, allowedChipIds);
  const documentIds = allowedDocumentIds ?? [];
  for (const documentId of documentIds) {
    const document = findDocumentContract(catalog, documentId);
    if (!document || !evaluateDocumentVisibility(summary, document).allowed) {
      throw new SessionAuthorizationRevokedError();
    }
  }
  const copyableChipIds = filterWholeWorkspaceAuthorizedChipIds(catalog, allowedChipIds ?? [], documentIds);
  if (copyableChipIds.length !== (allowedChipIds?.length ?? 0)) {
    throw new SessionAuthorizationRevokedError();
  }
}

// P2-1 (multi-agent audit): public counterpart of the private
// assertSessionStillAuthorized inside createSessionActions. Exposed for callers
// that need to re-check authorization outside of an action context — currently
// the SSE stream handler in http-server.ts, which must close the stream when
// grants are revoked mid-session.
//
// Returns true while the user identified by `summary` is still allowed to see
// the given session's outputs; returns false once any of (chip, document,
// scopePreset, model) has been revoked. Never throws — translates
// SessionAuthorizationRevokedError into false so the SSE close path can stay
// straight-line.
export interface SessionAuthorizationSnapshot {
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  allowedChipIds?: string[];
  allowedDocumentIds?: string[];
  scopeDescriptor?: { mode?: string };
  scopeWorkspace?: unknown;
  modelId?: string;
}

export function isSessionAuthorizationSnapshotCurrent(
  session: SessionAuthorizationSnapshot,
  summary: EffectiveAuthorizationSummary,
  catalog: ResourceVisibilityCatalog | null
): boolean {
  if (!summary.usable) {
    return false;
  }
  try {
    if (session.chipId) {
      const decision = authorizeResourceAccess(summary, { type: 'chip', id: session.chipId });
      if (!decision.allowed) {
        return false;
      }
    }
    if (session.documentId) {
      const document = findDocumentContract(catalog, session.documentId);
      const decision = document
        ? evaluateDocumentVisibility(summary, document)
        : authorizeResourceAccess(summary, { type: 'document', id: session.documentId, visibility: 'adminOnly' });
      if (!decision.allowed) {
        return false;
      }
    }
    const hasWorkspaceSnapshot = Boolean(
      session.allowedChipIds ||
      session.scopeWorkspace ||
      session.scopeDescriptor?.mode === 'group' ||
      session.scopeDescriptor?.mode === 'global'
    );
    if (hasWorkspaceSnapshot) {
      assertScopeWorkspaceStillAuthorized(
        summary,
        catalog,
        session.allowedChipIds,
        session.allowedDocumentIds
      );
    }
    if (session.scopePresetId) {
      if (isDynamicScopePresetId(session.scopePresetId)) {
        assertDynamicScopeChipsStillAuthorized(summary, session.allowedChipIds);
      } else {
        const scopePreset = findScopePresetContract(catalog, session.scopePresetId);
        const decision = scopePreset
          ? evaluateScopePresetVisibility(summary, scopePreset)
          : authorizeResourceAccess(summary, { type: 'scopePreset', id: session.scopePresetId, visibility: 'adminOnly' });
        if (!decision.allowed) {
          return false;
        }
      }
    }
    if (session.modelId) {
      const decision = authorizeResourceAccess(summary, { type: 'model', id: session.modelId });
      if (!decision.allowed) {
        return false;
      }
    }
    return true;
  } catch (error) {
    if (error instanceof SessionAuthorizationRevokedError) {
      return false;
    }
    throw error;
  }
}

export function assertSessionStillAuthorizedForUser(
  manager: SessionManager,
  sessionId: string,
  summary: EffectiveAuthorizationSummary,
  catalog: ResourceVisibilityCatalog | null
): boolean {
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  if (!session) {
    return false;
  }
  return isSessionAuthorizationSnapshotCurrent(session, summary, catalog);
}

export function createSessionActions(manager: SessionManager, options: SessionActionOptions = {}) {
  const scopeUserId = options.scopeUserId;
  const persistence = options.persistence;
  const source = options.source ?? 'rpc';
  const userId = scopeUserId ?? options.userSnapshot?.userId ?? options.userSnapshot?.id;
  const username = options.userSnapshot?.username;
  const role = options.userSnapshot?.role;
  const userModelGrants = options.userSnapshot?.authorizedModels;
  const creditBalanceUnits = options.userSnapshot?.credits?.balanceUnits;

  function assertSessionInScope(sessionId: string): void {
    if (!scopeUserId) {
      return;
    }

    const session = manager.list().find((candidate) => candidate.id === sessionId);
    if (!session || session.userId !== scopeUserId) {
      throw new SessionScopeError();
    }
  }

  // V2：单一事实源——HTTP（Web REST /log,/stream,/send、/rpc）与 MCP（Remote + stdio）
  // 共用这一份复验，不 fork 第二套。没有配置 getAuthorizationSummary 时完全是 no-op
  // （向后兼容；stdio MCP 当前未接线 chips/resources 运行时，天然落在这条分支）。
  async function assertSessionStillAuthorized(sessionId: string): Promise<void> {
    if (!options.getAuthorizationSummary) {
      return;
    }
    const summary = await options.getAuthorizationSummary();
    if (!summary) {
      return;
    }
    const catalog = options.resourceCatalog?.() ?? null;
    if (!assertSessionStillAuthorizedForUser(manager, sessionId, summary, catalog)) {
      throw new SessionAuthorizationRevokedError();
    }
  }

  return {
    async agent_spawn(input: AgentSpawnInput) {
      let params: z.infer<typeof AgentActionSchemas.agent_spawn>;
      try {
        params = AgentActionSchemas.agent_spawn.parse(input);
      } catch (error) {
        await input.scopeWorkspaceCleanup?.().catch(() => {
          // RPC/MCP wrappers may materialize a trusted scope workspace before
          // shared strict validation. Validation failure must relinquish it.
        });
        throw error;
      }
      const systemPrompt = appendSourceCitationPromptGuardrails(params.systemPrompt);
      const providerTask = withResponseLocaleTurnContext(params.task, options.responseLocale);
      let routing: ReturnType<typeof resolveModelRouting>;
      let budget: ReturnType<typeof assertContextBudget>;
      let creditReservation: Awaited<ReturnType<typeof reserveCreditsForSpawn>> | undefined;
      let session: Awaited<ReturnType<typeof manager.spawn>>;
      try {
        routing = resolveModelRouting(params, {
          userId,
          role,
          userModelGrants,
          creditBalanceUnits,
          source,
          modeRoleMapping: options.modeRoleMapping
        });
        budget = assertContextBudget({
          entry: source,
          role,
          userId,
          modelId: routing.modelId,
          mcpKeyFingerprint: options.mcpKeyFingerprint,
          task: providerTask,
          systemPrompt
        });
        if (budget.exceeded.length > 0) {
          throw new ContextBudgetExceededError(budget);
        }
        creditReservation = userId && options.creditReservations
          ? await reserveCreditsForSpawn(options.creditReservations, userId, routing.creditUnits)
          : undefined;
        const {
          model: _requestedModel,
          displayTask,
          scope: scopeDescriptor,
          usedSources: requestedUsedSources,
          sourceCitationSummary: requestedSourceCitationSummary,
          ...spawnParams
        } = params;
        let trustedUsedSources = spawnParams.scopeWorkspace ? requestedUsedSources : undefined;
        let trustedSourceCitationSummary = spawnParams.scopeWorkspace ? requestedSourceCitationSummary : undefined;
        // F1：单芯片会话（有 chipId、无 scopeWorkspace）由服务端自建一条芯片来源种子，
        // 不信任客户端入参；displayTitle 取 chipId（方案 A：来源胶囊只放芯片名）。
        if (!spawnParams.scopeWorkspace && spawnParams.chipId) {
          const seed = createUsedSourceRecord({
            scopeId: spawnParams.chipId,
            scopePresetId: spawnParams.chipId,
            documentId: spawnParams.chipId,
            displayTitle: spawnParams.chipId,
            chipId: spawnParams.chipId
          });
          if (seed) {
            trustedUsedSources = [seed];
            trustedSourceCitationSummary = createSourceCitationSummary([seed]);
          }
        }
        session = await manager.spawn({
          ...spawnParams,
          task: providerTask,
          userId: scopeUserId,
          chatMode: routing.chatMode,
          modelId: routing.modelId,
          claudeModelRole: routing.claudeModelRole,
          creditUnits: routing.creditUnits,
          creditReservation,
          displayTask: displayTask ?? (options.responseLocale ? params.task : undefined),
          scopeDescriptor,
          usedSources: trustedUsedSources,
          sourceCitationSummary: trustedSourceCitationSummary,
          systemPrompt,
          deferSettlement: Boolean(persistence)
        });
      } catch (error) {
        if (creditReservation) {
          await releaseReservedCredits(options.creditReservations, creditReservation.reservationId).catch(() => {
            // Preserve the original spawn failure.
          });
        }
        await params.scopeWorkspaceCleanup?.().catch(() => {
          // Best-effort cleanup; preserve the original pre-spawn/spawn failure.
        });
        throw error;
      }
      const turnId = createTurnId();
      const persistedCreditReservation = creditReservation
        ? { ...creditReservation, requestId: turnId }
        : undefined;

      if (persistence) {
        try {
          await persistence.recordSessionCreated({
            sessionId: session.id,
            userId,
            username,
            role,
            agentType: session.agentType,
            chipId: session.chipId,
            documentId: session.documentId,
            scopePresetId: session.scopePresetId,
            allowedChipIds: session.allowedChipIds,
            allowedDocumentIds: session.allowedDocumentIds,
            scopeDescriptor: session.scopeDescriptor,
            scopeWorkspace: session.scopeWorkspace,
            usedSources: session.usedSources,
            sourceCitationSummary: session.sourceCitationSummary,
            cwd: session.cwd,
            task: session.displayTask ?? session.task,
            claudeSessionId: session.claudeSessionId,
            sessionMode: session.sessionMode,
            chatMode: session.chatMode,
            modelId: session.modelId,
            claudeModelRole: session.claudeModelRole,
            creditUnits: session.creditUnits,
            creditReservation: persistedCreditReservation,
            turnState: session.turnState,
            turnCount: session.turnCount,
            source
          });
          await persistence.recordUserTurn(session.id, {
            role: 'user',
            turnId,
            text: session.displayTask ?? session.task,
            createdAt: new Date(session.startedAt).toISOString(),
            outputStart: 0,
            chatMode: session.chatMode,
            modelId: session.modelId,
            claudeModelRole: session.claudeModelRole,
            creditUnits: session.creditUnits,
            question: {
              sessionId: session.id,
              turnId,
              userId,
              username,
              role,
              chipId: session.chipId,
              chatMode: session.chatMode,
              modelId: session.modelId,
              claudeModelRole: session.claudeModelRole,
              creditUnits: session.creditUnits,
              source
            }
          });
          await persistence.recordSessionEvent(session.id, {
            event: 'agent_spawn',
            turnId,
            details: {
              source,
              userId,
              username,
              role,
              agentType: session.agentType,
              sessionMode: session.sessionMode,
              chatMode: session.chatMode,
              modelId: session.modelId,
              claudeModelRole: session.claudeModelRole,
              creditUnits: session.creditUnits,
              creditReservation: persistedCreditReservation,
              contextBudget: {
                estimated: budget.estimated,
                estimatedInputTokens: budget.estimatedInputTokens,
                exceeded: budget.exceeded,
                action: budget.action
              },
              chipId: session.chipId,
              documentId: session.documentId,
              scopePresetId: session.scopePresetId,
              allowedChipIds: session.allowedChipIds,
              allowedDocumentIds: session.allowedDocumentIds,
              scopeDescriptor: session.scopeDescriptor,
              scopeWorkspace: session.scopeWorkspace,
              usedSources: session.usedSources,
              sourceCitationSummary: session.sourceCitationSummary
            }
          });
        } catch (error) {
          manager.rejectSessionSettlement?.(session.id);
          if (creditReservation) {
            await clearPersistedCreditReservation(persistence, session.id);
            await releaseReservedCredits(options.creditReservations, creditReservation.reservationId).catch(() => {
              // Preserve the original persistence failure.
            });
          }
          await manager.kill(session.id).catch(() => {
            // Best-effort cleanup; preserve the original persistence failure.
          });
          throw error;
        }
        manager.acceptSessionSettlement?.(session.id);
      }

      return {
        sessionId: session.id,
        userId: session.userId,
        status: session.status,
        agentType: session.agentType,
        cwd: session.cwd,
        task: session.displayTask ?? session.task,
        startedAt: session.startedAt,
        sessionMode: session.sessionMode,
        chatMode: session.chatMode,
        modelId: session.modelId,
        claudeModelRole: session.claudeModelRole,
        creditUnits: session.creditUnits,
        turnState: session.turnState,
        turnCount: session.turnCount,
        claudeSessionId: session.claudeSessionId,
        chipId: session.chipId,
        documentId: session.documentId,
        scopePresetId: session.scopePresetId,
        scopeDescriptor: session.scopeDescriptor,
        scopeWorkspace: session.scopeWorkspace,
        usedSources: session.usedSources,
        sourceCitationSummary: session.sourceCitationSummary
      };
    },

    async agent_log(input: AgentLogInput) {
      const params = AgentActionSchemas.agent_log.parse(input);
      assertSessionInScope(params.sessionId);
      await assertSessionStillAuthorized(params.sessionId);
      const result =
        params.tail !== undefined
          ? manager.tail(params.sessionId, params.tail)
          : manager.log(params.sessionId, params.offset, params.limit);

      const projection = projectAssistantOutput(result.output, {
        allowAssistantFallback: true,
        ...getSessionCitationProjectionOptions(manager, params.sessionId)
      });
      const sessionMeta = getSessionRuntimeMetadata(manager, params.sessionId);
      return {
        sessionId: params.sessionId,
        ...sessionMeta,
        result: projection.text,
        messages: projection.text ? [{ role: 'assistant' as const, text: projection.text }] : [],
        output: projection.text,
        outputMeta: projection.metadata,
        rawOutputExposed: false,
        truncated: result.truncated,
        totalChars: result.totalChars,
        offset: result.offset,
        limit: result.limit
      };
    },

    async agent_send(input: AgentSendInput) {
      const params = AgentActionSchemas.agent_send.parse(input);
      assertSessionInScope(params.sessionId);
      await assertSessionStillAuthorized(params.sessionId);
      const releaseTurnStart = await manager.claimTurnStart(params.sessionId);
      try {
        const session = manager.list().find((candidate) => candidate.id === params.sessionId);
        assertTurnInputAllowed(session?.chatMode, params.displayData ?? params.data);
        if ((await persistence?.sessionStore?.readSessionMeta(params.sessionId))?.creditReservation) {
          throw new SessionBusyError('Previous credit settlement is incomplete');
        }
        const turnId = createTurnId();
        const sendCreditReservation = session?.userId && session.creditUnits && options.creditReservations
          ? await reserveCreditsForSpawn(options.creditReservations, session.userId, session.creditUnits)
          : undefined;
        if (persistence) {
          const text = params.displayData ?? params.data;

          try {
            if (sendCreditReservation) {
              await persistence.sessionStore.updateSessionMeta(params.sessionId, {
                creditReservation: {
                  ...sendCreditReservation,
                  requestId: turnId
                }
              });
            }
            await persistence.recordUserTurn(params.sessionId, {
              role: 'user',
              turnId,
              text,
              createdAt: new Date().toISOString(),
              outputStart: manager.log(params.sessionId).totalChars,
              chatMode: session?.chatMode,
              modelId: session?.modelId,
              claudeModelRole: session?.claudeModelRole,
              creditUnits: session?.creditUnits,
              question: {
                sessionId: params.sessionId,
                turnId,
                userId: session?.userId ?? userId,
                username,
                role,
                chipId: session?.chipId,
                chatMode: session?.chatMode,
                modelId: session?.modelId,
                claudeModelRole: session?.claudeModelRole,
                creditUnits: session?.creditUnits,
                source
              }
            });
          } catch (error) {
            if (sendCreditReservation) {
              await clearPersistedCreditReservation(persistence, params.sessionId);
              await releaseReservedCredits(options.creditReservations, sendCreditReservation.reservationId).catch(() => {
                // Best-effort rollback; the original persistence failure should surface.
              });
            }
            throw error;
          }
        }
        try {
          const providerData = withResponseLocaleTurnContext(params.data, options.responseLocale);
          if (params.submit === false) {
            await manager.send(params.sessionId, providerData);
          } else {
            await manager.submit(params.sessionId, providerData);
          }
        } catch (error) {
          if (sendCreditReservation) {
            if (persistence) {
              await clearPersistedCreditReservation(persistence, params.sessionId);
            }
            await releaseReservedCredits(options.creditReservations, sendCreditReservation.reservationId).catch(() => {
              // Preserve the manager error.
            });
          }
          throw error;
        }
        const sessionAfterSend = manager.list().find((candidate) => candidate.id === params.sessionId);

        return {
          sessionId: params.sessionId,
          sent: true,
          submitted: params.submit !== false,
          status: sessionAfterSend?.status,
          turnState: sessionAfterSend?.turnState,
          turnCount: sessionAfterSend?.turnCount,
          claudeSessionId: sessionAfterSend?.claudeSessionId,
          modelId: sessionAfterSend?.modelId,
          claudeModelRole: sessionAfterSend?.claudeModelRole,
          chatMode: sessionAfterSend?.chatMode,
          creditUnits: sessionAfterSend?.creditUnits
        };
      } finally {
        releaseTurnStart();
      }
    },

    async agent_poll(input: AgentPollInput) {
      const params = AgentActionSchemas.agent_poll.parse(input);
      assertSessionInScope(params.sessionId);
      await assertSessionStillAuthorized(params.sessionId);
      const result = await manager.poll(params.sessionId, params.timeoutMs);
      const projection = result.exited
        ? projectAssistantOutput(manager.log(params.sessionId).output, {
            allowAssistantFallback: true,
            ...getSessionCitationProjectionOptions(manager, params.sessionId)
          })
        : undefined;
      const sessionMeta = getSessionRuntimeMetadata(manager, params.sessionId);

      return {
        sessionId: params.sessionId,
        ...sessionMeta,
        hasOutput: result.hasOutput,
        exited: result.exited,
        exitCode: result.exitCode,
        ...(projection
          ? {
              result: projection.text,
              messages: projection.text ? [{ role: 'assistant' as const, text: projection.text }] : [],
              output: projection.text,
              outputMeta: projection.metadata,
              rawOutputExposed: false
            }
          : {})
      };
    },

    async agent_kill(input: AgentKillInput) {
      const params = AgentActionSchemas.agent_kill.parse(input);
      assertSessionInScope(params.sessionId);
      await assertSessionStillAuthorized(params.sessionId);
      persistence?.recordSessionEvent(params.sessionId, {
        event: 'agent_kill',
        details: {
          source,
          userId,
          username,
          role
        }
      }).catch(() => {
        // Preserve fire-and-forget kill semantics even if event persistence fails.
      });
      // Fire-and-forget: don't await kill to avoid blocking the HTTP response.
      // On Windows, ConPTY processes may take time to terminate.
      manager.kill(params.sessionId).catch(() => {
        // Ignore kill errors (process may already be dead)
      });

      return {
        sessionId: params.sessionId,
        killed: true
      };
    },

    async agent_list(_input: AgentListInput = {}) {
      let sessions = manager
        .listWithPid()
        .filter((session) => !scopeUserId || session.userId === scopeUserId);
      if (options.getAuthorizationSummary) {
        const summary = await options.getAuthorizationSummary();
        if (summary) {
          const catalog = options.resourceCatalog?.() ?? null;
          sessions = sessions.filter((session) => isSessionAuthorizationSnapshotCurrent(session, summary, catalog));
        }
      }

      return {
        sessions: sessions.map((session) => ({
          id: session.id,
          userId: session.userId,
          agentType: session.agentType,
          status: session.status,
          cwd: session.cwd,
          task: session.displayTask ?? session.task,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          totalOutputChars: session.totalOutputChars,
          pid: session.pid,
          sessionMode: session.sessionMode,
          chatMode: session.chatMode,
          modelId: session.modelId,
          claudeModelRole: session.claudeModelRole,
          creditUnits: session.creditUnits,
          turnState: session.turnState,
          turnCount: session.turnCount,
          claudeSessionId: session.claudeSessionId,
          chipId: session.chipId,
          scopePresetId: session.scopePresetId,
          scopeDescriptor: session.scopeDescriptor,
          scopeWorkspace: session.scopeWorkspace
        })),
        total: sessions.length,
        running: sessions.filter((session) => session.status === 'running').length,
        finished: sessions.filter((session) => session.status !== 'running').length
      };
    }
  };
}

function withResponseLocaleTurnContext(
  userText: string,
  locale: LocalePreference | undefined
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

export { ContextBudgetExceededError };

function resolveModelRouting(
  params: AgentSpawnInput,
  context: {
    userId?: string;
    role?: string;
    userModelGrants?: ModelId[];
    creditBalanceUnits?: number;
    source: SessionSource;
    modeRoleMapping?: ModeRoleMapping;
  }
): { chatMode: SearchModeId; modelId: ModelId; claudeModelRole: ClaudeModelRole; creditUnits: number } {
  const selection = resolveSearchModeSelection({
    requestedMode: params.chatMode,
    requestedModelId: params.model,
    entryPoint: sourceToSearchModeEntryPoint(context.source),
    includesImageInput: containsChatImageInput(params.displayTask ?? params.task),
    role: context.role ?? (context.userId ? undefined : 'admin'),
    userModelGrants: context.userModelGrants,
    creditBalanceUnits: context.creditBalanceUnits,
    modeRoleMapping: context.modeRoleMapping
  });
  assertResolvedSearchMode(selection);
  return {
    chatMode: selection.chatMode,
    modelId: selection.modelId,
    claudeModelRole: selection.modelId as ClaudeModelRole,
    creditUnits: selection.creditUnits
  };
}

async function reserveCreditsForSpawn(
  reservations: NonNullable<SessionActionOptions['creditReservations']>,
  userId: string,
  creditUnits: number
): Promise<{ reservationId: string; balanceBeforeUnits: number; balanceAfterUnits: number }> {
  try {
    return await reservations.reserve(userId, creditUnits);
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient credits') {
      throw new SessionModelRoutingError(402, 'INSUFFICIENT_CREDITS', 'Insufficient credits for this mode.', {
        creditUnits
      });
    }
    throw error;
  }
}

async function clearPersistedCreditReservation(
  persistence: PersistenceRuntime | undefined,
  sessionId: string
): Promise<void> {
  if (!persistence) {
    return;
  }
  await persistence.sessionStore.updateSessionMeta(sessionId, { creditReservation: undefined }).catch(() => {
    // Best-effort cleanup; preserve the original failure.
  });
}

async function releaseReservedCredits(
  reservations: SessionActionOptions['creditReservations'] | undefined,
  reservationId: string
): Promise<void> {
  await reservations?.release(reservationId);
}

function assertResolvedSearchMode(
  selection: ReturnType<typeof resolveSearchModeSelection>
): asserts selection is Extract<ReturnType<typeof resolveSearchModeSelection>, { ok: true }> {
  if (selection.ok) {
    return;
  }

  throw new SessionModelRoutingError(selection.statusCode, selection.code, selection.message, selection.details);
}

function assertTurnInputAllowed(chatMode: SearchModeId | undefined, text: string): void {
  if (!containsChatImageInput(text) || chatMode === 'multimodal') {
    return;
  }
  throw new SessionModelRoutingError(400, 'IMAGE_INPUT_NOT_ALLOWED', 'Image input requires multimodal mode', {
    chatMode: chatMode ?? 'standard'
  });
}

function createTurnId(): string {
  return `turn-${crypto.randomUUID()}`;
}

function getSessionCitationProjectionOptions(manager: SessionManager, sessionId: string): {
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
} {
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  return {
    ...(session?.usedSources ? { usedSources: session.usedSources } : {}),
    ...(session?.sourceCitationSummary ? { sourceCitationSummary: session.sourceCitationSummary } : {})
  };
}

function getSessionRuntimeMetadata(manager: SessionManager, sessionId: string): {
  chatMode?: SearchModeId;
  modelId?: ModelId;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
} {
  const session = manager.list().find((candidate) => candidate.id === sessionId);
  return {
    chatMode: session?.chatMode,
    modelId: session?.modelId,
    claudeModelRole: session?.claudeModelRole,
    creditUnits: session?.creditUnits
  };
}
