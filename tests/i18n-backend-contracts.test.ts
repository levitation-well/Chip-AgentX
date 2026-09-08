import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';
import { createSessionActions } from '../src/server/session-actions.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  const sessions: Array<Record<string, any>> = [];
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.spawn = vi.fn(async (params: Record<string, any>) => {
    const session = {
      id: 'session-i18n-1',
      userId: params.userId,
      agentType: params.agentType ?? 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: params.cwd ?? process.cwd(),
      task: params.task,
      sessionMode: params.sessionMode ?? 'conversation',
      chatMode: params.chatMode ?? 'standard',
      modelId: params.modelId,
      creditUnits: params.creditUnits,
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000911',
      totalOutputChars: 0
    };
    sessions.push(session);
    return session;
  });
  manager.list = vi.fn(() => sessions);
  manager.listWithPid = vi.fn(() => sessions.map((session) => ({ ...session, pid: 1 })));
  manager.log = vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 }));
  manager.tail = vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 }));
  manager.send = vi.fn(async () => undefined);
  manager.submit = vi.fn(async () => undefined);
  manager.claimTurnStart = vi.fn(() => () => undefined);
  manager.poll = vi.fn(async () => ({ hasOutput: false, exited: false }));
  manager.kill = vi.fn(async () => undefined);
  return manager;
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('bilingual backend contracts', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
    }
    dataDir = undefined;
  });

  it('returns both locale identity fields from GET /auth/me', async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-i18n-auth-'));
    const config: AuthConfig = {
      jwtSecret: JWT_SECRET,
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: await bcrypt.hash('admin-secret', 10),
      dataDir
    };
    const userStore = new UserStore(config);
    await userStore.init();
    const alice = await userStore.createUser('alice', 'alice-secret');
    await userStore.updateOwnLocale(alice.id, 'en-US');
    server = createHttpServer({
      manager: createFakeManager() as never,
      auth: { enabled: true, config, userStore, jwtService: new JwtService(config) },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false, dataDir }
    });
    const baseUrl = await listen(server);
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'alice-secret' })
    });
    const token = ((await login.json()) as any).token;

    const response = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        userId: alice.id,
        username: 'alice',
        localePreference: 'en-US',
        preferredLanguage: 'en-US'
      }
    });
  });

  it('accepts locale only on WebChat turns while preserving display text', async () => {
    const manager = createFakeManager();
    server = createHttpServer({
      manager: manager as never,
      auth: { enabled: false },
      chips: { enabled: false },
      prompts: { enabled: false },
      persistence: { enabled: false }
    });
    const baseUrl = await listen(server);

    const create = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'Explain this register',
        sessionMode: 'conversation',
        chatMode: 'standard',
        locale: 'en-US'
      })
    });
    expect(create.status).toBe(201);
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      displayTask: 'Explain this register',
      task: expect.stringContaining('Respond in English for this turn')
    }));
    expect(manager.spawn.mock.calls[0]?.[0].task).toContain('Explain this register');

    const send = await fetch(`${baseUrl}/sessions/session-i18n-1/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: '继续解释', locale: 'zh-CN' })
    });
    expect(send.status).toBe(200);
    expect(manager.submit).toHaveBeenCalledWith(
      'session-i18n-1',
      expect.stringContaining('Respond in Simplified Chinese for this turn')
    );
    expect(manager.submit.mock.calls[0]?.[1]).toContain('继续解释');

    const invalid = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'test', locale: 'fr-FR' })
    });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'INVALID_LOCALE' });
  });

  it('composes provider locale only at dispatch and persists the original user text', async () => {
    const sessions: Array<Record<string, any>> = [];
    const manager = {
      spawn: vi.fn(async (params: Record<string, any>) => {
        const session = {
          id: 'session-provider-context',
          userId: params.userId,
          agentType: params.agentType,
          status: 'running',
          startedAt: Date.now(),
          cwd: process.cwd(),
          task: params.task,
          displayTask: params.displayTask,
          sessionMode: 'conversation',
          chatMode: 'standard',
          modelId: params.modelId,
          creditUnits: params.creditUnits,
          totalOutputChars: 0
        };
        sessions.push(session);
        return session;
      }),
      list: vi.fn(() => sessions),
      listWithPid: vi.fn(() => sessions.map((session) => ({ ...session, pid: 1 }))),
      log: vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 })),
      tail: vi.fn(),
      send: vi.fn(async () => undefined),
      submit: vi.fn(async () => undefined),
      claimTurnStart: vi.fn(() => () => undefined),
      poll: vi.fn(),
      kill: vi.fn(async () => undefined)
    };
    const persistence = {
      recordSessionCreated: vi.fn(async () => undefined),
      recordUserTurn: vi.fn(async () => undefined),
      recordSessionEvent: vi.fn(async () => undefined),
      sessionStore: {
        readSessionMeta: vi.fn(async () => undefined)
      }
    };
    const webActions = createSessionActions(manager as never, {
      persistence: persistence as never,
      source: 'web',
      responseLocale: 'en-US'
    });

    await webActions.agent_spawn({
      agentType: 'claude-code',
      task: 'raw first question',
      sessionMode: 'conversation',
      chatMode: 'standard'
    });
    await webActions.agent_send({
      sessionId: 'session-provider-context',
      data: 'raw follow-up'
    });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.stringContaining('Respond in English for this turn'),
      displayTask: 'raw first question'
    }));
    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(expect.objectContaining({
      task: 'raw first question'
    }));
    expect(persistence.recordUserTurn).toHaveBeenNthCalledWith(
      1,
      'session-provider-context',
      expect.objectContaining({ text: 'raw first question' })
    );
    expect(persistence.recordUserTurn).toHaveBeenNthCalledWith(
      2,
      'session-provider-context',
      expect.objectContaining({ text: 'raw follow-up' })
    );
    expect(manager.submit).toHaveBeenCalledWith(
      'session-provider-context',
      expect.stringContaining('Respond in English for this turn')
    );

    const mcpManager = {
      ...manager,
      spawn: vi.fn(async (params: Record<string, any>) => ({
        id: 'session-mcp-raw',
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: process.cwd(),
        task: params.task,
        sessionMode: 'oneshot',
        totalOutputChars: 0
      }))
    };
    const mcpActions = createSessionActions(mcpManager as never, { source: 'mcp' });
    await mcpActions.agent_spawn({ agentType: 'claude-code', task: 'raw MCP question' });
    expect(mcpManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      task: 'raw MCP question'
    }));
  });
});
