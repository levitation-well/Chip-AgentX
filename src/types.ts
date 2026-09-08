import type { EventEmitter } from 'node:events';
import type { ModelId } from './model-catalog.js';
import type { ClaudeModelRole } from './model-routing.js';
import type { SafeScopeSessionSummary, ScopeDescriptor } from './scope/index.js';
import type { SourceCitationSummary, UsedSourceRecord } from './source-citations/index.js';

/**
 * Supported AI coding agent types
 */
export type AgentType = 'codex' | 'opencode' | 'pi' | 'claude-code';

/**
 * Session execution mode.
 * - oneshot: process exit finishes the AgentX session.
 * - conversation: successful Claude Code turns keep the AgentX session open.
 */
export type SessionMode = 'oneshot' | 'conversation';
export type ChatMode = 'standard' | 'enhanced' | 'multimodal';

/**
 * Current turn state for logical conversation sessions.
 */
export type TurnState = 'running' | 'idle';

/**
 * Session status values
 */
export type SessionStatus = 'running' | 'completed' | 'failed' | 'killed';

/**
 * Base session interface with all common properties
 */
export interface ProcessSession {
  id: string;
  userId?: string;
  agentType: AgentType;
  status: SessionStatus;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  exitSignal?: string;
  pendingStdout: string[];
  aggregated: string;
  truncated: boolean;
  totalOutputChars: number;
  lastOutputAt: number;
  cwd: string;
  task: string;
  displayTask?: string;
  sessionMode?: SessionMode;
  chatMode?: ChatMode;
  modelId?: ModelId;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
  creditReservation?: SessionCreditReservation;
  turnState?: TurnState;
  turnCount?: number;
  claudeSessionId?: string;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  /**
   * 动态 scope（scopePresetId 形如 dynamic-group / dynamic-global，见
   * scope/scope-options.ts 的 isDynamicScopePresetId）实际解析并授权访问的 chip 集合。
   * 目录里查不到这种合成 scopePresetId，因此撤权复验（session-actions.ts 的
   * assertSessionStillAuthorized、http-server.ts 的 assertCurrentMcpToolAndSession）
   * 必须逐个核对这里的 chip，而不是走 scopePreset 目录契约那条路径。
   * 单芯片/真实预设会话不使用这个字段（保持 undefined）。
   */
  allowedChipIds?: string[];
  /** Documents authorized for the physical scope workspace at materialization time. */
  allowedDocumentIds?: string[];
  scopeDescriptor?: ScopeDescriptor;
  scopeWorkspace?: SafeScopeSessionSummary;
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
}

/**
 * Running session with status 'running'
 */
export interface RunningSession extends ProcessSession {
  status: 'running';
}

/**
 * Finished session with status 'completed' | 'failed' | 'killed'
 */
export interface FinishedSession extends ProcessSession {
  status: 'completed' | 'failed' | 'killed';
  finishedAt: number;
}

/**
 * Result of polling a session for status
 */
export interface PollResult {
  hasOutput: boolean;
  exited: boolean;
  exitCode?: number;
}

/**
 * Result of retrieving session output
 */
export interface LogResult {
  output: string;
  truncated: boolean;
  /** Cumulative characters emitted in the current runtime, before retained-window truncation. */
  totalChars: number;
  /** Absolute runtime offset of output[0], not an index relative to the retained window. */
  offset: number;
  limit?: number;
}

/**
 * Parameters for spawning a new session
 */
export interface SpawnParams {
  sessionId?: string;
  agentType: AgentType;
  task: string;
  displayTask?: string;
  userId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  sessionMode?: SessionMode;
  chatMode?: ChatMode;
  modelId?: ModelId;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
  creditReservation?: SessionCreditReservation;
  claudeSessionId?: string;
  resume?: boolean;
  /** Persisted logical turn count to continue from when rebuilding a conversation adapter. */
  initialTurnCount?: number;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  allowedChipIds?: string[];
  allowedDocumentIds?: string[];
  scopeDescriptor?: ScopeDescriptor;
  scopeWorkspace?: SafeScopeSessionSummary;
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
  scopeWorkspaceCleanup?: () => Promise<void>;
  systemPrompt?: string; // 服务端可信系统提示词，经 direct adapter options 传递
  denyReadRoots?: string[]; // 服务端可信 Claude Code 禁读根目录
  allowedTools?: string[]; // 服务端可信 Claude Code 工具白名单
  permissionMode?: 'default' | 'acceptEdits' | 'plan'; // 服务端可信 Claude 权限模式
  /** Internal persistence gate: do not settle an instant exit until spawn records are durable. */
  deferSettlement?: boolean;
}

export interface SessionCreditReservation {
  reservationId: string;
  balanceBeforeUnits: number;
  balanceAfterUnits: number;
  /** Stable ledger id for crash reconciliation; not exposed to public APIs. */
  requestId?: string;
}

export interface AdapterState {
  turnState?: TurnState;
  turnCount?: number;
  claudeSessionId?: string;
}

/**
 * SessionManager configuration options
 */
export interface SessionManagerOptions {
  jobTtlMs?: number;
  maxOutputChars?: number;
  maxConcurrentSessions?: number;
  noOutputTimeoutMs?: number;
  /**
   * If true, exit the Node.js process when the last session exits.
   * Default: true on Windows (for ConPTY cleanup, CORE-06), false elsewhere.
   * Set to false for programmatic SDK use.
   */
  exitOnLastSession?: boolean;
}

/**
 * Server-controlled Claude launch policy. This must never be populated from a
 * caller's `env`; adapters receive it through the explicit spawn boundary.
 */
export interface TrustedClaudeSpawnOptions {
  systemPrompt?: string;
  claudeModelRole?: ClaudeModelRole;
  permissionMode?: 'default' | 'acceptEdits' | 'plan';
  allowedTools?: string[];
  denyReadRoots?: string[];
}

/**
 * Process adapter interface for process management
 */
export interface ProcessAdapter {
  readonly pid: number | undefined;
  spawn(
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
    task: string,
    trustedClaudeOptions?: TrustedClaudeSpawnOptions
  ): void;
  write(data: string): void;
  kill(): void;
  onData(handler: (data: string) => void): void;
  onExit(handler: (code: number, signal: string) => void): void;
  onState?(handler: (state: AdapterState) => void): void;
  removeDataHandler(handler: (data: string) => void): void;
  removeExitHandler(handler: (code: number, signal: string) => void): void;
  removeStateHandler?(handler: (state: AdapterState) => void): void;
  readonly turnState?: TurnState;
  readonly turnCount?: number;
  readonly claudeSessionId?: string;
}

/**
 * Session events interface extending EventEmitter
 */
export interface ProcessSessionEvents extends EventEmitter {
  on(event: 'output', listener: (sessionId: string, data: string) => void): this;
  on(event: 'exit', listener: (sessionId: string, code: number, signal: string) => void): this;
  on(event: 'state', listener: (sessionId: string, state: AdapterState) => void): this;
  emit(event: 'output', sessionId: string, data: string): boolean;
  emit(event: 'exit', sessionId: string, code: number, signal: string): boolean;
  emit(event: 'state', sessionId: string, state: AdapterState): boolean;
}

/**
 * Exit status mapping result
 */
export interface ExitStatusResult {
  status: 'completed' | 'failed' | 'killed';
  exitCode?: number;
  exitSignal?: string;
}
