import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { CreditLedger } from '../src/credits.js';
import { createPersistenceRuntime } from '../src/persistence/index.js';
import { createSourceCitationSummary, createUsedSourceRecord } from '../src/source-citations/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createChatManager() {
  const sessions: any[] = [];
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.sessions = sessions;
  manager.output = '';
  manager.failNextSubmit = false;
  manager.spawn = vi.fn().mockImplementation(async (params: any) => {
    const session = {
      id: `session-${sessions.length + 1}`,
      userId: params.userId,
      agentType: params.agentType,
      status: 'running',
      startedAt: Date.now(),
      cwd: params.cwd ?? process.cwd(),
      task: params.task,
      totalOutputChars: manager.output.length,
      sessionMode: params.sessionMode,
      chatMode: params.chatMode,
      modelId: params.modelId,
      claudeModelRole: params.claudeModelRole,
      creditUnits: params.creditUnits,
      creditReservation: params.creditReservation,
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000701',
      chipId: params.chipId
    };
    sessions.push(session);
    return session;
  });
  manager.log = vi.fn().mockImplementation((sessionId: string, offset = 0, limit?: number) => {
    const output = manager.output.slice(offset, limit ? offset + limit : undefined);
    return {
      output,
      truncated: false,
      totalChars: manager.output.length,
      offset,
      limit
    };
  });
  manager.tail = vi.fn().mockImplementation((sessionId: string, tail: number) => ({
    output: manager.output.slice(Math.max(0, manager.output.length - tail)),
    truncated: false,
    totalChars: manager.output.length,
    offset: Math.max(0, manager.output.length - tail),
    limit: tail
  }));
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockImplementation(async (sessionId: string) => {
    if (manager.failNextSubmit) {
      throw new Error('agent_send failed');
    }
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session?.sessionMode === 'conversation') {
      session.turnState = 'running';
      session.turnCount = (session.turnCount ?? 0) + 1;
    }
  });
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: false, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.claimTurnStart = vi.fn().mockResolvedValue(() => undefined);
  manager.list = vi.fn().mockImplementation(() => sessions);
  manager.listWithPid = vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 })));
  return manager;
}

async function startChatServer(options: { auth?: boolean; persistence?: boolean; aliceCreditUnits?: number } = {}) {
  const manager = createChatManager();
  let dataDir: string | undefined;
  let auth:
    | {
        enabled: true;
        config: AuthConfig;
        userStore: UserStore;
        jwtService: JwtService;
      }
    | { enabled: false };
  let jwtService: JwtService | undefined;
  let alice: Awaited<ReturnType<UserStore['createUser']>> | undefined;
  let bob: Awaited<ReturnType<UserStore['createUser']>> | undefined;

  if (options.auth) {
    dataDir = await mkdtemp(join(tmpdir(), 'agentx-phase7-chat-'));
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    alice = await userStore.createUser('alice', 'alice-secret', 'customer', {
      ...(options.aliceCreditUnits === undefined ? {} : { credits: { balanceUnits: options.aliceCreditUnits } })
    });
    bob = await userStore.createUser('bob', 'bob-secret', 'customer');
    jwtService = new JwtService(config);
    auth = { enabled: true, config, userStore, jwtService };
  } else {
    auth = { enabled: false };
  }

  const persistence =
    options.persistence && dataDir
      ? createPersistenceRuntime({ dataDir, fileLogging: false, retentionDays: 30 })
      : undefined;

  const server = createHttpServer({
    manager: manager as any,
    auth,
    chips: { enabled: false },
    prompts: { enabled: false },
    ...(persistence ? { persistence: { enabled: true, runtime: persistence } } : {})
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    auth,
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    jwtService,
    alice,
    bob,
    manager,
    persistence,
    server
  };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function removeTempDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function postJson(baseUrl: string, path: string, body: unknown, token?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function readSnapshot(response: Response) {
  const reader = response.body?.getReader();
  expect(reader).toBeDefined();
  const firstChunk = await reader!.read();
  await reader!.cancel();
  const text = new TextDecoder().decode(firstChunk.value);
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith('data: '));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice('data: '.length)) as any;
}

async function findTicketDetailFile(dataDir: string, ticketNo: string): Promise<string> {
  const root = join(dataDir, 'tickets', 'detail');
  const years = await readdir(root);
  for (const year of years) {
    const months = await readdir(join(root, year)).catch(() => []);
    for (const month of months) {
      const candidate = join(root, year, month, `${ticketNo}.json`);
      try {
        await readFile(candidate, 'utf8');
        return candidate;
      } catch {
        // Keep searching date buckets generated by the store clock.
      }
    }
  }
  throw new Error(`Ticket detail not found: ${ticketNo}`);
}

async function waitForCreditLedgerCount(ledger: CreditLedger, userId: string, count: number) {
  let last;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await ledger.query({ userId, limit: 20 });
    if (last.items.length >= count) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last ?? { items: [], total: 0, offset: 0, limit: 20 };
}

async function waitForReservationCleared(
  persistence: NonNullable<Awaited<ReturnType<typeof startChatServer>>['persistence']>,
  sessionId: string
) {
  let last = await persistence.sessionStore.readSessionMeta(sessionId);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await persistence.sessionStore.readSessionMeta(sessionId);
    if (!last?.creditReservation) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

describe('Phase 7 chat runtime history', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await removeTempDirWithRetry(dataDir);
      dataDir = undefined;
    }
  });

  it('records initial task and successful sends as ordered user and assistant messages', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task',
      sessionMode: 'conversation'
    });
    const session = (await created.json()) as any;
    started.manager.output = 'assistant one\n';

    const sent = await postJson(started.baseUrl, `/sessions/${session.sessionId}/send`, { data: 'next turn' });
    started.manager.output = 'assistant one\nassistant two\n';
    started.manager.sessions[0].turnState = 'idle';
    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;

    expect(created.status).toBe(201);
    expect(sent.status).toBe(200);
    expect(payload.messages).toEqual([
      { role: 'user', text: 'initial task' },
      { role: 'assistant', text: 'assistant one' },
      { role: 'user', text: 'next turn' },
      { role: 'assistant', text: 'assistant two' }
    ]);
  });

  it('does not record a failed send as a successful user turn', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task',
      sessionMode: 'conversation'
    });
    const session = (await created.json()) as any;
    started.manager.output = 'assistant one\n';
    started.manager.failNextSubmit = true;

    const failed = await postJson(started.baseUrl, `/sessions/${session.sessionId}/send`, { data: 'poison turn' });
    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;

    expect(failed.status).toBe(500);
    expect(payload.messages).toEqual([
      { role: 'user', text: 'initial task' },
      { role: 'assistant', text: 'assistant one' }
    ]);
  });

  it('reserves credits per conversation turn and does not reuse or refund a prior reservation', async () => {
    const started = await startChatServer({ auth: true, persistence: true, aliceCreditUnits: 100 });
    server = started.server;
    dataDir = started.dataDir;
    const alice = started.alice!;
    const token = started.jwtService!.sign(alice.id, alice.username, alice.role);
    const ledger = new CreditLedger({ dataDir: started.dataDir! });

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'initial task', sessionMode: 'conversation', chatMode: 'standard' },
      token
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as any;
    await expect((started.auth as any).userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(50);

    const runtimeSession = started.manager.sessions[0];
    runtimeSession.turnState = 'idle';
    runtimeSession.turnCount = 1;
    started.manager.emit('state', session.sessionId, { turnState: 'idle', turnCount: 1 });
    const firstLedger = await waitForCreditLedgerCount(ledger, alice.id, 1);
    expect(firstLedger.items[0]).toMatchObject({ status: 'charged', units: 50, balanceAfterUnits: 50 });
    expect((await waitForReservationCleared(started.persistence!, session.sessionId))?.creditReservation).toBeUndefined();

    const sent = await postJson(started.baseUrl, `/sessions/${session.sessionId}/send`, { data: 'second turn' }, token);
    expect(sent.status).toBe(200);
    await expect((started.auth as any).userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(0);

    runtimeSession.turnState = 'idle';
    started.manager.emit('state', session.sessionId, { turnState: 'idle', turnCount: runtimeSession.turnCount });
    const secondLedger = await waitForCreditLedgerCount(ledger, alice.id, 2);
    expect(secondLedger.items.map((item) => item.status)).toEqual(['charged', 'charged']);
    expect(secondLedger.items.map((item) => item.balanceAfterUnits).sort((left, right) => left - right)).toEqual([0, 50]);
    expect((await waitForReservationCleared(started.persistence!, session.sessionId))?.creditReservation).toBeUndefined();

    const rejected = await postJson(started.baseUrl, `/sessions/${session.sessionId}/send`, { data: 'third turn' }, token);
    expect(rejected.status).toBe(402);
    await expect((started.auth as any).userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(0);
    const finalLedger = await ledger.query({ userId: alice.id, limit: 20 });
    expect(finalLedger.items).toHaveLength(2);
  });

  it('does not reserve or lock credits when persistence settlement is disabled', async () => {
    const started = await startChatServer({ auth: true, persistence: false, aliceCreditUnits: 100 });
    server = started.server;
    dataDir = started.dataDir;
    const alice = started.alice!;
    const userStore = (started.auth as Extract<typeof started.auth, { enabled: true }>).userStore;
    const token = started.jwtService!.sign(alice.id, alice.username, alice.role);

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'non-durable billing guard', sessionMode: 'conversation', chatMode: 'standard' },
      token
    );

    expect(created.status).toBe(201);
    await expect(userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(100);
    expect(userStore.listCreditReservations()).toEqual([]);
  });

  it('does not refund twice when a stale reservation remains in session meta after release', async () => {
    const started = await startChatServer({ auth: true, persistence: true, aliceCreditUnits: 100 });
    server = started.server;
    dataDir = started.dataDir;
    const alice = started.alice!;
    const token = started.jwtService!.sign(alice.id, alice.username, alice.role);
    const ledger = new CreditLedger({ dataDir: started.dataDir! });

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'initial task', sessionMode: 'conversation', chatMode: 'standard' },
      token
    );
    expect(created.status).toBe(201);
    const session = (await created.json()) as any;
    const initialMeta = await started.persistence!.sessionStore.readSessionMeta(session.sessionId);
    const staleReservation = initialMeta?.creditReservation;
    expect(staleReservation?.reservationId).toBeTruthy();

    const runtimeSession = started.manager.sessions[0];
    runtimeSession.turnState = 'idle';
    runtimeSession.turnCount = 1;
    started.manager.emit('state', session.sessionId, { turnState: 'idle', turnCount: 1 });
    await waitForCreditLedgerCount(ledger, alice.id, 1);
    await expect((started.auth as any).userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(50);

    await started.persistence!.sessionStore.updateSessionMeta(session.sessionId, {
      creditReservation: staleReservation
    });
    started.manager.emit('exit', session.sessionId, 1, '');

    await waitForCreditLedgerCount(ledger, alice.id, 2);
    await expect((started.auth as any).userStore.getCreditBalanceUnits(alice.id)).resolves.toBe(50);
  });

  it('returns the same message contract from /log and SSE snapshot', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    started.manager.output = 'assistant one\n';

    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const logPayload = (await log.json()) as any;
    const stream = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/stream`);
    const snapshot = await readSnapshot(stream);

    expect(stream.status).toBe(200);
    expect(snapshot.messages).toEqual(logPayload.messages);
    expect(snapshot.messages).toEqual([
      { role: 'user', text: 'initial task' },
      { role: 'assistant', text: 'assistant one' }
    ]);
  });

  it('does not expose raw plain process output while the turn is still running', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    started.manager.list()[0].turnState = 'running';
    started.manager.output = [
      '== Page 53 ==',
      '**Table 6.1.3.2-14: Register TIMER_COUNTER**',
      '{"parent_tool_use_id":"call_00_test","subagent_type":"Explore"}'
    ].join('\n');

    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;
    const stream = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/stream`);
    const snapshot = await readSnapshot(stream);

    expect(payload.messages).toEqual([{ role: 'user', text: 'initial task' }]);
    expect(snapshot.messages).toEqual([{ role: 'user', text: 'initial task' }]);
  });

  it('sanitizes /log output while preserving final result metadata', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    started.manager.output = JSON.stringify({
      type: 'result',
      result: [
        'Final answer: E522.59 uses TIMER_COUNTER. Source: public datasheet.',
        'parent_tool_use_id: call_secret',
        'D:\\repo\\chip-agentx\\internal.md',
        '/opt/chip-agentx/datasheets/E522.59/raw.md'
      ].join('\n')
    });

    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;

    expect(payload.output).toBe('Final answer: E522.59 uses TIMER_COUNTER. Source: public datasheet.');
    expect(payload.assistantResult).toBe(payload.output);
    expect(payload.rawOutputExposed).toBe(false);
    expect(payload.outputMeta).toMatchObject({ rawOutputExposed: false, source: 'result' });
    expect(JSON.stringify(payload)).not.toContain('parent_tool_use_id');
    expect(JSON.stringify(payload)).not.toContain('D:\\repo\\chip-agentx');
    expect(JSON.stringify(payload)).not.toContain('/opt/chip-agentx/datasheets');
  });

  it('stores structured feedback snapshots from trusted session output and source metadata', async () => {
    const started = await startChatServer({ auth: true, persistence: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = started.jwtService!.sign(started.alice!.id, started.alice!.username, started.alice!.role);
    const bobToken = started.jwtService!.sign(started.bob!.id, started.bob!.username, started.bob!.role);

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'initial task' },
      aliceToken
    );
    const session = (await created.json()) as any;
    const source = createUsedSourceRecord({
      scopeId: 'scope-feedback',
      scopePresetId: 'preset-feedback',
      documentId: 'doc-feedback',
      displayTitle: 'Feedback Datasheet',
      filename: 'feedback-datasheet.pdf'
    })!;
    await started.persistence!.sessionStore.updateSessionMeta(session.sessionId, {
      modelId: 'haiku',
      chipId: 'E522.49',
      scopePresetId: 'preset-feedback',
      usedSources: [source],
      sourceCitationSummary: createSourceCitationSummary([source])
    });
    const transcript = await started.persistence!.sessionStore.readTranscript(session.sessionId);
    const turnId = transcript.find((entry) => entry.role === 'user')!.turnId!;
    started.manager.output = JSON.stringify({
      type: 'result',
      result: [
        'Final answer: use Feedback Datasheet. Source: Feedback Datasheet.',
        'cookie: session=secret',
        'D:\\repo\\chip-agentx\\internal.md'
      ].join('\n')
    });

    const createdFeedback = await postJson(
      started.baseUrl,
      '/api/feedback/messages',
      {
        sessionId: session.sessionId,
        turnId,
        feedbackTypes: ['bad-citation'],
        note: 'jwt=secret and /opt/chip-agentx/raw.md',
        sourceCitationSummary: {
          sources: [{ documentId: 'forged', sourcePath: 'D:\\secret\\raw.md' }]
        }
      },
      aliceToken
    );
    const body = (await createdFeedback.json()) as any;
    const denied = await postJson(
      started.baseUrl,
      '/api/feedback/messages',
      { sessionId: session.sessionId, turnId, feedbackTypes: ['useful'] },
      bobToken
    );

    expect(createdFeedback.status).toBe(201);
    expect(body.feedback).toMatchObject({
      sessionId: session.sessionId,
      turnId,
      reviewSignal: 'high_priority'
    });
    expect(denied.status).toBe(404);

    const detail = JSON.parse(await readFile(await findTicketDetailFile(started.dataDir!, body.ticket.ticketNo), 'utf8')) as any;
    const snapshot = detail.payload.feedbackSnapshot;
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({
      sessionId: session.sessionId,
      turnId,
      modelId: 'haiku',
      chipId: 'E522.49',
      reviewSignal: 'high_priority'
    });
    expect(snapshot.answerTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.sourceCitationSummary.sources).toEqual([
      expect.objectContaining({ documentId: 'doc-feedback', displayTitle: 'Feedback Datasheet' })
    ]);
    expect(serialized).not.toMatch(/forged|sourcePath|cookie|jwt=secret|D:\\|\/opt\/agentx/i);
  });

  it('does not send raw SSE output chunks and emits sanitized result metadata', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    const stream = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/stream`);
    const reader = stream.body!.getReader();
    await reader.read();

    started.manager.output = JSON.stringify({
      type: 'result',
      result: 'Final answer: E521.39 uses PWM_CTRL.'
    });
    started.manager.emit('output', session.sessionId, 'parent_tool_use_id: call_secret');
    started.manager.emit('state', session.sessionId, { turnState: 'idle', turnCount: 2 });

    let text = '';
    while (!text.includes('event: result') || !text.includes('event: state')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          setTimeout(() => reject(new Error('Timed out waiting for SSE result')), 1000);
        })
      ]);
      text += new TextDecoder().decode(chunk.value);
    }
    await reader.cancel();

    expect(text).toContain('event: output');
    expect(text).toContain('"hasOutput":true');
    expect(text).not.toContain('parent_tool_use_id');
    expect(text).toContain('event: result');
    expect(text).toContain('Final answer: E521.39 uses PWM_CTRL.');
    expect(text).toContain('"rawOutputExposed":false');
    expect(text.indexOf('event: result')).toBeLessThan(text.indexOf('event: state'));
  });

  it('deduplicates assistant message and matching final result in restored messages', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    started.manager.output = [
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'same answer' }] }
      }),
      JSON.stringify({ type: 'result', result: 'same answer' })
    ].join('\n');

    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;

    expect(payload.messages).toEqual([
      { role: 'user', text: 'initial task' },
      { role: 'assistant', text: 'same answer' }
    ]);
  });

  it('hides intermediate assistant/tool chatter while preserving the final assistant answer', async () => {
    const started = await startChatServer();
    server = started.server;
    dataDir = started.dataDir;

    const created = await postJson(started.baseUrl, '/sessions', {
      agentType: 'claude-code',
      task: 'initial task'
    });
    const session = (await created.json()) as any;
    started.manager.output = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: [
                'I will inspect the docs.',
                '<tool_call>',
                '<invoke_name>Read</invoke_name>',
                '<parameters><arg name="path">README.md</arg></parameters>',
                '</tool_call>',
                '<｜｜DSML｜｜tool_calls>',
                '<｜｜DSML｜｜invoke name="Grep">',
                '<｜｜DSML｜｜parameter name="pattern" string="true">LIN</｜｜DSML｜｜parameter>',
                '</｜｜DSML｜｜invoke>',
                '</｜｜DSML｜｜tool_calls>',
                'Final answer: LIN is on pin 3.'
              ].join('\n')
            }
          ]
        }
      }),
      JSON.stringify({ type: 'result', result: 'Final answer: LIN is on pin 3.' })
    ].join('\n');

    const log = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/log`);
    const payload = (await log.json()) as any;

    expect(payload.messages).toEqual([
      { role: 'user', text: 'initial task' },
      { role: 'assistant', text: 'Final answer: LIN is on pin 3.' }
    ]);
  });

  it('sanitizes persisted assistant transcript when restoring a historical chat', async () => {
    const started = await startChatServer({ auth: true, persistence: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = started.jwtService!.sign(started.alice!.id, started.alice!.username, started.alice!.role);

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'initial task' },
      aliceToken
    );
    const session = (await created.json()) as any;

    await started.persistence!.sessionStore.appendTranscript(session.sessionId, {
      role: 'assistant',
      turnId: 'turn-dirty',
      createdAt: new Date().toISOString(),
      text: [
        'Let me search the E522.59 documentation for information about communication priority.',
        '/opt/chip-agentx/datasheets/E522.59/07.05-PWMINInterface.md-42-  raw grep line',
        '/opt/chip-agentx/datasheets/E522.59/07.04.10-Standalone-Area.md-18-  raw grep line',
        '### 三、相关配置寄存器详解',
        '通讯优先级和外部 PWM 优先级可以通过相关寄存器配置。'
      ].join('\n')
    });

    const history = await fetch(`${started.baseUrl}/sessions/${session.sessionId}/history`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const payload = (await history.json()) as any;

    expect(history.status).toBe(200);
    expect(payload.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'initial task', createdAt: expect.any(String) }),
      expect.objectContaining({
        role: 'assistant',
        createdAt: expect.any(String),
        text: [
          '### 三、相关配置寄存器详解',
          '通讯优先级和外部 PWM 优先级可以通过相关寄存器配置。'
        ].join('\n')
      })
    ]);
    expect(payload.messages[1].text).not.toContain('/opt/chip-agentx/datasheets');
    expect(payload.messages[1].text).not.toContain('Let me search');
    expect(payload.transcript[1].text).toContain('/opt/chip-agentx/datasheets');
  });

  it('charges credits after a successful persisted session exit', async () => {
    const started = await startChatServer({ auth: true, persistence: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = started.jwtService!.sign(started.alice!.id, started.alice!.username, started.alice!.role);
    const before = await (started.auth as Extract<typeof started.auth, { enabled: true }>).userStore.getCreditBalanceUnits(started.alice!.id);

    const created = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'billable task', chatMode: 'standard' },
      aliceToken
    );
    const session = (await created.json()) as any;

    started.manager.output = JSON.stringify({ type: 'result', result: 'done' });
    started.manager.sessions[0].status = 'completed';
    started.manager.emit('exit', session.sessionId, 0, '');

    await vi.waitFor(async () => {
      const after = await (started.auth as Extract<typeof started.auth, { enabled: true }>).userStore.getCreditBalanceUnits(started.alice!.id);
      expect(after).toBe(before - 50);
      const rawLedger = await readFile(join(started.dataDir!, 'credits', 'ledger.jsonl'), 'utf8');
      expect(rawLedger).toContain('"status":"charged"');
      expect(rawLedger).toContain('"modelId":"haiku"');
      expect(rawLedger).not.toContain('Authorization');
      expect(rawLedger).not.toContain('token');
    }, { timeout: 10_000, interval: 20 });
  });

  it('keeps session list, log, and stream snapshot scoped to the authenticated user', async () => {
    const started = await startChatServer({ auth: true });
    server = started.server;
    dataDir = started.dataDir;
    const aliceToken = started.jwtService!.sign(started.alice!.id, started.alice!.username, started.alice!.role);
    const bobToken = started.jwtService!.sign(started.bob!.id, started.bob!.username, started.bob!.role);

    const aliceCreate = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'alice task' },
      aliceToken
    );
    const aliceSession = (await aliceCreate.json()) as any;
    started.manager.output = 'alice assistant\n';
    const bobCreate = await postJson(
      started.baseUrl,
      '/sessions',
      { agentType: 'claude-code', task: 'bob task' },
      bobToken
    );
    const bobSession = (await bobCreate.json()) as any;

    const aliceList = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const foreignLog = await fetch(`${started.baseUrl}/sessions/${bobSession.sessionId}/log`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const foreignStream = await fetch(`${started.baseUrl}/sessions/${bobSession.sessionId}/stream`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });
    const ownLog = await fetch(`${started.baseUrl}/sessions/${aliceSession.sessionId}/log`, {
      headers: { Authorization: `Bearer ${aliceToken}` }
    });

    expect((await aliceList.json() as any).sessions.map((session: any) => session.id)).toEqual([aliceSession.sessionId]);
    expect(foreignLog.status).toBe(404);
    expect(foreignStream.status).toBe(404);
    expect(ownLog.status).toBe(200);
  });
});
