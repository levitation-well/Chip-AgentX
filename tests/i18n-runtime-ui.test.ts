import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublic(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function createRuntime(options: {
  language?: string;
  user?: Record<string, unknown>;
  savedLocale?: string;
  explicit?: boolean;
  accountSaveOk?: boolean;
} = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><head><title>AgentX</title></head><body><span data-agentx-locale-root></span><p data-i18n="portal.common.refresh">刷新</p><textarea id="localized-textarea" data-i18n-placeholder="chat.message.placeholder" placeholder="输入芯片型号、寄存器名称或工程问题…"></textarea></body></html>',
    { url: 'https://agentx.example/home', runScripts: 'outside-only' }
  );
  const { window } = dom;
  Object.defineProperty(window.navigator, 'language', {
    configurable: true,
    value: options.language ?? 'zh-CN'
  });
  Object.defineProperty(window.navigator, 'languages', {
    configurable: true,
    value: [options.language ?? 'zh-CN']
  });
  if (options.user) {
    window.localStorage.setItem('agentx.auth.user', JSON.stringify(options.user));
  }
  if (options.savedLocale) {
    window.localStorage.setItem('agentx.locale.preference', options.savedLocale);
  }
  if (options.explicit) {
    window.localStorage.setItem('agentx.locale.explicit', '1');
  }

  const authFetch = vi.fn(async () => ({
    ok: options.accountSaveOk !== false,
    json: async () => options.accountSaveOk === false
      ? { error: 'save failed', code: 'LOCALE_SAVE_FAILED' }
      : { user: { localePreference: 'en-US', preferredLanguage: 'en-US' } }
  }));
  Object.assign(window, {
    AgentXAuth: {
      getToken: () => options.user ? 'token' : null,
      getUser: () => options.user ?? null,
      setUser: vi.fn(),
      authFetch
    }
  });
  window.eval(readPublic('i18n.js'));
  for (const asset of [
    'assets/i18n-portal.js',
    'assets/i18n-mcp-tickets.js',
    'assets/i18n-chat.js',
    'assets/i18n-admin.js'
  ]) {
    window.eval(readPublic(asset));
  }
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  return { dom, window, i18n: window.AgentXI18n, authFetch };
}

describe('shared bilingual runtime', () => {
  it('uses account preference before explicit local choice and browser language', () => {
    const account = createRuntime({
      language: 'en-US',
      savedLocale: 'en-US',
      explicit: true,
      user: { localePreference: 'zh-CN' }
    });
    expect(account.i18n.getLocale()).toBe('zh-CN');
    expect(account.window.document.documentElement.lang).toBe('zh-CN');

    const guest = createRuntime({ language: 'zh-CN', savedLocale: 'en-US', explicit: true });
    expect(guest.i18n.getLocale()).toBe('en-US');

    const firstVisit = createRuntime({ language: 'en-GB' });
    expect(firstVisit.i18n.getLocale()).toBe('en-US');
  });

  it('keeps catalogs symmetric and supports interpolation, fallback, Intl, and DOM attributes', () => {
    const { i18n, window } = createRuntime();
    expect(Object.keys(i18n.catalog['zh-CN']).sort()).toEqual(Object.keys(i18n.catalog['en-US']).sort());
    expect(i18n.t('chat.session.current', { title: 'E521.39' }, 'en-US')).toBe('Current session: E521.39');
    expect(i18n.t('chat.workspace.label', undefined, 'zh-CN')).toBe('对话');
    expect(i18n.t('common.loading', undefined, 'en-US')).toBe('Loading…');
    expect(i18n.t('updates.loading', undefined, 'en-US')).toBe('Loading updates…');
    expect(i18n.t('missing.translation.key', undefined, 'en-US')).toBe('missing.translation.key');
    expect(i18n.formatNumber(1234.5, {}, 'en-US')).toContain('1,234.5');
    expect(i18n.formatDate('2026-07-16T00:00:00.000Z', { year: 'numeric' }, 'en-US')).toContain('2026');
    expect(i18n.collator({ numeric: true }, 'en-US').compare('item2', 'item10')).toBeLessThan(0);

    const textarea = window.document.getElementById('localized-textarea') as HTMLTextAreaElement;
    textarea.value = 'typed user text';
    const originalTextContent = textarea.textContent;

    i18n.setLocale('en-US', { persist: false, syncAccount: false });
    expect(window.document.querySelector('[data-i18n="portal.common.refresh"]')?.textContent).toBe('Refresh');
    expect(textarea.placeholder).toBe('Ask about a chip, register, or engineering problem…');
    expect(textarea.value).toBe('typed user text');
    expect(textarea.textContent).toBe(originalTextContent);

    i18n.setLocale('zh-CN', { persist: false, syncAccount: false });
    expect(textarea.placeholder).toBe('输入芯片型号、寄存器名称或工程问题…');
    expect(textarea.value).toBe('typed user text');
    expect(textarea.textContent).toBe(originalTextContent);
    expect(window.document.querySelectorAll('[data-agentx-locale-switch] button')).toHaveLength(2);
  });

  it('rolls back a failed authenticated save and emits localechange', async () => {
    const { i18n, window, authFetch } = createRuntime({
      user: { localePreference: 'zh-CN' },
      accountSaveOk: false
    });
    const events: string[] = [];
    window.addEventListener('localechange', (event) => {
      events.push((event as CustomEvent<{ source: string }>).detail.source);
    });

    await expect(i18n.setLocale('en-US')).rejects.toThrow('save failed');
    expect(authFetch).toHaveBeenCalledWith('/api/account/locale', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ locale: 'en-US' })
    }));
    expect(i18n.getLocale()).toBe('zh-CN');
    expect(window.document.documentElement.lang).toBe('zh-CN');
    expect(events).toEqual(['local', 'rollback']);
  });

  it('reacts to storage and pageshow restoration without leaving stale DOM', () => {
    const { i18n, window } = createRuntime({ language: 'zh-CN' });
    window.dispatchEvent(new window.StorageEvent('storage', {
      key: i18n.LOCALE_KEY,
      newValue: 'en-US'
    }));
    expect(i18n.getLocale()).toBe('en-US');
    expect(window.document.querySelector('[data-i18n="portal.common.refresh"]')?.textContent).toBe('Refresh');

    window.localStorage.setItem(i18n.LOCALE_KEY, 'zh-CN');
    window.localStorage.setItem('agentx.locale.explicit', '1');
    window.dispatchEvent(new window.PageTransitionEvent('pageshow'));
    expect(i18n.getLocale()).toBe('zh-CN');
  });
});

describe('production page locale wiring', () => {
  const pages = [
    'index.html',
    'login.html',
    'chat.html',
    'account.html',
    'mcp-access.html',
    'tickets.html',
    'feedback.html',
    'datasheet-submit.html',
    'updates.html',
    'join-application.html',
    'donation-support.html',
    'mcp-client.html',
    'admin.html'
  ];

  it.each(pages)('%s has first-paint bootstrap and the shared 2.2.44 runtime', (page) => {
    const html = readPublic(page);
    expect(html).toContain('agentx.locale.preference');
    expect(html).toContain('document.documentElement.lang=');
    expect(html).toContain('/i18n.js?v=2.2.44');
    expect(
      html.includes('data-agentx-locale-root') || html.includes('data-portal-auth'),
      `${page} needs an explicit locale slot or the shared portal auth insertion point`
    ).toBe(true);
  });
});
