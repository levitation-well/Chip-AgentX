import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('admin users section UX overhaul (2.1.15)', () => {
  it('has a persistent search box and create button toolbar', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('id="user-search"');
    expect(html).toContain('id="user-create-open"');
    expect(html).toContain('class="user-toolbar full-only"');
  });

  it('renders users in a dense master/detail table and keeps filters inline', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('class="admin-users admin-master-detail');
    expect(html).toContain('class="panel user-list-panel user-master-panel admin-master-col"');
    // V17（2.2.28）：密集表统一为 div 包裹（class 挂在外层 div，<table> 自身不再带 admin-dense-table）。
    expect(html).toContain('<div class="admin-dense-table full-only">');
    expect(html).toContain('<table class="user-table" aria-label="用户列表" data-i18n-aria-label="admin.users.listAria">');
    expect(html).toContain('id="user-rail"');
    expect(html).toContain('class="rail-list user-rail-list"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('id="user-detail-close"');
    expect(html).not.toContain('class="user-rail-head rail-head" aria-hidden="true"');
    expect(html).toContain('admin-filterbar');
    expect(html).toContain('<th>积分余额</th>');
    expect(html).toContain('<th>MCP Key</th>');
    expect(html).not.toContain('collapsible-panel user-filter-panel');
    expect(html).not.toContain('collapsible-panel user-create-panel');
  });

  it('keeps the user detail pane inside the same master/detail grid as the rail', () => {
    const html = readPublicFile('admin.html');
    const gridStart = html.indexOf('class="admin-users admin-master-detail');
    const detailStart = html.indexOf('class="admin-user-context user-detail-panel admin-detail-col"');
    const rolesStart = html.indexOf('id="panel-roles"');

    expect(gridStart).toBeGreaterThan(-1);
    expect(detailStart).toBeGreaterThan(gridStart);
    expect(detailStart).toBeLessThan(rolesStart);
  });

  it('moves user creation into a modal shell', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('id="user-create-modal"');
    expect(html).toContain('id="user-create-cancel"');
  });

  it('organises user detail into five FE3 tabs with unified access', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('role="tablist"');
    for (const tab of ['profile', 'access', 'credits', 'keys', 'danger']) {
      expect(html).toContain(`data-user-tab="${tab}"`);
      expect(html).toContain(`id="user-tabpanel-${tab}"`);
    }
    expect(html).toContain('危险操作');
    expect(html).toContain('id="selected-user-access-summary"');
    expect(html).toContain('id="selected-user-access-editor"');
    expect(html).toContain('id="selected-user-access-save"');
    expect(html).not.toContain('id="user-tab-grants"');
    expect(html).not.toContain('id="user-tab-chips"');
    expect(html).not.toContain('id="user-tabpanel-grants"');
    expect(html).not.toContain('id="user-tabpanel-chips"');
    expect(html).not.toContain('collapsible-panel detail-head chip-access-panel');
    expect(html).not.toContain('grant-editor-panel');
  });

  it('loads the shared ui-kit before the current admin asset', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('/ui-kit.js?v=2.2.43');
    expect(html).toContain('/admin.js?v=2.2.44');
    expect(html.indexOf('/ui-kit.js')).toBeLessThan(html.indexOf('/admin.js'));
  });

  it('renders mode routing as the prototype three-card settings workbench', () => {
    const html = readPublicFile('admin.html');
    const css = readPublicFile('styles.css');

    expect(html).toContain('class="admin-mode-routing-grid"');
    for (const mode of ['standard', 'enhanced', 'multimodal']) {
      expect(html).toContain(`data-mode-card="${mode}"`);
      expect(html).toContain(`id="model-routing-${mode}"`);
      // 积分倍率不再写死 ×1.0/×4.0/×8.0，改为按模型档位 creditUnits 动态计算；HTML 只留渲染钩子。
      expect(html).toContain(`id="model-routing-${mode}-multiplier"`);
      expect(html).toContain(`data-mode-multiplier="${mode}"`);
    }
    expect(css).toContain('.admin-mode-routing-grid');
    expect(css).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(css).toContain('.admin-mode-card-multiplier');
  });

  it('computes mode card credit multipliers dynamically from model catalog creditUnits instead of hardcoding them', () => {
    const source = readPublicFile('admin.js');
    expect(source).toContain('function syncModelRoutingMultipliers');
    expect(source).toContain('function findModelCatalogEntry');
    expect(source).toContain('entry.creditUnits / baseUnits');
    expect(source).not.toMatch(/strong>×1\.0<\/strong>/);
    expect(source).not.toContain("'×4.0'");
    expect(source).not.toContain("'×8.0'");
  });

  it('renders role templates as prototype cards with a shared access workbench', () => {
    const html = readPublicFile('admin.html');
    const css = readPublicFile('styles.css');
    const source = readPublicFile('admin.js');

    expect(html).toContain('class="role-split-pane"');
    expect(html).toContain('class="role-list-header"');
    expect(html).toContain('class="role-editor-header"');
    expect(html).toContain('class="role-core-grid"');
    expect(html).toContain('id="role-access-editor" class="admin-access-editor"');
    expect(css).toContain('grid-template-columns: minmax(280px, 300px) minmax(0, 1fr)');
    expect(css).toContain('.role-row.selected');
    expect(css).toContain('.role-card-foot');
    expect(source).toContain("row.className = `role-row${name === roleState.editingRole ? ' selected' : ''}`");
    expect(source).toContain("head.className = 'role-card-head'");
    expect(source).not.toContain("row.append(summary, countSpan, editBtn, deleteBtn)");
  });
});

describe('admin.js users UX overhaul (2.1.15)', () => {
  it('wires search, tabs, shared access editor and AgentXUI feedback', () => {
    const source = readPublicFile('admin.js');
    expect(source).toContain("getElementById('user-search')");
    expect(source).toContain('activateUserTab');
    expect(source).toContain('function renderAccessEditor(');
    expect(source).toContain('function renderAccessChipList(');
    expect(source).toContain('AgentXUI.toast(');
    expect(source).toContain('AgentXUI.confirm(');
  });

  it('no longer uses a native confirm for user deletion', () => {
    const source = readPublicFile('admin.js');
    expect(source).not.toMatch(/confirm\(`删除用户/);
  });

  it('filters users by search keyword across username/email/company', () => {
    const source = readPublicFile('admin.js');
    expect(source).toContain('filters.search');
  });

  it('renders the selected-user state through a real rail instead of compacting the table', () => {
    const source = readPublicFile('admin.js');
    expect(source).toContain("getElementById('user-rail')");
    expect(source).toContain("getElementById('user-detail-close')");
    expect(source).toContain("className = 'rail-item user-compact-item user-info-btn'");
    expect(source).toContain("railItem.setAttribute('role', 'option')");
    expect(source).toContain("railItem.setAttribute('aria-selected'");
    expect(source).toContain('meta.textContent = user.role');
    expect(source).toContain('!visibleUsers.some((user) => user.id === state.selectedUserId)');
    expect(source).toContain('function closeUserDetail()');
    expect(source).not.toContain('user-row-compact');
    expect(source).not.toContain('compactCell.colSpan');
    expect(source).not.toContain('state.selectedUserId = state.users[0].id');
  });

  it('freezes the access editor for admin users at runtime (admins hold all permissions)', () => {
    const source = readPublicFile('admin.js');
    expect(source).toContain("getElementById('selected-user-access-save')");
    expect(source).toContain('renderSelectedUserAccess');
    expect(source).toContain('isAdminUser(user)');
  });
});


describe('admin users section layout stability (2.2.8)', () => {
  it('keeps /admin/sections/users as a bounded two-column workspace without page overflow', () => {
    const css = readPublicFile('styles.css');

    const adminGridBlock = /\.admin-grid \{\r?\n  min-width: 0;[\s\S]*?\r?\n\}/.exec(css)?.[0] || '';
    const masterDetailStart = css.indexOf('.admin-master-detail.detail-open {');
    const masterDetailBlock = css.slice(masterDetailStart, css.indexOf('}', masterDetailStart));
    const usersStart = css.indexOf('.users-section {');
    const usersBlock = css.slice(usersStart, css.indexOf('}', usersStart));
    const tableStart = css.indexOf('.user-table {');
    const tableBlock = css.slice(tableStart, css.indexOf('}', tableStart));

    expect(adminGridBlock).toContain('height: calc(100vh');
    expect(adminGridBlock).toContain('min-width: 0');
    expect(adminGridBlock).toContain('overflow: hidden');
    expect(usersBlock).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(usersBlock).toContain('overflow: visible');
    expect(masterDetailBlock).toContain('grid-template-columns: minmax(280px, 340px) minmax(0, 1fr)');
    expect(css).toContain('.user-master-panel');
    expect(css).toContain('.user-detail-panel');
    // C6：去 table-layout:fixed + 省略号截断，改内容驱动列宽 + 横向滚动（.admin-dense-table 的 overflow:auto
    // 承载滚动），保证 1440px 下用户名/公司不被截断；改用测滚动能力而非固定列宽夹断内容。
    expect(tableBlock).not.toContain('table-layout: fixed');
    const denseTableStart = css.indexOf('.admin-dense-table {');
    const denseTableBlock = css.slice(denseTableStart, css.indexOf('}', denseTableStart));
    expect(denseTableBlock).toContain('overflow: auto');
    expect(css).toContain('.admin-master-detail.detail-open .full-only');
    expect(css).toContain('.admin-master-detail.detail-open .user-rail-list');
    expect(css).toContain('.user-compact-item[aria-selected="true"]');
    expect(css).toContain('#selected-user-profile-form .user-profile-actions');
    expect(css).toContain('grid-template-columns: 140px minmax(0, 1fr)');
    expect(css).not.toContain('.users-section.detail-open .user-table thead');
  });
});
