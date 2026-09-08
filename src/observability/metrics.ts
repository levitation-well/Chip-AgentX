import type { CreditLedgerRecord } from '../credits.js';
import type { SessionHistoryStore, SessionIndexEntry } from '../persistence/session-history-store.js';
import { redactDebugText } from './redaction.js';

export interface ObservabilityMetrics {
  summary: {
    calls: number;
    creditsUnits: number;
    estimatedTokens: number;
    averageLatencyMs: number;
    failureRate: number;
  };
  breakdown: {
    byEntry: Record<string, MetricBucket>;
    byModel: Record<string, MetricBucket>;
    byUser: Record<string, MetricBucket>;
    byMcpKey: Record<string, MetricBucket>;
    byFailureReason: Record<string, MetricBucket>;
  };
  anomalies: ObservabilityAnomaly[];
}

export interface MetricBucket {
  calls: number;
  creditsUnits: number;
  estimatedTokens: number;
  failures: number;
  averageLatencyMs: number;
}

export interface ObservabilityAnomaly {
  type: 'high_credits' | 'high_failure_rate' | 'large_output';
  key: string;
  value: number;
}

export interface ObservabilityWindow {
  from?: string;
  to?: string;
}

export async function buildObservabilityMetrics(input: {
  sessionStore: SessionHistoryStore;
  creditRecords?: CreditLedgerRecord[];
  window?: ObservabilityWindow;
}): Promise<ObservabilityMetrics> {
  const sessions = (await input.sessionStore.readSessionIndex())
    .filter((session) => isWithinWindow(sessionObservedAt(session), input.window));
  const creditRecords = (input.creditRecords ?? [])
    .filter((record) => isWithinWindow(record.createdAt, input.window));
  const buckets = createBreakdown();
  let totalLatency = 0;
  let latencyCount = 0;
  let failures = 0;
  let estimatedTokens = 0;

  for (const session of sessions) {
    const latency = estimateLatencyMs(session);
    if (latency !== undefined) {
      totalLatency += latency;
      latencyCount += 1;
    }
    if (session.lastTurnResult?.status === 'error') failures += 1;
    estimatedTokens += estimateTokens(session);
    const creditsUnits = session.creditUnits ?? 0;
    addBucket(buckets.byEntry, session.source ?? 'unknown', creditsUnits, estimateTokens(session), session.lastTurnResult?.status === 'error', latency);
    addBucket(buckets.byModel, session.modelId ?? 'unknown', creditsUnits, estimateTokens(session), session.lastTurnResult?.status === 'error', latency);
    addBucket(buckets.byUser, session.username ?? session.userId ?? 'anonymous', creditsUnits, estimateTokens(session), session.lastTurnResult?.status === 'error', latency);
    addBucket(
      buckets.byFailureReason,
      getSafeFailureReason(session.lastTurnResult?.error),
      creditsUnits,
      estimateTokens(session),
      session.lastTurnResult?.status === 'error',
      latency
    );
  }

  for (const record of creditRecords) {
    addBucket(buckets.byMcpKey, getSafeMcpKeyBucket(record), record.units, 0, record.status === 'failure', undefined);
  }

  const calls = sessions.length;
  const creditsUnits = creditRecords.reduce((sum, record) => sum + Math.max(0, record.units), 0) ||
    sessions.reduce((sum, session) => sum + (session.creditUnits ?? 0), 0);

  return {
    summary: {
      calls,
      creditsUnits,
      estimatedTokens,
      averageLatencyMs: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
      failureRate: calls > 0 ? failures / calls : 0
    },
    breakdown: buckets,
    anomalies: detectAnomalies(sessions, buckets)
  };
}

function isWithinWindow(value: string | undefined, window: ObservabilityWindow | undefined): boolean {
  if (!window || (!window.from && !window.to)) return true;
  if (!value) return false;
  if (window.from && value < window.from) return false;
  if (window.to && value > window.to) return false;
  return true;
}

function sessionObservedAt(session: SessionIndexEntry): string | undefined {
  return session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
}

function createBreakdown(): ObservabilityMetrics['breakdown'] {
  return { byEntry: {}, byModel: {}, byUser: {}, byMcpKey: {}, byFailureReason: {} };
}

function addBucket(
  target: Record<string, MetricBucket>,
  key: string,
  creditsUnits: number,
  tokens: number,
  failed: boolean,
  latencyMs: number | undefined
): void {
  const bucket = target[key] ?? { calls: 0, creditsUnits: 0, estimatedTokens: 0, failures: 0, averageLatencyMs: 0 };
  const previousLatencyTotal = bucket.averageLatencyMs * bucket.calls;
  bucket.calls += 1;
  bucket.creditsUnits += creditsUnits;
  bucket.estimatedTokens += tokens;
  if (failed) bucket.failures += 1;
  bucket.averageLatencyMs = latencyMs === undefined ? bucket.averageLatencyMs : Math.round((previousLatencyTotal + latencyMs) / bucket.calls);
  target[key] = bucket;
}

function estimateTokens(session: SessionIndexEntry): number {
  return Math.ceil(((session.task?.length ?? 0) + (session.outputSize ?? 0)) / 4);
}

function estimateLatencyMs(session: SessionIndexEntry): number | undefined {
  const start = Date.parse(session.createdAt);
  const end = Date.parse(session.lastTurnResult?.finishedAt ?? session.lastMessageAt ?? '');
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function getSafeMcpKeyBucket(record: CreditLedgerRecord): string {
  const metadata = record.metadata ?? {};
  const fingerprint = metadata.keyFingerprint;
  return typeof fingerprint === 'string' && fingerprint ? fingerprint : 'unknown';
}

function getSafeFailureReason(error: string | undefined): string {
  if (!error) return 'none';
  return redactDebugText(error).text;
}

function detectAnomalies(sessions: SessionIndexEntry[], buckets: ObservabilityMetrics['breakdown']): ObservabilityAnomaly[] {
  const anomalies: ObservabilityAnomaly[] = [];
  for (const [key, bucket] of Object.entries(buckets.byUser)) {
    if (bucket.creditsUnits >= 1000) anomalies.push({ type: 'high_credits', key, value: bucket.creditsUnits });
    if (bucket.calls >= 5 && bucket.failures / bucket.calls >= 0.5) {
      anomalies.push({ type: 'high_failure_rate', key, value: bucket.failures / bucket.calls });
    }
  }
  for (const session of sessions) {
    if ((session.outputSize ?? 0) >= 200000) {
      anomalies.push({ type: 'large_output', key: session.sessionId, value: session.outputSize });
    }
  }
  return anomalies;
}
