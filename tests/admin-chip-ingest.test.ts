import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.spawn = vi.fn();
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

async function startServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ingest-data-'));
  const kbRoot = await mkdtemp(join(tmpdir(), 'ingest-kb-'));
  const configDir = await mkdtemp(join(tmpdir(), 'ingest-config-'));
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await mkdir(join(kbRoot, 'RISC-V'), { recursive: true });
  await mkdir(join(kbRoot, 'E522.94'), { recursive: true });

  const chipConfigFile = join(configDir, 'chips.json');
  const userAccessFile = join(configDir, 'user-chip-access.json');
  const rolesFile = join(configDir, 'roles.json');
  const promptsConfigFile = join(configDir, 'prompts.json');
  const promptsBaseDir = join(configDir, 'prompts');
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
          { id: 'RISC-V', label: 'RISC-V Core', workspaceDir: 'RISC-V' }
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
      {
        admin: { description: 'Admin', access: { allowedChips: ['*'], injectionPolicy: 'every_turn' } },
        customer: { description: 'Customer', access: { allowedChips: [], injectionPolicy: 'first_turn' } }
      },
      null,
      2
    ),
    'utf-8'
  );
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
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const manager = createFakeManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService, rolesFile },
    chips: { enabled: true, configFile: chipConfigFile, userAccessFile },
    prompts: { enabled: true, configFile: promptsConfigFile, rolesFile }
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
    jwtService,
    adminToken: jwtService.sign(admin!.id, admin!.username, admin!.role),
    aliceToken: jwtService.sign(alice.id, alice.username, alice.role)
  };
}

async function closeStarted(started: Awaited<ReturnType<typeof startServer>> | undefined) {
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

describe('B11 Task 2.6 — datasheet metadata ingest into chips.json', () => {
  let started: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await closeStarted(started);
    started = undefined;
  });

  it('ingests a brand-new chip draft into chips.json and reloads it', async () => {
    started = await startServer();
    const { baseUrl, adminToken, chipConfigFile, kbRoot } = started;

    const response = await fetch(`${baseUrl}/admin/chips/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        chipId: 'E522.94',
        label: 'E522.94 LED Driver',
        brand: 'Elmos',
        productLines: ['外饰灯'],
        summary: '16 路外饰灯 LED 驱动；LED 开/短路诊断；PWM 调光；UART-over-CAN；ASIL-B',
        applicationTags: ['外饰灯', 'LED-open-short-diagnostics', 'PWM-dimming', 'UART-over-CAN'],
        workspaceDir: join(kbRoot, 'E522.94')
      })
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.chip.id).toBe('E522.94');
    expect(body.chip.summary).toContain('PWM 调光');
    expect(body.chip.applicationTags).toContain('LED-open-short-diagnostics');

    // chips.json gained the chip with all draft fields.
    const saved = JSON.parse(await readFile(chipConfigFile, 'utf-8'));
    const e522 = saved.chips.find((c: any) => c.id === 'E522.94');
    expect(e522).toBeTruthy();
    expect(e522.brand).toBe('Elmos');
    expect(e522.productLines).toEqual(['外饰灯']);
    expect(e522.applicationTags).toContain('UART-over-CAN');

    // existing chips untouched.
    expect(saved.chips.map((c: any) => c.id)).toEqual(['E521.39', 'RISC-V', 'E522.94']);
    const e521 = saved.chips.find((c: any) => c.id === 'E521.39');
    expect(e521.label).toBe('E521.39 Chip');

    // reload: a fresh GET /admin/chips now shows the ingested chip (in-memory catalog refreshed).
    const reload = await fetch(`${baseUrl}/admin/chips`, { headers: { authorization: `Bearer ${adminToken}` } });
    const catalog = await json(reload);
    expect(catalog.chips.map((c: any) => c.id)).toContain('E522.94');
  });

  it('ingests metadata onto an existing chip without disturbing other fields or chips', async () => {
    started = await startServer();
    const { baseUrl, adminToken, chipConfigFile } = started;

    const response = await fetch(`${baseUrl}/admin/chips/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        chipId: 'E521.39',
        summary: 'LED 开短路诊断；PWM 调光',
        applicationTags: ['LED-diagnostics', 'PWM-dimming'],
        brand: 'ELMOS',
        productLines: ['氛围灯']
      })
    });
    expect(response.status).toBe(200);

    const saved = JSON.parse(await readFile(chipConfigFile, 'utf-8'));
    const e521 = saved.chips.find((c: any) => c.id === 'E521.39');
    // metadata merged in
    expect(e521.summary).toBe('LED 开短路诊断；PWM 调光');
    expect(e521.applicationTags).toEqual(['LED-diagnostics', 'PWM-dimming']);
    expect(e521.brand).toBe('ELMOS');
    expect(e521.productLines).toEqual(['氛围灯']);
    // pre-existing fields preserved (not provided by the draft)
    expect(e521.label).toBe('E521.39 Chip');
    expect(e521.queryHint).toBe('Use for E521.39 questions');
    // other chips unchanged
    expect(saved.chips.map((c: any) => c.id)).toEqual(['E521.39', 'RISC-V']);
    const riscv = saved.chips.find((c: any) => c.id === 'RISC-V');
    expect(riscv.label).toBe('RISC-V Core');
  });

  it('rejects ingest from a non-admin user with 403', async () => {
    started = await startServer();
    const { baseUrl, aliceToken, kbRoot } = started;
    const response = await fetch(`${baseUrl}/admin/chips/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ chipId: 'E522.94', label: 'x', workspaceDir: join(kbRoot, 'E522.94') })
    });
    expect(response.status).toBe(403);
  });

  it('rejects a new chip ingest that lacks a workspaceDir with 400', async () => {
    started = await startServer();
    const { baseUrl, adminToken } = started;
    const response = await fetch(`${baseUrl}/admin/chips/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ chipId: 'BRAND-NEW', summary: 'no workspace given' })
    });
    expect(response.status).toBe(400);
  });
});
