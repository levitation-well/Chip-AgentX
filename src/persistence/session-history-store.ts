import type { AgentType, ChatMode, SessionCreditReservation, SessionMode, TurnState } from '../types.js';
import type { ClaudeModelRole } from '../model-routing.js';
import type { SafeScopeSessionSummary, ScopeDescriptor } from '../scope/index.js';
import type { SourceCitationSummary, UsedSourceRecord } from '../source-citations/index.js';
import {
  appendJsonLine,
  appendText,
  readJsonFile,
  readJsonLines,
  readTextTail,
  writeJsonAtomic
} from './json-file.js';
import {
  createPersistencePaths,
  getSessionFile,
  initializeDataLayout,
  type PersistencePaths
} from './paths.js';

export type TurnResultStatus = 'done' | 'error' | 'interrupted';
export type SessionSource = 'web' | 'mcp' | 'rpc' | 'cli';

export interface TurnResult {
  status: TurnResultStatus;
  startedAt?: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  totalOutputChars: number;
  error?: string;
}

export interface SessionMeta {
  sessionId: string;
  userId?: string;
  username?: string;
  role?: string;
  agentType: AgentType | string;
  chipId?: string;
  chipLabel?: string;
  documentId?: string;
  scopePresetId?: string;
  allowedChipIds?: string[];
  allowedDocumentIds?: string[];
  scopeDescriptor?: ScopeDescriptor;
  scopeWorkspace?: SafeScopeSessionSummary;
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
  cwd: string;
  task: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  claudeSessionId?: string;
  sessionMode?: SessionMode;
  chatMode?: ChatMode;
  modelId?: string;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
  creditReservation?: SessionCreditReservation;
  /** 检索流水线类型（单芯片/跨档两步/全局），写 debug bundle 时同步落盘，供 admin 会话列表「类型」列使用。旧记录可能没有此字段。 */
  pipelineType?: '单芯片' | '跨档两步' | '全局';
  turnState?: TurnState;
  turnCount?: number;
  lastTurnResult?: TurnResult;
  outputSize: number;
  source?: SessionSource;
  tags: string[];
  adminNotes?: string;
  aiSummary?: string;
  aiLabels: string[];
}

export interface SessionIndexEntry {
  sessionId: string;
  userId?: string;
  username?: string;
  role?: string;
  agentType: AgentType | string;
  chipId?: string;
  chipLabel?: string;
  documentId?: string;
  scopePresetId?: string;
  scopeDescriptor?: ScopeDescriptor;
  scopeWorkspace?: SafeScopeSessionSummary;
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
  cwd: string;
  task: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  claudeSessionId?: string;
  sessionMode?: SessionMode;
  chatMode?: ChatMode;
  modelId?: string;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
  creditReservation?: SessionCreditReservation;
  pipelineType?: '单芯片' | '跨档两步' | '全局';
  turnState?: TurnState;
  turnCount?: number;
  lastTurnResult?: TurnResult;
  outputSize: number;
  source?: SessionSource;
  tags: string[];
  adminNotes?: string;
  aiSummary?: string;
  aiLabels: string[];
}

export type TranscriptEntry =
  | {
      turnId?: string;
      role: 'user';
      text: string;
      createdAt: string;
      outputStart?: number;
      chatMode?: ChatMode;
      modelId?: string;
      claudeModelRole?: ClaudeModelRole;
      creditUnits?: number;
    }
  | {
      turnId?: string;
      role: 'assistant';
      text: string;
      createdAt: string;
      chatMode?: ChatMode;
      modelId?: string;
      claudeModelRole?: ClaudeModelRole;
      creditUnits?: number;
      usedSources?: UsedSourceRecord[];
      sourceCitationSummary?: SourceCitationSummary;
    }
  | {
      turnId?: string;
      role: 'turn_result';
      status: TurnResultStatus;
      finishedAt: string;
      exitCode: number | null;
      signal: string | null;
      totalOutputChars: number;
      error?: string;
    };

export interface SessionEventRecord {
  event: string;
  sessionId: string;
  createdAt: string;
  turnId?: string;
  details?: Record<string, unknown>;
}

export interface TailOutputResult {
  output: string;
  totalChars: number;
  offset: number;
  limit: number;
}

export interface JsonLineReadOptions {
  offset?: number;
  limit?: number;
}

export interface UserSessionListOptions {
  offset?: number;
  limit?: number;
}

export type UserSessionHistorySummary = Omit<SessionIndexEntry, 'cwd' | 'outputSize' | 'adminNotes' | 'creditReservation'>;

export interface UserSessionListResult {
  items: UserSessionHistorySummary[];
  total: number;
  offset: number;
  limit: number;
}

export type UserHistoryTranscriptEntry =
  | {
      turnId?: string;
      role: 'user';
      text: string;
      createdAt: string;
      chatMode?: ChatMode;
      modelId?: string;
      claudeModelRole?: ClaudeModelRole;
      creditUnits?: number;
    }
  | {
      turnId?: string;
      role: 'assistant';
      text: string;
      createdAt: string;
      chatMode?: ChatMode;
      modelId?: string;
      creditUnits?: number;
      sourceCitationSummary?: SourceCitationSummary;
    };

export interface UserSessionHistoryDetail {
  summary: UserSessionHistorySummary;
  transcript: UserHistoryTranscriptEntry[];
}

export interface SessionHistoryStoreOptions {
  dataDir?: string;
  paths?: PersistencePaths;
  now?: () => string;
}

const MAX_USER_HISTORY_LIMIT = 500;

export class SessionHistoryStore {
  private readonly paths: PersistencePaths;
  private readonly now: () => string;
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SessionHistoryStoreOptions = {}) {
    this.paths = options.paths ?? createPersistencePaths(options.dataDir ?? './data');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async init(): Promise<void> {
    await initializeDataLayout(this.paths);
  }

  async createSession(meta: Omit<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'> &
    Partial<Pick<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'>>): Promise<SessionMeta> {
    await this.init();
    return this.withSessionQueue(meta.sessionId, async () => {
      const normalized = this.normalizeMeta(meta);

      await writeJsonAtomic(this.metaFile(normalized.sessionId), normalized);
      await this.upsertIndexEntry(normalized);

      return normalized;
    });
  }

  async readSessionMeta(sessionId: string): Promise<SessionMeta | undefined> {
    await this.init();
    return readJsonFile<SessionMeta | undefined>(this.metaFile(sessionId), undefined);
  }

  async updateSessionMeta(sessionId: string, patch: Partial<Omit<SessionMeta, 'sessionId'>>): Promise<SessionMeta> {
    await this.init();
    return this.withSessionQueue(sessionId, () => this.updateSessionMetaUnlocked(sessionId, patch));
  }

  async readSessionIndex(): Promise<SessionIndexEntry[]> {
    await this.init();
    return this.readIndex();
  }

  async listUserSessions(
    userId: string,
    options: UserSessionListOptions = {},
    include?: (meta: SessionMeta) => boolean | Promise<boolean>
  ): Promise<UserSessionListResult> {
    await this.init();
    const entries = await this.readIndex();
    const owned = entries.filter((entry) => entry.userId === userId);
    const visibleEntries = include
      ? (await Promise.all(owned.map(async (entry) => {
          const meta = await this.readSessionMeta(entry.sessionId);
          return meta && await include(meta) ? entry : undefined;
        }))).filter((entry): entry is SessionIndexEntry => Boolean(entry))
      : owned;
    const filtered = visibleEntries
      .sort((left, right) => sessionHistoryTimestamp(right).localeCompare(sessionHistoryTimestamp(left)))
      .map(toUserSessionHistorySummary);
    const page = paginate(filtered, options);

    return {
      items: page.items,
      total: filtered.length,
      offset: page.offset,
      limit: page.limit
    };
  }

  async readUserSessionHistory(
    userId: string,
    sessionId: string,
    transcriptOptions: JsonLineReadOptions = {}
  ): Promise<UserSessionHistoryDetail | undefined> {
    await this.init();
    const meta = await this.readSessionMeta(sessionId);
    if (!meta || meta.userId !== userId) {
      return undefined;
    }

    const visibleTranscript = (await this.readTranscript(sessionId))
      .filter(isUserHistoryTranscriptEntry)
      .map(toUserHistoryTranscriptEntry);
    const effectiveTranscriptOptions = transcriptOptions.offset === undefined && transcriptOptions.limit === undefined
      ? {
          offset: Math.max(0, visibleTranscript.length - MAX_USER_HISTORY_LIMIT),
          limit: MAX_USER_HISTORY_LIMIT
        }
      : transcriptOptions;
    const transcript = paginate(visibleTranscript, effectiveTranscriptOptions).items;

    return {
      summary: toUserSessionHistorySummary(toIndexEntry(meta)),
      transcript
    };
  }

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    await this.init();
    await this.requireSessionMeta(sessionId);
    await appendJsonLine(this.transcriptFile(sessionId), entry);

    const lastMessageAt = entry.role === 'turn_result' ? entry.finishedAt : entry.createdAt;
    const patch: Partial<SessionMeta> = { lastMessageAt };
    if (entry.role === 'turn_result') {
      patch.turnState = 'idle';
      patch.lastTurnResult = {
        status: entry.status,
        finishedAt: entry.finishedAt,
        exitCode: entry.exitCode,
        signal: entry.signal,
        totalOutputChars: entry.totalOutputChars,
        ...(entry.error !== undefined ? { error: entry.error } : {})
      };
    }
    await this.updateSessionMeta(sessionId, patch);
  }

  async readTranscript(sessionId: string, options: JsonLineReadOptions = {}): Promise<TranscriptEntry[]> {
    await this.init();
    await this.requireSessionMeta(sessionId);
    return readJsonLines<TranscriptEntry>(this.transcriptFile(sessionId), options);
  }

  async appendOutput(sessionId: string, chunk: string): Promise<SessionMeta> {
    await this.init();
    return this.withSessionQueue(sessionId, async () => {
      const meta = await this.requireSessionMeta(sessionId);
      await appendText(this.outputFile(sessionId), chunk);

      return this.updateSessionMetaUnlocked(sessionId, {
        outputSize: meta.outputSize + chunk.length
      });
    });
  }

  async tailOutput(sessionId: string, limitChars: number): Promise<TailOutputResult> {
    await this.init();
    const meta = await this.requireSessionMeta(sessionId);
    const limit = Math.max(0, limitChars);
    const output = await readTextTail(this.outputFile(sessionId), limit);
    const totalChars = meta.outputSize;

    return {
      output,
      totalChars,
      offset: Math.max(0, totalChars - limit),
      limit
    };
  }

  async appendEvent(sessionId: string, event: Omit<SessionEventRecord, 'sessionId' | 'createdAt'> &
    Partial<Pick<SessionEventRecord, 'sessionId' | 'createdAt'>>): Promise<SessionEventRecord> {
    await this.init();
    await this.requireSessionMeta(sessionId);
    const record: SessionEventRecord = {
      ...event,
      sessionId,
      createdAt: event.createdAt ?? this.now()
    };

    await appendJsonLine(this.eventsFile(sessionId), record);
    return record;
  }

  async readEvents(sessionId: string, options: JsonLineReadOptions = {}): Promise<SessionEventRecord[]> {
    await this.init();
    await this.requireSessionMeta(sessionId);
    return readJsonLines<SessionEventRecord>(this.eventsFile(sessionId), options);
  }

  async markRunningTurnsInterrupted(nowIso: string = this.now()): Promise<{ interrupted: string[] }> {
    await this.init();
    const index = await this.readIndex();
    const interrupted: string[] = [];

    for (const entry of index) {
      const meta = await this.readSessionMeta(entry.sessionId);
      if (!meta || meta.turnState !== 'running') {
        continue;
      }

      const updated = await this.updateSessionMeta(meta.sessionId, {
        turnState: 'idle',
        lastTurnResult: {
          status: 'interrupted',
          finishedAt: nowIso,
          exitCode: null,
          signal: 'RESTART',
          totalOutputChars: meta.outputSize ?? 0
        }
      });

      await this.appendEvent(updated.sessionId, {
        event: 'turn_interrupted_on_startup',
        createdAt: nowIso,
        details: {
          totalOutputChars: updated.outputSize
        }
      });
      interrupted.push(updated.sessionId);
    }

    return { interrupted };
  }

  private normalizeMeta(meta: Omit<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'> &
    Partial<Pick<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'>>): SessionMeta {
    const createdAt = meta.createdAt ?? this.now();

    return {
      ...meta,
      title: meta.title ?? meta.task.trim().slice(0, 40),
      createdAt,
      updatedAt: meta.updatedAt ?? createdAt,
      outputSize: meta.outputSize ?? 0,
      tags: [...(meta.tags ?? [])],
      aiLabels: [...(meta.aiLabels ?? [])]
    };
  }

  private async requireSessionMeta(sessionId: string): Promise<SessionMeta> {
    const meta = await this.readSessionMeta(sessionId);
    if (!meta) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return meta;
  }

  private async readIndex(): Promise<SessionIndexEntry[]> {
    return readJsonFile<SessionIndexEntry[]>(this.paths.sessionIndexFile, []);
  }

  private async upsertIndexEntry(meta: SessionMeta): Promise<void> {
    return this.withIndexQueue(async () => {
      const index = await this.readIndex();
      const entry = toIndexEntry(meta);
      const existingIndex = index.findIndex((candidate) => candidate.sessionId === meta.sessionId);

      if (existingIndex >= 0) {
        index[existingIndex] = entry;
      } else {
        index.push(entry);
      }

      index.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      await writeJsonAtomic(this.paths.sessionIndexFile, index);
    });
  }

  private async updateSessionMetaUnlocked(
    sessionId: string,
    patch: Partial<Omit<SessionMeta, 'sessionId'>>
  ): Promise<SessionMeta> {
    const existing = await this.requireSessionMeta(sessionId);
    const updated = this.normalizeMeta({
      ...existing,
      ...patch,
      sessionId,
      updatedAt: patch.updatedAt ?? this.now()
    });

    await writeJsonAtomic(this.metaFile(sessionId), updated);
    await this.upsertIndexEntry(updated);

    return updated;
  }

  private withSessionQueue<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(task);
    const tracked = current.catch(() => undefined).finally(() => {
      if (this.sessionQueues.get(sessionId) === tracked) {
        this.sessionQueues.delete(sessionId);
      }
    });
    this.sessionQueues.set(sessionId, tracked);
    return current;
  }

  private withIndexQueue<T>(task: () => Promise<T>): Promise<T> {
    const current = this.indexQueue.catch(() => undefined).then(task);
    this.indexQueue = current;
    return current;
  }

  private metaFile(sessionId: string): string {
    return getSessionFile(this.paths, sessionId, 'meta.json');
  }

  private transcriptFile(sessionId: string): string {
    return getSessionFile(this.paths, sessionId, 'transcript.jsonl');
  }

  private outputFile(sessionId: string): string {
    return getSessionFile(this.paths, sessionId, 'output.log');
  }

  private eventsFile(sessionId: string): string {
    return getSessionFile(this.paths, sessionId, 'events.jsonl');
  }
}

function toIndexEntry(meta: SessionMeta): SessionIndexEntry {
  return {
    sessionId: meta.sessionId,
    userId: meta.userId,
    username: meta.username,
    role: meta.role,
    agentType: meta.agentType,
    chipId: meta.chipId,
    chipLabel: meta.chipLabel,
    documentId: meta.documentId,
    scopePresetId: meta.scopePresetId,
    scopeDescriptor: meta.scopeDescriptor,
    scopeWorkspace: meta.scopeWorkspace,
    usedSources: meta.usedSources,
    sourceCitationSummary: meta.sourceCitationSummary,
    cwd: meta.cwd,
    task: meta.task,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastMessageAt: meta.lastMessageAt,
    claudeSessionId: meta.claudeSessionId,
    sessionMode: meta.sessionMode,
    chatMode: meta.chatMode,
    modelId: meta.modelId,
    claudeModelRole: meta.claudeModelRole,
    creditUnits: meta.creditUnits,
    creditReservation: meta.creditReservation,
    pipelineType: meta.pipelineType,
    turnState: meta.turnState,
    turnCount: meta.turnCount,
    lastTurnResult: meta.lastTurnResult,
    outputSize: meta.outputSize,
    source: meta.source,
    tags: [...meta.tags],
    adminNotes: meta.adminNotes,
    aiSummary: meta.aiSummary,
    aiLabels: [...meta.aiLabels]
  };
}

function sessionHistoryTimestamp(entry: Pick<SessionIndexEntry, 'lastMessageAt' | 'updatedAt' | 'createdAt'>): string {
  return entry.lastMessageAt ?? entry.updatedAt ?? entry.createdAt;
}

function paginate<T>(items: T[], options: UserSessionListOptions): { items: T[]; offset: number; limit: number } {
  const offset = Math.max(0, options.offset ?? 0);
  const requestedLimit = options.limit === undefined ? MAX_USER_HISTORY_LIMIT : Math.max(0, options.limit);
  const limit = Math.min(requestedLimit, MAX_USER_HISTORY_LIMIT);

  return {
    items: items.slice(offset, offset + limit),
    offset,
    limit
  };
}

function toUserSessionHistorySummary(entry: SessionIndexEntry): UserSessionHistorySummary {
  return {
    sessionId: entry.sessionId,
    userId: entry.userId,
    username: entry.username,
    role: entry.role,
    agentType: entry.agentType,
    chipId: entry.chipId,
    chipLabel: entry.chipLabel,
    documentId: entry.documentId,
    scopePresetId: entry.scopePresetId,
    scopeDescriptor: entry.scopeDescriptor,
    scopeWorkspace: entry.scopeWorkspace,
    usedSources: entry.usedSources,
    sourceCitationSummary: entry.sourceCitationSummary,
    task: entry.task,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastMessageAt: entry.lastMessageAt,
    claudeSessionId: entry.claudeSessionId,
    sessionMode: entry.sessionMode,
    chatMode: entry.chatMode,
    modelId: entry.modelId,
    claudeModelRole: entry.claudeModelRole,
    creditUnits: entry.creditUnits,
    pipelineType: entry.pipelineType,
    turnState: entry.turnState,
    turnCount: entry.turnCount,
    lastTurnResult: entry.lastTurnResult,
    source: entry.source,
    tags: [...entry.tags],
    aiSummary: entry.aiSummary,
    aiLabels: [...entry.aiLabels]
  };
}

function isUserHistoryTranscriptEntry(entry: TranscriptEntry): entry is Extract<TranscriptEntry, { role: 'user' | 'assistant' }> {
  return entry.role === 'user' || entry.role === 'assistant';
}

function toUserHistoryTranscriptEntry(entry: Extract<TranscriptEntry, { role: 'user' | 'assistant' }>): UserHistoryTranscriptEntry {
  return {
    turnId: entry.turnId,
    role: entry.role,
    text: entry.text,
    createdAt: entry.createdAt,
    chatMode: entry.chatMode,
    modelId: entry.modelId,
    claudeModelRole: entry.claudeModelRole,
    creditUnits: entry.creditUnits,
    ...(entry.role === 'assistant' && entry.sourceCitationSummary ? { sourceCitationSummary: entry.sourceCitationSummary } : {})
  };
}
