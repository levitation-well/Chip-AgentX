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

async function flushBrowserTasks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const uuidUserId = '8c5c3a23-7729-4e8b-82a5-09ee743f2d64';
const historicalUuidUserId = '9f4e9c10-93fd-4f43-a3aa-ef678d020889';

const usersPayload = {
  users: [
    {
      id: uuidUserId,
      username: 'alice',
      role: 'customer',
      createdAt: '2026-05-08T00:00:00.000Z'
    }
  ]
};

const sessionsPayload = {
  items: [
    {
      sessionId: 'session-running',
      title: 'Running check',
      username: 'alice',
      userId: 'user-alice',
      role: 'customer',
      chipId: 'E521.39',
      chipLabel: 'E521',
      source: 'web',
      agentType: 'claude-code',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T01:00:00.000Z',
      lastMessageAt: '2026-05-08T01:00:00.000Z',
      turnState: 'running',
      outputSize: 120
    },
    {
      sessionId: 'session-interrupted',
      title: 'Interrupted check',
      username: 'bob',
      userId: 'user-bob',
      role: 'internal',
      chipId: 'E522.95',
      source: 'web',
      agentType: 'claude-code',
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T01:00:00.000Z',
      lastMessageAt: '2026-05-07T01:00:00.000Z',
      turnState: 'idle',
      lastTurnResult: { status: 'interrupted', finishedAt: '2026-05-07T01:00:00.000Z', exitCode: null, signal: 'RESTART', totalOutputChars: 300 },
      outputSize: 300
    }
  ],
  total: 4,
  offset: 0,
  limit: 50
};

const questionsPayload = {
  items: [
    {
      questionId: 'q-1',
      sessionId: 'session-running',
      turnId: 'turn-1',
      text: 'Where are the power pins?',
      username: 'alice',
      userId: 'user-alice',
      role: 'customer',
      chipId: 'E521.39',
      source: 'web',
      createdAt: '2026-05-08T01:00:00.000Z'
    }
  ],
  total: 1,
  offset: 0,
  limit: 50
};

const detailPayload = {
  meta: {
    sessionId: 'session-running',
    claudeSessionId: 'claude-session',
    title: 'Running check',
    username: 'alice',
    userId: 'user-alice',
    role: 'customer',
    chipId: 'E521.39',
    chipLabel: 'E521',
    source: 'web',
    cwd: 'D:/chips/E521.39',
    agentType: 'claude-code',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T01:00:00.000Z',
    lastMessageAt: '2026-05-08T01:00:00.000Z',
    turnState: 'running',
    outputSize: 120,
    tags: ['phase14'],
    adminNotes: 'readonly note',
    aiSummary: 'readonly summary',
    aiLabels: ['debug']
  },
  transcript: [
    { role: 'user', text: 'Where are the power pins?', createdAt: '2026-05-08T01:00:00.000Z' },
    { role: 'assistant', text: 'Pin 1 and pin 2.', createdAt: '2026-05-08T01:01:00.000Z' },
    { role: 'turn_result', status: 'done', finishedAt: '2026-05-08T01:02:00.000Z', exitCode: 0, signal: null, totalOutputChars: 120 }
  ],
  events: [{ event: 'session_created', sessionId: 'session-running', createdAt: '2026-05-08T00:00:00.000Z' }]
};

const sessionTracePayload = {
  traces: [
    {
      sessionId: 'session-running',
      ts: '2026-05-08T01:03:00.000Z',
      stage: 'scope.resolve',
      status: 'ok',
      detail: { chipIds: ['E521.39'] }
    }
  ]
};

const sessionDebugPayload = {
  sessionId: 'session-running',
  type: '跨档两步',
  systemPrompt: {
    text: 'Use authorized datasheets only. API key [REDACTED_SECRET] must stay hidden.',
    truncated: false,
    chars: 76,
    redacted: ['secret']
  },
  stages: [
    {
      stage: 'scope.resolve',
      status: 'ok',
      ts: '2026-05-08T01:03:00.000Z',
      detail: { scopeId: 'scope-e521', allowedChipCount: 1, allowedDocumentCount: 2, fileCount: 2 }
    },
    {
      stage: 'cc.stage1',
      status: 'ok',
      ts: '2026-05-08T01:03:30.000Z',
      durationMs: 4210,
      detail: { matchedChips: 1 },
      artifact: {
        prompt: 'Find PWM candidates',
        response: 'E521.39',
        candidates: ['E521.39'],
        rawCandidatesCount: 1,
        truncated: false
      }
    },
    {
      stage: 'auth.recheck',
      status: 'ok',
      ts: '2026-05-08T01:03:45.000Z',
      detail: { kept: 1, dropped: 1 },
      artifact: {
        kept: ['E521.39'],
        dropped: ['E522.95']
      }
    },
    {
      stage: 'cc.stage2',
      status: 'ok',
      ts: '2026-05-08T01:04:00.000Z',
      artifact: { prompt: 'Answer from copied files', answer: { text: 'PWM width is 16-bit. JWT [REDACTED_JWT].', chars: 42, redacted: ['jwt'] }, sourceCount: 2 }
    },
    {
      stage: 'scope.materialize',
      status: 'ok',
      ts: '2026-05-08T01:05:00.000Z',
      artifact: {
        workspace: {
          scopeId: 'scope-e521',
          mode: 'copy',
          files: ['E521.39/datasheet.md', { path: 'E521.39/summary.md', size: 2048 }]
        }
      }
    },
    {
      stage: 'workspace.snapshot',
      status: 'ok',
      ts: '2026-05-08T01:06:00.000Z',
      artifact: {
        chipId: 'E521.39',
        files: [{ path: 'datasheet.md', size: 12288 }]
      }
    },
    {
      stage: 'ws.copy',
      status: 'ok',
      ts: '2026-05-08T01:07:00.000Z',
      artifact: {
        chips: ['E521.39'],
        files: [{ chipId: 'E521.39', path: 'E521.39/datasheet.md', size: 12288 }]
      }
    }
  ],
  failure: {
    stage: 'cc.stage2',
    error: 'Provider timeout',
    partialWorkspaceTree: [
      { path: 'E521.39', type: 'dir' },
      { path: 'E521.39/datasheet.md', size: 12288 }
    ]
  },
  final: { text: 'PWM width is 16-bit. JWT [REDACTED_JWT].', chars: 42, redacted: ['jwt'] }
};

const sessionAnalysisPayload = {
  meta: { sessionId: 'session-running', userId: 'user-alice', chipId: 'E521.39' },
  questionLedger: {
    items: [
      {
        questionId: 'q-analysis-1',
        sessionId: 'session-running',
        text: 'What is the PWM width?',
        answerPreview: '16-bit PWM',
        createdAt: '2026-05-08T01:05:00.000Z'
      }
    ],
    total: 1
  },
  messages: [
    { role: 'user', text: 'What is the PWM width?', createdAt: '2026-05-08T01:05:00.000Z' },
    { role: 'assistant', text: '16-bit PWM is available.', createdAt: '2026-05-08T01:06:00.000Z' }
  ]
};

function installAdminAuth(
  window: Window & Record<string, any>,
  user: unknown,
  fetchCalls: string[],
  options: { failQuestions?: boolean; failSessionDetail?: boolean } = {}
) {
  window.AgentXAuth = {
    getUser: () => user,
    logout: () => undefined,
    login: async () => ({ user }),
    clearToken: () => undefined,
    authFetch: async (path: string) => {
      fetchCalls.push(path);
      if (path === '/admin/chips') return okJson({ chips: [], knowledgeBaseRoot: '' });
      if (path === '/admin/users') return okJson(usersPayload);
      if (path === '/admin/chip-access') return okJson({ users: {} });
      if (path === '/admin/prompts') return okJson({ files: [] });
      if (path === '/admin/roles') return okJson({ roles: { admin: { description: 'Admin', permissions: [] } }, _permissions: {} });
      if (path.startsWith('/admin/sessions/history')) return okJson({ ...sessionsPayload, offset: Number(new URL(`http://x${path}`).searchParams.get('offset') ?? 0) });
      if (path.startsWith('/admin/questions')) {
        if (options.failQuestions) {
          return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
        }
        return okJson(questionsPayload);
      }
      if (path === '/admin/sessions/session-running/debug') return okJson(sessionDebugPayload);
      if (path === '/admin/sessions/session-running/analysis') return okJson(sessionAnalysisPayload);
      if (path === '/admin/sessions/session-interrupted/analysis') {
        return okJson({ ...sessionAnalysisPayload, meta: { sessionId: 'session-interrupted', userId: 'user-bob', chipId: 'E522.95' }, messages: [] });
      }
      if (path.startsWith('/admin/discovery-traces?sessionId=session-running')) return okJson(sessionTracePayload);
      if (path.includes('/history?outputTail=')) {
        return okJson({
          ...detailPayload,
          outputTail: { output: 'tail output', totalChars: 9000, offset: 3000, limit: 6000 }
        });
      }
      if (path.startsWith('/admin/sessions/session-running/history')) {
        if (options.failSessionDetail) {
          return { ok: false, status: 500, json: async () => ({ error: 'detail failed' }) };
        }
        return okJson(detailPayload);
      }
      throw new Error(`Unexpected admin fetch: ${path}`);
    }
  };
}

async function bootAdminPage(
  url: string,
  user: unknown = { username: 'root', role: 'admin' },
  options: { failQuestions?: boolean; failSessionDetail?: boolean } = {}
) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url,
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const fetchCalls: string[] = [];
  installAdminAuth(window, user, fetchCalls, options);
  window.eval(readPublicFile('admin.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  return { window, fetchCalls };
}

// A2：按用户 tab 现为共享密集表（.admin-dense-table）平铺行（按用户名排序），
// 不再有手风琴分组；这里返回该 tab 的会话表格 tbody 供用例操作。
function usersSessionsTbody(window: Window): HTMLElement {
  const tbody = window.document.getElementById('history-sessions-list-users');
  if (!tbody) {
    throw new Error('Expected history-sessions-list-users tbody');
  }
  return tbody;
}

describe('phase 14 admin history UI', () => {
  it('renders sessions and questions sections', async () => {
    const html = readPublicFile('admin.html');
    const js = readPublicFile('admin.js');

    expect(html).toContain('href="/admin/sections/sessions"');
    expect(html).not.toContain('id="section-questions"');
    expect(html).not.toContain('data-section="questions"');
    expect(html).toContain('history-tab-users');
    expect(html).toContain('history-tab-latest');
    expect(html).toContain('history-tab-questions');
    expect(js).toContain("sessions: { path: '/admin/sections/sessions'");
    expect(js).toContain("questions: { path: '/admin/sections/questions'");

    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    expect((window.document.getElementById('panel-sessions') as HTMLElement).hidden).toBe(false);
    expect(fetchCalls.some((path) => path.startsWith('/admin/sessions/history'))).toBe(true);
  });

  it('renders the users tab as a flat dense table sorted by username, not an accordion', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');

    // A2：按用户手风琴分组已回归原型平铺表；不应再出现分组 header/分组列表。
    expect(window.document.querySelectorAll('.history-user-header').length).toBe(0);
    expect(window.document.querySelectorAll('.history-user-group').length).toBe(0);

    const tbody = usersSessionsTbody(window);
    const rows = [...tbody.querySelectorAll('.history-session-row')] as HTMLTableRowElement[];
    expect(rows.length).toBeGreaterThan(0);
    // E4：会话表去掉了前导「时间」列，用户名现在是首列（原型列序：用户/角色/芯片/…）。
    const usernames = rows.map((row) => row.children[0]?.textContent || '');
    const sorted = [...usernames].sort((left, right) => left.toLocaleLowerCase().localeCompare(right.toLocaleLowerCase()));
    expect(usernames).toEqual(sorted);
  });

  it('keeps session rows in the users tab immediately clickable without expanding anything first', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);
    const row = tbody.querySelector('.history-session-row') as HTMLTableRowElement;
    expect(row).toBeTruthy();

    row.click();
    await flushBrowserTasks();

    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(false);
  });

  it('keeps session rows visible in the users tab when loading more sessions', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);
    const initialRowCount = tbody.querySelectorAll('.history-session-row').length;
    expect(initialRowCount).toBeGreaterThan(0);

    (window.document.getElementById('history-load-more-sessions') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(tbody.querySelectorAll('.history-session-row').length).toBeGreaterThanOrEqual(initialRowCount);
  });

  it('defaults questions route to the question ledger tab', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions');

    expect(window.document.getElementById('history-tab-questions')?.getAttribute('aria-selected')).toBe('true');
    expect((window.document.getElementById('history-pane-questions') as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('[data-section="sessions"]')?.getAttribute('aria-current')).toBe('page');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('运营记录');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('会话历史');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('问题台账');
    expect(fetchCalls.some((path) => path.startsWith('/admin/questions'))).toBe(true);
  });

  it('keeps the admin shell visible when the downgraded questions tab fails to load', async () => {
    const { window } = await bootAdminPage(
      'http://127.0.0.1:3000/admin/sections/questions',
      { username: 'root', role: 'admin' },
      { failQuestions: true }
    );

    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(true);
    expect((window.document.getElementById('panel-sessions') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('history-error')?.textContent).toContain('加载问题台账失败 (404)');
  });

  it('sends session filters as query parameters', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    (window.document.getElementById('history-filter-user') as HTMLInputElement).value = 'alice';
    (window.document.getElementById('history-filter-role') as HTMLInputElement).value = 'customer';
    (window.document.getElementById('history-filter-chip') as HTMLInputElement).value = 'E521.39';
    (window.document.getElementById('history-filter-keyword') as HTMLInputElement).value = 'power';
    (window.document.getElementById('history-filter-from') as HTMLInputElement).value = '2026-05-01';
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const url = new URL(`http://x${fetchCalls.filter((path) => path.startsWith('/admin/sessions/history')).at(-1) ?? ''}`);
    expect(url.searchParams.get('username')).toBe('alice');
    expect(url.searchParams.get('role')).toBe('customer');
    expect(url.searchParams.get('chipId')).toBe('E521.39');
    expect(url.searchParams.get('keyword')).toBe('power');
    expect(url.searchParams.get('from')).toContain('2026-05-01');
  });

  it('sends matching UUID user filter as session userId instead of username', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    (window.document.getElementById('history-filter-user') as HTMLInputElement).value = uuidUserId;
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const url = new URL(`http://x${fetchCalls.filter((path) => path.startsWith('/admin/sessions/history')).at(-1) ?? ''}`);
    expect(url.searchParams.get('userId')).toBe(uuidUserId);
    expect(url.searchParams.has('username')).toBe(false);
  });

  it('sends matching UUID user filter as question userId instead of username', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions');
    (window.document.getElementById('history-filter-user') as HTMLInputElement).value = historicalUuidUserId;
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const url = new URL(`http://x${fetchCalls.filter((path) => path.startsWith('/admin/questions')).at(-1) ?? ''}`);
    expect(url.searchParams.get('userId')).toBe(historicalUuidUserId);
    expect(url.searchParams.has('username')).toBe(false);
  });

  it('sends question date filters as query parameters', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions');
    (window.document.getElementById('history-filter-from') as HTMLInputElement).value = '2026-05-01';
    (window.document.getElementById('history-filter-to') as HTMLInputElement).value = '2026-05-09';
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const url = new URL(`http://x${fetchCalls.filter((path) => path.startsWith('/admin/questions')).at(-1) ?? ''}`);
    expect(url.searchParams.get('from')).toContain('2026-05-01');
    expect(url.searchParams.get('to')).toContain('2026-05-09');
  });

  it('loads more with the next offset', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');

    (window.document.getElementById('history-load-more-sessions') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const url = new URL(`http://x${fetchCalls.filter((path) => path.startsWith('/admin/sessions/history')).at(-1) ?? ''}`);
    expect(url.searchParams.get('offset')).toBe('2');
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('reloads the question tab after filters change in another tab', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions');
    (window.document.getElementById('history-tab-users') as HTMLButtonElement).click();
    await flushBrowserTasks();

    (window.document.getElementById('history-filter-keyword') as HTMLInputElement).value = 'power';
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    (window.document.getElementById('history-tab-questions') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const questionCalls = fetchCalls.filter((path) => path.startsWith('/admin/questions'));
    expect(questionCalls.length).toBeGreaterThanOrEqual(2);
    expect(new URL(`http://x${questionCalls.at(-1) ?? ''}`).searchParams.get('keyword')).toBe('power');
  });

  it('opens session detail drawer and renders transcript by default', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);

    (tbody.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();

    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('session-detail-drawer')?.textContent).toContain('会话转录');
    expect(window.document.getElementById('session-detail-drawer')?.textContent).toContain('会话信息');
    expect(window.document.getElementById('session-detail-drawer')?.textContent).not.toContain('Transcript');
    expect(window.document.getElementById('session-detail-drawer')?.textContent).not.toContain('Session Info');
    expect(window.document.getElementById('session-detail-transcript')?.textContent).toContain('Where are the power pins?');
    expect(window.document.getElementById('session-detail-info')?.textContent).toContain('claudeSessionId');
  });

  it('fetches session analysis and renders returned ledger and messages', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);

    (tbody.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();

    expect(fetchCalls).toContain('/admin/sessions/session-running/analysis');
    expect(window.document.getElementById('session-detail-analysis')?.textContent).toContain('What is the PWM width?');
    expect(window.document.getElementById('session-detail-analysis')?.textContent).toContain('16-bit PWM is available.');
  });

  it('ignores stale session analysis responses after selecting another session', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseRunningAnalysis: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string) => {
      if (path === '/admin/sessions/session-running/analysis') {
        return new Promise((resolve) => {
          releaseRunningAnalysis = () => resolve(okJson({
            ...sessionAnalysisPayload,
            messages: [{ role: 'assistant', text: 'RUNNING_ANALYSIS_SHOULD_NOT_RENDER' }]
          }));
        });
      }
      if (path.startsWith('/admin/sessions/session-interrupted/history')) {
        return okJson({
          ...detailPayload,
          meta: {
            ...detailPayload.meta,
            sessionId: 'session-interrupted',
            title: 'Interrupted check',
            username: 'bob',
            userId: 'user-bob'
          }
        });
      }
      return originalAuthFetch(path);
    };

    (window.document.getElementById('history-tab-latest') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const rows = [...window.document.querySelectorAll('#history-pane-latest .history-session-row')] as HTMLTableRowElement[];
    const runningRow = rows.find((row) => row.dataset.sessionId === 'session-running');
    const interruptedRow = rows.find((row) => row.dataset.sessionId === 'session-interrupted');
    runningRow?.click();
    await flushBrowserTasks();
    interruptedRow?.click();
    await flushBrowserTasks();
    releaseRunningAnalysis?.();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-detail-title')?.textContent).toContain('Interrupted check');
    expect(window.document.getElementById('session-detail-analysis')?.textContent).not.toContain('RUNNING_ANALYSIS_SHOULD_NOT_RENDER');
  });

  it('clears stale session detail when filters reset the history list', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);

    (tbody.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();
    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(false);

    (window.document.getElementById('history-filter-keyword') as HTMLInputElement).value = 'missing';
    (window.document.getElementById('history-filter-form') as HTMLFormElement).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(true);
    expect(window.document.getElementById('session-detail-analysis')?.textContent).not.toContain('What is the PWM width?');
  });

  it('renders readonly analysis fields and does not render analysis edit controls', async () => {
    const js = readPublicFile('admin.js');
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);
    (tbody.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-detail-info')?.textContent).toContain('adminNotes');
    expect(window.document.getElementById('session-detail-info')?.textContent).toContain('aiSummary');
    expect(js).not.toContain('saveAdminNotes');
  });

  it('does not request debug bundle before expansion and fetches /debug when expanded', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const tbody = usersSessionsTbody(window);
    (tbody.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();

    expect(fetchCalls.some((path) => path.includes('outputTail='))).toBe(false);
    expect(fetchCalls.some((path) => path.startsWith('/admin/discovery-traces?sessionId='))).toBe(false);
    expect(fetchCalls.some((path) => path.endsWith('/debug'))).toBe(false);

    (window.document.getElementById('session-debug-toggle') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(fetchCalls.some((path) => path.includes('outputTail='))).toBe(false);
    expect(fetchCalls.some((path) => path === '/admin/discovery-traces?sessionId=session-running')).toBe(false);
    expect(fetchCalls.some((path) => path === '/admin/sessions/session-running/debug')).toBe(true);
    const debugPanel = window.document.getElementById('session-detail-debug') as HTMLElement;
    expect(debugPanel.textContent).toContain('Use authorized datasheets only');
    expect(debugPanel.textContent).toContain('[REDACTED_SECRET]');
    expect(debugPanel.textContent).toContain('scope.resolve');
    expect(debugPanel.textContent).toContain('auth.recheck');
    expect(debugPanel.textContent).toContain('E522.95');
    expect(window.document.getElementById('session-detail-debug')?.textContent).toContain('PWM width is 16-bit');
    expect(window.document.getElementById('session-detail-debug')?.textContent).toContain('[REDACTED_JWT]');
    expect(window.document.getElementById('session-detail-debug')?.textContent).not.toContain('sha256');
    const failureSnapshot = Array.from(debugPanel.querySelectorAll('details.debug-artifact-block'))
      .find((block) => block.querySelector('summary')?.textContent?.includes('失败时工作区快照')) as HTMLElement | undefined;
    expect(failureSnapshot).toBeTruthy();
    expect(failureSnapshot?.querySelector('.debug-file-tree .debug-ft-row')).toBeTruthy();
    expect(failureSnapshot?.querySelector('pre.debug-output')).toBeNull();
    expect(failureSnapshot?.textContent).toContain('E521.39/datasheet.md');
    expect(failureSnapshot?.textContent).not.toContain('"path"');
    expect(debugPanel.querySelector('.debug-candidate-list')).toBeTruthy();
    expect(debugPanel.querySelector('.debug-file-tree')).toBeTruthy();
    expect(debugPanel.querySelector('.debug-simple-list')).toBeTruthy();
    const fileRows = Array.from(debugPanel.querySelectorAll('.debug-file-tree .debug-ft-row')) as HTMLElement[];
    const fileRowWithSize = fileRows.find((row) => row.textContent?.includes('12288'));
    const fileRowWithoutSize = fileRows.find((row) => row.textContent?.includes('E521.39/datasheet.md') && row.children[2]?.textContent === '');
    expect(fileRowWithSize?.children.length).toBe(3);
    expect(fileRowWithSize?.children[0]?.classList.contains('debug-row-icon')).toBe(true);
    expect(fileRowWithSize?.children[1]?.textContent).toContain('datasheet.md');
    expect(fileRowWithSize?.children[2]?.classList.contains('debug-ft-size')).toBe(true);
    expect(fileRowWithoutSize?.children.length).toBe(3);
    expect(fileRowWithoutSize?.children[0]?.classList.contains('debug-row-icon')).toBe(true);
    expect(fileRowWithoutSize?.children[1]?.textContent).toContain('E521.39/datasheet.md');
    expect(fileRowWithoutSize?.children[2]?.textContent).toBe('');
    const simpleRow = debugPanel.querySelector('.debug-simple-list .debug-sl-row') as HTMLElement;
    expect(simpleRow.children.length).toBe(2);
    expect(simpleRow.children[0]?.classList.contains('debug-row-icon')).toBe(true);
    const kvRow = debugPanel.querySelector('.debug-trace-kv .debug-sl-row') as HTMLElement;
    expect(kvRow.children.length).toBe(2);
    expect(kvRow.children[0]?.classList.contains('debug-row-icon')).toBe(true);
    expect(debugPanel.textContent).toContain('sourceCount');
    expect(debugPanel.textContent).not.toContain('"kind"');
    expect(debugPanel.textContent).not.toContain('"items"');

    // 批次H（2.2.27，对齐原型 renderTraceTimeline）：阶段 detail 改为在主行行内摘要，
    // 成功且无 artifact 的阶段主行不再留白；只有 artifact 才折叠进可展开体。
    const steps = Array.from(debugPanel.querySelectorAll('.debug-trace-step')) as HTMLElement[];
    const scopeResolveStep = steps.find(
      (step) => step.querySelector('.debug-trace-stage-name')?.textContent === 'scope.resolve'
    );
    expect(scopeResolveStep).toBeTruthy();
    const scopeDetail = scopeResolveStep!.querySelector('.debug-trace-stage-detail') as HTMLElement;
    // detail 直接显示在主行（无需展开），用行内 KV 小片而非留白
    expect(scopeDetail.querySelectorAll('.debug-trace-kv-chip').length).toBeGreaterThan(0);
    expect(scopeDetail.textContent).toContain('scopeId');
    expect(scopeDetail.textContent).toContain('scope-e521');
    // detail-only 阶段（无 artifact）不再有可展开体/按钮
    expect(scopeResolveStep!.querySelector('.debug-trace-step-head.has-artifact')).toBeNull();
    expect(scopeResolveStep!.querySelector('.debug-trace-artifact')).toBeNull();
    // 有 artifact 的阶段：detail 仍行内，artifact 仍折叠进可展开体
    const stage1Step = steps.find((step) => step.querySelector('.debug-trace-stage-name')?.textContent === 'cc.stage1');
    expect(stage1Step!.querySelector('.debug-trace-stage-detail')?.textContent).toContain('matchedChips');
    expect(stage1Step!.querySelector('.debug-trace-step-head.has-artifact')).toBeTruthy();
    expect(stage1Step!.querySelector('.debug-trace-artifact')).toBeTruthy();

    // V16：有 durationMs 的阶段渲染耗时（含单位「秒」/「毫秒」），不再是 toLocaleTimeString 的时间点；
    // 无 durationMs 的阶段回退显示 ts 时刻（保持向后兼容）。
    const stage1Dur = stage1Step!.querySelector('.debug-trace-dur') as HTMLElement;
    expect(stage1Dur.textContent).toMatch(/\d/);
    expect(stage1Dur.textContent).toMatch(/秒|毫秒/);
    expect(stage1Dur.textContent).not.toMatch(/:\d{2}:\d{2}/); // 不是 HH:MM:SS 时刻格式
    const scopeResolveDur = scopeResolveStep!.querySelector('.debug-trace-dur') as HTMLElement;
    expect(scopeResolveDur.textContent).toMatch(/:\d{2}:\d{2}/); // 无 durationMs 时仍回退为时刻
  });

  it('ignores stale debug responses after selecting another session', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseRunningDebug: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string) => {
      if (path === '/admin/sessions/session-running/debug') {
        return new Promise((resolve) => {
          releaseRunningDebug = () => resolve(okJson({
            ...sessionDebugPayload,
            systemPrompt: { text: 'RUNNING_DEBUG_SHOULD_NOT_RENDER', truncated: false }
          }));
        });
      }
      if (path.startsWith('/admin/sessions/session-interrupted/history')) {
        return okJson({
          ...detailPayload,
          meta: {
            ...detailPayload.meta,
            sessionId: 'session-interrupted',
            title: 'Interrupted check',
            username: 'bob',
            userId: 'user-bob'
          }
        });
      }
      return originalAuthFetch(path);
    };

    (window.document.getElementById('history-tab-latest') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const rows = [...window.document.querySelectorAll('#history-pane-latest .history-session-row')] as HTMLTableRowElement[];
    const runningRow = rows.find((row) => row.dataset.sessionId === 'session-running');
    const interruptedRow = rows.find((row) => row.dataset.sessionId === 'session-interrupted');
    runningRow?.click();
    await flushBrowserTasks();
    (window.document.getElementById('session-debug-toggle') as HTMLButtonElement).click();
    await flushBrowserTasks();
    interruptedRow?.click();
    await flushBrowserTasks();
    releaseRunningDebug?.();
    await flushBrowserTasks();

    expect(window.document.getElementById('session-detail-title')?.textContent).toContain('Interrupted check');
    expect(window.document.getElementById('session-detail-debug')?.textContent).not.toContain('RUNNING_DEBUG_SHOULD_NOT_RENDER');
  });

  it('opens the target session drawer and expands Debug from diagnostics query param', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions?debugSessionId=session-running');

    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('session-debug-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(fetchCalls.some((path) => path === '/admin/sessions/session-running/debug')).toBe(true);
    expect(window.document.getElementById('session-detail-debug')?.textContent).toContain('Use authorized datasheets only');
  });

  it('still renders deep-linked Debug when session detail fails', async () => {
    const { window, fetchCalls } = await bootAdminPage(
      'http://127.0.0.1:3000/admin/sections/sessions?debugSessionId=session-running',
      { username: 'root', role: 'admin' },
      { failSessionDetail: true }
    );

    expect(window.document.getElementById('session-detail-error')?.textContent).toContain('加载会话详情失败');
    expect(fetchCalls.some((path) => path === '/admin/sessions/session-running/debug')).toBe(true);
    expect(window.document.getElementById('session-detail-debug')?.textContent).toContain('Use authorized datasheets only');
  });

  it('renders interrupted and running status badges', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');

    // E4：状态徽标 className 仍按英文状态键着色，展示文案改中文（对齐原型「成功/失败/运行中」）。
    expect(window.document.querySelector('.status-badge.running')?.textContent).toBe('运行中');
    expect(window.document.querySelector('.status-badge.interrupted')?.textContent).toBe('已中断');
  });

  it('keeps latest tab session rows immediately clickable', async () => {
    const { window } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions');

    (window.document.getElementById('history-tab-latest') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const latestPane = window.document.getElementById('history-pane-latest') as HTMLElement;
    expect(latestPane.hidden).toBe(false);
    expect(latestPane.querySelector('.history-user-group')).toBeNull();

    (latestPane.querySelector('.history-session-row') as HTMLTableRowElement).click();
    await flushBrowserTasks();

    expect((window.document.getElementById('session-detail-drawer') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('session-detail-transcript')?.textContent).toContain('Where are the power pins?');
  });

  it('keeps history controls hidden for non-admin users', async () => {
    const { window, fetchCalls } = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions', {
      username: 'alice',
      role: 'customer'
    });

    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(true);
    expect(fetchCalls).toEqual([]);
  });
});
