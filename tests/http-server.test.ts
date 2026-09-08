import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer, persistSessionStateWithRetry, startHttpServer } from '../src/http-server.js';

function createFakeManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;

  manager.spawn = vi.fn().mockImplementation(async (params: Record<string, unknown>) => ({
    id: 'session-12345678',
    agentType: params.agentType ?? 'claude-code',
    status: 'running',
    startedAt: 123,
    cwd: params.cwd ?? 'D:/workspace',
    task: params.task ?? 'inspect project',
    sessionMode: params.sessionMode ?? 'conversation',
    chatMode: params.chatMode ?? 'multimodal',
    modelId: params.modelId,
    creditUnits: params.creditUnits,
    turnState: 'idle',
    turnCount: 1,
    claudeSessionId: '00000000-0000-4000-8000-000000000201'
  }));
  manager.log = vi.fn().mockReturnValue({
    output: 'hello',
    truncated: false,
    totalChars: 5,
    offset: 0
  });
  manager.tail = vi.fn().mockReturnValue({
    output: 'lo',
    truncated: false,
    totalChars: 5,
    offset: 3
  });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.claimTurnStart = vi.fn(() => () => undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.list = vi.fn().mockReturnValue([
    {
      id: 'session-12345678',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 123,
      cwd: 'D:/workspace',
      task: 'inspect project',
      sessionMode: 'conversation',
      chatMode: 'multimodal',
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000201',
      totalOutputChars: 0
    }
  ]);
  manager.listWithPid = vi.fn().mockReturnValue([
    {
      id: 'session-12345678',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 123,
      cwd: 'D:/workspace',
      task: 'inspect project',
      sessionMode: 'conversation',
      chatMode: 'multimodal',
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000201',
      totalOutputChars: 0,
      pid: 12345
    }
  ]);

  return manager;
}

async function startTestServer(manager = createFakeManager()) {
  const server = createHttpServer({ manager: manager as any, auth: { enabled: false } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    server,
    manager,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

describe('http server', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  it('retries the initial state persistence race until session metadata exists', async () => {
    const updateSessionMeta = vi.fn()
      .mockRejectedValueOnce(new Error('Session not found: session-race'))
      .mockRejectedValueOnce(new Error('Session not found: session-race'))
      .mockResolvedValue({});
    const recordSessionEvent = vi.fn()
      .mockRejectedValueOnce(new Error('Session not found: session-race'))
      .mockRejectedValueOnce(new Error('Session not found: session-race'))
      .mockResolvedValue({});

    await persistSessionStateWithRetry({
      sessionStore: { updateSessionMeta },
      recordSessionEvent
    } as never, 'session-race', {
      turnState: 'running',
      turnCount: 1,
      claudeSessionId: 'claude-session'
    }, { attempts: 3, delayMs: 0 });

    expect(updateSessionMeta).toHaveBeenCalledTimes(3);
    expect(recordSessionEvent).toHaveBeenCalledTimes(3);
  });

  it('can disable persistence for tests and logs server_started', async () => {
    const lines: unknown[] = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn((event: string, message: string, context?: { metadata?: unknown }) => {
        lines.push({ event, message, metadata: context?.metadata });
        return {
          timestamp: '2026-05-08T00:00:00.000Z',
          level: 'info',
          event,
          message,
          metadata: context?.metadata
        };
      }),
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn()
    };

    server = await startHttpServer({
      port: 0,
      auth: { enabled: false },
      persistence: { enabled: false },
      logger: logger as never
    });

    expect(lines).toEqual([
      expect.objectContaining({
        event: 'server_started',
        metadata: expect.objectContaining({ host: '127.0.0.1' })
      })
    ]);
  });

  it('answers OPTIONS requests with CORS headers', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-methods')).toBe('GET,POST,PUT,DELETE,OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toContain('Content-Type');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id');
    expect(response.headers.get('access-control-allow-headers')).toContain('MCP-Protocol-Version');
  });

  it('creates sessions through POST /sessions', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect project',
        sessionMode: 'conversation',
        chatMode: 'multimodal'
      })
    });

    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.sessionId).toBe('session-12345678');
    expect(started.manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: 'claude-code',
        task: 'inspect project',
        sessionMode: 'conversation',
        chatMode: 'multimodal',
        modelId: 'opus',
        creditUnits: 150
      })
    );
    expect(body).toMatchObject({
      sessionId: 'session-12345678',
      sessionMode: 'conversation',
      chatMode: 'multimodal',
      modelId: 'opus',
      creditUnits: 150,
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000201'
    });
  });

  it('returns the safe live session status required by Chat reconnect recovery', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      id: 'session-12345678',
      status: 'running',
      turnState: 'idle',
      sessionMode: 'conversation',
      chatMode: 'multimodal'
    });
    expect(body).not.toHaveProperty('cwd');
    expect(body).not.toHaveProperty('allowedChipIds');
    expect(body).not.toHaveProperty('allowedDocumentIds');
  });

  it('returns 404 when Chat reconnect asks for a session outside the visible list', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-not-visible`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Session not found' });
  });

  it('rejects client-supplied session identity fields through POST /sessions', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect project',
        sessionId: 'session-12345678'
      })
    });

    expect(response.status).toBe(400);
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('returns structured model routing errors through POST /sessions', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect project',
        model: 'not-a-model'
      })
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      code: 'UNKNOWN_MODEL',
      details: expect.objectContaining({ modelId: 'not-a-model' })
    });
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('rejects chat upload image references in standard mode before creating a session', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect /api/chat-uploads/00000000-0000-4000-8000-000000000001/image.png?token=redacted',
        chatMode: 'standard'
      })
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Image input requires multimodal mode');
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('lists sessions through GET /sessions', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].id).toBe('session-12345678');
    expect(body.sessions[0]).toMatchObject({
      sessionMode: 'conversation',
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000201'
    });
  });

  it('returns tailed logs through GET /sessions/:id/log', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/log?tail=20`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(started.manager.tail).toHaveBeenCalledWith('session-12345678', 20);
    expect(started.manager.log).not.toHaveBeenCalled();
    expect(body.output).toBe('lo');
  });

  it('sends input through POST /sessions/:id/send', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'continue' })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(started.manager.submit).toHaveBeenCalledWith('session-12345678', 'continue');
    expect(body.sent).toBe(true);
  });

  it('ignores client-supplied mode metadata on follow-up sends', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: 'continue',
        chatMode: 'standard',
        model: 'haiku',
        creditUnits: 1,
        usedSources: [{ sourcePath: 'D:/private.md' }],
        sourceCitationSummary: { sources: [{ sourcePath: 'D:/private.md' }] }
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(started.manager.submit).toHaveBeenCalledWith('session-12345678', 'continue');
    expect(body).toMatchObject({
      sent: true,
      chatMode: 'multimodal'
    });
  });

  it('kills sessions through DELETE /sessions/:id', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678`, {
      method: 'DELETE'
    });

    expect(response.status).toBe(204);
    expect(started.manager.kill).toHaveBeenCalledWith('session-12345678');
    // 204 should have no body
    expect(response.headers.get('content-type')).toBeNull();
  });

  it('returns JSON-RPC method-not-found errors', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_missing',
        params: {}
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' }
    });
  });

  it('returns JSON-RPC invalid-params errors', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-params',
        method: 'agent_spawn',
        params: { agentType: 'fake', task: 'inspect project' }
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toBe('Invalid params');
  });

  it('rejects client-supplied session identity fields through JSON-RPC spawn', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'controlled-session-id',
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: 'inspect project',
          sessionId: 'session-12345678'
        }
      })
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.error.code).toBe(-32602);
    expect(started.manager.spawn).not.toHaveBeenCalled();
  });

  it('returns JSON for unknown routes', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/missing`);
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
  });

  it('streams a snapshot event over SSE', async () => {
    const started = await startTestServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const firstChunk = await reader!.read();
    await reader!.cancel();
    const text = new TextDecoder().decode(firstChunk.value);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(started.manager.log).toHaveBeenCalledWith('session-12345678', undefined, undefined);
    expect(text).toContain('event: snapshot');
    expect(text).toContain('data:');
  });

  it('emits final assistant text when a conversation turn becomes idle', async () => {
    const manager = createFakeManager();
    manager.log = vi.fn().mockReturnValue({
      output: JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '### 结论\nPWM 寄存器包括 CTRL 和 DUTY。' }] }
      }),
      truncated: false,
      totalChars: 96,
      offset: 0
    });
    const started = await startTestServer(manager);
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    await reader!.read();
    manager.emit('state', 'session-12345678', {
      turnState: 'idle',
      turnCount: 2,
      claudeSessionId: '00000000-0000-4000-8000-000000000201'
    });
    const nextChunk = await reader!.read();
    await reader!.cancel();
    const text = new TextDecoder().decode(nextChunk.value);

    expect(text).toContain('event: state');
    expect(text).toContain('event: result');
    expect(text).toContain('PWM 寄存器包括 CTRL 和 DUTY');
    expect(text).not.toContain('Let me search');
  });

  it('emits a follow-up result from a retained tail using absolute output offsets', async () => {
    const manager = createFakeManager();
    manager.log = vi.fn().mockReturnValue({
      output: '',
      truncated: true,
      totalChars: 200_000,
      offset: 200_000
    });
    const started = await startTestServer(manager);
    server = started.server;

    const sendResponse = await fetch(`${started.baseUrl}/sessions/session-12345678/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'follow-up question', submit: true })
    });
    expect(sendResponse.status).toBe(200);

    const rawResult = JSON.stringify({ type: 'result', result: 'Second-turn answer survives truncation.' });
    manager.log.mockReturnValue({
      output: rawResult,
      truncated: true,
      totalChars: 200_000 + rawResult.length,
      offset: 200_000
    });

    const response = await fetch(`${started.baseUrl}/sessions/session-12345678/stream`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();

    manager.emit('state', 'session-12345678', {
      turnState: 'idle',
      turnCount: 2,
      claudeSessionId: '00000000-0000-4000-8000-000000000201'
    });
    const nextChunk = await reader!.read();
    await reader!.cancel();
    const text = new TextDecoder().decode(nextChunk.value);

    expect(text).toContain('event: result');
    expect(text).toContain('Second-turn answer survives truncation.');
  });
});
