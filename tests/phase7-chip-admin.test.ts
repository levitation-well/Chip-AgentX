import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';
import {
  parseResourceVisibilityCatalog,
  writeResourceVisibilityCatalogToFile,
  type ResourceVisibilityCatalog
} from '../src/security/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager(kbRoot: string) {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.spawn = vi.fn().mockImplementation(async (params: Record<string, unknown>) => ({
    id: 'session-test-123',
    sessionId: 'session-test-123',
    agentType: params.agentType,
    status: 'running',
    startedAt: 123,
    cwd: params.cwd,
    task: params.task,
    sessionMode: params.sessionMode,
    turnState: 'idle',
    turnCount: 1,
    chipId: params.chipId,
    userId: 'user-1'
  }));
  manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.tail = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  manager.list = vi.fn().mockReturnValue([]);
  return manager;
}

async function startAdminChipServer(
  options: { rolesJson?: Record<string, unknown>; resourceCatalog?: ResourceVisibilityCatalog } = {}
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'phase7-chip-data-'));
  const kbRoot = await mkdtemp(join(tmpdir(), 'phase7-chip-kb-'));
  const configDir = await mkdtemp(join(tmpdir(), 'phase7-chip-config-'));
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await mkdir(join(kbRoot, 'RISC-V'), { recursive: true });
  await mkdir(join(kbRoot, 'ADMIN-ONLY'), { recursive: true });

  const chipConfigFile = join(configDir, 'chips.json');
  const userAccessFile = join(configDir, 'user-chip-access.json');
  const rolesFile = join(configDir, 'roles.json');
  const promptsConfigFile = join(configDir, 'prompts.json');
  const promptsBaseDir = join(configDir, 'prompts');
  const resourcesConfigFile = join(configDir, 'resource-visibility.json');
  await writeFile(
    chipConfigFile,
    JSON.stringify(
      {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'E521.39 public resource summary',
            queryHint: 'Use for E521.39 questions',
            workspaceDir: 'E521.39'
          },
          { id: 'RISC-V', label: 'RISC-V Core', workspaceDir: 'RISC-V' },
          { id: 'ADMIN-ONLY', label: 'Admin Only', workspaceDir: 'ADMIN-ONLY' }
        ]
      },
      null,
      2
    ),
    'utf-8'
  );
  await writeFile(
    rolesFile,
    JSON.stringify(
      options.rolesJson ?? {
        admin: { description: 'Admin', access: { allowedChips: ['*'], injectionPolicy: 'every_turn' } },
        customer: { description: 'Customer', access: { allowedChips: [], injectionPolicy: 'first_turn' } }
      },
      null,
      2
    ),
    'utf-8'
  );
  if (options.resourceCatalog) {
    await writeResourceVisibilityCatalogToFile(resourcesConfigFile, options.resourceCatalog);
  }
  await mkdir(join(promptsBaseDir, 'roles'), { recursive: true });
  await mkdir(join(promptsBaseDir, 'chips'), { recursive: true });
  await writeFile(join(promptsBaseDir, 'global.md'), 'Global prompt\n', 'utf-8');
  await writeFile(
    promptsConfigFile,
    JSON.stringify(
      {
        baseDir: promptsBaseDir,
        files: { global: 'global.md', roles: 'roles', chips: 'chips' },
        defaultRole: 'customer'
      },
      null,
      2
    ),
    'utf-8'
  );

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer');
  const bob = await userStore.createUser('bob', 'bob-secret', 'customer');
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const manager = createFakeManager(kbRoot);
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService, rolesFile },
    chips: { enabled: true, configFile: chipConfigFile, userAccessFile },
    prompts: { enabled: true, configFile: promptsConfigFile, rolesFile },
    ...(options.resourceCatalog ? { resources: { enabled: true, configFile: resourcesConfigFile } } : {})
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    dataDir,
    kbRoot,
    configDir,
    chipConfigFile,
    rolesFile,
    resourcesConfigFile,
    userAccessFile,
    jwtService,
    userStore,
    manager,
    alice,
    bob,
    adminToken: jwtService.sign(admin!.id, admin!.username, admin!.role),
    aliceToken: jwtService.sign(alice.id, alice.username, alice.role),
    bobToken: jwtService.sign(bob.id, bob.username, bob.role)
  };
}

async function closeStarted(started: Awaited<ReturnType<typeof startAdminChipServer>> | undefined) {
  if (!started) return;
  if (started.server.listening) {
    await new Promise<void>((resolve, reject) => {
      started.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await rm(started.dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(started.kbRoot, { recursive: true, force: true }).catch(() => {});
  await rm(started.configDir, { recursive: true, force: true }).catch(() => {});
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('phase 7 chip catalog admin API', () => {
  let started: Awaited<ReturnType<typeof startAdminChipServer>> | undefined;

  afterEach(async () => {
    await closeStarted(started);
    started = undefined;
  });

  // V13：结构性变更（新增/删除 chip、或既有 chip 的 workspaceDir 变化）仍走重启闸——
  // 写盘成功但内存 catalog 不热替换，GET /chips 仍返回旧目录，直到服务重启。
  it('structural change (add/remove chip) is written to disk but keeps runtime catalog restart-gated', async () => {
    started = await startAdminChipServer();
    const absoluteWorkspace = join(started.kbRoot, 'E521.39');

    const adminCatalog = await fetch(`${started.baseUrl}/admin/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    const adminCatalogBody = await json(adminCatalog);
    expect(adminCatalogBody.chips[0].workspaceDir).toBe(absoluteWorkspace);
    expect(adminCatalogBody.chips[0].queryHint).toBe('Use for E521.39 questions');

    const response = await fetch(`${started.baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${started.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        knowledgeBaseRoot: started.kbRoot,
        chips: [
          {
            id: 'NEW-CHIP',
            label: 'New Chip',
            description: 'New public resource summary',
            queryHint: 'Use for new chip questions',
            workspaceDir: absoluteWorkspace
          }
        ]
      })
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.restartRequired).toBe(true);
    expect(body.chips).toHaveLength(1);
    const saved = JSON.parse(await readFile(started.chipConfigFile, 'utf-8'));
    expect(saved.chips[0].id).toBe('NEW-CHIP');
    expect(saved.chips[0].description).toBe('New public resource summary');
    expect(saved.chips[0].queryHint).toBe('Use for new chip questions');
    expect(saved.chips[0].workspaceDir).toBe(absoluteWorkspace);

    // 内存 catalog 未热替换：/chips 仍反映重启前的旧目录（3 个旧 chip，不含 NEW-CHIP）。
    const activeResponse = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    const activeBody = await json(activeResponse);
    expect(activeBody.chips.map((chip: { id: string }) => chip.id)).toEqual(['E521.39', 'RISC-V', 'ADMIN-ONLY']);
  });

  // V13：纯元数据编辑（brand/productLines/applicationTags/documentIds/summary 等，chip id 集合、
  // workspaceDir、knowledgeBaseRoot 均不变）立即热更新内存 catalog——GET /chips 无需重启即时反映新值，
  // 且响应 restartRequired:false。
  it('metadata-only edit hot-updates the runtime catalog immediately (restartRequired:false)', async () => {
    started = await startAdminChipServer();

    const getRes = await fetch(`${started.baseUrl}/admin/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    const catalog = (await json(getRes)) as { knowledgeBaseRoot: string; chips: any[] };
    catalog.chips = catalog.chips.map((c) =>
      c.id === 'E521.39'
        ? { ...c, summary: 'Hot-updated summary', productLines: ['氛围灯'], brand: 'ELMOS' }
        : c
    );

    const putRes = await fetch(`${started.baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${started.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    const body = await json(putRes);
    expect(body.restartRequired).toBe(false);

    // 写盘生效。
    const saved = JSON.parse(await readFile(started.chipConfigFile, 'utf-8'));
    const savedChip = saved.chips.find((c: any) => c.id === 'E521.39');
    expect(savedChip.summary).toBe('Hot-updated summary');
    expect(savedChip.productLines).toEqual(['氛围灯']);
    expect(savedChip.brand).toBe('ELMOS');

    // 内存 catalog 立即热更新：无需重启，/chips（公开端点，不回传 summary，但回传 productLines）即时反映新值。
    const activeResponse = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    const activeBody = await json(activeResponse);
    const activeChip = activeBody.chips.find((c: any) => c.id === 'E521.39');
    expect(activeChip.productLines).toEqual(['氛围灯']);

    // admin GET /admin/chips（回传全部字段含 summary）也即时反映新值，双路径一致。
    const activeAdminResponse = await fetch(`${started.baseUrl}/admin/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    const activeAdminBody = await json(activeAdminResponse);
    const activeAdminChip = activeAdminBody.chips.find((c: any) => c.id === 'E521.39');
    expect(activeAdminChip.summary).toBe('Hot-updated summary');
  });

  it('rejects non-absolute or missing workspaceDir values before saving', async () => {
    started = await startAdminChipServer();
    const filePath = join(started.configDir, 'not-a-directory.txt');
    await writeFile(filePath, 'not a directory', 'utf-8');

    for (const workspaceDir of ['../escape', 'E521.39', join(started.kbRoot, 'MISSING'), filePath]) {
      const response = await fetch(`${started.baseUrl}/admin/chips`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${started.adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          knowledgeBaseRoot: started.kbRoot,
          chips: [{ id: 'BAD', label: 'Bad', workspaceDir }]
        })
      });
      expect(response.status).toBe(400);
    }
  });

  it('retires the legacy user chip access admin route', async () => {
    started = await startAdminChipServer();
    const retiredGet = await fetch(`${started.baseUrl}/admin/chip-access`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    expect(retiredGet.status).toBe(404);

    const retiredPut = await fetch(`${started.baseUrl}/admin/chip-access`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${started.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ users: { [started.alice.id]: ['RISC-V'] } })
    });
    expect(retiredPut.status).toBe(404);
  });

  it('keeps the retired user chip access route independent from legacy file write failures', async () => {
    started = await startAdminChipServer();
    await rm(started.configDir, { recursive: true, force: true });
    await writeFile(started.configDir, 'blocks atomic write temp files', 'utf-8');

    const response = await fetch(`${started.baseUrl}/admin/chip-access`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${started.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ users: { [started.alice.id]: ['RISC-V'] } })
    });

    expect(response.status).toBe(404);
  });

  it('filters /chips and denies unauthorized session creation using user grants before role fallback', async () => {
    started = await startAdminChipServer();

    await started.userStore.updateUser(started.alice.id, { resourceGrants: { chipIds: ['RISC-V'] } });

    const aliceChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.aliceToken}` }
    });
    expect((await json(aliceChips)).chips.map((chip: { id: string }) => chip.id)).toEqual(['RISC-V']);

    const denied = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${started.aliceToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentType: 'claude-code', task: 'blocked', chipId: 'E521.39' })
    });
    expect(denied.status).toBe(403);
    expect(started.manager.spawn).not.toHaveBeenCalled();

    const allowed = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${started.aliceToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentType: 'claude-code', task: 'allowed', chipId: 'RISC-V' })
    });
    expect(allowed.status).toBe(201);
  });

  it('falls back to role grants when user has no explicit chip access and lets admins see all chips', async () => {
    started = await startAdminChipServer();

    const bobChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.bobToken}` }
    });
    expect((await json(bobChips)).chips.map((chip: { id: string }) => chip.id)).toEqual([]);

    const adminChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    expect((await json(adminChips)).chips.map((chip: { id: string }) => chip.id)).toEqual([
      'E521.39',
      'RISC-V',
      'ADMIN-ONLY'
    ]);
  });

  it('treats an explicit empty user chip list as a full override', async () => {
    started = await startAdminChipServer();

    const roles = JSON.parse(await readFile(started.rolesFile, 'utf-8'));
    roles.customer.access.allowedChips = ['*'];
    await writeFile(started.rolesFile, JSON.stringify(roles, null, 2), 'utf-8');
    const reload = await fetch(`${started.baseUrl}/admin/roles/reload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    expect(reload.status).toBe(200);

    const defaultChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.bobToken}` }
    });
    expect((await json(defaultChips)).chips.map((chip: { id: string }) => chip.id)).toEqual([
      'E521.39',
      'RISC-V',
      'ADMIN-ONLY'
    ]);

    await started.userStore.updateUser(started.bob.id, { resourceGrants: { chipIds: [] } });

    const overriddenChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${started.bobToken}` }
    });
    expect((await json(overriddenChips)).chips.map((chip: { id: string }) => chip.id)).toEqual([]);
  });

  it('keeps new roles denied by default and reloads role chip access without restart', async () => {
    started = await startAdminChipServer();

    const createRole = await fetch(`${started.baseUrl}/admin/roles`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${started.adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'operator', description: 'Operator', permissions: ['chips'] })
    });
    expect(createRole.status).toBe(201);

    await started.userStore.updateUserRole(started.bob.id, 'operator');
    const operatorToken = started.jwtService.sign(started.bob.id, started.bob.username, 'operator');
    const deniedChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${operatorToken}` }
    });
    expect((await json(deniedChips)).chips.map((chip: { id: string }) => chip.id)).toEqual([]);

    const deniedSession = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentType: 'claude-code', task: 'blocked', chipId: 'RISC-V' })
    });
    expect(deniedSession.status).toBe(403);
    expect(started.manager.spawn).not.toHaveBeenCalled();

    const roles = JSON.parse(await readFile(started.rolesFile, 'utf-8'));
    roles.operator.access.allowedChips = ['RISC-V'];
    await writeFile(started.rolesFile, JSON.stringify(roles, null, 2), 'utf-8');

    const reload = await fetch(`${started.baseUrl}/admin/roles/reload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${started.adminToken}` }
    });
    expect(reload.status).toBe(200);

    const allowedChips = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${operatorToken}` }
    });
    expect((await json(allowedChips)).chips.map((chip: { id: string }) => chip.id)).toEqual(['RISC-V']);

    const allowedSession = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${operatorToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ agentType: 'claude-code', task: 'allowed', chipId: 'RISC-V' })
    });
    expect(allowedSession.status).toBe(201);
    expect(started.manager.spawn).toHaveBeenCalledOnce();
  });

  // T16 回归守卫：brand/productLines 存入后原样返回（含多值 productLines）
  it('T16 guard: brand=Elmos and productLines=[Elmos 灯光, 氛围灯] survive PUT /admin/chips round-trip', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken, chipConfigFile } = started;
    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    catalog.chips = catalog.chips.map((c) =>
      c.id === 'E521.39'
        ? { ...c, brand: 'Elmos', productLines: ['Elmos 灯光', '氛围灯'] }
        : c
    );
    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { chips: any[] };
    const e521 = body.chips.find((c: any) => c.id === 'E521.39');
    expect(e521.brand).toBe('Elmos');
    expect(e521.productLines).toEqual(['Elmos 灯光', '氛围灯']);
    const saved = JSON.parse(await readFile(chipConfigFile, 'utf-8'));
    const saved521 = saved.chips.find((c: any) => c.id === 'E521.39');
    expect(saved521.brand).toBe('Elmos');
    expect(saved521.productLines).toEqual(['Elmos 灯光', '氛围灯']);
  });

  // 后端透传护栏：钉死 PUT body 的全部字段（summary/applicationTags/productLines/brand）忠实落库、后端不剥离。
  // 注意：本测试直接构造 PUT body，不经前端 collectChipCatalog —— 后端为全量覆盖（不做 merge），故「编辑器仅
  // 渲染部分字段、合并保留未编辑字段」必须在前端完成，由 web-ui-chip.test.ts 的 collectChipCatalog 镜像测试覆盖；
  // 本测试不冒充用真实 admin.js 求值的端到端覆盖。
  it('后端透传护栏：admin PUT 忠实持久化 summary/applicationTags/productLines/brand 全字段', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken, chipConfigFile } = started;
    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    catalog.chips = catalog.chips.map((c) =>
      c.id === 'E521.39'
        ? { ...c, summary: 'LED 开短路诊断；PWM 调光', applicationTags: ['LED-diagnostics', 'PWM-dimming'], productLines: ['氛围灯'], brand: 'ELMOS' }
        : c
    );
    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    const saved = JSON.parse(await readFile(chipConfigFile, 'utf-8'));
    const e521 = saved.chips.find((c: any) => c.id === 'E521.39');
    expect(e521.summary).toBe('LED 开短路诊断；PWM 调光');
    expect(e521.applicationTags).toEqual(['LED-diagnostics', 'PWM-dimming']);
    expect(e521.productLines).toEqual(['氛围灯']);
    expect(e521.brand).toBe('ELMOS');
  });

  // B11 Task 2.2：既有 chip 的 id 被改名 → 409 拒绝，目录不变；新增 chip（旧无此 id）允许。
  it('rejects renaming an existing chip id with 409 and leaves catalog unchanged', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken, chipConfigFile } = started;

    const before = JSON.parse(await readFile(chipConfigFile, 'utf-8'));

    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    // 把既有 E521.39 改名为 E521.99（其余 chip 不变）
    catalog.chips = catalog.chips.map((c) => (c.id === 'E521.39' ? { ...c, id: 'E521.99' } : c));

    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(409);

    // 目录文件未被改写
    const after = JSON.parse(await readFile(chipConfigFile, 'utf-8'));
    expect(after).toEqual(before);
  });

  // B11 Task 2.2：新增 chip（旧 catalog 无此 id）与既有 chip 并存时允许（不误判为改名）。
  it('allows adding a brand-new chip while keeping existing ids', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken, kbRoot } = started;
    await mkdir(join(kbRoot, 'NEW-CHIP'), { recursive: true });

    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    catalog.chips = [
      ...catalog.chips,
      { id: 'NEW-CHIP', label: 'New Chip', workspaceDir: join(kbRoot, 'NEW-CHIP') }
    ];

    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { chips: any[] };
    expect(body.chips.map((c: any) => c.id)).toContain('NEW-CHIP');
    expect(body.chips.map((c: any) => c.id)).toContain('E521.39');
  });

  // BE1：芯片删除后不再写 legacy user-chip-access.json；授权源已迁移到 users.json。
  // V3：芯片删除必须真实级联清理 users.json（含各 user 的 MCP key grants）、role grants（roles.json
  // 的 access.allowedChips + access.grants.chipIds）、resource-visibility.json 的 document/scopePreset
  // chipId 引用；历史 session/debug 审计与 prompt 文件保持不动（不属本次清理范围）。
  it('cascades deletion of a chip id across users, mcp keys, roles, and resource-visibility catalog (V3)', async () => {
    const resourceCatalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-e521-39',
          label: 'E521.39 doc',
          visibility: 'restricted',
          status: 'approved',
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          applicationTags: [],
          chipIds: ['E521.39', 'RISC-V'],
          requiredGrants: {},
          sourceLabels: []
        }
      ],
      scopePresets: [
        {
          scopePresetId: 'scope-lighting',
          label: 'Lighting scope',
          visibility: 'restricted',
          status: 'approved',
          brands: ['ELMOS'],
          productLines: ['Lighting'],
          applicationTags: [],
          chipIds: ['E521.39'],
          documentIds: ['doc-e521-39'],
          requiredGrants: {},
          sourceLabels: []
        }
      ]
    });
    started = await startAdminChipServer({
      rolesJson: {
        admin: { description: 'Admin', access: { allowedChips: ['*'], injectionPolicy: 'every_turn' } },
        customer: {
          description: 'Customer',
          access: {
            allowedChips: ['E521.39', 'RISC-V'],
            injectionPolicy: 'first_turn',
            grants: { chipIds: ['E521.39', 'RISC-V'] }
          }
        }
      },
      resourceCatalog
    });
    const { baseUrl, adminToken, alice, bob } = started;

    await started.userStore.updateUser(alice.id, { resourceGrants: { chipIds: ['E521.39', 'RISC-V'] } });
    await started.userStore.updateUser(bob.id, { resourceGrants: { chipIds: ['RISC-V'] } });
    await started.userStore.addMcpKey(alice.id, 'alice-key', { resourceGrants: { chipIds: ['E521.39', 'RISC-V'] } });

    // 历史审计/prompt 文件应保持不动：在 dataDir 下放一份仿真的 session 历史标记文件，
    // 删芯片前后取内容比对，验证级联清理未触碰它（用户明确要求：历史 session/debug 审计保留）。
    const historyMarkerFile = join(started.dataDir, 'sessions-history-marker.json');
    const historyMarkerContent = JSON.stringify({ sessionId: 'sess-1', chipId: 'E521.39', note: 'do-not-touch' });
    await writeFile(historyMarkerFile, historyMarkerContent, 'utf-8');
    const promptChipFile = join(started.configDir, 'prompts', 'chips', 'E521.39.md');
    await writeFile(promptChipFile, 'E521.39 system prompt\n', 'utf-8');

    // PUT 删除 E521.39：catalog 不再包含它，且 deletedIds 显式列出它。
    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    const remaining = catalog.chips.filter((c) => c.id !== 'E521.39');

    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ ...catalog, chips: remaining, deletedIds: ['E521.39'] })
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { chips: any[]; accessCleanup?: { removedGrants: number; affectedUsers: number } };

    // 计数是真实的（非恒 0 的桩返回）：alice 的 user grant + mcp key grant、bob 未持有该 chip
    // 故不计入 affectedUsers；至少 alice 一名用户受影响、至少 2 处 grant（user + mcp key）被剔除。
    expect(body.accessCleanup).toBeDefined();
    expect(body.accessCleanup!.removedGrants).toBeGreaterThan(0);
    expect(body.accessCleanup!.affectedUsers).toBeGreaterThan(0);

    // users.json：alice 的 resourceGrants.chipIds 与 mcp key 的 resourceGrants.chipIds 都已剔除 E521.39，
    // 但保留其余未删除的 chip（RISC-V）；bob（本就未持有 E521.39）不受影响、原样保留。
    const aliceAfter = await started.userStore.findById(alice.id);
    expect(aliceAfter?.resourceGrants?.chipIds).toEqual(['RISC-V']);
    expect(aliceAfter?.mcpKeys[0]?.resourceGrants?.chipIds).toEqual(['RISC-V']);
    const bobAfter = await started.userStore.findById(bob.id);
    expect(bobAfter?.resourceGrants?.chipIds).toEqual(['RISC-V']);

    // roles.json：customer 角色的 allowedChips 与 access.grants.chipIds 都已剔除 E521.39，通配符角色（admin）不受影响。
    const rolesAfter = JSON.parse(await readFile(started.rolesFile, 'utf-8'));
    expect(rolesAfter.customer.access.allowedChips).toEqual(['RISC-V']);
    expect(rolesAfter.customer.access.grants.chipIds).toEqual(['RISC-V']);
    expect(rolesAfter.admin.access.allowedChips).toEqual(['*']);

    // resource-visibility.json：文档/预设的 chipIds 引用中 E521.39 被剔除，其余引用（RISC-V/documentIds）保留。
    const resourcesAfter = JSON.parse(await readFile(started.resourcesConfigFile, 'utf-8'));
    const docAfter = resourcesAfter.documents.find((d: any) => d.documentId === 'doc-e521-39');
    expect(docAfter.chipIds).toEqual(['RISC-V']);
    const scopeAfter = resourcesAfter.scopePresets.find((s: any) => s.scopePresetId === 'scope-lighting');
    expect(scopeAfter.chipIds).toEqual([]);
    expect(scopeAfter.documentIds).toEqual(['doc-e521-39']);

    // 历史审计与 prompt 文件不受级联清理触碰。
    expect(await readFile(historyMarkerFile, 'utf-8')).toBe(historyMarkerContent);
    expect(await readFile(promptChipFile, 'utf-8')).toBe('E521.39 system prompt\n');

    // 复用同一 chip id 不应恢复旧授权：新建一个同 id 的 chip 后，alice/bob 均不应重新拥有它。
    const putAgainRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...catalog,
        chips: [...remaining, { id: 'E521.39', label: 'E521.39 Chip (recreated)', workspaceDir: join(started.kbRoot, 'E521.39') }]
      })
    });
    expect(putAgainRes.status).toBe(200);
    const aliceAfterRecreate = await started.userStore.findById(alice.id);
    expect(aliceAfterRecreate?.resourceGrants?.chipIds ?? []).not.toContain('E521.39');
  });

  // B11 Task 2.4：保存并发守卫。GET 返回 ETag；PUT(If-Match=旧 etag) 成功并返回新 etag；
  // 再用旧 etag 保存 → 409（目录已被前一次保存改写）。
  it('guards concurrent chip catalog saves via ETag / If-Match (mismatch -> 409)', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken } = started;

    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(getRes.status).toBe(200);
    const etagV1 = getRes.headers.get('etag');
    expect(etagV1).toBeTruthy();
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };

    // 第一次保存带正确 If-Match → 成功，返回新 etag（与 v1 不同）。
    const edited = {
      ...catalog,
      chips: catalog.chips.map((c) => (c.id === 'E521.39' ? { ...c, label: 'E521.39 Edited' } : c))
    };
    const put1 = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        'if-match': etagV1 as string
      },
      body: JSON.stringify(edited)
    });
    expect(put1.status).toBe(200);
    const etagV2 = put1.headers.get('etag');
    expect(etagV2).toBeTruthy();
    expect(etagV2).not.toBe(etagV1);

    // 第二次仍用旧 etagV1 → 409（并发覆盖被拒）。
    const put2 = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
        'if-match': etagV1 as string
      },
      body: JSON.stringify(edited)
    });
    expect(put2.status).toBe(409);
  });

  // B11 Task 2.4：向后兼容——不带 If-Match 的旧调用方仍可保存（不强制 If-Match）。
  it('still allows chip catalog saves without an If-Match header (backward compatible)', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken } = started;
    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };
    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    expect(putRes.headers.get('etag')).toBeTruthy();
  });

  // BE1：deletedIds 为空或缺省时不改动 users.json chip grants（无清理摘要时为零）。
  it('does not touch user chip grants when no chip is deleted', async () => {
    started = await startAdminChipServer();
    const { baseUrl, adminToken, alice } = started;

    await started.userStore.updateUser(alice.id, { resourceGrants: { chipIds: ['E521.39'] } });

    const getRes = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = (await getRes.json()) as { knowledgeBaseRoot: string; chips: any[] };

    const putRes = await fetch(`${baseUrl}/admin/chips`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(catalog)
    });
    expect(putRes.status).toBe(200);
    const body = (await putRes.json()) as { accessCleanup?: { removedGrants: number; affectedUsers: number } };
    expect(body.accessCleanup?.removedGrants ?? 0).toBe(0);

    expect((await started.userStore.findById(alice.id))?.resourceGrants?.chipIds).toEqual(['E521.39']);
  });
});
