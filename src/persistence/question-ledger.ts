import crypto from 'node:crypto';

import { appendJsonLine, readJsonLines } from './json-file.js';
import { createPersistencePaths, initializeDataLayout, type PersistencePaths } from './paths.js';
import type { ChatMode } from '../types.js';
import type { ClaudeModelRole } from '../model-routing.js';

export type QuestionSource = 'web' | 'mcp' | 'rpc' | 'cli';

export interface QuestionRecord {
  questionId: string;
  sessionId: string;
  turnId?: string;
  userId?: string;
  username?: string;
  role?: string;
  chipId?: string;
  chatMode?: ChatMode;
  modelId?: string;
  claudeModelRole?: ClaudeModelRole;
  creditUnits?: number;
  text: string;
  createdAt: string;
  source: QuestionSource;
}

export interface QuestionQuery {
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
}

export interface QuestionQueryResult {
  items: QuestionRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface QuestionLedgerOptions {
  dataDir?: string;
  paths?: PersistencePaths;
  now?: () => string;
}

export class QuestionLedger {
  private readonly paths: PersistencePaths;
  private readonly now: () => string;

  constructor(options: QuestionLedgerOptions = {}) {
    this.paths = options.paths ?? createPersistencePaths(options.dataDir ?? './data');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async init(): Promise<void> {
    await initializeDataLayout(this.paths);
  }

  async appendQuestion(
    record: Omit<QuestionRecord, 'questionId' | 'createdAt'> &
      Partial<Pick<QuestionRecord, 'questionId' | 'createdAt'>>
  ): Promise<QuestionRecord> {
    await this.init();
    const normalized: QuestionRecord = {
      ...record,
      questionId: record.questionId ?? crypto.randomUUID(),
      createdAt: record.createdAt ?? this.now()
    };

    await appendJsonLine(this.paths.questionsFile, normalized);
    return normalized;
  }

  async queryQuestions({
    sessionId,
    userId,
    username,
    role,
    chipId,
    from,
    to,
    keyword,
    offset = 0,
    limit = 100
  }: QuestionQuery = {}): Promise<QuestionQueryResult> {
    await this.init();
    const boundedOffset = Math.max(0, offset);
    const boundedLimit = Math.min(500, Math.max(0, limit));
    const lowerKeyword = keyword?.toLocaleLowerCase();
    const records = await readJsonLines<QuestionRecord>(this.paths.questionsFile);

    const filtered = records
      .filter((record) => matchesValue(record.sessionId, sessionId))
      .filter((record) => matchesValue(record.userId, userId))
      .filter((record) => matchesValue(record.username, username))
      .filter((record) => matchesValue(record.role, role))
      .filter((record) => matchesValue(record.chipId, chipId))
      .filter((record) => !from || record.createdAt >= from)
      .filter((record) => !to || record.createdAt <= to)
      .filter((record) => !lowerKeyword || record.text.toLocaleLowerCase().includes(lowerKeyword))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      items: filtered.slice(boundedOffset, boundedOffset + boundedLimit),
      total: filtered.length,
      offset: boundedOffset,
      limit: boundedLimit
    };
  }
}

function matchesValue(actual: string | undefined, expected: string | undefined): boolean {
  return expected === undefined || actual === expected;
}
