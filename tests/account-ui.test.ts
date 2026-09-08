import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function okJson(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload
  };
}

function noContent() {
  return {
    ok: true,
    status: 204,
    headers: { get: () => '' },
    json: async () => ({})
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function accountHtml() {
  return readPublicFile('account.html');
}

function accountJs() {
  return readPublicFile('account.js');
}

function accountPayload(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 'user-1',
      username: 'alice',
      role: 'customer',
      profile: {
        realName: 'Alice',
        company: 'ELMOS',
        jobTitle: 'FAE',
        email: 'alice@example.test',
        contact: 'demo-contact',
        usagePurpose: 'Support',
        focusBrands: ['ELMOS'],
        focusProductLines: ['Lighting'],
        focusChipDirections: ['LIN']
      }
    },
    permissions: {
      role: 'customer',
      authorizedModels: ['haiku'],
      availableModels: [{ id: 'haiku', label: 'Standard', creditUnits: 50 }],
      searchModes: [
        { id: 'standard', label: 'Standard', available: true, selectable: true, description: 'Default text Q&A' }
      ],
      resources: [{ id: 'e522', label: 'E522 family' }],
      mcpKeyPolicy: {
        allowMcpKeySelfCreate: true,
        maxMcpKeys: 2,
        defaultMcpKeyTtlDays: 7,
        allowMcpKeyRegenerate: true
      },
      selfService: { profile: true, password: true, mcpKeys: true, mcpKeyRegenerate: true }
    },
    credits: {
      balanceUnits: 999850,
      recentLedger: { items: [], total: 0, offset: 0, limit: 5 }
    },
    mcpKeys: [],
    ...overrides
  };
}

function creditsPayload(items: unknown[] = []) {
  return {
    balanceUnits: 999850,
    ledger: { items, total: items.length, offset: 0, limit: 20 }
  };
}

async function setupAccountDom(
  handler: (path: string, init?: RequestInit) => Promise<any>,
  options: { hash?: string } = {}
) {
  const dom = new JSDOM(accountHtml(), {
    url: `http://127.0.0.1:3000/account${options.hash || ''}`,
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  let authUser: Record<string, unknown> = { username: 'alice', role: 'customer' };
  window.AgentXAuth = {
    requireLogin: () => true,
    getToken: () => 'test-token',
    getUser: () => authUser,
    setUser: vi.fn((nextUser) => {
      authUser = nextUser;
    }),
    logout: vi.fn(),
    authFetch: handler
  };
  window.navigator.clipboard = { writeText: vi.fn() } as any;
  window.eval(readPublicFile('i18n.js'));
  window.eval(readPublicFile('assets/i18n-portal.js'));
  window.eval(readPublicFile('assets/i18n-mcp-tickets.js'));
  window.eval(readPublicFile('ui-kit.js'));
  window.eval(accountJs());
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  return window;
}

describe('account center UI', () => {
  it('defines the account page structure and safe account API calls', () => {
    const html = accountHtml();
    const js = accountJs();

    for (const token of [
      'id="account-profile-form"',
      'id="account-password-form"',
      'id="account-key-list"',
      'id="account-credits-list"',
      'id="account-secret-panel"',
      'data-account-workbench',
      'data-account-view="overview"',
      'data-portal-auth',
      'data-portal-nav',
      'portal-page',
      'portal-topbar',
      'float-nav',
      'data-product-name',
      'portal-skin-slot',
      'id="account-mode-list"'
    ]) {
      expect(html).toContain(token);
    }
    for (const removed of [
      'data-announcements-account',
      'announcements.js',
      'account-onboarding',
      'id="logout"',
      'account-admin-link',
      'data-product-version',
      '授权模型',
      'id="account-model-list"'
    ]) {
      expect(html).not.toContain(removed);
    }
    for (const endpoint of [
      '/api/account',
      '/api/account/profile',
      '/api/account/password',
      '/api/account/mcp-keys',
      '/api/account/credits'
    ]) {
      expect(js).toContain(endpoint);
    }
    expect(js).toContain('clearOneTimeSecret');
    expect(js).toContain('showOneTimeSecret');
    expect(js).not.toContain('NAV_STORAGE_KEY');
    expect(js).toContain('renderAvailableModes');
    expect(js).not.toContain('localStorage.setItem');
    expect(js).not.toMatch(/passwordHash|Authorization|Bearer/);
    expect(js).not.toContain('permissions.authorizedModels');
  });

  it('renders available modes instead of exposing authorized model ids', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(
          accountPayload({
            permissions: {
              ...accountPayload().permissions,
              availableModels: [
                { id: 'haiku', label: 'Standard', chatMode: 'standard', supportsImages: false, creditUnits: 50 },
                { id: 'opus', label: 'Multimodal', chatMode: 'multimodal', supportsImages: true, creditUnits: 260 },
                { id: 'sonnet', label: 'Enhanced', chatMode: 'enhanced', supportsImages: false, creditUnits: 120 }
              ],
              searchModes: [
                { id: 'standard', label: 'Standard', available: true, selectable: true, description: 'Default text Q&A' },
                { id: 'multimodal', label: 'Multimodal', available: true, selectable: true, description: 'Image-aware answers' },
                { id: 'enhanced', label: 'Enhanced', available: true, selectable: true, description: 'Long-context answers' }
              ],
              authorizedModels: ['haiku', 'opus', 'sonnet']
            }
          })
        );
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const modeList = window.document.getElementById('account-mode-list');
    expect(modeList?.textContent).toContain('标准');
    expect(modeList?.textContent).toContain('多模态');
    expect(modeList?.textContent).toContain('增强');
    expect(modeList?.textContent).not.toContain('haiku');
    expect(modeList?.textContent).not.toContain('opus');
    expect(modeList?.textContent).not.toContain('sonnet');
    expect(window.document.body.textContent).not.toContain('授权模型');
  });

  it('derives overview metrics and recent credits from the same API responses', async () => {
    const ledgerItem = {
      createdAt: '2026-07-10T08:00:00.000Z',
      entry: 'web',
      modelId: 'haiku',
      units: 50,
      status: 'charged',
      reason: 'agent_success'
    };
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(accountPayload({
          permissions: {
            ...accountPayload().permissions,
            searchModes: [
              { id: 'standard', available: true, selectable: true },
              { id: 'enhanced', available: true, selectable: true },
              { id: 'multimodal', available: false, selectable: true }
            ]
          },
          mcpKeys: [{
            id: 'key-1',
            name: 'laptop',
            fingerprint: 'abcd1234ef56',
            maskedKey: '1111...5555',
            expiresAt: '2099-12-31T23:59:59.000Z',
            lastUsed: '2026-07-10T07:30:00.000Z'
          }]
        }));
      }
      if (path === '/api/account/credits?limit=20') {
        return okJson({ balanceUnits: 999800, ledger: { items: [ledgerItem], total: 7, offset: 0, limit: 20 } });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    expect(window.document.getElementById('account-overview-mode-count')?.textContent).toBe('2');
    expect(window.document.getElementById('account-key-count')?.textContent).toBe('1');
    expect(window.document.getElementById('account-credit-balance')?.textContent).toBe('999800');
    expect(window.document.getElementById('account-overview-credit-balance')?.textContent).toBe('999800');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent).toContain('网页 · 50 单位 · 已扣除');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent).toContain('50');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent).toContain('7 条记录');
    expect(window.document.getElementById('account-credits-detail-balance')?.textContent).toBe('999800');
    expect(window.document.getElementById('account-credits-detail-total')?.textContent).toBe('7');
    expect(window.document.getElementById('account-credits-list')?.textContent).toContain('网页');
    expect(window.document.getElementById('account-credits-list')?.textContent).toContain('已扣除');
    expect(window.document.querySelector('#account-credits-list .ledger-status')?.getAttribute('title'))
      .toBe('智能体任务成功完成');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).toContain('1111...5555');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).toContain('过期时间 2099-12-31T23:59:59.000Z');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).toContain('最近使用 2026-07-10T07:30:00.000Z');
    expect(window.document.body.textContent).not.toContain('abcd1234ef56-secret');
  });

  it.each([
    [{ status: 'active' }, '账户状态正常'],
    [{ status: 'disabled' }, '账户已停用'],
    [{ status: 'active', expiresAt: '2000-01-01T00:00:00.000Z' }, '账户已过期']
  ])('renders truthful account availability for %j', async (userPatch, expected) => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(accountPayload({
          user: { ...accountPayload().user, ...userPatch }
        }));
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });

    expect(window.document.getElementById('account-availability')?.textContent).toContain(expected);
  });

  it('renders truthful empty states instead of synthetic chart values', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).toContain('暂无 MCP Key');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent).toContain('暂无 Credits 使用记录');
    expect(window.document.querySelector('.account-credit-chart')).toBeNull();
  });

  it('counts active keys and previews the three most recently used without exposing expired keys', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(accountPayload({
          mcpKeys: [
            { id: 'expired', name: 'expired', maskedKey: 'expired-mask', expiresAt: '2000-01-01T00:00:00.000Z', lastUsed: '2099-01-01T00:00:00.000Z' },
            { id: 'active-a', name: 'active-a', maskedKey: 'mask-a', expiresAt: '2099-01-01T00:00:00.000Z', lastUsed: '2026-07-10T09:00:00.000Z' },
            { id: 'active-b', name: 'active-b', maskedKey: 'mask-b', expiresAt: '2099-01-01T00:00:00.000Z', lastUsed: '2026-07-09T09:00:00.000Z' },
            { id: 'active-c', name: 'active-c', maskedKey: 'mask-c', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-07-08T09:00:00.000Z' },
            { id: 'active-d', name: 'active-d', maskedKey: 'mask-d', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-07-07T09:00:00.000Z' }
          ]
        }));
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });

    const previewRows = Array.from(window.document.querySelectorAll('.account-key-preview-row'));
    expect(window.document.getElementById('account-key-count')?.textContent).toBe('4');
    expect(previewRows).toHaveLength(3);
    expect(previewRows[0]?.textContent).toContain('active-a');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).not.toContain('expired-mask');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent).not.toContain('active-d');
  });

  it('keeps the newest account refresh from being overwritten by stale responses', async () => {
    const slowAccount = deferred<any>();
    const slowCredits = deferred<any>();
    let accountCalls = 0;
    let creditsCalls = 0;
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        accountCalls += 1;
        if (accountCalls === 1) {
          return slowAccount.promise;
        }
        return okJson(accountPayload({ user: { ...accountPayload().user, username: 'fresh' } }));
      }
      if (path === '/api/account/credits?limit=20') {
        creditsCalls += 1;
        if (creditsCalls === 1) {
          return slowCredits.promise;
        }
        return okJson(creditsPayload());
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    (window.document.getElementById('account-refresh') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(window.document.getElementById('account-username')?.textContent).toBe('fresh');

    slowAccount.resolve(okJson(accountPayload({ user: { ...accountPayload().user, username: 'stale' } })));
    slowCredits.resolve(okJson(creditsPayload()));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('account-username')?.textContent).toBe('fresh');
    expect(window.document.getElementById('account-status')?.textContent).toContain('账户信息已同步');
  });

  it('loads current account state from the server and saves profile for the current user', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const window = await setupAccountDom(async (path, init) => {
      calls.push({ path, init });
      if (path === '/api/account' && !init) return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      if (path === '/api/account/profile' && init?.method === 'PUT') return okJson({ user: { username: 'alice' } });
      throw new Error(`Unexpected fetch: ${path}`);
    });

    expect(window.document.getElementById('account-username')?.textContent).toBe('alice');
    const realName = window.document.getElementById('profile-real-name') as HTMLInputElement;
    realName.value = 'Alice Updated';
    (window.document.getElementById('account-profile-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    const profileCall = calls.find((call) => call.path === '/api/account/profile');
    expect(profileCall?.init?.body).toContain('Alice Updated');
    expect(profileCall?.init?.body).not.toContain('userId');
    // 成功反馈已从行内灰字迁移到 AgentXUI toast
    expect(window.document.querySelector('.agentx-toast')?.textContent).toContain('资料已保存');
  });

  it('blocks mismatched password confirmation before calling the password API', async () => {
    const calls: string[] = [];
    const window = await setupAccountDom(async (path) => {
      calls.push(path);
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });

    (window.document.getElementById('account-current-password') as HTMLInputElement).value = 'old-password';
    (window.document.getElementById('account-new-password') as HTMLInputElement).value = 'new-password';
    (window.document.getElementById('account-confirm-password') as HTMLInputElement).value = 'different';
    (window.document.getElementById('account-password-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    expect(calls).not.toContain('/api/account/password');
    expect(window.document.getElementById('account-password-result')?.textContent).toContain('不一致');
  });

  it('localizes dynamic key and credit metadata when the account locale changes', async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    let user = {
      ...(accountPayload().user as Record<string, unknown>),
      localePreference: 'zh-CN',
      preferredLanguage: 'zh-CN'
    };
    const key = {
      id: 'key-1',
      name: 'laptop',
      fingerprint: 'abcd1234ef56',
      maskedKey: '1111...5555'
    };
    const ledgerItem = {
      createdAt: '2026-07-10T08:00:00.000Z',
      entry: 'partner_api',
      units: 0,
      status: 'future_state',
      reason: 'future_reason'
    };
    const adminLedgerItem = {
      createdAt: '2026-07-10T09:00:00.000Z',
      entry: 'admin',
      units: 25,
      status: 'charged',
      reason: 'agent_success'
    };
    const window = await setupAccountDom(async (path, init) => {
      calls.push({ path, init });
      if (path === '/api/account' && !init) return okJson(accountPayload({ user, mcpKeys: [key] }));
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload([ledgerItem, adminLedgerItem]));
      if (path === '/api/account/locale' && init?.method === 'PUT') {
        user = { ...user, localePreference: 'en-US', preferredLanguage: 'en-US' };
        return okJson({ user });
      }
      throw new Error('Unexpected fetch: ' + path);
    });

    expect(window.document.getElementById('account-overview-key-preview')?.textContent)
      .toContain('永不过期 · 从未使用');
    expect(window.document.getElementById('account-key-list')?.textContent)
      .toContain('指纹 abcd1234ef56 · 永不过期 · 从未使用');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent)
      .toContain('未知入口 · 0 单位 · 未知状态');
    expect(window.document.querySelector('#account-credits-list .ledger-status')?.getAttribute('title'))
      .toBe('其他积分事件');
    expect(window.document.querySelectorAll('#account-credits-list .ledger-status')[1]?.getAttribute('title'))
      .toBe('agent_success');

    const locale = window.document.getElementById('account-locale') as HTMLSelectElement;
    locale.value = 'en-US';
    locale.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.documentElement.lang).toBe('en-US');
    expect(window.document.getElementById('account-overview-key-preview')?.textContent)
      .toContain('No expiry · Never used');
    expect(window.document.getElementById('account-key-list')?.textContent)
      .toContain('Fingerprint abcd1234ef56 · No expiry · Never used');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent)
      .toContain('Unknown entry · 0 units · Unknown');
    expect(window.document.querySelector('#account-credits-list .ledger-status')?.getAttribute('title'))
      .toBe('Other credit event');
    expect(window.document.querySelectorAll('#account-credits-list .ledger-status')[1]?.getAttribute('title'))
      .toBe('agent_success');
    expect(calls.find((call) => call.path === '/api/account/locale')?.init?.body)
      .toBe(JSON.stringify({ locale: 'en-US' }));
    const unsavedUsagePurpose = window.document.getElementById('profile-usage-purpose') as HTMLTextAreaElement;
    unsavedUsagePurpose.value = 'unsaved profile draft';
    await window.AgentXI18n.setLocale('zh-CN', { persist: false, syncAccount: false, source: 'shared-switch' });
    await flushBrowserTasks();

    expect(window.document.getElementById('account-overview-key-preview')?.textContent)
      .toContain('永不过期 · 从未使用');
    expect(window.document.getElementById('account-overview-credit-recent')?.textContent)
      .toContain('未知入口 · 0 单位 · 未知状态');
    expect(window.document.querySelector('#account-credits-list .ledger-status')?.getAttribute('title'))
      .toBe('其他积分事件');
    expect(window.document.querySelectorAll('#account-credits-list .ledger-status')[1]?.getAttribute('title'))
      .toBe('agent_success');
    expect(unsavedUsagePurpose.value).toBe('unsaved profile draft');

    expect(window.document.body.textContent).not.toMatch(/passwordHash|Bearer|mcp_REAL_SECRET/i);
  });

  it('defaults to overview and supports valid hash deep links', async () => {
    const handler = async (path: string) => {
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    };
    const defaultWindow = await setupAccountDom(handler);
    expect(defaultWindow.location.hash).toBe('#overview');
    expect((defaultWindow.document.querySelector('[data-account-view-panel="overview"]') as HTMLElement).hidden).toBe(false);
    const accessWindow = await setupAccountDom(handler, { hash: '#access' });
    expect((accessWindow.document.querySelector('[data-account-view-panel="access"]') as HTMLElement).hidden).toBe(false);
    expect(accessWindow.document.querySelector('[data-account-view="access"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps hash, active trigger and visible panel synchronized', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });
    (window.document.querySelector('[data-account-view="credits"]') as HTMLButtonElement).click();
    expect(window.location.hash).toBe('#credits');
    expect((window.document.querySelector('[data-account-view-panel="credits"]') as HTMLElement).hidden).toBe(false);
    window.location.hash = '#security';
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    expect((window.document.querySelector('[data-account-view-panel="security"]') as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('[data-account-view="security"]')?.classList.contains('active')).toBe(true);
  });

  it('keeps all six navigation buttons tabbable and follows browser back and forward', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });
    const triggers = Array.from(window.document.querySelectorAll('[data-account-view]')) as HTMLButtonElement[];
    expect(triggers).toHaveLength(6);
    expect(triggers.every((trigger) => trigger.tabIndex === 0)).toBe(true);
    (window.document.querySelector('[data-account-view="credits"]') as HTMLButtonElement).click();
    (window.document.querySelector('[data-account-view="security"]') as HTMLButtonElement).click();

    const back = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.back();
    await back;
    await flushBrowserTasks();
    expect(window.location.hash).toBe('#credits');
    expect((window.document.querySelector('[data-account-view-panel="credits"]') as HTMLElement).hidden).toBe(false);

    const forward = new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    window.history.forward();
    await forward;
    await flushBrowserTasks();
    expect(window.location.hash).toBe('#security');
    expect((window.document.querySelector('[data-account-view-panel="security"]') as HTMLElement).hidden).toBe(false);
  });

  it('normalizes an unknown hash to overview', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') return okJson(accountPayload());
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    }, { hash: '#unknown' });
    expect(window.location.hash).toBe('#overview');
    expect((window.document.querySelector('[data-account-view-panel="overview"]') as HTMLElement).hidden).toBe(false);
  });

  it('disables key creation when self-service policy is closed and renders empty states', async () => {
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(
          accountPayload({
            permissions: {
              ...accountPayload().permissions,
              mcpKeyPolicy: {
                allowMcpKeySelfCreate: false,
                maxMcpKeys: 0,
                defaultMcpKeyTtlDays: 0,
                allowMcpKeyRegenerate: false
              }
            }
          })
        );
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    });

    expect((window.document.getElementById('account-create-key') as HTMLButtonElement).disabled).toBe(true);
    expect(window.document.getElementById('account-key-policy-note')?.textContent).toContain('已关闭');
    expect(window.document.getElementById('account-key-list')?.textContent).toContain('暂无 MCP Key');
    expect(window.document.getElementById('account-credits-list')?.textContent).toContain('暂无 credits 记录');
  });

  it('shows created secret once and clears it on refresh without rendering full secrets from lists', async () => {
    const createdSecret = '11111111-2222-4333-8444-555555555555';
    let keys: unknown[] = [];
    const window = await setupAccountDom(async (path, init) => {
      if (path === '/api/account') return okJson(accountPayload({ mcpKeys: keys }));
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      if (path === '/api/account/mcp-keys' && init?.method === 'POST') {
        keys = [{ id: 'key-1', name: 'laptop', fingerprint: 'abcd1234ef56', maskedKey: '1111...5555' }];
        return okJson({ key: keys[0], secret: createdSecret }, 201);
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });

    (window.document.getElementById('account-key-name') as HTMLInputElement).value = 'laptop';
    (window.document.getElementById('account-key-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('account-secret-panel')?.hidden).toBe(false);
    expect(window.document.body.textContent).toContain(createdSecret);
    expect(window.document.getElementById('account-key-list')?.textContent).not.toContain(createdSecret);

    (window.document.getElementById('account-refresh') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('account-secret-panel')?.hidden).toBe(true);
    expect(window.document.body.textContent).not.toContain(createdSecret);
    expect(window.document.body.textContent).toContain('1111...5555');
  });

  it('confirms revoke and regenerate, showing only the regenerated one-time secret', async () => {
    const regeneratedSecret = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const calls: string[] = [];
    const key = { id: 'key-1', name: 'laptop', fingerprint: 'abcd1234ef56', maskedKey: '1111...5555' };
    const window = await setupAccountDom(async (path, init) => {
      calls.push(`${init?.method || 'GET'} ${path}`);
      if (path === '/api/account') return okJson(accountPayload({ mcpKeys: [key] }));
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      if (path === '/api/account/mcp-keys/key-1/regenerate' && init?.method === 'POST') {
        return okJson({ key, secret: regeneratedSecret });
      }
      if (path === '/api/account/mcp-keys/key-1' && init?.method === 'DELETE') {
        return noContent();
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    // 重生成：点击触发应用内确认弹窗，点确认按钮（primary）继续
    (window.document.querySelector('[data-action="regenerate"]') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const regenConfirm = window.document.querySelector('.agentx-modal-actions .primary-button') as HTMLButtonElement;
    expect(regenConfirm).toBeTruthy();
    regenConfirm.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls).toContain('POST /api/account/mcp-keys/key-1/regenerate');
    expect(window.document.body.textContent).toContain(regeneratedSecret);

    // 撤销：danger 确认弹窗，点 danger 按钮确认
    (window.document.querySelector('[data-action="revoke"]') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const revokeConfirm = window.document.querySelector('.agentx-modal-actions .danger-button') as HTMLButtonElement;
    expect(revokeConfirm).toBeTruthy();
    revokeConfirm.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls).toContain('DELETE /api/account/mcp-keys/key-1');
    expect(window.document.body.textContent).not.toContain(regeneratedSecret);
  });

  it('renders one searchable typed resource catalog without collapsing same-label identities', async () => {
    const resources = [
      { type: 'chip', id: 'E522.95', label: 'E522.95 Datasheet' },
      { type: 'document', id: 'doc-e52295-main', label: 'E522.95 Datasheet' },
      { type: 'scopePreset', id: 'lighting', label: 'ELMOS Lighting' },
      { type: 'promptTemplate', id: 'support', label: 'Support Prompt' }
    ];
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(accountPayload({
          permissions: { ...accountPayload().permissions, resources },
          mcpKeys: [
            { id: 'inherit', name: 'inherit', maskedKey: 'aaaa...bbbb', resources },
            { id: 'limited', name: 'limited', maskedKey: 'cccc...dddd', resourceGrants: { chipIds: ['E522.95'] }, resources: [resources[0]] },
            { id: 'empty', name: 'empty', maskedKey: 'eeee...ffff', resourceGrants: { chipIds: [] }, resources: [] }
          ]
        }));
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    }, { hash: '#access' });

    expect(window.document.getElementById('account-resource-count-all')?.textContent).toBe('4');
    expect(window.document.getElementById('account-resource-count-chip')?.textContent).toBe('1');
    expect(window.document.getElementById('account-resource-count-document')?.textContent).toBe('1');
    expect(window.document.getElementById('account-resource-count-scope')?.textContent).toBe('1');
    expect(window.document.getElementById('account-resource-count-other')?.textContent).toBe('1');
    expect(window.document.querySelector('[data-resource-identity="chip:E522.95"]')).toBeTruthy();
    expect(window.document.querySelector('[data-resource-identity="document:doc-e52295-main"]')).toBeTruthy();
    expect(window.document.querySelector('[data-resource-group="other"]')?.textContent).toContain('promptTemplate');

    const search = window.document.getElementById('account-resource-search') as HTMLInputElement;
    search.value = 'E522.95';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.querySelectorAll('#account-resource-list .account-resource-item')).toHaveLength(2);
    expect(window.document.getElementById('account-resource-list')?.textContent).toContain('chip:E522.95');
    expect(window.document.getElementById('account-resource-list')?.textContent).toContain('document:doc-e52295-main');

    search.value = '';
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.querySelector('[data-resource-filter="document"]') as HTMLButtonElement).click();
    expect(window.document.querySelectorAll('#account-resource-list .account-resource-item')).toHaveLength(1);
    expect(window.document.getElementById('account-resource-list')?.textContent).toContain('document:doc-e52295-main');
  });

  it('renders inherited, independently limited and explicitly empty key ranges without duplicate inherited lists', async () => {
    const resources = [
      { type: 'chip', id: 'E521.31', label: 'E521.31 Datasheet' },
      { type: 'document', id: 'doc-main', label: 'Main Datasheet' }
    ];
    const window = await setupAccountDom(async (path) => {
      if (path === '/api/account') {
        return okJson(accountPayload({
          permissions: { ...accountPayload().permissions, resources },
          mcpKeys: [
            { id: 'inherit', name: 'inherit', maskedKey: 'aaaa...bbbb', resources },
            { id: 'limited', name: 'limited', maskedKey: 'cccc...dddd', resourceGrants: { chipIds: ['E521.31'] }, resources: [resources[0]] },
            { id: 'empty', name: 'empty', maskedKey: 'eeee...ffff', resourceGrants: { chipIds: [] }, resources: [] }
          ]
        }));
      }
      if (path === '/api/account/credits?limit=20') return okJson(creditsPayload());
      throw new Error(`Unexpected fetch: ${path}`);
    }, { hash: '#access' });

    const inherited = window.document.querySelector('[data-key-id="inherit"]') as HTMLElement;
    const limited = window.document.querySelector('[data-key-id="limited"]') as HTMLElement;
    const empty = window.document.querySelector('[data-key-id="empty"]') as HTMLElement;
    expect(inherited.textContent).toContain('完整继承账户生效资源');
    expect(inherited.textContent).toContain('2/2');
    expect(inherited.querySelector('.account-key-difference')).toBeNull();
    expect(limited.textContent).toContain('Key 独立限制生效资源');
    expect(limited.textContent).toContain('1/2');
    expect(limited.querySelector('.account-key-difference')?.textContent).toContain('较账户未包含 · 1');
    expect(empty.textContent).toContain('Key 无生效资源');
    expect(empty.textContent).toContain('0/2');

    (window.document.getElementById('account-resource-toggle') as HTMLButtonElement).click();
    expect((window.document.getElementById('account-resource-body') as HTMLElement).hidden).toBe(true);
    (inherited.querySelector('[data-view-account-resources]') as HTMLButtonElement).click();
    expect((window.document.getElementById('account-resource-body') as HTMLElement).hidden).toBe(false);
    expect(window.document.activeElement?.id).toBe('account-resource-catalog');
  });
});
