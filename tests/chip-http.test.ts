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
const CHIP_CONFIG_TEMPLATE = {
  knowledgeBaseRoot: '__KB_ROOT__',
  chips: [
    { id: 'E521.39', label: 'E521.39 芯片', workspaceDir: 'E521.39' },
    { id: 'RISC-V', label: 'RISC-V 内核', workspaceDir: 'RISC-V' }
  ]
};

function createFakeManager(kbRoot = '') {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;

  manager.spawn = vi.fn().mockResolvedValue({
    id: 'session-test-123',
    agentType: 'claude-code',
    status: 'running',
    startedAt: 123,
    cwd: join(kbRoot || tmpdir(), 'E521.39'),
    task: 'test task',
    sessionMode: 'conversation',
    turnState: 'idle',
    turnCount: 1,
    chipId: 'E521.39',
    userId: 'user-1',
    claudeSessionId: '00000000-0000-4000-8000-000000000201'
  });
  manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.tail = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.listWithPid = vi.fn().mockReturnValue([
    {
      id: 'session-test-123',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 123,
      cwd: join(kbRoot || tmpdir(), 'E521.39'),
      task: 'test task',
      sessionMode: 'conversation',
      turnState: 'idle',
      turnCount: 1,
      chipId: 'E521.39',
      userId: 'user-1',
      finishedAt: undefined,
      exitCode: undefined,
      totalOutputChars: 0,
      pid: 12345,
      claudeSessionId: '00000000-0000-4000-8000-000000000201'
    }
  ]);

  return manager;
}

async function startChipServer(authEnabled = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chip-http-test-'));
  KB_ROOT = await mkdtemp(join(tmpdir(), 'chip-test-kb-'));

  // Create workspace directories so resolveChipWorkspace() succeeds
  await mkdir(join(KB_ROOT, 'E521.39'), { recursive: true });
  await mkdir(join(KB_ROOT, 'RISC-V'), { recursive: true });

  const manager = createFakeManager(KB_ROOT);

  const chipConfig = {
    knowledgeBaseRoot: KB_ROOT,
    chips: [
      {
        id: 'E521.39',
        label: 'E521.39 芯片',
        description: 'E521.39 public resource summary',
        queryHint: 'Use for E521.39 register and diagnostic questions',
        workspaceDir: 'E521.39'
      },
      {
        id: 'RISC-V',
        label: 'RISC-V 内核',
        description: 'RISC-V public resource summary',
        queryHint: 'Use for RISC-V core questions',
        workspaceDir: 'RISC-V'
      }
    ]
  };

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
    auth: authEnabled ? { enabled: true, config, userStore, jwtService } : { enabled: false },
    chips: { enabled: true, catalog: chipConfig }
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    manager,
    server,
    dataDir,
    jwtService,
    userStore,
    alice,
    admin
  };
}

async function closeServer(server: Server | undefined, dataDir: string | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (KB_ROOT) {
    await rm(KB_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('chip HTTP integration', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('GET /chips returns chip list without workspaceDir', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/chips`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.chips).toHaveLength(2);
    expect(body.chips[0]).toHaveProperty('id', 'E521.39');
    expect(body.chips[0]).toHaveProperty('description', 'E521.39 public resource summary');
    expect(body.chips[0]).toHaveProperty('queryHint', 'Use for E521.39 register and diagnostic questions');
    expect(body.chips[1]).toHaveProperty('id', 'RISC-V');
    expect(body.chips[0]).not.toHaveProperty('workspaceDir');
    expect(body.chips[0]).not.toHaveProperty('cwd');
    expect(body.chips[0]).not.toHaveProperty('knowledgeBaseRoot');
  });

  it('GET /chips requires authentication', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/chips`);
    expect(response.status).toBe(401);
  });

  it('GET /admin/chips returns chip mapping details for admin', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const response = await fetch(`${started.baseUrl}/admin/chips`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.chips).toHaveLength(2);
    expect(body.chips[0]).toHaveProperty('id', 'E521.39');
    expect(body.chips[0]).toHaveProperty('label');
    expect(body.chips[0]).toHaveProperty('description', 'E521.39 public resource summary');
    expect(body.chips[0]).toHaveProperty('queryHint', 'Use for E521.39 register and diagnostic questions');
    expect(body.chips[0]).toHaveProperty('workspaceDir');
    expect(body.chips[0]).toHaveProperty('workspaceExists', true);
    expect(body.chips[0]).toHaveProperty('workspaceStatus', 'exists');
  });

  it('GET /admin/chips returns 403 for non-admin', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const userToken = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/admin/chips`, {
      headers: { Authorization: `Bearer ${userToken}` }
    });

    expect(response.status).toBe(403);
  });

  it('POST /sessions with chipId spawns with resolved cwd', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect chip datasheet',
        chipId: 'E521.39',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.sessionId).toBe('session-test-123');
    expect(body.chipId).toBe('E521.39');
    expect(body).not.toHaveProperty('cwd');

    // Manager received resolved cwd
    expect(started.manager.spawn).toHaveBeenCalled();
    const spawnCall = started.manager.spawn.mock.calls[0]?.[0];
    expect(spawnCall).toHaveProperty('chipId', 'E521.39');
    expect(spawnCall).toHaveProperty('cwd');
    expect(spawnCall).toHaveProperty('systemPrompt');
    // After the fix the prompt must NOT leak the source filesystem path (it is in
    // denyReadRoots and would steer CC to a denied dir); it carries the chip id and
    // points CC at its current working directory (the isolated replica) instead.
    expect(spawnCall.systemPrompt).not.toContain('Configured workspace directory');
    expect(spawnCall.systemPrompt).not.toContain(join(KB_ROOT, 'E521.39'));
    expect(spawnCall.systemPrompt).toContain('Selected chip: E521.39');
    expect(spawnCall.systemPrompt).toContain('current working directory');
  });

  it('POST /sessions without chipId returns 400', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect chip datasheet'
      })
    });

    expect(response.status).toBe(400);
  });

  it('POST /sessions with unknown chipId returns 400', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect chip datasheet',
        chipId: 'UNKNOWN-CHIP'
      })
    });

    expect(response.status).toBe(400);
  });

  it('POST /sessions rejects user-supplied cwd', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'inspect chip datasheet',
        chipId: 'E521.39',
        cwd: '/etc/passwd'
      })
    });

    expect(response.status).toBe(400);
  });

  it('POST /rpc agent_spawn rejects user-supplied cwd when chips are enabled', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: {
          agentType: 'claude-code',
          task: 'inspect chip datasheet',
          chipId: 'E521.39',
          cwd: '/etc/passwd'
        }
      })
    });

    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error).toContain('cwd must not be supplied directly');
  });

  it('GET /sessions returns session list with chipId', async () => {
    const started = await startChipServer(true);
    server = started.server;
    dataDir = started.dataDir;
    const token = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toHaveProperty('chipId', 'E521.39');
    expect(body.sessions[0]).not.toHaveProperty('cwd');
  });

  it('POST /sessions with chips disabled still works (no chipId required)', async () => {
    const manager = createFakeManager();
    const server = createHttpServer({
      manager: manager as any,
      auth: { enabled: false },
      chips: { enabled: false }
    });

    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'test task'
      })
    });

    expect(response.status).toBe(201);
    expect(manager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'test task' })
    );

    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
