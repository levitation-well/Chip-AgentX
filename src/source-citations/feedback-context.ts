import crypto from 'node:crypto';
import type { SessionMeta, SessionSource, TranscriptEntry } from '../persistence/index.js';
import type { ChatMode } from '../types.js';
import {
  projectAssistantOutput,
  sanitizePersistedAssistantText,
  type AssistantOutputProjection
} from '../server/assistant-output-protocol.js';
import {
  assertNoUnsafeSourceCitationFields,
  createSourceCitationSummary,
  type PublicSourceCitationDto,
  type SourceCitationSummary,
  type UsedSourceRecord
} from './index.js';

export type FeedbackReviewSignal = 'normal' | 'high_priority';

export interface FeedbackContextInput {
  sessionId: string;
  turnId?: string;
  messageId?: string;
  feedbackTypes: string[];
  note?: string;
}

export interface FeedbackContextSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  entry: SessionSource;
  sessionId: string;
  turnId?: string;
  userId?: string;
  chatMode?: ChatMode;
  modelId?: string;
  creditUnits?: number;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  promptVersion?: string;
  configVersion: 'phase40-feedback-context-v1';
  resourceVersion?: string;
  feedbackTypes: string[];
  reviewSignal: FeedbackReviewSignal;
  note?: string;
  answerTextHash: string;
  answerExcerpt?: string;
  outputMeta: AssistantOutputProjection['metadata'];
  sourceCitationSummary: SourceCitationSummary;
  usedSources: PublicSourceCitationDto[];
}

export interface BuildFeedbackContextSnapshotOptions {
  meta: SessionMeta;
  transcript: TranscriptEntry[];
  output: string;
  input: FeedbackContextInput;
  entry: SessionSource;
  now?: () => string;
}

const ALLOWED_FEEDBACK_TYPES = new Set([
  'useful',
  'off-target',
  'missing-context',
  'bad-citation',
  'too-long',
  'safety-risk',
  'deeper-answer'
]);
const HIGH_PRIORITY_FEEDBACK_TYPES = new Set(['bad-citation', 'safety-risk']);
const MAX_NOTE_LENGTH = 1000;
const MAX_ANSWER_EXCERPT_LENGTH = 1200;

export class FeedbackContextError extends Error {
  readonly statusCode = 400;
}

export class FeedbackContextNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super('Session or message not found');
  }
}

export function normalizeFeedbackContextInput(value: unknown): FeedbackContextInput {
  if (!isRecord(value)) {
    throw new FeedbackContextError('Expected JSON feedback payload');
  }
  const sessionId = sanitizeIdentifier(value.sessionId);
  if (!sessionId) {
    throw new FeedbackContextError('sessionId is required');
  }
  const feedbackTypes = normalizeFeedbackTypes(value.feedbackTypes);
  if (feedbackTypes.length === 0) {
    throw new FeedbackContextError('feedbackTypes is required');
  }

  return {
    sessionId,
    turnId: sanitizeIdentifier(value.turnId),
    messageId: sanitizeIdentifier(value.messageId),
    feedbackTypes,
    note: sanitizeSafeText(value.note, MAX_NOTE_LENGTH)
  };
}

export function buildFeedbackContextSnapshot(
  options: BuildFeedbackContextSnapshotOptions
): FeedbackContextSnapshot {
  const requestedTurnId = options.input.turnId ?? options.input.messageId;
  const answerProjection = projectFeedbackAnswer(options.meta, options.transcript, options.output, requestedTurnId);
  const turnId = requestedTurnId ?? findLatestAssistantTurnId(options.transcript);
  if (requestedTurnId && !turnId) {
    throw new FeedbackContextNotFoundError();
  }

  const safeFeedbackTypes = normalizeFeedbackTypes(options.input.feedbackTypes);
  const sourceCitationSummary = answerProjection.metadata.citations;
  const snapshot = stripUndefined({
    schemaVersion: 1,
    capturedAt: options.now?.() ?? new Date().toISOString(),
    entry: options.entry,
    sessionId: options.meta.sessionId,
    turnId,
    userId: options.meta.userId,
    chatMode: options.meta.chatMode,
    modelId: options.meta.modelId,
    creditUnits: options.meta.creditUnits,
    chipId: options.meta.chipId,
    documentId: options.meta.documentId,
    scopePresetId: options.meta.scopePresetId,
    configVersion: 'phase40-feedback-context-v1',
    feedbackTypes: safeFeedbackTypes,
    reviewSignal: safeFeedbackTypes.some((type) => HIGH_PRIORITY_FEEDBACK_TYPES.has(type)) ? 'high_priority' : 'normal',
    note: sanitizeSafeText(options.input.note, MAX_NOTE_LENGTH),
    answerTextHash: hashAnswerText(answerProjection.text),
    answerExcerpt: sanitizeSafeText(answerProjection.text, MAX_ANSWER_EXCERPT_LENGTH),
    outputMeta: answerProjection.metadata,
    sourceCitationSummary,
    usedSources: sourceCitationSummary.sources.map((source) => ({ ...source }))
  }) as unknown as FeedbackContextSnapshot;

  assertNoUnsafeSourceCitationFields(snapshot.sourceCitationSummary);
  assertNoUnsafeSnapshotFields(snapshot);
  return snapshot;
}

function projectFeedbackAnswer(
  meta: SessionMeta,
  transcript: TranscriptEntry[],
  output: string,
  requestedTurnId: string | undefined
): AssistantOutputProjection {
  const projectionOptions = {
    allowAssistantFallback: true,
    ...safeSourceProjectionOptions(meta)
  };
  const outputSlice = sliceOutputForTurn(transcript, output, requestedTurnId);
  const projectedFromOutput = projectAssistantOutput(outputSlice, projectionOptions);
  if (projectedFromOutput.text || !requestedTurnId) {
    return projectedFromOutput;
  }

  const assistant = transcript.find(
    (entry): entry is Extract<TranscriptEntry, { role: 'assistant' }> =>
      entry.role === 'assistant' && entry.turnId === requestedTurnId
  );
  if (!assistant) {
    throw new FeedbackContextNotFoundError();
  }
  return projectAssistantOutput(sanitizePersistedAssistantText(assistant.text), projectionOptions);
}

function safeSourceProjectionOptions(meta: SessionMeta): {
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
} {
  if (meta.usedSources) {
    return { usedSources: meta.usedSources };
  }
  if (meta.sourceCitationSummary) {
    return { sourceCitationSummary: meta.sourceCitationSummary };
  }
  return { sourceCitationSummary: createSourceCitationSummary([]) };
}

function sliceOutputForTurn(transcript: TranscriptEntry[], output: string, turnId: string | undefined): string {
  if (!turnId) {
    return output;
  }
  const userIndex = transcript.findIndex((entry) => entry.role === 'user' && entry.turnId === turnId);
  const user = userIndex >= 0 ? transcript[userIndex] : undefined;
  if (!user || user.role !== 'user' || user.outputStart === undefined) {
    return '';
  }
  const nextUser = transcript.slice(userIndex + 1).find((entry) => entry.role === 'user');
  return output.slice(user.outputStart, nextUser?.role === 'user' ? nextUser.outputStart : undefined);
}

function findLatestAssistantTurnId(transcript: TranscriptEntry[]): string | undefined {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry?.role === 'assistant' && entry.turnId) {
      return entry.turnId;
    }
  }
  return transcript.find((entry) => entry.role === 'user' && entry.turnId)?.turnId;
}

function normalizeFeedbackTypes(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const result: string[] = [];
  for (const entry of values) {
    const type = sanitizeIdentifier(entry);
    if (type && ALLOWED_FEEDBACK_TYPES.has(type) && !result.includes(type)) {
      result.push(type);
    }
  }
  return result.slice(0, 10);
}

function sanitizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  if (!text || isUnsafeText(text)) {
    return undefined;
  }
  const safe = text.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 160);
  return safe || undefined;
}

function sanitizeSafeText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim().slice(0, limit);
  if (!text) {
    return undefined;
  }
  const safe = text
    .replace(/\b(?:authorization|cookie|password|secret|token|api[_-]?key|jwt)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]+/g, '[redacted-path]')
    .replace(/(^|\s)\/(?:srv|opt|home|var|tmp|workspace|etc|root)\/[^\s"'<>]+/gi, '$1[redacted-path]')
    .replace(/\\\\[^\s"'<>]+/g, '[redacted-path]')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe || undefined;
}

function hashAnswerText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function assertNoUnsafeSnapshotFields(snapshot: FeedbackContextSnapshot): void {
  const serialized = JSON.stringify(snapshot);
  if (
    /(?:sourcePath|workspacePath|serverPath|internalManifestPath|knowledgeBaseRoot|sourceRoot)/i.test(serialized) ||
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?:srv|opt|home|var|tmp|workspace|etc|root)\b)/i.test(serialized) ||
    /\b(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|jwt)\s*[:=]/i.test(serialized) ||
    /\bsk-[A-Za-z0-9_-]{16,}\b/.test(serialized)
  ) {
    throw new FeedbackContextError('Feedback snapshot contains unsafe fields');
  }
}

function isUnsafeText(value: string): boolean {
  return /(?:[A-Za-z]:[\\/]|\\\\|\/(?:srv|opt|home|var|tmp|workspace|etc|root)\b)/i.test(value) ||
    /\b(?:authorization|cookie|password|secret|api[_-]?key|token|jwt)\s*[:=]/i.test(value);
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
