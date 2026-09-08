import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('account UX overhaul (2.2.29)', () => {
  it('uses the B-primary C-secondary account console information architecture', () => {
    const html = readPublicFile('account.html');
    expect(html).toContain('data-account-view="overview"');
    expect(html).toContain('data-account-view="access"');
    expect(html).toContain('data-account-view="credits"');
    expect(html).toContain('data-account-view="profile"');
    expect(html).toContain('data-account-view="security"');
    expect(html).toContain('data-account-view="preferences"');
    expect(html).toContain('data-account-view-panel="overview"');
    expect(html).toContain('class="account-overview-grid"');
    expect(html).toContain('更多自助能力');
    expect(html).toContain('规划中');
    expect(html).not.toMatch(/新手引导|完成度|下一步|account-onboarding|data-onboarding/);
  });

  it('keeps every existing account CRUD mount point inside a detail panel', () => {
    const html = readPublicFile('account.html');
    for (const id of [
      'account-profile-form',
      'account-password-form',
      'account-locale',
      'account-mode-list',
      'account-resource-list',
      'account-policy-list',
      'account-key-form',
      'account-key-list',
      'account-credits-list'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('does not ship onboarding or synthetic credits chart markup', () => {
    const html = readPublicFile('account.html');
    const source = readPublicFile('account.js');
    expect(`${html}\n${source}`).not.toMatch(/account-onboarding|\/api\/account\/onboarding|account-credit-chart|chart-bar/);
  });

  it('styles the account console with shared skin tokens and hidden panels', () => {
    const css = readPublicFile('styles.css');
    expect(css).toContain('.account-overview-grid');
    expect(css).toContain('grid-template-columns: repeat(12, minmax(0, 1fr))');
    expect(css).toContain('.account-view-panel[hidden]');
    expect(css).toContain('display: none');
    const consoleRules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .filter((match) => /account-(?:overview|view-panel|access-grid|settings-grid|planning)/.test(match[1] || ''))
      .map((match) => match[0])
      .join('\n');
    expect(consoleRules).toContain('var(--skin-radius');
    expect(consoleRules).toContain('var(--account-inset-radius)');
    expect(consoleRules).toContain('var(--surface');
    expect(consoleRules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(consoleRules).not.toMatch(/border-radius:\s*\d/);
  });

  it('uses portal skin tokens for the account sync error badge', () => {
    const css = readPublicFile('styles.css');
    const rule = css.match(/\.account-shell \.status-badge\.error,\s*\.account-shell \.status-badge\.error-line\s*\{[^}]+\}/s)?.[0] || '';
    expect(rule).toContain('var(--danger)');
    expect(rule).toContain('var(--surface)');
    expect(rule).toContain('var(--border)');
    expect(rule).not.toContain('--admin-');
  });

  it('resets button chrome and stacks the grouped account navigation on narrow screens', () => {
    const css = readPublicFile('styles.css');
    expect(css).not.toContain('.account-workbench.nav-collapsed');
    expect(css).not.toContain('.account-sidenav-toggle');
    expect(css).toMatch(/\.account-sidenav-link\s*\{[^}]*border:\s*0[^}]*background:\s*transparent[^}]*cursor:\s*pointer/s);
    const mobileStart = css.indexOf('@media (max-width: 719px)');
    expect(mobileStart).toBeGreaterThan(-1);
    const mobileRules = css.slice(mobileStart, mobileStart + 1800);
    expect(mobileRules).toMatch(/\.account-sidenav\s*\{[^}]*flex-direction:\s*column[^}]*overflow-x:\s*hidden/s);
    expect(mobileRules).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
  });

  it('uses the shared portal workspace shell and topbar contract', () => {
    const html = readPublicFile('account.html');
    expect(html).toContain('<body class="landing-page portal-page portal-workspace-page">');
    expect(html).toContain('class="app-shell account-shell portal-shell"');
    expect(html).not.toContain('class="app-shell account-shell portal-shell shell-mk"');
    expect(html).toContain('class="landing-topbar portal-topbar float-nav"');
    expect(html).toContain('<a class="landing-brand brand" href="/home"');
    expect(html).toContain('data-product-name');
    expect(html).toContain('class="landing-nav portal-nav"');
    expect(html).toContain('<span data-portal-nav></span>');
    expect(html).toContain('class="portal-skin-slot" data-agentx-skin-root');
    expect(html).not.toContain('class="product-signature-top"');
    expect(html).not.toContain('data-product-signature');

    const css = readPublicFile('styles.css');
    expect(css).toMatch(/\.account-workbench\s*\{[^}]*width:\s*min\(1120px, calc\(100% - 40px\)\)[^}]*margin:\s*0 auto/s);
    expect(css).toMatch(/\.account-shell\s*\{[^}]*width:\s*100%[^}]*background:\s*transparent/s);
    expect(css).toMatch(/@media \(max-width: 980px\)[\s\S]*\.portal-auth-slot\s*\{[^}]*position:\s*sticky[^}]*left:\s*0[^}]*order:\s*-1/s);
  });

  it('uses body scrolling with a lightweight viewport-sticky side navigation', () => {
    const css = readPublicFile('styles.css');
    const accountShellRules = [...css.matchAll(/\.account-shell\s*\{[^}]*\}/g)].map((match) => match[0]).join('\n');
    const workbenchRule = css.match(/\.account-workbench\s*\{[^}]*\}/s)?.[0] || '';
    const sidenavRule = css.match(/\.account-sidenav\s*\{[^}]*\}/s)?.[0] || '';

    expect(accountShellRules).toContain('height: auto');
    expect(accountShellRules).toContain('min-height: 100vh');
    expect(accountShellRules).toContain('align-content: start');
    expect(accountShellRules).toContain('overflow: visible');
    expect(accountShellRules).not.toMatch(/(?:^|\n)\s*height:\s*100vh|overflow:\s*hidden/);
    expect(workbenchRule).not.toMatch(/overflow-y:\s*auto/);
    expect(sidenavRule).toMatch(/position:\s*sticky/);
    expect(sidenavRule).toMatch(/top:\s*90px/);
    expect(sidenavRule).toMatch(/max-height:\s*calc\(100vh - 104px\)/);
    expect(sidenavRule).toMatch(/border:\s*0/);
    expect(sidenavRule).toMatch(/background:\s*transparent/);
    expect(sidenavRule).toMatch(/box-shadow:\s*none/);
    expect(css).toMatch(/\.account-sidenav-link\.active\s*\{[^}]*background:\s*var\(--accent-subtle\)[^}]*color:\s*var\(--accent\)/s);
  });

  it('shows available modes in permissions without exposing authorized models', () => {
    const html = readPublicFile('account.html');
    const source = readPublicFile('account.js');
    expect(html).toContain('可用模式');
    expect(html).toContain('id="account-mode-list"');
    expect(html).not.toContain('授权模型');
    expect(html).not.toContain('id="account-model-list"');
    expect(source).toContain('modeList: document.getElementById(\'account-mode-list\')');
    expect(source).toContain('renderAvailableModes');
    expect(source).not.toContain('renderPills(els.modelList');
    expect(source).not.toContain('permissions.authorizedModels');
  });

  it('lays out access policy cards above a full-width resource summary', () => {
    const html = readPublicFile('account.html');
    const css = readPublicFile('styles.css');
    const document = new JSDOM(html).window.document;
    const grid = document.querySelector('.account-access-grid');
    const resourceList = document.querySelector('#account-resource-list');
    const resourceCard = resourceList?.closest('article');

    expect(grid?.querySelectorAll(':scope > article')).toHaveLength(2);
    expect(grid?.querySelector('#account-mode-list')).not.toBeNull();
    expect(grid?.querySelector('#account-policy-list')).not.toBeNull();
    expect(grid?.querySelector('#account-resource-list')).toBeNull();
    expect(resourceCard?.previousElementSibling).toBe(grid);
    expect(resourceCard?.nextElementSibling?.classList.contains('account-keys-panel')).toBe(true);
    expect(css).toMatch(/\.account-access-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*align-items:\s*start/s);
  });

  it('keeps account component colors tokenized instead of hardcoding the old green palette', () => {
    const css = readPublicFile('styles.css');
    const accountRules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)]
      .filter((match) => match[1]?.includes('account-'))
      .map((match) => match[0])
      .join('\n');
    expect(accountRules).not.toMatch(/#(?:0D504A|E6F4F1|B7D9D2|F2FBF8|FAFBFC)\b/i);
    expect(accountRules).toContain('var(--card-inset-bg)');
    expect(accountRules).toContain('var(--accent-subtle)');
    expect(accountRules).toContain('var(--secret-panel-bg)');
  });

  it('keeps the account pill contract via the shared capsule base plus one density variant rule', () => {
    const css = readPublicFile('styles.css');
    // V2.2.43 Wave2-E: capsule shape (inline-flex/center/pill radius) lives in the shared
    // pill base selector group; the standalone .account-pill rule keeps density only.
    const baseRule = [...css.matchAll(/([^{}]*\.account-pill[^{}]*)\{([^}]*)\}/g)]
      .map((match) => match[0])
      .find((rule) => /display:\s*inline-flex/.test(rule));

    expect(baseRule).toBeTruthy();
    expect(baseRule).toMatch(/align-items:\s*center/);
    expect(baseRule).toMatch(/border-radius:\s*var\(--radius-pill\)/);

    const pillRules = [...css.matchAll(/\.account-pill\s*\{[^}]*\}/g)].map((match) => match[0]);
    expect(pillRules).toHaveLength(1);
    expect(pillRules[0]).toMatch(/min-height:\s*28px/);
    expect(pillRules[0]).toMatch(/padding:\s*0 10px/);
    expect(pillRules[0]).toMatch(/font-size:\s*12\.5px/);
    expect(pillRules[0]).toMatch(/font-weight:\s*800/);
  });

  it('keeps the shared status badge legible outside the Admin theme scope', () => {
    const css = readPublicFile('styles.css');
    const baseRule = css.match(/\.status-badge\s*\{[^}]*\}/s)?.[0] || '';

    expect(baseRule).toMatch(/color:\s*var\(--muted\)/);
    expect(baseRule).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(baseRule).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });

  it('replaces the hero with a compact page head', () => {
    const html = readPublicFile('account.html');
    expect(html).toContain('account-pagehead');
    expect(html).not.toContain('account-hero-avatar');
    expect(html).not.toContain('class="account-hero"');
  });

  it('keeps sync status and refresh action together in the compact page head', () => {
    const html = readPublicFile('account.html');
    const css = readPublicFile('styles.css');
    const document = new JSDOM(html).window.document;
    const actions = document.querySelector('.account-pagehead-actions');
    const status = actions?.querySelector('#account-status.status-badge');
    const refresh = actions?.querySelector('#account-refresh');

    expect(status).not.toBeNull();
    expect(refresh).not.toBeNull();
    expect(status?.nextElementSibling).toBe(refresh);
    expect(css).toMatch(/\.account-shell \.status-badge\.error,\s*\.account-shell \.status-badge\.error-line\s*\{[^}]*color:\s*var\(--danger\)/s);
  });

  it('drops the placeholder login-status panel', () => {
    const html = readPublicFile('account.html');
    expect(html).not.toContain('登录状态与会话信息见上方账号摘要');
    expect(html).not.toContain('account-cols-2');
  });

  it('groups the profile form into 基本信息 / 关注方向', () => {
    const html = readPublicFile('account.html');
    expect(html).toContain('account-form-group-title');
    expect(html).toContain('基本信息');
    expect(html).toContain('关注方向');
  });

  it('loads ui-kit before account.js with current account assets', () => {
    const html = readPublicFile('account.html');
    expect(html).toContain('/ui-kit.js?v=2.2.43');
    expect(html).toContain('/styles.css?v=2.2.45');
    expect(html).toContain('/account.js?v=2.2.44');
    expect(html.indexOf('/ui-kit.js')).toBeLessThan(html.indexOf('/account.js'));
  });

  it('keeps the mobile portal header inside its rounded container', () => {
    const css = readPublicFile('styles.css');
    const mobileStart = [...css.matchAll(/@media \(max-width: 720px\)/g)]
      .map((match) => match.index)
      .find((index) => css.slice(index, index + 1800).includes('grid-template-columns: auto minmax(0, 1fr);')) ?? -1;
    const mobileRules = css.slice(mobileStart, mobileStart + 1800);

    expect(mobileStart).toBeGreaterThan(-1);
    expect(mobileRules).toContain('grid-template-columns: auto minmax(0, 1fr)');
    expect(mobileRules).toMatch(/\.portal-nav[^{]*\{[^}]*grid-column:\s*1 \/ -1[^}]*grid-row:\s*2[^}]*max-width:\s*100%[^}]*scrollbar-width:\s*none/s);
    expect(mobileRules).toMatch(/\.portal-nav::\-webkit-scrollbar[^}]*\{\s*display:\s*none/s);
  });

  it('stacks unequal key difference groups and compacts resources within each group', () => {
    const css = readPublicFile('styles.css');

    expect(css).toMatch(/\.account-key-difference-grid\s*\{[^}]*grid-template-columns:\s*1fr[^}]*gap:\s*14px/s);
    expect(css).toMatch(/\.account-key-difference-list\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
    expect(css).toMatch(/@media \(max-width: 719px\)[\s\S]*\.account-key-difference-list\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });
});

describe('account.js UX overhaul (2.1.15)', () => {
  it('drops native prompt/confirm in favour of AgentXUI dialogs', () => {
    const source = readPublicFile('account.js');
    expect(source).not.toContain('window.prompt(');
    expect(source).not.toContain('window.confirm(');
    expect(source).toContain('AgentXUI.prompt(');
    expect(source).toContain('AgentXUI.confirm(');
  });

  it('emits toast feedback', () => {
    const source = readPublicFile('account.js');
    expect(source).toContain('AgentXUI.toast(');
  });

  it('renders the credits ledger as a table with status badges', () => {
    const source = readPublicFile('account.js');
    expect(source).toContain('account-ledger-table');
    expect(source).toContain('ledger-status');
  });
});
