import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../public/product-shell.js', import.meta.url), 'utf8');

function createDom() {
  return new JSDOM(
    [
      '<!doctype html><html><body>',
      '<span data-portal-auth></span>',
      '<span data-product-name></span>',
      '<span data-product-version></span>',
      '<span data-product-signature></span>',
      '<span data-product-fingerprint></span>',
      '<a data-product-link="github" hidden>GitHub</a>',
      '<div data-product-changelog></div>',
      '<a data-donation-float href="#"><small data-donation-float-note></small></a>',
      '<section data-donation-root>',
      '<span data-donation-status></span>',
      '<input type="radio" name="donationAmount" value="5" checked>',
      '<input type="radio" name="donationAmount" value="10">',
      '<input type="radio" name="donationAmount" value="custom">',
      '<input data-donation-custom-amount type="number">',
      '<p data-donation-selected-amount></p>',
      '<div data-donation-qr="alipay"></div>',
      '<a data-donation-link="alipay" hidden>Alipay</a>',
      '<p data-donation-unavailable="alipay"></p>',
      '<div data-donation-qr="wechat"></div>',
      '<a data-donation-link="wechat" hidden>Wechat</a>',
      '<p data-donation-unavailable="wechat"></p>',
      '</section>',
      '</body></html>'
    ].join(''),
    { url: 'http://127.0.0.1:3000/', runScripts: 'outside-only' }
  );
}

describe('product shell helper', () => {
  it('renders version, signature, changelog, and configured links', async () => {
    const dom = createDom();
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/api/version')
          ? {
              version: '2.1.1',
              edition: 'public',
              landingMode: 'always',
              branding: {
                enabled: true,
                productName: 'AgentX Public',
                signature: 'Powered by AgentX',
                tooltip: 'AgentX',
                homepageUrl: '/home',
                githubUrl: 'https://example.com/repo'
              },
              fingerprint: {
                enabled: true,
                level: 'light',
                owner: 'AgentX',
                deploymentId: 'agentx-public',
                channel: 'web',
                version: '2.1.1',
                signed: true,
                marker: 'agentx-fp:v1.payload.signature'
              },
              donation: {
                enabled: true,
                alipayQrUrl: '/assets/donation/alipay.example.png',
                alipayLink: 'https://pay.example.com/alipay',
                wechatLink: '/donation/wechat'
              }
            }
          : {
              available: true,
              entries: [{ version: '2.1.1', date: '2026-05-30', items: ['Product shell'] }]
            }
    }));
    dom.window.fetch = fetchMock as never;
    dom.window.eval(script);

    await dom.window.AgentXProductShell.init(dom.window.document);

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/version');
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/changelog');
    expect(dom.window.document.querySelector('[data-product-name]')?.textContent).toBe('AgentX Public');
    expect(dom.window.document.querySelector('[data-product-version]')?.textContent).toBe('v2.1.1 · public');
    expect(dom.window.document.querySelector('[data-product-signature]')?.textContent).toBe('Powered by AgentX');
    expect(dom.window.document.querySelector('[data-product-signature] a')?.getAttribute('title')).toBe('AgentX');
    expect(dom.window.document.querySelector('[data-product-signature] a')?.getAttribute('href')).toBe('/home');
    expect(dom.window.document.querySelector('[data-product-link="github"]')?.getAttribute('href')).toBe('https://example.com/repo');
    expect(dom.window.document.querySelector('[data-product-changelog]')?.textContent).toContain('更新日志');
    expect(dom.window.document.querySelector('[data-product-changelog]')?.textContent).toContain('Product shell');
    expect(dom.window.document.querySelector('meta[name="agentx-fingerprint"]')?.getAttribute('content')).toBe(
      'agentx-fp:v1.payload.signature'
    );
    expect(dom.window.document.documentElement.getAttribute('data-agentx-fingerprint')).toBe(
      'agentx-fp:v1.payload.signature'
    );
    expect(dom.window.document.querySelector('[data-product-fingerprint]')?.textContent).toContain('agentx-public');
    expect(dom.window.document.querySelector('[data-donation-status]')?.textContent).toBe('可扫码或跳转');
    expect(dom.window.document.querySelector('[data-donation-float]')?.getAttribute('href')).toBe(
      '/donation-support'
    );
    expect(dom.window.document.querySelector('[data-donation-float-note]')?.textContent).toBe('查看二维码/链接');
    expect(dom.window.document.querySelector('[data-donation-qr="alipay"] img')?.getAttribute('src')).toBe(
      '/assets/donation/alipay.example.png'
    );
    expect((dom.window.document.querySelector('[data-donation-qr="wechat"]') as HTMLElement).hidden).toBe(true);
    expect(dom.window.document.querySelector('[data-donation-link="alipay"]')?.getAttribute('href')).toBe(
      'https://pay.example.com/alipay'
    );
    expect(dom.window.document.querySelector('[data-donation-link="wechat"]')?.getAttribute('href')).toBe(
      '/donation/wechat'
    );
    expect((dom.window.document.querySelector('[data-donation-unavailable="alipay"]') as HTMLElement).hidden).toBe(
      true
    );
  });

  it('soft-fails when product APIs are unavailable', async () => {
    const dom = createDom();
    dom.window.fetch = vi.fn(async () => {
      throw new Error('offline');
    }) as never;
    dom.window.eval(script);

    await expect(dom.window.AgentXProductShell.init(dom.window.document)).resolves.toBeUndefined();

    expect(dom.window.document.querySelector('[data-product-name]')?.textContent).toBe('AgentX');
    expect(dom.window.document.querySelector('[data-product-signature]')?.textContent).toBe('Powered by AgentX');
    expect((dom.window.document.querySelector('[data-product-changelog]') as HTMLElement).hidden).toBe(true);
    expect(dom.window.document.querySelector('[data-donation-status]')?.textContent).toBe('暂未开放');
    expect((dom.window.document.querySelector('[data-donation-unavailable="alipay"]') as HTMLElement).hidden).toBe(
      false
    );
  });

  it('updates donation amount display without writing payment state', () => {
    const dom = createDom();
    dom.window.fetch = vi.fn() as never;
    dom.window.eval(script);
    dom.window.AgentXProductShell.render(dom.window.document, {
      version: {
        donation: { enabled: true }
      },
      changelog: { available: false, entries: [] }
    });

    const customInput = dom.window.document.querySelector('[data-donation-custom-amount]') as HTMLInputElement;
    const fixedTen = dom.window.document.querySelector('input[name="donationAmount"][value="10"]') as HTMLInputElement;
    const customRadio = dom.window.document.querySelector(
      'input[name="donationAmount"][value="custom"]'
    ) as HTMLInputElement;

    customRadio.checked = true;
    customRadio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(dom.window.document.querySelector('[data-donation-selected-amount]')?.textContent).toBe('当前选择：5 元');

    customInput.value = '88';
    customInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    expect(dom.window.document.querySelector('[data-donation-selected-amount]')?.textContent).toBe('当前选择：88 元');
    expect(customRadio.checked).toBe(true);

    fixedTen.checked = true;
    fixedTen.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(customInput.value).toBe('');
    expect(dom.window.document.querySelector('[data-donation-selected-amount]')?.textContent).toBe('当前选择：10 元');
    expect(script).not.toContain('/api/donation');
    expect(script).not.toContain('donationOrder');
    expect(script).not.toContain('paymentStatus');
  });

  it('renders fingerprint idempotently and never executes marker as HTML', async () => {
    const dom = createDom();
    dom.window.fetch = vi.fn() as never;
    dom.window.eval(script);
    const marker = 'agentx-fp:v1.payload.signature"><script>alert(1)</script>';

    const payload = {
      version: {
        version: '2.1.1',
        edition: 'public',
        branding: { enabled: true },
        fingerprint: {
          enabled: true,
          level: 'light',
          signed: true,
          owner: 'AgentX',
          deploymentId: 'deployment',
          channel: 'web',
          marker
        }
      },
      changelog: { available: false, entries: [] }
    };
    dom.window.AgentXProductShell.render(dom.window.document, payload);
    dom.window.AgentXProductShell.render(dom.window.document, payload);

    expect(dom.window.document.querySelectorAll('meta[name="agentx-fingerprint"]')).toHaveLength(1);
    expect(dom.window.document.querySelector('meta[name="agentx-fingerprint"]')?.getAttribute('content')).toBe(marker);
    expect(dom.window.document.querySelectorAll('script')).toHaveLength(0);
  });

  it('rejects unsafe configured URLs', () => {
    const dom = createDom();
    dom.window.fetch = vi.fn() as never;
    dom.window.eval(script);

    expect(dom.window.AgentXProductShell.safeUrl('javascript:alert(1)')).toBe('');
    expect(dom.window.AgentXProductShell.safeUrl('//example.com')).toBe('');
    expect(dom.window.AgentXProductShell.safeUrl('/docs\nsecret')).toBe('');
    expect(dom.window.AgentXProductShell.safeUrl('/docs')).toBe('/docs');
    expect(dom.window.AgentXProductShell.safeUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('renders a user dropdown with account/admin/logout entries by role', async () => {
    const dom = createDom();
    dom.window.fetch = vi.fn() as never;
    dom.window.eval(script);
    // C2 fix: admin link is gated on server-confirmed role (/auth/me), not localStorage.
    // Stub no-token window so init() leaves serverAdminRole=false.
    dom.window.AgentXAuth = { getToken: () => null, authFetch: vi.fn() } as never;

    dom.window.localStorage.setItem('agentx.auth.user', JSON.stringify({ username: 'cust', role: 'customer' }));
    await dom.window.AgentXProductShell.init(dom.window.document);
    dom.window.AgentXProductShell.renderPortalAuth(dom.window.document);
    expect(dom.window.document.querySelector('[data-portal-auth] .portal-user-trigger')?.textContent).toContain('cust');
    expect(dom.window.document.querySelector('[data-portal-auth] .portal-user-avatar')?.textContent).toBe('C');
    expect(dom.window.document.querySelector('[data-portal-auth] a[href="/account"]')?.textContent).toBe('用户中心');
    expect(dom.window.document.querySelector('[data-portal-auth] a[href="/admin"]')).toBeNull();
    expect(dom.window.document.querySelector('[data-portal-auth] .portal-user-logout')).not.toBeNull();

    dom.window.localStorage.setItem('agentx.auth.user', JSON.stringify({ username: 'admin', role: 'admin' }));
    // Server-confirmed admin role enables admin link (localStorage role now ignored).
    dom.window.AgentXAuth = {
      getToken: () => 'stub-token',
      authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { role: 'admin' } }) })
    } as never;
    await dom.window.AgentXProductShell.init(dom.window.document);
    const adminLink = dom.window.document.querySelector('[data-portal-auth] a[href="/admin"]');
    expect(adminLink).not.toBeNull();
    expect(adminLink?.textContent).toBe('账户管理');
    dom.window.AgentXProductShell.renderPortalAuth(dom.window.document);
    expect(dom.window.document.querySelectorAll('[data-portal-auth] a[href="/admin"]')).toHaveLength(1);

    // A later server-confirmed non-admin response must remove a stale admin entry.
    dom.window.AgentXAuth = {
      getToken: () => 'stub-token',
      authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { role: 'customer' } }) })
    } as never;
    await dom.window.AgentXProductShell.init(dom.window.document);
    expect(dom.window.document.querySelector('[data-portal-auth] a[href="/admin"]')).toBeNull();

    dom.window.localStorage.removeItem('agentx.auth.user');
    dom.window.AgentXProductShell.renderPortalAuth(dom.window.document);
    expect(dom.window.document.querySelector('[data-portal-auth] .portal-user-menu')).toBeNull();
    expect(dom.window.document.querySelector('[data-portal-auth] a[href="/login"]')).not.toBeNull();
  });

  it('toggles the user dropdown open state on trigger click and closes on outside click', () => {
    const dom = createDom();
    dom.window.fetch = vi.fn() as never;
    dom.window.eval(script);

    dom.window.localStorage.setItem('agentx.auth.user', JSON.stringify({ username: 'cust', role: 'customer' }));
    dom.window.AgentXProductShell.renderPortalAuth(dom.window.document);
    const menu = dom.window.document.querySelector('[data-portal-auth] .portal-user-menu') as HTMLElement;
    const trigger = menu.querySelector('.portal-user-trigger') as HTMLButtonElement;

    trigger.click();
    expect(menu.classList.contains('open')).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    trigger.click();
    expect(menu.classList.contains('open')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click();
    expect(menu.classList.contains('open')).toBe(true);
    dom.window.document.body.click();
    expect(menu.classList.contains('open')).toBe(false);
  });
});
