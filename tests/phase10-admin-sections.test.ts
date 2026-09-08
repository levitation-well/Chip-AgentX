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
    // 贴近真实 fetch Response：admin.js 读 response.headers.get('etag') 做并发守卫（B11 Task 2.4）。
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) }
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface AdminHarnessOptions {
  url?: string;
  users?: any[];
  roles?: Record<string, any>;
  permissions?: Record<string, any>;
  promptFiles?: any[];
  promptBodies?: Record<string, string>;
  promptListStatus?: number;
  promptReadStatus?: number;
  chips?: any[];
  resourceDocuments?: any[];
  resourceScopePresets?: any[];
  chipSaveStatus?: number;
  chipLoadReject?: boolean;
  ticketItems?: any[];
  ticketDetails?: Record<string, any>;
}

async function bootAdminPage(options: AdminHarnessOptions = {}) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: options.url ?? 'http://127.0.0.1:3000/admin/sections/roles',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];
  const roles = options.roles ?? {
    customer: {
      description: 'Customer role',
      permissions: [],
      access: { allowedChips: [], injectionPolicy: 'first_turn' }
    },
    admin: {
      description: 'Admin role',
      permissions: ['admin.users', 'admin.roles'],
      access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
    }
  };
  const permissions = options.permissions ?? {
    'chat.send': { label: 'Send chat', description: 'Can send chat messages' },
    'admin.users': { label: 'Manage users', description: 'Can manage users' },
    'admin.roles': { label: 'Manage roles', description: 'Can manage roles' }
  };
  const promptFiles = options.promptFiles ?? [
    { type: 'global', name: 'global.md', path: 'global.md', exists: true },
    { type: 'role', name: 'customer.md', path: 'role/customer.md', exists: true },
    { type: 'chip', name: 'E521.39.md', path: 'chips/E521.39.md', exists: true }
  ];
  const promptBodies = options.promptBodies ?? {
    'global.md': 'Global prompt',
    'role/customer.md': 'Customer prompt',
    'chips/E521.39.md': 'Chip prompt'
  };
  let chips = options.chips ?? [
    { id: 'E521.39', label: 'E521.39 Chip', workspaceDir: 'D:\\kb\\E521.39' },
    { id: 'RISC-V', label: 'RISC-V Core', workspaceDir: 'D:\\kb\\riscv' }
  ];
  const resourceDocuments = options.resourceDocuments ?? [];
  const resourceScopePresets = options.resourceScopePresets ?? [];
  let users = options.users ?? [{ id: 'user-1', username: 'alice', role: 'customer', mcpKeys: [] }];
  const ticketItems = options.ticketItems ?? [];
  const ticketDetails = options.ticketDetails ?? {};

  window.confirm = vi.fn(() => true);
  // ui-kit 在该功能测试中不加载，提供最小 AgentXUI 桩：应用内确认弹窗默认放行、toast 静默。
  // B4：芯片删除 / 资源删除已从原生 confirm() 迁移到 window.AgentXUI.confirm({danger:true})。
  window.AgentXUI = {
    toast: vi.fn(),
    confirm: vi.fn(async () => true)
  };
  window.AgentXAuth = {
    getUser: () => ({ username: 'root', role: 'admin' }),
    logout: () => undefined,
    login: async () => ({ user: { username: 'root', role: 'admin' } }),
    clearToken: () => undefined,
    authFetch: async (path: string, requestOptions?: any) => {
      calls.push({ path, options: requestOptions });

      if (path === '/admin/chips' && requestOptions?.method === 'PUT') {
        if (options.chipSaveStatus) return jsonResponse({ error: 'chip save failed' }, options.chipSaveStatus);
        const body = JSON.parse(requestOptions.body);
        chips = body.chips;
        return jsonResponse({
          chips,
          knowledgeBaseRoot: body.knowledgeBaseRoot || '',
          message: 'Saved. Restart the service for changes to take effect.'
        });
      }
      if (path === '/admin/chips') {
        if (options.chipLoadReject) throw new Error('chip catalog unavailable');
        return jsonResponse({ chips, knowledgeBaseRoot: '' });
      }
      const effectiveAuthPath = /^\/admin\/users\/([^/]+)\/effective-authorization$/.exec(path);
      if (effectiveAuthPath) {
        return jsonResponse({ dimensions: { chipIds: [], modelIds: [], scopePresetIds: [], mcpToolIds: [] } });
      }
      if (path === '/admin/users') return jsonResponse({ users });
      if (path === '/admin/resources') {
        return jsonResponse({ documents: resourceDocuments, scopePresets: resourceScopePresets });
      }
      if (path === '/admin/prompts') {
        if (options.promptListStatus) return jsonResponse({ error: 'prompts failed' }, options.promptListStatus);
        return jsonResponse({ files: promptFiles });
      }
      if (path.startsWith('/admin/prompts/') && path.endsWith('/history')) {
        const promptPath = decodeURIComponent(path.slice('/admin/prompts/'.length, -'/history'.length));
        return jsonResponse({
          entries: promptBodies[promptPath]
            ? [{ relativePath: promptPath, hash: 'abc123', createdAt: '2026-05-29T00:00:00.000Z', userId: 'admin', username: 'admin', role: 'admin', content: promptBodies[promptPath] }]
            : []
        });
      }
      if (path.startsWith('/admin/prompts/') && path.endsWith('/rollback')) {
        const promptPath = decodeURIComponent(path.slice('/admin/prompts/'.length, -'/rollback'.length));
        promptBodies[promptPath] = 'Rolled back prompt';
        return jsonResponse({ rolledBack: true, content: promptBodies[promptPath] });
      }
      if (path.startsWith('/admin/prompts/')) {
        const promptPath = decodeURIComponent(path.slice('/admin/prompts/'.length));
        if (requestOptions?.method === 'PUT') {
          promptBodies[promptPath] = JSON.parse(requestOptions.body).content;
          return jsonResponse({ path: promptPath, content: promptBodies[promptPath] });
        }
        if (options.promptReadStatus) return jsonResponse({ error: 'read failed' }, options.promptReadStatus);
        const promptFile = promptFiles.find((file) => file.path === promptPath);
        const missing = promptFile?.exists === false || (promptPath.startsWith('chips/') && !promptBodies[promptPath]);
        return jsonResponse({ path: promptPath, content: promptBodies[promptPath] || 'Default chip prompt', missing });
      }
      if (path === '/admin/roles' && requestOptions?.method === 'POST') {
        const body = JSON.parse(requestOptions.body);
        roles[body.name] = { description: body.description, permissions: body.permissions, access: body.access };
        return jsonResponse({ role: roles[body.name] }, 201);
      }
      const rolePath = /^\/admin\/roles\/([^/]+)$/.exec(path);
      if (rolePath && requestOptions?.method === 'PUT') {
        const name = decodeURIComponent(rolePath[1]!);
        const body = JSON.parse(requestOptions.body);
        roles[name] = { description: body.description, permissions: body.permissions, access: body.access };
        return jsonResponse({ role: roles[name] });
      }
      if (rolePath && requestOptions?.method === 'DELETE') {
        delete roles[decodeURIComponent(rolePath[1]!)];
        return jsonResponse({ ok: true });
      }
      if (path === '/admin/roles') return jsonResponse({ roles, _permissions: permissions });
      if (path.startsWith('/admin/tickets?')) {
        return jsonResponse({ items: ticketItems });
      }
      const accountApprovePath = /^\/admin\/tickets\/([^/]+)\/account-application\/approve$/.exec(path);
      if (accountApprovePath && requestOptions?.method === 'POST') {
        const ticketNo = decodeURIComponent(accountApprovePath[1]!);
        const detail = ticketDetails[ticketNo];
        const payload = detail?.payload || {};
        const user = {
          id: payload.userId || 'approved-user-id',
          username: payload.username || 'approved.customer',
          role: payload.role || payload.requestedRole || 'customer',
          status: 'active',
          profile: {
            email: payload.email || '',
            company: payload.company || '',
            realName: payload.realName || ''
          },
          mcpKeys: []
        };
        users = [...users.filter((candidate) => candidate.id !== user.id), user];
        if (detail) detail.status = 'approved';
        return jsonResponse({ ticket: detail, user });
      }
      const ticketMessagePath = /^\/admin\/tickets\/([^/]+)\/messages$/.exec(path);
      if (ticketMessagePath && requestOptions?.method === 'POST') {
        const ticketNo = decodeURIComponent(ticketMessagePath[1]!);
        const detail = ticketDetails[ticketNo];
        const body = JSON.parse(requestOptions.body);
        const message = {
          authorLabel: 'root',
          authorRole: 'admin',
          audience: body.audience,
          text: body.text,
          createdAt: '2026-07-04T00:00:00.000Z'
        };
        if (detail) detail.messages = [...(detail.messages || []), message];
        return jsonResponse({ ticket: detail, message });
      }
      const ticketPath = /^\/admin\/tickets\/([^/]+)$/.exec(path);
      if (ticketPath && requestOptions?.method === 'PATCH') {
        const ticketNo = decodeURIComponent(ticketPath[1]!);
        const detail = ticketDetails[ticketNo];
        Object.assign(detail, JSON.parse(requestOptions.body));
        return jsonResponse({ ticket: detail });
      }
      if (ticketPath) {
        const ticketNo = decodeURIComponent(ticketPath[1]!);
        return jsonResponse({ ticket: ticketDetails[ticketNo] });
      }
      if (path.startsWith('/admin/observability')) {
        if (path.includes('range=invalid')) {
          return jsonResponse({ error: 'Invalid observability range' }, 400);
        }
        return jsonResponse({
          summary: { calls: 3, creditsUnits: 150, estimatedTokens: 1200, averageLatencyMs: 250, failureRate: 0.25 },
          breakdown: {
            byEntry: { web: { calls: 2, creditsUnits: 100, estimatedTokens: 800, failures: 0, averageLatencyMs: 200 } },
            byModel: { 'haiku': { calls: 3, creditsUnits: 150, estimatedTokens: 1200, failures: 1, averageLatencyMs: 250 } },
            byUser: { alice: { calls: 3, creditsUnits: 150, estimatedTokens: 1200, failures: 1, averageLatencyMs: 250 } },
            byMcpKey: { fp_123: { calls: 1, creditsUnits: 50, estimatedTokens: 0, failures: 0, averageLatencyMs: 0 } },
            byFailureReason: {}
          },
          anomalies: [
            { type: 'high_failure_rate', key: 'alice', value: 0.5 },
            { type: 'high_credits', key: 'sonnet', value: 900 },
            { type: 'large_output', key: 'session-1', value: 200000 }
          ]
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

describe('phase 10 admin roles prompts and chips sections', () => {
  it('maps legacy admin sections into FE2 navigation groups without changing section ids', () => {
    const dom = new JSDOM(readPublicFile('admin.html'));
    const document = dom.window.document;
    const groupSections = (group: string) => [...document.querySelectorAll(`[data-nav-group="${group}"] [data-section]`)]
      .map((link) => link.getAttribute('data-section'));

    expect(groupSections('user-access')).toEqual(['users', 'roles']);
    expect(groupSections('knowledge')).toEqual(['chips', 'resources', 'prompts']);
    expect(groupSections('operations')).toEqual(['sessions', 'observability']);
    expect(groupSections('content-support')).toEqual(['announcements', 'feedback']);
    expect(groupSections('system-settings')).toEqual(['model-routing', 'discovery-traces']);
    expect(document.getElementById('section-credits')).toBeNull();
    expect(document.getElementById('section-questions')).toBeNull();
    expect(document.getElementById('user-tab-credits')).not.toBeNull();
    expect(document.getElementById('selected-user-credit-balance')).not.toBeNull();
    expect(document.getElementById('selected-user-credit-form')).not.toBeNull();
    expect(document.getElementById('selected-user-credit-ledger')).not.toBeNull();
    expect(document.getElementById('history-tab-questions')).not.toBeNull();
  });

  it('renders role list with template chip summaries', async () => {
    const { window } = await bootAdminPage();

    const roleList = window.document.getElementById('role-list')!;
    expect(roleList.textContent).toContain('admin');
    expect(roleList.textContent).toContain('全部芯片');
  });

  it('renders role permission matrix from _permissions', async () => {
    const { window } = await bootAdminPage();

    (window.document.querySelector('.role-edit-btn') as HTMLButtonElement).click();

    const permissionList = window.document.getElementById('role-permission-list')!;
    expect(permissionList.textContent).toContain('Send chat');
    expect(permissionList.textContent).toContain('Can send chat messages');
    expect(permissionList.querySelector('input[value="chat.send"]')).toBeTruthy();
    const option = permissionList.querySelector('.permission-option') as HTMLLabelElement;
    expect(option.querySelector('input[type="checkbox"]')).toBeTruthy();
    expect(option.querySelector('span')?.textContent).toContain('Send chat');
  });

  it('keeps role editor actions wired after list re-render and freezes admin access editing', async () => {
    const { window } = await bootAdminPage();

    const adminRow = [...window.document.querySelectorAll('.role-row')].find((row) =>
      row.textContent?.includes('admin')
    ) as HTMLElement;
    expect(adminRow.querySelector('.role-delete-btn')).toHaveProperty('disabled', true);
    (adminRow.querySelector('.role-edit-btn') as HTMLButtonElement).click();

    const selectedRow = window.document.querySelector('.role-row.selected') as HTMLElement;
    expect(selectedRow?.textContent).toContain('admin');
    const accessEditor = window.document.getElementById('role-access-editor')!;
    expect(accessEditor.textContent).toContain('admin 模板固定拥有全部访问权限');
    expect(accessEditor.querySelector('input')).toBeNull();

    (window.document.getElementById('role-cancel') as HTMLButtonElement).click();
    expect((window.document.getElementById('role-editor-form') as HTMLElement).hidden).toBe(true);
    expect(window.document.querySelector('.role-row.selected')).toBeNull();

    (window.document.getElementById('role-add') as HTMLButtonElement).click();
    expect((window.document.getElementById('role-editor-form') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('role-name') as HTMLInputElement).disabled).toBe(false);
  });

  it('creates a role through /admin/roles', async () => {
    const { window, calls } = await bootAdminPage();

    (window.document.getElementById('role-add') as HTMLButtonElement).click();
    (window.document.getElementById('role-name') as HTMLInputElement).value = 'operator';
    (window.document.getElementById('role-description') as HTMLInputElement).value = 'Operator';
    const selectedMode = window.document.querySelector(
      'input[name="role-chip-access-mode"][value="selected"]'
    ) as HTMLInputElement;
    selectedMode.checked = true;
    selectedMode.dispatchEvent(new window.Event('change', { bubbles: true }));
    const chipCheckbox = window.document.querySelector('#role-access-editor input[value="E521.39"]') as HTMLInputElement;
    chipCheckbox.checked = true;
    chipCheckbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    (window.document.getElementById('role-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    const createCall = calls.find((call) => call.path === '/admin/roles' && call.options?.method === 'POST');
    expect(JSON.parse(createCall?.options.body)).toEqual({
      name: 'operator',
      description: 'Operator',
      permissions: [],
      access: {
        allowedChips: ['E521.39'],
        injectionPolicy: 'first_turn',
        grants: {
          brands: [],
          productLines: [],
          chipIds: ['E521.39'],
          documentIds: [],
          scopePresetIds: [],
          modelIds: [],
          mcpTools: []
        }
      }
    });
    expect(window.document.getElementById('role-success')?.textContent).toContain('角色已创建');
  });

  it('updates an existing role through /admin/roles/:name', async () => {
    const { window, calls } = await bootAdminPage();

    const adminRow = [...window.document.querySelectorAll('.role-row')].find((row) =>
      row.textContent?.includes('admin')
    ) as HTMLElement;
    (adminRow.querySelector('.role-edit-btn') as HTMLButtonElement).click();
    (window.document.getElementById('role-description') as HTMLInputElement).value = 'Admin updated';
    (window.document.getElementById('role-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    const updateCall = calls.find((call) => call.path === '/admin/roles/admin' && call.options?.method === 'PUT');
    expect(JSON.parse(updateCall?.options.body)).toMatchObject({
      name: 'admin',
      description: 'Admin updated'
    });
  });

  it('deletes a role through /admin/roles/:name after confirmation', async () => {
    const { window, calls } = await bootAdminPage();
    // C8：角色删除已从原生 confirm() 迁移到 window.AgentXUI.confirm({danger:true}) 应用内确认弹窗。
    const confirmSpy = window.AgentXUI.confirm as ReturnType<typeof vi.fn>;

    const customerRow = [...window.document.querySelectorAll('.role-row')].find((row) =>
      row.textContent?.includes('customer')
    ) as HTMLElement;
    (customerRow.querySelector('.role-delete-btn') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: '确认删除角色「customer」？',
      danger: true
    }));
    expect(calls.find((call) => call.path === '/admin/roles/customer' && call.options?.method === 'DELETE')).toBeTruthy();
    expect(window.document.getElementById('role-list')?.textContent).not.toContain('customer');
  });

  it('renders ticket inbox cards and keeps detail actions wired after selecting a datasheet ticket', async () => {
    const ticket = {
      ticketNo: 'DS-2026-0012',
      type: 'datasheet_submission',
      status: 'received',
      title: 'E521.31-ds-rev4 补充修订版',
      createdAt: '2026-07-01T08:38:00.000Z',
      updatedAt: '2026-07-01T16:38:00.000Z',
      needsMoreInfo: false,
      publicNote: '已接收资料',
      internalNote: '优先检查 revision 表',
      result: '',
      contact: { raw: 'fae@elmos.example' },
      payload: {
        vendor: 'Elmos Semiconductor',
        partNumberOrKeywords: 'E521.31',
        sourceNote: 'Rev4 datasheet',
        uploadReview: {
          state: 'received',
          searchable: false,
          securityScan: { status: 'clean', summary: 'clean', attachments: [] }
        }
      },
      attachments: [
        { id: 'att-1', originalName: 'E521.31.pdf', sizeBytes: 2048, mimeType: 'application/pdf', status: 'stored' }
      ],
      messages: [
        { authorLabel: 'partner', authorRole: 'user', audience: 'user', createdAt: '2026-07-01T16:38:00.000Z', text: '请协助入库。' }
      ]
    };
    const { window, calls } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/feedback',
      ticketItems: [{
        ticketNo: ticket.ticketNo,
        type: ticket.type,
        status: ticket.status,
        title: ticket.title,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        needsMoreInfo: ticket.needsMoreInfo
      }],
      ticketDetails: { [ticket.ticketNo]: ticket }
    });

    await flushBrowserTasks();
    const card = window.document.querySelector('#ticket-admin-list .ticket-admin-card') as HTMLButtonElement;
    expect(card).toBeTruthy();
    expect(card.className).toContain('feedback-row');
    card.click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.some((call) => call.path === '/admin/tickets/DS-2026-0012')).toBe(true);
    const selectedCard = window.document.querySelector('#ticket-admin-list .ticket-admin-card') as HTMLButtonElement;
    expect(selectedCard.className).toContain('active');
    expect(selectedCard.className).toContain('selected');
    expect(window.document.querySelector('.ticket-admin-detail-workbench')).toBeTruthy();
    expect(window.document.querySelector('.ticket-admin-conversation')).toBeTruthy();
    expect(window.document.querySelector('.ticket-admin-sidecar')).toBeTruthy();
    expect(window.document.getElementById('ticket-admin-reply-form')).toBeTruthy();
    expect(window.document.getElementById('ticket-admin-review-form')).toBeTruthy();
    expect(window.document.getElementById('ticket-admin-download-all')).toBeTruthy();
    expect(window.document.getElementById('ticket-admin-application-actions')).toBeTruthy();
    expect([...window.document.querySelectorAll('#ticket-admin-status option')].map((option) => option.getAttribute('value'))).toEqual(['received', 'archived']);

    (window.document.getElementById('ticket-admin-reply-text') as HTMLTextAreaElement).value = '已收到，继续处理。';
    (window.document.getElementById('ticket-admin-reply-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/tickets/DS-2026-0012/messages' && call.options?.method === 'POST')).toBe(true);

    (window.document.getElementById('ticket-admin-public-note') as HTMLTextAreaElement).value = '公开备注更新';
    (window.document.getElementById('ticket-admin-review-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/tickets/DS-2026-0012' && call.options?.method === 'PATCH')).toBe(true);
  });

  it('approves account applications and jumps to the created user detail', async () => {
    const ticket = {
      ticketNo: 'APP-2026-0007',
      type: 'account_application',
      status: 'pending',
      title: '申请开通客户账号',
      createdAt: '2026-07-02T08:38:00.000Z',
      updatedAt: '2026-07-02T08:38:00.000Z',
      needsMoreInfo: false,
      publicNote: '',
      internalNote: '',
      result: '',
      contact: { email: 'approved@example.com' },
      payload: {
        userId: 'approved-user-id',
        username: 'approved.customer',
        role: 'customer',
        email: 'approved@example.com',
        company: 'Elmos Partner'
      },
      attachments: [],
      messages: []
    };
    const { window, calls } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/feedback',
      ticketItems: [{
        ticketNo: ticket.ticketNo,
        type: ticket.type,
        status: ticket.status,
        title: ticket.title,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        needsMoreInfo: ticket.needsMoreInfo
      }],
      ticketDetails: { [ticket.ticketNo]: ticket }
    });

    await flushBrowserTasks();
    (window.document.querySelector('#ticket-admin-list .ticket-admin-card') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    const approve = window.document.querySelector('#ticket-admin-application-actions .primary-button') as HTMLButtonElement;
    expect(approve.textContent).toBe('批准并创建用户');
    approve.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.some((call) => call.path === '/admin/tickets/APP-2026-0007/account-application/approve' && call.options?.method === 'POST')).toBe(true);
    expect(window.location.pathname).toBe('/admin/sections/users');
    expect((window.document.getElementById('panel-users') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('selected-user-title')?.textContent).toBe('用户详情：approved.customer');
    expect(window.document.querySelector('.user-compact-item.selected')?.textContent).toContain('approved.customer');
  });

  it('renders prompt management by chip with built and missing badges', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });

    const cards = [...window.document.querySelectorAll('.prompt-chip-card')] as HTMLElement[];
    expect(cards).toHaveLength(2);
    expect(cards[0]?.textContent).toContain('E521.39');
    expect(cards[0]?.textContent).toContain('已建');
    expect(cards[1]?.textContent).toContain('RISC-V');
    expect(cards[1]?.textContent).toContain('未建');
    expect(window.document.getElementById('prompt-chip-count')?.textContent).toBe('1 / 2 已建');
    expect(window.document.querySelector('.prompt-file-btn')).toBeNull();
  });

  it('uses exact chip prompt paths instead of substring matching similar chip ids', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/prompts',
      chips: [
        { id: 'E521.3', label: 'Short id', workspaceDir: 'D:\\kb\\E521.3' },
        { id: 'E521.39', label: 'Long id', workspaceDir: 'D:\\kb\\E521.39' }
      ],
      promptFiles: [
        { type: 'chip', name: 'E521.39.md', path: 'chips/E521.39.md', exists: true }
      ],
      promptBodies: { 'chips/E521.39.md': 'Long chip prompt' }
    });

    const cards = [...window.document.querySelectorAll('.prompt-chip-card')] as HTMLElement[];
    expect(cards[0]?.textContent).toContain('E521.3');
    expect(cards[0]?.textContent).toContain('未建');
    expect(cards[1]?.textContent).toContain('E521.39');
    expect(cards[1]?.textContent).toContain('已建');
    expect(window.document.getElementById('prompt-chip-count')?.textContent).toBe('1 / 2 已建');
  });

  it('shows prompt load failure in the retry panel', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/prompts',
      promptReadStatus: 500
    });

    (window.document.querySelector('.prompt-chip-card') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect((window.document.getElementById('prompt-error-panel') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('prompt-editor-container') as HTMLElement).hidden).toBe(true);
    expect(window.document.getElementById('prompt-error-message')?.textContent).toContain('加载提示词失败 (500)');
  });

  it('shows an empty state with template action for missing chip prompts', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });

    const cards = [...window.document.querySelectorAll('.prompt-chip-card')] as HTMLButtonElement[];
    cards[1]!.click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('prompt-editor-container') as HTMLElement).hidden).toBe(true);
    expect((window.document.getElementById('prompt-placeholder') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('prompt-placeholder')?.textContent).toContain('RISC-V 尚未创建提示词');
    expect((window.document.getElementById('prompt-template-create') as HTMLButtonElement).hidden).toBe(false);

    (window.document.getElementById('prompt-template-create') as HTMLButtonElement).click();
    expect((window.document.getElementById('prompt-editor-container') as HTMLElement).hidden).toBe(false);
    expect((window.document.getElementById('prompt-content') as HTMLTextAreaElement).value).toContain('# RISC-V');
    expect(window.document.getElementById('prompt-editor-status')?.textContent).toContain('草稿');
  });

  it('blocks section navigation when prompt content is dirty', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });
    // C8：放弃未保存草稿确认已从原生 confirm() 迁移到 window.AgentXUI.confirm({danger:true})。
    const confirmSpy = vi.fn(async () => false);
    window.AgentXUI.confirm = confirmSpy;

    (window.document.querySelector('.prompt-chip-card') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const content = window.document.getElementById('prompt-content') as HTMLTextAreaElement;
    content.value = 'Changed prompt';
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.querySelector('[data-section="roles"]') as HTMLAnchorElement).click();
    await flushBrowserTasks();

    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: '当前提示词草稿未保存，确认放弃？',
      danger: true
    }));
    expect(window.location.pathname).toBe('/admin/sections/prompts');
    expect((window.document.getElementById('panel-prompts') as HTMLElement).hidden).toBe(false);
  });

  it('blocks prompt file switching when prompt content is dirty', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });
    // C8：放弃未保存草稿确认已从原生 confirm() 迁移到 window.AgentXUI.confirm({danger:true})。
    const confirmSpy = vi.fn(async () => false);
    window.AgentXUI.confirm = confirmSpy;

    const cards = [...window.document.querySelectorAll('.prompt-chip-card')] as HTMLButtonElement[];
    cards[0]!.click();
    await flushBrowserTasks();
    const content = window.document.getElementById('prompt-content') as HTMLTextAreaElement;
    content.value = 'Changed prompt';
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    cards[1]!.click();
    await flushBrowserTasks();

    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({
      body: '当前提示词草稿未保存，确认放弃？',
      danger: true
    }));
    expect(window.document.getElementById('prompt-file-name')?.textContent).toBe('E521.39 · 提示词正文');
    expect((window.document.getElementById('prompt-content') as HTMLTextAreaElement).value).toBe('Changed prompt');
  });

  it('ignores stale prompt loads after switching chips', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseFirstChip: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/prompts/chips%2FE521.39.md') {
        return new Promise((resolve) => {
          releaseFirstChip = () => resolve(jsonResponse({ path: 'chips/E521.39.md', content: 'STALE CHIP PROMPT', missing: false }));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    const cards = [...window.document.querySelectorAll('.prompt-chip-card')] as HTMLButtonElement[];
    cards[0]!.click();
    await flushBrowserTasks();
    cards[1]!.click();
    await flushBrowserTasks();
    releaseFirstChip?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('prompt-file-name')?.textContent).toBe('RISC-V · 提示词正文');
    expect((window.document.getElementById('prompt-editor-container') as HTMLElement).hidden).toBe(true);
    expect(window.document.getElementById('prompt-placeholder')?.textContent).toContain('RISC-V 尚未创建提示词');
  });

  it('saves prompt content through /admin/prompts/:path', async () => {
    const { window, calls } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });

    (window.document.querySelector('.prompt-chip-card') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const content = window.document.getElementById('prompt-content') as HTMLTextAreaElement;
    content.value = 'Updated chip prompt';
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.getElementById('prompt-save') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const saveCall = calls.find((call) => call.path === '/admin/prompts/chips%2FE521.39.md' && call.options?.method === 'PUT');
    expect(JSON.parse(saveCall?.options.body)).toEqual({ content: 'Updated chip prompt' });
    expect(window.document.getElementById('prompt-editor-status')?.textContent).toBe('已保存');
    expect(window.document.querySelector('.prompt-chip-card.built')?.textContent).toContain('已建');
  });

  it('does not clear dirty prompt state when a stale save resolves after more edits', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/prompts' });
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseSave: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/prompts/chips%2FE521.39.md' && requestOptions?.method === 'PUT') {
        return new Promise((resolve) => {
          releaseSave = () => resolve(jsonResponse({ path: 'chips/E521.39.md', content: JSON.parse(requestOptions.body).content }));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    (window.document.querySelector('.prompt-chip-card') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const content = window.document.getElementById('prompt-content') as HTMLTextAreaElement;
    content.value = 'Save request content';
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.getElementById('prompt-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    content.value = 'New unsaved content';
    content.dispatchEvent(new window.Event('input', { bubbles: true }));
    releaseSave?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(content.value).toBe('New unsaved content');
    expect(window.document.getElementById('prompt-editor-status')?.textContent).toBe('有未保存更改');
  });

  it('loads a selected history entry into draft without posting rollback', async () => {
    const { window, calls } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/prompts',
      promptFiles: [
        { type: 'chip', name: 'E521.39.md', path: 'chips/E521.39.md', exists: true }
      ],
      promptBodies: { 'chips/E521.39.md': 'Current prompt' }
    });
    const originalAuthFetch = window.AgentXAuth.authFetch;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/prompts/chips%2FE521.39.md/history') {
        return jsonResponse({
          entries: [
            { relativePath: 'chips/E521.39.md', hash: 'new-hash', createdAt: '2026-05-30T00:00:00.000Z', userId: 'admin', username: 'admin', role: 'admin', content: 'Newer history' },
            { relativePath: 'chips/E521.39.md', hash: 'old-hash', createdAt: '2026-05-29T00:00:00.000Z', userId: 'admin', username: 'admin', role: 'admin', content: 'Older history draft' }
          ]
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    (window.document.querySelector('.prompt-chip-card') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    const historyButtons = [...window.document.querySelectorAll('.prompt-history-rollback')] as HTMLButtonElement[];
    historyButtons[1]!.click();
    await flushBrowserTasks();

    expect((window.document.getElementById('prompt-content') as HTMLTextAreaElement).value).toBe('Older history draft');
    expect(window.document.getElementById('prompt-editor-status')?.textContent).toContain('保存后生效');
    expect(calls.some((call) => call.path.endsWith('/rollback'))).toBe(false);
  });

  it('jumps from chip catalog prompt badge to the matching chip prompt editor', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

    const promptJump = window.document.querySelector('.chip-prompt-jump') as HTMLButtonElement;
    promptJump.click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/prompts');
    expect((window.document.getElementById('panel-prompts') as HTMLElement).hidden).toBe(false);
    expect(window.document.querySelector('.prompt-chip-card.active')?.textContent).toContain('E521.39');
    expect(window.document.getElementById('prompt-file-name')?.textContent).toBe('E521.39 · 提示词正文');
  });

  it('renders chip document links as read-only jumps into the resources document editor', async () => {
    const { window, calls } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/chips',
      chips: [
        { id: 'E521.39', label: 'E521.39 Chip', workspaceDir: 'D:\\kb\\E521.39', documentIds: ['doc-e521'] }
      ],
      resourceDocuments: [
        {
          documentId: 'doc-e521',
          label: 'E521.39 datasheet',
          visibility: 'restricted',
          status: 'approved',
          chipIds: ['E521.39'],
          requiredGrants: {}
        }
      ]
    });

    (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
    const documentList = window.document.getElementById('chip-editor-document-ids') as HTMLElement;
    expect(documentList.className).toContain('chip-document-list');
    expect(documentList.className).not.toContain('admin-token-picker');
    expect(documentList.dataset.field).toBeUndefined();

    (documentList.querySelector('.chip-document-link') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.some((call) => call.path === '/admin/resources')).toBe(true);
    expect(window.location.pathname).toBe('/admin/sections/resources');
    expect((window.document.getElementById('panel-resources') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('resource-editor-title')?.textContent).toContain('编辑文档');
    expect((window.document.getElementById('resource-editor-id') as HTMLInputElement).value).toBe('doc-e521');
  });

  it('does not let keyboard activation on the prompt badge open the chip editor row action', async () => {
    const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

    const promptJump = window.document.querySelector('.chip-prompt-jump') as HTMLButtonElement;
    promptJump.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(true);
  });

  // B1：芯片编辑器改为真正的右侧滑出抽屉——带遮罩、支持 Escape / 点遮罩 / 关闭按钮三种关闭方式。
  describe('chip editor drawer open/close behavior (B1)', () => {
    it('opening a chip row shows both the drawer and its backdrop', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();

      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(false);
      expect((window.document.getElementById('chip-editor-backdrop') as HTMLElement).hidden).toBe(false);
    });

    it('closes the drawer and backdrop on Escape', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(false);

      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(true);
      expect((window.document.getElementById('chip-editor-backdrop') as HTMLElement).hidden).toBe(true);
    });

    it('closes the drawer and backdrop on backdrop click', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(false);

      (window.document.getElementById('chip-editor-backdrop') as HTMLElement).click();

      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(true);
      expect((window.document.getElementById('chip-editor-backdrop') as HTMLElement).hidden).toBe(true);
    });

    it('closes the drawer via the close button', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
      (window.document.getElementById('chip-editor-close') as HTMLButtonElement).click();

      expect((window.document.getElementById('chip-editor-drawer') as HTMLElement).hidden).toBe(true);
    });
  });

  // B2：抽屉内 tab 结构——基础信息／归组／关联文档／工作区路径／危险操作，点击与键盘方向键均可切换。
  describe('chip editor drawer tabs (B2)', () => {
    it('defaults to the basic-info tab and shows only its panel', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();

      expect((window.document.getElementById('chip-editor-tabpanel-basic') as HTMLElement).hidden).toBe(false);
      expect((window.document.getElementById('chip-editor-tabpanel-group') as HTMLElement).hidden).toBe(true);
      expect(window.document.getElementById('chip-editor-tab-basic')?.getAttribute('aria-selected')).toBe('true');
    });

    it('switches to the group (归组) tab on click, revealing the taxonomy block fields', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
      (window.document.getElementById('chip-editor-tab-group') as HTMLButtonElement).click();

      expect((window.document.getElementById('chip-editor-tabpanel-group') as HTMLElement).hidden).toBe(false);
      expect((window.document.getElementById('chip-editor-tabpanel-basic') as HTMLElement).hidden).toBe(true);
      expect(window.document.getElementById('chip-editor-tab-group')?.getAttribute('aria-selected')).toBe('true');
      expect(window.document.getElementById('chip-editor-tabpanel-group')?.querySelector('.taxonomy-block')).toBeTruthy();
    });

    it('isolates delete to the danger tab, hidden for a brand-new (unsaved) chip', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.getElementById('chip-add') as HTMLButtonElement).click();

      expect((window.document.getElementById('chip-editor-tab-danger') as HTMLElement).hidden).toBe(true);
      expect((window.document.getElementById('chip-editor-delete') as HTMLElement).hidden).toBe(true);
    });

    it('cycles tabs with ArrowRight/ArrowLeft keyboard navigation', async () => {
      const { window } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

      (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
      const basicTab = window.document.getElementById('chip-editor-tab-basic') as HTMLButtonElement;
      basicTab.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

      expect(window.document.getElementById('chip-editor-tab-group')?.getAttribute('aria-selected')).toBe('true');
      expect((window.document.getElementById('chip-editor-tabpanel-group') as HTMLElement).hidden).toBe(false);
    });
  });

  it('blocks deleting a chip referenced by user grants', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/chips',
      users: [{ id: 'user-1', username: 'alice', role: 'customer', resourceGrants: { chipIds: ['E521.39'] }, mcpKeys: [] }]
    });

    (window.document.querySelector('.chip-catalog-row') as HTMLTableRowElement).click();
    (window.document.getElementById('chip-editor-delete') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.document.getElementById('chip-mapping-error')?.textContent).toContain(
      '芯片 E521.39 仍被用户授权引用'
    );
    expect(window.document.querySelectorAll('.chip-catalog-row')).toHaveLength(2);
  });

  it('renders server-verified workspace directory status in the chip catalog', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/chips',
      chips: [
        { id: 'E521.39', label: 'E521.39 Chip', workspaceDir: 'D:\\kb\\E521.39', workspaceExists: true, workspaceStatus: 'exists' },
        { id: 'RISC-V', label: 'RISC-V Core', workspaceDir: 'D:\\kb\\riscv', workspaceExists: false, workspaceStatus: 'missing' }
      ]
    });

    // E5: workspace path column copy matches the prototype ("✓ path exists / ! path missing").
    const rows = [...window.document.querySelectorAll('.chip-catalog-row')] as HTMLTableRowElement[];
    expect(rows[0]!.textContent).toContain('路径已存在');
    expect(rows[1]!.textContent).toContain('路径缺失');
  });

  it('rejects duplicate chip ids before save', async () => {
    const { window, calls } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

    // chipId 创建后只读，故用「新增行 + 填入与既有芯片重复的 id」触发唯一性校验，
    // 而非修改既有行 id（那会先被「创建后不可改名（→409）」拦截）。
    (window.document.getElementById('chip-add') as HTMLButtonElement).click();
    (window.document.getElementById('chip-editor-id') as HTMLInputElement).value = 'E521.39';
    (window.document.getElementById('chip-editor-label') as HTMLInputElement).value = 'Dup';
    (window.document.getElementById('chip-editor-workspace-dir') as HTMLInputElement).value = 'D:\\kb\\dup';
    (window.document.getElementById('chip-editor-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();

    expect(window.document.getElementById('chip-mapping-error')?.textContent).toBe('Chip E521.39 already exists.');
    expect(calls.find((call) => call.path === '/admin/chips' && call.options?.method === 'PUT')).toBeUndefined();
  });

  it('shows restart-required message after saving chips', async () => {
    const { window, calls } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });

    (window.document.getElementById('chip-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.find((call) => call.path === '/admin/chips' && call.options?.method === 'PUT')).toBeTruthy();
    expect((window.document.getElementById('chip-restart-notice') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('chip-restart-notice')?.textContent).toContain('服务重启后');
  });

  it('sends deletedIds when removing a chip from the drawer', async () => {
    const { window, calls } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/chips' });
    const rows = [...window.document.querySelectorAll('.chip-catalog-row')] as HTMLTableRowElement[];

    rows[1]!.click();
    (window.document.getElementById('chip-editor-delete') as HTMLButtonElement).click();
    await flushBrowserTasks();
    (window.document.getElementById('chip-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    const saveCall = calls.find((call) => call.path === '/admin/chips' && call.options?.method === 'PUT');
    expect(JSON.parse(saveCall?.options.body).deletedIds).toEqual(['RISC-V']);
  });

  it('keeps chip save errors inside the chip section', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/chips',
      chipSaveStatus: 500
    });

    (window.document.getElementById('chip-save') as HTMLButtonElement).click();
    await flushBrowserTasks();

    expect(window.document.getElementById('chip-mapping-error')?.textContent).toContain('chip save failed');
    expect(window.document.getElementById('admin-error')?.textContent).toBe('');
    expect(window.document.getElementById('role-error')?.textContent).toBe('');
    expect(window.document.getElementById('prompt-list-error')?.textContent).toBe('');
  });

  it('keeps role prompt and chip errors isolated', async () => {
    const { window } = await bootAdminPage({
      promptListStatus: 500,
      chipSaveStatus: 500
    });

    await flushBrowserTasks();
    expect(window.document.getElementById('prompt-list-error')?.textContent).toContain('加载提示词失败 (500)');

    (window.document.getElementById('role-add') as HTMLButtonElement).click();
    (window.document.getElementById('role-save') as HTMLButtonElement).click();
    expect(window.document.getElementById('role-error')?.textContent).toBe('角色名称不能为空');
    expect(window.document.getElementById('prompt-list-error')?.textContent).toContain('加载提示词失败 (500)');

    (window.document.querySelector('[data-section="chips"]') as HTMLAnchorElement).click();
    (window.document.getElementById('chip-save') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.document.getElementById('chip-mapping-error')?.textContent).toContain('chip save failed');
    expect(window.document.getElementById('admin-error')?.textContent).toBe('');
  });

  it('continues rendering other sections when prompts fail to load', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/roles',
      promptListStatus: 500
    });

    expect(window.document.getElementById('prompt-list-error')?.textContent).toContain('加载提示词失败 (500)');
    expect(window.document.getElementById('role-list')?.textContent).toContain('admin');
    expect(window.document.getElementById('chip-catalog-list')?.textContent).toContain('E521.39');
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(false);
  });

  it('continues rendering other sections when chip catalog throws during load', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/roles',
      chipLoadReject: true
    });

    expect(window.document.getElementById('chip-mapping-error')?.textContent).toContain('chip catalog unavailable');
    expect(window.document.getElementById('role-list')?.textContent).toContain('admin');
    expect(window.document.getElementById('prompt-file-list')?.textContent).toContain('暂无芯片目录');
    expect((window.document.getElementById('admin-operation-surface') as HTMLElement).hidden).toBe(false);
  });

  it('keeps direct section routes and existing admin endpoints intact', async () => {
    for (const path of ['/admin/sections/roles', '/admin/sections/prompts', '/admin/sections/chips', '/admin/sections/observability']) {
      const { window, calls } = await bootAdminPage({ url: `http://127.0.0.1:3000${path}` });
      const activeSection = path.split('/').pop()!;

      expect((window.document.getElementById(`panel-${activeSection}`) as HTMLElement).hidden).toBe(false);
      expect(calls.some((call) => call.path === '/admin/roles')).toBe(true);
      expect(calls.some((call) => call.path === '/admin/prompts')).toBe(true);
      expect(calls.some((call) => call.path === '/admin/chips')).toBe(true);
    }
  });

  it('renders observability metrics without raw prompt/debug text', async () => {
    const { window, calls } = await bootAdminPage({ url: 'http://127.0.0.1:3000/admin/sections/observability' });

    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/observability?range=7d')).toBe(true);
    const panel = window.document.getElementById('panel-observability')!;
    expect(panel.querySelector('#observability-range')).toBeTruthy();
    expect(panel.textContent).toContain('调用量');
    expect(panel.textContent).toContain('积分消耗');
    expect(panel.textContent).toContain('估算 token');
    expect(panel.textContent).toContain('平均耗时');
    expect(panel.textContent).toContain('按入口分布');
    expect(panel.textContent).toContain('按模型分布');
    expect(panel.textContent).toContain('按用户分布');
    expect(panel.textContent).toContain('按 MCP Key 分布');
    expect(panel.textContent).toContain('异常列表');
    expect(panel.textContent).not.toMatch(/Calls|Credits|Est\. tokens|Avg latency|Failure rate/);
    expect(panel.textContent).toContain('高失败率');
    expect(panel.textContent).toContain('高积分消耗');
    expect(panel.textContent).toContain('超大输出');
    expect(panel.textContent).not.toContain('high_failure_rate');
    expect(panel.textContent).not.toContain('high_credits');
    expect(panel.textContent).not.toContain('large_output');
    expect(panel.textContent).toContain('haiku');
    expect(panel.textContent).toContain('fp_123');
    expect(panel.querySelector('.observability-bar-track')).toBeTruthy();
    expect(panel.querySelector('.observability-bar-fill')).toBeTruthy();
    (window.document.getElementById('observability-range') as HTMLSelectElement).value = '24h';
    (window.document.getElementById('observability-range') as HTMLSelectElement).dispatchEvent(
      new window.Event('change', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/observability?range=24h')).toBe(true);
    const range = window.document.getElementById('observability-range') as HTMLSelectElement;
    range.append(new window.Option('Invalid', 'invalid'));
    range.value = 'invalid';
    range.dispatchEvent(new window.Event('change', { bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/observability?range=invalid')).toBe(true);
    expect(panel.textContent).not.toContain('正在加载成本观测指标');
    expect(panel.textContent).not.toContain('system prompt');
    expect(panel.textContent).not.toContain('D:\\');
  });

  it('opens the matching user detail from the observability user distribution', async () => {
    const { window } = await bootAdminPage({
      url: 'http://127.0.0.1:3000/admin/sections/observability',
      users: [
        { id: 'user-1', username: 'alice', role: 'customer', status: 'active', mcpKeys: [] },
        { id: 'user-2', username: 'bob', role: 'partner', status: 'active', mcpKeys: [] }
      ]
    });

    await flushBrowserTasks();
    const userRow = window.document.querySelector('#observability-user .observability-row.is-actionable') as HTMLElement;
    expect(userRow).toBeTruthy();
    expect(userRow.getAttribute('role')).toBe('button');
    userRow.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.location.pathname).toBe('/admin/sections/users');
    expect((window.document.getElementById('panel-users') as HTMLElement).hidden).toBe(false);
    expect(window.document.getElementById('selected-user-title')?.textContent).toBe('用户详情：alice');
    expect((window.document.getElementById('user-search') as HTMLInputElement).value).toBe('');
  });
});
