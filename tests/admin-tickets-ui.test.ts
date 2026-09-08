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

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    ticketNo: 'FB-20260706-0001',
    type: 'feedback',
    status: 'submitted',
    title: 'First ticket',
    needsMoreInfo: false,
    publicNote: '',
    internalNote: '',
    result: '',
    payload: {},
    attachments: [],
    messages: [],
    createdAt: '2026-07-06T06:00:00.000Z',
    updatedAt: '2026-07-06T07:00:00.000Z',
    ...overrides
  };
}

// V5: mirrors the announcements admin UI boot pattern (tests/announcements-admin-ui.test.ts)
// so the ticket workbench gets the same stale-response guard coverage.
async function bootAdminPage() {
  const dom = new JSDOM(readPublicFile('admin.html'), {
    url: 'http://127.0.0.1:3000/admin/sections/feedback',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  const calls: Array<{ path: string; options?: any }> = [];
  const items = [
    ticket({ ticketNo: 'FB-20260706-0001', title: 'Ticket A' }),
    ticket({ ticketNo: 'FB-20260706-0002', title: 'Ticket B' })
  ];

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
      if (path.startsWith('/admin/tickets?')) {
        return jsonResponse({ items, total: items.length });
      }
      const detailMatch = /^\/admin\/tickets\/([^/]+)$/.exec(path);
      if (detailMatch) {
        const ticketNo = decodeURIComponent(detailMatch[1]!);
        const current = items.find((item) => item.ticketNo === ticketNo) || ticket({ ticketNo });
        if (requestOptions?.method === 'PATCH') {
          const updated = { ...current, ...JSON.parse(requestOptions.body) };
          const index = items.findIndex((item) => item.ticketNo === ticketNo);
          if (index >= 0) items[index] = updated;
          return jsonResponse({ ticket: updated });
        }
        return jsonResponse({ ticket: current });
      }
      throw new Error(`Unexpected admin fetch: ${path}`);
    }
  };

  window.eval(readPublicFile('admin.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  await flushBrowserTasks();
  return { window, calls, items };
}

describe('V5: admin ticket detail staleness guard', () => {
  it('ignores a stale slow ticket detail response after switching selection, keeping the newer selection intact', async () => {
    const { window } = await bootAdminPage();
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseStaleTicketA: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/tickets/FB-20260706-0001' && !requestOptions?.method) {
        return new Promise((resolve) => {
          releaseStaleTicketA = () => resolve(jsonResponse({ ticket: ticket({ ticketNo: 'FB-20260706-0001', title: 'Ticket A' }) }));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    const rows = [...window.document.querySelectorAll('.ticket-admin-card')] as HTMLButtonElement[];
    expect(rows.length).toBe(2);

    // Select A (slow response, held back) then quickly switch to B (fast response).
    rows[0]!.click();
    await flushBrowserTasks();
    rows[1]!.click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    // B's detail should now be showing.
    expect(window.document.getElementById('ticket-admin-detail-title')?.textContent).toContain('Ticket B');

    // Now release the stale A response — it must NOT clobber B's already-rendered detail.
    releaseStaleTicketA?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('ticket-admin-detail-title')?.textContent).toContain('Ticket B');
  });

  it('does not let a stale earlier ticket detail response clobber the currently selected ticket detail (so saving cannot mix A/B state)', async () => {
    const { window } = await bootAdminPage();
    const originalAuthFetch = window.AgentXAuth.authFetch;
    let releaseStaleTicketA: (() => void) | undefined;
    window.AgentXAuth.authFetch = async (path: string, requestOptions?: any) => {
      if (path === '/admin/tickets/FB-20260706-0001' && !requestOptions?.method) {
        return new Promise((resolve) => {
          releaseStaleTicketA = () => resolve(jsonResponse({ ticket: ticket({ ticketNo: 'FB-20260706-0001', title: 'Ticket A' }) }));
        });
      }
      return originalAuthFetch(path, requestOptions);
    };

    const rows = [...window.document.querySelectorAll('.ticket-admin-card')] as HTMLButtonElement[];
    // Select A (slow response, held back) then quickly switch to B (fast response).
    rows[0]!.click();
    await flushBrowserTasks();
    rows[1]!.click();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('ticket-admin-detail-title')?.textContent).toContain('Ticket B');

    // A's stale response finally resolves after the switch — it must not overwrite B's selectedDetail,
    // since a subsequent save reads `selectedTicketNo` (already B) together with `selectedDetail`
    // (would wrongly become A's) to build the PATCH body.
    releaseStaleTicketA?.();
    await flushBrowserTasks();
    await flushBrowserTasks();

    expect(window.document.getElementById('ticket-admin-detail-title')?.textContent).toContain('Ticket B');

    const noteField = window.document.getElementById('ticket-admin-public-note') as HTMLTextAreaElement;
    expect(noteField.value).toBe('');
  });
});
