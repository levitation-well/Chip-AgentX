/**
 * TDD：admin 成本观测（observability）HTTP 路由级集成测试。
 *
 * 补功能审查报告 P2-6 缺口——此前 `/admin/observability` 只有前端 jsdom mock（phase10），
 * 没有真实起服务、打端点的路由级断言。这里覆盖：
 *   - admin + 合法 range（7d）→ 200 + 指标结构；
 *   - admin + 缺省 range → 200（resolveObservabilityRange 缺省回退 7d）；
 *   - admin + 非法 range → 400「Invalid observability range」；
 *   - 非 admin（customer）→ 403；
 *   - 无凭证 → 4xx（拒绝，不泄露数据）。
 */
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createPersistenceRuntime } from '../src/persistence/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-observability-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startTestServer(dataDir: string) {
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

  const runtime = createPersistenceRuntime({ dataDir });
  await runtime.init();

  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: false },
    prompts: { enabled: false },
    persistence: { enabled: true, runtime }
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

function adminToken(started: Awaited<ReturnType<typeof startTestServer>>): string {
  return started.jwtService.sign(started.adminUser!.id, started.adminUser!.username, started.adminUser!.role);
}

describe('GET /admin/observability', () => {
  it('admin + 合法 range 返回 200 + 指标结构', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      // 播种一条会话，让指标走非空计算路径（而非仅空态）。
      await started.runtime.recordSessionCreated({
        sessionId: 'sess-obs-1',
        userId: 'user-1',
        username: 'zhang.san',
        role: 'customer',
        agentType: 'claude-code',
        cwd: '',
        task: '哪些芯片支持 16-bit PWM',
        source: 'web'
      });
      const res = await fetch(`${started.baseUrl}/admin/observability?range=7d`, {
        headers: { Authorization: `Bearer ${adminToken(started)}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const body = (await res.json()) as {
        summary?: { failureRate?: unknown; calls?: unknown };
        breakdown?: Record<string, unknown>;
        anomalies?: unknown;
      };
      expect(typeof body.summary?.failureRate).toBe('number');
      expect(typeof body.summary?.calls).toBe('number');
      expect(body.breakdown).toMatchObject({
        byEntry: expect.any(Object),
        byModel: expect.any(Object),
        byUser: expect.any(Object),
        byMcpKey: expect.any(Object),
        byFailureReason: expect.any(Object)
      });
      expect(Array.isArray(body.anomalies)).toBe(true);
    } finally {
      await closeServer(started.server);
    }
  });

  it('admin + 缺省 range 返回 200（回退 7d）', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      const res = await fetch(`${started.baseUrl}/admin/observability`, {
        headers: { Authorization: `Bearer ${adminToken(started)}` }
      });
      expect(res.status).toBe(200);
    } finally {
      await closeServer(started.server);
    }
  });

  it('admin + 非法 range 返回 400', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      const res = await fetch(`${started.baseUrl}/admin/observability?range=not-a-range`, {
        headers: { Authorization: `Bearer ${adminToken(started)}` }
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe('Invalid observability range');
    } finally {
      await closeServer(started.server);
    }
  });

  it('非 admin（customer）返回 403', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);
      const res = await fetch(`${started.baseUrl}/admin/observability?range=7d`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(res.status).toBe(403);
    } finally {
      await closeServer(started.server);
    }
  });

  it('无凭证返回 4xx（拒绝）', async () => {
    const dataDir = await tempDir();
    const started = await startTestServer(dataDir);
    try {
      const res = await fetch(`${started.baseUrl}/admin/observability?range=7d`, { redirect: 'manual' });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(res.status).not.toBe(403);
    } finally {
      await closeServer(started.server);
    }
  });
});
