import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function okJson(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => payload
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: 'announcement-1',
    type: 'announcement',
    status: 'published',
    title: 'Service notice',
    summary: 'Short summary',
    body: 'Safe plain body',
    visibility: 'public',
    requiresLogin: false,
    pinned: false,
    priority: 10,
    modalBehavior: 'once_per_version',
    revision: 1,
    publishedAt: '2026-05-30T07:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    ...overrides
  };
}

async function setupDom(htmlName: string, handler: (path: string, init?: RequestInit) => Promise<any>, auth = false) {
  const dom = new JSDOM(readPublicFile(htmlName), {
    url: htmlName === 'index.html' ? 'http://127.0.0.1:3000/home' : `http://127.0.0.1:3000/${htmlName.replace('.html', '')}`,
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  window.fetch = vi.fn((path, init) => handler(String(path), init as RequestInit)) as any;
  if (auth) {
    window.AgentXAuth = {
      getToken: () => 'test-token',
      authFetch: vi.fn((path: string, init?: RequestInit) => handler(path, init))
    };
  }
  window.eval(readPublicFile('i18n.js'));
  window.eval(readPublicFile('assets/i18n-mcp-tickets.js'));
  window.eval(readPublicFile('announcements.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  return window;
}

describe('announcement user UI', () => {
  it('renders the Home feed and dismisses once-per-revision modal locally for anonymous users', async () => {
    const payload = {
      modalCandidate: item(),
      feed: [item(), item({ id: 'news-1', type: 'news', title: 'News item', modalBehavior: 'none' })]
    };
    const window = await setupDom('index.html', async (path) => {
      expect(path).toBe('/api/announcements/home?locale=en-US');
      return okJson(payload);
    });

    expect(window.document.body.textContent).toContain('Service notice');
    expect(window.document.querySelector('.announcement-modal-backdrop')).toBeTruthy();

    (window.document.querySelector('.announcement-modal-panel .primary-button') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.localStorage.getItem('dismissed:announcement-1:1')).toBe('1');
    expect(window.document.querySelector('.announcement-modal-backdrop')).toBeFalsy();

    await window.AgentXAnnouncements.init();
    await flushBrowserTasks();
    expect(window.document.querySelector('.announcement-modal-backdrop')).toBeFalsy();
  });

  it('keeps force-until-expiry Home modal eligible on every reload while rendering only server DTOs', async () => {
    const force = item({
      id: 'force-1',
      title: 'Forced notice',
      modalBehavior: 'force_until_expiry',
      endsAt: '2026-05-31T07:00:00.000Z'
    });
    const window = await setupDom('index.html', async () => okJson({ modalCandidate: force, feed: [force] }));

    (window.document.querySelector('.announcement-modal-panel .primary-button') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.localStorage.getItem('dismissed:force-1:1')).toBe('1');

    await window.AgentXAnnouncements.init();
    await flushBrowserTasks();
    expect(window.document.querySelector('.announcement-modal-backdrop')?.textContent).toContain('Forced notice');
    expect(window.document.body.textContent).not.toContain('sourceRef');
  });

  it('does not initialize announcements on Chat because updates live on the news page', async () => {
    const calls: string[] = [];
    const window = await setupDom(
      'chat.html',
      async (path) => {
        calls.push(path);
        return okJson({ items: [item({ id: 'a1', title: 'A1' })] });
      },
      true
    );

    expect(window.document.querySelector('[data-announcements-chat]')).toBeNull();
    expect(window.document.querySelector('.chat-announcements-list')).toBeNull();
    expect(calls).toEqual([]);
    expect(window.document.querySelector('.announcement-modal-backdrop')).toBeFalsy();
  });
});
