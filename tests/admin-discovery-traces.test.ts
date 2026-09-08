/**
 * TDD：admin Discovery Trace 只读视图
 * - 后端 GET /admin/discovery-traces（admin only，返回 { traces: DiscoveryTraceEvent[] }）
 * - 前端合约：admin.html 含 #panel-discovery-traces，并以“运行诊断”放在系统设置组内
 */
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { DiscoveryTraceStore } from '../src/observability/discovery-trace.js';
import { createPersistenceRuntime, type PersistenceRuntime } from '../src/persistence/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const tempDirs: string[] = [];

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function okJson(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    headers: { get: () => null }
  };
}

async function flushBrowserTasks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-discovery-traces-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startTestServer(
  dataDir: string,
  opts: { persistence?: boolean; resourcesConfigFile?: string; resourcesEnabled?: boolean } = {}
) {
  const authDir = await tempDir();
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir: authDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer');
  const adminUser = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);

  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  manager.getSession = vi.fn().mockReturnValue(undefined);

  const runtime = opts.persistence ? createPersistenceRuntime({ dataDir }) : undefined;
  if (runtime) {
    await runtime.init();
  }

  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: false },
    prompts: { enabled: false },
    resources:
      opts.resourcesEnabled || opts.resourcesConfigFile
        ? { enabled: true, configFile: opts.resourcesConfigFile }
        : undefined,
    persistence: runtime ? { enabled: true, runtime } : { enabled: false, dataDir }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    jwtService,
    server,
    alice,
    adminUser,
    runtime
  };
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

// ——— 后端 HTTP 接口测试 ———

describe('GET /admin/discovery-traces', () => {
  it('admin 身份返回 200 + traces 数组', async () => {
    const dataDir = await tempDir();

    // 先写几条 trace 事件
    const store = new DiscoveryTraceStore({ dataDir });
    await store.record({ sessionId: 'session-1', stage: 'cc.launch', detail: { flags: ['--print'] } });
    await store.record({ sessionId: 'session-1', stage: 'error', status: 'error', detail: { exitCode: 1 } });

    const started = await startTestServer(dataDir);
    try {
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const res = await fetch(`${started.baseUrl}/admin/discovery-traces`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json() as { traces: unknown[]; systemInfo?: Record<string, string> };
      expect(Array.isArray(body.traces)).toBe(true);
      expect(body.traces.length).toBe(2);
      expect(body.traces[0]).toMatchObject({ sessionId: 'session-1', stage: 'cc.launch', status: 'ok' });
      expect(body.traces[1]).toMatchObject({ sessionId: 'session-1', stage: 'error', status: 'error' });
      expect(body.systemInfo).toMatchObject({
        nodeVersion: expect.stringMatching(/^v\d+\./),
        agentBackend: 'claude-code',
        dataDir: dataDir,
        configStatus: expect.any(String),
        claudeCodeCliVersion: expect.stringMatching(/^(unavailable|not-found|error|v?\d+)/)
      });
      expect(Object.values(body.systemInfo ?? {})).not.toContain('待接入');
    } finally {
      await closeServer(started.server);
    }
  });

  it('systemInfo.configStatusItems 对缺失的资源配置文件如实标注 fallback（不再误报已加载）', async () => {
    const dataDir = await tempDir();
    // 指向一个不存在的资源配置文件：batch C 后 runtime 会以空 catalog 降级存在，
    // 卡片必须区分「跑在内存默认上」而非报「已加载」。
    const missingResourcesFile = path.join(await tempDir(), 'resource-visibility.json');
    const started = await startTestServer(dataDir, { resourcesConfigFile: missingResourcesFile });
    try {
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );
      const res = await fetch(`${started.baseUrl}/admin/discovery-traces`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        systemInfo?: { configStatusItems?: Array<{ name: string; status: string; detail?: string }> };
      };
      const items = body.systemInfo?.configStatusItems ?? [];
      const resourcesItem = items.find((item) => item.name === 'resources');
      expect(resourcesItem?.status).toBe('fallback');
      expect(resourcesItem?.detail).toContain('resource-visibility.json');
    } finally {
      await closeServer(started.server);
    }
  });

  it('systemInfo.configStatusItems 对存在的资源配置文件标注 ok 且带真实路径', async () => {
    const dataDir = await tempDir();
    const resourcesDir = await tempDir();
    const resourcesFile = path.join(resourcesDir, 'resource-visibility.json');
    await writeFile(resourcesFile, JSON.stringify({ documents: [], scopePresets: [] }), 'utf8');
    const started = await startTestServer(dataDir, { resourcesConfigFile: resourcesFile });
    try {
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );
      const res = await fetch(`${started.baseUrl}/admin/discovery-traces`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        systemInfo?: { configStatusItems?: Array<{ name: string; status: string; detail?: string }> };
      };
      const items = body.systemInfo?.configStatusItems ?? [];
      const resourcesItem = items.find((item) => item.name === 'resources');
      expect(resourcesItem?.status).toBe('ok');
      expect(resourcesItem?.detail).toContain('resource-visibility.json');
    } finally {
      await closeServer(started.server);
    }
  });

  it('非 admin（customer）返回 403', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      const userToken = started.jwtService.sign(
        started.alice.id,
        started.alice.username,
        started.alice.role
      );

      const res = await fetch(`${started.baseUrl}/admin/discovery-traces`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(res.status).toBe(403);
    } finally {
      await closeServer(started.server);
    }
  });

  it('支持 ?limit= 过滤返回条数', async () => {
    const dataDir = await tempDir();

    const store = new DiscoveryTraceStore({ dataDir });
    await store.record({ sessionId: 'session-a', stage: 'cc.launch', detail: {} });
    await store.record({ sessionId: 'session-b', stage: 'cc.launch', detail: {} });
    await store.record({ sessionId: 'session-c', stage: 'cc.launch', detail: {} });

    const started = await startTestServer(dataDir);
    try {
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const res = await fetch(`${started.baseUrl}/admin/discovery-traces?limit=2`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { traces: unknown[] };
      expect(body.traces.length).toBe(2);
    } finally {
      await closeServer(started.server);
    }
  });

  it('支持 ?sessionId= 过滤 sessionId', async () => {
    const dataDir = await tempDir();

    const store = new DiscoveryTraceStore({ dataDir });
    await store.record({ sessionId: 'session-x', stage: 'cc.launch', detail: {} });
    await store.record({ sessionId: 'session-y', stage: 'cc.launch', detail: {} });

    const started = await startTestServer(dataDir);
    try {
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const res = await fetch(`${started.baseUrl}/admin/discovery-traces?sessionId=session-x`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { traces: Array<{ sessionId: string }> };
      expect(body.traces.every((t) => t.sessionId === 'session-x')).toBe(true);
      expect(body.traces.length).toBe(1);
    } finally {
      await closeServer(started.server);
    }
  });

  it('响应派生 type 字段：单芯片、跨档两步、全局', async () => {
    const dataDir = await tempDir();
    const store = new DiscoveryTraceStore({ dataDir });
    const started = await startTestServer(dataDir, { persistence: true });
    try {
      await seedSession(started.runtime!, { sessionId: 'single-session', chipId: 'E521.31' });
      await seedSession(started.runtime!, { sessionId: 'two-stage-session', scopePresetId: 'scope-all' });
      await seedSession(started.runtime!, { sessionId: 'global-session' });
      await store.record({ sessionId: 'single-session', stage: 'cc.launch', detail: {} });
      await store.record({ sessionId: 'two-stage-session', stage: 'cc.stage1', detail: { candidatesCount: 1 } });
      await store.record({ sessionId: 'global-session', stage: 'cc.launch', detail: {} });

      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );
      const res = await fetch(`${started.baseUrl}/admin/discovery-traces`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { traces: Array<{ sessionId: string; type: string }> };
      expect(body.traces.find((trace) => trace.sessionId === 'single-session')?.type).toBe('单芯片');
      expect(body.traces.find((trace) => trace.sessionId === 'two-stage-session')?.type).toBe('跨档两步');
      expect(body.traces.find((trace) => trace.sessionId === 'global-session')?.type).toBe('全局');
    } finally {
      await closeServer(started.server);
    }
  });
});

describe('GET /admin/sessions/:id/debug', () => {
  it('admin 身份读取会话 debug bundle', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir, { persistence: true });
    try {
      await seedSession(started.runtime!, { sessionId: 'debug-session', chipId: 'E521.31' });
      await started.runtime!.sessionDebugBundles.write('debug-session', {
        type: '单芯片',
        systemPrompt: 'system prompt: retained',
        stages: [{ stage: 'workspace.snapshot', artifact: { files: [{ path: 'merge.md', size: 5 }] } }]
      });
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const res = await fetch(`${started.baseUrl}/admin/sessions/debug-session/debug`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = await res.json() as { sessionId: string; type: string; systemPrompt?: { text: string; redacted?: string[]; sha256?: string } };
      expect(body.sessionId).toBe('debug-session');
      expect(body.type).toBe('单芯片');
      expect(body.systemPrompt?.text).toBe('system prompt: retained');
      expect(body.systemPrompt?.sha256).toBeUndefined();
    } finally {
      await closeServer(started.server);
    }
  });

  it('会话不存在或 bundle 不存在时返回 404', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir, { persistence: true });
    try {
      await seedSession(started.runtime!, { sessionId: 'no-bundle-session' });
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const missingSession = await fetch(`${started.baseUrl}/admin/sessions/missing/debug`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const missingBundle = await fetch(`${started.baseUrl}/admin/sessions/no-bundle-session/debug`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      expect(missingSession.status).toBe(404);
      expect(missingBundle.status).toBe(404);
      expect(await missingSession.json()).toEqual({ error: 'Session debug bundle not found' });
      expect(await missingBundle.json()).toEqual({ error: 'Session debug bundle not found' });
    } finally {
      await closeServer(started.server);
    }
  });

  it('debug.json 损坏时返回受控错误而不是 500', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir, { persistence: true });
    try {
      await seedSession(started.runtime!, { sessionId: 'corrupt-debug-session' });
      await writeFile(path.join(dataDir, 'sessions', 'corrupt-debug-session', 'debug.json'), '{not-json', 'utf8');
      const adminToken = started.jwtService.sign(
        started.adminUser!.id,
        started.adminUser!.username,
        started.adminUser!.role
      );

      const res = await fetch(`${started.baseUrl}/admin/sessions/corrupt-debug-session/debug`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });

      expect(res.status).toBe(422);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(await res.json()).toEqual({ error: 'Session debug bundle is unreadable' });
    } finally {
      await closeServer(started.server);
    }
  });
});

// ——— 前端合约测试（jsdom 文本扫描）———

describe('admin.html Discovery Trace 前端合约', () => {
  it('含有 #panel-discovery-traces 面板', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const panel = dom.window.document.getElementById('panel-discovery-traces');
    expect(panel).not.toBeNull();
  });

  it('含有系统设置组下的运行诊断导航项（data-section）', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const navItem = dom.window.document.querySelector('[data-section="discovery-traces"]');
    expect(navItem).not.toBeNull();
    expect(navItem?.textContent).toContain('运行诊断');
    expect(navItem?.closest('[data-nav-group]')?.getAttribute('data-nav-group')).toBe('system-settings');
    expect(dom.window.document.getElementById('panel-discovery-traces')?.textContent).toContain('运行诊断');
  });

  it('#panel-discovery-traces 含有错误提示元素 #discovery-traces-error', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const errorEl = dom.window.document.getElementById('discovery-traces-error');
    expect(errorEl).not.toBeNull();
  });

  it('#panel-discovery-traces 含有列表容器 #discovery-traces-list', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const listEl = dom.window.document.getElementById('discovery-traces-list');
    expect(listEl).not.toBeNull();
  });

  it('#panel-discovery-traces 含有系统信息卡槽', () => {
    const html = readPublicFile('admin.html');
    const dom = new JSDOM(html);
    const panel = dom.window.document.getElementById('panel-discovery-traces');
    expect(dom.window.document.getElementById('diagnostics-system-info')).not.toBeNull();
    expect(dom.window.document.getElementById('diagnostics-version-value')).not.toBeNull();
    expect(dom.window.document.getElementById('diagnostics-node-version-value')).not.toBeNull();
    expect(dom.window.document.getElementById('diagnostics-agent-backend-value')).not.toBeNull();
    expect(dom.window.document.getElementById('diagnostics-claude-version-value')).not.toBeNull();
    expect(panel?.textContent).toContain('系统信息');
    expect(panel?.textContent).toContain('Agent 后端');
    expect(panel?.textContent).toContain('Claude Code CLI');
  });

  it('#panel-discovery-traces 含有失败快捷筛选和会话 Debug 跳转契约', () => {
    const html = readPublicFile('admin.html');
    const js = readPublicFile('admin.js');
    const dom = new JSDOM(html);
    expect(dom.window.document.getElementById('discovery-traces-filter-all')).not.toBeNull();
    expect(dom.window.document.getElementById('discovery-traces-filter-error')).not.toBeNull();
    expect(js).toContain("state.discoveryTraces.quickFilter");
    expect(js).toContain("trace.type || pipelineTypeLabel(trace.pipeline)");
    expect(js).toContain('/admin/sections/sessions?debugSessionId=');
    expect(js).toContain('打开会话 Debug');
  });

  it('运行诊断 detail 使用结构化 key-value DOM 渲染而非裸 JSON 字符串', async () => {
    const dom = new JSDOM(readPublicFile('admin.html'), {
      url: 'http://127.0.0.1:3000/admin/sections/discovery-traces',
      runScripts: 'outside-only'
    });
    const window = dom.window as unknown as Window & Record<string, any>;
    window.AgentXAuth = {
      getUser: () => ({ username: 'root', role: 'admin' }),
      logout: () => undefined,
      login: async () => ({ user: { username: 'root', role: 'admin' } }),
      clearToken: () => undefined,
      authFetch: async (requestPath: string) => {
        if (requestPath === '/admin/discovery-traces') {
          return okJson({
            traces: [
              {
                sessionId: 'session-1',
                ts: '2026-07-04T00:00:00.000Z',
                stage: 'cc.launch',
                status: 'ok',
                type: '跨档两步',
                detail: { flags: ['--print'], exitCode: 0 }
              }
            ],
            systemInfo: {
              nodeVersion: 'v20.0.0',
              agentBackend: 'claude-code',
              dataDir: 'C:/agentx-data',
              configStatus: 'auth:enabled',
              configStatusItems: [
                { name: 'auth', status: 'ok' },
                { name: 'chips', status: 'ok', detail: 'C:/agentx/config/chips.json' },
                {
                  name: 'resources',
                  status: 'fallback',
                  detail: 'C:/agentx/config/resource-visibility.json（文件缺失，使用内存默认）'
                }
              ],
              claudeCodeCliVersion: '1.0.0',
              platform: 'win32/x64'
            }
          });
        }
        if (requestPath === '/admin/chips') return okJson({ chips: [], knowledgeBaseRoot: '' });
        if (requestPath === '/admin/users') return okJson({ users: [] });
        if (requestPath === '/admin/prompts') return okJson({ files: [] });
        if (requestPath === '/admin/roles') return okJson({ roles: { admin: { description: 'Admin', permissions: [] } }, _permissions: {} });
        if (requestPath === '/admin/resources') return okJson({ documents: [], scopePresets: [] });
        if (requestPath.startsWith('/admin/observability')) return okJson({ summary: {}, breakdown: {}, anomalies: [] });
        if (requestPath.startsWith('/admin/sessions/history')) return okJson({ items: [], total: 0, offset: 0, limit: 50 });
        if (requestPath.startsWith('/admin/questions')) return okJson({ items: [], total: 0, offset: 0, limit: 50 });
        throw new Error(`Unexpected admin fetch: ${requestPath}`);
      }
    };

    window.eval(readPublicFile('admin.js'));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    await flushBrowserTasks();

    // 批次B（2.2.27）：detail 已收进「默认折叠、点箭头展开」的明细行，且整表复用共享密集表 .admin-dense-table。
    expect(window.document.querySelector('#discovery-traces-list .admin-dense-table')).toBeTruthy();
    expect(window.document.querySelector('#discovery-traces-list .discovery-trace-expand')).toBeTruthy();
    const detailRow = window.document.querySelector('#discovery-traces-list .discovery-trace-detail-row') as HTMLElement;
    expect(detailRow).toBeTruthy();
    expect(detailRow.hidden).toBe(true);
    const detailCell = window.document.querySelector('#discovery-traces-list .discovery-trace-detail-cell') as HTMLElement;
    expect(detailCell).toBeTruthy();
    expect(detailCell.querySelector('.debug-trace-kv')).toBeTruthy();
    const keys = Array.from(detailCell.querySelectorAll('dt')).map((node) => node.textContent);
    const values = Array.from(detailCell.querySelectorAll('dd')).map((node) => node.textContent);
    expect(keys).toContain('flags');
    expect(keys).toContain('exitCode');
    expect(values).toContain('--print');
    expect(values).toContain('0');
    expect(detailCell.textContent).not.toContain('"flags"');
    expect(detailCell.textContent).not.toContain('{');

    // 批次G（2.2.27）：配置文件加载状态卡三态渲染——ok=已加载（绿）/ fallback=使用默认（黄）/ 缺失（红），
    // 并把配置文件路径作为详情行显示；resources 缺文件时必须是「使用默认」而非误报「已加载」。
    const statusRows = Array.from(
      window.document.querySelectorAll('#diagnostics-config-status-list .diagnostics-config-status-row')
    ) as HTMLElement[];
    expect(statusRows.length).toBe(3);
    const resourcesRow = statusRows.find((row) => row.querySelector('.diagnostics-config-status-name')?.textContent === 'resources');
    expect(resourcesRow).toBeTruthy();
    expect(resourcesRow!.querySelector('.admin-badge-warn')?.textContent).toBe('使用默认');
    expect(resourcesRow!.querySelector('.diagnostics-config-status-detail')?.textContent).toContain('resource-visibility.json');
    const authRow = statusRows.find((row) => row.querySelector('.diagnostics-config-status-name')?.textContent === 'auth');
    expect(authRow!.querySelector('.admin-badge-success')?.textContent).toBe('已加载');
    expect(authRow!.querySelector('.diagnostics-config-status-detail')).toBeNull();
  });
});

async function seedSession(
  runtime: PersistenceRuntime,
  input: { sessionId: string; chipId?: string; scopePresetId?: string }
): Promise<void> {
  await runtime.recordSessionCreated({
    sessionId: input.sessionId,
    userId: 'user-1',
    username: 'alice',
    role: 'customer',
    agentType: 'claude-code',
    cwd: '',
    task: 'test question',
    source: 'web',
    ...(input.chipId ? { chipId: input.chipId } : {}),
    ...(input.scopePresetId ? { scopePresetId: input.scopePresetId } : {})
  });
}
