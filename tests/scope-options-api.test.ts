/**
 * TDD 测试：GET /api/scope-options
 * 返回当前用户可选的检索范围（按授权芯片聚合）。
 *
 * 覆盖以下场景：
 * 1. 未认证 → 401
 * 2. chips 未配置 → 返回空结构（three-tier 齐全）
 * 3. 认证用户（只有部分芯片授权）→ 只看到自己授权的芯片聚合，不泄露其他芯片（零越权）
 * 4. tooLarge 标记随文件数变化正确设置
 * 5. 响应结构符合 ScopeOptionsResponse（single/group/global 三段齐全）
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  closeMcpHttpTestServer,
  createCaptureLogger,
  createTestManager,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import type { ScopeOptionsResponse, ScopeChipOption, ScopeGroupOption } from '../src/scope/scope-options.js';

// ──────────────────────────────────────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────────────────────────────────────

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

async function loginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.token;
}

/**
 * 创建含真实 .md 文件的临时目录，用于 countChipScopeFiles 返回真实文件数。
 */
async function makeFakeWorkspace(fileCount: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scope-opts-ws-'));
  for (let i = 0; i < fileCount; i++) {
    await writeFile(join(dir, `datasheet-${i}.md`), `# Datasheet ${i}\n`);
  }
  return dir;
}

/**
 * 创建一个完整的测试服务器，支持：
 * - 预先知道 userId（先创建用户再写 userAccess 文件），实现芯片授权隔离
 * - chips catalog 可自定义
 * - 返回 baseUrl、server、userStore、alice、dataDir 等
 */
async function startServerWithChipAccess(opts: {
  chips: Record<string, { id: string; label: string; workspaceDir: string; brand?: string; productLines?: string[] }[]>;
  aliceChipIds: string[];  // alice 被允许访问的 chipId 列表
}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'scope-opts-test-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();

  const alice = await userStore.createUser('alice', 'alice-secret', 'customer', {
    resourceGrants: { chipIds: opts.aliceChipIds, mcpTools: ['agentx_whoami'] }
  });

  // 写 userAccess 文件（以 alice.id 为键）
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await writeFile(userAccessFile, JSON.stringify({ users: { [alice.id]: opts.aliceChipIds } }));

  const chips = Object.values(opts.chips).flat();

  const logs: ReturnType<typeof createCaptureLogger>[] = [];
  const capturedLogs: Parameters<typeof createCaptureLogger>[0] = [];
  const logger = createCaptureLogger(capturedLogs);

  const jwtService = new JwtService(config);
  const server = createHttpServer({
    manager: createTestManager() as any,
    auth: { enabled: true, config, userStore, jwtService },
    persistence: { enabled: false },
    logger: logger as never,
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: tmpdir(),
        chips
      }
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return { server, dataDir, baseUrl, alice, userStore, jwtService };
}

// ──────────────────────────────────────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────────────────────────────────────

describe('GET /api/scope-options', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  const tmpWorkspaceDirs: string[] = [];

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    for (const dir of tmpWorkspaceDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // ────────────────────────────────────────────────────────────
  // 用例 1：未认证 → 401
  // ────────────────────────────────────────────────────────────
  it('未认证请求返回 401', async () => {
    const started = await startMcpHttpTestServer({});
    server = started.server;
    dataDir = started.dataDir;

    const res = await fetch(`${started.baseUrl}/api/scope-options`);
    expect(res.status).toBe(401);
  });

  // ────────────────────────────────────────────────────────────
  // 用例 2：chips 未配置 → 返回空结构，三段齐全
  // ────────────────────────────────────────────────────────────
  it('chips 未配置时返回空结构（single/group/global 三段齐全）', async () => {
    const started = await startMcpHttpTestServer({}); // 不传 chips
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;

    expect(body).toHaveProperty('single');
    expect(body).toHaveProperty('group');
    expect(body).toHaveProperty('global');
    expect(body.single.chips).toEqual([]);
    expect(body.group.productLines).toEqual([]);
    expect(body.group.brands).toEqual([]);
    expect(body.group.applications).toEqual([]);
    expect(body.global.chipIds).toEqual([]);
    expect(body.global.fileCount).toBe(0);
    expect(body.global.tooLarge).toBe(false);
  });

  // ────────────────────────────────────────────────────────────
  // 用例 3：零越权——alice 只有 chip-a 授权，chip-b 不应出现
  // ────────────────────────────────────────────────────────────
  it('授权用户只看到其授权芯片聚合，不含未授权芯片（零越权）', async () => {
    const wsA = await makeFakeWorkspace(3); // chip-a: 3 个文件
    const wsB = await makeFakeWorkspace(5); // chip-b: 5 个文件（alice 无权）
    tmpWorkspaceDirs.push(wsA, wsB);

    const started = await startServerWithChipAccess({
      chips: {
        all: [
          { id: 'chip-a', label: 'Chip A', brand: 'ELMOS', productLines: ['Lighting'], workspaceDir: wsA },
          { id: 'chip-b', label: 'Chip B', brand: 'ELMOS', productLines: ['Motor'], workspaceDir: wsB }
        ]
      },
      aliceChipIds: ['chip-a'] // alice 只有 chip-a
    });
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;

    // ── single 段：只含 chip-a ──
    expect(body.single.chips).toHaveLength(1);
    const chipA = body.single.chips[0] as ScopeChipOption;
    expect(chipA.chipId).toBe('chip-a');
    expect(chipA.label).toBe('Chip A');
    expect(chipA.fileCount).toBe(3);

    // 零越权：chip-b 不在 single.chips 中
    const allSingleIds = body.single.chips.map((c) => c.chipId);
    expect(allSingleIds).not.toContain('chip-b');

    // ── group.productLines：只含 Lighting（chip-a），不含 Motor（chip-b）──
    const plValues = body.group.productLines.map((g: ScopeGroupOption) => g.value);
    expect(plValues).toContain('Lighting');
    expect(plValues).not.toContain('Motor');

    // ── group.brands：ELMOS 品牌组只包含 chip-a，不包含 chip-b ──
    const elmosBrand = body.group.brands.find((g: ScopeGroupOption) => g.value === 'ELMOS');
    expect(elmosBrand).toBeDefined();
    expect(elmosBrand!.chipIds).toContain('chip-a');
    expect(elmosBrand!.chipIds).not.toContain('chip-b');

    // ── global 段：chipIds 只含 chip-a ──
    expect(body.global.chipIds).toContain('chip-a');
    expect(body.global.chipIds).not.toContain('chip-b');
    expect(body.global.fileCount).toBe(3); // 只计 chip-a 的文件
  });

  // ────────────────────────────────────────────────────────────
  // 用例 4：tooLarge 标记——超过阈值 200 时为 true
  // ────────────────────────────────────────────────────────────
  it('tooLarge 标记在文件数超过阈值 200 时为 true，否则为 false', async () => {
    const wsSmall = await makeFakeWorkspace(50);   // 50 个文件 → LineA tooLarge false
    const wsLarge = await makeFakeWorkspace(201);  // 201 个文件 → LineB tooLarge true
    tmpWorkspaceDirs.push(wsSmall, wsLarge);

    const started = await startServerWithChipAccess({
      chips: {
        all: [
          { id: 'chip-small', label: 'Small Chip', productLines: ['LineA'], workspaceDir: wsSmall },
          { id: 'chip-large', label: 'Large Chip', productLines: ['LineB'], workspaceDir: wsLarge }
        ]
      },
      aliceChipIds: ['chip-small', 'chip-large'] // alice 有两个芯片
    });
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;

    // 两个芯片均可见
    expect(body.single.chips).toHaveLength(2);

    // global tooLarge：50 + 201 = 251 > 200 → true
    expect(body.global.tooLarge).toBe(true);
    expect(body.global.fileCount).toBe(251);

    // productLine 分组
    const lineA = body.group.productLines.find((g: ScopeGroupOption) => g.value === 'LineA');
    const lineB = body.group.productLines.find((g: ScopeGroupOption) => g.value === 'LineB');
    expect(lineA?.tooLarge).toBe(false);   // 50 ≤ 200
    expect(lineB?.tooLarge).toBe(true);    // 201 > 200
  });

  // ────────────────────────────────────────────────────────────
  // 用例 5：响应结构完整性
  // ────────────────────────────────────────────────────────────
  it('响应结构符合 ScopeOptionsResponse（single/group/global 字段齐全）', async () => {
    const ws = await makeFakeWorkspace(2);
    tmpWorkspaceDirs.push(ws);

    const started = await startServerWithChipAccess({
      chips: {
        all: [
          { id: 'chip-x', label: 'Chip X', brand: 'BrandX', productLines: ['PL1'], workspaceDir: ws }
        ]
      },
      aliceChipIds: ['chip-x']
    });
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;

    // 顶层三段
    expect(body).toHaveProperty('single');
    expect(body).toHaveProperty('group');
    expect(body).toHaveProperty('global');

    // single.chips 字段
    expect(body.single.chips).toHaveLength(1);
    const chip = body.single.chips[0] as ScopeChipOption;
    expect(chip).toHaveProperty('chipId', 'chip-x');
    expect(chip).toHaveProperty('label', 'Chip X');
    expect(chip).toHaveProperty('fileCount', 2);
    expect(chip).toHaveProperty('productLines');
    expect(Array.isArray(chip.productLines)).toBe(true);

    // group.productLines 字段
    expect(body.group.productLines).toHaveLength(1);
    const pl = body.group.productLines[0] as ScopeGroupOption;
    expect(pl).toHaveProperty('dimension', 'productLine');
    expect(pl).toHaveProperty('value', 'PL1');
    expect(pl).toHaveProperty('chipIds');
    expect(pl).toHaveProperty('fileCount', 2);
    expect(pl).toHaveProperty('tooLarge', false);

    // group.brands 字段
    expect(body.group.brands).toHaveLength(1);
    const brand = body.group.brands[0] as ScopeGroupOption;
    expect(brand).toHaveProperty('dimension', 'brand');
    expect(brand).toHaveProperty('value', 'BrandX');

    // global 字段
    expect(body.global.chipIds).toEqual(['chip-x']);
    expect(body.global.fileCount).toBe(2);
    expect(body.global.tooLarge).toBe(false);
  });

  // ────────────────────────────────────────────────────────────
  // 用例 6：group.applications 字段存在且反映 applicationTags
  // ────────────────────────────────────────────────────────────
  it('chips 未配置时返回空结构包含 group.applications: []', async () => {
    const started = await startMcpHttpTestServer({});
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;
    // 空结构也必须包含 applications 字段
    expect(body.group).toHaveProperty('applications');
    expect(Array.isArray(body.group.applications)).toBe(true);
    expect(body.group.applications).toEqual([]);
  });

  it('授权用户 GET /api/scope-options 返回 group.applications，含 applicationTags 聚合', async () => {
    const ws = await makeFakeWorkspace(2);
    tmpWorkspaceDirs.push(ws);

    const started = await startServerWithChipAccess({
      chips: {
        all: [
          {
            id: 'chip-led',
            label: 'LED Driver',
            brand: 'ELMOS',
            productLines: ['Lighting'],
            // 添加 applicationTags 字段（通过类型扩展方式传入）
            ...(({ applicationTags: ['氛围灯', 'LED驱动'] } as unknown as object)),
            workspaceDir: ws
          }
        ]
      },
      aliceChipIds: ['chip-led']
    });
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-options`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ScopeOptionsResponse;

    // group.applications 必须是数组
    expect(body.group).toHaveProperty('applications');
    expect(Array.isArray(body.group.applications)).toBe(true);
    // 芯片有 applicationTags，应当出现对应分组
    const appValues = body.group.applications.map((a: ScopeGroupOption) => a.value);
    expect(appValues).toContain('氛围灯');
    expect(appValues).toContain('LED驱动');
    // 每个分组的 dimension 应为 'application'
    for (const app of body.group.applications) {
      expect((app as ScopeGroupOption).dimension).toBe('application');
    }
  });
});
