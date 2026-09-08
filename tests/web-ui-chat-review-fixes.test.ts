import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function extractFunctionSource(js: string, name: string): string {
  let start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in chat.js`);
  if (js.slice(start - 6, start) === 'async ') start -= 6;
  const parenStart = js.indexOf('(', start);
  let parenDepth = 0;
  let afterParams = -1;
  for (let index = parenStart; index < js.length; index += 1) {
    if (js[index] === '(') parenDepth += 1;
    if (js[index] === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        afterParams = index + 1;
        break;
      }
    }
  }
  const bodyStart = js.indexOf('{', afterParams);
  let depth = 0;
  for (let index = bodyStart; index < js.length; index += 1) {
    if (js[index] === '{') depth += 1;
    if (js[index] === '}') depth -= 1;
    if (depth === 0) return js.slice(start, index + 1);
  }
  throw new Error(`${name} body not closed`);
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

async function flushBrowserTasks() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function mode(id: 'standard' | 'enhanced' | 'multimodal', selectable = true) {
  return {
    id,
    label: id,
    available: selectable,
    selectable,
    allowsImageInput: id === 'multimodal' && selectable,
    disabledReason: selectable ? '' : '当前账户没有可用模式',
    disabledReasons: selectable ? [] : [{ code: 'MODE_UNAVAILABLE', message: '当前账户没有可用模式' }]
  };
}

function scopeOptions() {
  return {
    single: { chips: [{ chipId: 'E521.39', label: 'E521.39' }] },
    group: { productLines: [], brands: [], applications: [] },
    global: { chipCount: 1, fileCount: 1, tooLarge: false }
  };
}

describe('V2.2.37 Chat review fixes', () => {
  it('keeps one turn phase busy until a real terminal event and stops the server turn', () => {
    const js = readPublicFile('chat.js');
    const send = extractFunctionSource(js, 'sendMessage');
    const cancel = extractFunctionSource(js, 'cancelActiveTurn');
    const stream = extractFunctionSource(js, 'openStream');

    expect(js).toContain("turnPhase: 'idle'");
    expect(js).toContain('function setTurnPhase(');
    expect(send).toContain("setTurnPhase('submitting'");
    expect(send).not.toMatch(/finally\s*\{[\s\S]*setSendControlsBusy\(false\)/);
    expect(stream).toContain("setTurnPhase('running'");
    expect(stream).toMatch(/finishTurn|completeTurn/);
    expect(cancel).toMatch(/^async function cancelActiveTurn/);
    expect(cancel).toContain("method: 'DELETE'");
    expect(cancel).toContain("setTurnPhase('stopping'");
  });

  it('recovers an active turn after returning from a background tab', () => {
    const js = readPublicFile('chat.js');
    const init = extractFunctionSource(js, 'init');
    expect(js).toContain('async function reconcileVisibleTurn(');
    expect(init).toContain("document.visibilityState === 'visible'");
    expect(init).toContain('reconcileVisibleTurn');
  });

  it('makes image upload abortable, generation-safe and usable through paste and drop', () => {
    const js = readPublicFile('chat.js');
    const upload = extractFunctionSource(js, 'handleImageFiles');
    expect(js).toContain('imageUploadGeneration: 0');
    expect(js).toContain('imageUploadPending: false');
    expect(upload).toContain('AbortController');
    expect(upload).toMatch(/generation\s*!==\s*state\.imageUploadGeneration/);
    expect(js).toContain("addEventListener('paste'");
    expect(js).toContain("addEventListener('drop'");
    expect(js).toContain('state.imageUploadPending');
    expect(js).toContain('canUploadImages');
  });

  it('validates mode and scope before optimistic messages and surfaces structured API errors', () => {
    const js = readPublicFile('chat.js');
    const send = extractFunctionSource(js, 'sendMessage');
    const validationIndex = send.indexOf('validateMessageSubmission');
    const optimisticIndex = send.indexOf('appendOptimisticUserMessage');
    expect(validationIndex).toBeGreaterThan(-1);
    expect(optimisticIndex).toBeGreaterThan(validationIndex);
    expect(js).toContain('async function apiErrorFromResponse(');
    expect(js).toContain('function hasSelectableMode(');
    expect(js).toContain('chat-capability-status');
  });

  it('provides a mobile session drawer and real session search without hardcoded white', () => {
    const html = readPublicFile('chat.html');
    const css = readPublicFile('styles.css');
    const js = readPublicFile('chat.js');
    expect(html).toContain('id="mobile-session-toggle"');
    expect(html).toContain('id="mobile-session-backdrop"');
    expect(html).toContain('id="session-search"');
    expect(js).toContain('function setMobileSidebarOpen(');
    expect(js).toContain('state.sessionSearchQuery');
    expect(css).toContain('.mobile-sidebar-open');
    expect(css).not.toMatch(/@media \(max-width: 860px\)[\s\S]*?\.chat-hifi-sessions\s*\{\s*display:\s*none/);
    const newSessionRule = css.match(/\.chat-session-head #new-session\s*\{([^}]+)\}/)?.[1] || '';
    expect(newSessionRule).not.toContain('#FFFFFF');
    expect(newSessionRule).toContain('var(--accent-text)');
  });

  it('keeps a closed mobile drawer out of the tab order after desktop-to-mobile resize and inerts all outside surfaces while open', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let narrow = false;
    window.matchMedia = vi.fn(() => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }));
    window.requestAnimationFrame = (callback: FrameRequestCallback) => { callback(0); return 1; };
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {} }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const sidebar = window.document.getElementById('session-sidebar') as HTMLElement;
    const topbar = window.document.querySelector('.portal-topbar') as HTMLElement;
    const workspace = window.document.querySelector('.chat-workspace') as HTMLElement;
    expect(sidebar.inert).toBe(false);
    expect(sidebar.getAttribute('aria-hidden')).toBe('false');

    narrow = true;
    window.dispatchEvent(new window.Event('resize'));
    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute('aria-hidden')).toBe('true');
    expect(window.document.querySelector('[data-i18n="chat.session.title"]')?.textContent).toBe('Sessions');
    expect(window.document.querySelector('[data-mode="standard"] .chat-mode-title')?.textContent).toBe('Standard');

    window.document.getElementById('mobile-session-toggle')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await flushBrowserTasks();
    expect(sidebar.inert).toBe(false);
    expect(topbar.inert).toBe(true);
    expect(workspace.inert).toBe(true);
    (window.document.getElementById('mobile-session-backdrop') as HTMLButtonElement).click();
    expect(sidebar.inert).toBe(true);
    expect(topbar.inert).toBe(false);
    expect(workspace.inert).toBe(false);
    dom.window.close();
  });

  it('guards auth and sidebar storage and restores future scope descriptors', () => {
    const auth = readPublicFile('auth.js');
    const chat = readPublicFile('chat.js');
    expect(auth).toContain('function safeStorageGet(');
    expect(auth).toContain('function safeStorageSet(');
    expect(auth).toContain('function safeStorageRemove(');
    expect(chat).toContain('function restoreScopeFromSession(');
    expect(chat).toContain('scopeDescriptor');
    expect(chat).toContain('scopePresetId');
    expect(chat).toContain('scopeWorkspace');

    const normalizeSource = extractFunctionSource(chat, 'normalizeScopeDescriptor');
    // eslint-disable-next-line no-new-func
    const normalizeScopeDescriptor = new Function(
      `const SCOPE_MODES = ['single', 'group', 'global'];\n${normalizeSource}\nreturn normalizeScopeDescriptor;`
    )();
    expect(normalizeScopeDescriptor({
      scopePresetId: 'dynamic-group',
      scopeWorkspace: { mode: 'copy', groups: [{ dimension: 'productLine', value: 'Ambient' }] }
    })).toMatchObject({ mode: 'group', groups: [{ dimension: 'productLine', value: 'Ambient' }] });
    expect(normalizeScopeDescriptor({ scopePresetId: 'dynamic-global' })).toMatchObject({ mode: 'global' });
  });

  it('disables the composer and explains why when every mode is unavailable', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {} }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard', false), mode('enhanced', false), mode('multimodal', false)] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(true);
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    const status = window.document.getElementById('chat-capability-status') as HTMLElement;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('当前账户没有可用模式');
    dom.window.close();
  });

  it('keeps controls busy until DELETE confirms the running turn is stopped', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let stopped = false;
    let resolveDelete!: (value: unknown) => void;
    const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
    const requests: Array<{ path: string; method?: string }> = [];
    const source = { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => source,
      authFetch: async (path: string, init?: RequestInit) => {
        requests.push({ path, method: init?.method });
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          return jsonResponse({ sessions: [{
            id: 'session-1', chipId: 'E521.39', chatMode: 'standard',
            turnState: stopped ? 'idle' : 'running', status: stopped ? 'completed' : 'running'
          }] });
        }
        if (path === '/sessions/session-1/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/session-1' && init?.method === 'DELETE') return deleteResponse;
        if (path === '/sessions/session-1') return jsonResponse({ turnState: stopped ? 'idle' : 'running' });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const send = window.document.getElementById('send-message') as HTMLButtonElement;
    const stop = window.document.getElementById('stop-message') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(stop.hidden).toBe(false);

    stop.click();
    await flushBrowserTasks();
    expect(stop.disabled).toBe(true);
    expect(send.disabled).toBe(true);
    expect(requests).toContainEqual({ path: '/sessions/session-1', method: 'DELETE' });

    stopped = true;
    resolveDelete({ ok: true, status: 204, json: async () => ({}) });
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(send.disabled).toBe(false);
    expect(stop.hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('已停止');
    dom.window.close();
  });

  it('disables follow-up immediately after a live global search settles and history marks it restart-only', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const listeners = new Map<string, (event: { data: string }) => void>();
    const source = {
      addEventListener: vi.fn((type: string, listener: (event: { data: string }) => void) => listeners.set(type, listener)),
      close: vi.fn(),
      onerror: null
    };
    let settled = false;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => source,
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          return jsonResponse({ sessions: [{
            id: 'global-1', chatMode: 'standard', scopeDescriptor: { mode: 'global' },
            turnState: settled ? 'idle' : 'running', status: settled ? 'completed' : 'running',
            requiresNewScopeQuery: settled
          }] });
        }
        if (path === '/sessions/global-1/history') return jsonResponse({ messages: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);

    settled = true;
    listeners.get('final')?.({ data: JSON.stringify({ data: 'global answer' }) });
    await flushBrowserTasks();
    await flushBrowserTasks();

    const send = window.document.getElementById('send-message') as HTMLButtonElement;
    const status = window.document.getElementById('chat-capability-status') as HTMLElement;
    expect(send.disabled).toBe(true);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toContain('cannot continue in place');
    dom.window.close();
  });

  it('aborts an upload on mode change and ignores its late response', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let resolveUpload!: (value: unknown) => void;
    const uploadResponse = new Promise((resolve) => { resolveUpload = resolve; });
    let uploadSignal: AbortSignal | undefined;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {} }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [] });
        if (path === '/api/chat-uploads/images') {
          uploadSignal = init?.signal || undefined;
          return uploadResponse;
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const multimodal = window.document.querySelector('input[value="multimodal"]') as HTMLInputElement;
    multimodal.checked = true;
    multimodal.dispatchEvent(new window.Event('change', { bubbles: true }));
    const image = new window.File(['image'], 'scope.png', { type: 'image/png' });
    const paste = new window.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { files: [image], items: [] } });
    window.document.getElementById('message')?.dispatchEvent(paste);
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);

    const standard = window.document.querySelector('input[value="standard"]') as HTMLInputElement;
    standard.checked = true;
    standard.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(uploadSignal?.aborted).toBe(true);
    resolveUpload(jsonResponse({ images: [{ originalName: 'scope.png', url: '/api/chat-uploads/u/scope.png?token=late' }] }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect((window.document.getElementById('message') as HTMLTextAreaElement).value).not.toContain('token=late');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(false);
    dom.window.close();
  });

  it('treats revoked or missing active sessions as terminal and unlocks a fresh Chat state', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const sources: Array<{ addEventListener: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onerror: unknown }> = [];
    let historyCalls = 0;
    let chipCalls = 0;
    let scopeCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => {
        const source = { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
        sources.push(source);
        return source;
      },
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') {
          chipCalls += 1;
          return jsonResponse({ chips: chipCalls === 1
            ? [{ id: 'E521.39', label: 'E521.39' }]
            : [{ id: 'E522.95', label: 'E522.95' }] });
        }
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') {
          scopeCalls += 1;
          return jsonResponse(scopeCalls === 1 ? scopeOptions() : {
            single: { chips: [{ chipId: 'E522.95', label: 'E522.95' }] },
            group: { productLines: [], brands: [], applications: [] },
            global: { chipCount: 1, fileCount: 2, tooLarge: false }
          });
        }
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1
            ? [{ id: 'session-revoked', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }]
            : [] });
        }
        if (path === '/sessions/session-revoked/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/session-revoked') return jsonResponse({ error: 'Session not found' }, 404);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);

    let visibility = 'hidden';
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(false);
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('no longer available');
    const chipValues = Array.from((window.document.getElementById('chip-select') as HTMLSelectElement).options)
      .map((option) => option.value);
    expect(chipValues).toContain('E522.95');
    expect(chipValues).not.toContain('E521.39');
    expect(historyCalls).toBeGreaterThanOrEqual(2);
    expect(chipCalls).toBeGreaterThanOrEqual(2);
    expect(scopeCalls).toBeGreaterThanOrEqual(2);
    dom.window.close();
  });

  it('ignores a late unavailable result from a session that the user already left', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let resolveOldStatus!: (value: unknown) => void;
    const oldStatus = new Promise((resolve) => { resolveOldStatus = resolve; });
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }, { id: 'E522.95', label: 'E522.95' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [
          { id: 'old-running', title: 'Old running', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' },
          { id: 'new-idle', title: 'New idle', chipId: 'E522.95', chatMode: 'standard', turnState: 'idle', status: 'idle' }
        ] });
        if (path === '/sessions/old-running/history') return jsonResponse({ messages: [{ role: 'assistant', text: 'old answer' }] });
        if (path === '/sessions/new-idle/history') return jsonResponse({ messages: [{ role: 'assistant', text: 'new answer' }] });
        if (path === '/sessions/old-running') return oldStatus;
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    let visibility = 'hidden';
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    const newRow = Array.from(window.document.querySelectorAll<HTMLButtonElement>('.session-row'))
      .find((row) => row.textContent?.includes('New idle'));
    newRow?.click();
    await flushBrowserTasks();
    resolveOldStatus(jsonResponse({ error: 'Session not found' }, 404));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('New idle');
    expect(window.document.getElementById('conversation')?.textContent).toContain('new answer');
    expect(window.document.getElementById('chat-error')?.textContent).not.toContain('no longer available');
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);
    dom.window.close();
  });

  it('does not let an old idle poll unlock a newer turn in the same session', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let resolveOldStatus!: (value: unknown) => void;
    const oldStatus = new Promise((resolve) => { resolveOldStatus = resolve; });
    let statusCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'same-session-chip', label: 'Same session chip' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [
          { id: 'same-session', title: 'Same session', chipId: 'same-session-chip', chatMode: 'standard', turnState: 'running', status: 'running' }
        ] });
        if (path === '/sessions/same-session/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/same-session/send' && init?.method === 'POST') return jsonResponse({ turnState: 'running', status: 'running' });
        if (path === '/sessions/same-session') {
          statusCalls += 1;
          return statusCalls === 1 ? oldStatus : jsonResponse({ turnState: 'idle', status: 'idle' });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    let visibility = 'hidden';
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'hidden';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);

    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'new turn';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    resolveOldStatus(jsonResponse({ turnState: 'idle', status: 'idle' }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('keeps the Composer in a transition state while a selected session history is loading', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let resolveRunningHistory!: (value: unknown) => void;
    const runningHistory = new Promise((resolve) => { resolveRunningHistory = resolve; });
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [
          { id: 'idle-a', title: 'Idle A', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' },
          { id: 'running-b', title: 'Running B', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }
        ] });
        if (path === '/sessions/idle-a/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/running-b/history') return runningHistory;
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(false);
    const runningRow = Array.from(window.document.querySelectorAll<HTMLButtonElement>('.session-row'))
      .find((row) => row.textContent?.includes('Running B'));
    runningRow?.click();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    resolveRunningHistory(jsonResponse({ messages: [] }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('keeps new-session creation locked until the created session is selected', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    let resolveCreatedList!: (value: unknown) => void;
    const createdList = new Promise((resolve) => { resolveCreatedList = resolve; });
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return historyCalls === 1 ? jsonResponse({ sessions: [] }) : createdList;
        }
        if (path === '/sessions' && init?.method === 'POST') return jsonResponse({ sessionId: 'created-live' }, 201);
        if (path === '/sessions/created-live/history') return jsonResponse({ messages: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const chip = window.document.getElementById('chip-select') as HTMLSelectElement;
    chip.value = 'E521.39';
    chip.dispatchEvent(new window.Event('change', { bubbles: true }));
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'create safely';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    expect((window.document.getElementById('new-session') as HTMLButtonElement).disabled).toBe(true);

    resolveCreatedList(jsonResponse({ sessions: [
      { id: 'created-live', title: 'Created live', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }
    ] }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('Created live');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('keeps a successfully created running session busy when its first history load fails', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1 ? [] : [
            { id: 'created-history-error', title: 'Created history error', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }
          ] });
        }
        if (path === '/sessions' && init?.method === 'POST') return jsonResponse({ sessionId: 'created-history-error' }, 201);
        if (path === '/sessions/created-history-error/history') return jsonResponse({ error: 'History temporarily unavailable' }, 500);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const chip = window.document.getElementById('chip-select') as HTMLSelectElement;
    chip.value = 'E521.39';
    chip.dispatchEvent(new window.Event('change', { bubbles: true }));
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'create despite history error';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('Created history error');
    expect(window.document.getElementById('chat-error')?.textContent).toContain('History temporarily unavailable');
    expect(window.document.getElementById('conversation')?.textContent).not.toContain('发送失败');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('keeps a server-created session running when the first session-list refresh fails', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return historyCalls === 1
            ? jsonResponse({ sessions: [] })
            : jsonResponse({ error: 'Session list temporarily unavailable' }, 503);
        }
        if (path === '/sessions' && init?.method === 'POST') {
          return jsonResponse({ sessionId: 'created-list-error', turnState: 'running', status: 'running' }, 201);
        }
        if (path === '/sessions/created-list-error/history') return jsonResponse({ messages: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const chip = window.document.getElementById('chip-select') as HTMLSelectElement;
    chip.value = 'E521.39';
    chip.dispatchEvent(new window.Event('change', { bubbles: true }));
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'create through list outage';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('create through list outage');
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Failed to load sessions (503)');
    expect(window.document.getElementById('conversation')?.textContent).not.toContain('Failed to send');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('does not add a permanent activity placeholder when a new session already finished', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1 ? [] : [
            { id: 'created-idle', title: 'Created idle', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }
          ] });
        }
        if (path === '/sessions' && init?.method === 'POST') return jsonResponse({ sessionId: 'created-idle' }, 201);
        if (path === '/sessions/created-idle/history') return jsonResponse({ error: 'Idle history temporarily unavailable' }, 500);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const chip = window.document.getElementById('chip-select') as HTMLSelectElement;
    chip.value = 'E521.39';
    chip.dispatchEvent(new window.Event('change', { bubbles: true }));
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'quick question';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('conversation')?.textContent).toContain('quick question');
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Idle history temporarily unavailable');
    expect(window.document.getElementById('conversation')?.textContent).not.toContain('正在查阅资料');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(false);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    dom.window.close();
  });

  it('discards a late terminal session-list snapshot after a newer turn starts', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const sources: Array<{ handlers: Map<string, (event: any) => void>; close: ReturnType<typeof vi.fn>; onerror: unknown }> = [];
    let historyCalls = 0;
    let resolveOldList!: (value: unknown) => void;
    const oldList = new Promise((resolve) => { resolveOldList = resolve; });
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => {
        const handlers = new Map<string, (event: any) => void>();
        const source = {
          handlers,
          close: vi.fn(),
          onerror: null,
          addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler); }
        };
        sources.push(source);
        return source;
      },
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          if (historyCalls === 1) return jsonResponse({ sessions: [
            { id: 'same-live', title: 'Same live', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }
          ] });
          return oldList;
        }
        if (path === '/sessions/same-live/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/same-live/send' && init?.method === 'POST') return jsonResponse({ turnState: 'running', status: 'running' });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const firstSource = sources.at(-1);
    firstSource?.handlers.get('final')?.({ data: JSON.stringify({ data: 'old turn complete' }) });
    await Promise.resolve();
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(false);
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'new turn';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    resolveOldList(jsonResponse({ sessions: [
      { id: 'same-live', title: 'Same live', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }
    ] }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.querySelector('.session-row')?.textContent).toContain('Running');
    expect(window.document.querySelector('.session-row')?.textContent).not.toContain('History');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    dom.window.close();
  });

  it('cleans a stale session selected from a concurrently outdated history list', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1
            ? [
                { id: 'valid-session', title: 'Valid session', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' },
                { id: 'stale-session', title: 'Stale session', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }
              ]
            : [{ id: 'valid-session', title: 'Valid session', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }] });
        }
        if (path === '/sessions/valid-session/history') return jsonResponse({ messages: [{ role: 'assistant', text: 'valid answer' }] });
        if (path === '/sessions/stale-session/history') return jsonResponse({ error: 'History gone' }, 404);
        if (path === '/sessions/stale-session/log') return jsonResponse({ error: 'Session access revoked' }, 403);
        if (path === '/sessions/stale-session') return jsonResponse({ error: 'Session gone' }, 404);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const staleRow = Array.from(window.document.querySelectorAll<HTMLButtonElement>('.session-row'))
      .find((row) => row.textContent?.includes('Stale session'));
    staleRow?.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('no longer available');
    expect(window.document.getElementById('session-list')?.textContent).toContain('Valid session');
    expect(window.document.getElementById('session-list')?.textContent).not.toContain('Stale session');
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);
    dom.window.close();
  });

  it('cleans a session that becomes unavailable during send', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1
            ? [{ id: 'send-revoked', title: 'Send revoked', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }]
            : [] });
        }
        if (path === '/sessions/send-revoked/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/send-revoked/send' && init?.method === 'POST') return jsonResponse({ error: 'Forbidden' }, 403);
        if (path === '/sessions/send-revoked') return jsonResponse({ error: 'Session not found' }, 404);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'retry this safely';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('no longer available');
    expect(message.value).toBe('retry this safely');
    expect(message.disabled).toBe(false);
    dom.window.close();
  });

  it('preserves an accessible session when send is forbidden for a non-terminal reason', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [
          { id: 'send-forbidden', title: 'Send forbidden', chipId: 'E521.39', chatMode: 'standard', turnState: 'idle', status: 'idle' }
        ] });
        if (path === '/sessions/send-forbidden/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/send-forbidden/send' && init?.method === 'POST') return jsonResponse({ error: 'Policy denied this message' }, 403);
        if (path === '/sessions/send-forbidden') return jsonResponse({ turnState: 'idle', status: 'idle' });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    message.value = 'forbidden content';
    (window.document.getElementById('message-form') as HTMLFormElement)
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('Send forbidden');
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Policy denied this message');
    expect(message.value).toBe('forbidden content');
    expect(message.disabled).toBe(false);
    dom.window.close();
  });

  it('cleans a running session when Stop reports it is already unavailable', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    let historyCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          return jsonResponse({ sessions: historyCalls === 1
            ? [{ id: 'stop-revoked', title: 'Stop revoked', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }]
            : [] });
        }
        if (path === '/sessions/stop-revoked/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/stop-revoked' && init?.method === 'DELETE') return jsonResponse({ error: 'Session not found' }, 404);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.getElementById('stop-message') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Session not found');
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    dom.window.close();
  });

  it('keeps a turn locked when both Stop and its status probe are inconclusive', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener() {}, close() {}, onerror: null }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') return jsonResponse({ sessions: [
          { id: 'stop-uncertain', title: 'Stop uncertain', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }
        ] });
        if (path === '/sessions/stop-uncertain/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/stop-uncertain' && init?.method === 'DELETE') return jsonResponse({ error: 'Gateway timeout' }, 502);
        if (path === '/sessions/stop-uncertain') return jsonResponse({ error: 'Status unavailable' }, 503);
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.getElementById('stop-message') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.textContent).toContain('Stop uncertain');
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Gateway timeout');
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });

  it('finishes reconnect recovery when the terminal log disappears after an idle status', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const sources: Array<Record<string, any>> = [];
    let historyCalls = 0;
    let sessionHistoryCalls = 0;
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', localePreference: 'en-US' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => {
        const source = { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
        sources.push(source);
        return source;
      },
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          historyCalls += 1;
          if (historyCalls === 1) {
            return jsonResponse({ sessions: [{ id: 'reconnect-gone', title: 'Reconnect gone', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }] });
          }
          return jsonResponse({ sessions: [] });
        }
        if (path === '/sessions/reconnect-gone/history') {
          sessionHistoryCalls += 1;
          return sessionHistoryCalls === 1
            ? jsonResponse({ messages: [] })
            : jsonResponse({ error: 'History gone' }, 404);
        }
        if (path === '/sessions/reconnect-gone/log') return jsonResponse({ error: 'Log gone' }, 410);
        if (path === '/sessions/reconnect-gone') return jsonResponse({ turnState: 'idle', status: 'idle' });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const activeSource = sources.at(-1);
    expect(typeof activeSource?.onerror).toBe('function');
    window.setTimeout = ((callback: TimerHandler) => {
      void Promise.resolve().then(() => typeof callback === 'function' && callback());
      return 101;
    }) as typeof window.setTimeout;
    activeSource?.onerror();
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-meta')?.hidden).toBe(true);
    expect(window.document.getElementById('chat-error')?.textContent).toContain('Log gone');
    expect((window.document.getElementById('message') as HTMLTextAreaElement).disabled).toBe(false);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(true);
    dom.window.close();
  });

  it('polls and reopens the stream after an active tab becomes visible again', async () => {
    const dom = new JSDOM(readPublicFile('chat.html'), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const sources: Array<{ addEventListener: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; onerror: unknown }> = [];
    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => {
        const source = { addEventListener: vi.fn(), close: vi.fn(), onerror: null };
        sources.push(source);
        return source;
      },
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return jsonResponse({ modes: [mode('standard'), mode('enhanced'), mode('multimodal')] });
        if (path === '/chips') return jsonResponse({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/api/scope-presets') return jsonResponse({ presets: [] });
        if (path === '/api/scope-options') return jsonResponse(scopeOptions());
        if (path === '/sessions/history') {
          return jsonResponse({ sessions: [{ id: 'session-1', chipId: 'E521.39', chatMode: 'standard', turnState: 'running', status: 'running' }] });
        }
        if (path === '/sessions/session-1/history') return jsonResponse({ messages: [] });
        if (path === '/sessions/session-1') return jsonResponse({ turnState: 'running' });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('chat.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    const baselineSources = sources.length;
    expect(baselineSources).toBeGreaterThan(0);
    const activeSource = sources[baselineSources - 1];

    let visibility = 'hidden';
    Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => visibility });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    expect(activeSource.close).toHaveBeenCalled();

    visibility = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(sources).toHaveLength(baselineSources + 1);
    expect((window.document.getElementById('send-message') as HTMLButtonElement).disabled).toBe(true);
    expect((window.document.getElementById('stop-message') as HTMLButtonElement).hidden).toBe(false);
    dom.window.close();
  });
});
