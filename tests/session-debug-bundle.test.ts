import { existsSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SessionDebugBundleStore,
  type SessionDebugStage
} from '../src/observability/session-debug-bundle.js';
import { createPersistencePaths } from '../src/persistence/paths.js';
import type { Logger, LogContext, LogLevel, LogRecord } from '../src/logging/logger.js';

describe('SessionDebugBundleStore', () => {
  it('writes and reads a debug bundle with raw prompt and secret content redacted', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-'));
    const warnings: LogRecord[] = [];
    const store = new SessionDebugBundleStore({
      paths: createPersistencePaths(root),
      logger: createTestLogger(warnings),
      now: () => new Date('2026-07-04T00:00:00.000Z')
    });

    await store.write('session-1', {
      type: '单芯片',
      systemPrompt: [
        'system prompt: keep this admin-only diagnostic prompt',
        'api_key=sk-test-secret',
        'cwd=D:\\repo\\chip-agentx\\private'
      ].join('\n'),
      stages: [
        {
          stage: 'cc.launch',
          status: 'ok',
          ts: '2026-07-04T00:00:01.000Z',
          artifact: {
            cwd: 'D:\\repo\\chip-agentx\\private',
            authorization: 'Bearer abc.def.ghijklmnopqrstuvwxyz',
            fileCount: 3
          }
        }
      ]
    });

    const bundle = await store.get('session-1');

    expect(warnings).toEqual([]);
    expect(bundle).toMatchObject({
      sessionId: 'session-1',
      type: '单芯片',
      createdAt: '2026-07-04T00:00:00.000Z'
    });
    expect(bundle?.systemPrompt).toMatchObject({
      truncated: false
    });
    expect(bundle?.systemPrompt?.chars).toBeGreaterThan(0);
    expect(bundle?.systemPrompt?.text).toContain('keep this admin-only diagnostic prompt');
    expect(bundle?.systemPrompt?.text).toContain('[REDACTED_SECRET]');
    expect(bundle?.systemPrompt?.text).toContain('[REDACTED_PATH]');
    expect(bundle?.systemPrompt?.text).not.toContain('sk-test-secret');
    expect(bundle?.systemPrompt?.text).not.toContain('D:\\repo\\chip-agentx\\private');
    expect(JSON.stringify(bundle?.stages[0]?.artifact)).toContain('[REDACTED_PATH]');
    expect(JSON.stringify(bundle?.stages[0]?.artifact)).toContain('[REDACTED_SECRET]');
  });

  it('serializes concurrent writes for the same session and preserves partial patches', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-merge-'));
    const store = new SessionDebugBundleStore({
      paths: createPersistencePaths(root),
      now: () => new Date('2026-07-04T00:00:00.000Z')
    });

    const firstStage: SessionDebugStage = {
      stage: 'scope.resolve',
      status: 'ok',
      ts: '2026-07-04T00:00:01.000Z',
      artifact: { chips: ['E521.31'] }
    };
    const secondStage: SessionDebugStage = {
      stage: 'cc.stage1',
      status: 'ok',
      ts: '2026-07-04T00:00:02.000Z',
      artifact: { candidates: ['E521.31'] }
    };

    await Promise.all([
      store.write('session-1', { type: '跨档两步', stages: [firstStage] }),
      store.write('session-1', { systemPrompt: 'system prompt: retained' }),
      store.write('session-1', { stages: [secondStage] })
    ]);

    const bundle = await store.get('session-1');

    expect(bundle?.type).toBe('跨档两步');
    expect(bundle?.systemPrompt?.text).toBe('system prompt: retained');
    expect(bundle?.stages.map((stage) => stage.stage).sort()).toEqual(['cc.stage1', 'scope.resolve']);
  });

  it('rejects unsafe session ids before touching the filesystem', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-safe-'));
    const store = new SessionDebugBundleStore({ paths: createPersistencePaths(root) });

    expect(() => store.write('../escape', { systemPrompt: 'x' })).toThrow(/Unsafe session id/);
    await expect(store.get('../escape')).rejects.toThrow(/Unsafe session id/);
  });

  it('swallows write failures and records a logger warning', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-fail-'));
    const sessionsFile = path.join(root, 'sessions-file');
    await writeFile(sessionsFile, 'not a directory', 'utf8');
    const warnings: LogRecord[] = [];
    const store = new SessionDebugBundleStore({
      paths: { ...createPersistencePaths(root), sessionsDir: sessionsFile },
      logger: createTestLogger(warnings)
    });

    await expect(store.write('session-1', { systemPrompt: 'system prompt: ok' })).resolves.toBeUndefined();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe('session_debug_bundle_write_failed');
    expect(JSON.stringify(warnings[0])).not.toContain(sessionsFile);
    expect(JSON.stringify(warnings[0])).toContain('[REDACTED_PATH]');
    expect(existsSync(path.join(sessionsFile, 'session-1', 'debug.json'))).toBe(false);
  });

  it('still resolves diagnostic write failures when logger sinks throw', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-logger-fail-'));
    const sessionsFile = path.join(root, 'sessions-file');
    await writeFile(sessionsFile, 'not a directory', 'utf8');
    const store = new SessionDebugBundleStore({
      paths: { ...createPersistencePaths(root), sessionsDir: sessionsFile },
      logger: {
        debug() { throw new Error('logger failed'); },
        info() { throw new Error('logger failed'); },
        warn() { throw new Error('logger failed'); },
        error() { throw new Error('logger failed'); },
        log() { throw new Error('logger failed'); }
      }
    });

    await expect(store.write('session-1', { systemPrompt: 'system prompt: ok' })).resolves.toBeUndefined();
  });

  it('applies text truncation and the 128KB soft limit before writing debug.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-limit-'));
    const paths = createPersistencePaths(root);
    const store = new SessionDebugBundleStore({
      paths,
      softLimitBytes: 2200,
      textFieldLimitChars: 6000
    });
    const largeText = 'x'.repeat(6000);

    await store.write('session-1', {
      stages: [
        {
          stage: 'cc.stage1',
          status: 'ok',
          ts: '2026-07-04T00:00:01.000Z',
          artifact: { rawText: largeText }
        }
      ]
    });

    const bundle = await store.get('session-1');
    const artifact = bundle?.stages[0]?.artifact as { rawText: { text: string; redacted: string[] } };
    const filePath = path.join(paths.sessionsDir, 'session-1', 'debug.json');
    const fileText = await readFile(filePath, 'utf8');

    expect(Buffer.byteLength(fileText, 'utf8')).toBeLessThanOrEqual(2200);
    expect(artifact.rawText.text).toContain('x');
    expect(artifact.rawText.text).not.toContain('[REDACTED_DEBUG_TEXT]');
    await expect(stat(filePath)).resolves.toBeTruthy();
  });

  it('keeps stage diagnostic text readable while redacting secrets, JWTs, and absolute paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-stage-text-'));
    const store = new SessionDebugBundleStore({
      paths: createPersistencePaths(root),
      now: () => new Date('2026-07-04T00:00:00.000Z')
    });

    await store.write('session-1', {
      stages: [
        {
          stage: 'cc.stage2',
          status: 'ok',
          artifact: {
            rawOutput: [
              'Final answer keeps useful datasheet evidence.',
              'Bearer abc.def.ghijklmnopqrstuvwxyz',
              'session claim eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.signaturepayload',
              'source=D:\\knowledge-bases\\E521.31\\datasheet.pdf'
            ].join('\n')
          }
        }
      ]
    });

    const bundle = await store.get('session-1');
    const artifact = bundle?.stages[0]?.artifact as { rawOutput: { text: string; redacted: string[] } };

    expect(artifact.rawOutput.text).toContain('Final answer keeps useful datasheet evidence.');
    expect(artifact.rawOutput.text).toContain('Bearer [REDACTED_SECRET]');
    expect(artifact.rawOutput.text).toContain('[REDACTED_JWT]');
    expect(artifact.rawOutput.text).toContain('[REDACTED_PATH]');
    expect(artifact.rawOutput.text).not.toContain('D:\\knowledge-bases');
    expect(artifact.rawOutput.redacted).toEqual(expect.arrayContaining(['jwt', 'path', 'token']));
  });

  it('replaces large nested artifacts when string truncation alone cannot satisfy the soft limit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-nested-limit-'));
    const paths = createPersistencePaths(root);
    const store = new SessionDebugBundleStore({
      paths,
      softLimitBytes: 1200,
      textFieldLimitChars: 6000
    });

    await store.write('session-1', {
      stages: [
        {
          stage: 'cc.stage1',
          status: 'ok',
          artifact: {
            candidates: Array.from({ length: 120 }, (_, index) => ({
              chipId: `E${index}`,
              reason: 'short reason'
            }))
          }
        }
      ]
    });

    const bundle = await store.get('session-1');
    const artifact = bundle?.stages[0]?.artifact as { truncated?: boolean; reason?: string };
    const filePath = path.join(paths.sessionsDir, 'session-1', 'debug.json');
    const fileText = await readFile(filePath, 'utf8');

    expect(Buffer.byteLength(fileText, 'utf8')).toBeLessThanOrEqual(1200);
    expect(artifact).toEqual({
      truncated: true,
      reason: 'debug bundle soft limit exceeded'
    });
  });

  it('bounds large nested detail payloads before writing debug.json', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-detail-limit-'));
    const paths = createPersistencePaths(root);
    const store = new SessionDebugBundleStore({
      paths,
      softLimitBytes: 1200,
      textFieldLimitChars: 6000
    });

    await store.write('session-1', {
      stages: [
        {
          stage: 'scope.resolve',
          status: 'ok',
          detail: {
            files: Array.from({ length: 160 }, (_, index) => ({
              path: `chip-${index}/spec.md`,
              size: index
            }))
          }
        }
      ]
    });

    const bundle = await store.get('session-1');
    const detail = bundle?.stages[0]?.detail as { truncated?: boolean; reason?: string };
    const filePath = path.join(paths.sessionsDir, 'session-1', 'debug.json');
    const fileText = await readFile(filePath, 'utf8');

    expect(Buffer.byteLength(fileText, 'utf8')).toBeLessThanOrEqual(1200);
    expect(detail).toEqual({
      truncated: true,
      reason: 'debug bundle soft limit exceeded'
    });
  });

  it('records durationMs when the caller supplies a per-stage elapsed time (V16)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-duration-'));
    const store = new SessionDebugBundleStore({
      paths: createPersistencePaths(root),
      now: () => new Date('2026-07-04T00:00:05.000Z')
    });

    await store.write('session-1', {
      type: '跨档两步',
      stages: [
        { stage: 'cc.stage1', status: 'ok', durationMs: 4210, detail: { candidatesCount: 3 } },
        { stage: 'ws.copy', status: 'ok', durationMs: 812 }
      ]
    });

    const bundle = await store.get('session-1');
    const stage1 = bundle?.stages.find((stage) => stage.stage === 'cc.stage1');
    const copy = bundle?.stages.find((stage) => stage.stage === 'ws.copy');

    expect(stage1?.durationMs).toBe(4210);
    expect(copy?.durationMs).toBe(812);
  });

  it('leaves durationMs absent when the caller does not supply one (backward compatible)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-no-duration-'));
    const store = new SessionDebugBundleStore({
      paths: createPersistencePaths(root),
      now: () => new Date('2026-07-04T00:00:05.000Z')
    });

    await store.write('session-1', {
      stages: [{ stage: 'cc.launch', status: 'ok' }]
    });

    const bundle = await store.get('session-1');
    expect(bundle?.stages[0]?.durationMs).toBeUndefined();
  });

  it('hard caps bundles with many unique stages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agentx-debug-bundle-stage-limit-'));
    const paths = createPersistencePaths(root);
    const store = new SessionDebugBundleStore({
      paths,
      softLimitBytes: 1200,
      textFieldLimitChars: 6000
    });

    await store.write('session-1', {
      stages: Array.from({ length: 500 }, (_, index) => ({
        stage: `stage.${index}`,
        status: 'ok',
        detail: { index }
      }))
    });

    const bundle = await store.get('session-1');
    const marker = bundle?.stages.at(-1);
    const filePath = path.join(paths.sessionsDir, 'session-1', 'debug.json');
    const fileText = await readFile(filePath, 'utf8');

    expect(Buffer.byteLength(fileText, 'utf8')).toBeLessThanOrEqual(1200);
    expect(marker?.stage).toBe('debug.truncated');
    expect(marker?.detail).toMatchObject({
      reason: 'debug bundle soft limit exceeded'
    });
    expect(Number(marker?.detail?.omittedStageCount)).toBeGreaterThan(0);
  });
});

function createTestLogger(records: LogRecord[]): Logger {
  const write = (level: LogLevel, event: string, message: string, context?: LogContext): LogRecord => {
    const record: LogRecord = { timestamp: '2026-07-04T00:00:00.000Z', level, event, message, ...context };
    records.push(record);
    return record;
  };
  return {
    debug(event: string, message: string, context?: LogContext) {
      return write('debug', event, message, context);
    },
    info(event: string, message: string, context?: LogContext) {
      return write('info', event, message, context);
    },
    warn(event: string, message: string, context?: LogContext) {
      return write('warn', event, message, context);
    },
    error(event: string, message: string, context?: LogContext) {
      return write('error', event, message, context);
    },
    log(level: LogLevel, event: string, message: string, context?: LogContext) {
      return write(level, event, message, context);
    }
  };
}
