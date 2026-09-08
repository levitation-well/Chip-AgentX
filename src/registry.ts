import { EventEmitter } from 'node:events';
import type {
  AdapterState,
  RunningSession,
  FinishedSession,
  ProcessSession,
  SessionManagerOptions,
  SessionStatus
} from './types.js';
import { truncateOutput } from './utils.js';

/**
 * Default TTL for job sessions (30 minutes)
 */
const DEFAULT_JOB_TTL_MS = 1_800_000;

/**
 * Default maximum output characters (200,000)
 */
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;

/**
 * ProcessRegistry manages session state with TTL cleanup
 * Handles running and finished sessions in memory Map storage
 */
export class ProcessRegistry extends EventEmitter {
  private readonly runningSessions: Map<string, RunningSession> = new Map();
  private readonly finishedSessions: Map<string, FinishedSession> = new Map();
  private readonly jobTtlMs: number;
  private readonly maxOutputChars: number;
  private sweeperTimer?: NodeJS.Timeout;

  constructor(options: SessionManagerOptions = {}) {
    super();
    this.jobTtlMs = options.jobTtlMs ?? DEFAULT_JOB_TTL_MS;
    this.maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    this.startSweeper();
  }

  /**
   * Register a new running session
   */
  register(session: RunningSession): void {
    this.runningSessions.set(session.id, session);
  }

  /**
   * Unregister a session from running sessions
   */
  unregister(sessionId: string): void {
    this.runningSessions.delete(sessionId);
  }

  /**
   * Remove a specific session from both running and finished maps
   */
  clear(sessionId: string): void {
    this.runningSessions.delete(sessionId);
    this.finishedSessions.delete(sessionId);
  }

  /**
   * Move a session from running to finished state, or update an already finished session.
   * This allows "kill" to override a "failed" status from an unexpected exit.
   */
  finish(
    sessionId: string,
    status: 'completed' | 'failed' | 'killed',
    exitCode?: number,
    exitSignal?: string
  ): FinishedSession | undefined {
    const running = this.runningSessions.get(sessionId);

    if (running) {
      // Session is still running - finish it
      const finished: FinishedSession = {
        ...running,
        status,
        finishedAt: Date.now(),
        exitCode,
        exitSignal
      };

      this.runningSessions.delete(sessionId);
      this.finishedSessions.set(sessionId, finished);

      this.emit('exit', sessionId, exitCode ?? 0, exitSignal ?? '');
      return finished;
    }

    // Session already finished - update its status (e.g., "failed" -> "killed")
    const existing = this.finishedSessions.get(sessionId);
    if (existing) {
      existing.status = status;
      existing.exitCode = exitCode;
      existing.exitSignal = exitSignal;
      existing.finishedAt = Date.now();
      return existing;
    }

    // Session not found
    return undefined;
  }

  /**
   * Get a session by ID (checks both running and finished)
   */
  get(sessionId: string): ProcessSession | undefined {
    return this.runningSessions.get(sessionId) ?? this.finishedSessions.get(sessionId);
  }

  /**
   * List all sessions (running and finished)
   */
  list(): ProcessSession[] {
    return [
      ...Array.from(this.runningSessions.values()),
      ...Array.from(this.finishedSessions.values())
    ];
  }

  /**
   * List only running sessions
   */
  listRunning(): RunningSession[] {
    return Array.from(this.runningSessions.values());
  }

  /**
   * Get count of running sessions
   */
  getRunningCount(): number {
    return this.runningSessions.size;
  }

  /**
   * Append output to a session
   */
  appendOutput(sessionId: string, chunk: string): void {
    const session = this.runningSessions.get(sessionId);
    if (!session) {
      return;
    }

    session.pendingStdout.push(chunk);
    session.aggregated += chunk;
    session.lastOutputAt = Date.now();
    session.totalOutputChars += chunk.length;

    // Truncate if exceeding max
    truncateOutput(session, this.maxOutputChars);

    this.emit('output', sessionId, chunk);
  }

  /**
   * Update session status
   */
  updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.runningSessions.get(sessionId);
    if (session && status !== 'running') {
      // Can only update status to non-running in running sessions
      (session as ProcessSession).status = status;
    }
  }

  /**
   * Update metadata for a running logical session.
   */
  updateState(sessionId: string, state: AdapterState): void {
    const session = this.runningSessions.get(sessionId);
    if (!session) {
      return;
    }

    if (state.turnState !== undefined) {
      session.turnState = state.turnState;
    }
    if (state.turnCount !== undefined) {
      session.turnCount = state.turnCount;
    }
    if (state.claudeSessionId !== undefined) {
      session.claudeSessionId = state.claudeSessionId;
    }

    this.emit('state', sessionId, state);
  }

  /**
   * Start the TTL sweeper interval
   */
  startSweeper(): void {
    if (this.sweeperTimer) {
      return;
    }

    const interval = this.jobTtlMs / 6; // Check 6x faster than TTL
    this.sweeperTimer = setInterval(() => {
      this.cleanupExpired();
    }, interval);
  }

  /**
   * Stop the TTL sweeper interval
   */
  stopSweeper(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = undefined;
    }
  }

  /**
   * Remove finished sessions older than TTL
   */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [id, session] of this.finishedSessions) {
      if (session.finishedAt && now - session.finishedAt > this.jobTtlMs) {
        this.finishedSessions.delete(id);
      }
    }
  }

  /**
   * Destroy the registry and clear all sessions
   */
  destroy(): void {
    this.stopSweeper();
    this.runningSessions.clear();
    this.finishedSessions.clear();
  }
}
