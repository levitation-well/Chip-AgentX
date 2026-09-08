import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

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

function createdJson(payload: unknown) {
  return {
    ok: true,
    status: 201,
    json: async () => payload
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface AdminHarnessOptions {
  users?: any[];
  chips?: any[];
  effectiveAuthorization?: (user: any) => any;
  roles?: Record<string, any>;
}

async function bootAdminPage(options: AdminHarnessOptions = {}) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: 'http://127.0.0.1:3000/admin/sections/users',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];
  const users = options.users ?? [
    {
      id: 'user-1',
      username: 'alice',
      role: 'customer',
      createdAt: '2026-05-07T01:00:00.000Z',
      mcpKeys: []
    }
  ];
  const chips = options.chips ?? [
    { id: 'E521.39', label: 'E521.39 Chip' },
    { id: 'RISC-V', label: 'RISC-V Core' },
    { id: 'ADMIN-ONLY', label: 'Admin Only' }
  ];
  const roles = options.roles ?? {
    customer: {
      description: 'Customer',
      permissions: [],
      access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' }
    },
    internal: {
      description: 'Internal',
      permissions: ['users', 'prompts'],
      access: { allowedChips: ['E521.39', 'RISC-V'], injectionPolicy: 'every_turn' }
    },
    admin: {
      description: 'Admin',
      permissions: ['users', 'roles', 'prompts', 'chips'],
      access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
    }
  };

  window.navigator.clipboard = { writeText: vi.fn() };
  // ui-kit 在该功能测试中不加载，提供最小 AgentXUI 桩：confirm 默认放行、toast 静默
  window.AgentXUI = {
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => null),
    chipInput: vi.fn(() => ({ sync: vi.fn() }))
  };
  window.AgentXAuth = {
    getUser: () => ({ username: 'root', role: 'admin' }),
    logout: () => undefined,
    login: async () => ({ user: { username: 'root', role: 'admin' } }),
    clearToken: () => undefined,
    authFetch: async (path: string, requestOptions?: any) => {
      calls.push({ path, options: requestOptions });
      if (path === '/admin/chips') {
        return okJson({ chips, knowledgeBaseRoot: '' });
      }
      if (path === '/admin/users' && requestOptions?.method === 'POST') {
        const body = JSON.parse(requestOptions.body);
        const user = {
          id: 'user-2',
          username: body.username,
          role: body.role,
          status: body.status,
          expiresAt: body.expiresAt,
          profile: body.profile,
          createdAt: '2026-05-07T02:00:00.000Z',
          mcpKeys: []
        };
        users.push(user);
        return createdJson({ user });
      }
      if (path === '/admin/users') {
        return okJson({ users });
      }
      const effectiveAuthorizationMatch = /^\/admin\/users\/([^/]+)\/effective-authorization$/.exec(path);
      if (effectiveAuthorizationMatch) {
        const userId = decodeURIComponent(effectiveAuthorizationMatch[1]!);
        const user = users.find((candidate) => candidate.id === userId);
        if (options.effectiveAuthorization) {
          return okJson(options.effectiveAuthorization(user));
        }
        return okJson({
          userId,
          dimensions: {
            brands: [{ id: 'ELMOS', source: 'role_default' }],
            productLines: [{ id: 'Lighting', source: 'role_default' }],
            chipIds: [
              { id: 'E521.39', source: 'product_line_derived' },
              ...((user?.resourceGrants?.chipIds || []).map((id: string) => ({
                id,
                source: 'user_override'
              })))
            ],
            modelIds: [
              { id: 'haiku', source: 'role_default' },
              ...((user?.modelGrants || []).map((id: string) => ({ id, source: 'user_override' })))
            ],
            scopePresetIds: [],
            mcpTools: [{ id: 'agentx_whoami', source: 'role_default' }]
          },
          overrides: { systemBChipOverride: Object.prototype.hasOwnProperty.call(user?.resourceGrants || {}, 'chipIds') },
          computedAt: '2026-07-04T00:00:00.000Z'
        });
      }
      const roleMatch = /^\/admin\/users\/([^/]+)\/role$/.exec(path);
      if (roleMatch && requestOptions?.method === 'PUT') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(roleMatch[1]!));
        const body = JSON.parse(requestOptions.body);
        user.role = body.role;
        return okJson({ user });
      }
      const passwordMatch = /^\/admin\/users\/([^/]+)\/password$/.exec(path);
      if (passwordMatch && requestOptions?.method === 'PUT') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(passwordMatch[1]!));
        return okJson({ user });
      }
      const userUpdateMatch = /^\/admin\/users\/([^/]+)$/.exec(path);
      if (userUpdateMatch && requestOptions?.method === 'PUT') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(userUpdateMatch[1]!));
        Object.assign(user, JSON.parse(requestOptions.body));
        return okJson({ user });
      }
      const keyCreateMatch = /^\/admin\/users\/([^/]+)\/keys$/.exec(path);
      if (keyCreateMatch && requestOptions?.method === 'POST') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(keyCreateMatch[1]!));
        const body = JSON.parse(requestOptions.body);
        const key = {
          id: 'key-new',
          key: 'generated-full-key',
          name: body.name,
          expiresAt: body.expiresAt,
          createdAt: '2026-05-07T02:10:00.000Z'
        };
        user.mcpKeys.push(key);
        return createdJson({ key });
      }
      const keyUpdateMatch = /^\/admin\/users\/([^/]+)\/keys\/([^/]+)$/.exec(path);
      if (keyUpdateMatch && requestOptions?.method === 'PUT') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(keyUpdateMatch[1]!));
        const key = user.mcpKeys.find((candidate) => candidate.id === decodeURIComponent(keyUpdateMatch[2]!));
        Object.assign(key, JSON.parse(requestOptions.body));
        return okJson({ key });
      }
      if (keyUpdateMatch && requestOptions?.method === 'DELETE') {
        const user = users.find((candidate) => candidate.id === decodeURIComponent(keyUpdateMatch[1]!));
        user.mcpKeys = user.mcpKeys.filter((candidate) => candidate.id !== decodeURIComponent(keyUpdateMatch[2]!));
        return { ok: true, status: 204, json: async () => ({}) };
      }
      const deleteMatch = /^\/admin\/users\/([^/]+)$/.exec(path);
      if (deleteMatch && requestOptions?.method === 'DELETE') {
        const index = users.findIndex((candidate) => candidate.id === decodeURIComponent(deleteMatch[1]!));
        if (index >= 0) users.splice(index, 1);
        return { ok: true, status: 204, json: async () => ({}) };
      }
      if (path === '/admin/prompts') {
        return okJson({ files: [] });
      }
      if (path === '/admin/roles') {
        return okJson({ roles, _permissions: {} });
      }
      const roleSaveMatch = /^\/admin\/roles\/([^/]+)$/.exec(path);
      if (roleSaveMatch && requestOptions?.method === 'PUT') {
        const roleName = decodeURIComponent(roleSaveMatch[1]!);
        const body = JSON.parse(requestOptions.body);
        roles[roleName] = { description: body.description, permissions: body.permissions, access: body.access };
        return okJson({ role: roles[roleName] });
      }
      throw new Error(`Unexpected admin fetch: ${path}`);
    }
  };

  window.eval(readPublicFile('admin.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  await flushBrowserTasks();

  return { window, calls, users };
}

async function openFirstUserDetail(window: Window & Record<string, any>) {
  (window.document.querySelector('#user-list tr.user-row') as HTMLTableRowElement | null)?.click();
  await flushBrowserTasks();
  await flushBrowserTasks();
}

describe('phase 9 admin users page split', () => {
  it('prioritizes the user list with a persistent toolbar, inline filters and a hidden create modal', async () => {
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          resourceGrants: { chipIds: ['RISC-V'] },
          mcpKeys: [{ id: 'key-1', name: 'laptop', key: 'full-key', createdAt: '2026-05-07T01:10:00.000Z' }]
        }
      ]
    });

    const usersPanel = window.document.getElementById('panel-users')!;
    const searchBox = window.document.getElementById('user-search')!;
    const createOpen = window.document.getElementById('user-create-open')!;
    const filterBar = window.document.querySelector('.admin-filterbar') as HTMLFormElement;
    const userTable = window.document.querySelector('.user-table') as HTMLTableElement;
    const createModal = window.document.getElementById('user-create-modal') as HTMLDivElement;

    // MCP Key 标签页仍然存在
    expect(usersPanel.textContent).toContain('MCP Key');
    // 搜索框 + 创建按钮工具条排在表格之前
    expect(searchBox.compareDocumentPosition(userTable) & window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(createOpen.textContent).toContain('创建用户');
    // 筛选条常驻（不再是折叠的 details）
    expect(filterBar.tagName).toBe('FORM');
    expect(window.document.querySelector('#panel-users .admin-master-detail')).toBeTruthy();
    expect(window.document.querySelector('#panel-users .admin-master-col')).toBeTruthy();
    expect(window.document.querySelector('#panel-users .admin-detail-col')).toBeTruthy();
    expect(window.document.getElementById('panel-users')?.classList.contains('detail-open')).toBe(false);
    expect(window.document.querySelector('#panel-users .admin-master-detail')?.classList.contains('detail-open')).toBe(false);
    // V17（2.2.28）：密集表统一为 div 包裹，class 挂在外层 div、<table> 自身不再带 admin-dense-table。
    expect(userTable.classList.contains('admin-dense-table')).toBe(false);
    expect(userTable.parentElement?.classList.contains('admin-dense-table')).toBe(true);
    const headers = [...window.document.querySelectorAll('#panel-users .user-table thead th')]
      .map((th) => th.textContent?.trim());
    expect(headers).toEqual(['用户名', '角色', '状态', '积分余额', '芯片访问摘要', 'MCP Key', '有效期', '公司']);
    // 创建用户弹窗默认隐藏
    expect(createModal.hidden).toBe(true);
    // 表格行展示 KEY 数量与芯片访问摘要
    const userList = window.document.getElementById('user-list')!;
    const firstRow = userList.querySelector('tr')!;
    const cells = [...firstRow.querySelectorAll('td')].map((cell) => cell.textContent);
    expect(firstRow.classList.contains('user-row')).toBe(true);
    expect(firstRow.querySelector('td')?.colSpan).toBe(1);
    expect(cells).toHaveLength(8);
    expect(cells[0]).toContain('alice');
    expect(cells[1]).toContain('customer');
    await openFirstUserDetail(window);
    expect(window.document.getElementById('panel-users')?.classList.contains('detail-open')).toBe(true);
    expect(window.document.querySelector('#panel-users .admin-master-detail')?.classList.contains('detail-open')).toBe(true);
    expect(window.document.querySelector('#user-rail .user-compact-item')?.textContent).toContain('alice');
    expect(window.document.querySelector('#user-rail .user-compact-meta')?.textContent).toBe('customer');
  });

  it('keeps users master-detail and role summaries from squeezing text into broken words', async () => {
    const styles = readPublicFile('styles.css');

    expect(styles).toContain('.admin-master-detail.detail-open');
    expect(styles).toContain('.admin-master-detail.detail-open .full-only');
    expect(styles).toContain('.admin-master-detail.detail-open .user-rail-list');
    expect(styles).toContain('.user-compact-item');
    expect(styles).toContain('overflow-wrap: break-word');
    expect(styles).toContain('overflow-wrap: anywhere');
    expect(styles).toContain('word-break: normal');
    const roleSplitBlock = /\.role-split-pane \{[\s\S]*?\n\}/.exec(styles)?.[0] || '';
    const roleTextBlock = /\.role-card-desc \{[\s\S]*?\n\}/.exec(styles)?.[0] || '';
    expect(roleSplitBlock).toContain('grid-template-columns: minmax(280px, 300px) minmax(0, 1fr)');
    expect(roleTextBlock).toContain('overflow-wrap: normal');
    expect(roleTextBlock).toContain('hyphens: none');
    expect(roleTextBlock).not.toContain('overflow-wrap: break-word');
    expect(roleTextBlock).not.toContain('overflow-wrap: anywhere');
  });

  it('keeps long usernames fully visible in the dense users table', async () => {
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'very.long.customer.name@example-company.com',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          mcpKeys: []
        }
      ]
    });

    const userButton = window.document.querySelector('#user-list .user-info-btn') as HTMLButtonElement;
    expect(window.document.getElementById('user-list')?.textContent).toContain('very.long.customer.name@example-company.com');
    expect(userButton.className).not.toMatch(/truncate|ellipsis/);
  });

  it('opens the selected user detail and renders role editing after row selection', async () => {
    const { window } = await bootAdminPage();

    expect(window.document.getElementById('selected-user-title')?.textContent).toBe('选择用户');
    await openFirstUserDetail(window);

    expect(window.document.getElementById('selected-user-title')?.textContent).toBe('用户详情：alice');
    expect(window.document.getElementById('selected-user-meta')?.textContent).toContain('user-1');
    expect((window.document.getElementById('selected-user-role') as HTMLSelectElement).value).toBe('customer');
    expect(window.document.querySelector('tr.user-row[aria-selected="true"]')?.textContent).toContain('alice');
    expect(window.document.querySelector('.role-selector')).toBeNull();
  });

  it('creates a user and selects the created detail', async () => {
    const { window, calls } = await bootAdminPage();

    (window.document.getElementById('new-username') as HTMLInputElement).value = 'bob';
    (window.document.getElementById('new-password') as HTMLInputElement).value = 'bob-secret';
    (window.document.getElementById('new-role') as HTMLSelectElement).value = 'internal';
    (window.document.getElementById('new-status') as HTMLSelectElement).value = 'disabled';
    (window.document.getElementById('new-company') as HTMLInputElement).value = 'Elmos';
    window.document.getElementById('user-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const createCall = calls.find((call) => call.path === '/admin/users' && call.options?.method === 'POST');
    expect(JSON.parse(createCall?.options.body)).toMatchObject({
      username: 'bob',
      role: 'internal',
      status: 'disabled',
      profile: { company: 'Elmos' }
    });
    expect(window.document.getElementById('selected-user-title')?.textContent).toBe('用户详情：bob');
    expect((window.document.getElementById('selected-user-role') as HTMLSelectElement).value).toBe('internal');
    expect(window.document.querySelector('tr.user-row[aria-selected="true"]')?.textContent).toContain('bob');
  });

  it('creates a minimal user without sending profile:null', async () => {
    const { window, calls } = await bootAdminPage();

    (window.document.getElementById('new-username') as HTMLInputElement).value = 'minimal';
    (window.document.getElementById('new-password') as HTMLInputElement).value = 'minimal-secret';
    (window.document.getElementById('new-role') as HTMLSelectElement).value = 'customer';
    window.document.getElementById('user-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const createCall = calls.find((call) => call.path === '/admin/users' && call.options?.method === 'POST');
    const body = JSON.parse(createCall?.options.body);
    expect(body).toMatchObject({
      username: 'minimal',
      role: 'customer',
      status: 'active'
    });
    expect(body).not.toHaveProperty('profile');
  });

  it('saves profile fields and filters users locally', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          status: 'active',
          createdAt: '2026-05-07T01:00:00.000Z',
          profile: { company: 'AgentX', userType: 'customer_engineer' },
          mcpKeys: []
        },
        {
          id: 'user-2',
          username: 'bob',
          role: 'internal',
          status: 'disabled',
          createdAt: '2026-05-07T01:00:00.000Z',
          profile: { company: 'Elmos', userType: 'agent_engineer' },
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('selected-user-company') as HTMLInputElement).value = 'Updated Co';
    (window.document.getElementById('selected-user-status') as HTMLSelectElement).value = 'disabled';
    window.document
      .getElementById('selected-user-profile-form')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const saveCall = calls.find((call) => call.path === '/admin/users/user-1' && call.options?.method === 'PUT');
    expect(JSON.parse(saveCall?.options.body)).toMatchObject({
      status: 'disabled',
      profile: { company: 'Updated Co' }
    });
    expect(JSON.parse(saveCall?.options.body).profile).not.toHaveProperty('userType');

    (window.document.getElementById('user-filter-status') as HTMLSelectElement).value = 'disabled';
    window.document.getElementById('user-filter-form')?.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('user-list')?.textContent).toContain('alice');
    expect(window.document.getElementById('user-list')?.textContent).toContain('bob');

    (window.document.getElementById('user-filter-company') as HTMLInputElement).value = 'Updated';
    window.document.getElementById('user-filter-form')?.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('user-list')?.textContent).toContain('alice');
    expect(window.document.getElementById('user-list')?.textContent).not.toContain('bob');

    (window.document.getElementById('user-filter-company') as HTMLInputElement).value = '';
    (window.document.getElementById('user-filter-role') as HTMLSelectElement).value = 'internal';
    window.document.getElementById('user-filter-form')?.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(window.document.getElementById('user-list')?.textContent).not.toContain('alice');
    expect(window.document.getElementById('user-list')?.textContent).toContain('bob');
  });

  it('saves role changes from the selected user detail', async () => {
    const { window, calls } = await bootAdminPage();
    await openFirstUserDetail(window);

    (window.document.getElementById('selected-user-role') as HTMLSelectElement).value = 'internal';
    window.document
      .getElementById('selected-user-role-form')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const roleCall = calls.find((call) => call.path === '/admin/users/user-1/role');
    expect(roleCall?.options.method).toBe('PUT');
    expect(JSON.parse(roleCall?.options.body)).toEqual({ role: 'internal' });
    expect(window.document.querySelector('tr.user-row[aria-selected="true"]')?.textContent).toContain('internal');
  });

  it('masks existing MCP keys by default', async () => {
    const fullKey = 'mcp-secret-key-value';
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          mcpKeys: [{
            id: 'key-1',
            name: 'local-dev',
            key: fullKey,
            maskedKey: 'mcp-...alue',
            fingerprint: 'abcd1234ef56',
            createdAt: '2026-05-07T01:10:00.000Z'
          }]
        }
      ]
    });
    await openFirstUserDetail(window);

    const keyList = window.document.getElementById('key-list')!;
    expect(keyList.textContent).not.toContain(fullKey);
    expect(keyList.textContent).toContain('mcp-...alue');
    expect(keyList.textContent).not.toContain('Show');
    expect(keyList.textContent).toContain('复制摘要');
    expect(keyList.textContent).toContain('撤销');
  });

  it('creates and edits MCP key expiry without exposing full keys by default', async () => {
    const fullKey = 'mcp-secret-key-value';
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          mcpKeys: [{ id: 'key-1', name: 'local-dev', key: fullKey, createdAt: '2026-05-07T01:10:00.000Z' }]
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('key-name') as HTMLInputElement).value = 'remote';
    window.document.getElementById('key-form')?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const createCall = calls.find((call) => call.path === '/admin/users/user-1/keys' && call.options?.method === 'POST');
    expect(JSON.parse(createCall?.options.body)).toMatchObject({ name: 'remote' });

    const editForm = window.document.querySelector('#key-list .key-edit-form') as HTMLFormElement;
    (editForm.querySelector('input[type="text"]') as HTMLInputElement).value = 'renamed';
    editForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const editCall = calls.find((call) => call.path === '/admin/users/user-1/keys/key-1' && call.options?.method === 'PUT');
    expect(JSON.parse(editCall?.options.body)).toMatchObject({ name: 'renamed' });
    expect(window.document.getElementById('key-list')?.textContent).not.toContain(fullKey);
  });

  it('never reveals full existing MCP keys from the admin list DOM', async () => {
    const fullKey = 'mcp-secret-key-value';
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          mcpKeys: [{
            id: 'key-1',
            name: 'local-dev',
            key: fullKey,
            maskedKey: 'mcp-...alue',
            fingerprint: 'abcd1234ef56',
            createdAt: '2026-05-07T01:10:00.000Z'
          }]
        }
      ]
    });
    await openFirstUserDetail(window);

    const buttons = [...window.document.querySelectorAll('#key-list button')].map((button) => button.textContent);
    expect(buttons).not.toContain('Show');
    expect(buttons).not.toContain('Hide');
    expect(window.document.getElementById('key-list')?.textContent).not.toContain(fullKey);
    expect(window.document.getElementById('key-list')?.textContent).toContain('mcp-...alue');
  });

  it('renders unified access summary and editor with source badges', async () => {
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          modelGrants: ['sonnet'],
          resourceGrants: { chipIds: ['RISC-V'] },
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.document.getElementById('user-tab-grants')).toBeNull();
    expect(window.document.getElementById('user-tab-chips')).toBeNull();
    const summary = window.document.getElementById('selected-user-access-summary')!;
    expect(summary.textContent).toContain('ELMOS');
    expect(summary.textContent).toContain('产品线推导');
    expect(summary.textContent).toContain('用户覆盖');
    expect(summary.textContent).toContain('sonnet');
    expect(summary.querySelector('.admin-badge-muted')?.textContent).toContain('角色默认');
    expect(summary.querySelector('.admin-badge-info')?.textContent).toContain('用户覆盖');
    expect(summary.querySelector('.admin-badge-warn')?.textContent).toContain('产品线推导');
    expect(window.document.querySelectorAll('#user-tabpanel-access .admin-token-picker').length).toBeGreaterThanOrEqual(5);
    expect(window.document.querySelector('#user-tabpanel-access .admin-access-editor-hint')?.textContent).toContain(
      '品牌/产品线授权会自动展开为芯片授权'
    );
    expect(window.document.querySelector('#user-tabpanel-access .admin-check-list')).toBeTruthy();
    expect(window.document.querySelector('#user-tabpanel-access [data-admin-state="explicit"]')?.textContent).toContain('RISC-V');
    expect(window.document.querySelector('#user-tabpanel-access [data-admin-state="inherited"]')?.textContent).toContain('E521.39');
  });

  it('saves unified access to the user record only', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          modelGrants: ['sonnet'],
          resourceGrants: { chipIds: ['RISC-V'] },
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const editList = window.document.getElementById('selected-user-access-editor')!;
    const adminOnly = [...editList.querySelectorAll('input[type="checkbox"]')].find(
      (input) => (input as HTMLInputElement).value === 'ADMIN-ONLY'
    ) as HTMLInputElement;
    adminOnly.checked = true;
    adminOnly.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const userSave = calls.find((call) => call.path === '/admin/users/user-1' && call.options?.method === 'PUT');
    expect(JSON.parse(userSave!.options.body).modelGrants).toContain('sonnet');
    expect(JSON.parse(userSave!.options.body).resourceGrants.chipIds).toEqual(expect.arrayContaining(['RISC-V', 'ADMIN-ONLY']));
    expect(calls.find((call) => call.path === '/admin/chip-access')).toBeUndefined();
  });

  it('omits chipIds when saving non-chip access without an explicit chip override', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          modelGrants: [],
          resourceGrants: {},
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const modelInput = window.document.querySelector(
      '#user-tabpanel-access [data-access-dimension="modelGrants"] .admin-token-input'
    ) as HTMLInputElement;
    modelInput.value = 'sonnet';
    modelInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const userSave = calls.find((call) => call.path === '/admin/users/user-1' && call.options?.method === 'PUT');
    const payload = JSON.parse(userSave!.options.body);
    expect(payload.modelGrants).toEqual(['sonnet']);
    expect(payload).not.toHaveProperty('resourceGrants');
    expect(calls.find((call) => call.path === '/admin/chip-access')).toBeUndefined();
  });

  it('preserves an existing explicit chip override when saving only model access', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          modelGrants: [],
          resourceGrants: { chipIds: ['RISC-V'] },
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const modelInput = window.document.querySelector(
      '#user-tabpanel-access [data-access-dimension="modelGrants"] .admin-token-input'
    ) as HTMLInputElement;
    modelInput.value = 'sonnet';
    modelInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    const userSave = calls.find((call) => call.path === '/admin/users/user-1' && call.options?.method === 'PUT');
    const payload = JSON.parse(userSave!.options.body);
    expect(payload.modelGrants).toEqual(['sonnet']);
    expect(payload.resourceGrants.chipIds).toEqual(['RISC-V']);
    expect(calls.find((call) => call.path === '/admin/chip-access')).toBeUndefined();
    expect(window.document.querySelector('#user-tabpanel-access [data-admin-state="explicit"]')?.textContent).toContain('RISC-V');
  });

  it('does not request the retired /admin/chip-access route during boot or access editing', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          modelGrants: [],
          resourceGrants: { chipIds: ['RISC-V'] },
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const adminOnly = [...window.document.querySelectorAll('#selected-user-access-editor input[type="checkbox"]')].find(
      (input) => (input as HTMLInputElement).value === 'ADMIN-ONLY'
    ) as HTMLInputElement;
    adminOnly.checked = true;
    adminOnly.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.find((call) => call.path === '/admin/chip-access')).toBeUndefined();
  });

  it('refreshes the effective summary after saving access', async () => {
    let effectiveVersion = 0;
    const { window } = await bootAdminPage({
      users: [
        {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          createdAt: '2026-05-07T01:00:00.000Z',
          resourceGrants: { chipIds: [] },
          mcpKeys: []
        }
      ],
      effectiveAuthorization: (user) => ({
        userId: user.id,
        dimensions: {
          brands: [],
          productLines: [],
          chipIds: [{ id: effectiveVersion > 0 ? 'ADMIN-ONLY' : 'E521.39', source: effectiveVersion > 0 ? 'user_override' : 'product_line_derived' }],
          modelIds: [],
          scopePresetIds: [],
          mcpTools: []
        },
        overrides: { systemBChipOverride: false },
        computedAt: '2026-07-04T00:00:00.000Z'
      })
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.document.getElementById('selected-user-access-summary')?.textContent).toContain('E521.39');
    effectiveVersion = 1;
    const adminOnly = [...window.document.querySelectorAll('#selected-user-access-editor input[type="checkbox"]')].find(
      (input) => (input as HTMLInputElement).value === 'ADMIN-ONLY'
    ) as HTMLInputElement;
    adminOnly.checked = true;
    adminOnly.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-access-summary')?.textContent).toContain('ADMIN-ONLY');
    expect(window.document.getElementById('selected-user-access-summary')?.textContent).not.toContain('E521.39');
  });

  it('freezes unified access editing for admin users', async () => {
    const { window, calls } = await bootAdminPage({
      users: [
        {
          id: 'admin-1',
          username: 'root',
          role: 'admin',
          createdAt: '2026-05-07T01:00:00.000Z',
          mcpKeys: []
        }
      ]
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-access-editor')?.textContent).toContain('admin 角色已获得全部访问权限');
    expect((window.document.getElementById('selected-user-access-save') as HTMLButtonElement).disabled).toBe(true);
    expect([...window.document.querySelectorAll('#user-tabpanel-access input, #user-tabpanel-access button')]
      .filter((element) => element.id !== 'user-tab-access')
      .every((element) => (element as HTMLInputElement | HTMLButtonElement).disabled || element.id === 'selected-user-access-save')).toBe(true);

    (window.document.getElementById('selected-user-access-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(calls.find((call) => call.path === '/admin/chip-access')).toBeUndefined();
  });

  it('keeps dirty access state visible when the unified access save fails', async () => {
    const dom = new JSDOM(readPublicFile('admin.html'), {
      url: 'http://127.0.0.1:3000/admin/sections/users',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const calls: Array<{ path: string; options?: any }> = [];
    const users = [{
      id: 'user-1',
      username: 'alice',
      role: 'customer',
      createdAt: '2026-05-07T01:00:00.000Z',
      resourceGrants: { chipIds: [] },
      mcpKeys: []
    }];
    window.navigator.clipboard = { writeText: vi.fn() };
    window.AgentXUI = { toast: vi.fn(), confirm: vi.fn(async () => true), prompt: vi.fn(async () => null), chipInput: vi.fn(() => ({ sync: vi.fn() })) };
    window.AgentXAuth = {
      getUser: () => ({ username: 'root', role: 'admin' }),
      logout: () => undefined,
      clearToken: () => undefined,
      authFetch: async (path: string, requestOptions?: any) => {
        calls.push({ path, options: requestOptions });
        if (path === '/admin/chips') return okJson({ chips: [{ id: 'ADMIN-ONLY', label: 'Admin Only' }], knowledgeBaseRoot: '' });
        if (path === '/admin/users') return okJson({ users });
        if (path === '/admin/prompts') return okJson({ files: [] });
        if (path === '/admin/roles') return okJson({ roles: { customer: { description: 'Customer', permissions: [], access: { allowedChips: [], injectionPolicy: 'first_turn' } } }, _permissions: {} });
        if (path === '/admin/users/user-1/effective-authorization') return okJson({
          userId: 'user-1',
          dimensions: { brands: [], productLines: [], chipIds: [], modelIds: [], scopePresetIds: [], mcpTools: [] },
          overrides: { systemBChipOverride: false },
          computedAt: '2026-07-04T00:00:00.000Z'
        });
        if (path === '/admin/users/user-1' && requestOptions?.method === 'PUT') {
          return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
        }
        throw new Error(`Unexpected admin fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('admin.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    await flushBrowserTasks();
    (window.document.querySelector('#user-list tr.user-row') as HTMLTableRowElement | null)?.click();
    await flushBrowserTasks();
    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const adminOnly = window.document.querySelector('#selected-user-access-editor input[value="ADMIN-ONLY"]') as HTMLInputElement;
    adminOnly.checked = true;
    adminOnly.dispatchEvent(new window.Event('change', { bubbles: true }));
    window.document.getElementById('selected-user-access-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-access-dirty')?.hidden).toBe(false);
    expect(window.document.getElementById('selected-user-access-error')?.textContent).toContain('boom');
    expect(window.document.getElementById('selected-user-access-error')?.textContent).not.toContain('部分保存');
    expect(calls.filter((call) => call.path === '/admin/users')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/admin/chip-access')).toHaveLength(0);
  });

  it('uses the shared access renderer for role template grants', async () => {
    const { window } = await bootAdminPage();
    await openFirstUserDetail(window);

    (window.document.querySelector('#role-list .role-edit-btn') as HTMLButtonElement).click();

    const roleEditor = window.document.getElementById('role-editor-form')!;
    const userDimensions = [...window.document.querySelectorAll('#user-tabpanel-access .admin-token-picker')]
      .map((node) => (node as HTMLElement).dataset.accessDimension)
      .sort();
    const roleDimensions = [...roleEditor.querySelectorAll('.admin-token-picker')]
      .map((node) => (node as HTMLElement).dataset.accessDimension)
      .sort();
    expect(roleDimensions).toEqual(userDimensions);
    expect(roleEditor.querySelector('.admin-access-editor-hint')?.textContent).toContain(
      '品牌/产品线授权会自动展开为芯片授权'
    );
    expect(roleEditor.querySelector('.admin-check-list')).toBeTruthy();
    expect(window.document.getElementById('role-brand-grants')).toBeNull();
    expect(window.document.getElementById('role-productline-grants')).toBeNull();
  });

  it('keeps role non-chip grant tokens editable when chip mode is all or none', async () => {
    const { window } = await bootAdminPage();

    (window.document.querySelector('#role-list .role-edit-btn') as HTMLButtonElement).click();
    const noneMode = window.document.querySelector('input[name="role-chip-access-mode"][value="none"]') as HTMLInputElement;
    noneMode.checked = true;
    noneMode.dispatchEvent(new window.Event('change', { bubbles: true }));

    const modelInput = window.document.querySelector(
      '#role-editor-form [data-access-dimension="modelGrants"] .admin-token-input'
    ) as HTMLInputElement;
    const chipCheckbox = window.document.querySelector(
      '#role-editor-form .admin-check-list input[type="checkbox"]'
    ) as HTMLInputElement;
    expect(modelInput.disabled).toBe(false);
    expect(chipCheckbox.disabled).toBe(true);
  });

  it('invalidates selected effective authorization after saving a role template', async () => {
    let roleVersion = 0;
    const { window } = await bootAdminPage({
      effectiveAuthorization: (user) => ({
        userId: user.id,
        dimensions: {
          brands: [],
          productLines: [],
          chipIds: [],
          modelIds: [{ id: roleVersion > 0 ? 'sonnet' : 'haiku', source: 'role_default' }],
          scopePresetIds: [],
          mcpTools: []
        },
        overrides: { systemBChipOverride: false },
        computedAt: '2026-07-04T00:00:00.000Z'
      })
    });
    await openFirstUserDetail(window);

    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.document.getElementById('selected-user-access-summary')?.textContent).toContain('haiku');

    roleVersion = 1;
    (window.document.querySelector('#role-list .role-edit-btn') as HTMLButtonElement).click();
    window.document.getElementById('role-save')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-access-summary')?.textContent).toContain('sonnet');
  });

  it('does not let a stale effective-authorization error overwrite the newly selected user', async () => {
    const dom = new JSDOM(readPublicFile('admin.html'), {
      url: 'http://127.0.0.1:3000/admin/sections/users',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    const delayed = deferred<Response>();
    const users = [
      { id: 'user-1', username: 'alice', role: 'customer', createdAt: '2026-05-07T01:00:00.000Z', mcpKeys: [] },
      { id: 'user-2', username: 'bob', role: 'customer', createdAt: '2026-05-07T01:00:00.000Z', mcpKeys: [] }
    ];
    window.navigator.clipboard = { writeText: vi.fn() };
    window.AgentXUI = { toast: vi.fn(), confirm: vi.fn(async () => true), prompt: vi.fn(async () => null), chipInput: vi.fn(() => ({ sync: vi.fn() })) };
    window.AgentXAuth = {
      getUser: () => ({ username: 'root', role: 'admin' }),
      logout: () => undefined,
      login: async () => ({ user: { username: 'root', role: 'admin' } }),
      clearToken: () => undefined,
      authFetch: async (path: string) => {
        if (path === '/admin/chips') return okJson({ chips: [], knowledgeBaseRoot: '' });
        if (path === '/admin/users') return okJson({ users });
        if (path === '/admin/prompts') return okJson({ files: [] });
        if (path === '/admin/roles') return okJson({ roles: { customer: { description: 'Customer', permissions: [], access: { allowedChips: [], injectionPolicy: 'first_turn' } } }, _permissions: {} });
        if (path === '/admin/users/user-1/effective-authorization') return delayed.promise;
        if (path === '/admin/users/user-2/effective-authorization') return okJson({
          userId: 'user-2',
          dimensions: { brands: [], productLines: [], chipIds: [], modelIds: [{ id: 'haiku', source: 'role_default' }], scopePresetIds: [], mcpTools: [] },
          overrides: { systemBChipOverride: false },
          computedAt: '2026-07-04T00:00:00.000Z'
        });
        throw new Error(`Unexpected admin fetch: ${path}`);
      }
    };

    window.eval(readPublicFile('admin.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();
    (window.document.querySelector('#user-list tr.user-row') as HTMLTableRowElement | null)?.click();
    await flushBrowserTasks();
    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    [...window.document.querySelectorAll('#user-list tr.user-row')]
      .find((row) => row.textContent?.includes('bob'))
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    (window.document.getElementById('user-tab-access') as HTMLButtonElement).click();
    await flushBrowserTasks();
    delayed.resolve({
      ok: false,
      status: 500,
      json: async () => ({ error: 'old alice failed' })
    } as Response);
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('selected-user-title')?.textContent).toContain('bob');
    expect(window.document.getElementById('selected-user-access-summary')?.textContent).toContain('haiku');
    expect(window.document.getElementById('selected-user-access-error')?.textContent).not.toContain('old alice failed');
  });

  it('resets passwords and deletes selected users from the detail panel', async () => {
    const { window, calls } = await bootAdminPage();
    await openFirstUserDetail(window);
    // 删除改为 AgentXUI 应用内确认弹窗，桩默认放行
    const confirmSpy = window.AgentXUI.confirm as ReturnType<typeof vi.fn>;

    (window.document.getElementById('selected-user-password') as HTMLInputElement).value = 'new-secret';
    window.document
      .getElementById('selected-user-password-form')
      ?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();

    const passwordCall = calls.find((call) => call.path === '/admin/users/user-1/password');
    expect(passwordCall?.options.method).toBe('PUT');
    expect(JSON.parse(passwordCall?.options.body)).toEqual({ password: 'new-secret' });

    (window.document.getElementById('selected-user-delete') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(confirmSpy).toHaveBeenCalled();
    expect(calls.find((call) => call.path === '/admin/users/user-1' && call.options?.method === 'DELETE')).toBeTruthy();
    expect(window.document.getElementById('user-list')?.textContent).toContain('暂无用户');
  });
});
