import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPersistenceRuntime,
  initPersistenceRuntime,
  SessionHistoryStore
} from '../src/persistence/index.js';
import type { Logger } from '../src/logging/index.js';

const tempDirs: string[] = [];
const fixedNow = new Date('2026-05-08T03:00:00.000Z');

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function captureLogger(lines: unknown[]): Logger {
  return {
    debug: vi.fn((event, message, context) => record('debug', event, message, context)),
    info: vi.fn((event, message, context) => record('info', event, message, context)),
    warn: vi.fn((event, message, context) => record('warn', event, message, context)),
    error: vi.fn((event, message, context) => record('error', event, message, context)),
    log: vi.fn((level, event, message, context) => record(level, event, message, context))
  };

  function record(level: string, event: string, message: string, context?: { metadata?: unknown }) {
    const value = { level, event, message, metadata: context?.metadata };
    lines.push(value);
    return {
      timestamp: fixedNow.toISOString(),
      level,
      event,
      message,
      metadata: context?.metadata
    } as ReturnType<Logger['info']>;
  }
}

describe('persistence runtime initialization', () => {
  it('initializes the data layout', async () => {
    const dataDir = await tempDir();
    const lines: unknown[] = [];

    const runtime = await initPersistenceRuntime({
      dataDir,
      logger: captureLogger(lines),
      now: () => fixedNow
    });

    await expect(readFile(path.join(dataDir, 'sessions', 'index.json'), 'utf8')).resolves.toBe('[]\n');
    expect(runtime.dataDir).toBe(path.resolve(dataDir));
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'data_dir_initialized',
        metadata: { dataDir: path.resolve(dataDir), interruptedCount: 0 }
      })
    );
  });

  it('logs interrupted running turns on startup', async () => {
    const dataDir = await tempDir();
    const store = new SessionHistoryStore({
      dataDir,
      now: () => '2026-05-08T02:00:00.000Z'
    });
    await store.createSession({
      sessionId: 'session-running',
      agentType: 'claude-code',
      cwd: 'D:/work',
      task: 'continue',
      turnState: 'running'
    });
    await store.appendOutput('session-running', 'partial');
    const lines: unknown[] = [];

    await initPersistenceRuntime({
      dataDir,
      logger: captureLogger(lines),
      now: () => fixedNow
    });

    await expect(store.readSessionMeta('session-running')).resolves.toMatchObject({
      turnState: 'idle',
      lastTurnResult: {
        status: 'interrupted',
        signal: 'RESTART',
        totalOutputChars: 7
      }
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'data_dir_initialized',
        metadata: { dataDir: path.resolve(dataDir), interruptedCount: 1 }
      })
    );
  });

  it('throws a diagnostic error when data dir cannot be initialized', async () => {
    const root = await tempDir();
    const dataDir = path.join(root, 'not-a-directory');
    await writeFile(dataDir, 'file blocks directory creation', 'utf8');
    const lines: unknown[] = [];

    await expect(
      initPersistenceRuntime({
        dataDir,
        logger: captureLogger(lines),
        now: () => fixedNow
      })
    ).rejects.toThrow();
    expect(lines).toContainEqual(
      expect.objectContaining({
        event: 'persist_error',
        metadata: expect.objectContaining({ dataDir: path.resolve(dataDir) })
      })
    );
  });
});

describe('persistence runtime facade', () => {
  it('records sessions turns output and completion through Phase 13 facade methods', async () => {
    const dataDir = await tempDir();
    const runtime = await initPersistenceRuntime({
      dataDir,
      logger: captureLogger([]),
      now: () => fixedNow
    });

    await runtime.recordSessionCreated({
      sessionId: 'session-1',
      agentType: 'claude-code',
      cwd: 'D:/work',
      task: 'inspect',
      turnState: 'running'
    });
    await runtime.recordUserTurn('session-1', {
      role: 'user',
      turnId: 'turn-1',
      text: 'What changed?',
      createdAt: fixedNow.toISOString(),
      question: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        source: 'web',
        userId: 'user-1'
      }
    });
    await runtime.recordOutputChunk('session-1', 'hello');
    await runtime.recordTurnFinished('session-1', {
      status: 'error',
      finishedAt: fixedNow.toISOString(),
      exitCode: 1,
      signal: null,
      totalOutputChars: 5,
      error: 'model process failed'
    });
    await runtime.recordSessionEvent('session-1', { event: 'custom_event' });

    await expect(runtime.sessionStore.readTranscript('session-1')).resolves.toEqual([
      expect.objectContaining({ role: 'user', text: 'What changed?' }),
      expect.objectContaining({ role: 'turn_result', status: 'error', error: 'model process failed' })
    ]);
    await expect(runtime.questionLedger.queryQuestions({ userId: 'user-1' })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ text: 'What changed?' })]
    });
    await expect(runtime.sessionStore.tailOutput('session-1', 10)).resolves.toMatchObject({
      output: 'hello',
      totalChars: 5
    });
    await expect(runtime.sessionStore.readEvents('session-1')).resolves.toEqual([
      expect.objectContaining({ event: 'custom_event' })
    ]);
  });

  it('does not subscribe to session manager events automatically', () => {
    const manager = { on: vi.fn() };

    createPersistenceRuntime({ dataDir: path.resolve('data'), logger: captureLogger([]), manager } as never);

    expect(manager.on).not.toHaveBeenCalled();
  });
});
