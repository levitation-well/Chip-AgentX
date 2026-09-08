import crypto from 'node:crypto';
import path from 'node:path';

import { appendJsonLine, readJsonLines } from './persistence/json-file.js';
import type { UserStore } from './auth/user-store.js';
import { normalizeClaudeModelRole } from './model-routing.js';

export { DEFAULT_CREDIT_UNITS } from './auth/user-store.js';

export const CREDIT_UNITS_PER_CREDIT = 100;
export const MODEL_CREDIT_UNITS = {
  haiku: 50,
  sonnet: 100,
  opus: 150,
  fable: 50,
  'deepseek-v4-flash': 50,
  'deepseek-v4-pro': 100,
  'mimo-v2.5': 150
} as const;

export type CreditModelId = keyof typeof MODEL_CREDIT_UNITS;
export type CreditLedgerStatus = 'charged' | 'free' | 'failure';
export type CreditLedgerEntryKind = 'chat' | 'mcp' | 'admin' | 'system' | string;

export interface CreditLedgerRecord {
  id: string;
  userId: string;
  username?: string;
  entry: CreditLedgerEntryKind;
  modelId?: string;
  units: number;
  status: CreditLedgerStatus;
  reason: string;
  balanceBeforeUnits?: number;
  balanceAfterUnits?: number;
  sessionId?: string;
  requestId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CreditLedgerQuery {
  userId?: string;
  entry?: string;
  modelId?: string;
  sessionId?: string;
  status?: CreditLedgerStatus;
  from?: string;
  to?: string;
  offset?: number;
  limit?: number;
}

export interface CreditLedgerQueryResult {
  items: CreditLedgerRecord[];
  total: number;
  offset: number;
  limit: number;
}

export interface CreditLedgerOptions {
  dataDir?: string;
  ledgerFile?: string;
  now?: () => string;
}

export interface RecordCreditInput {
  userId: string;
  username?: string;
  entry: CreditLedgerEntryKind;
  modelId?: string;
  units?: number;
  reason: string;
  sessionId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChargeCreditInput extends RecordCreditInput {
  modelId: string;
}

export interface CreditReservation {
  reservationId: string;
  userId: string;
  units: number;
  balanceBeforeUnits: number;
  balanceAfterUnits: number;
}

export class CreditLedger {
  private readonly ledgerFile: string;
  private readonly now: () => string;

  constructor(options: CreditLedgerOptions = {}) {
    this.ledgerFile = options.ledgerFile ?? path.join(path.resolve(options.dataDir ?? './data'), 'credits', 'ledger.jsonl');
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async append(
    record: Omit<CreditLedgerRecord, 'id' | 'createdAt'> & Partial<Pick<CreditLedgerRecord, 'id' | 'createdAt'>>
  ): Promise<CreditLedgerRecord> {
    const normalized: CreditLedgerRecord = {
      ...record,
      id: record.id ?? crypto.randomUUID(),
      createdAt: record.createdAt ?? this.now(),
      metadata: sanitizeMetadata(record.metadata)
    };
    if (normalized.metadata && Object.keys(normalized.metadata).length === 0) {
      delete normalized.metadata;
    }

    await appendJsonLine(this.ledgerFile, normalized);
    return normalized;
  }

  async query({
    userId,
    entry,
    modelId,
    sessionId,
    status,
    from,
    to,
    offset = 0,
    limit = 100
  }: CreditLedgerQuery = {}): Promise<CreditLedgerQueryResult> {
    const boundedOffset = Math.max(0, offset);
    const boundedLimit = Math.min(500, Math.max(0, limit));
    const records = await readJsonLines<CreditLedgerRecord>(this.ledgerFile);
    const filtered = records
      .filter((record) => userId === undefined || record.userId === userId)
      .filter((record) => entry === undefined || record.entry === entry)
      .filter((record) => modelId === undefined || record.modelId === modelId)
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .filter((record) => status === undefined || record.status === status)
      .filter((record) => from === undefined || record.createdAt >= from)
      .filter((record) => to === undefined || record.createdAt <= to)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    return {
      items: filtered.slice(boundedOffset, boundedOffset + boundedLimit),
      total: filtered.length,
      offset: boundedOffset,
      limit: boundedLimit
    };
  }

  async queryAll({
    userId,
    entry,
    modelId,
    sessionId,
    status,
    from,
    to
  }: Omit<CreditLedgerQuery, 'offset' | 'limit'> = {}): Promise<CreditLedgerRecord[]> {
    const records = await readJsonLines<CreditLedgerRecord>(this.ledgerFile);
    return records
      .filter((record) => userId === undefined || record.userId === userId)
      .filter((record) => entry === undefined || record.entry === entry)
      .filter((record) => modelId === undefined || record.modelId === modelId)
      .filter((record) => sessionId === undefined || record.sessionId === sessionId)
      .filter((record) => status === undefined || record.status === status)
      .filter((record) => from === undefined || record.createdAt >= from)
      .filter((record) => to === undefined || record.createdAt <= to)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}

export class CreditService {
  constructor(
    private readonly users: Pick<
      UserStore,
      | 'debitCreditBalanceUnits'
      | 'getCreditBalanceUnits'
      | 'reserveCreditBalanceUnits'
      | 'releaseCreditReservation'
    >,
    private readonly ledger: CreditLedger
  ) {}

  async reserve(input: { userId: string; units: number }): Promise<CreditReservation> {
    if (!Number.isInteger(input.units) || input.units < 0) {
      throw new Error('Credit units must be a non-negative integer');
    }
    const reservationId = crypto.randomUUID();
    const debit = await this.users.reserveCreditBalanceUnits(input.userId, reservationId, input.units);
    return {
      reservationId,
      userId: input.userId,
      units: input.units,
      balanceBeforeUnits: debit.balanceBeforeUnits,
      balanceAfterUnits: debit.balanceAfterUnits
    };
  }

  async release(reservation: CreditReservation): Promise<void> {
    await this.users.releaseCreditReservation(reservation.reservationId);
  }

  async charge(input: ChargeCreditInput): Promise<CreditLedgerRecord> {
    let units = input.units;
    if (units === undefined) {
      try {
        units = getModelCreditUnits(input.modelId);
      } catch {
        const balance = await this.users.getCreditBalanceUnits(input.userId);
        return await this.ledger.append({
          ...baseLedgerInput(input),
          status: 'failure',
          units: 0,
          reason: input.reason || 'unknown_credit_model',
          balanceBeforeUnits: balance,
          balanceAfterUnits: balance
        });
      }
    }
    if (!Number.isInteger(units) || units < 0) {
      throw new Error('Credit units must be a non-negative integer');
    }

    try {
      const debit = await this.users.debitCreditBalanceUnits(input.userId, units);
      return await this.ledger.append({
        ...baseLedgerInput(input),
        status: 'charged',
        units,
        balanceBeforeUnits: debit.balanceBeforeUnits,
        balanceAfterUnits: debit.balanceAfterUnits
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Insufficient credits') {
        const balance = await this.users.getCreditBalanceUnits(input.userId);
        return await this.ledger.append({
          ...baseLedgerInput(input),
          status: 'failure',
          units: 0,
          reason: input.reason || 'insufficient_credits',
          balanceBeforeUnits: balance,
          balanceAfterUnits: balance
        });
      }
      throw error;
    }
  }

  async recordFree(input: RecordCreditInput): Promise<CreditLedgerRecord> {
    const balance = await this.users.getCreditBalanceUnits(input.userId);
    return await this.ledger.append({
      ...baseLedgerInput(input),
      status: 'free',
      units: 0,
      balanceBeforeUnits: balance,
      balanceAfterUnits: balance
    });
  }

  async recordFailure(input: RecordCreditInput): Promise<CreditLedgerRecord> {
    const balance = await this.users.getCreditBalanceUnits(input.userId);
    return await this.ledger.append({
      ...baseLedgerInput(input),
      status: 'failure',
      units: 0,
      balanceBeforeUnits: balance,
      balanceAfterUnits: balance
    });
  }
}

export function getModelCreditUnits(modelId: string): number {
  const normalized = normalizeClaudeModelRole(modelId) ?? modelId;
  const units = MODEL_CREDIT_UNITS[normalized as CreditModelId];
  if (units === undefined) {
    throw new Error(`Unknown credit model: ${modelId}`);
  }
  return units;
}

export function hasSufficientCredits(balanceUnits: number, costUnits: number): boolean {
  if (!Number.isInteger(balanceUnits) || !Number.isInteger(costUnits)) {
    throw new Error('Credit units must be integers');
  }
  return balanceUnits >= costUnits;
}

export function creditsToUnits(credits: number): number {
  const units = credits * CREDIT_UNITS_PER_CREDIT;
  if (!Number.isInteger(units)) {
    throw new Error('Credits must convert to integer units');
  }
  return units;
}

function baseLedgerInput(input: RecordCreditInput): Omit<CreditLedgerRecord, 'id' | 'createdAt' | 'status'> {
  return {
    userId: input.userId,
    username: input.username,
    entry: input.entry,
    modelId: input.modelId,
    units: input.units ?? 0,
    reason: input.reason,
    sessionId: input.sessionId,
    requestId: input.requestId,
    metadata: sanitizeMetadata(input.metadata)
  };
}

function sanitizeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !isSecretLikeKey(key))
      .map(([key, value]) => [key, sanitizeMetadataValue(value)])
  );
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadataValue);
  }
  if (value && typeof value === 'object') {
    return sanitizeMetadata(value as Record<string, unknown>);
  }
  return value;
}

function isSecretLikeKey(key: string): boolean {
  return /(key|authorization|bearer|jwt|password|secret|token)/i.test(key);
}
