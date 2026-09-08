import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createPersistencePaths,
  SessionHistoryStore,
  type SessionMeta
} from '../src/persistence/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-session-history-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createStore(root: string, now = '2026-05-08T01:00:00.000Z'): SessionHistoryStore {
  return new SessionHistoryStore({
    dataDir: root,
    now: () => now
  });
}

function baseMeta(overrides: Partial<SessionMeta> = {}): Omit<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'> &
  Partial<Pick<SessionMeta, 'title' | 'createdAt' | 'updatedAt' | 'outputSize' | 'tags' | 'aiLabels'>> {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    username: 'alice',
    role: 'internal',
    agentType: 'claude-code',
    chipId: 'E521.39',
    chipLabel: 'E521.39 demo chip',
    cwd: 'D:/work/chips/E521.39',
    task: 'inspect datasheet and summarize power pins',
    source: 'web',
    turnState: 'running',
    sessionMode: 'conversation',
    tags: ['phase-12'],
    aiSummary: 'pending summary',
    aiLabels: ['datasheet'],
    ...overrides
  };
}

describe('SessionHistoryStore metadata and index', () => {
  it('creates meta and session index', async () => {
    const root = await tempDir();
    const paths = createPersistencePaths(root);
    const store = createStore(root);

    const meta = await store.createSession(baseMeta());

    expect(meta).toMatchObject({
      sessionId: 'session-1',
      title: 'inspect datasheet and summarize power pi',
      createdAt: '2026-05-08T01:00:00.000Z',
      updatedAt: '2026-05-08T01:00:00.000Z',
      outputSize: 0,
      tags: ['phase-12'],
      aiSummary: 'pending summary',
      aiLabels: ['datasheet']
    });

    await expect(readFile(path.join(paths.sessionsDir, 'session-1', 'meta.json'), 'utf8')).resolves.toContain(
      '"sessionId": "session-1"'
    );
    await expect(store.readSessionIndex()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        username: 'alice',
        chipId: 'E521.39',
        title: meta.title,
        outputSize: 0
      })
    ]);
  });

  it('defaults title to first 40 characters', async () => {
    const root = await tempDir();
    const store = createStore(root);
    const task = `  ${'x'.repeat(60)} trailing text`;

    const meta = await store.createSession(baseMeta({ sessionId: 'session-2', task }));

    expect(meta.title).toBe('x'.repeat(40));
  });

  it('updates session meta and index together', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());

    const updated = await store.updateSessionMeta('session-1', {
      title: 'renamed',
      turnState: 'idle',
      tags: ['reviewed'],
      aiSummary: 'answered'
    });

    expect(updated).toMatchObject({
      title: 'renamed',
      turnState: 'idle',
      tags: ['reviewed'],
      aiSummary: 'answered'
    });
    await expect(store.readSessionIndex()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        title: 'renamed',
        turnState: 'idle',
        tags: ['reviewed'],
        aiSummary: 'answered'
      })
    ]);
  });

  it('keeps the session index consistent during concurrent creates', async () => {
    const root = await tempDir();
    const store = createStore(root);

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.createSession(
          baseMeta({
            sessionId: `session-${index}`,
            task: `inspect datasheet ${index}`,
            updatedAt: `2026-05-08T01:00:0${index}.000Z`
          })
        )
      )
    );

    const index = await store.readSessionIndex();
    expect(index).toHaveLength(8);
    expect(index.map((entry) => entry.sessionId).sort()).toEqual(
      Array.from({ length: 8 }, (_, entryIndex) => `session-${entryIndex}`)
    );
  });

  it('does not leak an unhandled rejection when a queued meta update fails', async () => {
    const root = await tempDir();
    const store = createStore(root);
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };

    process.on('unhandledRejection', handler);
    try {
      await expect(store.updateSessionMeta('missing-session', { turnState: 'running' })).rejects.toThrow(
        'Session not found: missing-session'
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});

describe('SessionHistoryStore transcript output and events', () => {
  it('appends transcript entries', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());

    await store.appendTranscript('session-1', {
      role: 'user',
      turnId: 'turn-1',
      text: 'What are the power pins?',
      createdAt: '2026-05-08T01:01:00.000Z',
      outputStart: 0
    });
    await store.appendTranscript('session-1', {
      role: 'assistant',
      turnId: 'turn-1',
      text: 'VDD and GND.',
      createdAt: '2026-05-08T01:02:00.000Z'
    });
    await store.appendTranscript('session-1', {
      role: 'turn_result',
      turnId: 'turn-1',
      status: 'done',
      finishedAt: '2026-05-08T01:03:00.000Z',
      exitCode: 0,
      signal: null,
      totalOutputChars: 12
    });

    await expect(store.readTranscript('session-1')).resolves.toEqual([
      expect.objectContaining({ role: 'user', outputStart: 0 }),
      expect.objectContaining({ role: 'assistant', text: 'VDD and GND.' }),
      expect.objectContaining({ role: 'turn_result', status: 'done', exitCode: 0 })
    ]);
    await expect(store.readTranscript('session-1', { offset: 1, limit: 1 })).resolves.toEqual([
      expect.objectContaining({ role: 'assistant' })
    ]);
    await expect(store.readSessionMeta('session-1')).resolves.toMatchObject({
      turnState: 'idle',
      lastTurnResult: {
        status: 'done',
        finishedAt: '2026-05-08T01:03:00.000Z',
        totalOutputChars: 12
      }
    });
  });

  it('updates outputSize when appending output', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());

    await store.appendOutput('session-1', 'hello ');
    const meta = await store.appendOutput('session-1', 'world');

    expect(meta.outputSize).toBe(11);
    await expect(store.readSessionIndex()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session-1', outputSize: 11 })
    ]);
  });

  it('serializes concurrent output appends for one session', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());
    const chunks = ['aa', 'bbb', 'c', 'dddd', 'eeeee', 'ffffff'];

    await Promise.all(chunks.map((chunk) => store.appendOutput('session-1', chunk)));

    const expectedSize = chunks.join('').length;
    await expect(store.readSessionMeta('session-1')).resolves.toMatchObject({ outputSize: expectedSize });
    await expect(store.readSessionIndex()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'session-1', outputSize: expectedSize })
    ]);
    await expect(readFile(path.join(createPersistencePaths(root).sessionsDir, 'session-1', 'output.log'), 'utf8')).resolves.toHaveLength(
      expectedSize
    );
  });

  it('persists error turn details in transcript meta and index', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());

    await store.appendTranscript('session-1', {
      role: 'turn_result',
      turnId: 'turn-1',
      status: 'error',
      finishedAt: '2026-05-08T01:03:00.000Z',
      exitCode: 1,
      signal: null,
      totalOutputChars: 12,
      error: 'provider timed out'
    });

    await expect(store.readTranscript('session-1')).resolves.toEqual([
      expect.objectContaining({ role: 'turn_result', status: 'error', error: 'provider timed out' })
    ]);
    await expect(store.readSessionMeta('session-1')).resolves.toMatchObject({
      lastTurnResult: { status: 'error', error: 'provider timed out' }
    });
    await expect(store.readSessionIndex()).resolves.toEqual([
      expect.objectContaining({
        sessionId: 'session-1',
        lastTurnResult: expect.objectContaining({ status: 'error', error: 'provider timed out' })
      })
    ]);
  });

  it('tails output with limit', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());
    await store.appendOutput('session-1', 'hello world');

    await expect(store.tailOutput('session-1', 5)).resolves.toEqual({
      output: 'world',
      totalChars: 11,
      offset: 6,
      limit: 5
    });
  });

  it('appends and reads event records', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta());

    await store.appendEvent('session-1', {
      event: 'session_created',
      createdAt: '2026-05-08T01:04:00.000Z',
      details: { source: 'test' }
    });

    await expect(store.readEvents('session-1')).resolves.toEqual([
      {
        event: 'session_created',
        sessionId: 'session-1',
        createdAt: '2026-05-08T01:04:00.000Z',
        details: { source: 'test' }
      }
    ]);
  });
});

describe('SessionHistoryStore user history queries', () => {
  it('lists user sessions in last activity order with pagination', async () => {
    const root = await tempDir();
    const store = createStore(root);

    await store.createSession(
      baseMeta({
        sessionId: 'session-a',
        userId: 'user-1',
        updatedAt: '2026-05-08T01:01:00.000Z',
        createdAt: '2026-05-08T01:00:00.000Z'
      })
    );
    await store.appendTranscript('session-a', {
      role: 'user',
      text: 'latest message',
      createdAt: '2026-05-08T01:10:00.000Z'
    });

    await store.createSession(
      baseMeta({
        sessionId: 'session-b',
        userId: 'user-1',
        updatedAt: '2026-05-08T01:03:00.000Z',
        createdAt: '2026-05-08T01:02:00.000Z'
      })
    );

    await store.createSession(
      baseMeta({
        sessionId: 'session-c',
        userId: 'user-2',
        updatedAt: '2026-05-08T01:20:00.000Z',
        createdAt: '2026-05-08T01:04:00.000Z'
      })
    );

    await store.createSession(
      baseMeta({
        sessionId: 'session-d',
        userId: 'user-1',
        updatedAt: '2026-05-08T00:59:00.000Z',
        createdAt: '2026-05-08T00:59:00.000Z'
      })
    );

    await expect(store.listUserSessions('user-1')).resolves.toEqual({
      items: [
        expect.objectContaining({ sessionId: 'session-a', userId: 'user-1' }),
        expect.objectContaining({ sessionId: 'session-b', userId: 'user-1' }),
        expect.objectContaining({ sessionId: 'session-d', userId: 'user-1' })
      ],
      total: 3,
      offset: 0,
      limit: 500
    });
    await expect(store.listUserSessions('user-1', { offset: 1, limit: 1 })).resolves.toEqual({
      items: [expect.objectContaining({ sessionId: 'session-b' })],
      total: 3,
      offset: 1,
      limit: 1
    });

    const sessions = await store.listUserSessions('user-1');
    expect(sessions.items[0]).not.toHaveProperty('cwd');
    expect(sessions.items[0]).not.toHaveProperty('outputSize');
    expect(sessions.items[0]).not.toHaveProperty('adminNotes');
  });

  it('reports filtered totals and caps excessive user history limits', async () => {
    const root = await tempDir();
    const store = createStore(root);

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.createSession(
          baseMeta({
            sessionId: `session-${index}`,
            userId: 'user-1',
            updatedAt: `2026-05-08T01:00:0${index}.000Z`
          })
        )
      )
    );

    const page = await store.listUserSessions('user-1', { offset: 2, limit: 1000 });

    expect(page.total).toBe(6);
    expect(page.offset).toBe(2);
    expect(page.limit).toBe(500);
    expect(page.items).toHaveLength(4);
    expect(page.items[0].sessionId).toBe('session-3');
  });

  it('returns a sanitized user-visible session detail', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(
      baseMeta({
        sessionId: 'session-1',
        adminNotes: 'internal only',
        cwd: 'D:/secret/workspace',
        scopePresetId: 'dynamic-group',
        scopeWorkspace: {
          scopeId: 'scope-safe',
          scopePresetId: 'dynamic-group',
          mode: 'copy',
          fileCount: 2,
          allowedChipCount: 2,
          allowedDocumentCount: 2,
          labels: ['E521.31', 'E521.39'],
          usedSources: [],
          sourceCitationSummary: { sourceCount: 0, labels: [], sourceIds: [], usedSources: [] }
        },
        pipelineType: '跨档两步'
      })
    );

    await store.appendTranscript('session-1', {
      role: 'user',
      turnId: 'turn-1',
      text: 'Show me the pinout',
      createdAt: '2026-05-08T01:01:00.000Z',
      outputStart: 0
    });
    await store.appendTranscript('session-1', {
      role: 'assistant',
      turnId: 'turn-1',
      text: 'Here is the summary.',
      createdAt: '2026-05-08T01:02:00.000Z'
    });
    await store.appendTranscript('session-1', {
      role: 'turn_result',
      turnId: 'turn-1',
      status: 'done',
      finishedAt: '2026-05-08T01:03:00.000Z',
      exitCode: 0,
      signal: null,
      totalOutputChars: 21
    });
    await store.appendEvent('session-1', {
      event: 'session_viewed',
      createdAt: '2026-05-08T01:04:00.000Z'
    });

    await expect(store.readUserSessionHistory('user-1', 'session-1')).resolves.toEqual({
      summary: expect.objectContaining({
        sessionId: 'session-1',
        userId: 'user-1',
        title: 'inspect datasheet and summarize power pi',
        aiSummary: 'pending summary',
        scopePresetId: 'dynamic-group',
        scopeWorkspace: expect.objectContaining({ scopeId: 'scope-safe' }),
        pipelineType: '跨档两步'
      }),
      transcript: [
        {
          role: 'user',
          turnId: 'turn-1',
          text: 'Show me the pinout',
          createdAt: '2026-05-08T01:01:00.000Z'
        },
        {
          role: 'assistant',
          turnId: 'turn-1',
          text: 'Here is the summary.',
          createdAt: '2026-05-08T01:02:00.000Z'
        }
      ]
    });

    const history = await store.readUserSessionHistory('user-1', 'session-1');
    expect(history?.summary).not.toHaveProperty('cwd');
    expect(history?.summary).not.toHaveProperty('outputSize');
    expect(history?.summary).not.toHaveProperty('adminNotes');
    expect(history?.transcript[0]).not.toHaveProperty('outputStart');
    expect(history?.transcript).toHaveLength(2);

    await expect(store.readUserSessionHistory('user-2', 'session-1')).resolves.toBeUndefined();
  });

  it('returns the newest 500 visible messages by default while preserving explicit pagination', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta({ sessionId: 'session-1' }));
    const transcript = Array.from({ length: 505 }, (_, index) => JSON.stringify({
      role: 'user',
      turnId: `turn-${index}`,
      text: `message-${index}`,
      createdAt: `2026-05-08T01:${String(index % 60).padStart(2, '0')}:00.000Z`
    })).join('\n') + '\n';
    await writeFile(path.join(root, 'sessions', 'session-1', 'transcript.jsonl'), transcript, 'utf8');

    const defaultHistory = await store.readUserSessionHistory('user-1', 'session-1');
    expect(defaultHistory?.transcript).toHaveLength(500);
    expect(defaultHistory?.transcript[0]?.text).toBe('message-5');
    expect(defaultHistory?.transcript.at(-1)?.text).toBe('message-504');

    const explicitHistory = await store.readUserSessionHistory('user-1', 'session-1', { offset: 0, limit: 2 });
    expect(explicitHistory?.transcript.map((entry) => entry.text)).toEqual(['message-0', 'message-1']);
  });
});

describe('SessionHistoryStore restart recovery', () => {
  it('marks running turns interrupted on startup', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta({ sessionId: 'running-session', turnState: 'running' }));
    await store.appendOutput('running-session', 'partial output');

    const result = await store.markRunningTurnsInterrupted('2026-05-08T02:00:00.000Z');

    expect(result).toEqual({ interrupted: ['running-session'] });
    await expect(store.readSessionMeta('running-session')).resolves.toMatchObject({
      turnState: 'idle',
      lastTurnResult: {
        status: 'interrupted',
        finishedAt: '2026-05-08T02:00:00.000Z',
        exitCode: null,
        signal: 'RESTART',
        totalOutputChars: 14
      }
    });
    await expect(store.readEvents('running-session')).resolves.toEqual([
      expect.objectContaining({
        event: 'turn_interrupted_on_startup',
        sessionId: 'running-session',
        createdAt: '2026-05-08T02:00:00.000Z'
      })
    ]);
  });

  it('does not change idle sessions', async () => {
    const root = await tempDir();
    const store = createStore(root);
    await store.createSession(baseMeta({ sessionId: 'idle-session', turnState: 'idle' }));

    const result = await store.markRunningTurnsInterrupted('2026-05-08T02:00:00.000Z');

    expect(result).toEqual({ interrupted: [] });
    const meta = await store.readSessionMeta('idle-session');
    expect(meta).toMatchObject({ turnState: 'idle' });
    expect(meta).not.toHaveProperty('lastTurnResult');
    await expect(store.readEvents('idle-session')).resolves.toEqual([]);
  });
});
