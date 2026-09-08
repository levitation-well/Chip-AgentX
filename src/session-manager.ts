import { EventEmitter } from 'node:events';
import type {
  AdapterState,
  ProcessSession,
  RunningSession,
  SpawnParams,
  SessionManagerOptions,
  PollResult,
  LogResult,
  AgentType,
  ChatMode
} from './types.js';
import type { ModelId } from './model-catalog.js';
import { ProcessRegistry } from './registry.js';
import { Supervisor } from './supervisor.js';
import { createAdapter } from './adapters/index.js';
import type { ProcessAdapter } from './types.js';
import type { SafeScopeSessionSummary } from './scope/index.js';
import type { SourceCitationSummary, UsedSourceRecord } from './source-citations/index.js';

/**
 * Default max concurrent sessions (8)
 */
const DEFAULT_MAX_CONCURRENT_SESSIONS = 8;

export class SessionBusyError extends Error {
  readonly statusCode = 409;

  constructor(message: string = 'Session is busy') {
    super(message);
  }
}

export class SessionConflictError extends Error {
  readonly statusCode = 409;

  constructor(message: string = 'Session already exists') {
    super(message);
  }
}

export class SessionNotInteractiveError extends Error {
  readonly statusCode = 409;

  constructor(message: string = 'Session is not interactive') {
    super(message);
  }
}

/**
 * SessionManager - Public API facade for session lifecycle management
 * Coordinates ProcessRegistry, Supervisor, and adapters
 */
export class SessionManager extends EventEmitter {
  private readonly registry: ProcessRegistry;
  private readonly supervisor: Supervisor;
  private readonly maxConcurrentSessions: number;
  private readonly overallTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly scopeWorkspaceCleanups: Map<string, () => Promise<void>> = new Map();
  private readonly pendingScopeWorkspaceCleanups: Map<string, Promise<void>> = new Map();
  private readonly managedAbortControllers: Map<string, AbortController> = new Map();
  private readonly turnStartReservations = new Set<string>();
  private settlementBarrierEnabled = false;
  private readonly pendingTurnSettlements = new Map<string, {
    turnCount: number;
    promise: Promise<void>;
    resolve: () => void;
  }>();
  private readonly failedTurnSettlements = new Set<string>();
  private readonly pendingSessionAcceptance = new Map<string, {
    promise: Promise<boolean>;
    resolve: (accepted: boolean) => void;
  }>();
  private readonly historicalResumeClaims = new Set<string>();

  constructor(options: SessionManagerOptions = {}) {
    super();

    this.registry = new ProcessRegistry(options);
    // On Windows, exitOnLastSession defaults to true to handle ConPTY cleanup (CORE-06)
    this.supervisor = new Supervisor(options.noOutputTimeoutMs, {
      exitOnLastSession: options.exitOnLastSession ?? (process.platform === 'win32')
    });
    this.maxConcurrentSessions = options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;

    // Proxy events from registry
    this.registry.on('output', (sessionId: string, data: string) => {
      this.emit('output', sessionId, data);
    });

    this.registry.on('exit', (sessionId: string, code: number, signal: string) => {
      this.emit('exit', sessionId, code, signal);
    });

    this.registry.on('state', (sessionId: string, state: AdapterState) => {
      if (this.settlementBarrierEnabled && state.turnState === 'idle' && typeof state.turnCount === 'number') {
        const session = this.registry.get(sessionId);
        if (session?.sessionMode === 'conversation') {
          this.beginTurnSettlement(sessionId, state.turnCount);
        }
      }
      this.emit('state', sessionId, state);
    });
  }

  /**
   * Spawn a new session for the given agent
   * Returns ProcessSession with unique ID
   */
  async spawn(params: SpawnParams): Promise<ProcessSession> {
    // Validate agentType
    const validAgentTypes: AgentType[] = ['codex', 'opencode', 'pi', 'claude-code'];
    if (!validAgentTypes.includes(params.agentType)) {
      throw new Error(`Unknown agent type: ${params.agentType}`);
    }

    // Check concurrent sessions limit
    if (this.registry.getRunningCount() >= this.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${this.maxConcurrentSessions}) reached`);
    }

    const sessionMode = params.sessionMode ?? 'oneshot';
    const sessionId = params.sessionId ?? crypto.randomUUID();

    if (this.registry.get(sessionId)) {
      throw new SessionConflictError(`Session already exists: ${sessionId}`);
    }

    // Create adapter
    const adapter = createAdapter(params.agentType, {
      sessionMode,
      claudeSessionId: params.claudeSessionId,
      resume: params.resume,
      initialTurnCount: params.initialTurnCount
    });

    const now = Date.now();

    // Create running session
    const session: RunningSession = {
      id: sessionId,
      userId: params.userId,
      agentType: params.agentType,
      status: 'running',
      startedAt: now,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: now,
      cwd: params.cwd ?? process.cwd(),
      task: params.task,
      displayTask: params.displayTask,
      sessionMode,
      chatMode: params.chatMode,
      modelId: params.modelId,
      claudeModelRole: params.claudeModelRole,
      creditUnits: params.creditUnits,
      creditReservation: params.creditReservation,
      turnState: adapter.turnState,
      turnCount: adapter.turnCount,
      claudeSessionId: adapter.claudeSessionId,
      chipId: params.chipId,
      documentId: params.documentId,
      scopePresetId: params.scopePresetId,
      allowedChipIds: params.allowedChipIds,
      allowedDocumentIds: params.allowedDocumentIds,
      scopeDescriptor: params.scopeDescriptor,
      scopeWorkspace: params.scopeWorkspace,
      usedSources: params.usedSources,
      sourceCitationSummary: params.sourceCitationSummary
    };

    // Register with registry
    this.registry.register(session);
    if (params.deferSettlement) {
      let resolve!: (accepted: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      this.pendingSessionAcceptance.set(sessionId, { promise, resolve });
    }

    // Register with supervisor
    this.supervisor.register(sessionId, adapter, params.noOutputTimeoutMs);
    if (params.scopeWorkspaceCleanup) {
      this.scopeWorkspaceCleanups.set(sessionId, params.scopeWorkspaceCleanup);
    }

    // Set overall timeout if specified
    if (params.timeoutMs !== undefined) {
      const timer = setTimeout(() => {
        const session = this.registry.get(sessionId);
        if (session && session.status === 'running') {
          this.kill(sessionId).catch(() => {});
        }
        this.overallTimeouts.delete(sessionId);
      }, params.timeoutMs);
      this.overallTimeouts.set(sessionId, timer);
    }

    // Set up adapter event handlers
    const exitHandler = (code: number, signal: string) => {
      this.handleExit(sessionId, code, signal);
    };
    adapter.onExit(exitHandler);

    const stateHandler = (state: AdapterState) => {
      this.registry.updateState(sessionId, state);
      if (state.turnState === 'running') {
        this.supervisor.resetNoOutputTimeout(sessionId, params.noOutputTimeoutMs);
      } else if (state.turnState === 'idle') {
        this.supervisor.clearNoOutputTimeout(sessionId);
      }
    };
    adapter.onState?.(stateHandler);

    const dataHandler = (data: string) => {
      this.registry.appendOutput(sessionId, data);
      this.supervisor.resetNoOutputTimeout(sessionId, params.noOutputTimeoutMs);
    };
    adapter.onData(dataHandler);

    // Spawn the process
    const cols = params.cols ?? 200;
    const rows = params.rows ?? 80;
    const env = params.env ?? {};
    if (params.agentType === 'claude-code') {
      adapter.spawn(session.cwd, env, cols, rows, params.task, {
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
        ...(params.claudeModelRole ? { claudeModelRole: params.claudeModelRole } : {}),
        ...(params.permissionMode ? { permissionMode: params.permissionMode } : {}),
        ...(params.allowedTools && params.allowedTools.length > 0 ? { allowedTools: params.allowedTools } : {}),
        ...(params.denyReadRoots && params.denyReadRoots.length > 0 ? { denyReadRoots: params.denyReadRoots } : {})
      });
    } else {
      adapter.spawn(session.cwd, env, cols, rows, params.task);
    }

    // Discovery Trace 最小落点（spec §6.9）：仅对经隔离闸加固的 claude-code 会话 emit 'launch'，
    // 供 http 层落一条结构化 cc.launch 事件。非隔离会话不 emit，避免刷 trace。
    if (
      params.agentType === 'claude-code' &&
      ((params.denyReadRoots?.length ?? 0) > 0 || (params.allowedTools?.length ?? 0) > 0)
    ) {
      this.emit('launch', sessionId, {
        permissionMode: params.permissionMode ?? 'default',
        allowedTools: params.allowedTools ?? [],
        denyReadRoots: params.denyReadRoots ?? [],
        cwd: session.cwd
      });
    }

    return session;
  }

  acceptSessionSettlement(sessionId: string): void {
    const pending = this.pendingSessionAcceptance.get(sessionId);
    if (!pending) return;
    this.pendingSessionAcceptance.delete(sessionId);
    pending.resolve(true);
  }

  rejectSessionSettlement(sessionId: string): void {
    const pending = this.pendingSessionAcceptance.get(sessionId);
    if (!pending) return;
    this.pendingSessionAcceptance.delete(sessionId);
    this.registry.finish(sessionId, 'killed', undefined, 'PERSISTENCE_REJECTED');
    pending.resolve(false);
  }

  async waitForSessionSettlementAcceptance(sessionId: string): Promise<boolean> {
    return await (this.pendingSessionAcceptance.get(sessionId)?.promise ?? Promise.resolve(true));
  }

  /**
   * Send data to session stdin (no newline appended)
   */
  async send(sessionId: string, data: string): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    if (adapter) {
      try {
        await adapter.write(data);
      } catch (error) {
        if (error instanceof Error && error.message.includes('turn is already running')) {
          throw new SessionBusyError(error.message);
        }
        throw error;
      }
      return;
    }
    if (this.registry.get(sessionId)) {
      throw new SessionNotInteractiveError();
    }
  }

  /**
   * Submit data to session stdin (newline appended)
   */
  async submit(sessionId: string, data: string): Promise<void> {
    await this.send(sessionId, data + '\n');
  }

  /**
   * Atomically reserve the right to start one conversation turn.
   *
   * Credit reservation and transcript persistence happen before adapter.write,
   * so relying on the adapter's turnState check alone leaves a race where two
   * concurrent requests can both reserve credits. The returned release
   * callback must be invoked after the adapter accepts or rejects the turn.
   */
  async claimTurnStart(sessionId: string): Promise<() => void> {
    const settlement = this.pendingTurnSettlements.get(sessionId);
    if (settlement) {
      await settlement.promise;
    }
    if (this.failedTurnSettlements.has(sessionId)) {
      throw new SessionBusyError('Previous turn settlement is incomplete');
    }
    const session = this.registry.get(sessionId);
    if (!session || session.status !== 'running' || session.sessionMode !== 'conversation') {
      throw new SessionNotInteractiveError();
    }
    if (session.turnState === 'running' || this.turnStartReservations.has(sessionId)) {
      throw new SessionBusyError();
    }
    this.turnStartReservations.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.turnStartReservations.delete(sessionId);
    };
  }

  /**
   * Atomically claim and prepare a persisted conversation id for historical
   * resume. The claim is held across persistence, credit reservation and spawn
   * so a stale HTTP snapshot can never clear or kill a newer generation.
   */
  async claimHistoricalResume(sessionId: string): Promise<() => void> {
    if (this.historicalResumeClaims.has(sessionId)) {
      throw new SessionBusyError('Session resume is already in progress');
    }
    this.historicalResumeClaims.add(sessionId);

    try {
      const pendingSettlement = this.pendingTurnSettlements.get(sessionId);
      if (pendingSettlement) {
        await pendingSettlement.promise;
      }

      const current = this.registry.get(sessionId);
      if (current?.status === 'running') {
        throw new SessionBusyError('Session is already running');
      }

      // Finished registry snapshots are diagnostic state from the previous
      // generation. Only clear after checking the current object under this
      // per-session claim; callers must never clear from a stale route-local
      // snapshot.
      if (current) {
        this.clear(sessionId);
      }
      // Historical single-chip resume may rebuild the same absolute cwd.
      // Wait even when the registry snapshot was already cleared: the prior
      // generation's best-effort rm() may still be in flight.
      await this.cleanupScopeWorkspace(sessionId);
      this.resetLifecycleGeneration(sessionId);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.historicalResumeClaims.delete(sessionId);
      };
    } catch (error) {
      this.historicalResumeClaims.delete(sessionId);
      throw error;
    }
  }

  enableTurnSettlementBarrier(): void {
    this.settlementBarrierEnabled = true;
  }

  completeTurnSettlement(sessionId: string, turnCount: number): void {
    const pending = this.pendingTurnSettlements.get(sessionId);
    if (!pending || pending.turnCount !== turnCount) return;
    this.pendingTurnSettlements.delete(sessionId);
    this.failedTurnSettlements.delete(sessionId);
    pending.resolve();
  }

  failTurnSettlement(sessionId: string, turnCount: number): void {
    const pending = this.pendingTurnSettlements.get(sessionId);
    if (!pending || pending.turnCount !== turnCount) return;
    this.pendingTurnSettlements.delete(sessionId);
    this.failedTurnSettlements.add(sessionId);
    pending.resolve();
  }

  private beginTurnSettlement(sessionId: string, turnCount: number): void {
    const current = this.pendingTurnSettlements.get(sessionId);
    if (current?.turnCount === turnCount) return;
    if (current) {
      this.pendingTurnSettlements.delete(sessionId);
      this.failedTurnSettlements.add(sessionId);
      current.resolve();
    }
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.pendingTurnSettlements.set(sessionId, { turnCount, promise, resolve });
  }

  /**
   * Poll session for status within timeout
   */
  poll(sessionId: string, timeoutMs: number): Promise<PollResult> {
    return new Promise((resolve) => {
      const session = this.registry.get(sessionId);
      if (!session) {
        resolve({ hasOutput: false, exited: true });
        return;
      }

      // Check if already exited
      if (session.status !== 'running') {
        resolve({
          hasOutput: session.pendingStdout.length > 0,
          exited: true,
          exitCode: session.exitCode
        });
        return;
      }

      // Set up output listener
      const outputHandler = () => {
        cleanup();
        resolve({ hasOutput: true, exited: false });
      };

      // Set up exit listener
      const exitHandler = (_id: string, code: number, _signal: string) => {
        if (_id === sessionId) {
          cleanup();
          resolve({
            hasOutput: session.pendingStdout.length > 0,
            exited: true,
            exitCode: code
          });
        }
      };

      const cleanup = () => {
        this.registry.off('output', outputHandler);
        this.registry.off('exit', exitHandler);
      };

      // Register listeners
      this.registry.on('output', outputHandler);
      this.registry.on('exit', exitHandler);

      // Set timeout
      setTimeout(() => {
        cleanup();
        const currentSession = this.registry.get(sessionId);
        resolve({
          hasOutput: (currentSession?.pendingStdout.length ?? 0) > 0,
          exited: currentSession?.status !== 'running'
        });
      }, timeoutMs);
    });
  }

  /**
   * Get session output with optional offset and limit
   */
  log(sessionId: string, offset?: number, limit?: number): LogResult {
    const session = this.registry.get(sessionId);
    if (!session) {
      return {
        output: '',
        truncated: false,
        totalChars: 0,
        offset: offset ?? 0
      };
    }

    let output = session.aggregated;
    const totalChars = session.totalOutputChars;
    const retainedOffset = Math.max(0, totalChars - output.length);
    let actualOffset = retainedOffset;

    if (offset !== undefined) {
      actualOffset = Math.min(Math.max(offset, retainedOffset), totalChars);
      output = output.slice(actualOffset - retainedOffset);
    }

    if (limit !== undefined) {
      output = output.slice(0, limit);
    }

    return {
      output,
      truncated: session.truncated,
      totalChars,
      offset: actualOffset,
      limit
    };
  }

  /**
   * Get last N characters of session output
   */
  tail(sessionId: string, n: number): LogResult {
    const session = this.registry.get(sessionId);
    if (!session) {
      return {
        output: '',
        truncated: false,
        totalChars: 0,
        offset: 0
      };
    }

    const output = session.aggregated.slice(-n);
    const totalChars = session.totalOutputChars;
    return {
      output,
      truncated: session.truncated,
      totalChars,
      offset: Math.max(0, totalChars - output.length)
    };
  }

  /**
   * Kill a session with graceful shutdown (SIGTERM then SIGKILL)
   */
  async kill(sessionId: string): Promise<void> {
    const adapter = this.getAdapter(sessionId);
    const currentSession = this.registry.get(sessionId);
    // A successful Claude conversation keeps its logical session registered
    // while no child process is running. Stopping that already-idle state must
    // not turn the completed turn into a killed/error result.
    if (
      adapter &&
      currentSession?.status === 'running' &&
      currentSession.sessionMode === 'conversation' &&
      currentSession.turnState === 'idle'
    ) {
      return;
    }
    if (!adapter) {
      const managed = this.managedAbortControllers.get(sessionId);
      const session = this.registry.get(sessionId);
      if (managed && session?.status === 'running') {
        this.managedAbortControllers.delete(sessionId);
        managed.abort(new Error('Managed session cancelled'));
        this.registry.finish(sessionId, 'killed', undefined, 'SIGTERM');
        this.cleanupScopeWorkspace(sessionId);
      }
      return;
    }

    try {
      // Graceful shutdown with SIGTERM
      await this.supervisor.kill(sessionId, false);

      // Wait 3 seconds
      await new Promise<void>((resolve) => setTimeout(resolve, 3000));

      // Check if process still alive and force kill if needed
      const stillAlive = this.registry.get(sessionId);
      if (stillAlive && stillAlive.status === 'running') {
        await this.supervisor.kill(sessionId, true);
      }
    } catch {
      // Kill may fail on Windows ConPTY or if process already exited.
      // Continue to mark the session as killed.
    }

    // Update registry with killed status
    this.registry.finish(sessionId, 'killed', undefined, 'SIGKILL');
    this.cleanupScopeWorkspace(sessionId);
  }

  /**
   * List all sessions with status
   */
  list(): ProcessSession[] {
    return this.registry.list();
  }

  /**
   * List all sessions with PID from the adapter
   */
  listWithPid(): (ProcessSession & { pid?: number })[] {
    const sessions = this.registry.list();
    return sessions.map((session) => {
      const adapter = this.getAdapter(session.id);
      return {
        ...session,
        pid: adapter?.pid
      };
    });
  }

  /**
   * Remove a specific session from the registry
   * Useful for admin cleanup or manual session removal
   */
  clear(sessionId: string): void {
    this.registry.clear(sessionId);
    this.supervisor.unregister(sessionId);
    this.cleanupScopeWorkspace(sessionId);
    const timeout = this.overallTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.overallTimeouts.delete(sessionId);
    }
  }

  private resetLifecycleGeneration(sessionId: string): void {
    this.turnStartReservations.delete(sessionId);
    this.failedTurnSettlements.delete(sessionId);
    const pendingSettlement = this.pendingTurnSettlements.get(sessionId);
    if (pendingSettlement) {
      this.pendingTurnSettlements.delete(sessionId);
      pendingSettlement.resolve();
    }
    const pendingAcceptance = this.pendingSessionAcceptance.get(sessionId);
    if (pendingAcceptance) {
      this.pendingSessionAcceptance.delete(sessionId);
      pendingAcceptance.resolve(false);
    }
    const managedAbort = this.managedAbortControllers.get(sessionId);
    if (managedAbort) {
      managedAbort.abort();
      this.managedAbortControllers.delete(sessionId);
    }
  }

  /**
   * Get adapter for session
   */
  private getAdapter(sessionId: string): ProcessAdapter | undefined {
    return this.supervisor.getAdapter(sessionId);
  }

  /**
   * Handle session exit
   */
  private handleExit(sessionId: string, code: number, signal: string): void {
    // Clear any pending overall timeout
    const timeout = this.overallTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.overallTimeouts.delete(sessionId);
    }

    // Finish session in registry
    this.registry.finish(sessionId, code === 0 ? 'completed' : 'failed', code, signal);
    this.cleanupScopeWorkspace(sessionId);

    // Notify supervisor
    this.supervisor.handleExit(sessionId, code, signal);
  }

  /**
   * Destroy the session manager and clean up all sessions
   */
  destroy(): void {
    // Clear all overall timeouts
    for (const timer of this.overallTimeouts.values()) {
      clearTimeout(timer);
    }
    this.overallTimeouts.clear();

    // Kill all running sessions
    for (const session of this.registry.listRunning()) {
      this.kill(session.id).catch(() => {
        // Ignore errors during destroy
      });
    }

    // Clean up registry and supervisor
    this.registry.destroy();
    this.supervisor.destroy();
  }

  /**
   * 创建一个「托管会话」：注册为 running、可注入输出、可结束——不起真实进程、不挂 supervisor。
   * 用于把预算好的答案（如大范围两阶段结果）以流式会话形式回送给前端。
   */
  createManagedSession(params: ManagedSessionParams): ManagedSessionHandle {
    if (this.registry.getRunningCount() >= this.maxConcurrentSessions) {
      throw new Error(`Max concurrent sessions (${this.maxConcurrentSessions}) reached`);
    }
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const session: RunningSession = {
      id: sessionId,
      userId: params.userId,
      agentType: 'claude-code',
      status: 'running',
      startedAt: now,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: now,
      cwd: '',
      task: params.task,
      sessionMode: 'oneshot',
      chatMode: params.chatMode,
      modelId: params.modelId,
      claudeModelRole: params.claudeModelRole,
      creditUnits: params.creditUnits,
      creditReservation: params.creditReservation,
      scopeWorkspace: params.scopeWorkspace,
      // P1-3 (multi-agent audit): persist auth-recheck inputs so revocation
      // can be detected mid-session on /log /poll /send /kill.
      chipId: params.chipId,
      documentId: params.documentId,
      scopePresetId: params.scopePresetId,
      allowedChipIds: params.allowedChipIds,
      allowedDocumentIds: params.allowedDocumentIds,
      scopeDescriptor: params.scopeDescriptor
    };
    this.registry.register(session);
    const abortController = new AbortController();
    this.managedAbortControllers.set(sessionId, abortController);
    return {
      sessionId,
      signal: abortController.signal,
      appendOutput: (chunk: string) => this.registry.appendOutput(sessionId, chunk),
      complete: (meta) => {
        const current = this.registry.get(sessionId);
        if (!current || current.status !== 'running' || abortController.signal.aborted) {
          return;
        }
        this.managedAbortControllers.delete(sessionId);
        // 顺序要紧：meta 必须在 finish() 之前写入 session。finish() 会把 running 会话
        // 浅拷贝进 FinishedSession 并同步 emit 'exit'；citation/usedSources 须在那之前就位，
        // 否则订阅 'exit' 的 SSE 消费者读到的 finished 副本将缺少来源信息。
        if (meta?.sourceCitationSummary) session.sourceCitationSummary = meta.sourceCitationSummary;
        if (meta?.usedSources) session.usedSources = meta.usedSources;
        this.registry.finish(sessionId, 'completed', 0);
      },
      fail: (message: string) => {
        const current = this.registry.get(sessionId);
        if (!current || current.status !== 'running' || abortController.signal.aborted) {
          return;
        }
        this.managedAbortControllers.delete(sessionId);
        this.registry.appendOutput(sessionId, message);
        this.registry.finish(sessionId, 'failed', 1);
      }
    };
  }

  /** 只读取会话（running 或 finished）。 */
  getSession(sessionId: string): ProcessSession | undefined {
    return this.registry.get(sessionId);
  }

  private cleanupScopeWorkspace(sessionId: string): Promise<void> {
    const pending = this.pendingScopeWorkspaceCleanups.get(sessionId);
    if (pending) {
      return pending;
    }
    const cleanup = this.scopeWorkspaceCleanups.get(sessionId);
    if (!cleanup) {
      return Promise.resolve();
    }
    this.scopeWorkspaceCleanups.delete(sessionId);
    const cleanupPromise = cleanup()
      .catch(() => {
        // Scope workspace cleanup is best-effort and must not surface internal paths.
      })
      .finally(() => {
        if (this.pendingScopeWorkspaceCleanups.get(sessionId) === cleanupPromise) {
          this.pendingScopeWorkspaceCleanups.delete(sessionId);
        }
      });
    this.pendingScopeWorkspaceCleanups.set(sessionId, cleanupPromise);
    return cleanupPromise;
  }
}

export interface ManagedSessionParams {
  userId?: string;
  task: string;
  chatMode?: ChatMode;
  modelId?: ModelId;
  claudeModelRole?: import('./model-routing.js').ClaudeModelRole;
  creditUnits?: number;
  creditReservation?: import('./types.js').SessionCreditReservation;
  scopeWorkspace?: SafeScopeSessionSummary;
  // P1-3 (multi-agent audit): large-scope session auth revalidation inputs.
  // These let assertSessionStillAuthorized in src/server/session-actions.ts
  // recheck chip / document / scope-preset authorization on every /log/poll/send/kill,
  // even after the session is no longer in the request scope.
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  allowedChipIds?: string[];
  allowedDocumentIds?: string[];
  scopeDescriptor?: import('./scope/index.js').ScopeDescriptor;
}

export interface ManagedSessionHandle {
  sessionId: string;
  signal: AbortSignal;
  appendOutput(chunk: string): void;
  complete(meta?: { sourceCitationSummary?: SourceCitationSummary; usedSources?: UsedSourceRecord[] }): void;
  fail(message: string): void;
}
