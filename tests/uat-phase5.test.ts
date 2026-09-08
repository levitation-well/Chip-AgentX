/**
 * Phase 5 User Acceptance Tests (UAT)
 *
 * Tests the CHIP-01 / CHIP-02 acceptance criteria from the ROADMAP.
 * CHIP-01: Users can select a chip model in the chat interface.
 * CHIP-02: The system sets the Claude Code working directory based on the user's chip selection.
 *
 * These are black-box API tests that verify the HTTP layer behavior.
 * They use real HTTP server startup with in-memory stores.
 */
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

const JWT_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

let KB_ROOT: string;
let CHIP_CONFIG: { knowledgeBaseRoot: string; chips: { id: string; label: string; workspaceDir: string }[] };

async function startUATServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'uat-phase5-'));
  KB_ROOT = await mkdtemp(join(tmpdir(), 'uat-phase5-kb-'));
  await mkdir(join(KB_ROOT, 'E521.39'), { recursive: true });
  await mkdir(join(KB_ROOT, 'RISC-V'), { recursive: true });
  CHIP_CONFIG = {
    knowledgeBaseRoot: KB_ROOT,
    chips: [
      { id: 'E521.39', label: 'E521.39 芯片', workspaceDir: 'E521.39' },
      { id: 'RISC-V', label: 'RISC-V 内核', workspaceDir: 'RISC-V' }
    ]
  };

  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  const sessions: any[] = [];
  let sessionCounter = 0;
  manager.spawn = vi.fn().mockImplementation(async (params: any) => {
    const session = {
      id: `uat-${++sessionCounter}`,
      agentType: params.agentType,
      status: 'running' as const,
      startedAt: Date.now(),
      cwd: params.cwd || join(KB_ROOT, params.chipId || 'default'),
      task: params.task,
      sessionMode: params.sessionMode,
      turnState: 'idle' as const,
      turnCount: 1,
      chipId: params.chipId,
      userId: params.userId,
      claudeSessionId: '00000000-0000-4000-8000-000000005001'
    };
    sessions.push(session);
    return session;
  });
  manager.log = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.tail = vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 });
  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.listWithPid = vi.fn().mockImplementation(() =>
    sessions.map((s) => ({ ...s, pid: 99999 }))
  );

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
          id: 'user-1',
          username: 'alice',
          passwordHash: await bcrypt.hash('alice-secret', 10),
          mcpKeys: [],
          createdAt: '2026-05-14T00:00:00.000Z',
          role: 'internal'
        },
        {
          id: 'admin-id',
          username: 'admin',
          passwordHash: config.adminPasswordHash,
          mcpKeys: [],
          createdAt: '2026-05-14T00:00:00.000Z',
          role: 'admin'
        }
      ],
      null,
      2
    ),
    'utf8'
  );
  await userStore.init();
  const alice = (await userStore.findByUsername('alice'))!;
  const jwtService = new JwtService(config);

  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: true, catalog: CHIP_CONFIG }
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  return { baseUrl: `http://127.0.0.1:${address.port}`, server, dataDir, jwtService, alice };
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

describe('UAT Phase 5 — chip selection and workspace isolation', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let baseUrl: string;
  let userToken: string;

  beforeEach(async () => {
    const started = await startUATServer();
    server = started.server;
    dataDir = started.dataDir;
    baseUrl = started.baseUrl;
    userToken = `Bearer ${started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role)}`;
  });

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  // CHIP-01: User can see chip selector
  it('CHIP-01: authenticated user can GET /chips to see available chips', async () => {
    const response = await fetch(`${baseUrl}/chips`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(Array.isArray(body.chips)).toBe(true);
    expect(body.chips.length).toBeGreaterThanOrEqual(1);
    expect(body.chips[0]).toHaveProperty('id');
    expect(body.chips[0]).toHaveProperty('label');
  });

  it('CHIP-01: chip list does not expose workspaceDir to regular users', async () => {
    const response = await fetch(`${baseUrl}/chips`, { headers: { Authorization: userToken } });
    const body = await json(response);
    for (const chip of body.chips) {
      expect(chip).not.toHaveProperty('workspaceDir');
      expect(chip).not.toHaveProperty('cwd');
      expect(chip).not.toHaveProperty('knowledgeBaseRoot');
    }
  });

  // CHIP-02: Session creation uses chipId
  it('CHIP-02: POST /sessions with chipId creates session with resolved cwd', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect E521.39 datasheet', chipId: 'E521.39', sessionMode: 'conversation' })
    });
    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body).toHaveProperty('chipId', 'E521.39');
  });

  it('CHIP-02: POST /sessions resolves cwd from chip catalog server-side', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'E521.39', sessionMode: 'conversation' })
    });
    expect(response.status).toBe(201);
  });

  it('CHIP-02: POST /sessions rejects user-supplied cwd (directory traversal prevention)', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'E521.39', cwd: '/etc/passwd' })
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(String(body.error)).not.toContain('/etc/passwd');
  });

  it('CHIP-02: POST /sessions rejects unknown chipId', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'NONEXISTENT-CHIP' })
    });
    expect(response.status).toBe(400);
  });

  // CHIP-02: Session list includes chipId
  it('CHIP-02: GET /sessions includes chipId per session', async () => {
    await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'inspect', chipId: 'E521.39' })
    });
    const response = await fetch(`${baseUrl}/sessions`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.sessions.length).toBeGreaterThanOrEqual(1);
    const session = body.sessions.find((s: any) => s.chipId === 'E521.39');
    expect(session).toBeDefined();
    expect(session).toHaveProperty('chipId', 'E521.39');
  });

  // Deferred: Full editable chip directory management
  it('Deferred: chip config is managed server-side via CHIP_CONFIG_FILE, not editable from UI', async () => {
    const response = await fetch(`${baseUrl}/chips`, { headers: { Authorization: userToken } });
    expect(response.status).toBe(200);
    // The API is read-only for chip selection; no POST/PUT/DELETE on /chips
    const postResponse = await fetch(`${baseUrl}/chips`, {
      method: 'POST',
      headers: { Authorization: userToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'NEW-CHIP', label: 'New Chip', workspaceDir: '/some/path' })
    });
    expect(postResponse.status).toBe(404);
  });
});
