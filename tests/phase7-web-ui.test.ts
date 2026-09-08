import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function okJson(payload: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => payload
  };
}

function searchModesPayload() {
  return {
    modes: [
      {
        id: 'standard',
        label: 'Standard',
        description: 'Default text Q&A',
        defaultModelId: 'haiku',
        modelLabel: 'Standard',
        creditUnits: 50,
        available: true,
        selectable: true,
        allowsImageInput: false,
        disabledReasons: []
      },
      {
        id: 'enhanced',
        label: 'Enhanced',
        description: 'Long-context answers',
        defaultModelId: 'sonnet',
        modelLabel: 'Enhanced',
        creditUnits: 100,
        available: true,
        selectable: true,
        allowsImageInput: false,
        disabledReasons: []
      },
      {
        id: 'multimodal',
        label: 'Multimodal',
        description: 'Image-aware answers',
        defaultModelId: 'opus',
        modelLabel: 'MiMo V2.5',
        creditUnits: 150,
        available: true,
        selectable: true,
        allowsImageInput: true,
        disabledReasons: []
      }
    ]
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('phase 7 chat ui contract', () => {
  const chatHtml = () => readPublicFile('chat.html');
  const chatJs = () => readPublicFile('chat.js');
  const adminHtml = () => readPublicFile('admin.html');
  const adminJs = () => readPublicFile('admin.js');
  const styles = () => readPublicFile('styles.css').replace(/\r\n/g, '\n');

  it('keeps the composer and keyboard send contract wired to the chat DOM', () => {
    const html = chatHtml();
    const js = chatJs();

    for (const token of [
      'id="message-form"',
      'id="message"',
      'id="send-message"',
      'id="conversation"',
      'id="session-meta"',
      'id="chat-error"',
      'id="chip-select"'
    ]) {
      expect(html).toContain(token);
    }

    expect(js).toContain("els.message.addEventListener('keydown'");
    expect(js).toContain("event.key === 'Enter'");
    expect(js).toContain('!event.shiftKey');
    expect(js).toContain('event.preventDefault()');
    expect(js).toContain('els.messageForm.requestSubmit()');
    expect(js).toContain('const text = rawText.trim()');
    expect(js).toContain('if (!text)');
    expect(js).toContain('function renderSessionMeta()');
    expect(styles()).toContain('.session-meta');
  });

  it('keeps admin prompt history controls limited to summary and rollback', () => {
    const html = adminHtml();
    const js = adminJs();
    const css = styles();

    expect(html).toContain('id="prompt-history-summary"');
    expect(html).toContain('id="prompt-rollback"');
    expect(html).toContain('载入上一版草稿');
    expect(js).toContain('/history');
    expect(js).toContain('function rollbackPrompt()');
    expect(js).toContain('function loadPromptHistoryDraft(entry)');
    expect(css).toContain('.prompt-history-panel');

    expect(html.toLowerCase()).not.toContain('prompt-diff');
    expect(html.toLowerCase()).not.toContain('test-run');
    expect(js.toLowerCase()).not.toContain('promptdiff');
    expect(js.toLowerCase()).not.toContain('test-run');
  });

  it('renders optimistic user messages with recoverable failure state', () => {
    const js = chatJs();
    const css = styles().replace(/\r\n/g, '\n');

    expect(js).toContain('function appendOptimisticUserMessage(text)');
    expect(js).toContain("status: 'pending'");
    expect(js).toContain('const optimistic = appendOptimisticUserMessage(text)');
    expect(js).toContain("markMessageStatus(optimistic.id, 'sent')");
    expect(js).toContain("markMessageStatus(optimistic.id, 'failed')");
    expect(js).toContain('els.message.value = rawText');
    expect(js).toContain('els.message.focus()');
    expect(js).toContain("setError(error.message || i18n('chat.error.send'))");
    expect(js).toContain('item.dataset.clientId = message.id');
    expect(js).toContain('item.dataset.status = message.status');

    expect(css).toContain('.message.pending');
    expect(css).toContain('.message.failed');
    expect(css).toContain('.message-status');
    expect(css).toContain('.message-activity-dots');
    expect(css).not.toContain('agentx-lookup-dots');
  });

  it('keeps streaming output as a status placeholder until the final answer arrives', () => {
    const js = chatJs();

    expect(js).toContain('activeAssistantMessageId');
    expect(js).toContain('function updateAssistantMessage(text)');
    expect(js).toContain('function showAssistantActivity()');
    expect(js).toContain('正在查阅资料');
    expect(js).toContain('message-activity-dots');
    expect(js).toContain('function startActivityDots(messageId, element)');
    expect(js).toContain('function stopActivityDots(messageId)');
    expect(js).toContain('function clearActivityTimers()');
    expect(js).toContain('streamBuffers: new Map()');
    expect(js).toContain('activityTimers: new Map()');
    expect(js).toContain('function bufferStreamOutput(sessionId, chunk)');
    expect(js).toContain('function areMessagesEquivalent(left, right)');
    expect(js).toContain('if (active.text === text)');
    expect(js).toContain('state.messages.find((message) => message.id === state.activeAssistantMessageId)');
    expect(js).toContain('active.text = text');
    expect(js).toContain('active.text += text');
    expect(js).toContain("id: nextClientId('assistant')");
    expect(js).toContain("status: 'streaming'");
    expect(js).toContain('state.activeAssistantMessageId = message.id');
    expect(js).toContain('showAssistantActivity();');
    expect(js).toContain("openStream(session.id, { preserveActiveAssistant: true })");
    expect(js).toContain("bufferStreamOutput(sessionId, payload.data || '')");
    expect(js).toContain('showAssistantActivity()');
    expect(js).toContain("payload.state?.turnState === 'idle'");
    expect(js).toContain('refreshLog()');
    expect(js).toContain('closeStream()');
    expect(js).toContain('items = { plain: [], assistant: [], result: [] }');
    expect(js).toContain('function finalizeAssistantMessage(text, options = {})');
    expect(js).toContain("source.addEventListener('result', (event) => handleFinalAssistantEvent(event, sessionId, source))");
    expect(js).toContain("source.addEventListener('final', (event) => handleFinalAssistantEvent(event, sessionId, source))");
    expect(js).toContain('lastAssistant.text === text || lastAssistant.text.includes(text)');
    expect(js).toContain('active.status = undefined');
  });

  it('treats /log and snapshot messages as authoritative restored history', () => {
    const js = chatJs();
    const refreshIndex = js.indexOf('async function refreshLog()');
    const selectIndex = js.indexOf('async function selectSession(sessionId, options = {})');
    const openIndex = js.indexOf('openStream(sessionId)');

    expect(js).toContain('function formatPayloadMessages(payload, options');
    expect(js).toContain('Array.isArray(payload.messages)');
    expect(js).toContain('setMessages(formatPayloadMessages(payload, { sessionId: targetSessionId }));');
    expect(js).toContain('mergeSnapshotMessages(snapshotMessages, sessionId)');
    expect(js).toContain('preserveLocalFailures: true');
    expect(js).toContain('preserveActiveAssistant: true');
    expect(js).toContain('state.activeAssistantMessageId = null');
    expect(js).toContain('function shouldIgnoreStreamEvent(sessionId, source)');
    expect(js).toContain('sessionId !== state.activeSessionId || source !== state.eventSource');
    expect(js).toContain('if (shouldIgnoreStreamEvent(sessionId, source))');
    expect(js).toContain('state.activeChipId = session?.chipId || null');
    expect(js).toContain('els.chipSelect.disabled = true');
    expect(js).not.toContain('setTranscript');

    expect(selectIndex).toBeGreaterThan(refreshIndex);
    expect(openIndex).toBeGreaterThan(selectIndex);
  });

  it('renders untrusted chat text through a safe markdown DOM renderer', () => {
    const js = chatJs();

    expect(js).toContain('renderMessageContent(body, visibleText)');
    expect(js).toContain('document.createTextNode');
    expect(js).toContain('renderSafeLink');
    expect(js).toContain('renderSafeImage');
    expect(js).toContain('function stripVisibleFingerprintMarker(text)');
    expect(js).toContain('status.textContent');
    expect(js).toContain('row.textContent');
    expect(js).toContain('opt.textContent');
    expect(js).not.toContain('innerHTML');
    expect(js).toContain('els.conversation.replaceChildren()');
  });

  it('filters dangerous markdown links and external images in rendered chat DOM', async () => {
    const dom = new JSDOM(chatHtml(), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;

    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'admin', role: 'admin' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener: () => undefined, close: () => undefined }),
      authFetch: async (path: string) => {
        if (path === '/api/search-modes') return okJson(searchModesPayload());
        if (path === '/chips') return okJson({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/sessions/history') {
          return okJson({
            sessions: [{
              id: 'session-1',
              agentType: 'claude-code',
              status: 'completed',
              sessionMode: 'conversation',
              chatMode: 'standard',
              chipId: 'E521.39',
              title: 'safety'
            }]
          });
        }
        if (path === '/sessions/session-1/history') {
          return okJson({
            messages: [{
              role: 'assistant',
              text: [
                '### Safe',
                '<script>alert(1)</script>',
                '[bad](javascript:alert(1)) [file](file:///etc/passwd) [ok](/tickets)',
                '![external](https://evil.example/a.png) ![internal](/api/chat-uploads/abc/file.png?token=t)'
              ].join('\n')
            }]
          });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(chatJs());
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const content = window.document.querySelector('.message-content') as HTMLElement;
    expect(content.querySelector('script')).toBeNull();
    expect(content.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(content.querySelector('a[href^="file:"]')).toBeNull();
    expect(content.querySelector('a[href="/tickets"]')).not.toBeNull();
    const images = [...content.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(images).toEqual(['/api/chat-uploads/abc/file.png?token=t']);
    expect(content.textContent).toContain('<script>alert(1)</script>');
    expect(content.textContent).toContain('[图片已过滤: external]');
  });

  it('renders service-driven search modes and gates uploads by selected mode', async () => {
    const dom = new JSDOM(chatHtml(), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const bodies: any[] = [];

    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'customer', role: 'customer', credits: { balanceUnits: 120 } }),
      logout: () => undefined,
      openAuthorizedEventStream: () => ({ addEventListener: () => undefined, close: () => undefined }),
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') {
          const payload = searchModesPayload();
          payload.modes[2] = {
            ...payload.modes[2],
            available: false,
            selectable: false,
            allowsImageInput: false,
            disabledReason: 'This mode is not available to this identity.',
            disabledReasons: [{ code: 'MODEL_NOT_AUTHORIZED', message: 'This mode is not available to this identity.' }]
          } as any;
          return okJson(payload);
        }
        if (path === '/chips') return okJson({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        if (path === '/sessions/history') return okJson({ sessions: [] });
        if (path === '/sessions' && init?.method === 'POST') {
          bodies.push(JSON.parse(String(init.body)));
          return { ...okJson({ sessionId: 'session-ui' }), status: 201 };
        }
        if (path === '/sessions/session-ui/history') return okJson({ messages: [] });
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(chatJs());
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const options = [...window.document.querySelectorAll('.chat-mode-segment')];
    expect(options).toHaveLength(3);
    expect(window.document.getElementById('model-credit-status')).toBeNull();
    expect((window.document.querySelector('input[value="multimodal"]') as HTMLInputElement).disabled).toBe(true);
    expect(window.document.querySelector('[data-mode="multimodal"]')?.textContent).not.toContain('This mode is not available');
    expect(window.document.querySelector('[data-mode="multimodal"] .chat-mode-reason')).toBeNull();
    expect((window.document.getElementById('chat-image-input') as HTMLInputElement).disabled).toBe(true);
    expect(window.document.getElementById('image-upload-control')?.getAttribute('title')).toContain('多模态模式');

    (window.document.getElementById('chip-select') as HTMLSelectElement).value = 'E521.39';
    (window.document.getElementById('message') as HTMLTextAreaElement).value = 'hello';
    window.document.getElementById('message-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    expect(bodies[0]).toMatchObject({ chatMode: 'standard', chipId: 'E521.39' });
    expect(bodies[0]).not.toHaveProperty('model');
  });

  it('starts a separate assistant bubble after a finalized streaming turn', async () => {
    const dom = new JSDOM(chatHtml(), {
      url: 'http://127.0.0.1:3000/chat',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const sources: Array<Record<string, any>> = [];
    const sessions: any[] = [];
    const messagesBySession = new Map<string, Array<{ role: string; text: string }>>();

    class FakeEventSource {
      listeners = new Map<string, Array<(event: { data: string }) => void>>();
      addEventListener(type: string, listener: (event: { data: string }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
      }
      emit(type: string, payload: unknown) {
        for (const listener of this.listeners.get(type) || []) {
          listener({ data: JSON.stringify(payload) });
        }
      }
      close() {}
    }

    window.AgentXAuth = {
      requireLogin: () => true,
      getUser: () => ({ username: 'admin', role: 'admin' }),
      logout: () => undefined,
      openAuthorizedEventStream: () => {
        const source = new FakeEventSource();
        sources.push(source);
        return source;
      },
      authFetch: async (path: string, init?: RequestInit) => {
        if (path === '/api/search-modes') return okJson(searchModesPayload());
        if (path === '/chips') {
          return okJson({ chips: [{ id: 'E521.39', label: 'E521.39' }] });
        }
        if (path === '/sessions/history') {
          return okJson({ sessions });
        }
        if (path === '/sessions' && !init) {
          return okJson({ sessions });
        }
        if (path === '/sessions' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          const session = {
            id: 'session-1',
            agentType: 'claude-code',
            status: 'running',
            startedAt: Date.now(),
            sessionMode: 'conversation',
            chipId: body.chipId,
            turnState: 'running',
            title: body.task,
            cwd: 'E:\\Elmos_work_space\\datasheet-md\\E521.39'
          };
          sessions.splice(0, sessions.length, session);
          messagesBySession.set(session.id, [{ role: 'user', text: body.task }]);
          return { ...okJson({ sessionId: session.id }), status: 201 };
        }
        if (path === '/sessions/session-1/log') {
          return okJson({ messages: messagesBySession.get('session-1') || [] });
        }
        if (path === '/sessions/session-1/history') {
          return okJson({ messages: messagesBySession.get('session-1') || [] });
        }
        if (path === '/sessions/session-1/send' && init?.method === 'POST') {
          const body = JSON.parse(String(init.body));
          messagesBySession.get('session-1')?.push({ role: 'user', text: body.data });
          return okJson({ sent: true, status: 'running', turnState: 'running' });
        }
        throw new Error(`Unexpected fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('i18n.js'));
    window.eval(readPublicFile('assets/i18n-chat.js'));
    window.eval(chatJs());
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const chipSelect = window.document.getElementById('chip-select') as HTMLSelectElement;
    const message = window.document.getElementById('message') as HTMLTextAreaElement;
    const form = window.document.getElementById('message-form') as HTMLFormElement;
    chipSelect.value = 'E521.39';

    message.value = 'first prompt';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    let placeholder = window.document.querySelector('.message.assistant');
    expect(placeholder?.textContent?.trim().startsWith('正在查阅资料')).toBe(true);
    expect(placeholder?.querySelector('.message-activity-dots')).not.toBeNull();

    sources[0].emit('output', {
      data: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: '<tool_call>\n<invoke_name>Read</invoke_name>\n</tool_call>'
              }
            ]
          }
        })
      ].join('\n')
    });
    placeholder = window.document.querySelector('.message.assistant');
    expect(placeholder?.textContent?.trim().startsWith('正在查阅资料')).toBe(true);
    expect(placeholder?.querySelector('.message-activity-dots')).not.toBeNull();
    sources[0].emit('output', { data: '123' });
    expect(window.document.querySelector('.message.assistant')).toBe(placeholder);
    // Keep the browser resilient to a legacy or delayed idle-before-result
    // sequence even though current servers emit the result first.
    sources[0].emit('state', { state: { turnState: 'idle', turnCount: 1 } });
    sources[0].emit('result', { data: '123' });
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(window.document.querySelector('.message.assistant .message-content')?.textContent?.trim()).toBe('123');

    message.value = 'second prompt';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    sources[sources.length - 1].emit('output', { data: '789' });
    sources[sources.length - 1].emit('result', { data: '789' });

    const assistantMessages = [...window.document.querySelectorAll('.message.assistant')].map((node) =>
      node.querySelector('.message-content')?.textContent?.trim()
    );
    expect(assistantMessages).toEqual(['123', '789']);
    expect(window.document.getElementById('session-meta')?.textContent).not.toContain('工作目录');
  });
});

describe('phase 7 admin guard and key copy contract', () => {
  const adminHtml = () => readPublicFile('admin.html');
  const adminJs = () => readPublicFile('admin.js');
  const styles = () => readPublicFile('styles.css').replace(/\r\n/g, '\n');

  it('renders an admin login shell before the operation surface', () => {
    const html = adminHtml();
    const css = styles();

    expect(html).toContain('id="admin-login-shell"');
    expect(html).toContain('id="admin-login-form"');
    expect(html).toContain('id="admin-username"');
    expect(html).toContain('id="admin-password"');
    expect(html).toContain('id="admin-no-permission"');
    expect(html).toContain('data-portal-auth');
    expect(html).not.toContain('id="logout"');
    expect(html).toContain('id="admin-operation-surface" hidden');
    expect(html.indexOf('id="admin-login-shell"')).toBeLessThan(html.indexOf('id="admin-operation-surface"'));
    expect(html).toContain('data-admin-control');
    expect(css).toContain('[hidden]');
    expect(css).toContain('display: none !important');
    expect(css).toContain('.meta-pill:empty');

    const cssDom = new JSDOM(`<style>${css}</style><main hidden class="admin-grid"></main>`);
    expect(cssDom.window.getComputedStyle(cssDom.window.document.querySelector('main') as HTMLElement).display).toBe(
      'none'
    );
  });

  it('keeps the operation surface hidden for unauthenticated admin visits', async () => {
    const fetchCalls: string[] = [];
    const dom = new JSDOM(adminHtml(), {
      url: 'http://127.0.0.1:3000/admin',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    window.AgentXAuth = {
      getUser: () => null,
      logout: () => undefined,
      login: async () => {
        throw new Error('unexpected login');
      },
      clearToken: () => undefined,
      authFetch: async (path: string) => {
        fetchCalls.push(path);
        return okJson({});
      }
    };

    window.eval(adminJs());
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();

    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(true);
    expect(window.document.querySelector('[data-portal-auth]')).not.toBeNull();
    expect(window.document.getElementById('logout')).toBeNull();
    expect(fetchCalls).toEqual([]);
  });

  it('confirms role === admin before loading or showing admin operations', () => {
    const js = adminJs();

    expect(js).toContain('function isAdminUser(user)');
    expect(js).toContain("user.role === 'admin'");
    expect(js).toContain('showAdminLogin');
    expect(js).toContain('showAdminOperations');
    expect(js).toContain('adminLoginForm.addEventListener');
    expect(js).toContain('AgentXAuth.login');
    expect(js).toContain('AgentXAuth.clearToken()');
    expect(js).toContain('renderAdminPortalAuth');
    expect(js).not.toContain('els.logout');
    expect(js).toContain('No admin permission');
    expect(js.indexOf('if (!isAdminUser(currentUser))')).toBeLessThan(js.indexOf('await loadAdminData()'));
  });

  it('lists full MCP Key values with copy buttons and sensitivity warning', () => {
    const js = adminJs();
    const css = styles();

    expect(js).toContain('function renderKeyValue(key)');
    expect(js).toContain('key.key');
    expect(js).toContain('copyFullKey');
    expect(js).toContain('navigator.clipboard?.writeText(value)');
    expect(js).toContain('Sensitive credential');
    expect(js).toContain('Full MCP Key');
    expect(css).toContain('.key-sensitive-warning');
    expect(css).toContain('.key-value');
  });

  it('wires editable chip catalog and per-user chip grants in Admin UI', () => {
    const html = adminHtml();
    const js = adminJs();
    const css = styles();

    for (const token of [
      'id="new-role"',
      'id="user-create-error"',
      'class="admin-workspace"',
      'admin-user-context',
      'user-detail-panel',
      'class="admin-chip-panel',
      'id="chip-add"',
      'id="chip-save"',
      'id="chip-restart-notice"',
      'id="selected-user-access-summary"',
      'id="selected-user-access-editor"',
      'id="selected-user-access-save"',
      'id="selected-user-access-error"'
    ]) {
      expect(html).toContain(token);
    }

    expect(js).toContain("authFetch('/admin/chips'");
    expect(js).not.toContain("authFetch('/admin/chip-access'");
    expect(js).toContain("role: document.getElementById('new-role')");
    expect(js).toContain("userCreateError: document.getElementById('user-create-error')");
    expect(js).toContain("selectedUserAccessSave: document.getElementById('selected-user-access-save')");
    expect(js).toContain('function renderSelectedUserAccess()');
    expect(js).toContain('function saveSelectedUserAccess()');
    expect(js).toContain('role');
    expect(js).toContain('setUserCreateError');
    expect(js).toContain('function renderChipCatalogRow(chip)');
    expect(js).toContain('function fillChipEditor');
    expect(js).toContain('function applyChipEditor');
    expect(js).toContain('function collectChipCatalog()');
    expect(js).toContain('chip-editor-workspace-dir');
    expect(js).toContain('function isAbsoluteWorkspaceDir(value)');
    expect(js).toContain('需在服务重启后才对新会话的检索与授权生效');
    expect(js).toContain('function renderChipAccess()');
    expect(js).toContain('input[type="checkbox"]:checked');
    expect(js).toContain('isChipReferenced');

    expect(css).toContain('.chip-catalog-row');
    // B1：芯片编辑器改为真正的右侧滑出抽屉，接入既有 .admin-drawer/.admin-drawer-backdrop 组件，
    // 退役此前占位用的 .admin-drawer-panel（inline 块 + margin-top，未真正滑出）。
    expect(css).toContain('.admin-drawer');
    expect(css).toContain('.admin-drawer-backdrop');
    expect(css).not.toContain('.admin-drawer-panel');
    expect(css).toContain('.admin-muted-note');
    expect(css).toContain('overflow: visible');
    expect(css).toContain('max-height: none');
    expect(css).toContain('.chip-access-option');
    expect(css).toContain('.restart-notice');
    expect(css).toContain('grid-template-columns: 18px minmax(0, 1fr)');
    expect(css).toContain('max-width: 14px');
    expect(css).toContain('overflow-wrap: break-word');
    expect(css).toContain('.users-section {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr)');
    expect(css).toContain('.admin-master-detail.detail-open {\n  grid-template-columns: minmax(280px, 340px) minmax(0, 1fr)');
    expect(css).not.toContain('grid-template-columns: 260px 200px minmax(0, 1fr)');
    expect(css).toContain('display: flex');
    expect(css).toContain('flex-direction: column');
    expect(css).toContain('.admin-grid,\n  .admin-workspace-shell,\n  .admin-workspace {\n    height: auto;\n    overflow: visible;');
    expect(css).toContain('.success-line');
  });

  it('uses a split-pane prompt editor with retryable failure states', () => {
    const html = adminHtml();
    const js = adminJs();
    const css = styles();

    for (const token of [
      'class="prompt-split-pane"',
      'class="panel prompt-nav-pane"',
      'class="panel detail-body prompt-editor-pane"',
      'id="prompt-error-panel"',
      'id="prompt-error-message"',
      'id="prompt-retry"'
    ]) {
      expect(html).toContain(token);
    }

    expect(js).toContain('function setPromptEditorState(status, message)');
    expect(js).toContain("setPromptEditorState('loading'");
    expect(js).toContain("'load-failed',");
    expect(js).toContain('function retryPromptLoad()');
    expect(js).toContain('promptRetry.addEventListener');
    expect(js).toContain('promptContent.disabled');
    expect(js).toContain('save-failed');
    expect(js).toContain('state.hasUnsavedChanges = true');
    expect(js).toContain('file.exists === false');

    expect(css).toContain('.prompt-split-pane');
    expect(css).toContain('grid-template-columns: minmax(180px, 240px) minmax(0, 1fr)');
    // B7：版本历史从正文上方的横条改为右侧 240px 侧栏，历史行从 .prompt-editor-container 的
    // 独立一行并入 .prompt-body-grid（正文 + 历史侧栏左右布局），故容器行数由 4 行降为 3 行。
    expect(css).toContain('grid-template-rows: auto auto minmax(320px, 1fr)');
    expect(css).toContain('.prompt-body-grid');
    expect(css).toContain('grid-template-columns: minmax(0, 1fr) 240px');
    expect(css).toContain('.prompt-history-rail');
    expect(css).toContain('.prompt-error-panel');
    expect(css).toContain('.prompt-editor-status.load-failed');
    expect(css).toContain('.prompt-chip-card.missing');
  });
});
