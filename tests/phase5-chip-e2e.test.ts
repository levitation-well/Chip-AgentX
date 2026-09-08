import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

let KB_ROOT: string;
let CHIP_CONFIG: { knowledgeBaseRoot: string; chips: { id: string; label: string; workspaceDir: string }[] };

function createFakeManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.spawn = vi.fn().mockResolvedValue({
    id: 'sess-e2e-1',
    agentType: 'claude-code',
    status: 'running',
    startedAt: Date.now(),
    cwd: join(KB_ROOT, 'E521.39'),
    task: 'e2e test',
    sessionMode: 'conversation',
    turnState: 'idle',
    turnCount: 1,
    chipId: 'E521.39',
    userId: 'user-1',
    claudeSessionId: '00000000-0000-4000-8000-000000000301'
  });
  manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.tail = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.listWithPid = vi.fn().mockReturnValue([
    {
      id: 'sess-e2e-1',
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: join(KB_ROOT, 'E521.39'),
      task: 'e2e test',
      sessionMode: 'conversation',
      turnState: 'idle',
      turnCount: 1,
      chipId: 'E521.39',
      userId: 'user-1',
      finishedAt: undefined,
      exitCode: undefined,
      totalOutputChars: 0,
      pid: 54321,
      claudeSessionId: '00000000-0000-4000-8000-000000000301'
    }
  ]);
  return manager;
}

async function startE2EServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'chip-e2e-'));
  KB_ROOT = await mkdtemp(join(tmpdir(), 'chip-e2e-kb-'));
  await mkdir(join(KB_ROOT, 'E521.39'), { recursive: true });
  await mkdir(join(KB_ROOT, 'RISC-V'), { recursive: true });
  CHIP_CONFIG = {
    knowledgeBaseRoot: KB_ROOT,
    chips: [
      { id: 'E521.39', label: 'E521.39 芯片', workspaceDir: 'E521.39' },
      { id: 'RISC-V', label: 'RISC-V 内核', workspaceDir: 'RISC-V' }
    ]
  };

  const manager = createFakeManager();
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await writeFile(
    join(dataDir, 'users.json'),
    JSON.stringify(
      [
        {
          id: 'admin-id',
          username: 'admin',
          passwordHash: config.adminPasswordHash,
          mcpKeys: [],
          createdAt: '2026-05-14T00:00:00.000Z',
          role: 'admin'
        },
        {
          id: 'user-1',
          username: 'alice',
          passwordHash: await bcrypt.hash('alice-secret', 10),
          mcpKeys: [],
          createdAt: '2026-05-14T00:00:00.000Z',
          role: 'internal'
        }
      ],
      null,
      2
    ),
    'utf8'
  );
  await userStore.init();
  const alice = (await userStore.findByUsername('alice'))!;
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);

  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: true, catalog: CHIP_CONFIG }
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  return { baseUrl: `http://127.0.0.1:${address.port}`, manager, server, dataDir, jwtService, alice, admin };
}

async function closeServer(server: Server | undefined, dataDir: string | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  const cleanups = [dataDir, KB_ROOT].filter(Boolean) as string[];
  await Promise.all(cleanups.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('Phase 5 chip E2E', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let baseUrl: string;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    const started = await startE2EServer();
    server = started.server;
    dataDir = started.dataDir;
    baseUrl = started.baseUrl;
    adminToken = `Bearer ${started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role)}`;
    userToken = `Bearer ${started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role)}`;
  });

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('CHIP-01: user can get chip list from GET /chips', async () => {
    const response = await fetch(`${baseUrl}/chips`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.chips).toHaveLength(2);
    expect(body.chips[0].id).toBe('E521.39');
    expect(body.chips[0]).toHaveProperty('id');
    expect(body.chips[0]).toHaveProperty('label');
    expect(body.chips[0]).not.toHaveProperty('workspaceDir');
    expect(body.chips[0]).not.toHaveProperty('cwd');
    expect(body.chips[0]).not.toHaveProperty('knowledgeBaseRoot');
  });

  it('CHIP-02: POST /sessions with chipId resolves cwd server-side', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect E521.39 datasheet', chipId: 'E521.39', sessionMode: 'conversation' })
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toHaveProperty('sessionId');
    expect(body).toHaveProperty('chipId', 'E521.39');
  });

  it('CHIP-02: user cannot submit arbitrary cwd', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'E521.39', cwd: '/etc/passwd' })
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body).toHaveProperty('error');
    expect(String(body.error)).not.toContain('/etc/passwd');
  });

  it('CHIP-02: unknown chipId returns 400', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'UNKNOWN-CHIP' })
    });
    expect(response.status).toBe(400);
  });

  it('CHIP-02: session list includes chipId', async () => {
    // Create a session first
    await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'E521.39' })
    });
    const response = await fetch(`${baseUrl}/sessions`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.sessions.some((s: any) => s.chipId === 'E521.39')).toBe(true);
  });

  it('admin can view chip mapping at GET /admin/chips', async () => {
    const response = await fetch(`${baseUrl}/admin/chips`, { headers: { Authorization: adminToken } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.chips).toHaveLength(2);
    expect(body.chips[0]).toHaveProperty('workspaceDir');
  });

  it('non-admin cannot view chip mapping', async () => {
    const response = await fetch(`${baseUrl}/admin/chips`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(403);
  });

  it('GET /chips requires authentication', async () => {
    const response = await fetch(`${baseUrl}/chips`);
    expect(response.status).toBe(401);
  });
});
