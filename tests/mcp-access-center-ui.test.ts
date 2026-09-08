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

function publicPayload(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      enabled: true,
      mode: 'bearer-mcp-key',
      authenticated: false,
      requiredForUserData: true
    },
    server: {
      remoteHttpUrl: 'http://127.0.0.1:3000/mcp',
      verifyUrl: 'http://127.0.0.1:3000/mcp/verify',
      authMode: 'bearer-mcp-key'
    },
    templates: [
      {
        id: 'opencode',
        label: 'opencode Remote MCP config',
        clientType: 'opencode',
        downloadUrl: 'http://127.0.0.1:3000/mcp-templates/opencode.json',
        contentType: 'application/json'
      },
      {
        id: 'codex',
        label: 'Codex Remote MCP handoff',
        clientType: 'codex',
        downloadUrl: 'http://127.0.0.1:3000/mcp-templates/codex.md',
        contentType: 'text/markdown'
      },
      {
        id: 'claude-code',
        label: 'Claude Code Remote MCP handoff',
        clientType: 'claude-code',
        downloadUrl: 'http://127.0.0.1:3000/mcp-templates/claude-code.md',
        contentType: 'text/markdown'
      }
    ],
    downloads: [],
    securityNotes: [
      'Full MCP keys are only shown once by the Account key create or regenerate APIs.',
      'Remote MCP clients should call agentx_whoami first.'
    ],
    permissions: {
      allowedModels: [],
      resources: [],
      mcpKeyPolicy: null
    },
    user: null,
    keySummaries: [],
    availableKeys: [],
    ...overrides
  };
}

function authenticatedPayload(overrides: Record<string, unknown> = {}) {
  return publicPayload({
    auth: {
      enabled: true,
      mode: 'bearer-mcp-key',
      authenticated: true,
      requiredForUserData: true
    },
    user: { id: 'user-1', username: 'alice', role: 'customer', status: 'active' },
    permissions: {
      role: 'customer',
      allowedModels: [{ id: 'sonnet', label: 'Enhanced' }],
      resources: [{ type: 'chip', id: 'E521.39', label: 'E521.39 LIN RGB' }],
      mcpKeyPolicy: {
        allowMcpKeySelfCreate: true,
        maxMcpKeys: 2,
        defaultMcpKeyTtlDays: 7,
        allowMcpKeyRegenerate: true
      }
    },
    keySummaries: [
      {
        keyId: 'key-1',
        name: 'laptop',
        maskedKey: 'mcp_1234...abcd',
        fingerprint: 'fp-safe-123',
        usable: true,
        status: 'usable',
        allowedModels: [{ id: 'sonnet', label: 'Enhanced' }]
      }
    ],
    availableKeys: [
      {
        keyId: 'key-1',
        name: 'laptop',
        maskedKey: 'mcp_1234...abcd',
        fingerprint: 'fp-safe-123',
        usable: true,
        status: 'usable',
        allowedModels: [{ id: 'sonnet', label: 'Enhanced' }]
      }
    ],
    ...overrides
  });
}

async function setupMcpAccessDom(options: {
  payload?: unknown;
  token?: string | null;
  user?: { username: string; role: string } | null;
  fail?: boolean;
}) {
  const dom = new JSDOM(readPublicFile('mcp-access.html'), {
    url: 'http://127.0.0.1:3000/mcp-access',
    runScripts: 'outside-only'
  });
  const window = dom.window as unknown as Window & Record<string, any>;
  Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'zh-CN' });
  Object.defineProperty(window.navigator, 'languages', { configurable: true, value: ['zh-CN'] });
  const calls: string[] = [];
  const handler = vi.fn(async (path: string) => {
    calls.push(path);
    if (options.fail) return okJson({ error: 'boom' }, 500);
    return okJson(options.payload || publicPayload());
  });
  window.fetch = vi.fn(async (path: string) => handler(path)) as any;
  window.AgentXAuth = {
    getToken: () => options.token || null,
    getUser: () => options.user || null,
    logout: vi.fn(),
    authFetch: handler
  };
  window.navigator.clipboard = { writeText: vi.fn() } as any;
  window.eval(readPublicFile('i18n.js'));
  window.eval(readPublicFile('assets/i18n-portal.js'));
  window.eval(readPublicFile('assets/i18n-mcp-tickets.js'));
  window.eval(readPublicFile('mcp-access.js'));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await flushBrowserTasks();
  await flushBrowserTasks();
  return { window, calls, handler };
}

describe('MCP access center UI', () => {
  it('defines the access center structure and consumes the access-center contract', () => {
    const html = readPublicFile('mcp-access.html');
    const js = readPublicFile('mcp-access.js');

    for (const token of [
      'class="landing-page portal-workspace-page mcp-access-page reference-page"',
      'class="page landing-shell portal-workspace-shell shell-mk"',
      'class="portal-workspace-main reference-main"',
      'id="mcp-access-key-list"',
      'id="mcp-access-model-list"',
      'id="mcp-access-resource-list"',
      'id="mcp-access-template-code"',
      'id="mcp-access-copy-summary"',
      '/mcp-access.js?v=2.2.45'
    ]) {
      expect(html).toContain(token);
    }
    expect(html).not.toContain('/assets/agentx-newwebui.css');
    expect(html).not.toContain('agentx-newwebui-page');
    expect(js).toContain('/api/mcp/access-center');
    expect(js).toContain('keySummaries');
    expect(js).toContain('allowedModels');
    expect(js).toContain('resources');
    expect(js).toContain('mcpKeyPolicy');
    expect(js).toContain('/api/account/onboarding');
    expect(js).not.toMatch(/localStorage\.setItem|passwordHash/);
  });

  it('renders unauthenticated public metadata without user key or permission data', async () => {
    const fullSecret = 'mcp_REAL_SECRET_SHOULD_NOT_RENDER_123456';
    const { window, calls } = await setupMcpAccessDom({
      payload: publicPayload()
    });

    expect(calls).toContain('/api/mcp/access-center');
    expect(window.document.getElementById('mcp-access-user-status')?.textContent).toBe('公共接入说明');
    expect(window.document.getElementById('mcp-access-key-list')?.textContent).toContain('未登录，无法显示 Key 与权限信息。');
    expect(window.document.body.textContent).toContain('http://127.0.0.1:3000/mcp');
    expect(window.document.body.textContent).toContain('登录后可见');
    expect(window.document.body.textContent).not.toContain(fullSecret);
    expect(window.document.body.textContent).not.toContain('alice');
  });

  it('renders authenticated key summaries, models, resources, and template metadata without full secrets', async () => {
    const fullSecret = 'mcp_REAL_SECRET_SHOULD_NOT_RENDER_123456';
    const { window } = await setupMcpAccessDom({
      token: 'login-token',
      user: { username: 'alice', role: 'customer' },
      payload: authenticatedPayload()
    });

    expect(window.document.getElementById('mcp-access-user-status')?.textContent).toContain('alice');
    expect(window.document.getElementById('mcp-access-key-list')?.textContent).toContain('mcp_1234...abcd');
    expect(window.document.getElementById('mcp-access-key-list')?.textContent).toContain('fp-safe-123');
    expect(window.document.getElementById('mcp-access-model-list')?.textContent).toContain('增强');
    expect(window.document.getElementById('mcp-access-resource-list')?.textContent).toContain('E521.39 LIN RGB');
    expect(window.document.getElementById('mcp-access-policy-list')?.textContent).toContain('允许自助创建');
    expect(window.document.getElementById('mcp-access-template-meta')?.textContent).toContain('opencode Remote MCP config');
    expect(window.document.body.textContent).not.toContain(fullSecret);
    expect(window.document.body.textContent).not.toMatch(/Authorization: Bearer mcp_/);
  });

  it('copies only placeholder templates and safe summaries', async () => {
    const { window } = await setupMcpAccessDom({
      token: 'login-token',
      user: { username: 'alice', role: 'customer' },
      payload: authenticatedPayload()
    });

    (window.document.getElementById('mcp-access-copy-template') as HTMLButtonElement).click();
    await flushBrowserTasks();
    expect(window.navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('AGENTX_MCP_KEY'));
    expect(window.navigator.clipboard.writeText).not.toHaveBeenLastCalledWith(expect.stringContaining('mcp_REAL'));

    (window.document.getElementById('mcp-access-copy-summary') as HTMLButtonElement).click();
    await flushBrowserTasks();
    const copied = (window.navigator.clipboard.writeText as any).mock.calls.at(-1)?.[0] as string;
    expect(copied).toContain('keyId=key-1');
    expect(copied).toContain('fingerprint=fp-safe-123');
    expect(copied).toContain('secret=<never copy full key from access center>');
    expect(copied).not.toContain('Authorization: Bearer');
  });

  it('marks MCP access onboarding step for authenticated users without copying secrets', async () => {
    const { window, calls } = await setupMcpAccessDom({
      token: 'login-token',
      user: { username: 'alice', role: 'customer' },
      payload: authenticatedPayload({
        user: {
          id: 'user-1',
          username: 'alice',
          role: 'customer',
          localePreference: 'en-US',
          onboarding: { status: 'in_progress', completedSteps: ['profile'], dismissedHints: [] }
        }
      })
    });

    expect(window.document.documentElement.lang).toBe('en-US');
    expect(window.document.getElementById('mcp-access-public-note')?.textContent).toContain('masked/fingerprint');
    (window.document.getElementById('mcp-access-complete-step') as HTMLButtonElement).click();
    await flushBrowserTasks();

    const onboardingCall = calls.find((call) => call === '/api/account/onboarding');
    expect(onboardingCall).toBe('/api/account/onboarding');
    expect(window.document.body.textContent).not.toMatch(/mcp_REAL_SECRET|Bearer mcp_/i);
  });

  it('keeps an error state visible without falling back to stale private data', async () => {
    const { window } = await setupMcpAccessDom({
      token: 'login-token',
      user: { username: 'alice', role: 'customer' },
      fail: true
    });

    expect(window.document.getElementById('mcp-access-status')?.textContent).toContain('boom');
    expect(window.document.getElementById('mcp-access-key-list')?.textContent).toContain('未登录，无法显示 Key 与权限信息。');
    expect(window.document.body.textContent).not.toContain('mcp_REAL_SECRET');
  });
});
