import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function adminDocument() {
  return new JSDOM(readPublicFile('admin.html')).window.document;
}

describe('FE4 admin remaining workspaces contracts', () => {
  it('keeps the F6 ingestion path out of the visible admin shell', () => {
    const html = readPublicFile('admin.html');
    const doc = adminDocument();

    expect(doc.getElementById('chip-ingest-form')).toBeNull();
    expect(doc.getElementById('chip-ingest-submit')).toBeNull();
    expect(doc.querySelector('.chip-ingest-panel')).toBeNull();
    expect(html).not.toContain('/admin/chips/ingest');
    expect(html).not.toContain('数据孵化入库');
  });

  it('renders a FE4 chip catalog surface with future-module guidance', () => {
    const doc = adminDocument();
    const css = readPublicFile('styles.css');
    const panel = doc.getElementById('panel-chips');
    expect(panel).toBeTruthy();

    expect(panel!.querySelector('#chip-catalog-table')).toBeTruthy();
    expect(panel!.querySelector('#chip-catalog-list')).toBeTruthy();
    expect(panel!.querySelector('#chip-editor-drawer')).toBeTruthy();
    expect(panel!.querySelector('#chip-editor-document-ids')?.className).toContain('chip-document-list');
    expect(panel!.querySelector('#chip-editor-document-ids')?.className).not.toContain('admin-token-picker');
    expect(panel!.querySelector('#chip-editor-document-ids[data-field="documentIds"]')).toBeNull();
    expect(css).toMatch(/#chip-editor-form\s*{[^}]*grid-template-columns:\s*1fr/s);

    const headerText = panel!.querySelector('thead')?.textContent || '';
    for (const label of ['Chip ID', 'Label', '品牌', '产品线', '应用标签', '文档数', '提示词', '工作区路径']) {
      expect(headerText).toContain(label);
    }

    expect(panel!.textContent).toContain('外部资料提交的审核入库流程为未来模块');
    expect(panel!.textContent).toContain('数据孵化 SOP');
  });

  it('keeps resources structured and free of raw requiredGrants JSON editing', () => {
    const doc = adminDocument();
    const panel = doc.getElementById('panel-resources');
    expect(panel).toBeTruthy();

    expect(panel!.querySelector('[data-resources-tab="documents"]')?.textContent).toContain('文档可见性');
    expect(panel!.querySelector('[data-resources-tab="scope-presets"]')?.textContent).toContain('Scope Presets');
    expect(panel!.querySelector('#resource-editor-grant-chip-ids')).toBeTruthy();
    expect(panel!.querySelector('#resource-editor-grant-document-ids')).toBeTruthy();
    expect(panel!.querySelector('#resource-editor-grant-scope-preset-ids')).toBeTruthy();
    expect(panel!.textContent).not.toContain('Required grants JSON');
  });

  it('renders prompt history as a selectable timeline with guarded rollback', () => {
    const doc = adminDocument();
    const panel = doc.getElementById('panel-prompts');
    const js = readPublicFile('admin.js');
    const css = readPublicFile('styles.css');

    expect(panel).toBeTruthy();
    expect(panel!.querySelector('#prompt-chip-count')).toBeTruthy();
    expect(panel!.querySelector('#prompt-file-list')?.className).toContain('prompt-chip-list');
    expect(panel!.querySelector('#prompt-history-list')).toBeTruthy();
    expect(panel!.querySelector('#prompt-template-create')).toBeTruthy();
    expect(panel!.querySelector('#prompt-placeholder')?.textContent).toContain('从模板创建');
    expect(panel!.querySelector('#prompt-error-title')?.textContent).toContain('提示词加载失败');
    expect(panel!.querySelector('#prompt-retry')?.textContent).toContain('重试');
    expect(js).toContain('renderPromptHistory');
    expect(js).toContain('promptFileForChip');
    expect(js).toContain('openPromptForChip');
    expect(js).toContain('loadPromptHistoryDraft');
    expect(js).toContain('保存后生效');
    expect(js).toContain('chip-prompt-jump');
    expect(css).toContain('.prompt-chip-card');
    expect(css).toContain('.prompt-history-rollback');
    expect(js).toContain('提示词尚未创建');
  });

  it('bounds the prompt panel to per-pane internal scroll so a long chip list cannot blow out the workspace', () => {
    const css = readPublicFile('styles.css');
    // 图3 溢出修复（2.2.29）：提示词面板填满 .admin-workspace 视口、两栏各自内部滚动，
    // 不再让左栏卡片列表无界拉高、把右侧编辑区撑成大片空白并溢出可视区。
    // - 提示词面板作为 .admin-workspace（flex column）子项填满可用高度
    expect(css).toMatch(/\.prompt-admin-detail\s*\{[^}]*flex:\s*1/);
    // - split-pane 去掉原固定 min-height:460px 的无界拉高，改为填满并交给内部滚动
    expect(css).not.toMatch(/\.prompt-split-pane\s*\{[^}]*min-height:\s*460px/);
    // - 左栏卡片列表在自身内部竖向滚动（头部标题+已建计数保持固定）
    expect(css).toMatch(/\.prompt-chip-list\s*\{[^}]*overflow-y:\s*auto/);
    // - 右栏编辑区独立滚动
    expect(css).toMatch(/\.prompt-editor-pane\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('renders observability with a prototype-style range picker and distribution bars', () => {
    const doc = adminDocument();
    const css = readPublicFile('styles.css');
    const js = readPublicFile('admin.js');
    const panel = doc.getElementById('panel-observability');
    expect(panel).toBeTruthy();

    expect(panel!.querySelector('#observability-range option[value="24h"]')).toBeTruthy();
    expect(panel!.querySelector('#observability-range option[value="7d"]')).toBeTruthy();
    expect(panel!.querySelector('#observability-range option[value="30d"]')).toBeTruthy();
    expect(css).toContain('.observability-bar-track');
    expect(css).toContain('.observability-bar-fill');
    expect(js).toContain("fill.className = 'observability-bar-fill'");
  });

  it('uses structured announcement grants and source reference controls instead of JSON textareas', () => {
    const doc = adminDocument();
    const panel = doc.getElementById('panel-announcements');
    expect(panel).toBeTruthy();

    expect(panel!.querySelector('#announcement-admin-required-grants')).toBeNull();
    expect(panel!.querySelector('#announcement-admin-source-ref')).toBeNull();
    expect(panel!.textContent).not.toContain('Required grants JSON');
    expect(panel!.textContent).not.toContain('Source ref JSON');
    expect(panel!.querySelector('#announcement-admin-source-kind option[value="phase_release_note"]')).toBeTruthy();
    expect(panel!.querySelector('#announcement-admin-source-kind option[value="document"]')).toBeNull();
    expect(panel!.querySelector('#announcement-admin-source-kind option[value="chip"]')).toBeNull();
    expect(panel!.querySelector('.announcements-admin-grid')?.children.length).toBe(3);
    expect(panel!.querySelector('.announcement-admin-list-col #announcement-admin-filter-form')).toBeTruthy();
    expect(panel!.querySelector('.announcement-admin-editor-col #announcement-admin-editor')).toBeTruthy();
    expect(panel!.querySelector('.announcement-admin-preview-col #announcement-admin-portal-preview')).toBeTruthy();
    expect(panel!.querySelector('#announcement-admin-editor #announcement-admin-portal-preview')).toBeNull();

    for (const id of [
      'announcement-admin-grant-brands',
      'announcement-admin-grant-product-lines',
      'announcement-admin-grant-chip-ids',
      'announcement-admin-grant-document-ids',
      'announcement-admin-source-kind',
      'announcement-admin-source-id',
      'announcement-admin-source-url',
      'announcement-admin-source-label',
      'announcement-admin-portal-preview'
    ]) {
      expect(panel!.querySelector(`#${id}`)).toBeTruthy();
    }
  });

  it('renders ticket inbox controls for submitted-material download without direct ingestion review UI', () => {
    const doc = adminDocument();
    const panel = doc.getElementById('ticket-admin-center');
    expect(panel).toBeTruthy();

    expect(panel!.querySelector('#ticket-admin-more-filters-toggle')).toBeTruthy();
    expect(panel!.querySelector('#ticket-admin-more-filters')).toBeTruthy();
    expect(panel!.querySelector('#ticket-admin-download-all')).toBeTruthy();
    expect(panel!.querySelector('#ticket-admin-material-notice')).toBeTruthy();
    expect(panel!.querySelector('.ticket-admin-detail-workbench')).toBeTruthy();
    expect(panel!.querySelector('.ticket-admin-conversation')).toBeTruthy();
    expect(panel!.querySelector('.ticket-admin-sidecar')).toBeTruthy();
    expect(panel!.querySelector('.ticket-admin-review-card')).toBeTruthy();
    expect(panel!.textContent).toContain('审核晋升入知识库为未来模块');
    expect(panel!.querySelector('#ticket-admin-datasheet-review')).toBeNull();
    expect(panel!.textContent).not.toContain('芯片候选');
  });

  it('wires the session drawer to the existing analysis endpoint with isolated rendering state', () => {
    const html = readPublicFile('admin.html');
    const js = readPublicFile('admin.js');

    expect(html).toContain('加载更多会话');
    expect(html).toContain('加载更多问题');
    expect(html).toContain('会话转录');
    expect(html).toContain('会话信息');
    expect(html).not.toContain('load more sessions');
    expect(html).not.toContain('load more questions');
    expect(html).not.toContain('Transcript');
    expect(html).not.toContain('Session Info');
    expect(js).toContain('暂无会话转录');
    expect(js).not.toContain('无 transcript');
    expect(html).toContain('id="session-detail-analysis"');
    expect(html).toContain('id="session-detail-analysis-error"');
    expect(html).toContain('id="session-detail-analysis-bubbles"');
    expect(js).toContain('/analysis');
    expect(js).toContain('loadSessionAnalysis');
    expect(js).toContain('renderSessionAnalysis');
    expect(js).toContain('analysisRequestId');
    expect(js).toContain('session-analysis-bubble');
    expect(js).toContain('renderDebugCandidateList');
    expect(js).toContain('renderDebugFileTree');
    expect(js).toContain('renderDebugSimpleList');
    expect(js).not.toContain("pre.textContent = typeof artifact === 'string' ? artifact : JSON.stringify(artifact, null, 2)");
    const css = readPublicFile('styles.css');
    expect(css).toMatch(/\.debug-ft-row\s*\{[^}]*grid-template-columns:\s*18px 1fr auto/s);
    expect(css).toMatch(/\.debug-sl-row\s*\{[^}]*grid-template-columns:\s*18px 1fr/s);
  });

  it('bumps the admin asset version to the FE4 product version', () => {
    expect(readPublicFile('admin.html')).toContain('admin.js?v=2.2.44');
  });
});
