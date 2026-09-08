import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function loadSafeRedirectTarget() {
  const html = readPublicFile('login.html');
  const match = /function safeRedirectTarget\(value\) \{[^}]+\}/.exec(html);
  if (!match) {
    throw new Error('safeRedirectTarget function not found');
  }
  return new Function(`${match[0]}; return safeRedirectTarget;`)() as (value: string | null) => string;
}

function loadLoginRuntimeScript() {
  const document = new JSDOM(readPublicFile('login.html')).window.document;
  const scripts = [...document.querySelectorAll('script:not([src])')];
  const script = scripts.at(-1)?.textContent;
  if (!script) throw new Error('login runtime script not found');
  return script;
}

function createLoginRuntime(fetchMock: ReturnType<typeof vi.fn>, token = '') {
  const virtualConsole = new VirtualConsole();
  const scriptErrors: string[] = [];
  virtualConsole.on('jsdomError', (error) => {
    if (!error.message.includes('Not implemented: navigation')) scriptErrors.push(error.message);
  });
  const dom = new JSDOM(`<!doctype html><html><body>
    <form id="login-form">
      <input id="username"><input id="password" type="password">
      <button id="login-submit" type="submit">Log in</button>
      <p id="login-error"></p>
    </form>
    <script>var t = function bundleRuntimeIdentifier() {};</script>
    <script>${readPublicFile('auth.js')}</script>
    <script>${loadLoginRuntimeScript()}</script>
  </body></html>`, {
    url: 'https://agentx.example/login',
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      Object.assign(window, { fetch: fetchMock, Headers, Response });
      if (token) {
        window.localStorage.setItem('agentx.auth.token', token);
        window.localStorage.setItem('agentx.auth.user', JSON.stringify({ id: 'legacy', username: 'legacy' }));
      }
    }
  });
  return { dom, scriptErrors };
}

async function startStaticServer() {
  const server = createHttpServer({ auth: { enabled: false } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

describe('authenticated web UI assets', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  it('serves login, chat, admin, and shared auth assets', async () => {
    const started = await startStaticServer();
    server = started.server;

    const login = await fetch(`${started.baseUrl}/login`);
    const chat = await fetch(`${started.baseUrl}/chat`);
    const admin = await fetch(`${started.baseUrl}/admin`);
    const authJs = await fetch(`${started.baseUrl}/auth.js`);
    const chatJs = await fetch(`${started.baseUrl}/chat.js`);
    const adminJs = await fetch(`${started.baseUrl}/admin.js`);

    expect(login.status).toBe(200);
    expect(await login.text()).toContain('id="login-form"');
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('id="chip-select"');
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain('id="key-form"');
    expect(authJs.headers.get('content-type')).toContain('application/javascript');
    expect(chatJs.headers.get('content-type')).toContain('application/javascript');
    expect(adminJs.headers.get('content-type')).toContain('application/javascript');
  });

  it('adds bearer tokens to authenticated fetch calls and handles 401', () => {
    const authJs = readPublicFile('auth.js');

    expect(authJs).toContain('Authorization');
    expect(authJs).toContain('Bearer ${token}');
    expect(authJs).toContain('response.status === 401');
    expect(authJs).toContain("window.location.assign('/login')");
    expect(authJs).toContain("function requireLogin(redirectTarget = '/login')");
    expect(authJs).toContain('localStorage');
  });

  it('connects SSE with an Authorization header without exposing the JWT in the URL', () => {
    const authJs = readPublicFile('auth.js');

    expect(authJs).toContain('openAuthorizedEventStream');
    expect(authJs).toContain("Accept: 'text/event-stream'");
    expect(authJs).toContain('response.body.getReader()');
    expect(authJs).not.toContain('/stream?token=');
  });

  it('parses authenticated fetch SSE events through the EventSource-compatible facade', async () => {
    const dom = new JSDOM('', { url: 'https://agentx.example/chat', runScripts: 'outside-only' });
    Object.assign(dom.window, {
      AbortController,
      Headers,
      TextDecoder
    });
    const fetchMock = vi.fn(async () => new Response(
      'event: output\ndata: {"data":"hello"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    ));
    dom.window.fetch = fetchMock as never;
    dom.window.localStorage.setItem('agentx.auth.token', 'secret-jwt');
    dom.window.eval(readPublicFile('auth.js'));

    const event = await new Promise<{ data: string }>((resolve, reject) => {
      const stream = dom.window.AgentXAuth.openAuthorizedEventStream('session/one');
      stream.addEventListener('output', (received: { data: string }) => {
        stream.close();
        resolve(received);
      });
      stream.onerror = reject;
    });

    expect(event.data).toBe('{"data":"hello"}');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0]!;
    expect(String(requestUrl)).toBe('https://agentx.example/sessions/session%2Fone/stream');
    expect(String(requestUrl)).not.toContain('secret-jwt');
    expect((requestOptions as RequestInit).headers).toBeInstanceOf(Headers);
    expect(((requestOptions as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer secret-jwt');
  });

  it('parses SSE when CRLF delimiters are split across network chunks', async () => {
    const dom = new JSDOM('', { url: 'https://agentx.example/chat', runScripts: 'outside-only' });
    Object.assign(dom.window, { AbortController, Headers, TextDecoder });
    const encoder = new TextEncoder();
    const chunks = [
      'event: output\r',
      '\n',
      'data: {"data":"split"}\r',
      '\n\r',
      '\n'
    ];
    dom.window.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      })
    })) as never;
    dom.window.localStorage.setItem('agentx.auth.token', 'secret-jwt');
    dom.window.eval(readPublicFile('auth.js'));

    const event = await new Promise<{ data: string }>((resolve, reject) => {
      const stream = dom.window.AgentXAuth.openAuthorizedEventStream('split-crlf');
      stream.addEventListener('output', (received: { data: string }) => {
        stream.close();
        resolve(received);
      });
      stream.onerror = reject;
    });

    expect(event.data).toBe('{"data":"split"}');
    dom.window.close();
  });

  it('allows login next redirects only to safe same-origin paths', () => {
    const safeRedirectTarget = loadSafeRedirectTarget();

    for (const allowed of ['/home', '/chat?chip=E52131', '/tickets#mine']) {
      expect(safeRedirectTarget(allowed)).toBe(allowed);
    }

    for (const blocked of ['', 'https://evil.example', '//evil.example', '/\\evil', '/auth/login', '/auth/token', '/login']) {
      expect(safeRedirectTarget(blocked)).toBe('');
    }
  });

  it('binds the login form without colliding with global bundle identifiers', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: 'fresh-token',
      user: { id: 'existing-user', username: 'existing-user', role: 'customer' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const { dom, scriptErrors } = createLoginRuntime(fetchMock);
    const username = dom.window.document.querySelector<HTMLInputElement>('#username')!;
    const password = dom.window.document.querySelector<HTMLInputElement>('#password')!;
    username.value = 'existing-user';
    password.value = 'correct-password';

    dom.window.document.querySelector<HTMLFormElement>('#login-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(dom.window.localStorage.getItem('agentx.auth.token')).toBe('fresh-token'));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://agentx.example/auth/login');
    expect(scriptErrors).toEqual([]);
    dom.window.close();
  });

  it('clears an expired cached token while keeping the login form usable', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    }));
    const { dom, scriptErrors } = createLoginRuntime(fetchMock, 'expired-token');

    await vi.waitFor(() => expect(dom.window.localStorage.getItem('agentx.auth.token')).toBeNull());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://agentx.example/auth/me');
    expect(dom.window.document.querySelector('#login-form')).not.toBeNull();
    expect(scriptErrors).toEqual([]);
    dom.window.close();
  });

  it('does not let a delayed stale-session 401 clear a fresh login', async () => {
    let resolveSessionCheck!: (response: Response) => void;
    const sessionCheck = new Promise<Response>((resolve) => {
      resolveSessionCheck = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/auth/me') return sessionCheck;
      return new Response(JSON.stringify({
        token: 'fresh-token',
        user: { id: 'existing-user', username: 'existing-user', role: 'customer' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const { dom, scriptErrors } = createLoginRuntime(fetchMock, 'expired-token');
    dom.window.document.querySelector<HTMLInputElement>('#username')!.value = 'existing-user';
    dom.window.document.querySelector<HTMLInputElement>('#password')!.value = 'correct-password';

    dom.window.document.querySelector<HTMLFormElement>('#login-form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(dom.window.localStorage.getItem('agentx.auth.token')).toBe('fresh-token'));
    resolveSessionCheck(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.window.localStorage.getItem('agentx.auth.token')).toBe('fresh-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(scriptErrors).toEqual([]);
    dom.window.close();
  });

  it('uses authenticated API calls from chat and admin pages', () => {
    const chatJs = readPublicFile('chat.js');
    const adminJs = readPublicFile('admin.js');

    expect(chatJs).toContain('AgentXAuth.authFetch');
    expect(chatJs).toContain("requireLogin('/login')");
    expect(chatJs).toContain('/sessions');
    expect(chatJs).toContain('/send');
    expect(chatJs).toContain('textContent');
    expect(adminJs).toContain('AgentXAuth.authFetch');
    expect(adminJs).toContain('/admin/users');
    expect(adminJs).toContain('/keys');
    expect(adminJs).not.toContain('passwordHash');
  });
});
