import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildObservabilityMetrics } from '../src/observability/metrics.js';
import { SessionHistoryStore } from '../src/persistence/session-history-store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('observability metrics', () => {
  it('aggregates calls, models, entries, users, credits and failures without prompt text', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-metrics-'));
    dirs.push(dataDir);
    const store = new SessionHistoryStore({ dataDir });
    await store.createSession({
      sessionId: 's1',
      userId: 'u1',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      cwd: 'D:/secret/workspace',
      task: 'private prompt text',
      source: 'web',
      modelId: 'haiku',
      creditUnits: 50,
      createdAt: '2026-05-29T00:00:00.000Z'
    });
    await store.updateSessionMeta('s1', {
      outputSize: 200,
      lastTurnResult: {
        status: 'error',
        finishedAt: '2026-05-29T00:00:02.000Z',
        exitCode: 1,
        signal: null,
        totalOutputChars: 200,
        error: 'timeout in D:/secret/workspace with api_key=sk-private'
      }
    });

    const metrics = await buildObservabilityMetrics({
      sessionStore: store,
      creditRecords: [{
        id: 'c1',
        userId: 'u1',
        username: 'alice',
        entry: 'chat',
        modelId: 'haiku',
        units: 50,
        status: 'charged',
        reason: 'session_turn',
        createdAt: '2026-05-29T00:00:03.000Z',
        metadata: { keyFingerprint: 'fp_123' }
      }]
    });

    expect(metrics.summary).toMatchObject({ calls: 1, creditsUnits: 50, failureRate: 1 });
    expect(metrics.breakdown.byEntry.web.calls).toBe(1);
    expect(metrics.breakdown.byModel['haiku'].creditsUnits).toBe(50);
    expect(metrics.breakdown.byMcpKey.fp_123.calls).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain('private prompt text');
    expect(JSON.stringify(metrics)).not.toContain('D:/secret/workspace');
    expect(JSON.stringify(metrics)).not.toContain('sk-private');
    expect(JSON.stringify(metrics.breakdown.byFailureReason)).toContain('[REDACTED_PATH]');
    expect(JSON.stringify(metrics.breakdown.byFailureReason)).toContain('[REDACTED_SECRET]');
  });

  it('filters sessions and credit records by the selected observation window', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-metrics-range-'));
    dirs.push(dataDir);
    const store = new SessionHistoryStore({ dataDir });
    await store.createSession({
      sessionId: 'inside',
      userId: 'u1',
      username: 'inside-user',
      role: 'customer',
      agentType: 'claude-code',
      cwd: dataDir,
      task: 'inside',
      source: 'web',
      modelId: 'haiku',
      creditUnits: 10,
      createdAt: '2026-07-04T10:00:00.000Z'
    });
    await store.createSession({
      sessionId: 'outside',
      userId: 'u2',
      username: 'outside-user',
      role: 'customer',
      agentType: 'claude-code',
      cwd: dataDir,
      task: 'outside',
      source: 'mcp',
      modelId: 'opus',
      creditUnits: 90,
      createdAt: '2026-06-01T10:00:00.000Z'
    });

    const metrics = await buildObservabilityMetrics({
      sessionStore: store,
      creditRecords: [
        {
          id: 'inside-credit',
          userId: 'u1',
          username: 'inside-user',
          entry: 'chat',
          modelId: 'haiku',
          units: 10,
          status: 'charged',
          reason: 'session_turn',
          createdAt: '2026-07-04T10:01:00.000Z'
        },
        {
          id: 'outside-credit',
          userId: 'u2',
          username: 'outside-user',
          entry: 'mcp',
          modelId: 'opus',
          units: 90,
          status: 'charged',
          reason: 'session_turn',
          createdAt: '2026-06-01T10:01:00.000Z'
        }
      ],
      window: {
        from: '2026-07-04T00:00:00.000Z',
        to: '2026-07-05T00:00:00.000Z'
      }
    });

    expect(metrics.summary.calls).toBe(1);
    expect(metrics.summary.creditsUnits).toBe(10);
    expect(metrics.breakdown.byEntry.web.calls).toBe(1);
    expect(metrics.breakdown.byEntry.mcp).toBeUndefined();
    expect(metrics.breakdown.byUser['inside-user'].calls).toBe(1);
    expect(metrics.breakdown.byUser['outside-user']).toBeUndefined();
  });
});
