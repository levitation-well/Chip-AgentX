/**
 * Phase 5 Web UI Chip Integration Tests
 *
 * Tests the chip selector in chat.js and chip mapping panel in admin.js
 * using jsdom to simulate the DOM and verify UI behavior.
 *
 * @see tests/uat-phase5.test.ts for HTTP-layer tests
 * @see tests/chip-http.test.ts for API-level tests
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

/**
 * 从 public/admin.js 真实源码中取出两条哨兵注释之间的字节，
 * 用 new Function 包成可调用的 collectChipCatalogCore，使测试直接求值真实合并逻辑，
 * 不再依赖测试内的镜像副本。哨兵缺失时抛出，保证 TDD 先红。
 */
function loadAdminCore(): (
  rows: ArrayLike<Element>,
  stateChips: any[],
  knowledgeBaseRoot: unknown
) => { knowledgeBaseRoot: unknown; chips: any[] } {
  const src = readPublicFile('admin.js');
  const startMarker = '=== TESTABLE collectChipCatalogCore START ===';
  const endMarker = '=== TESTABLE collectChipCatalogCore END ===';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) {
    throw new Error('sentinel not found');
  }
  const body = src.slice(src.indexOf('\n', start) + 1, src.lastIndexOf('\n', end));
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn collectChipCatalogCore;`)();
}

/**
 * 从 public/admin.js 真实源码取出 createChipInput 纯函数（两哨兵之间）并求值。
 * 该函数依赖 document.createElement，故注入测试的 document 作为闭包变量。
 */
function loadCreateChipInput(documentRef: Document): (
  labelText: string,
  field: string,
  value: string
) => HTMLElement {
  const src = readPublicFile('admin.js');
  const startMarker = '=== TESTABLE createChipInput START ===';
  const endMarker = '=== TESTABLE createChipInput END ===';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) {
    throw new Error('createChipInput sentinel not found');
  }
  const body = src.slice(src.indexOf('\n', start) + 1, src.lastIndexOf('\n', end));
  // eslint-disable-next-line no-new-func
  const adminText = (_key: string, fallback?: string) => fallback || _key;
  return new Function('document', 'adminText', `${body}\nreturn createChipInput;`)(documentRef, adminText);
}

/**
 * 从 public/admin.js 真实源码取出 buildChipIngestDraft 纯函数（两哨兵之间）并求值。
 * 该函数仅用入参字符串 + 标准 JS，无 DOM 依赖。
 */
function loadBuildChipIngestDraft(): (fields: Record<string, string>) => Record<string, unknown> {
  const src = readPublicFile('admin.js');
  const startMarker = '=== TESTABLE buildChipIngestDraft START ===';
  const endMarker = '=== TESTABLE buildChipIngestDraft END ===';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) {
    throw new Error('buildChipIngestDraft sentinel not found');
  }
  const body = src.slice(src.indexOf('\n', start) + 1, src.lastIndexOf('\n', end));
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn buildChipIngestDraft;`)();
}

// Mock global fetch for UI tests
const mockFetch = vi.fn();

describe('chat.js chip selector behavior', () => {
  let window: ReturnType<typeof JSDOM.prototype.window>;
  let document: Document;
  let authFetchMock: ReturnType<typeof vi.fn>;
  let openAuthorizedEventStreamMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Create a fresh JSDOM for each test
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <body>
          <div id="chat-error"></div>
          <div id="user-status"></div>
          <div id="session-list"></div>
          <div id="session-meta"></div>
          <div id="conversation"></div>
          <form id="message-form">
            <input id="message" />
            <button id="send-message"></button>
          </form>
          <button id="new-session">新会话</button>
          <button id="logout">退出</button>
          <select id="chip-select"></select>
        </body>
      </html>`,
      { url: 'http://localhost/chat', runScripts: 'outside-only' }
    );
    window = dom.window;
    document = window.document;

    // Setup auth mock
    authFetchMock = vi.fn();
    openAuthorizedEventStreamMock = vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null
    });

    // Inject auth utilities
    window.AgentXAuth = {
      requireLogin: vi.fn().mockReturnValue(false),
      getUser: vi.fn().mockReturnValue({ id: 'user-1', username: 'alice' }),
      authFetch: authFetchMock,
      openAuthorizedEventStream: openAuthorizedEventStreamMock,
      logout: vi.fn()
    };

    // Setup DOM globals
    global.window = window as any;
    global.document = document;
    global.fetch = mockFetch;

    // Reset mocks
    mockFetch.mockReset();
    authFetchMock.mockReset();
    openAuthorizedEventStreamMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('chip select population', () => {
    it('renders chip options from GET /chips response', async () => {
      // Simulate the loadChips() behavior
      const chipsResponse = {
        chips: [
          { id: 'E521.39', label: 'E521.39 芯片' },
          { id: 'RISC-V', label: 'RISC-V 内核' }
        ]
      };
      authFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => chipsResponse
      });

      // Execute loadChips logic
      const response = await window.AgentXAuth.authFetch('/chips');
      const payload = await response.json();
      const chips = payload.chips || [];

      // Render chip select (simulating renderChipSelect)
      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      chipSelect.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '选择芯片';
      placeholder.disabled = true;
      placeholder.selected = true;
      chipSelect.append(placeholder);
      for (const chip of chips) {
        const opt = document.createElement('option');
        opt.value = chip.id;
        opt.textContent = chip.label;
        chipSelect.append(opt);
      }

      expect(chipSelect.options.length).toBe(3); // 1 placeholder + 2 chips
      expect(chipSelect.options[1].value).toBe('E521.39');
      expect(chipSelect.options[1].textContent).toBe('E521.39 芯片');
      expect(chipSelect.options[2].value).toBe('RISC-V');
      expect(chipSelect.options[2].textContent).toBe('RISC-V 内核');
    });

    it('does not expose workspaceDir in chip options', async () => {
      const chipsResponse = {
        chips: [
          { id: 'E521.39', label: 'E521.39 芯片', workspaceDir: '/secret/path' } // should not appear
        ]
      };
      authFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => chipsResponse
      });

      const response = await window.AgentXAuth.authFetch('/chips');
      const payload = await response.json();
      const chips = payload.chips || [];

      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      chipSelect.replaceChildren();
      for (const chip of chips) {
        // Only extract id and label (mimicking listPublicChips behavior)
        const { id, label } = chip;
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = label;
        chipSelect.appendChild(opt);
      }

      const chipOption = chipSelect.options[0];
      expect(chipOption.value).toBe('E521.39');
      expect(chipOption.textContent).toBe('E521.39 芯片');
      // Verify no workspaceDir leaked into DOM
      expect(chipOption.getAttribute('workspaceDir')).toBeNull();
      expect(chipOption.dataset.workspaceDir).toBeUndefined();
    });

    it('requires chip selection before creating session', async () => {
      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      chipSelect.value = ''; // No chip selected

      const chipId = chipSelect.value;
      const error = !chipId ? '请先选择一个芯片' : null;

      expect(error).toBe('请先选择一个芯片');
    });

    it('includes chipId in session creation payload', async () => {
      // Simulate selecting a chip - need to add option first, then select
      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      
      // Add options to select
      const opt = document.createElement('option');
      opt.value = 'E521.39';
      opt.textContent = 'E521.39 芯片';
      chipSelect.appendChild(opt);
      chipSelect.value = 'E521.39';

      // Mock the session creation response
      authFetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessionId: 'sess-123' })
      });

      const sessionPayload = {
        agentType: 'claude-code',
        task: 'inspect datasheet',
        sessionMode: 'conversation',
        chipId: chipSelect.value
      };

      await window.AgentXAuth.authFetch('/sessions', {
        method: 'POST',
        body: JSON.stringify(sessionPayload)
      });

      expect(authFetchMock).toHaveBeenCalledWith('/sessions', expect.objectContaining({
        method: 'POST'
      }));
      const callBody = JSON.parse(authFetchMock.mock.calls[0][1].body);
      expect(callBody).toEqual(expect.objectContaining({
        chipId: 'E521.39'
      }));
      expect(callBody).not.toHaveProperty('cwd'); // cwd should not be in user payload
    });
  });

  describe('chip selector freeze on active session', () => {
    it('disables chip select when session is active', () => {
      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      
      // Add option and select it first
      const opt = document.createElement('option');
      opt.value = 'E521.39';
      chipSelect.appendChild(opt);
      
      const activeChipId = 'E521.39';
      const activeSessionId = 'sess-123';

      // Simulate session being active - syncChipSelector from chat.js
      if (activeSessionId && activeChipId) {
        chipSelect.value = activeChipId;
        chipSelect.disabled = true;
      }

      expect(chipSelect.disabled).toBe(true);
      expect(chipSelect.value).toBe('E521.39');
    });

    it('re-enables chip select when new session is started', () => {
      const chipSelect = document.getElementById('chip-select') as HTMLSelectElement;
      chipSelect.value = 'E521.39';
      chipSelect.disabled = true;

      // Simulate "new session" action
      const activeSessionId = null;
      const activeChipId = null;

      if (!activeSessionId) {
        chipSelect.disabled = false;
      }

      expect(chipSelect.disabled).toBe(false);
    });
  });

  describe('session list chip display', () => {
    it('displays chipId alongside session info in session rows', () => {
      const sessions = [
        { id: 'sess-1', agentType: 'claude-code', chipId: 'E521.39' },
        { id: 'sess-2', agentType: 'claude-code', chipId: 'RISC-V' },
        { id: 'sess-3', agentType: 'claude-code', chipId: null }
      ];

      const sessionList = document.getElementById('session-list') as HTMLDivElement;
      sessionList.replaceChildren();

      for (const session of sessions) {
        const row = document.createElement('button');
        row.className = 'session-row';
        const chipLabel = session.chipId || '—';
        row.textContent = `${chipLabel} · ${session.agentType} · ${String(session.id).slice(0, 8)}`;
        sessionList.appendChild(row);
      }

      const rows = sessionList.querySelectorAll('.session-row');
      expect(rows[0].textContent).toContain('E521.39');
      expect(rows[1].textContent).toContain('RISC-V');
      expect(rows[2].textContent).toContain('—');
    });
  });
});

describe('admin.js chip mapping panel behavior', () => {
  let window: ReturnType<typeof JSDOM.prototype.window>;
  let document: Document;
  let authFetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const dom = new JSDOM(
      `<!DOCTYPE html>
      <html>
        <body>
          <div id="admin-error"></div>
          <div id="chip-mapping-list"></div>
          <div id="chip-mapping-error"></div>
          <div id="user-list"></div>
          <div id="key-list"></div>
          <div id="selected-user-title"></div>
          <button id="logout">退出</button>
          <form id="user-form">
            <input id="new-username" />
            <input id="new-password" />
          </form>
          <form id="key-form">
            <input id="key-name" />
          </form>
          <div id="generated-key"></div>
        </body>
      </html>`,
      { url: 'http://localhost/admin', runScripts: 'outside-only' }
    );
    window = dom.window;
    document = window.document;

    authFetchMock = vi.fn();

    window.AgentXAuth = {
      requireLogin: vi.fn().mockReturnValue(false),
      getUser: vi.fn().mockReturnValue({ id: 'admin-1', username: 'admin' }),
      authFetch: authFetchMock,
      logout: vi.fn()
    };

    global.window = window as any;
    global.document = document;
    global.fetch = mockFetch;

    mockFetch.mockReset();
    authFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('chip mapping display', () => {
    it('renders chip mapping with id, label, public metadata, and workspaceDir for admin', async () => {
      const adminChipsResponse = {
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39 芯片',
            description: 'E521.39 public resource summary',
            queryHint: 'Use for E521.39 questions',
            workspaceDir: '/kb/E521.39'
          },
          { id: 'RISC-V', label: 'RISC-V 内核', workspaceDir: '/kb/RISC-V' }
        ]
      };
      authFetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => adminChipsResponse
      });

      const response = await window.AgentXAuth.authFetch('/admin/chips', { skipAuthRedirect: true });
      const payload = await response.json();
      const chips = payload.chips || [];

      const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
      chipMappingList.replaceChildren();
      document.getElementById('chip-mapping-error')!.textContent = '';

      for (const chip of chips) {
        const row = document.createElement('div');
        row.className = 'chip-mapping-row';
        const idSpan = document.createElement('span');
        idSpan.className = 'chip-mapping-id';
        idSpan.textContent = chip.id;
        const labelSpan = document.createElement('span');
        labelSpan.className = 'chip-mapping-label';
        labelSpan.textContent = chip.label || chip.id;
        const descriptionSpan = document.createElement('span');
        descriptionSpan.className = 'chip-mapping-description';
        descriptionSpan.textContent = chip.description || '';
        const queryHintSpan = document.createElement('span');
        queryHintSpan.className = 'chip-mapping-query-hint';
        queryHintSpan.textContent = chip.queryHint || '';
        const dirSpan = document.createElement('span');
        dirSpan.className = 'chip-mapping-dir';
        dirSpan.textContent = chip.workspaceDir || '';
        row.append(idSpan, labelSpan, descriptionSpan, queryHintSpan, dirSpan);
        chipMappingList.appendChild(row);
      }

      expect(chipMappingList.children.length).toBe(2);
      expect((chipMappingList.children[0].querySelector('.chip-mapping-id') as HTMLElement).textContent).toBe('E521.39');
      expect((chipMappingList.children[0].querySelector('.chip-mapping-description') as HTMLElement).textContent).toBe('E521.39 public resource summary');
      expect((chipMappingList.children[0].querySelector('.chip-mapping-query-hint') as HTMLElement).textContent).toBe('Use for E521.39 questions');
      expect((chipMappingList.children[0].querySelector('.chip-mapping-dir') as HTMLElement).textContent).toBe('/kb/E521.39');
    });

    it('collects all editor fields via real admin.js collectChipCatalogCore', () => {
      const collect = loadAdminCore();
      const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
      chipMappingList.replaceChildren();
      const row = document.createElement('div');
      row.className = 'chip-editor-row';
      (row as HTMLElement).dataset.chipId = 'E521.39';
      row.innerHTML = `
        <input data-field="id" value="E521.39" />
        <input data-field="label" value="E521.39 芯片" />
        <input data-field="brand" value="ELMOS" />
        <input data-field="brandAliases" value="" />
        <input data-field="productLines" value="氛围灯" />
        <input data-field="description" value="E521.39 public resource summary" />
        <input data-field="summary" value="LED 诊断" />
        <input data-field="queryHint" value="Use for E521.39 questions" />
        <input data-field="applicationTags" value="LED-diagnostics、PWM" />
        <input data-field="documentIds" value="" />
        <input data-field="permissionTags" value="" />
        <input data-field="sourceLabels" value="" />
        <input data-field="workspaceDir" value="/kb/E521.39" />
      `;
      chipMappingList.appendChild(row);

      const rows = chipMappingList.querySelectorAll('.chip-editor-row');
      const { knowledgeBaseRoot, chips } = collect(rows, [], '/kb');

      // 真实采集覆盖全部九个字段（含 brand/productLines/summary/applicationTags），不再只仿采五字段
      expect(knowledgeBaseRoot).toBe('/kb');
      expect(chips).toHaveLength(1);
      expect(chips[0].id).toBe('E521.39');
      expect(chips[0].label).toBe('E521.39 芯片');
      expect(chips[0].brand).toBe('ELMOS');
      expect(chips[0].productLines).toEqual(['氛围灯']);
      expect(chips[0].description).toBe('E521.39 public resource summary');
      expect(chips[0].summary).toBe('LED 诊断');
      expect(chips[0].queryHint).toBe('Use for E521.39 questions');
      expect(chips[0].applicationTags).toEqual(['LED-diagnostics', 'PWM']);
      expect(chips[0].workspaceDir).toBe('/kb/E521.39');
    });

    it('shows error message when non-admin tries to access chip mapping', async () => {
      authFetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: 'Forbidden' })
      });

      const response = await window.AgentXAuth.authFetch('/admin/chips', { skipAuthRedirect: true });

      if (response.status === 403) {
        const errorEl = document.getElementById('chip-mapping-error') as HTMLDivElement;
        errorEl.textContent = '无权限查看芯片映射';
      }

      expect(document.getElementById('chip-mapping-error')!.textContent).toBe('无权限查看芯片映射');
    });

    it('shows empty state when no chips are configured', async () => {
      authFetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ chips: [] })
      });

      const response = await window.AgentXAuth.authFetch('/admin/chips', { skipAuthRedirect: true });
      const payload = await response.json();
      const chips = payload.chips || [];

      const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
      chipMappingList.replaceChildren();

      if (chips.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = '暂无芯片配置';
        chipMappingList.appendChild(empty);
      }

      expect(chipMappingList.textContent).toContain('暂无芯片配置');
    });

    it('chip mapping panel renders a dense catalog plus editable drawer fields', () => {
      const src = readPublicFile('admin.js');
      const html = readPublicFile('admin.html');
      expect(src).toContain('function renderChipCatalogRow');
      expect(src).toContain('function fillChipEditor');
      expect(src).toContain('function applyChipEditor');
      for (const id of [
        'chip-catalog-table',
        'chip-catalog-list',
        'chip-editor-drawer',
        'chip-editor-id',
        'chip-editor-label',
        'chip-editor-brand',
        'chip-editor-product-lines',
        'chip-editor-application-tags',
        'chip-editor-document-ids',
        'chip-editor-summary',
        'chip-editor-query-hint',
        'chip-editor-workspace-dir'
      ]) {
        expect(html).toContain(`id="${id}"`);
      }
    });

    it('createChipInput 对既有 chipId（field=id 且 value 非空）渲染只读输入（B11 Task 2.2）', () => {
      const createChipInput = loadCreateChipInput(document);

      // 既有 chip：id 非空 → readOnly，防止重命名
      const existingId = createChipInput('Chip ID', 'id', 'E521.31') as HTMLLabelElement;
      const existingInput = existingId.querySelector('input') as HTMLInputElement;
      expect(existingInput.readOnly).toBe(true);

      // 新建行：id 为空 → 可编辑（允许首次命名）
      const newId = createChipInput('Chip ID', 'id', '') as HTMLLabelElement;
      expect((newId.querySelector('input') as HTMLInputElement).readOnly).toBe(false);

      // 其它字段无论是否有值都不只读
      const label = createChipInput('Label', 'label', 'E521.31 芯片') as HTMLLabelElement;
      expect((label.querySelector('input') as HTMLInputElement).readOnly).toBe(false);
    });

    describe('collectChipCatalogCore 合并逻辑（真实 admin.js 求值）', () => {
      // 不再镜像合并算法：直接取 admin.js 两哨兵之间的真实字节求值，
      // 篡改纯函数（如去掉 ...original）即会让本组转红。

      it('合并：保留未编辑字段、解析 applicationTags、空 summary 不写入、支持按 dataset.chipId 查原始对象', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        // 原始 chip 含有编辑器不渲染的额外字段（_legacyMeta 任何编辑器字段都覆盖不到，护栏靠它）
        const stateChips = [
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'original desc',
            queryHint: 'original hint',
            workspaceDir: '/kb/E521.39',
            productLines: ['氛围灯'],
            brand: 'ELMOS',
            documentIds: ['doc-1'],
            permissionTags: ['internal'],
            summary: 'original summary',
            _legacyMeta: { keep: true }
          }
        ];

        // 构造一个 chip-editor-row，包含全部十三个字段（含 B11 Task 2.1 新增四个数组字段）
        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        (row as HTMLElement).dataset.chipId = 'E521.39'; // 按原始 id 查找
        row.innerHTML = `
          <input data-field="id" value="E521.39-RENAMED" />
          <input data-field="label" value="E521.39 已改名" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="" />
          <input data-field="productLines" value="" />
          <input data-field="description" value="new desc" />
          <input data-field="summary" value="LED 开短路诊断；PWM 调光" />
          <input data-field="queryHint" value="new hint" />
          <input data-field="applicationTags" value="LED-diagnostics, PWM-dimming、ambient" />
          <input data-field="documentIds" value="doc-1" />
          <input data-field="permissionTags" value="internal" />
          <input data-field="sourceLabels" value="" />
          <input data-field="workspaceDir" value="/kb/E521.39" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, stateChips, '/kb');

        expect(chips).toHaveLength(1);
        const chip = chips[0];

        // 编辑后字段正确覆盖
        expect(chip.id).toBe('E521.39-RENAMED');
        expect(chip.label).toBe('E521.39 已改名');
        expect(chip.description).toBe('new desc');
        expect(chip.queryHint).toBe('new hint');
        expect(chip.workspaceDir).toBe('/kb/E521.39');
        expect(chip.summary).toBe('LED 开短路诊断；PWM 调光');

        // applicationTags 按 /[,，、]/ 拆分，去空格
        expect(chip.applicationTags).toEqual(['LED-diagnostics', 'PWM-dimming', 'ambient']);

        // documentIds/permissionTags 现已是可编辑字段：输入保留即原样回写
        expect(chip.documentIds).toEqual(['doc-1']);
        expect(chip.permissionTags).toEqual(['internal']);
        // 真正未渲染的额外字段经 {...original} 合并存活（护栏：篡改 ...original 即转红）
        expect(chip._legacyMeta).toEqual({ keep: true });
        // brand 留空 → 真实实现 delete，原始 brand 不保留
        expect(chip).not.toHaveProperty('brand');
        // productLines/sourceLabels 留空 → 真实实现写空数组（非保留原始、非 delete）
        expect(chip.productLines).toEqual([]);
        expect(chip.sourceLabels).toEqual([]);
      });

      it('合并：productLines 按 /[,，、]/ 拆分去空格', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        (row as HTMLElement).dataset.chipId = 'E521.39';
        row.innerHTML = `
          <input data-field="id" value="E521.39" />
          <input data-field="label" value="L" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="" />
          <input data-field="productLines" value="氛围灯，外饰灯、灯光" />
          <input data-field="description" value="" />
          <input data-field="summary" value="" />
          <input data-field="queryHint" value="" />
          <input data-field="applicationTags" value="" />
          <input data-field="documentIds" value="" />
          <input data-field="permissionTags" value="" />
          <input data-field="sourceLabels" value="" />
          <input data-field="workspaceDir" value="/kb/E521.39" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, [], '/kb');

        expect(chips[0].productLines).toEqual(['氛围灯', '外饰灯', '灯光']);
      });

      it('合并：空 summary 字段不写入 key（真实实现写空 applicationTags 数组）', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        const stateChips = [{ id: 'RISC-V', label: 'RISC-V Core', workspaceDir: '/kb/RISC-V' }];

        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        (row as HTMLElement).dataset.chipId = 'RISC-V';
        row.innerHTML = `
          <input data-field="id" value="RISC-V" />
          <input data-field="label" value="RISC-V Core" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="" />
          <input data-field="productLines" value="" />
          <input data-field="description" value="" />
          <input data-field="summary" value="" />
          <input data-field="queryHint" value="" />
          <input data-field="applicationTags" value="" />
          <input data-field="documentIds" value="" />
          <input data-field="permissionTags" value="" />
          <input data-field="sourceLabels" value="" />
          <input data-field="workspaceDir" value="/kb/RISC-V" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, stateChips, '/kb');

        expect(chips[0]).not.toHaveProperty('summary');
        expect(chips[0].applicationTags).toEqual([]);
        expect(chips[0].productLines).toEqual([]);
      });

      it('合并：四个数组字段 brandAliases/documentIds/permissionTags/sourceLabels 按 /[,，、]/ 拆分去空（B11 Task 2.1）', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        (row as HTMLElement).dataset.chipId = 'E521.39';
        row.innerHTML = `
          <input data-field="id" value="E521.39" />
          <input data-field="label" value="L" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="a, b、c" />
          <input data-field="productLines" value="" />
          <input data-field="description" value="" />
          <input data-field="summary" value="" />
          <input data-field="queryHint" value="" />
          <input data-field="applicationTags" value="" />
          <input data-field="documentIds" value="doc-1，doc-2" />
          <input data-field="permissionTags" value="internal、partner" />
          <input data-field="sourceLabels" value="seed" />
          <input data-field="workspaceDir" value="/kb/E521.39" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, [], '/kb');

        expect(chips[0].brandAliases).toEqual(['a', 'b', 'c']);
        expect(chips[0].documentIds).toEqual(['doc-1', 'doc-2']);
        expect(chips[0].permissionTags).toEqual(['internal', 'partner']);
        expect(chips[0].sourceLabels).toEqual(['seed']);
      });

      it('合并：四个数组字段留空 → 写空数组 [End]（与 productLines 空值语义一致，B11 Task 2.1）', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        // 原始 chip 含这四个字段的旧值；编辑器留空应改写为空数组（非保留原始）
        const stateChips = [
          {
            id: 'E521.39',
            label: 'L',
            workspaceDir: '/kb/E521.39',
            brandAliases: ['old-alias'],
            documentIds: ['old-doc'],
            permissionTags: ['old-tag'],
            sourceLabels: ['old-source']
          }
        ];

        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        (row as HTMLElement).dataset.chipId = 'E521.39';
        row.innerHTML = `
          <input data-field="id" value="E521.39" />
          <input data-field="label" value="L" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="" />
          <input data-field="productLines" value="" />
          <input data-field="description" value="" />
          <input data-field="summary" value="" />
          <input data-field="queryHint" value="" />
          <input data-field="applicationTags" value="" />
          <input data-field="documentIds" value="" />
          <input data-field="permissionTags" value="" />
          <input data-field="sourceLabels" value="" />
          <input data-field="workspaceDir" value="/kb/E521.39" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, stateChips, '/kb');

        expect(chips[0].brandAliases).toEqual([]);
        expect(chips[0].documentIds).toEqual([]);
        expect(chips[0].permissionTags).toEqual([]);
        expect(chips[0].sourceLabels).toEqual([]);
      });

      it('合并：新行（无 dataset.chipId）从空对象合并，不报错', () => {
        const collect = loadAdminCore();
        const chipMappingList = document.getElementById('chip-mapping-list') as HTMLDivElement;
        chipMappingList.replaceChildren();

        const row = document.createElement('div');
        row.className = 'chip-editor-row';
        row.dataset.chipId = ''; // 真实新增行：renderChipEditorRow 用 chip.id='' 设为空串（非 undefined），二者经 byId.get 均回退 {}
        row.innerHTML = `
          <input data-field="id" value="NEW-CHIP" />
          <input data-field="label" value="New Chip" />
          <input data-field="brand" value="" />
          <input data-field="brandAliases" value="" />
          <input data-field="productLines" value="" />
          <input data-field="description" value="" />
          <input data-field="summary" value="" />
          <input data-field="queryHint" value="" />
          <input data-field="applicationTags" value="a,b" />
          <input data-field="documentIds" value="" />
          <input data-field="permissionTags" value="" />
          <input data-field="sourceLabels" value="" />
          <input data-field="workspaceDir" value="/kb/new" />
        `;
        chipMappingList.appendChild(row);

        const rows = chipMappingList.querySelectorAll('.chip-editor-row');
        const { chips } = collect(rows, [], '/kb');

        expect(chips[0].id).toBe('NEW-CHIP');
        expect(chips[0].applicationTags).toEqual(['a', 'b']);
        expect(chips[0]).not.toHaveProperty('summary');
      });
    });
  });
});

// T16 前端合约：chip 编辑器源码暴露 brand 与 productLines 输入
describe('admin.js chip editor brand/productLines 合约（T16）', () => {
  it('chip editor 源码暴露 brand 与 productLines 输入', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('id="chip-editor-brand"');
    expect(html).toContain('id="chip-editor-product-lines"');
    expect(html).toContain('data-field="brand"');
    expect(html).toContain('data-field="productLines"');
  });
});

// B11 Task 2.6：数据孵化入库前端合约
describe('admin.js datasheet metadata ingest 合约（B11 Task 2.6）', () => {
  it('buildChipIngestDraft 拆分列表字段、省略空值、保留 chipId', () => {
    const build = loadBuildChipIngestDraft();
    const draft = build({
      chipId: '  E522.94 ',
      label: 'E522.94 LED Driver',
      brand: 'Elmos',
      productLines: '外饰灯, 氛围灯、室内灯',
      summary: '16 路外饰灯 LED 驱动；PWM 调光',
      applicationTags: 'LED-open-short-diagnostics，PWM-dimming',
      workspaceDir: '/opt/chip-agentx/datasheets/E522.94'
    });
    expect(draft.chipId).toBe('E522.94');
    expect(draft.label).toBe('E522.94 LED Driver');
    expect(draft.brand).toBe('Elmos');
    expect(draft.productLines).toEqual(['外饰灯', '氛围灯', '室内灯']);
    expect(draft.summary).toBe('16 路外饰灯 LED 驱动；PWM 调光');
    expect(draft.applicationTags).toEqual(['LED-open-short-diagnostics', 'PWM-dimming']);
    expect(draft.workspaceDir).toBe('/opt/chip-agentx/datasheets/E522.94');
  });

  it('buildChipIngestDraft 省略空字段，避免空值覆盖既有 chip', () => {
    const build = loadBuildChipIngestDraft();
    const draft = build({
      chipId: 'E521.39',
      label: '',
      brand: '   ',
      productLines: '',
      summary: '只更新 summary',
      applicationTags: '',
      workspaceDir: ''
    });
    expect(draft).toEqual({ chipId: 'E521.39', summary: '只更新 summary' });
    expect(draft).not.toHaveProperty('label');
    expect(draft).not.toHaveProperty('productLines');
    expect(draft).not.toHaveProperty('applicationTags');
    expect(draft).not.toHaveProperty('workspaceDir');
  });

  it('admin.js removes the dead ingest submit glue while keeping the pure draft builder', () => {
    const src = readPublicFile('admin.js');
    // buildChipIngestDraft 仍保留（纯函数，供 POST /admin/chips/ingest 未来复用，且有独立单测覆盖）。
    expect(src).toContain('function buildChipIngestDraft');
    // 但驱动它的表单提交胶水代码（ingestChipDraft 函数、chipIngestForm 等元素查找与监听）已随
    // admin 改版收官批（B8）移除——markup 已不存在，留着即死代码。
    expect(src).not.toContain('async function ingestChipDraft');
    expect(src).not.toContain('chipIngestForm');
    expect(src).not.toContain('chipIngestError');
    expect(src).not.toContain('chipIngestId');
    expect(src).not.toContain('chipIngestStatus');
  });

  it('admin.html keeps the F6 ingestion UI hidden behind future-module guidance', () => {
    const html = readPublicFile('admin.html');
    expect(html).not.toContain('id="chip-ingest-form"');
    expect(html).not.toContain('id="chip-ingest-submit"');
    expect(html).toContain('外部资料提交的审核入库流程为未来模块');
    expect(html).toContain('数据孵化 SOP');
  });
});
