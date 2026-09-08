/**
 * P3 / B6 积分管理 admin 界面合约测试。
 *
 * 直读 public/admin.html + public/admin.js 真实源码：
 *  - Task 3.1（脚手架）：旧顶层 #panel-credits 退役，入口收敛到用户详情积分 tab。
 *  - Task 3.2（行为）：用户详情积分 tab 拉取 GET /admin/credits?userId=u1 并展示流水；
 *    以正确 body POST /admin/credits/adjust（delta 与目标余额两路）；
 *    后端 400（结果余额为负）以错误形式暴露；空流水走 renderEmptyState。
 *
 * 任何 fetch 响应 mock 必须带 headers.get 垫片：admin.js 在 chips 路径会读 response.headers.get('etag')，
 * 其它路径必须返回 null 而非抛错。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function jsonResponse(payload: unknown, status = 200, etag?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) }
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface CreditsHarnessOptions {
  url?: string;
  users?: any[];
  creditBalances?: Record<string, number>;
  ledgers?: Record<string, { items: any[]; total: number; offset: number; limit: number }>;
  creditLoaders?: Record<string, () => Promise<any>>;
  adjustLoader?: (body: any, context: { user: any; before: number; after: number }) => Promise<any>;
  adjustStatus?: number;
  adjustError?: string;
}

async function bootAdminCredits(options: CreditsHarnessOptions = {}) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: options.url ?? 'http://127.0.0.1:3000/admin/sections/users',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];

  const balances = options.creditBalances ?? { u1: 1200, u2: 0 };
  // 贴近真实 /admin/users：每个用户自带 credits.balanceUnits。
  const users =
    options.users ??
    [
      { id: 'u1', username: 'alice', role: 'customer', mcpKeys: [], credits: { balanceUnits: balances.u1 } },
      { id: 'u2', username: 'bob', role: 'partner', mcpKeys: [], credits: { balanceUnits: balances.u2 } }
    ];
  const ledgers = options.ledgers ?? {
    u1: {
      items: [
        {
          id: 'led-1',
          userId: 'u1',
          username: 'alice',
          entry: 'admin',
          units: 500,
          status: 'free',
          reason: 'welcome bonus',
          balanceBeforeUnits: 700,
          balanceAfterUnits: 1200,
          createdAt: '2026-06-24T00:00:00.000Z'
        }
      ],
      total: 1,
      offset: 0,
      limit: 20
    },
    u2: { items: [], total: 0, offset: 0, limit: 20 }
  };

  window.confirm = vi.fn(() => true);
  window.AgentXAuth = {
    getUser: () => ({ username: 'root', role: 'admin' }),
    logout: () => undefined,
    login: async () => ({ user: { username: 'root', role: 'admin' } }),
    clearToken: () => undefined,
    authFetch: async (path: string, requestOptions?: any) => {
      calls.push({ path, options: requestOptions });

      if (path === '/admin/users') return jsonResponse({ users });
      if (path === '/admin/chips') return jsonResponse({ chips: [], knowledgeBaseRoot: '' });
      if (path === '/admin/chip-access') return jsonResponse({ users: {} });
      if (path === '/admin/prompts') return jsonResponse({ files: [] });
      if (path === '/admin/roles') return jsonResponse({ roles: {}, _permissions: {} });

      if (path.startsWith('/admin/credits?')) {
        const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
        const userId = query.get('userId') ?? '';
        const user = users.find((candidate) => candidate.id === userId);
        if (!user) return jsonResponse({ error: 'User not found' }, 404);
        if (options.creditLoaders?.[userId]) {
          const payload = await options.creditLoaders[userId]();
          return jsonResponse({
            userId: user.id,
            username: user.username,
            ...payload
          });
        }
        return jsonResponse({
          userId: user.id,
          username: user.username,
          balanceUnits: balances[user.id] ?? 0,
          ledger: ledgers[user.id] ?? { items: [], total: 0, offset: 0, limit: 20 }
        });
      }

      if (path === '/admin/credits/adjust' && requestOptions?.method === 'POST') {
        if (options.adjustStatus) {
          return jsonResponse({ error: options.adjustError ?? 'adjust failed' }, options.adjustStatus);
        }
        const body = JSON.parse(requestOptions.body);
        const user = users.find((candidate) => candidate.id === body.userId);
        if (!user) return jsonResponse({ error: 'User not found' }, 404);
        const before = balances[user.id] ?? 0;
        const after =
          typeof body.balanceUnits === 'number' ? body.balanceUnits : before + (body.deltaUnits ?? 0);
        if (options.adjustLoader) {
          const payload = await options.adjustLoader(body, { user, before, after });
          balances[user.id] = typeof payload.balanceAfterUnits === 'number' ? payload.balanceAfterUnits : after;
          return jsonResponse(payload);
        }
        balances[user.id] = after;
        return jsonResponse({
          userId: user.id,
          username: user.username,
          balanceBeforeUnits: before,
          balanceAfterUnits: after,
          deltaUnits: after - before,
          reason: body.reason,
          note: body.note,
          ledgerRecord: {
            id: 'led-new',
            userId: user.id,
            username: user.username,
            entry: 'admin',
            units: Math.abs(after - before),
            status: 'free',
            reason: body.reason,
            balanceBeforeUnits: before,
            balanceAfterUnits: after,
            createdAt: '2026-06-25T00:00:00.000Z'
          }
        });
      }

      throw new Error(`Unexpected admin fetch: ${path}`);
    }
  };

  window.eval(readPublicFile('admin.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  await flushBrowserTasks();

  return { window, calls };
}

async function selectFirstUser(window: Window) {
  const firstUser = window.document.querySelector('#user-list .user-info-btn, #user-list tr') as HTMLElement | null;
  if (!firstUser) {
    throw new Error('Expected a selectable user row');
  }
  firstUser.click();
  await flushBrowserTasks();
  await flushBrowserTasks();
}

describe('P3/B6 credits admin section scaffold (Task 3.1)', () => {
  it('admin.html retires the top-level credits panel and keeps user detail credits controls', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const link = doc.querySelector('#admin-section-nav [data-section="credits"]');
    expect(link).toBeNull();
    expect(doc.getElementById('panel-credits')).toBeNull();
    expect(doc.getElementById('user-tab-credits')).toBeTruthy();
    expect(doc.getElementById('user-tabpanel-credits')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-balance')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-mode-delta')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-mode-balance')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-amount')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-reason')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-note')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-submit')).toBeTruthy();
    expect(doc.getElementById('selected-user-credit-ledger')).toBeTruthy();
  });

  it('admin.js no longer registers credits as a top-level section', () => {
    const src = readPublicFile('admin.js');
    expect(src).not.toMatch(/credits:\s*\{\s*path:\s*'\/admin\/sections\/credits'/);
    expect(src).not.toContain("data-section=\"credits\"");
  });
});

describe('P3/B6 credits admin section behavior (Task 3.2)', () => {
  it('activating the selected user credits tab fetches and renders the detail ledger', async () => {
    const { window, calls } = await bootAdminCredits({
      url: 'http://127.0.0.1:3000/admin/sections/users'
    });

    await selectFirstUser(window);
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.some((call) => call.path === '/admin/credits?userId=u1')).toBe(true);
    expect(window.document.getElementById('selected-user-credit-balance')?.textContent).toContain('1200');
    expect(window.document.getElementById('selected-user-credit-ledger')?.textContent).toContain('welcome bonus');
  });

  it('selected user credits delta mode posts deltaUnits and clears the detail form', async () => {
    const { window, calls } = await bootAdminCredits({
      url: 'http://127.0.0.1:3000/admin/sections/users'
    });

    await selectFirstUser(window);
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-credit-mode-delta')?.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.getElementById('selected-user-credit-mode-balance')?.getAttribute('aria-pressed')).toBe('false');
    expect((window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).placeholder).toContain('delta');

    (window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value = '300';
    (window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value = 'topup';
    (window.document.getElementById('selected-user-credit-note') as HTMLInputElement).value = 'manual';
    window.document.getElementById('selected-user-credit-form')?.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    const adjustCall = calls.find((call) => {
      if (call.path !== '/admin/credits/adjust' || call.options?.method !== 'POST') return false;
      return JSON.parse(call.options.body).deltaUnits === 300;
    });
    expect(adjustCall).toBeTruthy();
    expect(JSON.parse(adjustCall!.options.body)).toMatchObject({
      userId: 'u1',
      reason: 'topup',
      note: 'manual',
      deltaUnits: 300
    });
    expect(JSON.parse(adjustCall!.options.body).balanceUnits).toBeUndefined();
    expect((window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value).toBe('');
    expect((window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value).toBe('');
    expect((window.document.getElementById('selected-user-credit-note') as HTMLInputElement).value).toBe('');
  });

  it('selected user credits balance mode posts balanceUnits and updates segmented state', async () => {
    const { window, calls } = await bootAdminCredits({
      url: 'http://127.0.0.1:3000/admin/sections/users'
    });

    await selectFirstUser(window);
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.getElementById('selected-user-credit-mode-balance') as HTMLButtonElement).click();

    expect(window.document.getElementById('selected-user-credit-mode-delta')?.getAttribute('aria-pressed')).toBe('false');
    expect(window.document.getElementById('selected-user-credit-mode-balance')?.getAttribute('aria-pressed')).toBe('true');
    expect((window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).placeholder).toContain('目标余额');

    (window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value = '5000';
    (window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value = 'reset';
    window.document.getElementById('selected-user-credit-form')?.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    const adjustCall = calls.find((call) => {
      if (call.path !== '/admin/credits/adjust' || call.options?.method !== 'POST') return false;
      return JSON.parse(call.options.body).balanceUnits === 5000;
    });
    expect(adjustCall).toBeTruthy();
    expect(JSON.parse(adjustCall!.options.body)).toMatchObject({
      userId: 'u1',
      reason: 'reset',
      balanceUnits: 5000
    });
    expect(JSON.parse(adjustCall!.options.body).deltaUnits).toBeUndefined();
  });

  it('ignores stale selected-user credit submit responses after switching users', async () => {
    let resolveAdjust: (value: any) => void = () => undefined;
    const adjustResponse = new Promise((resolve) => {
      resolveAdjust = resolve;
    });
    const { window } = await bootAdminCredits({
      url: 'http://127.0.0.1:3000/admin/sections/users',
      adjustLoader: async () => adjustResponse
    });

    await selectFirstUser(window);
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    (window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value = '300';
    (window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value = 'alice topup';
    window.document.getElementById('selected-user-credit-form')?.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    const userButtons = [...window.document.querySelectorAll('#user-list .user-info-btn')] as HTMLButtonElement[];
    userButtons[1]!.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value = '77';
    (window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value = 'bob draft';

    resolveAdjust({
      userId: 'u1',
      username: 'alice',
      balanceBeforeUnits: 1200,
      balanceAfterUnits: 1500,
      deltaUnits: 300,
      reason: 'alice topup',
      ledgerRecord: {
        id: 'alice-late-adjust',
        userId: 'u1',
        username: 'alice',
        entry: 'admin',
        units: 300,
        status: 'free',
        reason: 'alice topup',
        balanceBeforeUnits: 1200,
        balanceAfterUnits: 1500,
        createdAt: '2026-06-27T00:00:00.000Z'
      }
    });
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-title')?.textContent).toContain('bob');
    expect((window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value).toBe('77');
    expect((window.document.getElementById('selected-user-credit-reason') as HTMLInputElement).value).toBe('bob draft');
    expect(window.document.getElementById('selected-user-credit-balance')?.textContent).toContain('0');
  });

  it('selected user credits rejects an empty reason before sending', async () => {
    const { window, calls } = await bootAdminCredits({
      url: 'http://127.0.0.1:3000/admin/sections/users'
    });

    await selectFirstUser(window);
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    (window.document.getElementById('selected-user-credit-amount') as HTMLInputElement).value = '300';
    window.document.getElementById('selected-user-credit-form')?.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    expect(calls.find((call) => call.path === '/admin/credits/adjust')).toBeUndefined();
    expect(window.document.getElementById('selected-user-credit-status')?.textContent).toContain('原因');
  });
});
