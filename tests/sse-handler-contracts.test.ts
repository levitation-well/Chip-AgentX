/**
 * F1 / F2 / F3 / F4 (multi-agent audit round 2): contract assertions on the
 * revised handleSseStream body. We don't import the function (it's a private
 * helper inside http-server.ts), but we can at least assert that the source
 * has the four required patterns:
 *   - exitHandler awaits checkAuthorization before writing
 *   - closeStream is guarded by a closed-flag
 *   - all in-flight .then() callbacks short-circuit on `closed`
 *   - response.on('error', ...) is registered to silence socket errors
 *   - the dynamic import of session-actions is cached at module scope
 */
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it, vi } from 'vitest';

import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

function readSource(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startBehaviorServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-sse-lifecycle-'));
  const config: AuthConfig = {
    jwtSecret: '0123456789abcdef0123456789abcdef',
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 4),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const user = await userStore.createUser('alice', 'alice-secret', 'customer');
  const jwtService = new JwtService(config);
  const session = {
    id: 'session-sse-lifecycle',
    userId: user.id,
    agentType: 'claude-code',
    status: 'running',
    startedAt: Date.now(),
    cwd: process.cwd(),
    task: 'SSE lifecycle regression',
    totalOutputChars: 0
  };
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn(() => [session]);
  manager.getSession = vi.fn((sessionId: string) => sessionId === session.id ? session : null);
  manager.log = vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 }));
  manager.tail = vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 }));

  let streamResponse: ServerResponse | undefined;
  const server = createHttpServer({
    manager: manager as never,
    auth: { enabled: true, config, userStore, jwtService },
    persistence: { enabled: false }
  });
  server.prependListener('request', (request, response) => {
    if (request.url?.includes('/stream')) {
      streamResponse = response;
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    getStreamResponse: () => streamResponse,
    manager,
    server,
    session,
    token: jwtService.sign(user.id, user.username, user.role),
    user,
    userStore
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sessionEventListenerCounts(manager: EventEmitter) {
  return {
    output: manager.listenerCount('output'),
    state: manager.listenerCount('state'),
    exit: manager.listenerCount('exit')
  };
}

describe('handleSseStream multi-agent audit round 2 contracts', () => {
  it('F1: exitHandler awaits checkAuthorization before flushing result/exit frames', () => {
    const src = readSource('http-server.ts');
    // Find the exitHandler block. The handler body has multiple nested braces
    // (the .then() callback), so we use a sentinel-based extraction: take
    // everything from `const exitHandler` up to the next handler definition
    // (`const keepalive =`) and check that checkAuthorization appears
    // before the first writeSse.
    const start = src.indexOf('const exitHandler =');
    const end = src.indexOf('const keepalive =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const exitBody = src.slice(start, end);
    const checkIdx = exitBody.indexOf('checkAuthorization()');
    const firstWriteIdx = exitBody.indexOf('writeSse(response,');
    expect(checkIdx).toBeGreaterThan(-1);
    expect(firstWriteIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(firstWriteIdx);
  });

  it('F2: closeStream is guarded by a closed-flag (no-op on second call)', () => {
    const src = readSource('http-server.ts');
    const closeMatch = src.match(/const closeStream = \(\): void => \{[\s\S]*?\};/);
    expect(closeMatch).not.toBeNull();
    const closeBody = closeMatch![0];
    expect(closeBody).toContain('if (closed) return');
    expect(closeBody).toContain('closed = true');
  });

  it('F2: every async .then() checkAuthorization path short-circuits on `closed`', () => {
    const src = readSource('http-server.ts');
    // Find every `void checkAuthorization().then(...)` block and assert that
    // each one has an `if (closed || ...)` early-return.
    const matches = src.match(/void checkAuthorization\(\)\.then\([\s\S]*?\}\);/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const block of matches) {
      expect(block).toMatch(/if \(closed \|\| !ok\)/);
    }
  });

  it('F3: response.on("error", ...) is registered', () => {
    const src = readSource('http-server.ts');
    expect(src).toMatch(/response\.on\(['"]error['"],/);
  });

  it('F4: dynamic import of session-actions is cached at module scope', () => {
    const src = readSource('http-server.ts');
    expect(src).toMatch(/_sessionActionsModulePromise/);
    // The per-event closure must not do its own `await import(...)`.
    const eventClosure = src.match(/void checkAuthorization\(\)\.then\([\s\S]*?\}\);/g) ?? [];
    for (const block of eventClosure) {
      expect(block).not.toMatch(/await import\(['"]\.\/server\/session-actions/);
    }
  });
});

describe('handleSseStream lifecycle behavior', () => {
  it('drops a deferred authorization callback after the request closes and cleans up listeners and timer', async () => {
    const started = await startBehaviorServer();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const listenerBaseline = sessionEventListenerCounts(started.manager);
      const response = await fetch(`${started.baseUrl}/sessions/${started.session.id}/stream`, {
        headers: { Authorization: `Bearer ${started.token}` }
      });
      reader = response.body!.getReader();
      await reader.read();

      const serverResponse = started.getStreamResponse();
      expect(serverResponse).toBeDefined();
      const writeSpy = vi.spyOn(serverResponse!, 'write');
      const recheck = deferred<typeof started.user | undefined>();
      const findByIdSpy = vi.spyOn(started.userStore, 'findById').mockImplementationOnce(() => recheck.promise);
      const clearCountBeforeClose = clearIntervalSpy.mock.calls.length;

      started.manager.emit('output', started.session.id, 'new output');
      await vi.waitFor(() => expect(findByIdSpy).toHaveBeenCalledTimes(1));
      await reader.cancel();
      await vi.waitFor(() => expect(sessionEventListenerCounts(started.manager)).toEqual(listenerBaseline));

      recheck.resolve(started.user);
      await flushPromises();

      expect(sessionEventListenerCounts(started.manager)).toEqual(listenerBaseline);
      expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearCountBeforeClose);
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      await reader?.cancel().catch(() => undefined);
      clearIntervalSpy.mockRestore();
      await closeServer(started.server);
      await rm(started.dataDir, { recursive: true, force: true });
    }
  });

  it('treats a response error as terminal, cleans up, and drops a deferred authorization callback', async () => {
    const started = await startBehaviorServer();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const listenerBaseline = sessionEventListenerCounts(started.manager);
      const response = await fetch(`${started.baseUrl}/sessions/${started.session.id}/stream`, {
        headers: { Authorization: `Bearer ${started.token}` }
      });
      reader = response.body!.getReader();
      await reader.read();

      const serverResponse = started.getStreamResponse();
      expect(serverResponse).toBeDefined();
      const writeSpy = vi.spyOn(serverResponse!, 'write');
      const recheck = deferred<typeof started.user | undefined>();
      const findByIdSpy = vi.spyOn(started.userStore, 'findById').mockImplementationOnce(() => recheck.promise);
      const clearCountBeforeError = clearIntervalSpy.mock.calls.length;

      started.manager.emit('output', started.session.id, 'new output');
      await vi.waitFor(() => expect(findByIdSpy).toHaveBeenCalledTimes(1));
      serverResponse!.emit('error', new Error('simulated response failure'));
      recheck.resolve(started.user);
      await flushPromises();

      const listenerCountsAfterError = sessionEventListenerCounts(started.manager);
      const clearCountAfterError = clearIntervalSpy.mock.calls.length;
      const writesAfterError = writeSpy.mock.calls.length;
      await reader.cancel();

      expect(listenerCountsAfterError).toEqual(listenerBaseline);
      expect(clearCountAfterError).toBeGreaterThan(clearCountBeforeError);
      expect(writesAfterError).toBe(0);
    } finally {
      await reader?.cancel().catch(() => undefined);
      clearIntervalSpy.mockRestore();
      await closeServer(started.server);
      await rm(started.dataDir, { recursive: true, force: true });
    }
  });
});
