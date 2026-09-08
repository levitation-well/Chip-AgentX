import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http-server.js';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function readDistFile(name: string) {
  return readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8');
}

function readDocFile(name: string) {
  return readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
}

function expectNoCustomerInternalPaths(value: string) {
  expect(value).not.toContain('/opt/');
  expect(value).not.toContain('D:\\');
  expect(value).not.toContain('workspaceDir');
  expect(value).not.toContain('knowledgeBaseRoot');
}

async function startServer() {
  const server = createHttpServer({ auth: { enabled: false } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

const cloudProxyExactPaths = [
  '/home',
  '/home.html',
  '/login',
  '/chat',
  '/admin',
  '/account',
  '/account.html',
  '/mcp-access',
  '/mcp-access.html',
  '/mcp-client',
  '/mcp-client.html',
  '/feedback',
  '/feedback.html',
  '/datasheet-submit',
  '/datasheet-submit.html',
  '/updates',
  '/updates.html',
  '/join-application',
  '/join-application.html',
  '/tickets',
  '/tickets.html',
  '/ticket-system',
  '/donation-support',
  '/donation-support.html',
  '/health',
  '/rpc',
  '/mcp',
  '/chips',
  '/styles.css',
  '/auth.js',
  '/chat.js',
  '/admin.js',
  '/account.js',
  '/ui-kit.js',
  '/announcements.js',
  '/i18n.js',
  '/mcp-access.js',
  '/updates.js',
  '/product-shell.js',
  '/tickets.js'
] as const;

const cloudProxyPrefixPaths = [
  '/admin/',
  '/api/',
  '/auth/',
  '/sessions',
  '/mcp/',
  '/mcp-templates/',
  '/downloads/',
  '/assets/'
] as const;

function normalizeLocalHref(href: string): string | null {
  if (!href.startsWith('/') || href.startsWith('//')) {
    return null;
  }
  return href.split(/[?#]/, 1)[0];
}

function isCloudProxiedAgentXPath(pathname: string): boolean {
  return (
    cloudProxyExactPaths.includes(pathname as (typeof cloudProxyExactPaths)[number]) ||
    cloudProxyPrefixPaths.some((prefix) => pathname.startsWith(prefix))
  );
}

describe('web ui assets', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  it('defines the login page structure', () => {
    const html = readPublicFile('login.html');

    expect(html).toContain('<title>AgentX · 登录</title>');
    expect(html).toContain('AgentX');
    expect(html).toContain('float-nav');
    expect(html).toContain('data-portal-nav');
    expect(html).toContain('data-agentx-skin-root');
    expect(html).toContain('data-portal-auth');
    expect(html).toContain('id="login-form"');
    expect(html).toContain('id="username"');
    expect(html).toContain('id="password"');
    expect(html).toContain('登录 AgentX');
    expect(html).toContain('id="login-error"');
    expect(html).toContain('/auth.js');
    expect(html).toContain('/product-shell.js');
    expect(html).toContain('safeRedirectTarget');
    expect(html).toContain("|| '/home'");
  });

  it('defines the public landing shell structure', () => {
    const html = readPublicFile('index.html');
    const productShell = readPublicFile('product-shell.js');

    expect(html).toContain('AgentX · 工程资料平台');
    expect(html).toContain('href="/home"');
    expect(html).toContain('float-nav');
    expect(html).toContain('shell-mk');
    expect(html).toContain('资料');
    // 门户导航改由 product-shell.js 单一数据源渲染，首页仅保留 [data-portal-nav] 槽位。
    expect(html).toContain('data-portal-nav');
    expect(productShell).toContain("{ href: '/home', key: 'portal.nav.home', label: '首页' }");
    expect(productShell).toContain("{ href: '/chat', key: 'portal.nav.chat', label: '对话' }");
    expect(productShell).not.toContain("{ href: '/account', key: 'portal.nav.account', label: '用户中心' }");
    expect(productShell).toContain("{ href: '/mcp-access', key: 'portal.nav.mcp', label: 'MCP' }");
    expect(productShell).toContain("{ href: '/tickets', key: 'portal.nav.tickets', label: '工单' }");
    expect(productShell).toContain("{ href: '/feedback', key: 'portal.nav.feedback', label: '反馈' }");
    expect(productShell).toContain("{ href: '/datasheet-submit', key: 'portal.nav.materials', label: '资料' }");
    expect(productShell).toContain("{ href: '/updates', key: 'portal.nav.updates', label: '新闻' }");
    expect(productShell).toContain("{ href: '/join-application', key: 'portal.nav.join', label: '加入申请' }");
    expect(html).toContain('/join-application');
    expect(html).toContain('/login');
    expect(html).toContain('data-portal-auth');
    expect(html).toContain('/styles.css?v=2.2.45');
    expect(html).toContain('/assets/agentx-webui.css?v=2.2.43');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).toContain('/assets/agentx-webui.js?v=2.2.43');
    expect(html).toContain('/home');
    expect(html).toContain('data-product-version');
    expect(html).toContain('data-product-signature');
    expect(html).toContain('data-product-fingerprint');
    expect(html).toContain('data-product-changelog');
    expect(html).toContain('data-announcements-home');
    expect(html).toContain('data-announcements-home-feed');
    expect(html).toContain('data-announcement-modal');
    expect(html).toContain('/announcements.js?v=2.2.42');
    expect(html).toContain('MCP 接入');
    expect(html).toContain('资料提交');
    expect(html).toContain('芯片问答');
    expect(html).toContain('驱动开发辅助');

    const homeCss = readPublicFile('styles.css');
    expect(homeCss).toContain('body.portal-page .portal-hero-actions .landing-button {');
    expect(homeCss).toContain('body.portal-page .portal-capabilities-section .portal-section-title {');
    expect(html).toContain('AUTOSAR');
    expect(html).toContain('UDS');
    expect(html).toContain('OTA');
    expect(html).toContain('支持平台');
    expect(html).toContain('href="/donation-support"');
    expect(html).toContain('class="donation-footer-link"');
    expect(html).toContain('data-donation-float');
    expect(html).toContain('data-donation-float-note');
    expect(html).not.toContain('href="#updates"');
    expect(html).not.toContain('id="donation-soon"');
    expect(html).not.toContain('公开协作入口');
    expect(html).not.toContain('id="operations"');
    expect(html).not.toContain('portal-operations');
    expect(html).not.toContain('id="login-form"');
  });

  it('renderPortalNav keeps User Center out of the unified eight-link portal nav', () => {
    const source = readPublicFile('product-shell.js');
    const dom = new JSDOM(
      '<!doctype html><html><body><nav class="topbar-nav" data-portal-nav></nav></body></html>',
      { url: 'http://localhost/account', runScripts: 'dangerously' }
    );
    dom.window.eval(source);
    const doc = dom.window.document;
    const links = [...doc.querySelectorAll('[data-portal-nav] a.portal-nav-link')];

    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/home',
      '/chat',
      '/mcp-access',
      '/tickets',
      '/feedback',
      '/datasheet-submit',
      '/updates',
      '/join-application'
    ]);
    const active = doc.querySelector('[data-portal-nav] a[aria-current="page"]');
    expect(active).toBeNull();
  });

  it('renderPortalNav marks the link matching the current path as active', () => {
    const source = readPublicFile('product-shell.js');
    const dom = new JSDOM(
      '<!doctype html><html><body><span data-portal-nav></span></body></html>',
      { url: 'http://localhost/tickets', runScripts: 'dangerously' }
    );
    dom.window.eval(source);
    const doc = dom.window.document;
    const active = [...doc.querySelectorAll('[data-portal-nav] a[aria-current="page"]')];

    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute('href')).toBe('/tickets');
    expect(active[0]?.classList.contains('active')).toBe(true);
  });

  it('keeps logged-in pages connected back to the public portal', () => {
    const chat = readPublicFile('chat.html');
    const admin = readPublicFile('admin.html');
    const auth = readPublicFile('auth.js');
    const productShell = readPublicFile('product-shell.js');

    expect(chat).toContain('data-portal-nav');
    expect(chat).toContain('data-portal-auth');
    expect(chat).toContain('data-agentx-skin-root');
    // Admin uses a reduced shell: one portal return link plus the shared account capsule.
    expect(admin).not.toContain('data-portal-nav');
    expect(admin).toContain('class="admin-return-link"');
    expect(admin).toContain('data-product-version');
    expect(productShell).toContain("{ href: '/home', key: 'portal.nav.home', label: '首页' }");
    expect(productShell).toContain("{ href: '/tickets', key: 'portal.nav.tickets', label: '工单' }");
    expect(auth).toContain('loginUrlForCurrentPage');
    expect(auth).toContain('next=');
    expect(productShell).toContain('data-portal-auth');
    expect(productShell).toContain('portal-user-menu');
    expect(productShell).toContain('portal-user-trigger');
    expect(productShell).toContain("accountLink.textContent = i18n('portal.auth.account', '用户中心')");
    expect(productShell).toContain("adminLink.textContent = i18n('portal.auth.admin', '账户管理')");
    expect(productShell).toContain('/donation-support');
  });

  it('defines the public ticket system page structure and versioned assets', () => {
    const html = readPublicFile('tickets.html');
    const script = readPublicFile('tickets.js');

    expect(html).toContain('AgentX · 工单系统');
    expect(html).toContain('id="ticket-query-form"');
    expect(html).not.toContain('badge gray">脱敏');
    expect(html).toContain('id="ticket-no-input"');
    expect(html).toContain('id="ticket-query-result"');
    expect(html).toContain('id="ticket-query-error"');
    expect(html).toContain('id="ticket-system-layout"');
    expect(html).toContain('id="ticket-system-side"');
    expect(html).toContain('id="ticket-sidebar-toggle"');
    expect(html).not.toContain('id="feedback-ticket-form"');
    expect(html).toContain('id="my-tickets-list"');
    expect(html).toContain('id="my-tickets-status"');
    expect(html).not.toContain('id="datasheet-ticket-form"');
    expect(html).not.toContain('name="partNumberOrKeywords"');
    expect(html).not.toContain('name="sourceNote"');
    expect(html).not.toContain('id="datasheet-attachments"');
    expect(html).not.toContain('datasheet-submit-soon');
    expect(html).not.toContain('name="datasheetCategory"');
    expect(html).not.toContain('资料分类');
    expect(html).not.toContain('id="account-application-form"');
    expect(html).not.toContain('id="account-application-status"');
    expect(html).not.toContain('id="donation-support"');
    expect(html).not.toContain('data-donation-root');
    expect(html).not.toContain('data-donation-status');
    expect(html).not.toContain('捐赠支持');
    expect(html).not.toContain('用于服务器、存储、资料处理、AI token 和网站维护');
    expect(html).toContain('/styles.css?v=2.2.45');
    expect(html).toContain('/assets/agentx-webui.css?v=2.2.43');
    expect(html).toContain('/auth.js?v=2.2.42');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).toContain('/assets/agentx-webui.js?v=2.2.43');
    expect(html).toContain('/tickets.js?v=2.2.43');
    expect(html).not.toContain('<select name="category"');
    expect(script).toContain('new FormData');
    expect(script).toContain('/api/tickets/feedback');
    expect(script).toContain('/api/tickets/datasheet');
    expect(script).toContain('/api/tickets/account-application');
    expect(script).toContain('account-application-form');
    expect(script).toContain('account-application-status');
    expect(script).toContain("passwordInput.value = ''");
    expect(script).toContain('datasheet-ticket-form');
    expect(script).toContain('datasheet-attachments');
    expect(script).toContain("i18n('tickets.validation.fileRequired')");
    expect(script).toContain('Authorization');
    expect(script).toContain('/api/tickets/');
    expect(script).toContain('/public');
    expect(script).toContain('/api/my/tickets');
    expect(script).toContain('agentx.tickets.sidebarCollapsed');
    expect(script).toContain('initTicketSidebarCollapse');
    expect(script).toContain('maxFiles = 3');
    expect(script).toContain('100 * 1024 * 1024');
    expect(script).toContain('in_development');
    expect(script).toContain('launched');
    expect(script).toContain('deferred');
    expect(script).not.toContain('in_progress');
    expect(script).not.toContain('released');
    expect(script).not.toContain('internalNote');
    expect(script).not.toContain('storagePath');
    expect(script).not.toContain('originalName');
    expect(script).not.toContain('payload');
    expect(script).not.toContain('datasheetCategory');
    expect(script).not.toContain('/api/donation');
  });

  it('defines the standalone donation support page', () => {
    const html = readPublicFile('donation-support.html');

    expect(html).toContain('AgentX · 捐赠支持');
    expect(html).toContain('id="donation-support"');
    expect(html).toContain('data-donation-root');
    expect(html).toContain('data-donation-status');
    expect(html).toContain('你的支持将用于服务器、存储与日常运维。');
    expect(html).toContain('所有支持将直接用于平台的服务器、存储和内容维护。');
    expect(html).not.toContain('用于服务器、存储、资料处理、AI token 和网站维护');
    expect(html).not.toContain('第一版只展示二维码或跳转链接，不会自动确认支付状态');
    for (const amount of ['5 元', '10 元', '30 元', '50 元', '100 元', '自定义']) {
      expect(html).toContain(amount);
    }
    for (const value of ['5', '10', '30', '50', '100', 'custom']) {
      expect(html).toContain(`name="donationAmount" value="${value}"`);
    }
    expect(html).toContain('data-donation-custom-amount');
    expect(html).toContain('data-donation-qr="alipay"');
    expect(html).toContain('data-donation-link="alipay"');
    expect(html).toContain('data-donation-unavailable="alipay"');
    expect(html).toContain('data-donation-qr="wechat"');
    expect(html).toContain('data-donation-link="wechat"');
    expect(html).toContain('data-donation-unavailable="wechat"');
    expect(html).toContain('暂未开放');
    expect(html).not.toContain('id="donation-soon"');
    expect(html).toContain('/styles.css?v=2.2.45');
    expect(html).toContain('/assets/agentx-webui.css?v=2.2.43');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).toContain('/assets/agentx-webui.js?v=2.2.43');
  });

  it('defines split public workflow pages', () => {
    const feedback = readPublicFile('feedback.html');
    const datasheet = readPublicFile('datasheet-submit.html');
    const application = readPublicFile('join-application.html');

    expect(feedback).toContain('id="feedback-ticket-form"');
    expect(feedback).toContain('id="feedback-attachments"');
    expect(feedback).toContain('accept=".pdf,.zip,.7z,.md,.markdown,.txt,.c,.h,.cs,.cpp,.cxx,.cc,.hpp,.hh"');
    expect(feedback).not.toContain('id="ticket-query-form"');
    expect(feedback).not.toContain('id="datasheet-ticket-form"');
    expect(feedback).not.toContain('id="account-application-form"');

    expect(datasheet).toContain('id="datasheet-ticket-form"');
    expect(datasheet).toContain('name="partNumberOrKeywords"');
    expect(datasheet).toContain('name="sourceNote"');
    expect(datasheet).toContain('id="datasheet-attachments"');
    expect(datasheet).not.toContain('name="datasheetCategory"');
    expect(datasheet).not.toContain('id="ticket-query-form"');
    expect(datasheet).not.toContain('id="feedback-ticket-form"');
    expect(datasheet).not.toContain('id="account-application-form"');

    expect(application).toContain('id="account-application-form"');
    expect(application).toContain('portal-workspace-page reference-page');
    expect(application).toContain('id="account-application-status"');
    expect(application).toContain('name="username"');
    expect(application).toContain('name="password"');
    expect(application).toContain('name="company"');
    expect(application).toContain('name="reason"');
    expect(application).not.toContain('id="ticket-query-form"');
    expect(application).not.toContain('id="feedback-ticket-form"');
    expect(application).not.toContain('id="datasheet-ticket-form"');

    for (const html of [feedback, datasheet, application]) {
      expect(html).toContain('data-portal-auth');
      expect(html).toContain('/auth.js?v=2.2.42');
      expect(html).toContain('/product-shell.js?v=2.2.42');
      expect(html).toContain('/tickets.js?v=2.2.43');
      expect(html).toContain('data-portal-nav');
    }
  });

  it('defines the public updates page with split news reading layout', () => {
    const html = readPublicFile('updates.html');
    const script = readPublicFile('updates.js');

    expect(html).toContain('AgentX · 新闻与更新');
    expect(html).toContain('data-updates-root');
    expect(html).toContain('data-updates-list');
    expect(html).toContain('data-updates-detail');
    expect(html).toContain('updates-split-layout');
    expect(html).toContain('data-portal-nav');
    expect(html).toContain('data-agentx-skin-root');
    expect(html).toContain('data-portal-auth');
    expect(html).toContain('/updates.js?v=2.2.43');
    expect(script).not.toContain('v1-8-mcp-security');
    expect(script).not.toContain('englishUpdates');
    expect(script).toContain('/api/announcements/feed');
    expect(script).toContain('history.replaceState');
    expect(script).toContain('data-updates-filter');
    expect(script).toContain('try {');
    expect(script).toContain('items.some((item) => item.id === id)');

    const css = readPublicFile('styles.css');
    expect(css).toContain('body.reference-page .ann-fbtn.active,');
    expect(css).toContain('body.reference-page .updates-filter-button.active {');
    expect(css).toContain('.step p .code-inline {');
    expect(css).toContain('body.reference-page label.choice.checkbox-line {');
    expect(css).toContain('#ticket-query-form .field {');
    expect(css).toContain('#ticket-query-form .primary-button {');
  });

  it('defines the public MCP client setup page and templates', () => {
    const html = readPublicFile('mcp-access.html');
    const script = readPublicFile('mcp-access.js');
    const opencode = readPublicFile('mcp-templates/opencode.json');
    const codex = readPublicFile('mcp-templates/codex.md');
    const claudeCode = readPublicFile('mcp-templates/claude-code.md');
    const spawn = readPublicFile('mcp-templates/agent-spawn.example.json');
    const opencodeConfig = JSON.parse(opencode);
    const spawnArgs = JSON.parse(spawn);
    expect(html).toContain('MCP 接入中心');
    expect(html).toContain('class="landing-page portal-workspace-page mcp-access-page reference-page"');
    expect(html).toContain('class="page landing-shell portal-workspace-shell shell-mk"');
    expect(html).toContain('class="portal-workspace-main reference-main"');
    expect(html).toContain('id="mcp-access-key-list"');
    expect(html).toContain('id="mcp-access-template-code"');
    expect(html).toContain('未登录时仅显示公共接入信息。登录后可查看 Key、授权模型与资源详情。');
    expect(html).toContain('opencode');
    expect(html).toContain('Codex');
    expect(html).toContain('Claude Code');
    expect(html).toContain('agentx_whoami');
    expect(html).toContain('permissions.resources[].id');
    expect(html).toContain('chipId');
    expect(script).toContain('/api/mcp/access-center');
    expect(script).toContain('AGENTX_MCP_KEY');
    expect(script).toContain('maskedKey');
    expect(script).toContain('fingerprint');
    expect(script).toContain('keySummaries');
    expect(script).toContain('availableKeys');
    expect(html).toContain('/mcp-templates/opencode.json');
    expect(html).not.toContain('mcp-access-security-panel');
    expect(html).not.toContain('mcp-access-security-notes');
    expect(script).not.toContain('renderSecurityNotes');
    expect(script).not.toContain('securityNotes');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).toContain('/mcp-access.js?v=2.2.45');
    expect(html).toContain('/assets/agentx-webui.js?v=2.2.43');
    expect(html).not.toContain('/assets/agentx-newwebui.css');
    expect(html).not.toContain('landing-hero');
    expect(html).not.toContain('Bearer &lt;MCP_KEY&gt;');
    expect(opencodeConfig).toHaveProperty('mcp');
    expect(opencodeConfig).not.toHaveProperty('mcpServers');
    expect(opencodeConfig.mcp['agentx-remote']).toMatchObject({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      enabled: true,
      oauth: false,
      headers: {
        Authorization: 'Bearer {env:AGENTX_MCP_KEY}'
      }
    });
    expect(opencode).not.toContain('mcpServers');
    expect(codex).toContain('--bearer-token-env-var AGENTX_MCP_KEY');
    expect(codex).toContain('https://mcp.example.com/mcp');
    expect(codex).toContain('本机私有');
    expect(claudeCode).toContain('--transport http agentx-remote');
    expect(claudeCode).toContain('https://mcp.example.com/mcp');
    expect(claudeCode).toContain('本机私有');
    expect(claudeCode).toContain('AGENTX_MCP_KEY');
    expect(claudeCode).not.toContain('Bearer <MCP_KEY>');
    expect(claudeCode).not.toContain("AGENTX_MCP_KEY='<MCP_KEY>'");
    expect(spawnArgs).toMatchObject({
      agentType: 'claude-code',
      chipId: '<RESOURCE_ID_FROM_AGENTX_WHOAMI>',
      sessionMode: 'oneshot'
    });
    expect(spawnArgs).not.toHaveProperty('cwd');
    expect(spawnArgs.task).toContain('Read-only smoke test');
    expect(spawnArgs.task).toContain('AGENTX_MCP_OK');
    for (const value of [html, script, opencode, codex, claudeCode, spawn]) {
      expectNoCustomerInternalPaths(value);
      expect(value).not.toContain('BEGIN ');
      expect(value).not.toContain('203.0.113.10');
      expect(value).not.toMatch(/AGENTX_MCP_KEY=[A-Za-z0-9._~+/=-]{10,}/);
      expect(value).not.toContain('MCP_API_KEY=');
      expect(value).not.toMatch(/ALI_AGENTX_MCP_KEY/);
      expect(value).not.toMatch(/mcp_[A-Za-z0-9_-]{16,}/);
    }
  });

  it('keeps the legacy MCP client file as an access center alias only', () => {
    const legacy = readPublicFile('mcp-client.html');

    expect(legacy).toContain('/mcp-access');
    expect(legacy).toContain('legacy alias');
    expect(legacy).not.toContain('https://mcp.example.com/mcp');
    expect(legacy).not.toContain('Bearer {env:AGENTX_MCP_KEY}');
    expectNoCustomerInternalPaths(legacy);
  });

  it('defines the chat page structure', () => {
    const html = readPublicFile('chat.html');

    expect(html).toContain('id="chip-select"');
    expect(html).toContain('id="session-meta"');
    expect(html).toContain('id="chat-grid"');
    expect(html).toContain('id="session-sidebar"');
    expect(html).toContain('id="chat-sidebar-toggle"');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).not.toContain('/announcements.js');
    expect(html).toContain('/chat.js?v=2.2.44');
    expect(html).toContain('/assets/agentx-webui.js?v=2.2.43');
    expect(html).not.toContain('data-product-changelog');
    expect(html).not.toContain('data-announcements-chat');
    expect(html).not.toContain('data-announcements-chat-feed');
    expect(html).toContain('data-portal-nav');
    expect(html).toContain('data-product-signature');
    expect(html).toContain('data-product-fingerprint');
    expect(html).toContain('id="message-form"');
    expect(html).toContain('id="conversation"');
    expect(html).toContain('name="chat-mode"');
    expect(html).toContain('value="standard"');
    expect(html).toContain('value="enhanced"');
    expect(html).toContain('value="multimodal"');
    expect(html).toContain('id="chat-mode-options"');
    expect(html).toContain('chat-mode-segment');
    expect(html).toContain('composer-floatbar');
    expect(html).not.toContain('id="model-credit-status"');
    expect(html).not.toContain('id="chat-locale-hint"');
    expect(html).not.toContain('id="chat-mode-lock-hint"');
    expect(html).not.toContain('chat-attach-hint');
    expect(html).toContain('id="chat-image-input"');
    expect(readPublicFile('product-shell.js')).toContain("{ href: '/feedback', key: 'portal.nav.feedback', label: '反馈' }");
    expect(html).toContain('data-portal-auth');
    expect(html).not.toContain('id="feedback-open-button"');
    expect(html).not.toContain('id="feedback-form"');
    expect(html).not.toContain('id="feedback-session-checkbox"');
    expect(html).toContain('/chat.js');
    const script = readPublicFile('chat.js');
    expect(script).toContain('agentx.chat.sidebarCollapsed');
    expect(script).toContain('initChatSidebarCollapse');
    expect(script).toContain('renderMessageContent');
    expect(script).toContain('isInternalImageUrl');
    expect(script).toContain('/api/feedback/messages');
    expect(script).toContain('/api/search-modes');
    expect(script).toContain('function renderSearchModeOptions()');
    expect(script).toContain('chatMode: selectedChatMode()');
    expect(script).toContain("form.append('chatMode', selectedChatMode())");
    expect(script).toContain('credits?.balanceUnits');
    expect(script).toContain('selectedModeAllowsImageInput');
    expect(script).toContain('state.uploadedImageMarkdown');
    expect(script).not.toContain('model: selectedModel()?.id');
    expect(script).not.toContain('const modelCatalog');
    expect(script).not.toContain('const defaultModelByMode');
    expect(script).not.toContain('feedback-modal');
  });

  it('keeps chat hifi shell contracts while using the portal navigation', () => {
    const html = readPublicFile('chat.html');
    const productShell = readPublicFile('product-shell.js');
    const dom = new JSDOM(html, { url: 'http://localhost/chat', runScripts: 'dangerously' });
    dom.window.eval(productShell);
    const document = dom.window.document;
    const body = document.body;
    const header = document.querySelector('header.portal-topbar');
    const activeLinks = [...document.querySelectorAll('[data-portal-nav] a[aria-current="page"]')];

    expect(body.classList.contains('chat-page')).toBe(true);
    expect(body.classList.contains('landing-page')).toBe(true);
    expect(body.classList.contains('portal-page')).toBe(true);
    expect(body.classList.contains('portal-workspace-page')).toBe(true);
    expect(header?.classList.contains('landing-topbar')).toBe(true);
    expect(header?.classList.contains('float-nav')).toBe(true);
    expect(document.querySelector('header.chat-floating-nav')).toBeNull();
    expect(document.querySelector('.landing-brand.brand')?.getAttribute('href')).toBe('/home');
    expect(document.querySelector('.brand-mark')?.textContent).toBe('AX');
    expect(document.querySelector('[data-portal-auth]')).not.toBeNull();
    expect(document.querySelector('[data-agentx-skin-root]')).not.toBeNull();
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0]?.getAttribute('href')).toBe('/chat');
    expect(activeLinks[0]?.classList.contains('active')).toBe(true);
    expect(html).toContain('id="chat-grid" class="chat-grid chat-hifi-grid"');
    expect(html).toContain('id="session-sidebar" class="session-sidebar chat-hifi-sessions"');
    expect(html).toContain('class="chat-workspace chat-hifi-workspace"');
    expect(html).not.toContain('href="#"');
  });

  it('keeps chat sidebar and composer controls while using hifi classes', () => {
    const html = readPublicFile('chat.html');
    const document = new JSDOM(html).window.document;
    const uniqueIds = [
      'session-list',
      'session-meta',
      'conversation',
      'message-form',
      'message',
      'send-message',
      'new-session',
      'chat-error',
      'chip-select',
      'chat-grid',
      'chat-sidebar-toggle',
      'chat-mode-options',
      'image-upload-control',
      'chat-image-input'
    ];

    expect(html).toContain('id="session-sidebar"');
    expect(html).toContain('id="chat-sidebar-toggle"');
    expect(html).toContain('id="new-session"');
    expect(html).toContain('id="session-list"');
    expect(html).toContain('id="message-form" class="chat-composer chat-hifi-composer"');
    expect(html).toContain('id="message"');
    expect(html).toContain('id="send-message"');
    expect(html).toContain('id="chat-mode-options"');
    expect(html).toContain('name="chat-mode"');
    expect(html).toContain('id="image-upload-control" class="chat-image-upload chat-hifi-image-upload"');
    expect(html).toContain('<svg viewBox="0 0 24 24" width="18" height="18"');
    expect(html).toContain('<span class="sr-only" data-i18n="chat.image.add">添加图片</span>');
    expect(html).toContain('id="chat-image-input"');
    expect(html).toContain('name="images"');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,image/gif"');
    expect(html).toContain('multiple disabled');
    expect(html).toContain('composer-floatbar');
    expect(html).not.toContain('id="chat-locale-hint"');
    expect(html).not.toContain('id="model-credit-status"');
    expect(html).toContain('id="chat-error"');
    expect(html).toContain('class="chat-chip-pill"');
    for (const id of uniqueIds) {
      expect(document.querySelectorAll(`#${id}`).length, `${id} should be unique`).toBe(1);
    }
    expect(document.querySelectorAll('input[name="chat-mode"]').length).toBe(3);
    expect(document.querySelector('#chip-select')?.tagName).toBe('SELECT');
    expect(document.querySelector('#image-upload-control span')?.textContent).toBe('添加图片');
  });

  it('defines page-scoped chat hifi styles', () => {
    const css = readPublicFile('styles.css');

    for (const selector of [
      'body.chat-page .chat-hifi-shell',
      '.chat-hifi-grid',
      '.chat-hifi-sessions',
      '.chat-hifi-workspace',
      '.chat-hifi-composer',
      '.chat-hifi-image-upload',
      '.chat-hifi-send',
      '.chat-hifi-modes',
      '.composer-floatbar',
      '.chat-chip-pill'
    ]) {
      expect(css).toContain(selector);
    }
    expect(css).toContain('body.chat-page .chat-hifi-grid');
    expect(css).toContain('body.portal-page .portal-topbar');
    expect(css).toContain('body.portal-workspace-page .portal-topbar');
    expect(css).toContain('@media (max-width: 860px)');

    const gridMatch = css.match(/body\.chat-page \.chat-hifi-grid\s*\{([^}]+)\}/);
    if (!gridMatch) throw new Error('body.chat-page .chat-hifi-grid rule not found');
    expect(gridMatch[1]).toContain('width: 100%');
    expect(gridMatch[1]).toContain('max-width: none');
    expect(gridMatch[1]).toContain('margin: 0');
    expect(gridMatch[1]).toContain('grid-template-columns: clamp(236px, 18vw, 320px) minmax(0, 1fr)');
    expect(gridMatch[1]).not.toContain('1220px');
  });

  it('chat sidebar uses skin tokens, not hardcoded colors', () => {
    const css = readPublicFile('styles.css');

    // 提取 .chat-hifi-sessions 规则块，断言令牌替换
    const sessionsMatch = css.match(/body\.chat-page \.chat-hifi-sessions\s*\{([^}]+)\}/);
    if (!sessionsMatch) throw new Error('body.chat-page .chat-hifi-sessions rule not found');
    const sessionsBlock = sessionsMatch[1];
    expect(sessionsBlock).toContain('height: calc(100vh - 124px)');
    expect(sessionsBlock).toContain('var(--border)');
    expect(sessionsBlock).toContain('var(--skin-radius)');
    expect(sessionsBlock).toContain('var(--surface-alt)');
    expect(sessionsBlock).toContain('var(--skin-shadow-panel)');
    expect(sessionsBlock).not.toContain('#DCE4E1');
    expect(sessionsBlock).not.toContain('rgba(255, 255, 255, 0.9)');

    // 搜索框令牌
    const searchMatch = css.match(/\.chat-session-search\s*\{([^}]+)\}/);
    if (!searchMatch) throw new Error('.chat-session-search rule not found');
    const searchBlock = searchMatch[1];
    expect(searchBlock).toContain('var(--border)');
    expect(searchBlock).toContain('var(--surface-alt)');
    expect(searchBlock).toContain('var(--muted)');
    expect(searchBlock).not.toContain('#DCE4E1');
    expect(searchBlock).not.toContain('#F8FAF9');
    expect(searchBlock).not.toContain('#83908D');

    // 新建按钮令牌
    const newSessionMatch = css.match(/\.chat-session-head #new-session\s*\{([^}]+)\}/);
    if (!newSessionMatch) throw new Error('.chat-session-head #new-session rule not found');
    const newSessionBlock = newSessionMatch[1];
    expect(newSessionBlock).toContain('var(--accent)');
    expect(newSessionBlock).not.toContain('#0F766E');

    // 激活行令牌
    const activeMatch = css.match(/body\.chat-page \.session-row\.active\s*\{([^}]+)\}/);
    if (!activeMatch) throw new Error('body.chat-page .session-row.active rule not found');
    const activeBlock = activeMatch[1];
    expect(activeBlock).toContain('var(--accent)');
    expect(activeBlock).toContain('var(--accent-subtle)');
    expect(activeBlock).not.toContain('#E6F4F1');
    expect(activeBlock).not.toContain('#0B5F58');

    // 激活行圆点（::before 是独立规则块，需单独断言）
    const activeDotMatch = css.match(/body\.chat-page \.session-row\.active::before\s*\{([^}]+)\}/);
    if (!activeDotMatch) throw new Error('body.chat-page .session-row.active::before rule not found');
    const activeDotBlock = activeDotMatch[1];
    expect(activeDotBlock).toContain('var(--accent)');
    expect(activeDotBlock).not.toContain('#0F766E');
  });

  it('clips the composer dock inside the rounded workspace panel', () => {
    const css = readPublicFile('styles.css');

    // workspace 是圆角面板
    const workspaceMatch = css.match(/body\.chat-page \.chat-hifi-workspace\s*\{([^}]+)\}/);
    if (!workspaceMatch) throw new Error('body.chat-page .chat-hifi-workspace rule not found');
    const workspaceBlock = workspaceMatch[1];
    expect(workspaceBlock).toContain('overflow: hidden');
    expect(workspaceBlock).toContain('var(--skin-radius)');
    expect(workspaceBlock).toContain('var(--surface)');
    expect(workspaceBlock).toContain('var(--skin-shadow-panel)');
    expect(workspaceBlock).toContain('var(--border)');

    // composer-wrap 不再有白色渐隐背景
    const wrapMatch = css.match(/\.chat-hifi-composer-wrap\s*\{([^}]+)\}/);
    if (!wrapMatch) throw new Error('.chat-hifi-composer-wrap rule not found');
    const wrapBlock = wrapMatch[1];
    expect(wrapBlock).not.toContain('linear-gradient');
    expect(wrapBlock).not.toContain('#FFFFFF');
    expect(wrapBlock).not.toContain('position: sticky');
    expect(wrapBlock).toContain('background: transparent');
    expect(wrapBlock).toContain('border-top: 0');

    // chip-pill 使用令牌颜色
    const pillMatch = css.match(/\.chat-chip-pill\s*\{([^}]+)\}/);
    if (!pillMatch) throw new Error('.chat-chip-pill rule not found');
    const pillBlock = pillMatch[1];
    expect(pillBlock).toContain('var(--border)');
    expect(pillBlock).toContain('var(--accent)');
    expect(pillBlock).toContain('var(--surface)');
    expect(pillBlock).not.toContain('#ADDCD5');
    expect(pillBlock).not.toContain('#0B5F58');
    expect(pillBlock).not.toContain('rgba(255, 255, 255, 0.96)');
  });

  it('conversation scrolls independently while composer stays docked at workspace bottom', () => {
    const css = readPublicFile('styles.css');

    // workspace 有确定高度 + 三段 grid，底部行才能稳定停靠 composer
    const workspaceMatch = css.match(/body\.chat-page \.chat-hifi-workspace\s*\{([^}]+)\}/);
    if (!workspaceMatch) throw new Error('body.chat-page .chat-hifi-workspace rule not found');
    const workspaceBlock = workspaceMatch[1];
    expect(workspaceBlock).toContain('grid-template-rows: auto minmax(0, 1fr) auto');
    expect(workspaceBlock).toContain('height: calc(100vh - 124px)');

    // conversation 独立滚动：可收缩 + 自身滚动条
    const convMatch = css.match(/body\.chat-page \.conversation\s*\{([^}]+)\}/);
    if (!convMatch) throw new Error('body.chat-page .conversation rule not found');
    const convBlock = convMatch[1];
    expect(convBlock).toContain('min-height: 0');
    expect(convBlock).toContain('overflow: auto');
    expect(convBlock).not.toContain('min-height: 430px');

    // composer dock 不依赖 sticky（grid 行已保证底部停靠）
    const wrapMatch = css.match(/\.chat-hifi-composer-wrap\s*\{([^}]+)\}/);
    if (!wrapMatch) throw new Error('.chat-hifi-composer-wrap rule not found');
    expect(wrapMatch[1]).not.toContain('position: sticky');
  });

  it('pins workspace grid rows so composer docks even when session-meta is hidden', () => {
    const css = readPublicFile('styles.css');

    // 新会话态 chat.js 会把 #session-meta 设为 hidden（display:none），
    // 隐藏元素退出 grid 流，若不显式锚定行号，剩余两个子元素会被自动放进
    // 前两行 —— conversation 落到 auto 行、composer-wrap 抢到 1fr 弹性行，
    // 导致输入框漂在中部、下方留白。显式 grid-row 锚定可使行分配稳定。
    expect(css).toMatch(/body\.chat-page \.session-meta\s*\{[^}]*grid-row:\s*1/);
    expect(css).toMatch(/body\.chat-page \.conversation\s*\{[^}]*grid-row:\s*2/);
    expect(css).toMatch(/\.chat-hifi-composer-wrap\s*\{[^}]*grid-row:\s*3/);
  });

  it('tokenizes chat message bubbles and citations', () => {
    const css = readPublicFile('styles.css');

    const msgMatch = css.match(/body\.chat-page \.message-bubble\s*\{([^}]+)\}/);
    if (!msgMatch) throw new Error('body.chat-page .message-bubble rule not found');
    const msg = msgMatch[1];
    expect(msg).toContain('max-width: 100%');
    expect(msg).toContain('var(--border)');
    expect(msg).toContain('var(--surface)');
    expect(msg).toContain('var(--text)');
    expect(msg).not.toContain('#E3E8E5');
    expect(msg).not.toContain('#FFFFFF');
    expect(msg).not.toContain('#4A5452');

    const userMatch = css.match(/body\.chat-page \.message\.user \.message-bubble\s*\{([^}]+)\}/);
    if (!userMatch) throw new Error('body.chat-page .message.user .message-bubble rule not found');
    const user = userMatch[1];
    expect(user).toContain('background: var(--surface)');
    expect(user).toContain('border-color: var(--border)');
    expect(user).toContain('color: var(--text)');
    expect(user).toContain('box-shadow');
    expect(user).not.toContain('#E6F4F1');
    expect(user).not.toContain('#ADDCD5');

    const assistantRowMatch = css.match(/body\.chat-page \.message\.assistant\s*\{([^}]+)\}/);
    if (!assistantRowMatch) throw new Error('body.chat-page .message.assistant rule not found');
    expect(assistantRowMatch[1]).toContain('width: min(920px, 92%)');

    const assistantBubbleMatch = css.match(/body\.chat-page \.message\.assistant \.message-bubble\s*\{([^}]+)\}/);
    if (!assistantBubbleMatch) throw new Error('body.chat-page .message.assistant .message-bubble rule not found');
    expect(assistantBubbleMatch[1]).toContain('width: 100%');

    const failedMatch = css.match(/body\.chat-page \.message\.failed \.message-bubble\s*\{([^}]+)\}/);
    if (!failedMatch) throw new Error('body.chat-page .message.failed .message-bubble rule not found');
    const failed = failedMatch[1];
    expect(failed).toContain('var(--danger)');
    expect(failed).not.toContain('#B42318');
    expect(failed).not.toContain('#F0B8B2');

    const actionMatch = css.match(/body\.chat-page \.message-action-button,\s*body\.chat-page \.message-feedback-compact button\s*\{([^}]+)\}/);
    if (!actionMatch) throw new Error('message action button rule not found');
    const action = actionMatch[1];
    expect(action).toContain('var(--surface)');
    expect(action).toContain('var(--border)');
    expect(action).not.toContain('#DCE3E0');
  });

  it('tokenizes composer inner controls', () => {
    const css = readPublicFile('styles.css');

    const composerMatch = css.match(/body\.chat-page \.chat-hifi-composer\s*\{([^}]+)\}/);
    if (!composerMatch) throw new Error('chat-hifi-composer rule not found');
    const composer = composerMatch[1];
    expect(composer).toContain('var(--surface)');
    expect(composer).toContain('var(--border)');
    expect(composer).not.toContain('#FFFFFF');
    expect(composer).not.toContain('rgba(202, 215, 211, 0.95)');

    const uploadMatch = css.match(/body\.chat-page \.chat-hifi-image-upload\s*\{([^}]+)\}/);
    if (!uploadMatch) throw new Error('image upload rule not found');
    const upload = uploadMatch[1];
    expect(upload).toContain('var(--accent)');
    expect(upload).toContain('var(--accent-subtle)');
    expect(upload).not.toContain('#06433E');
    expect(upload).not.toContain('#DFF3EF');
    expect(upload).not.toContain('#B7DFD8');

    const sendMatch = css.match(/body\.chat-page \.chat-hifi-send\s*\{([^}]+)\}/);
    if (!sendMatch) throw new Error('send button rule not found');
    const send = sendMatch[1];
    expect(send).toContain('var(--accent)');
    expect(send).not.toContain('#0F766E');

    const selectedMatch = css.match(/body\.chat-page \.chat-hifi-modes \.chat-mode-segment\.selected\s*\{([^}]+)\}/);
    if (!selectedMatch) throw new Error('selected mode segment rule not found');
    const selected = selectedMatch[1];
    expect(selected).toContain('var(--accent)');
    expect(selected).not.toContain('#0F766E');

    const pillSelectMatch = css.match(/\.chat-chip-pill select\s*\{([^}]+)\}/);
    if (!pillSelectMatch) throw new Error('chip-pill select rule not found');
    expect(pillSelectMatch[1]).toContain('var(--accent)');
    expect(pillSelectMatch[1]).not.toContain('#0B5F58');
  });

  it('tokenizes chat sidebar and page residuals', () => {
    const css = readPublicFile('styles.css');

    const pageMatch = css.match(/body\.chat-page\s*\{([^}]+)\}/);
    if (!pageMatch) throw new Error('body.chat-page rule not found');
    const page = pageMatch[1];
    expect(page).toContain('var(--text)');
    expect(page).toContain('var(--skin-gradient)');
    expect(page).not.toContain('#17211F');
    expect(page).not.toContain('linear-gradient(180deg, #F8FAF9');

    const rowMatch = css.match(/body\.chat-page \.session-row\s*\{([^}]+)\}/);
    if (!rowMatch) throw new Error('session-row rule not found');
    expect(rowMatch[1]).toContain('var(--text)');
    expect(rowMatch[1]).not.toContain('#444F4D');

    const metaMatch = css.match(/body\.chat-page \.session-meta\s*\{([^}]+)\}/);
    if (!metaMatch) throw new Error('session-meta rule not found');
    const meta = metaMatch[1];
    expect(meta).toContain('var(--border)');
    expect(meta).toContain('var(--surface-alt)');
    expect(meta).not.toContain('#DCE4E1');
    expect(meta).not.toContain('rgba(255, 255, 255, 0.82)');

    const searchIconMatch = css.match(/\.chat-session-search::before\s*\{([^}]+)\}/);
    if (!searchIconMatch) throw new Error('search icon rule not found');
    expect(searchIconMatch[1]).toContain('var(--muted)');
    expect(searchIconMatch[1]).not.toContain('#8D9794');
  });

  it('guards setError against a missing error element', () => {
    const script = readPublicFile('chat.js');
    // setError 必须在写 textContent 前判空，避免 Cannot set properties of null
    expect(script).toMatch(/function setError\([^)]*\)\s*\{\s*if \(els\.error\)/);
  });

  it('keeps chat markdown rendering on a strict allowlist', () => {
    const script = readPublicFile('chat.js');

    expect(script).toContain("replace(/^```");
    expect(script).toContain("document.createElement('table')");
    expect(script).toContain("document.createElement('blockquote')");
    expect(script).toContain("document.createElement('img')");
    expect(script).toContain("renderSafeLink");
    expect(script).toContain("renderSafeImage");
    expect(script).toContain("/^\\/api\\/chat-uploads\\//");
    expect(script).toContain("/^\\/downloads\\//");
    expect(script).toContain("/^\\/assets\\//");
    expect(script).not.toContain('javascript:');
    expect(script).not.toContain('file://');
  });

  it('renders markdown by block-level tokens without depending on blank lines', () => {
    const script = readPublicFile('chat.js');
    // 逐行分词：按单换行切行后逐块识别，不再只靠空行 split(/\n{2,}/)
    expect(script).toMatch(/split\('\\n'\)/);
    // 新增水平分隔线分支：--- / *** / ___ → <hr>
    expect(script).toContain("document.createElement('hr')");
    // 仍复用既有块级渲染器，不引入任何 markdown 库
    expect(script).toContain('renderTable');
    expect(script).toContain('renderList');
    expect(script).toContain('renderCodeBlock');
    expect(script).toContain('isMarkdownTable');
    expect(script).toContain('appendInlineMarkdown');
  });

  it('defines the admin page structure', () => {
    const html = readPublicFile('admin.html');

    for (const id of [
      'user-form',
      'new-role',
      'user-filter-role',
      'user-create-error',
      'user-list',
      'key-form',
      'key-list',
      'generated-key',
      'admin-error',
      'admin-sidebar-toggle',
      'panel-feedback',
      'feedback-admin-error',
      'ticket-admin-filter-form',
      'ticket-admin-filter-type',
      'ticket-admin-filter-status',
      'ticket-admin-filter-needs-more-info',
      'ticket-admin-filter-keyword',
      'ticket-admin-filter-feedback-type',
      'ticket-admin-filter-chip',
      'ticket-admin-filter-document',
      'ticket-admin-filter-scope',
      'ticket-admin-filter-model',
      'ticket-admin-filter-review-signal',
      'ticket-admin-list',
      'ticket-admin-detail',
      'ticket-admin-attachments',
      'ticket-admin-preview',
      'ticket-admin-review-form',
      'ticket-admin-status',
      'ticket-admin-public-note',
      'ticket-admin-internal-note',
      'ticket-admin-result',
      'ticket-admin-needs-more-info',
      'ticket-admin-more-filters-toggle',
      'ticket-admin-more-filters',
      'ticket-admin-download-all',
      'ticket-admin-material-notice',
      'ticket-admin-application-actions'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-portal-auth');
    expect(html).not.toContain('id="logout"');
    expect(html).toContain('反馈&工单');
    expect(html).not.toContain('旧反馈管理');
    expect(html).not.toContain('GitHub Issue');
    expect(html).not.toContain('legacy-feedback-admin');
    expect(html).not.toContain('datasheet-ticket-admin');
    expect(html).not.toContain('feedback-split');
    expect(html).toContain('class="admin-nav-icon"');
    expect(html).not.toContain('data-short=');
    expect(html).toContain('id="admin-sidebar-toggle"');
    expect(html).not.toContain('>submitted<');
    expect(html).not.toContain('>needs_more_info<');
    const script = readPublicFile('admin.js');
    expect(script).toContain("submitted: '已提交'");
    expect(script).toContain("reviewing: '审核中'");
    expect(script).toContain("feedback: '反馈&工单'");
    expect(script).toContain('/admin/tickets?');
    expect(script).toContain('ticket-admin-filter-keyword');
    expect(script).toContain('ticket-admin-filter-feedback-type');
    expect(script).toContain("params.set('feedbackType'");
    expect(script).toContain("params.set('reviewSignal', 'high_priority')");
    expect(script).toContain('account_application');
    expect(script).toContain('datasheet_submission');
    expect(script).toContain('feedback');
    expect(script).toContain('/attachments/');
    expect(script).toContain('/download');
    expect(script).toContain('/preview');
    expect(script).toContain('/account-application/approve');
    expect(script).toContain('response.blob()');
    expect(script).toContain('URL.createObjectURL');
    expect(script).toContain('AgentXAuth.authFetch');
    expect(script).toContain('批准并创建用户');
    expect(script).not.toContain('申请密码');
    expect(script).not.toContain('plainPassword');
    expect(script).toContain('TICKET_STATUS_OPTIONS_BY_TYPE');
    expect(script).toContain("feedback: ['submitted', 'received', 'evaluating', 'accepted', 'in_development', 'launched', 'deferred', 'closed']");
    expect(script).toContain("datasheet_submission: ['received', 'archived']");
    expect(script).toContain("'needs_more_info'");
    expect(script).toContain("'archived'");
    expect(script).not.toContain('/datasheet-review');
    // round3 D1：SPEC 明令资料提交工单详情不做 安全扫描/metadata候选/绑定意图 字段组，
    // formatMetadataCandidate/formatBindingIntent 随该字段组一并删除，故不再断言这两个标识符存在。
    expect(script).not.toContain('metadataCandidate');
    expect(script).not.toContain('bindingIntent');
    expect(script).toContain("account_application: ['submitted', 'pending_review', 'needs_more_info', 'approved', 'rejected', 'closed']");
    expect(script).toContain('syncTicketDetailStatusOptions');
    expect(script).toContain('ticketTypeFromTicketNo');
    expect(script).toContain("ticketNo.startsWith('FB-')");
    expect(script).toContain("ticketNo.startsWith('DS-')");
    expect(script).toContain("ticketNo.startsWith('AP-')");
    expect(script).toContain('请选择工单');
    expect(script).toContain('暂无可用状态');
    expect(script).toContain('select.disabled = Boolean(options.disabled)');
    expect(script).toContain('agentx.admin.sidebarCollapsed');
    expect(script).toContain('账号名已存在');
    expect(script).not.toContain('/admin/feedback');
    expect(script).not.toContain('feedbackGithub');
    expect(script).not.toContain('datasheetTicket');
    expect(script).not.toContain('passwordHash');
    expect(script).not.toContain('storagePath');
    expect(script).not.toContain('textContent = attachment.storagePath');
    expect(html).toContain('data-section="feedback"');
    // Admin 顶栏收敛为单个返回门户入口、版本徽标和账户入口，不再渲染门户多链接导航。
    expect(html).not.toContain('data-portal-nav');
    expect(html).toContain('class="admin-return-link"');
    expect(html).not.toContain('id="admin-user-status"');
    expect(html).toContain('/styles.css?v=2.2.45');
    expect(html).toContain('/product-shell.js?v=2.2.42');
    expect(html).toContain('/admin.js?v=2.2.44');
    expect(html).not.toContain('/assets/agentx-webui.css');
    expect(html).not.toContain('/assets/agentx-webui.js');
    expect(html).toContain('data-product-version');
    expect(html).not.toContain('data-product-signature');
    expect(html).not.toContain('data-product-changelog');
    expect(html).toContain('data-product-fingerprint');
    expect(html).not.toContain('selected-user-type');
    expect(html).not.toContain('new-user-type');
    expect(html).not.toContain('user-filter-type');
    expect(html).not.toContain('fingerprint-verification-entry');
    expect(html).not.toContain('Fingerprint CLI');
    expect(html).toContain('id="admin-section-nav"');
    expect(html).toContain('/admin.js');
  });

  it('defines the admin fixed grayscale design system without leaking portal skins', () => {
    const html = readPublicFile('admin.html');
    const css = readPublicFile('styles.css');

    expect(html).toContain('data-admin-theme="light"');
    expect(html).not.toContain('data-agentx-skin-root');
    expect(html).not.toContain('dataset.agentxSkin');
    expect(html).not.toContain('/assets/agentx-webui.css');
    expect(html).not.toContain('/assets/agentx-webui.js');

    const tokenStart = css.indexOf(':root[data-admin-theme],');
    expect(tokenStart).toBeGreaterThanOrEqual(0);
    const tokenBlock = css.slice(tokenStart, css.indexOf('}', tokenStart));

    for (const token of [
      '--admin-background: oklch(1 0 0)',
      '--admin-foreground: oklch(0.145 0 0)',
      '--admin-card: oklch(1 0 0)',
      '--admin-primary: oklch(0.205 0 0)',
      '--admin-primary-foreground: oklch(0.985 0 0)',
      '--admin-border: oklch(0.922 0 0)',
      '--admin-ring: oklch(0.708 0 0)',
      '--admin-success: oklch(0.55 0.12 150)',
      '--admin-info: oklch(0.5 0.09 250)',
      '--admin-warn: oklch(0.62 0.13 75)',
      '--admin-shadow-sm: 0 1px 2px oklch(0.145 0 0 / 0.05)'
    ]) {
      expect(tokenBlock).toContain(token);
    }

    expect(css.match(/^:root \{/gm)).toHaveLength(1);
    expect(css).not.toContain('.dark {\n  --background: oklch(0.145 0 0)');

    for (const selector of [
      '.admin-primary-button',
      '.admin-secondary-button',
      '.admin-danger-button',
      '.admin-dense-table',
      '.admin-filterbar',
      '.admin-master-detail',
      '.admin-master-col',
      '.admin-detail-col',
      '.admin-drawer',
      '.admin-drawer-backdrop',
      '.admin-drawer-header',
      '.admin-drawer-body',
      '.admin-drawer-footer',
      '.admin-tabs',
      '.admin-tab-pip',
      '.admin-badge',
      '.admin-badge-success',
      '.admin-badge-info',
      '.admin-badge-warn',
      '.admin-badge-muted',
      '.admin-badge-solid',
      '.admin-token-picker',
      '.admin-token-chip',
      '.admin-token-input',
      '.admin-check-list',
      '.admin-check-list-search',
      '.admin-check-list-item',
      '.admin-empty-state',
      '.admin-empty-inner',
      '.admin-error-banner',
      '.admin-danger-confirm',
      '.admin-danger-confirm-actions'
    ]) {
      expect(css).toContain(selector);
    }

    const componentMarker = '/* ---- Admin FE1 shared design-system components ---- */';
    const componentStart = css.indexOf(componentMarker);
    expect(componentStart).toBeGreaterThanOrEqual(0);
    const componentEndSelector = '.admin-danger-confirm-actions';
    const componentEndSelectorStart = css.indexOf(componentEndSelector, componentStart);
    expect(componentEndSelectorStart).toBeGreaterThan(componentStart);
    const componentEnd = css.indexOf('}', componentEndSelectorStart);
    expect(componentEnd).toBeGreaterThan(componentEndSelectorStart);
    const componentBlock = css.slice(componentStart, componentEnd + 1);

    expect(componentBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(componentBlock).not.toMatch(/\brgba\(/);
    expect(componentBlock).not.toMatch(/\boklch\(/);
  });

  it('defines first-paint skin tokens in CSS before the React skin switcher mounts', () => {
    const css = readPublicFile('styles.css');

    for (const skin of ['voltagent', 'cal']) {
      const marker = `html[data-agentx-skin="${skin}"]`;
      expect(css).toContain(marker);
      const start = css.indexOf(marker);
      const block = css.slice(start, css.indexOf('}', start));
      for (const token of [
        '--bg',
        '--surface',
        '--surface-alt',
        '--text',
        '--muted',
        '--border',
        '--accent',
        '--accent-text',
        '--accent-subtle',
        '--skin-gradient',
        '--skin-radius',
        '--skin-font-display'
      ]) {
        expect(block, `${skin} should define ${token}`).toContain(token);
      }
    }
  });

  it('selected chat controls use accent-text instead of fixed white text', () => {
    const css = readPublicFile('styles.css');
    const sendStart = css.indexOf('body.chat-page .chat-hifi-send');
    const sendBlock = css.slice(sendStart, css.indexOf('}', sendStart));
    const modeStart = css.indexOf('body.chat-page .chat-hifi-modes .chat-mode-segment.selected');
    const modeBlock = css.slice(modeStart, css.indexOf('}', modeStart));

    expect(sendBlock).toContain('color: var(--accent-text)');
    expect(modeBlock).toContain('color: var(--accent-text)');
    expect(sendBlock).not.toContain('#FFFFFF');
    expect(modeBlock).not.toContain('#FFFFFF');
  });

  it('contains responsive layout hooks without overflowing mobile controls', () => {
    const css = readPublicFile('styles.css');

    for (const token of [
      '--bg: #f5f5f4',
      '--surface: #ffffff',
      '--text: #111827',
      '--muted: #737373',
      '--border: #e5e5e5',
      '--accent: #111827',
      '--danger: #B42318'
    ]) {
      expect(css).toContain(token);
    }
    expect(css).toContain('@media (max-width: 899px)');
    expect(css).toContain('min-width: 0');
    expect(css).toContain('max-width: 100%');
    expect(css).toContain('.landing-feature-grid');
    expect(css).toContain('.portal-nav');
    expect(css).toContain('.portal-capability-grid');
    expect(css).toContain('.auth-page .login-shell');
    expect(css).toContain('.auth-topbar');
    expect(css).toContain('.portal-footer-actions');
    expect(css).toContain('.donation-footer-link');
    expect(css).toContain('.donation-card');
    expect(css).toContain('.donation-panel');
    expect(css).toContain('.donation-amounts');
    expect(css).toContain('.donation-channel-grid');
    expect(css).toContain('.donation-qr');
    expect(css).toContain('.donation-unavailable');
    expect(css).toContain('.ticket-system-layout');
    expect(css).toContain('.ticket-system-layout.sidebar-collapsed');
    expect(css).toContain('.sidebar-collapse-button');
    expect(css).toContain('width: 28px');
    expect(css).toContain('height: 28px');
    expect(css).toContain('border-radius: var(--radius-pill)');
    expect(css).toContain('.admin-section-nav > .sidebar-collapse-button');
    expect(css).toContain('.ticket-query-card');
    expect(css).toContain('.datasheet-submit-card');
    expect(css).toContain('.ticket-admin-panel');
    expect(css).toContain('.ticket-admin-toolbar');
    expect(css).toContain('.ticket-admin-type-badge');
    expect(css).toContain('.ticket-admin-preview');
    expect(css).not.toContain('.legacy-feedback-admin');
    expect(css).toContain('.ticket-admin-attachment-row');
    expect(css).toContain('.feedback-ticket-form');
    expect(css).toContain('.feedback-category-grid');
    expect(css).toContain('.ticket-result');
    expect(css).toContain('.my-ticket-list');
    expect(css).toContain('.mcp-template-grid');
    expect(css).not.toContain('.account-grid');
    expect(css).toContain('.account-secret-panel');
    expect(css).toContain('.account-key-row');
    expect(css).toContain('.mcp-step-list');
    expect(css).toContain('grid-template-columns: 1fr');
    expect(css).toContain('.product-changelog');
    expect(css).toContain('.product-shell-panel');
    expect(css).toContain('.announcements-home-list');
    expect(css).not.toContain('.account-announcements-panel');
    expect(css).not.toContain('.chat-announcements-panel');
    expect(css).toContain('.announcement-filter-button');
    expect(css).toContain('.chat-grid.sidebar-collapsed');
    expect(css).toContain('.chat-mode-segment');
    expect(css).toContain('.composer-floatbar');
    expect(css).toContain('.admin-grid.sidebar-collapsed');
    expect(css).toContain('.fingerprint-summary');
    expect(css).toContain('.fingerprint-entry');
    expect(css).toContain('.modal-backdrop');
    expect(css).not.toContain('.feedback-modal');
    expect(css).not.toContain('.feedback-split');
    expect(css).toContain('flex-wrap: wrap');
  });

  it('serves the authenticated web UI from the HTTP server', async () => {
    const started = await startServer();
    server = started.server;

    const root = await fetch(`${started.baseUrl}/`, { redirect: 'manual' });
    const home = await fetch(`${started.baseUrl}/home`, { redirect: 'manual' });
    const login = await fetch(`${started.baseUrl}/login`);
    const chat = await fetch(`${started.baseUrl}/chat`);
    const admin = await fetch(`${started.baseUrl}/admin`);
    const account = await fetch(`${started.baseUrl}/account`);
    const accountHtml = await fetch(`${started.baseUrl}/account.html`);
    const mcpAccess = await fetch(`${started.baseUrl}/mcp-access`);
    const mcpAccessHtml = await fetch(`${started.baseUrl}/mcp-access.html`);
    const mcpClient = await fetch(`${started.baseUrl}/mcp-client`);
    const mcpClientHtml = await fetch(`${started.baseUrl}/mcp-client.html`);
    const tickets = await fetch(`${started.baseUrl}/tickets`);
    const ticketSystemAlias = await fetch(`${started.baseUrl}/ticket-system`);
    const feedbackAlias = await fetch(`${started.baseUrl}/feedback`);
    const datasheetAlias = await fetch(`${started.baseUrl}/datasheet-submit`);
    const updatesAlias = await fetch(`${started.baseUrl}/updates`);
    const updatesHtml = await fetch(`${started.baseUrl}/updates.html`);
    const joinAlias = await fetch(`${started.baseUrl}/join-application`);
    const donationAlias = await fetch(`${started.baseUrl}/donation-support`);
    const opencodeTemplate = await fetch(`${started.baseUrl}/mcp-templates/opencode.json`);
    const codexTemplate = await fetch(`${started.baseUrl}/mcp-templates/codex.md`);
    const missingTemplate = await fetch(`${started.baseUrl}/mcp-templates/unknown.json`);
    const directoryTemplate = await fetch(`${started.baseUrl}/mcp-templates/`);
    const traversalTemplate = await fetch(`${started.baseUrl}/mcp-templates/%2e%2e/admin.html`);
    const css = await fetch(`${started.baseUrl}/styles.css`);
    const versionedCss = await fetch(`${started.baseUrl}/styles.css?v=2.2.45`);
    const productShell = await fetch(`${started.baseUrl}/product-shell.js`);
    const announcementsJs = await fetch(`${started.baseUrl}/announcements.js?v=2.2.42`);
    const versionedTicketsJs = await fetch(`${started.baseUrl}/tickets.js?v=2.2.43`);
    const versionedI18nJs = await fetch(`${started.baseUrl}/i18n.js?v=2.2.44`);
    const versionedMcpAccessJs = await fetch(`${started.baseUrl}/mcp-access.js?v=2.2.45`);
    const versionedAdminJs = await fetch(`${started.baseUrl}/admin.js?v=2.2.44`);
    const versionedUiKitJs = await fetch(`${started.baseUrl}/ui-kit.js?v=2.2.43`);
    const versionedUpdatesJs = await fetch(`${started.baseUrl}/updates.js?v=2.2.43`);
    const versionedWebui = await fetch(`${started.baseUrl}/assets/agentx-webui.js?v=2.2.43`);

    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/home');
    expect(home.status).toBe(302);
    expect(home.headers.get('location')).toBe('/login');
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('login-form');
    expect(chat.status).toBe(200);
    expect(await chat.text()).toContain('conversation');
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain('user-form');
    expect(account.status).toBe(200);
    expect(await account.text()).toContain('account-profile-form');
    expect(accountHtml.status).toBe(200);
    expect(await accountHtml.text()).toContain('account-key-list');
    expect(mcpAccess.status).toBe(200);
    expect(await mcpAccess.text()).toContain('mcp-access-key-list');
    expect(mcpAccessHtml.status).toBe(200);
    expect(await mcpAccessHtml.text()).toContain('mcp-access-template-code');
    expect(mcpClient.status).toBe(200);
    expect(await mcpClient.text()).toContain('mcp-access-key-list');
    expect(mcpClientHtml.status).toBe(200);
    expect(await mcpClientHtml.text()).toContain('mcp-access-key-list');
    expect(tickets.status).toBe(200);
    const ticketsText = await tickets.text();
    expect(ticketsText).toContain('ticket-query-form');
    expect(ticketsText).toContain('my-tickets-list');
    expect(ticketsText).not.toContain('feedback-ticket-form');
    expect(ticketsText).not.toContain('datasheet-ticket-form');
    expect(ticketsText).not.toContain('account-application-form');
    expect(ticketsText).not.toContain('data-donation-root');
    expect(ticketSystemAlias.status).toBe(200);
    expect(await ticketSystemAlias.text()).toContain('ticket-query-form');
    expect(feedbackAlias.status).toBe(200);
    expect(await feedbackAlias.text()).toContain('feedback-ticket-form');
    expect(datasheetAlias.status).toBe(200);
    expect(await datasheetAlias.text()).toContain('datasheet-ticket-form');
    expect(updatesAlias.status).toBe(200);
    expect(await updatesAlias.text()).toContain('data-updates-root');
    expect(updatesHtml.status).toBe(200);
    expect(await updatesHtml.text()).toContain('updates-split-layout');
    expect(joinAlias.status).toBe(200);
    expect(await joinAlias.text()).toContain('account-application-form');
    expect(donationAlias.status).toBe(200);
    expect(await donationAlias.text()).toContain('data-donation-root');
    expect(opencodeTemplate.status).toBe(200);
    expect(opencodeTemplate.headers.get('content-type')).toContain('application/json');
    expect(await opencodeTemplate.text()).toContain('AGENTX_MCP_KEY');
    expect(codexTemplate.status).toBe(200);
    expect(codexTemplate.headers.get('content-type')).toContain('text/markdown');
    expect(missingTemplate.status).toBe(404);
    expect(directoryTemplate.status).toBe(404);
    expect(traversalTemplate.status).toBe(404);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(css.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(versionedCss.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(productShell.status).toBe(200);
    expect(productShell.headers.get('content-type')).toContain('application/javascript');
    expect(productShell.headers.get('cache-control')).toBe('no-cache, no-store, must-revalidate');
    expect(announcementsJs.status).toBe(200);
    expect(announcementsJs.headers.get('content-type')).toContain('application/javascript');
    expect(announcementsJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedI18nJs.status).toBe(200);
    expect(versionedI18nJs.headers.get('content-type')).toContain('application/javascript');
    expect(versionedI18nJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedTicketsJs.status).toBe(200);
    expect(versionedTicketsJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedMcpAccessJs.status).toBe(200);
    expect(versionedMcpAccessJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedAdminJs.status).toBe(200);
    expect(versionedAdminJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedUiKitJs.status).toBe(200);
    expect(versionedUiKitJs.headers.get('content-type')).toContain('application/javascript');
    expect(versionedUiKitJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedUpdatesJs.status).toBe(200);
    expect(versionedUpdatesJs.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(versionedWebui.status).toBe(200);
    expect(versionedWebui.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('documents nginx proxy routes for every public AgentX link', () => {
    const linuxDeploy = readDocFile('linux-deploy.md');
    const linkedPages = [
      'index.html',
      'feedback.html',
      'datasheet-submit.html',
      'updates.html',
      'join-application.html',
      'tickets.html',
      'donation-support.html',
      'chat.html',
      'admin.html',
      'mcp-client.html',
      'login.html'
    ];
    const hrefs = new Set<string>();

    for (const page of linkedPages) {
      const html = readPublicFile(page);
      for (const match of html.matchAll(/href="([^"]+)"/g)) {
        const pathname = normalizeLocalHref(match[1]);
        if (pathname) {
          hrefs.add(pathname);
        }
      }
    }

    for (const pathname of hrefs) {
      expect(isCloudProxiedAgentXPath(pathname), `${pathname} must be proxied to AgentX`).toBe(true);
    }
    for (const pathname of cloudProxyExactPaths) {
      expect(linuxDeploy).toContain(`location = ${pathname}`);
    }
    for (const prefix of cloudProxyPrefixPaths) {
      expect(linuxDeploy).toContain(`location ^~ ${prefix}`);
    }
    expect(linuxDeploy).toContain('通用路由提示');
  });

  it('keeps the published CLI bundle in sync with v1.7 ticket routes', () => {
    const bundle = readDistFile('cli/index.js');

    expect(bundle).toContain('/api/tickets/feedback');
    expect(bundle).toContain('/api/tickets/datasheet');
    expect(bundle).toContain('/api/tickets/account-application');
    expect(bundle).toContain('/api/my/tickets');
    expect(bundle).toContain('/admin/tickets');
    expect(bundle).toContain('tickets.js');
    expect(bundle).toContain('/ticket-system');
    expect(bundle).toContain('feedback.html');
    expect(bundle).toContain('datasheet-submit.html');
    expect(bundle).toContain('updates.html');
    expect(bundle).toContain('updates.js');
    expect(bundle).toContain('join-application.html');
    expect(bundle).toContain('donation-support.html');
  });
});
