import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupRetention, resolveRetentionPolicy } from '../src/observability/retention.js';
import { createPersistencePaths } from '../src/persistence/paths.js';

describe('observability retention cleanup', () => {
  it('uses default and env-configurable retention days', () => {
    expect(resolveRetentionPolicy({})).toEqual({ rawDebugDays: 30, auditDays: 180, metricsDays: 365 });
    expect(resolveRetentionPolicy({ AGENTX_RETENTION_RAW_DEBUG_DAYS: '7' })).toMatchObject({ rawDebugDays: 7 });
  });

  it('deletes only expired raw/debug files under dataDir', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-retention-'));
    const paths = createPersistencePaths(dataDir);
    const sessionDir = path.join(paths.sessionsDir, 'session-1');
    await mkdir(sessionDir, { recursive: true });
    const oldOutput = path.join(sessionDir, 'output.log');
    const oldDebug = path.join(sessionDir, 'debug.json');
    const transcript = path.join(sessionDir, 'transcript.jsonl');
    await writeFile(oldOutput, 'raw debug', 'utf8');
    await writeFile(oldDebug, '{"sessionId":"session-1"}\n', 'utf8');
    await writeFile(transcript, 'keep', 'utf8');
    const old = new Date('2026-01-01T00:00:00.000Z');
    await utimes(oldOutput, old, old);
    await utimes(oldDebug, old, old);
    await cleanupRetention(paths, {
      policy: { rawDebugDays: 30, auditDays: 180, metricsDays: 365 },
      now: new Date('2026-03-01T00:00:00.000Z')
    });

    expect(existsSync(oldOutput)).toBe(false);
    expect(existsSync(oldDebug)).toBe(false);
    await expect(stat(transcript)).resolves.toBeTruthy();
  });

  it('skips cleanup roots outside dataDir before scanning them', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-retention-root-'));
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'agentx-retention-outside-'));
    const outsideFile = path.join(outsideDir, 'output.log');
    await writeFile(outsideFile, 'outside raw debug', 'utf8');
    const old = new Date('2026-01-01T00:00:00.000Z');
    await utimes(outsideFile, old, old);

    const paths = {
      ...createPersistencePaths(dataDir),
      sessionsDir: outsideDir
    };
    const result = await cleanupRetention(paths, {
      policy: { rawDebugDays: 30, auditDays: 180, metricsDays: 365 },
      now: new Date('2026-03-01T00:00:00.000Z')
    });

    expect(result.skipped).toContain(outsideDir);
    await expect(stat(outsideFile)).resolves.toBeTruthy();
  });
});
