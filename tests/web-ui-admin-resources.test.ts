/**
 * P5 / B7 资源治理 admin 界面合约测试。
 *
 * 直读 public/admin.html + public/admin.js 真实源码：
 *  - 脚手架：admin.html 含 #panel-resources（Documents | Scope Presets 双 tab）、
 *    文档表（id/label/visibility/status/chipIds/操作列）、preset 表（含 documentIds 列 + 孤儿告警位）、
 *    编辑模态含 visibility（6 级）/ status（5 个前端流转态）选择器 + requiredGrants（7 类）编辑器；
 *    admin.js 的 ADMIN_SECTIONS 含 'resources'，导航链接存在。
 *  - 行为：loadResources 经 authFetch 打 GET /admin/resources，
 *    renderResources 渲染文档行 / preset 行；validatePreset 打 POST .../validate 并展示孤儿告警；
 *    空列表走 renderEmptyState。
 *
 * 任何 fetch 响应 mock 必须带 headers.get 垫片：admin.js 在 chips 路径会读 response.headers.get('etag')，
 * 其它路径必须返回 null 而非抛错（缺失会中断渲染——phase10 曾被此 bug 命中）。
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

interface ResourcesHarnessOptions {
  url?: string;
  chips?: any[];
  documents?: any[];
  scopePresets?: any[];
  validation?: { missingDocumentIds: string[]; missingChipIds: string[]; hasOrphans: boolean };
}

function seedChips() {
  return [
    { id: 'CHIP-SEED', label: 'Seed chip' },
    { id: 'CHIP-ALT', label: 'Alternate chip' }
  ];
}

function seedDocuments() {
  return [
    {
      documentId: 'doc-seed',
      label: 'Seed datasheet',
      visibility: 'restricted',
      status: 'approved',
      brands: ['ELMOS'],
      productLines: ['Lighting'],
      applicationTags: ['Automotive lighting'],
      chipIds: ['CHIP-SEED'],
      requiredGrants: { documentIds: ['doc-seed'] },
      sourceLabels: ['seed'],
      approvedBy: 'root',
      approvedAt: '2026-06-24T09:00:00.000Z'
    }
  ];
}

function seedPresets() {
  return [
    {
      scopePresetId: 'scope-seed',
      label: 'Seed scope',
      visibility: 'restricted',
      status: 'approved',
      brands: ['ELMOS'],
      productLines: ['Lighting'],
      applicationTags: ['Automotive lighting'],
      chipIds: ['CHIP-SEED'],
      documentIds: ['doc-seed'],
      requiredGrants: { scopePresetIds: ['scope-seed'] },
      sourceLabels: ['seed']
    }
  ];
}

async function bootAdminResources(options: ResourcesHarnessOptions = {}) {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: options.url ?? 'http://127.0.0.1:3000/admin/sections/resources',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];

  const documents = options.documents ?? seedDocuments();
  const scopePresets = options.scopePresets ?? seedPresets();
  const chips = options.chips ?? seedChips();
  const validation = options.validation ?? { missingDocumentIds: [], missingChipIds: [], hasOrphans: false };

  window.confirm = vi.fn(() => true);
  window.AgentXAuth = {
    getUser: () => ({ username: 'root', role: 'admin' }),
    logout: () => undefined,
    login: async () => ({ user: { username: 'root', role: 'admin' } }),
    clearToken: () => undefined,
    authFetch: async (path: string, requestOptions?: any) => {
      calls.push({ path, options: requestOptions });

      if (path === '/admin/users') return jsonResponse({ users: [] });
      if (path === '/admin/chips') return jsonResponse({ chips, knowledgeBaseRoot: '' });
      if (path === '/admin/chip-access') return jsonResponse({ users: {} });
      if (path === '/admin/prompts') return jsonResponse({ files: [] });
      if (path === '/admin/roles') return jsonResponse({ roles: {}, _permissions: {} });

      if (path === '/admin/resources' && (!requestOptions || requestOptions.method === undefined || requestOptions.method === 'GET')) {
        return jsonResponse({
          documents,
          scopePresets,
          counts: { documents: documents.length, scopePresets: scopePresets.length }
        });
      }

      const resourceUpdateMatch = /^\/admin\/resources\/(documents|scope-presets)\/([^/]+)$/.exec(path);
      if (resourceUpdateMatch && requestOptions?.method === 'PUT') {
        return jsonResponse({ ok: true, resource: JSON.parse(requestOptions.body || '{}') });
      }

      const validateMatch = /^\/admin\/resources\/scope-presets\/([^/]+)\/validate$/.exec(path);
      if (validateMatch && requestOptions?.method === 'POST') {
        return jsonResponse(validation);
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

describe('P5/B7 resources admin section scaffold', () => {
  it('admin.html renders panel-resources with Documents and Scope Presets tabs', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const panel = doc.getElementById('panel-resources');
    expect(panel).toBeTruthy();

    // 双 tab：Documents | Scope Presets
    expect(panel!.querySelector('[data-resources-tab="documents"]')).toBeTruthy();
    expect(panel!.querySelector('[data-resources-tab="scope-presets"]')).toBeTruthy();

    // 文档表（含 tbody）+ preset 表（含 tbody）
    expect(panel!.querySelector('#resources-documents-list')).toBeTruthy();
    expect(panel!.querySelector('#resources-presets-list')).toBeTruthy();
  });

  it('admin.html document table headers cover id/label/visibility/status/chipIds/actions', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const panel = dom.window.document.getElementById('panel-resources')!;
    const docPane = panel.querySelector('[data-resources-pane="documents"]')!;
    const headerText = docPane.querySelector('thead')!.textContent || '';
    expect(headerText).toContain('文档 ID');
    expect(headerText).toContain('可见性');
    expect(headerText).toContain('状态');
  });

  it('admin.html preset table includes a documentIds column and an orphan warning slot', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const panel = dom.window.document.getElementById('panel-resources')!;
    const presetPane = panel.querySelector('[data-resources-pane="scope-presets"]')!;
    const headerText = presetPane.querySelector('thead')!.textContent || '';
    expect(headerText).toContain('文档');
    // 孤儿告警容器
    expect(panel.querySelector('#resources-preset-orphan-warning')).toBeTruthy();
  });

  it('admin.html editor exposes visibility levels, status flow controls, and requiredGrants editor', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const panel = dom.window.document.getElementById('panel-resources')!;

    const visibilitySelect = panel.querySelector('#resource-editor-visibility') as HTMLSelectElement | null;
    expect(visibilitySelect).toBeTruthy();
    const visibilityValues = Array.from(visibilitySelect!.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    for (const level of ['public', 'customer', 'partner', 'internal', 'adminOnly', 'restricted']) {
      expect(visibilityValues).toContain(level);
    }

    const statusSelect = panel.querySelector('#resource-editor-status') as HTMLSelectElement | null;
    expect(statusSelect).toBeTruthy();
    const statusValues = Array.from(statusSelect!.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(statusValues).toEqual(['draft', 'pending', 'approved', 'rejected', 'archived']);
    expect(statusValues).not.toContain('disabled');
    expect(panel.querySelector('#resource-editor-status-flow')).toBeTruthy();
    expect(panel.querySelector('#resource-editor-status-actions')).toBeTruthy();

    // requiredGrants 7 类编辑器输入框
    for (const grant of [
      'resource-editor-grant-brands',
      'resource-editor-grant-product-lines',
      'resource-editor-grant-chip-ids',
      'resource-editor-grant-document-ids',
      'resource-editor-grant-scope-preset-ids',
      'resource-editor-grant-model-ids',
      'resource-editor-grant-mcp-tools'
    ]) {
      expect(panel.querySelector(`#${grant}`)).toBeTruthy();
    }
  });

  it('admin.html exposes a resources nav link', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const link = dom.window.document.querySelector('#admin-section-nav [data-section="resources"]');
    expect(link).toBeTruthy();
  });

  it('admin.js ADMIN_SECTIONS registers resources and a loadResources function exists', () => {
    const src = readPublicFile('admin.js');
    expect(src).toMatch(/resources:\s*\{\s*path:\s*'\/admin\/sections\/resources'/);
    expect(src).toMatch(/function loadResources/);
    // loader 经 authFetch 打 /admin/resources
    expect(src).toMatch(/authFetch\(\s*'\/admin\/resources'/);
  });
});

describe('P5/B7 resources admin section behavior', () => {
  it('loadResources fetches GET /admin/resources via authFetch and renderResources renders document + preset rows', async () => {
    const { window, calls } = await bootAdminResources();

    const resourcesCall = calls.find((call) => call.path === '/admin/resources');
    expect(resourcesCall).toBeTruthy();

    const docList = window.document.getElementById('resources-documents-list')!;
    expect(docList.textContent).toContain('doc-seed');
    expect(docList.textContent).toContain('Seed datasheet');

    const presetList = window.document.getElementById('resources-presets-list')!;
    expect(presetList.textContent).toContain('scope-seed');
  });

  it('empty document catalog renders an empty-state row', async () => {
    const { window } = await bootAdminResources({ documents: [], scopePresets: [] });
    const docList = window.document.getElementById('resources-documents-list')!;
    expect(docList.querySelector('.empty-state')).toBeTruthy();
  });

  // B3：文档/Scope 面板加载时主动做孤儿引用校验（前端本地比对，不依赖点击「校验孤儿」）。
  it('proactively renders a persistent orphan banner when a loaded scope preset references a missing document/chip id', async () => {
    const { window } = await bootAdminResources({
      scopePresets: [
        {
          ...seedPresets()[0],
          documentIds: ['doc-seed', 'doc-ghost'],
          chipIds: ['CHIP-SEED', 'CHIP-GHOST']
        }
      ]
    });

    const banner = window.document.getElementById('resources-orphan-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('scope-seed');
    expect(banner.textContent).toContain('doc-ghost');
    expect(banner.textContent).toContain('CHIP-GHOST');
    // 未缺失的引用不应被误报
    expect(banner.textContent).not.toContain('doc-seed,');
  });

  it('hides the proactive orphan banner when no loaded scope preset has missing references', async () => {
    const { window } = await bootAdminResources();
    const banner = window.document.getElementById('resources-orphan-banner')!;
    expect(banner.hidden).toBe(true);
    expect(banner.textContent).toBe('');
  });

  it('validatePreset POSTs to /admin/resources/scope-presets/:id/validate and surfaces orphan references', async () => {
    const { window, calls } = await bootAdminResources({
      validation: { missingDocumentIds: ['doc-missing'], missingChipIds: ['CHIP-MISSING'], hasOrphans: true }
    });

    await window.AgentXAdminResources.validatePreset('scope-seed');
    await flushBrowserTasks();
    await flushBrowserTasks();

    const validateCall = calls.find(
      (call) => call.path === '/admin/resources/scope-presets/scope-seed/validate' && call.options?.method === 'POST'
    );
    expect(validateCall).toBeTruthy();

    const warning = window.document.getElementById('resources-preset-orphan-warning')!;
    expect(warning.textContent).toContain('doc-missing');
    expect(warning.textContent).toContain('CHIP-MISSING');
  });

  it('uses the shared token picker for Scope Preset chip selection and saves chipIds as an array', async () => {
    // H3：Scope Preset 的芯片选择器改用与文档 chipIds 相同的 .admin-token-picker/.admin-token-field 组件
    // （对齐原型 knowledge.html openPresetDrawer() 第 954-961 行「芯片选择器」），
    // 不再是独立的 .admin-check-list 方形矩阵。
    const { window, calls } = await bootAdminResources();

    (window.document.getElementById('resources-tab-presets') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const edit = window.document.querySelector('#resources-presets-list button') as HTMLButtonElement;
    edit.click();
    await flushBrowserTasks();

    const chipField = window.document.getElementById('resource-editor-chip-ids')!;
    expect(chipField.classList.contains('admin-token-picker')).toBe(true);
    expect(chipField.classList.contains('resource-chip-checklist')).toBe(false);
    expect(chipField.querySelector('.admin-check-list-search')).toBeNull();
    expect(chipField.textContent).toContain('CHIP-SEED');

    const tokenInput = chipField.querySelector('.admin-token-input') as HTMLInputElement;
    expect(tokenInput).toBeTruthy();
    tokenInput.value = 'CHIP-ALT';
    tokenInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(chipField.textContent).toContain('CHIP-ALT');

    (window.document.getElementById('resource-editor-save') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const updateCall = calls.find((call) => call.path === '/admin/resources/scope-presets/scope-seed' && call.options?.method === 'PUT');
    expect(updateCall).toBeTruthy();
    expect(JSON.parse(updateCall!.options.body).chipIds).toEqual(['CHIP-ALT', 'CHIP-SEED']);
  });

  it('renders document status flow actions and keeps status changes in the editor until saved', async () => {
    const { window, calls } = await bootAdminResources({
      documents: [
        {
          ...seedDocuments()[0],
          status: 'pending',
          approvedBy: undefined,
          approvedAt: undefined
        }
      ]
    });

    const edit = window.document.querySelector('#resources-documents-list button') as HTMLButtonElement;
    edit.click();
    await flushBrowserTasks();

    const flow = window.document.getElementById('resource-editor-status-flow')!;
    const actions = window.document.getElementById('resource-editor-status-actions')!;
    // H3：状态流条对齐原型线性渲染——status=pending 时只展示 draft→pending→approved 三步，
    // rejected/archived 是各自独立的终点分支，不再固定展示全部 5 个状态节点。
    expect(flow.textContent).toContain('draft');
    expect(flow.textContent).toContain('pending');
    expect(flow.textContent).toContain('approved');
    expect(flow.textContent).not.toContain('rejected');
    expect(flow.textContent).not.toContain('archived');
    expect(actions.textContent).toContain('批准');
    expect(actions.textContent).toContain('驳回');
    expect(actions.textContent).not.toContain('提交审核');

    const approve = Array.from(actions.querySelectorAll('button')).find((button) => button.textContent === '批准') as HTMLButtonElement;
    const callsBeforeAction = calls.length;
    approve.click();

    const statusSelect = window.document.getElementById('resource-editor-status') as HTMLSelectElement;
    expect(statusSelect.value).toBe('approved');
    expect(window.document.getElementById('resource-editor-status-line')?.textContent).toContain('保存后生效');
    expect(window.document.getElementById('resource-editor-status-actions')?.textContent).toContain('归档');
    expect(calls.length).toBe(callsBeforeAction);
  });

  it('limits resource status action buttons for draft, rejected, and archived states', async () => {
    const { window, calls } = await bootAdminResources({
      documents: [
        { ...seedDocuments()[0], documentId: 'doc-draft', status: 'draft' },
        { ...seedDocuments()[0], documentId: 'doc-rejected', status: 'rejected' },
        { ...seedDocuments()[0], documentId: 'doc-archived', status: 'archived' }
      ]
    });

    const editButtons = Array.from(window.document.querySelectorAll('#resources-documents-list button')) as HTMLButtonElement[];

    editButtons[0].click();
    await flushBrowserTasks();
    let actions = window.document.getElementById('resource-editor-status-actions')!;
    expect(actions.textContent).toContain('提交审核');
    expect(actions.textContent).not.toContain('批准');
    let callsBeforeAction = calls.length;
    (actions.querySelector('button') as HTMLButtonElement).click();
    expect((window.document.getElementById('resource-editor-status') as HTMLSelectElement).value).toBe('pending');
    expect(calls.length).toBe(callsBeforeAction);

    editButtons[1].click();
    await flushBrowserTasks();
    actions = window.document.getElementById('resource-editor-status-actions')!;
    expect(actions.textContent).toContain('归档');
    expect(actions.textContent).not.toContain('批准');
    callsBeforeAction = calls.length;
    (actions.querySelector('button') as HTMLButtonElement).click();
    expect((window.document.getElementById('resource-editor-status') as HTMLSelectElement).value).toBe('archived');
    expect(calls.length).toBe(callsBeforeAction);

    editButtons[2].click();
    await flushBrowserTasks();
    actions = window.document.getElementById('resource-editor-status-actions')!;
    expect(actions.textContent).toContain('当前状态无可用动作');
    expect(actions.querySelector('button')).toBeNull();
  });
});
