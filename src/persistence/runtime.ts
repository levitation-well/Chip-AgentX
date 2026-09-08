import type { SessionMeta, TranscriptEntry, TurnResult } from './session-history-store.js';
import { QuestionLedger, type QuestionRecord } from './question-ledger.js';
import { SessionHistoryStore } from './session-history-store.js';
import {
  createPersistencePaths,
  initializeDataLayout,
  resolveDataDir,
  type PersistencePaths
} from './paths.js';
import {
  LOG_EVENTS,
  cleanupOldLogFiles,
  createAuditLogger,
  createLogger,
  type AuditLogger,
  type Logger
} from '../logging/index.js';
import { cleanupRetention, resolveRetentionPolicy } from '../observability/retention.js';
import { SessionDebugBundleStore } from '../observability/session-debug-bundle.js';

export interface PersistenceRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  dataDir?: string;
  paths?: PersistencePaths;
  fileLogging?: boolean;
  retentionDays?: number;
  now?: () => Date;
  logger?: Logger;
  auditLogger?: AuditLogger;
}

export interface PersistenceRuntime {
  dataDir: string;
  paths: PersistencePaths;
  sessionStore: SessionHistoryStore;
  questionLedger: QuestionLedger;
  sessionDebugBundles: SessionDebugBundleStore;
  logger: Logger;
  auditLogger: AuditLogger;
  init(): Promise<{ interrupted: string[] }>;
  recordSessionCreated(meta: Parameters<SessionHistoryStore['createSession']>[0]): Promise<SessionMeta>;
  recordUserTurn(
    sessionId: string,
    input: TranscriptEntry & { role: 'user'; question?: Omit<QuestionRecord, 'questionId' | 'createdAt' | 'text'> }
  ): Promise<void>;
  recordOutputChunk(sessionId: string, chunk: string): Promise<void>;
  recordTurnFinished(sessionId: string, result: TurnResult): Promise<void>;
  recordSessionEvent(sessionId: string, event: Parameters<SessionHistoryStore['appendEvent']>[1]): Promise<void>;
}

export function createPersistenceRuntime(options: PersistenceRuntimeOptions = {}): PersistenceRuntime {
  const dataDir = options.paths?.dataDir ?? options.dataDir ?? resolveDataDir(options.env, options.cwd);
  const paths = options.paths ?? createPersistencePaths(dataDir);
  const nowDate = options.now ?? (() => new Date());
  const nowIso = () => nowDate().toISOString();
  const logger =
    options.logger ??
    createLogger({
      dataDir: paths.dataDir,
      fileLogging: options.fileLogging,
      now: nowDate
    });
  const auditLogger =
    options.auditLogger ??
    createAuditLogger({
      dataDir: paths.dataDir,
      fileLogging: options.fileLogging,
      now: nowDate
    });
  const sessionStore = new SessionHistoryStore({ paths, now: nowIso });
  const questionLedger = new QuestionLedger({ paths, now: nowIso });
  const sessionDebugBundles = new SessionDebugBundleStore({ paths, logger, auditLogger, now: nowDate });
  const retentionPolicy = resolveRetentionPolicy(options.env);
  const retentionCleanupIntervalMs = resolveRetentionCleanupIntervalMs(options.env);
  let retentionCleanupTimer: NodeJS.Timeout | undefined;

  function scheduleRetentionCleanup(): void {
    if (retentionCleanupTimer || retentionCleanupIntervalMs <= 0) return;
    retentionCleanupTimer = setInterval(() => {
      cleanupRetention(paths, {
        policy: retentionPolicy,
        now: nowDate(),
        logger
      }).catch((error) => {
        logger.warn('retention_cleanup_failed', 'Scheduled retention cleanup failed', {
          metadata: { error: error instanceof Error ? error.message : String(error) }
        });
      });
    }, retentionCleanupIntervalMs);
    retentionCleanupTimer.unref?.();
  }

  return {
    dataDir: paths.dataDir,
    paths,
    sessionStore,
    questionLedger,
    sessionDebugBundles,
    logger,
    auditLogger,
    async init() {
      await initializeDataLayout(paths);
      await sessionStore.init();
      if (options.fileLogging) {
        cleanupOldLogFiles({
          dataDir: paths.dataDir,
          retentionDays: options.retentionDays,
          now: nowDate()
        });
      }
      await cleanupRetention(paths, {
        policy: retentionPolicy,
        now: nowDate(),
        logger
      });
      scheduleRetentionCleanup();
      const result = await sessionStore.markRunningTurnsInterrupted(nowIso());
      logger.info(LOG_EVENTS.dataDirInitialized, 'Persistence data directory initialized', {
        metadata: { dataDir: paths.dataDir, interruptedCount: result.interrupted.length }
      });
      return result;
    },
    recordSessionCreated(meta) {
      return sessionStore.createSession(meta);
    },
    async recordUserTurn(sessionId, input) {
      await sessionStore.appendTranscript(sessionId, input);
      if (input.question) {
        await questionLedger.appendQuestion({
          ...input.question,
          sessionId,
          turnId: input.turnId,
          text: input.text
        });
      }
    },
    async recordOutputChunk(sessionId, chunk) {
      await sessionStore.appendOutput(sessionId, chunk);
    },
    async recordTurnFinished(sessionId, result) {
      await sessionStore.appendTranscript(sessionId, {
        role: 'turn_result',
        status: result.status,
        finishedAt: result.finishedAt,
        exitCode: result.exitCode,
        signal: result.signal,
        totalOutputChars: result.totalOutputChars,
        ...(result.error !== undefined ? { error: result.error } : {})
      });
    },
    async recordSessionEvent(sessionId, event) {
      await sessionStore.appendEvent(sessionId, event);
    }
  };
}

function resolveRetentionCleanupIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.AGENTX_RETENTION_CLEANUP_INTERVAL_MS);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  return 6 * 60 * 60 * 1000;
}

export async function initPersistenceRuntime(options: PersistenceRuntimeOptions = {}): Promise<PersistenceRuntime> {
  const runtime = createPersistenceRuntime(options);
  try {
    await runtime.init();
    return runtime;
  } catch (error) {
    runtime.logger.error(LOG_EVENTS.persistError, 'Persistence runtime initialization failed', {
      metadata: {
        dataDir: runtime.dataDir,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
}
