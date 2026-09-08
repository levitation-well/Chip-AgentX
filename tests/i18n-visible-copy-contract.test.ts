import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublic(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

const controllers = [
  'account.js',
  'admin.js',
  'announcements.js',
  'auth.js',
  'chat.js',
  'mcp-access.js',
  'product-shell.js',
  'tickets.js',
  'ui-kit.js',
  'updates.js'
];

const engineeringAllowlist = new Set([
  'active',
  'disabled',
  'error',
  'expired',
  'info',
  'success',
  'unavailable',
  'usable',
  'warning'
]);

function visibleLiteralViolations(source: string): string[] {
  const values: string[] = [];
  const assignmentPattern = /(?:textContent|innerText|placeholder|title)\s*=\s*(['"])(.*?)\1/g;
  const callPattern = /(?:setStatus|setError|notify|confirm|alert)\([^;\n]*?(['"])(.*?)\1/g;
  for (const pattern of [assignmentPattern, callPattern]) {
    for (const match of source.matchAll(pattern)) {
      const value = match[2].trim();
      if (!value || engineeringAllowlist.has(value)) continue;
      if (/^(?:account|admin|ann|chat|common|core|mcp|portal|tickets|updates)\.[A-Za-z0-9_.-]+$/.test(value)) continue;
      if (/[\p{Script=Han}A-Za-z]/u.test(value)) values.push(value);
    }
  }
  return [...new Set(values)];
}

function setupLocalizedDom(html: string, locale: 'zh-CN' | 'en-US') {
  const dom = new JSDOM(readPublic(html), {
    url: `http://127.0.0.1:3000/${html}`,
    runScripts: 'outside-only'
  });
  const { window } = dom;
  window.localStorage.setItem('agentx.locale.preference', locale);
  window.localStorage.setItem('agentx.locale.explicit', '1');
  window.localStorage.setItem('agentx.auth.user', JSON.stringify({
    username: 'i18n-test',
    role: 'customer',
    localePreference: locale,
    preferredLanguage: locale
  }));
  Object.assign(window, {
    AgentXAuth: {
      getToken: () => null,
      getUser: () => ({ username: 'i18n-test', role: 'customer', localePreference: locale }),
      setUser: vi.fn()
    }
  });
  window.eval(readPublic('i18n.js'));
  window.eval(readPublic('assets/i18n-portal.js'));
  window.eval(readPublic('assets/i18n-mcp-tickets.js'));
  return { dom, window };
}

describe('visible copy localization gate', () => {
  it.each(controllers)('%s has no direct user-visible string assignments outside the dictionary', (file) => {
    expect(visibleLiteralViolations(readPublic(file)), file).toEqual([]);
  });

  it('renders the updates page from the announcements feed with data-driven counts', async () => {
    const { dom, window } = setupLocalizedDom('updates.html', 'en-US');
    const requests: string[] = [];
    const feedItem = (overrides: Record<string, unknown> = {}) => ({
      id: 'feed-1',
      type: 'release_note',
      title: 'Feed release title',
      summary: 'Feed release summary',
      body: 'First paragraph.\nSecond paragraph.',
      publishedAt: '2026-05-28T00:00:00.000Z',
      updatedAt: '2026-05-28T00:00:00.000Z',
      revision: 1,
      ...overrides
    });
    window.fetch = vi.fn(async (path: string) => {
      requests.push(String(path));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          items: [
            feedItem(),
            feedItem({ id: 'feed-2', type: 'news', title: 'Feed news title', state: { read: false, dismissed: false } })
          ]
        })
      };
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    window.eval(readPublic('updates.js'));
    await flush();
    await flush();

    expect(requests).toContain('/api/announcements/feed?locale=en-US');
    const bodyText = window.document.body.textContent || '';
    expect(bodyText).toContain('Feed release title');
    expect(bodyText).toContain('Feed news title');
    expect(bodyText).not.toContain('v1-8-mcp-security');
    const counts = Array.from(window.document.querySelectorAll('[data-updates-filter] .ct')).map((el) => el.textContent);
    expect(counts).toEqual(['2', '1', '1', '0']);
    expect(window.document.querySelector('.updates-list-item .badge.teal.dot')?.textContent).toBe('Unread');
    expect(window.document.querySelector('.updates-title-block h1')?.textContent).toBe('What’s New');
    expect(window.document.querySelector('.updates-title-block p')?.textContent)
      .toBe('Product releases, platform news, and service announcements.');
    expect(window.document.querySelector('.updates-title-block a')?.textContent).toBe('Back to home updates');
    expect(window.document.querySelector('.updates-title-block')?.getAttribute('aria-label'))
      .toBe('News, announcements, and release notes');
    expect(window.document.querySelector('.updates-filter-row')?.getAttribute('aria-label')).toBe('News filters');
    expect(window.document.querySelector('[data-updates-layout]')?.getAttribute('aria-label')).toBe('News list and detail');
    expect(window.document.querySelector('.updates-list-panel')?.getAttribute('aria-label')).toBe('News list');

    await window.AgentXI18n.setLocale('zh-CN', { syncAccount: false });
    await flush();
    await flush();
    expect(requests).toContain('/api/announcements/feed?locale=zh-CN');
    expect(window.document.querySelector('.updates-list-item .badge.teal.dot')?.textContent).toBe('未读');
    dom.window.close();
  });

  it('localizes Account navigation aria labels without changing the fallback markup', () => {
    const { dom, window } = setupLocalizedDom('account.html', 'en-US');
    window.AgentXI18n.applyLocale('en-US');

    expect(window.document.querySelector('.account-sidenav')?.getAttribute('aria-label'))
      .toBe('Account console navigation');
    const tablists = window.document.querySelectorAll('.account-sidenav-tabs');
    expect(tablists[0]?.getAttribute('aria-label')).toBe('Account workspace');
    expect(tablists[1]?.getAttribute('aria-label')).toBe('Account settings');
    for (const id of [
      'profile-focus-brands',
      'profile-focus-product-lines',
      'profile-focus-chip-directions'
    ]) {
      expect((window.document.getElementById(id) as HTMLTextAreaElement).placeholder)
        .toBe('Separate entries with commas or line breaks');
    }
    dom.window.close();
  });

  it('leaves no Chinese Admin aria labels or placeholders in the English locale', async () => {
    const { dom, window } = setupLocalizedDom('admin.html', 'en-US');
    window.eval(readPublic('assets/i18n-admin.js'));
    window.AgentXI18n.applyLocale('en-US');

    const localizedAttributes = Array.from(
      window.document.querySelectorAll<HTMLElement>('[aria-label], [placeholder]')
    ).flatMap((element) => [
      element.getAttribute('aria-label') || '',
      element.getAttribute('placeholder') || ''
    ]).filter(Boolean);

    expect(localizedAttributes.filter((value) => /\p{Script=Han}/u.test(value))).toEqual([]);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    dom.window.close();
  });

  it('shows the localized empty and error states for the updates feed', async () => {
    const { dom, window } = setupLocalizedDom('updates.html', 'en-US');
    window.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ items: [] })
    }));
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    window.eval(readPublic('updates.js'));
    await flush();
    await flush();
    expect(window.document.querySelector('[data-updates-list] .empty-state')?.textContent).toBe('No updates available');
    dom.window.close();

    const failing = setupLocalizedDom('updates.html', 'zh-CN');
    failing.window.fetch = vi.fn(async () => { throw new Error('network down'); });
    failing.window.eval(readPublic('updates.js'));
    await flush();
    await flush();
    expect(failing.window.document.querySelector('[data-updates-list] .empty-state')?.textContent).toBe('更新加载失败，请稍后重试');
    failing.dom.window.close();
  });

  it('renders ticket-owned dynamic states from the active locale', async () => {
    const { dom, window } = setupLocalizedDom('tickets.html', 'en-US');
    Object.assign(window.AgentXAuth, {
      getUser: () => null,
      authFetch: vi.fn()
    });
    window.eval(readPublic('tickets.js'));

    expect(window.document.getElementById('my-tickets-status')?.textContent)
      .toBe('Log in to view tickets linked to your account.');
    dom.window.close();
  });
});
