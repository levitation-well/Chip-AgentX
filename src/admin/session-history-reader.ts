import { QuestionLedger, type QuestionQuery, type QuestionQueryResult } from '../persistence/question-ledger.js';
import {
  SessionHistoryStore,
  type SessionEventRecord,
  type SessionIndexEntry,
  type SessionMeta,
  type TranscriptEntry,
  type TurnResult
} from '../persistence/session-history-store.js';
import { redactDebugText, redactDebugValue } from '../observability/redaction.js';

export interface SessionHistoryListQuery {
  userId?: string;
  username?: string;
  role?: string;
  chipId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  offset?: number;
  limit?: number;
}

export interface SessionHistoryDetailOptions {
  offset?: number;
  limit?: number;
  includeOutputTail?: number;
}

export interface SessionAnalysisPackageOptions {
  offset?: number;
  limit?: number;
  includeOutputTail?: number;
  questionQuery?: Omit<QuestionQuery, 'offset' | 'limit'> & { offset?: number; limit?: number };
}

export interface AdminSessionDetail {
  meta: SessionMeta;
  transcript: TranscriptEntry[];
  events: SessionEventRecord[];
  outputTail?: { output: string; totalChars: number; offset: number; limit: number };
}

export interface SessionAnalysisPackage {
  meta: SessionMeta;
  transcript: TranscriptEntry[];
  questions: QuestionQueryResult;
  outputTail?: { output: string; totalChars: number; offset: number; limit: number };
}

export async function listAdminSessions(
  store: SessionHistoryStore,
  query: SessionHistoryListQuery = {}
): Promise<{ items: SessionIndexEntry[]; total: number; offset: number; limit: number }> {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(500, Math.max(0, query.limit ?? 100));
  const keyword = query.keyword?.trim().toLocaleLowerCase();
  const items = (await store.readSessionIndex())
    .filter((entry) => matchesValue(entry.userId, query.userId))
    .filter((entry) => matchesValue(entry.username, query.username))
    .filter((entry) => matchesValue(entry.role, query.role))
    .filter((entry) => matchesValue(entry.chipId, query.chipId))
    .filter((entry) => !query.from || getSessionSortValue(entry) >= query.from!)
    .filter((entry) => !query.to || getSessionSortValue(entry) <= query.to!)
    .filter((entry) => !keyword || matchesSessionKeyword(entry, keyword))
    .sort((left, right) => getSessionSortValue(right).localeCompare(getSessionSortValue(left)));

  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    offset,
    limit
  };
}

export async function readAdminSessionDetail(
  store: SessionHistoryStore,
  sessionId: string,
  options: SessionHistoryDetailOptions = {}
): Promise<AdminSessionDetail> {
  const meta = await requireMeta(store, sessionId);
  const transcript = await store.readTranscript(sessionId, { offset: options.offset, limit: options.limit });
  const events = await store.readEvents(sessionId);
  const detail: AdminSessionDetail = { meta, transcript, events };

  if (options.includeOutputTail && options.includeOutputTail > 0) {
    const outputTail = await store.tailOutput(sessionId, options.includeOutputTail);
    detail.outputTail = {
      ...outputTail,
      output: redactDebugText(outputTail.output).text
    };
  }

  return redactDebugValue(detail);
}

export async function queryAdminQuestions(
  ledger: QuestionLedger,
  query: QuestionQuery = {}
): Promise<QuestionQueryResult> {
  return ledger.queryQuestions(query);
}

export async function readSessionAnalysisPackage(
  store: SessionHistoryStore,
  ledger: QuestionLedger,
  sessionId: string,
  options: SessionAnalysisPackageOptions = {}
): Promise<SessionAnalysisPackage> {
  const detail = await readAdminSessionDetail(store, sessionId, {
    offset: options.offset,
    limit: options.limit,
    includeOutputTail: options.includeOutputTail
  });
  const questions = await ledger.queryQuestions({
    ...options.questionQuery,
    sessionId
  });

  return {
    meta: detail.meta,
    transcript: detail.transcript,
    questions,
    ...(detail.outputTail ? { outputTail: detail.outputTail } : {})
  };
}

export type { TurnResult };

function matchesValue(actual: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}

function matchesSessionKeyword(entry: SessionIndexEntry, keyword: string): boolean {
  return [
    entry.sessionId,
    entry.title,
    entry.task,
    entry.agentType,
    entry.chipId,
    entry.chipLabel,
    entry.username,
    entry.role,
    entry.lastTurnResult?.error
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .some((value) => value.toLocaleLowerCase().includes(keyword));
}

function getSessionSortValue(entry: SessionIndexEntry): string {
  return entry.lastMessageAt ?? entry.updatedAt ?? entry.createdAt;
}

async function requireMeta(store: SessionHistoryStore, sessionId: string): Promise<SessionMeta> {
  const meta = await store.readSessionMeta(sessionId);
  if (!meta) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return meta;
}
