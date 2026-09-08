import { EventEmitter, once } from 'node:events';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer, isScopeHistorySessionRestartOnly } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createPersistenceRuntime, type PersistenceRuntime } from '../src/persistence/index.js';
import { SessionBusyError } from '../src/session-manager.js';
import { CreditLedger } from '../src/credits.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-http-history-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.claimTurnStart = vi.fn(() => () => undefined);
  manager.enableTurnSettlementBarrier = vi.fn();
  manager.completeTurnSettlement = vi.fn();
  manager.failTurnSettlement = vi.fn();
  manager.clear = vi.fn();
  manager.claimHistoricalResume = vi.fn(async (sessionId: string) => {
    manager.clear(sessionId);
    return () => undefined;
  });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.spawn = vi.fn().mockResolvedValue({
    id: 'session-alice',
    userId: 'user-alice',
    agentType: 'claude-code',
    status: 'running',
    startedAt: Date.now(),
    cwd: 'D:/chips/E521.39',
    task: 'next question',
    sessionMode: 'conversation',
    turnState: 'running',
    turnCount: 2,
    claudeSessionId: 'claude-alice',
    chipId: 'E521.39'
  });
  return manager;
}

async function startHistoryServer(
  runtime: PersistenceRuntime,
  options: Pick<Parameters<typeof createHttpServer>[0], 'product'> & { withoutChips?: boolean } = {}
) {
  const authDir = await tempDir();
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir: authDir
  };
  const userStore = new UserStore(config);
  await writeFile(
    path.join(authDir, 'users.json'),
    JSON.stringify(
      [
        {
          id: 'admin-user',
          username: 'admin',
          passwordHash: config.adminPasswordHash,
          mcpKeys: [],
          createdAt: '2026-05-08T00:00:00.000Z',
          role: 'admin'
        },
        {
          id: 'user-alice',
          username: 'alice',
          passwordHash: await bcrypt.hash('alice-secret', 10),
          mcpKeys: [],
          createdAt: '2026-05-08T00:00:00.000Z',
          role: 'customer',
          modelGrants: ['haiku', 'sonnet', 'opus'],
          resourceGrants: { chipIds: ['E521.39'] }
        },
        {
          id: 'user-bob',
          username: 'bob',
          passwordHash: await bcrypt.hash('bob-secret', 10),
          mcpKeys: [],
          createdAt: '2026-05-08T00:00:00.000Z',
          role: 'customer',
          modelGrants: ['haiku', 'sonnet', 'opus'],
          resourceGrants: { chipIds: ['E521.39'] }
        }
      ],
      null,
      2
    ),
    'utf8'
  );
  await userStore.init();
  const jwtService = new JwtService(config);
  const manager = createManager();
  const kbRoot = path.join(authDir, 'knowledge-base');
  const chipWorkspace = path.join(kbRoot, 'E521.39');
  await mkdir(chipWorkspace, { recursive: true });
  await writeFile(path.join(chipWorkspace, 'datasheet.md'), '# E521.39 test datasheet\n', 'utf8');
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    ...(options.withoutChips ? {} : {
      chips: {
        enabled: true,
        catalog: {
          knowledgeBaseRoot: kbRoot,
          chips: [{
            id: 'E521.39',
            label: 'E521.39',
            description: 'History test chip',
            queryHint: 'Use the test datasheet.',
            workspaceDir: 'E521.39'
          }]
        }
      }
    }),
    prompts: { enabled: false },
    persistence: { runtime },
    ...(options.product ? { product: options.product } : {})
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    jwtService,
    manager,
    server,
    userStore
  };
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function flushAsyncHandlers(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForAssertion(assertion: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 10_000, interval: 20 });
}

async function readSnapshot(response: Response): Promise<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE stream ended before snapshot');
      buffer += decoder.decode(value, { stream: true });
      const match = /event: snapshot\r?\ndata: (.+?)\r?\n\r?\n/s.exec(buffer);
      if (match?.[1]) return JSON.parse(match[1]);
    }
  } finally {
    await reader.cancel();
  }
}

describe('HTTP session history', () => {
  it('rejects cross-tenant image sends before writing into the target workspace', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    const started = await startHistoryServer(runtime);
    const isolatedCwd = path.join(dataDir, 'scope-workspaces', 'alice-live');
    const uploadId = '00000000-0000-4000-8000-000000000099';
    const storedName = '00000000-0000-4000-8000-000000000098.png';
    const uploadDir = path.join(dataDir, 'chat-uploads', 'user-bob', uploadId);
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, storedName), Buffer.from('not-a-real-png'));
    await mkdir(isolatedCwd, { recursive: true });
    started.manager.list.mockReturnValue([{
      id: 'session-alice',
      userId: 'user-alice',
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: isolatedCwd,
      task: 'alice task',
      sessionMode: 'conversation',
      chatMode: 'multimodal',
      modelId: 'opus',
      turnState: 'idle',
      turnCount: 1,
      chipId: 'E521.39'
    }]);

    try {
      const bobToken = started.jwtService.sign('user-bob', 'bob', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: `inspect ![diagram](/api/chat-uploads/${uploadId}/${storedName}?token=cross-tenant)`
        })
      });

      expect(response.status).toBe(404);
      await expect(access(path.join(isolatedCwd, 'chat-images'))).rejects.toThrow();
      expect(started.manager.submit).not.toHaveBeenCalled();
    } finally {
      await closeServer(started.server);
    }
  });

  it("returns only the authenticated user's history and does not expose cwd raw output or logs", async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: 'D:/chips/E521.39',
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-alice'
    });
    await runtime.recordUserTurn('session-alice', {
      role: 'user',
      text: 'first question',
      createdAt: '2026-05-08T01:00:00.000Z'
    });
    await runtime.sessionStore.appendTranscript('session-alice', {
      role: 'assistant',
      text: 'answer',
      createdAt: '2026-05-08T01:01:00.000Z'
    });
    await runtime.recordSessionCreated({
      sessionId: 'session-bob',
      userId: 'user-bob',
      username: 'bob',
      role: 'customer',
      agentType: 'claude-code',
      cwd: 'D:/chips/other',
      task: 'private question',
      source: 'web'
    });

    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const list = await fetch(`${started.baseUrl}/sessions/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const listBody = await list.json() as any;

      expect(list.status).toBe(200);
      expect(listBody.sessions).toHaveLength(1);
      expect(listBody.total).toBe(1);
      expect(listBody.sessions[0]).toMatchObject({ sessionId: 'session-alice', id: 'session-alice' });
      expect(JSON.stringify(listBody)).not.toContain('D:/chips');

      const detail = await fetch(`${started.baseUrl}/sessions/session-alice/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const detailBody = await detail.json() as any;
      expect(detail.status).toBe(200);
      expect(detailBody.messages.map((message: any) => message.text)).toEqual(['first question', 'answer']);
      expect(JSON.stringify(detailBody)).not.toContain('output');
      expect(JSON.stringify(detailBody)).not.toContain('events');
      expect(JSON.stringify(detailBody)).not.toContain('audit');

      const foreign = await fetch(`${started.baseUrl}/sessions/session-bob/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(foreign.status).toBe(404);
    } finally {
      await closeServer(started.server);
    }
  });

  it('marks every persisted preset or scope-workspace session as restart-only, matching resume rejection', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'preset-session',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      scopePresetId: 'preset-customer-visible',
      cwd: 'D:/isolated/preset',
      task: 'preset query',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-preset'
    });
    await runtime.recordSessionCreated({
      sessionId: 'workspace-session',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      scopeWorkspace: { scopePresetId: 'workspace-only' } as any,
      cwd: 'D:/isolated/workspace',
      task: 'workspace query',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-workspace'
    });

    const started = await startHistoryServer(runtime);
    try {
      await started.userStore.updateUser('user-alice', { role: 'admin' });
      const token = started.jwtService.sign('user-alice', 'alice', 'admin');
      const response = await fetch(`${started.baseUrl}/sessions/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json() as any;
      expect(response.status).toBe(200);
      expect(body.sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'preset-session', requiresNewScopeQuery: true })
      ]));
      expect(isScopeHistorySessionRestartOnly({
        scopeWorkspace: { scopePresetId: 'workspace-only' }
      })).toBe(true);
    } finally {
      await closeServer(started.server);
    }
  });

  it('projects same-user live conversation turn state into history list and detail', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'scope-session',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      scopePresetId: 'dynamic-group',
      cwd: 'D:/isolated/scope-session',
      task: 'group query',
      source: 'web',
      sessionMode: 'conversation',
      turnState: 'idle'
    });

    const started = await startHistoryServer(runtime, { withoutChips: true });
    const token = started.jwtService.sign('user-alice', 'alice', 'customer');
    const readHistoryState = async () => {
      const listResponse = await fetch(`${started.baseUrl}/sessions/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const listBody = await listResponse.json() as any;
      const detailResponse = await fetch(`${started.baseUrl}/sessions/scope-session/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const detailBody = await detailResponse.json() as any;
      expect(listResponse.status).toBe(200);
      expect(detailResponse.status).toBe(200);
      return {
        list: listBody.sessions.find((session: any) => session.id === 'scope-session'),
        detail: detailBody
      };
    };
    const liveSession = {
      id: 'scope-session',
      userId: 'user-alice',
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: 'D:/isolated/scope-session',
      task: 'group query',
      sessionMode: 'conversation',
      turnState: 'running'
    };

    try {
      started.manager.list.mockReturnValue([{ ...liveSession, userId: 'user-bob' }]);
      await expect(readHistoryState()).resolves.toMatchObject({
        list: { turnState: 'idle', requiresNewScopeQuery: true },
        detail: { turnState: 'idle', requiresNewScopeQuery: true }
      });

      started.manager.list.mockReturnValue([liveSession]);
      await expect(readHistoryState()).resolves.toMatchObject({
        list: { turnState: 'running', requiresNewScopeQuery: false },
        detail: { turnState: 'running', requiresNewScopeQuery: false }
      });

      await runtime.sessionStore.updateSessionMeta('scope-session', { turnState: 'running' });
      started.manager.list.mockReturnValue([{ ...liveSession, turnState: 'idle' }]);
      await expect(readHistoryState()).resolves.toMatchObject({
        list: { turnState: 'idle', requiresNewScopeQuery: false },
        detail: { turnState: 'idle', requiresNewScopeQuery: false }
      });

      started.manager.list.mockReturnValue([]);
      await expect(readHistoryState()).resolves.toMatchObject({
        list: { turnState: 'running', requiresNewScopeQuery: true },
        detail: { turnState: 'running', requiresNewScopeQuery: true }
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('keeps persisted chat history messages free of visible fingerprint markers', async () => {
    process.env.AGENTX_FINGERPRINT_SECRET = 'history-fingerprint-test-secret';
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    const assistantText =
      '这是一段面向客户的自然语言回答，内容足够长，用来说明当前芯片资料查询结果。它应当保持干净，不应该把内部水印标记显示在聊天历史里。';
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: 'D:/chips/E521.39',
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation'
    });
    await runtime.recordUserTurn('session-alice', {
      role: 'user',
      text: 'first question',
      createdAt: '2026-05-08T01:00:00.000Z'
    });
    await runtime.sessionStore.appendTranscript('session-alice', {
      role: 'assistant',
      text: assistantText,
      createdAt: '2026-05-08T01:01:00.000Z'
    });

    const started = await startHistoryServer(runtime, {
      product: { config: { edition: 'public', landingMode: 'always' } }
    });
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const detail = await fetch(`${started.baseUrl}/sessions/session-alice/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const detailBody = await detail.json() as any;

      expect(detail.status).toBe(200);
      expect(detailBody.messages.map((message: any) => message.text)).toEqual(['first question', assistantText]);
      expect(JSON.stringify(detailBody.messages)).not.toContain('agentx-fp:v1.');
    } finally {
      delete process.env.AGENTX_FINGERPRINT_SECRET;
      await closeServer(started.server);
    }
  });

  it('reports user history total before pagination and caps excessive limits', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    for (let index = 0; index < 3; index += 1) {
      await runtime.recordSessionCreated({
        sessionId: `session-alice-${index}`,
        userId: 'user-alice',
        username: 'alice',
        role: 'customer',
        agentType: 'claude-code',
        cwd: `D:/chips/${index}`,
        task: `question ${index}`,
        source: 'web'
      });
    }

    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions/history?offset=1&limit=1000`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body.total).toBe(3);
      expect(body.offset).toBe(1);
      expect(body.limit).toBe(500);
      expect(body.sessions).toHaveLength(2);
    } finally {
      await closeServer(started.server);
    }
  });

  it('persists assistant transcript when a conversation turn returns to idle without exiting', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const created = await fetch(`${started.baseUrl}/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'claude-code', task: 'first question', chipId: 'E521.39', sessionMode: 'conversation' })
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as any;
      expect(createdBody.sessionId).toBe('session-alice');

      started.manager.log.mockReturnValue({
        output: 'assistant answer from idle turn',
        truncated: false,
        totalChars: 'assistant answer from idle turn'.length,
        offset: 0
      });
      started.manager.list.mockReturnValue([
        {
          id: 'session-alice',
          status: 'running',
          sessionMode: 'conversation',
          turnState: 'idle',
          turnCount: 1
        }
      ]);
      started.manager.emit('state', 'session-alice', {
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: 'claude-alice'
      });

      await waitForAssertion(async () => {
        const detail = await fetch(`${started.baseUrl}/sessions/session-alice/history`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        const detailBody = await detail.json() as any;
        expect(detail.status).toBe(200);
        expect(detailBody.messages.map((message: any) => message.text)).toEqual([
          'next question',
          'assistant answer from idle turn'
        ]);
        await expect(runtime.sessionStore.readEvents('session-alice')).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event: 'agent_state' }),
            expect.objectContaining({ event: 'turn_finished' })
          ])
        );
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('persists a follow-up assistant result from a truncated retained window', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const created = await fetch(`${started.baseUrl}/sessions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType: 'claude-code', task: 'first question', chipId: 'E521.39', sessionMode: 'conversation' })
      });
      expect(created.status).toBe(201);

      await runtime.recordUserTurn('session-alice', {
        role: 'user',
        turnId: 'turn-follow-up',
        text: 'follow-up question',
        createdAt: new Date().toISOString(),
        outputStart: 200_000
      });
      const rawResult = JSON.stringify({ type: 'result', result: 'Persisted second-turn answer.' });
      started.manager.log.mockReturnValue({
        output: rawResult,
        truncated: true,
        totalChars: 200_000 + rawResult.length,
        offset: 200_000
      });
      started.manager.list.mockReturnValue([{
        id: 'session-alice',
        status: 'running',
        sessionMode: 'conversation',
        turnState: 'idle',
        turnCount: 2
      }]);
      started.manager.emit('state', 'session-alice', {
        turnState: 'idle',
        turnCount: 2,
        claudeSessionId: 'claude-alice'
      });

      await waitForAssertion(async () => {
        const transcript = await runtime.sessionStore.readTranscript('session-alice');
        expect(transcript).toEqual(expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            turnId: 'turn-follow-up',
            text: 'Persisted second-turn answer.'
          })
        ]));
        await expect(runtime.sessionStore.readEvents('session-alice')).resolves.toEqual(
          expect.arrayContaining([expect.objectContaining({ event: 'turn_finished' })])
        );
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('resumes a persisted historical session using the original session id and question ledger', async () => {
    const dataDir = await tempDir();
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000401');
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-alice',
      turnState: 'idle',
      turnCount: 1
    });
    await runtime.recordOutputChunk('session-alice', 'previous persisted output is longer than new');
    const started = await startHistoryServer(runtime);
    try {
      // A finished registry snapshot remains for the diagnostic TTL. Resume
      // must clear that stale entry before reusing the persisted session id.
      started.manager.list.mockReturnValue([{
        id: 'session-alice',
        userId: 'user-alice',
        agentType: 'claude-code',
        status: 'completed',
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
        cwd: 'D:/chips/E521.39',
        task: 'first question',
        sessionMode: 'conversation',
        chipId: 'E521.39'
      }]);
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'next question' })
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ sessionId: 'session-alice', resumed: true });
      expect(started.manager.clear).toHaveBeenCalledWith('session-alice');
      expect(started.manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'session-alice',
        claudeSessionId: 'claude-alice',
        initialTurnCount: 1,
        cwd: historicalCwd,
        resume: true
      }));
      await expect(access(path.join(historicalCwd, 'datasheet.md'))).resolves.toBeUndefined();
      started.manager.log.mockReturnValue({
        output: 'new assistant answer',
        truncated: false,
        totalChars: 'new assistant answer'.length,
        offset: 0
      });
      started.manager.list.mockReturnValue([{
        ...(await started.manager.spawn.mock.results[0]?.value),
        id: 'session-alice',
        status: 'completed',
        sessionMode: 'conversation'
      }]);
      started.manager.emit('exit', 'session-alice', 0, '');
      await waitForAssertion(async () => {
        await expect(runtime.sessionStore.readSessionMeta('session-alice')).resolves.toMatchObject({
          lastTurnResult: expect.objectContaining({ status: 'done' })
        });
      });

      const detail = await fetch(`${started.baseUrl}/sessions/session-alice/history`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const detailBody = await detail.json() as any;
      expect(detailBody.messages.map((message: any) => message.text)).toContain('new assistant answer');
      await expect(runtime.questionLedger.queryQuestions({ sessionId: 'session-alice' })).resolves.toMatchObject({
        total: 1,
        items: [expect.objectContaining({ text: 'next question' })]
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('keeps persisted history in the SSE snapshot after historical resume', async () => {
    const dataDir = await tempDir();
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000411');
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-alice',
      turnState: 'idle',
      turnCount: 1
    });
    await runtime.recordUserTurn('session-alice', {
      role: 'user',
      turnId: 'turn-old',
      text: 'first question',
      createdAt: '2026-07-14T08:00:00.000Z',
      outputStart: 0
    });
    await runtime.sessionStore.appendTranscript('session-alice', {
      role: 'assistant',
      turnId: 'turn-old',
      text: 'previous persisted answer',
      createdAt: '2026-07-14T08:01:00.000Z',
      sourceCitationSummary: {
        captureKind: 'system_captured_source_seed',
        sourceCount: 1,
        sources: [{
          captureKind: 'system_captured_source_seed',
          scopeId: 'E521.39',
          scopePresetId: 'E521.39',
          documentId: 'old-datasheet',
          displayTitle: 'Old Datasheet',
          chipId: 'E521.39'
        }]
      }
    });
    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const sent = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'new resumed question' })
      });
      expect(sent.status).toBe(200);

      started.manager.list.mockReturnValue([{
        id: 'session-alice',
        userId: 'user-alice',
        agentType: 'claude-code',
        status: 'running',
        startedAt: Date.now(),
        cwd: historicalCwd,
        task: 'new resumed question',
        sessionMode: 'conversation',
        turnState: 'running',
        turnCount: 2,
        claudeSessionId: 'claude-alice',
        chipId: 'E521.39'
      }]);
      started.manager.log.mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });

      const stream = await fetch(`${started.baseUrl}/sessions/session-alice/stream`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const snapshot = await readSnapshot(stream);

      expect(snapshot.messages.slice(0, 2)).toEqual([
        { role: 'user', text: 'first question', turnId: 'turn-old' },
        {
          role: 'assistant',
          text: 'previous persisted answer',
          turnId: 'turn-old',
          sourceCitationSummary: expect.objectContaining({
            sourceCount: 1,
            sources: [expect.objectContaining({ documentId: 'old-datasheet' })]
          })
        }
      ]);
      expect(snapshot.messages[2]).toMatchObject({
        role: 'user',
        text: 'new resumed question',
        turnId: expect.stringMatching(/^turn-/)
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('does not overwrite an unsettled historical credit reservation', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000413'),
      task: 'previous question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      claudeSessionId: 'claude-alice',
      turnState: 'idle',
      turnCount: 1
    });
    const started = await startHistoryServer(runtime);
    await fetch(`${started.baseUrl}/api/version`);
    await runtime.sessionStore.updateSessionMeta('session-alice', {
      creditReservation: {
        reservationId: 'unsettled-hold',
        balanceBeforeUnits: 100,
        balanceAfterUnits: 50,
        requestId: 'turn-unsettled'
      }
    });
    try {
      const releaseSpy = vi.spyOn(started.userStore, 'releaseCreditReservation')
        .mockRejectedValueOnce(new Error('simulated release failure'));
      started.manager.emit('exit', 'session-alice', 1, 'FAILED');
      await waitForAssertion(async () => {
        expect(releaseSpy).toHaveBeenCalledWith('unsettled-hold');
        await expect(runtime.sessionStore.readSessionMeta('session-alice')).resolves.toMatchObject({
          lastTurnResult: { status: 'error' },
          creditReservation: { reservationId: 'unsettled-hold' }
        });
      });

      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'must wait for settlement' })
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'TURN_SETTLEMENT_INCOMPLETE' });
      expect(started.manager.claimHistoricalResume).not.toHaveBeenCalled();
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(runtime.sessionStore.readSessionMeta('session-alice')).resolves.toMatchObject({
        creditReservation: { reservationId: 'unsettled-hold', requestId: 'turn-unsettled' }
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('persists and settles one resumed answer without leaking or duplicating its reservation', async () => {
    const dataDir = await tempDir();
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000412');
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      claudeSessionId: 'claude-alice',
      turnState: 'idle',
      turnCount: 1
    });
    await runtime.recordUserTurn('session-alice', {
      role: 'user',
      turnId: 'turn-old',
      text: 'first question',
      createdAt: '2026-07-14T08:00:00.000Z',
      outputStart: 0
    });
    await runtime.sessionStore.appendTranscript('session-alice', {
      role: 'assistant',
      turnId: 'turn-old',
      text: 'old answer',
      createdAt: '2026-07-14T08:01:00.000Z'
    });
    const started = await startHistoryServer(runtime);
    const ledger = new CreditLedger({ dataDir });
    try {
      await started.userStore.setCreditBalanceUnits('user-alice', 100);
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const sent = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'resumed billed question' })
      });
      expect(sent.status).toBe(200);
      expect(started.manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ initialTurnCount: 1 }));
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(50);

      const rawAnswer = JSON.stringify({ type: 'result', result: 'resumed answer persisted once' });
      started.manager.log.mockReturnValue({
        output: rawAnswer,
        truncated: false,
        totalChars: rawAnswer.length,
        offset: 0
      });
      started.manager.list.mockReturnValue([{
        id: 'session-alice',
        userId: 'user-alice',
        agentType: 'claude-code',
        status: 'running',
        startedAt: Date.now(),
        cwd: historicalCwd,
        task: 'resumed billed question',
        sessionMode: 'conversation',
        chatMode: 'standard',
        modelId: 'haiku',
        creditUnits: 50,
        turnState: 'idle',
        turnCount: 2,
        claudeSessionId: 'claude-alice',
        chipId: 'E521.39'
      }]);
      vi.spyOn(started.userStore, 'commitCreditReservation')
        .mockRejectedValueOnce(new Error('simulated commit failure'));
      started.manager.emit('state', 'session-alice', {
        turnState: 'idle',
        turnCount: 2,
        claudeSessionId: 'claude-alice'
      });

      await waitForAssertion(async () => {
        const meta = await runtime.sessionStore.readSessionMeta('session-alice');
        expect(meta?.creditReservation).toMatchObject({ requestId: expect.stringMatching(/^turn-/) });
        expect(started.manager.failTurnSettlement).toHaveBeenCalledWith('session-alice', 2);
        const charged = await ledger.query({ userId: 'user-alice', sessionId: 'session-alice', status: 'charged' });
        expect(charged.items).toHaveLength(1);
      });
      const blocked = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'must not overwrite the hold' })
      });
      expect(blocked.status).toBe(409);

      // A duplicate terminal signal retries the same durable requestId without
      // appending another assistant or charged ledger row.
      started.manager.emit('state', 'session-alice', {
        turnState: 'idle',
        turnCount: 2,
        claudeSessionId: 'claude-alice'
      });

      await waitForAssertion(async () => {
        const transcript = await runtime.sessionStore.readTranscript('session-alice');
        expect(transcript.filter((entry) =>
          entry.role === 'assistant' && entry.text === 'resumed answer persisted once')).toHaveLength(1);
        const meta = await runtime.sessionStore.readSessionMeta('session-alice');
        expect(meta).toMatchObject({ turnCount: 2 });
        expect(meta?.creditReservation).toBeUndefined();
        expect(started.userStore.listCreditReservations()).toEqual([]);
      });
      const charged = await ledger.query({ userId: 'user-alice', sessionId: 'session-alice', status: 'charged' });
      expect(charged.items).toHaveLength(1);
      expect(charged.items[0]).toMatchObject({ units: 50, balanceAfterUnits: 50 });
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(50);

      const transcriptBeforeIdleDelete = await runtime.sessionStore.readTranscript('session-alice');
      const stopped = await fetch(`${started.baseUrl}/sessions/session-alice`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(stopped.status).toBe(204);
      expect(started.manager.kill).toHaveBeenCalledWith('session-alice');
      await flushAsyncHandlers();
      await expect(runtime.sessionStore.readTranscript('session-alice')).resolves.toEqual(transcriptBeforeIdleDelete);
      expect(started.userStore.listCreditReservations()).toEqual([]);
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(50);
    } finally {
      await closeServer(started.server);
    }
  });

  it('serializes concurrent historical resume requests without killing or duplicating the winning turn', async () => {
    const dataDir = await tempDir();
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000402');
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-alice'
    });
    const started = await startHistoryServer(runtime);
    try {
      started.manager.list.mockReturnValue([{
        id: 'session-alice',
        userId: 'user-alice',
        agentType: 'claude-code',
        status: 'completed',
        startedAt: Date.now() - 1_000,
        finishedAt: Date.now(),
        cwd: 'D:/chips/E521.39',
        task: 'first question',
        sessionMode: 'conversation',
        chipId: 'E521.39'
      }]);
      let resumeClaimed = false;
      started.manager.claimHistoricalResume.mockImplementation(async (sessionId: string) => {
        if (resumeClaimed) throw new SessionBusyError('Session resume is already in progress');
        resumeClaimed = true;
        started.manager.clear(sessionId);
        return () => { resumeClaimed = false; };
      });
      let resolveSpawn!: (value: unknown) => void;
      started.manager.spawn.mockImplementation(() => new Promise((resolve) => { resolveSpawn = resolve; }));
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const request = (data: string) => fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data })
      });

      const winningRequest = request('winning question');
      await waitForAssertion(() => expect(started.manager.spawn).toHaveBeenCalledTimes(1));
      const losingResponse = await request('losing question');
      expect(losingResponse.status).toBe(409);

      resolveSpawn({
        id: 'session-alice',
        userId: 'user-alice',
        agentType: 'claude-code',
        status: 'running',
        startedAt: Date.now(),
        cwd: 'D:/chips/E521.39',
        task: 'winning question',
        sessionMode: 'conversation',
        turnState: 'running',
        turnCount: 2,
        claudeSessionId: 'claude-alice',
        chipId: 'E521.39'
      });
      expect((await winningRequest).status).toBe(200);
      expect(started.manager.spawn).toHaveBeenCalledTimes(1);
      expect(started.manager.kill).not.toHaveBeenCalled();
      const transcript = await runtime.sessionStore.readTranscript('session-alice');
      expect(transcript.filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual(['winning question']);
    } finally {
      await closeServer(started.server);
    }
  });

  it('fails closed instead of resuming a cleaned dynamic-scope workspace from the repository cwd', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      scopePresetId: 'dynamic-global',
      scopeDescriptor: { mode: 'global' },
      cwd: '',
      task: 'global question',
      source: 'web',
      sessionMode: 'oneshot',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50
    });
    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const balanceBefore = await started.userStore.getCreditBalanceUnits('user-alice');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'unsafe follow-up' })
      });
      const body = await response.json() as any;

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'SCOPE_SESSION_RESTART_REQUIRED' });
      expect(started.manager.claimHistoricalResume).not.toHaveBeenCalled();
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(balanceBefore);
    } finally {
      await closeServer(started.server);
    }
  });

  it('materializes image uploads for a resumed multimodal turn while keeping workspace-local paths out of history', async () => {
    const dataDir = await tempDir();
    const resumeCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000403');
    const uploadId = '00000000-0000-4000-8000-000000000777';
    const storedName = 'diagram.png';
    const uploadDir = path.join(dataDir, 'chat-uploads', 'user-alice', uploadId);
    await mkdir(uploadDir, { recursive: true });
    await mkdir(resumeCwd, { recursive: true });
    await writeFile(path.join(uploadDir, storedName), 'image-bytes', 'utf8');
    await writeFile(path.join(uploadDir, 'meta.json'), JSON.stringify({ readToken: 'read-token' }), 'utf8');

    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: resumeCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'multimodal',
      modelId: 'opus',
      creditUnits: 150,
      claudeSessionId: 'claude-alice'
    });
    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const original = `inspect ![diagram](/api/chat-uploads/${uploadId}/${storedName}?token=read-token)`;
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: original })
      });

      expect(response.status).toBe(200);
      expect(started.manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
        task: 'inspect ![diagram](./chat-images/diagram.png)',
        displayTask: original,
        chatMode: 'multimodal'
      }));
      await expect(access(path.join(resumeCwd, 'chat-images', storedName))).resolves.toBeUndefined();
      const transcript = await runtime.sessionStore.readTranscript('session-alice');
      expect(transcript).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: 'user', text: original })
      ]));
      expect(JSON.stringify(transcript)).not.toContain('./chat-images/diagram.png');
    } finally {
      await closeServer(started.server);
    }
  });

  it('resume 单 chip 会话时走共享隔离闸重建副本，spawn 参数含隔离路径与硬化策略', async () => {
    // 准备目录结构
    const dataDir = await tempDir();
    const kbRoot = path.join(dataDir, 'kb');
    const chipDir = path.join(kbRoot, 'E521.39');
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000404');
    await mkdir(chipDir, { recursive: true });
    // 写一个哑文件确保 resolveChipWorkspace 能通过 stat 校验
    await writeFile(path.join(chipDir, 'README.md'), 'chip doc', 'utf8');

    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();

    // 预置一条有 chipId + claudeSessionId 的历史会话元数据
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      claudeSessionId: 'claude-alice'
    });

    // 用户访问控制文件
    const userAccessFile = path.join(dataDir, 'user-chip-access.json');
    await writeFile(
      userAccessFile,
      JSON.stringify({ users: { 'user-alice': ['E521.39'] } }, null, 2),
      'utf-8'
    );

    // 构建带 chips 的认证配置
    const authDir = await tempDir();
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir: authDir
    };
    const userStore = new UserStore(config);
    await writeFile(
      path.join(authDir, 'users.json'),
      JSON.stringify(
        [
          {
            id: 'user-alice',
            username: 'alice',
            passwordHash: await bcrypt.hash('alice-secret', 10),
            mcpKeys: [],
            createdAt: '2026-05-08T00:00:00.000Z',
            role: 'customer'
          }
        ],
        null,
        2
      ),
      'utf8'
    );
    await userStore.init();
    const jwtService = new JwtService(config);

    // manager：spawn 的返回值要足够完整，让 updateSessionMeta 不报错
    const manager = new EventEmitter() as EventEmitter & Record<string, any>;
    manager.list = vi.fn().mockReturnValue([]);
    manager.listWithPid = vi.fn().mockReturnValue([]);
    manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
    manager.clear = vi.fn();
    manager.claimHistoricalResume = vi.fn(async (sessionId: string) => {
      manager.clear(sessionId);
      return () => undefined;
    });
    manager.kill = vi.fn().mockResolvedValue(undefined);
    manager.spawn = vi.fn().mockResolvedValue({
      id: 'session-alice',
      userId: 'user-alice',
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: path.join(dataDir, 'scope-workspaces', 'chip-test'),
      task: 'next question',
      sessionMode: 'conversation',
      turnState: 'running',
      turnCount: 2,
      claudeSessionId: 'claude-alice-new',
      chipId: 'E521.39'
    });

    const server = createHttpServer({
      manager: manager as any,
      auth: { enabled: true, config, userStore, jwtService },
      chips: {
        enabled: true,
        userAccessFile,
        catalog: {
          knowledgeBaseRoot: kbRoot,
          chips: [
            {
              id: 'E521.39',
              label: 'E521.39 Chip',
              description: 'Chip for test',
              queryHint: 'Ask E521 questions',
              workspaceDir: 'E521.39'
            }
          ]
        }
      },
      prompts: { enabled: false },
      persistence: { runtime, dataDir }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const token = jwtService.sign('user-alice', 'alice', 'customer');
      const response = await fetch(`${baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'next question after chip resume' })
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ sessionId: 'session-alice', resumed: true });

      // 核心断言：spawn 的 cwd 必须在 scope-workspaces 下（隔离副本），不在 kbRoot 内
      expect(manager.spawn).toHaveBeenCalledOnce();
      const spawnArg = (manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;

      // cwd 应在 dataDir/scope-workspaces/ 下（副本）
      expect(typeof spawnArg['cwd']).toBe('string');
      expect(spawnArg['cwd']).toBe(historicalCwd);
      expect((spawnArg['cwd'] as string).toLowerCase()).toContain('scope-workspaces');
      // cwd 不在 knowledgeBaseRoot 内
      const cwdStr = spawnArg['cwd'] as string;
      const kbRootResolved = path.resolve(kbRoot).toLowerCase();
      expect(cwdStr.toLowerCase()).not.toContain(kbRootResolved);

      // 硬化参数
      expect(Array.isArray(spawnArg['denyReadRoots'])).toBe(true);
      expect((spawnArg['denyReadRoots'] as string[]).length).toBeGreaterThanOrEqual(1);

      expect(Array.isArray(spawnArg['allowedTools'])).toBe(true);
      expect(spawnArg['allowedTools']).toEqual(['Read', 'Grep']);

      expect(spawnArg['permissionMode']).toBe('default');

      // resume 标志
      expect(spawnArg['resume']).toBe(true);

      // scopeWorkspaceCleanup 是函数
      expect(typeof spawnArg['scopeWorkspaceCleanup']).toBe('function');
    } finally {
      await closeServer(server);
    }
  });

  it('cleans the rebuilt isolated workspace when historical resume credit reservation is rejected', async () => {
    const dataDir = await tempDir();
    const historicalCwd = path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000405');
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: historicalCwd,
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      claudeSessionId: 'claude-alice'
    });

    const started = await startHistoryServer(runtime);
    try {
      await started.userStore.setCreditBalanceUnits('user-alice', 0);
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'resume without enough credits' })
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(402);
      expect(body).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
      expect(started.manager.spawn).not.toHaveBeenCalled();
      const workspaceRoot = path.join(dataDir, 'scope-workspaces');
      await expect(readdir(workspaceRoot)).resolves.toEqual([]);
    } finally {
      await closeServer(started.server);
    }
  });

  it('rejects an unsafe legacy chip cwd before charging, writing history, or creating a workspace', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: path.join(dataDir, 'legacy-chip-workspace'),
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      claudeSessionId: 'claude-alice'
    });

    const started = await startHistoryServer(runtime);
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const balanceBefore = await started.userStore.getCreditBalanceUnits('user-alice');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'unsafe historical follow-up' })
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'CHAT_SESSION_RESTART_REQUIRED' });
      expect(started.manager.claimHistoricalResume).not.toHaveBeenCalled();
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(balanceBefore);
      await expect(runtime.sessionStore.readTranscript('session-alice')).resolves.toEqual([]);
      await expect(runtime.questionLedger.queryQuestions({ sessionId: 'session-alice' })).resolves.toMatchObject({ total: 0 });
      await expect(access(path.join(dataDir, 'scope-workspaces'))).rejects.toThrow();
    } finally {
      await closeServer(started.server);
    }
  });

  it('fails closed when a persisted chip session cannot reload the chip runtime', async () => {
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({ dataDir });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: path.join(dataDir, 'scope-workspaces', 'chip-00000000-0000-4000-8000-000000000406'),
      task: 'first question',
      source: 'web',
      sessionMode: 'conversation',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50,
      claudeSessionId: 'claude-alice'
    });

    const started = await startHistoryServer(runtime, { withoutChips: true });
    try {
      const token = started.jwtService.sign('user-alice', 'alice', 'customer');
      const balanceBefore = await started.userStore.getCreditBalanceUnits('user-alice');
      const response = await fetch(`${started.baseUrl}/sessions/session-alice/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'resume without chip runtime' })
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'CHAT_SESSION_RESTART_REQUIRED' });
      expect(started.manager.claimHistoricalResume).not.toHaveBeenCalled();
      expect(started.manager.spawn).not.toHaveBeenCalled();
      await expect(started.userStore.getCreditBalanceUnits('user-alice')).resolves.toBe(balanceBefore);
      await expect(runtime.sessionStore.readTranscript('session-alice')).resolves.toEqual([]);
    } finally {
      await closeServer(started.server);
    }
  });
});
