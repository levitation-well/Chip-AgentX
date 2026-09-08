import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload
  };
}

function flushBrowserTasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function announcement(overrides: Record<string, unknown> = {}) {
  return {
    id: 'announcement-1',
    type: 'announcement',
    status: 'draft',
    title: 'Service notice',
    summary: 'Short summary',
    body: 'Safe body',
    visibility: 'public',
    requiresLogin: false,
    roleAllowList: [],
    requiredGrants: {},
    pinned: false,
    priority: 5,
    modalBehavior: 'none',
    revision: 1,
    createdAt: '2026-05-30T06:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    createdBy: 'admin',
    updatedBy: 'admin',
    sourceRef: { kind: 'manual', note: 'internal candidate' },
    readStateSummary: { revision: 1, readCount: 2, dismissedCount: 1 },
    ...overrides
  };
}

async function bootAdminPage() {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: 'http://127.0.0.1:3000/admin/sections/announcements',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];
  let items = [announcement(), announcement({ id: 'news-1', type: 'news', status: 'published', title: 'News item' })];

  window.confirm = vi.fn(() => true);
  window.AgentXAuth = {
    getUser: () => ({ username: 'root', role: 'admin' }),
    logout: () => undefined,
    login: async () => ({ user: { username: 'root', role: 'admin' } }),
    clearToken: () => undefined,
    authFetch: async (path: string, requestOptions?: any) => {
      calls.push({ path, options: requestOptions });
      if (path === '/admin/chips') return jsonResponse({ chips: [], knowledgeBaseRoot: '' });
      if (path === '/admin/users') return jsonResponse({ users: [] });
      if (path === '/admin/chip-access') return jsonResponse({ users: {} });
      if (path === '/admin/prompts') return jsonResponse({ files: [] });
      if (path === '/admin/roles') return jsonResponse({ roles: {}, _permissions: {} });
      if (path.startsWith('/admin/announcements?')) {
        return jsonResponse({ items: items.filter((item) => item.type === 'news'), total: 1 });
      }
      if (path === '/admin/announcements') {
        if (requestOptions?.method === 'POST') {
          const created = announcement({ id: 'created-1', ...JSON.parse(requestOptions.body), status: 'draft' });
          items = [created, ...items];
          return jsonResponse({ item: created }, 201);
        }
        return jsonResponse({ items, total: items.length });
      }
      const detailMatch = /^\/admin\/announcements\/([^/]+)(?:\/([^/]+))?$/.exec(path);
      if (detailMatch) {
        const id = decodeURIComponent(detailMatch[1]!);
        const action = detailMatch[2];
        const current = items.find((item) => item.id === id) || announcement({ id });
        if (requestOptions?.method === 'PATCH') {
          const updated = { ...current, ...JSON.parse(requestOptions.body), revision: Number(current.revision) + 1 };
          items = items.map((item) => (item.id === id ? updated : item));
          return jsonResponse({ item: updated });
        }
        if (requestOptions?.method === 'POST' && action) {
          const updated = action === 'duplicate'
            ? announcement({ id: 'duplicate-1', status: 'draft', title: `${current.title} Copy` })
            : { ...current, status: action === 'publish' ? 'published' : action === 'offline' ? 'offline' : 'archived' };
          if (action === 'duplicate') {
            items = [updated, ...items];
          } else {
            items = items.map((item) => (item.id === id ? updated : item));
          }
          return jsonResponse({ item: updated }, action === 'duplicate' ? 201 : 200);
        }
        return jsonResponse({ item: current });
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

describe('announcement admin UI', () => {
  it('exposes the announcements section and editor controls', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('data-section="announcements"');
    expect(html).toContain('id="panel-announcements"');
    expect(html).toContain('announcement-admin-filter-type');
    expect(html).toContain('announcement-admin-grant-chip-ids');
    expect(html).toContain('announcement-admin-source-kind');
    expect(html).toContain('announcement-admin-preview-col');
    expect(html).toContain('announcement-admin-more-filters');
    expect(html).toContain('announcement-preview-card-outer');
    expect(html).not.toContain('announcement-admin-required-grants');
    expect(html).not.toContain('announcement-admin-source-ref');
    expect(readPublicFile('admin.js')).not.toContain('.innerHTML');
    expect(readPublicFile('admin.js')).toContain('renderAnnouncementEditorPreview');
    expect(readPublicFile('admin.js')).toContain('选择或新建公告后显示用户端预览');
    expect(readPublicFile('admin.js')).toContain("addEventListener('input', refreshAnnouncementPreview)");
    expect(readPublicFile('admin.js')).toContain('applyAnnouncementFilters');
    expect(readPublicFile('styles.css')).toContain('grid-template-columns: minmax(280px, 320px) minmax(0, 1fr) minmax(240px, 280px)');
  });

  it('loads, filters, edits, and publishes announcements through admin endpoints', async () => {
    const { window, calls } = await bootAdminPage();

    expect((window.document.getElementById('panel-announcements') as HTMLElement).hidden).toBe(false);
    expect(calls.some((call) => call.path === '/admin/announcements')).toBe(true);
    expect(window.document.getElementById('announcement-admin-list')?.textContent).toContain('Service notice');
    expect(window.document.getElementById('announcement-admin-list')?.textContent).toContain('read 2');

    (window.document.querySelector('.announcement-admin-row') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.document.getElementById('announcement-admin-read-summary')?.textContent).toContain('dismiss 1');
    expect((window.document.getElementById('announcement-admin-source-label') as HTMLInputElement).value).toContain('internal candidate');

    (window.document.getElementById('announcement-admin-title-input') as HTMLInputElement).value = 'Updated notice';
    // V12：假阳性回归测试——之前直接给 <div id="announcement-admin-grant-chip-ids"> 赋 `.value` 只是
    // 加了一个 JS expando 属性（DOM 元素允许任意属性赋值），并不是真实的 <input> 交互。旧断言只因
    // `getTokenFieldValues` 的 `'value' in target` 短路巧合命中了这个 expando 才「往返」成功，从未真正
    // 走过 `.admin-token-input` 的 change 事件路径。这里改为定位该 div 内真实渲染出的 `.admin-token-input`，
    // 设值并派发真实 change 事件，断言芯片确实被加入 requiredGrants（走真实交互路径，而非 expando 巧合）。
    const chipGrantContainer = window.document.getElementById('announcement-admin-grant-chip-ids') as HTMLElement;
    const chipGrantInput = chipGrantContainer.querySelector('.admin-token-input') as HTMLInputElement;
    expect(chipGrantInput).toBeTruthy();
    chipGrantInput.value = 'E521.39';
    chipGrantInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    (window.document.getElementById('announcement-admin-source-kind') as HTMLSelectElement).value = 'phase_release_note';
    (window.document.getElementById('announcement-admin-source-id') as HTMLInputElement).value = '42';
    (window.document.getElementById('announcement-admin-source-url') as HTMLInputElement).value = '2.2.25';
    (window.document.getElementById('announcement-admin-source-label') as HTMLInputElement).value = 'FE4 rollout note';
    (window.document.getElementById('announcement-admin-editor') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();
    const patchCall = calls.find((call) => call.path === '/admin/announcements/announcement-1' && call.options?.method === 'PATCH');
    const patchBody = JSON.parse(patchCall?.options.body);
    expect(patchBody.title).toBe('Updated notice');
    expect(patchBody.requiredGrants).toEqual({ chipIds: ['E521.39'] });
    expect(patchBody.sourceRef).toEqual({ kind: 'phase_release_note', phase: 42, version: '2.2.25', note: 'FE4 rollout note' });

    const publishButton = [...window.document.querySelectorAll('#announcement-admin-actions button')]
      .find((button) => button.textContent === '发布') as HTMLButtonElement;
    publishButton.click();
    await flushBrowserTasks();
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/announcements/announcement-1/publish')).toBe(true);

    (window.document.getElementById('announcement-admin-filter-type') as HTMLSelectElement).value = 'news';
    (window.document.getElementById('announcement-admin-filter-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    expect(calls.some((call) => call.path === '/admin/announcements?type=news')).toBe(true);
    expect(window.document.getElementById('announcement-admin-list')?.textContent).toContain('News item');
  });

  it('applies visible announcement filters without opening advanced filters', async () => {
    const { window, calls } = await bootAdminPage();

    (window.document.getElementById('announcement-admin-filter-type') as HTMLSelectElement).value = 'news';
    (window.document.getElementById('announcement-admin-filter-type') as HTMLSelectElement).dispatchEvent(
      new window.Event('change', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(calls.some((call) => call.path === '/admin/announcements?type=news')).toBe(true);
    expect((window.document.querySelector('.announcement-admin-more-filters') as HTMLDetailsElement).open).toBe(false);
  });

  it('does not send a partial sourceRef when no supported source kind is selected', async () => {
    const { window, calls } = await bootAdminPage();

    (window.document.querySelector('.announcement-admin-row') as HTMLButtonElement).click();
    await flushBrowserTasks();
    (window.document.getElementById('announcement-admin-source-kind') as HTMLSelectElement).value = '';
    (window.document.getElementById('announcement-admin-source-id') as HTMLInputElement).value = '42';
    (window.document.getElementById('announcement-admin-source-url') as HTMLInputElement).value = '2.2.25';
    (window.document.getElementById('announcement-admin-source-label') as HTMLInputElement).value = 'orphan note';
    (window.document.getElementById('announcement-admin-editor') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    const patchCall = calls.find((call) => call.path === '/admin/announcements/announcement-1' && call.options?.method === 'PATCH');
    expect(JSON.parse(patchCall?.options.body).sourceRef).toBeNull();
  });

  it('ignores stale failed announcement detail loads after switching selection', async () => {
    const { window } = await bootAdminPage();
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseStaleFailure: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/announcements/announcement-1') {
        return new Promise((resolve) => {
          releaseStaleFailure = () => resolve(jsonResponse({ error: 'stale failure' }, 500));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    const rows = [...window.document.querySelectorAll('.announcement-admin-row')] as HTMLButtonElement[];
    rows[0]!.click();
    await flushBrowserTasks();
    rows[1]!.click();
    await flushBrowserTasks();
    releaseStaleFailure?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('announcement-admin-error')?.textContent).toBe('');
    expect(window.document.getElementById('announcement-admin-editor-title')?.textContent).toContain('News item');
  });

  it('clears the right-side announcement preview while no detail is selected', async () => {
    const { window } = await bootAdminPage();

    (window.document.querySelector('.announcement-admin-row') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.document.getElementById('announcement-admin-portal-preview')?.textContent).toContain('Short summary');

    (window.document.getElementById('announcement-admin-filter-type') as HTMLSelectElement).value = 'changelog';
    (window.document.getElementById('announcement-admin-filter-form') as HTMLFormElement).dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true })
    );
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect((window.document.getElementById('announcement-admin-editor') as HTMLFormElement).hidden).toBe(true);
    expect(window.document.getElementById('announcement-admin-portal-preview')?.textContent).toContain('选择或新建公告后显示用户端预览');
    expect(window.document.getElementById('announcement-admin-portal-preview')?.textContent).not.toContain('Short summary');
  });

  it('ignores stale rejected announcement detail requests after switching selection', async () => {
    const { window } = await bootAdminPage();
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let rejectStaleRequest: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/announcements/announcement-1') {
        return new Promise((_, reject) => {
          rejectStaleRequest = () => reject(new Error('stale network failure'));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    const rows = [...window.document.querySelectorAll('.announcement-admin-row')] as HTMLButtonElement[];
    rows[0]!.click();
    await flushBrowserTasks();
    rows[1]!.click();
    await flushBrowserTasks();
    rejectStaleRequest?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('announcement-admin-error')?.textContent).toBe('');
    expect(window.document.getElementById('announcement-admin-editor-title')?.textContent).toContain('News item');
  });
});
