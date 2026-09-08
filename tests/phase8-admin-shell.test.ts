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

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function installAdminAuth(window: Window & Record<string, any>, user: unknown, fetchCalls: string[] = []) {
  window.AgentXAuth = {
    getUser: () => user,
    logout: () => undefined,
    login: async () => ({ user }),
    clearToken: () => undefined,
    authFetch: async (path: string) => {
      fetchCalls.push(path);
      if (path === '/admin/chips') {
        return okJson({ chips: [], knowledgeBaseRoot: '' });
      }
      if (path === '/admin/users') {
        return okJson({ users: [{ id: 'user-1', username: 'alice', role: 'customer', mcpKeys: [], credits: { balanceUnits: 1200 } }] });
      }
      if (path === '/admin/prompts') {
        return okJson({ files: [] });
      }
      if (path === '/admin/roles') {
        return okJson({ roles: { admin: { description: 'Admin', permissions: [] } }, _permissions: {} });
      }
      if (path === '/admin/users/user-1/effective-authorization') {
        return okJson({
          userId: 'user-1',
          dimensions: { brands: [], productLines: [], chipIds: [], modelIds: [], scopePresetIds: [], mcpTools: [] },
          overrides: {},
          computedAt: '2026-07-04T00:00:00.000Z'
        });
      }
      if (path.startsWith('/admin/sessions/history')) {
        return okJson({ items: [], total: 0, offset: 0, limit: 50 });
      }
      if (path.startsWith('/admin/questions')) {
        return okJson({ items: [], total: 0, offset: 0, limit: 50 });
      }
      if (path === '/admin/model-routing') {
        return okJson({
          config: {
            allowedRoles: ['haiku', 'sonnet', 'opus', 'fable'],
            modeRoleMapping: { standard: 'haiku', enhanced: 'sonnet', multimodal: 'opus' }
          }
        });
      }
      if (path.startsWith('/admin/credits?')) {
        return okJson({
          userId: 'user-1',
          username: 'alice',
          balanceUnits: 1200,
          ledger: { items: [], total: 0, offset: 0, limit: 20 }
        });
      }
      throw new Error(`Unexpected admin fetch: ${path}`);
    }
  };
}

async function bootAdminPage(url: string, user: unknown, fetchCalls: string[] = []) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url,
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  installAdminAuth(window, user, fetchCalls);

  window.eval(readPublicFile('admin.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();

  return window;
}

describe('phase 8 admin shell routing', () => {
  it('renders Admin shell with five collapsible navigation groups', () => {
    const html = readPublicFile('admin.html');
    const css = readPublicFile('styles.css');
    const dom = new JSDOM(html);
    const document = dom.window.document;

    expect(html).toContain('id="admin-section-nav"');
    expect(html).toContain('id="admin-breadcrumb"');
    expect(document.querySelector('[data-portal-nav]')).toBeNull();
    expect(document.querySelector('[data-product-version]')).not.toBeNull();
    expect(document.querySelector('[data-portal-auth]')).not.toBeNull();
    expect(document.querySelector('.admin-return-link')?.getAttribute('href')).toBe('/home');

    const groups = [...document.querySelectorAll('[data-nav-group]')];
    expect(groups.map((group) => group.getAttribute('data-nav-group'))).toEqual([
      'user-access',
      'knowledge',
      'operations',
      'content-support',
      'system-settings'
    ]);
    expect(groups.map((group) => group.querySelector('.admin-nav-group-title')?.textContent?.trim())).toEqual([
      '用户与访问',
      '知识库',
      '运营记录',
      '内容与支持',
      '系统设置'
    ]);

    const visibleSections = [...document.querySelectorAll('#admin-section-nav [data-section]')]
      .map((link) => link.getAttribute('data-section'));
    expect(visibleSections).toEqual([
      'users',
      'roles',
      'chips',
      'resources',
      'prompts',
      'sessions',
      'observability',
      'announcements',
      'feedback',
      'model-routing',
      'discovery-traces'
    ]);
    expect(document.getElementById('section-credits')).toBeNull();
    expect(document.getElementById('section-questions')).toBeNull();
    expect(document.getElementById('history-tab-questions')).not.toBeNull();
    expect(css).toContain('.admin-section-nav');
    expect(css).toContain('.admin-nav-group');
    expect(css).toContain('.admin-breadcrumb');
    expect(css).toContain('.admin-workspace-shell');
    expect(css).toContain('.users-section');
  });

  it('defaults /admin to the users section and replaces the URL', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage('http://127.0.0.1:3000/admin', { username: 'root', role: 'admin' }, fetchCalls);

    expect(window.location.pathname).toBe('/admin/sections/users');
    expect((window.document.getElementById('panel-users') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('panel-roles') as HTMLElement).hidden).toBe(true);
    expect((window.document.getElementById('panel-model-routing') as HTMLElement).hidden).toBe(true);
    expect(window.document.querySelector('[data-section="users"]')?.getAttribute('aria-current')).toBe('page');
    expect(window.document.querySelector('[data-nav-group="user-access"]')?.getAttribute('data-expanded')).toBe('true');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('用户与访问');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('用户');
    expect(fetchCalls).toEqual([
      '/admin/chips',
      '/admin/users',
      '/admin/prompts',
      '/admin/roles',
      // 批次D（2.2.27）：资源目录（documents/scopePresets）改为初始预加载，供「用户与访问」授权候选使用。
      '/admin/resources'
    ]);
  });

  it('activates the modes and model tiers section and loads its admin config', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/model-routing', {
      username: 'root',
      role: 'admin'
    }, fetchCalls);

    expect((window.document.getElementById('panel-model-routing') as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('[data-section="model-routing"]')?.getAttribute('aria-current')).toBe('page');
    expect(window.document.querySelector('[data-nav-group="system-settings"]')?.getAttribute('data-expanded')).toBe('true');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('系统设置');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('模式与模型档位');
    expect((window.document.getElementById('model-routing-standard') as HTMLSelectElement).value).toBe('haiku');
    expect(fetchCalls).toContain('/admin/model-routing');
  });

  it('routes questions through session history while highlighting the operations nav item', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/questions', {
      username: 'root',
      role: 'admin'
    }, fetchCalls);

    expect((window.document.getElementById('panel-sessions') as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('[data-section="sessions"]')?.getAttribute('aria-current')).toBe('page');
    expect(window.document.querySelector('[data-section="questions"]')).toBeNull();
    expect(window.document.querySelector('[data-nav-group="operations"]')?.getAttribute('data-expanded')).toBe('true');
    expect(window.document.getElementById('history-tab-questions')?.getAttribute('aria-selected')).toBe('true');
    expect((window.document.getElementById('history-pane-questions') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('运营记录');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('会话历史');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('问题台账');
    expect(fetchCalls.some((path) => path.startsWith('/admin/questions'))).toBe(true);
  });

  it('updates breadcrumbs when history tabs change', async () => {
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/sessions', {
      username: 'root',
      role: 'admin'
    });

    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('按用户');
    (window.document.getElementById('history-tab-questions') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/questions');
    expect(window.document.getElementById('history-tab-questions')?.getAttribute('aria-selected')).toBe('true');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('问题台账');
    (window.document.getElementById('history-tab-latest') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/sessions');
    expect(window.document.getElementById('history-tab-latest')?.getAttribute('aria-selected')).toBe('true');

    window.history.back();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/questions');
    expect(window.document.getElementById('history-tab-questions')?.getAttribute('aria-selected')).toBe('true');
    expect(window.document.getElementById('admin-breadcrumb')?.textContent).toContain('问题台账');
  });

  it('exposes credits controls from the selected user detail tab', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/users', {
      username: 'root',
      role: 'admin'
    }, fetchCalls);

    expect(window.document.getElementById('user-tab-credits')).not.toBeNull();
    (window.document.querySelector('#user-list tr') as HTMLTableRowElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.getElementById('user-tab-credits') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('user-tabpanel-credits') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('selected-user-credit-balance')?.textContent).toContain('1200');
    expect(window.document.getElementById('selected-user-credit-ledger')).not.toBeNull();
    expect(window.document.getElementById('selected-user-credit-mode-delta')?.getAttribute('aria-pressed')).toBe('true');
    expect(window.document.getElementById('selected-user-credit-mode-balance')).not.toBeNull();
    expect(fetchCalls.some((path) => path === '/admin/credits?userId=user-1')).toBe(true);
  });

  it('activates matching sections for direct URLs and navigation clicks', async () => {
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/prompts', {
      username: 'root',
      role: 'admin'
    });

    expect((window.document.getElementById('panel-prompts') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('panel-users') as HTMLElement).hidden).toBe(true);
    expect(window.document.querySelector('[data-section="prompts"]')?.getAttribute('aria-current')).toBe('page');

    const chips = window.document.querySelector('[data-section="chips"]') as HTMLAnchorElement;
    chips.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/chips');
    expect((window.document.getElementById('panel-chips') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('panel-prompts') as HTMLElement).hidden).toBe(true);
  });

  it('keeps browser back and forward aligned with the visible Admin section', async () => {
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/users', {
      username: 'root',
      role: 'admin'
    });

    (window.document.querySelector('[data-section="roles"]') as HTMLAnchorElement).dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true })
    );
    (window.document.querySelector('[data-section="chips"]') as HTMLAnchorElement).dispatchEvent(
      new window.MouseEvent('click', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/chips');
    expect((window.document.getElementById('panel-chips') as HTMLElement).hidden).toBe(false);

    window.history.back();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/roles');
    expect((window.document.getElementById('panel-roles') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('panel-chips') as HTMLElement).hidden).toBe(true);
  });

  it('shows only the login shell for unauthenticated direct section visits and makes no Admin API calls', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage('http://127.0.0.1:3000/admin/sections/roles', null, fetchCalls);

    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(true);
    expect((window.document.getElementById('admin-section-nav') as HTMLElement).hidden).toBe(true);
    expect(fetchCalls).toEqual([]);
  });

  it('shows the same no-permission state for non-admin direct section visits', async () => {
    const fetchCalls: string[] = [];
    const window = await bootAdminPage(
      'http://127.0.0.1:3000/admin/sections/chips',
      { username: 'alice', role: 'customer' },
      fetchCalls
    );

    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(true);
    expect(window.document.getElementById('admin-no-permission')?.textContent).toContain('No admin permission');
    expect(fetchCalls).toEqual([]);
  });

  it('returns to the login shell when an admin loader receives 401', async () => {
    const dom = new JSDOM(readPublicFile('admin.html'), {
      url: 'http://127.0.0.1:3000/admin/sections/users',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const fetchCalls: string[] = [];
    window.AgentXAuth = {
      getUser: () => ({ username: 'root', role: 'admin' }),
      logout: () => undefined,
      login: async () => ({ user: { username: 'root', role: 'admin' } }),
      clearToken: () => undefined,
      authFetch: async (path: string) => {
        fetchCalls.push(path);
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'Unauthorized' })
        };
      }
    };

    window.eval(readPublicFile('admin.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(fetchCalls).toContain('/admin/chips');
    expect((window.document.getElementById('admin-login-shell') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(true);
    expect((window.document.getElementById('admin-section-nav') as HTMLElement).hidden).toBe(true);
    expect(window.document.getElementById('admin-no-permission')?.textContent).toContain('Login expired');
  });
});
