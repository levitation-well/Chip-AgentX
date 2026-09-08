/**
 * Phase 6: System Prompt Injection — HTTP Server Integration Tests
 *
 * Tests the HTTP server's integration with the prompts module:
 * - PromptRuntime initialization (config/roles.json, config/prompts.json)
 * - RBAC enforcement on session creation (role-chip access matrix)
 * - Admin UI prompt file management APIs
 * - System prompt injection on session creation
 *
 * These are E2E tests using a real HTTP server with mocked SessionManager.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import type { ChipCatalog } from '../src/chips/index.js';

const JWT_SECRET = 'test-jwt-secret-32-characters!';

let KB_ROOT: string;

function createFakeManager() {
  const sessions: any[] = [];
  const manager = {
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: `session-${Date.now()}`,
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? process.cwd(),
        chipId: params.chipId,
        task: params.task,
        sessionMode: params.sessionMode,
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: '00000000-0000-4000-8000-000000000601'
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn().mockResolvedValue(() => undefined),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((s) => ({ ...s, pid: 12345 }))),
    on: vi.fn(),
    off: vi.fn()
  };

  return { manager, sessions };
}

async function startServer(overrides: {
  auth?: Parameters<typeof createHttpServer>[0]['auth'];
  chips?: ChipCatalog | null;
  prompts?: Parameters<typeof createHttpServer>[0]['prompts'];
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-phase6-'));
  KB_ROOT = await mkdtemp(join(tmpdir(), 'chip-kb-'));

  // Copy example prompt/role configs into an isolated temp config dir so tests
  // do not depend on the real config/*.json files that are stripped from the
  // open-source tree.
  const tempConfigDir = join(dataDir, 'config');
  await mkdir(tempConfigDir, { recursive: true });
  await copyFile(join(process.cwd(), 'config', 'prompts.example.json'), join(tempConfigDir, 'prompts.json'));
  await copyFile(join(process.cwd(), 'config', 'roles.example.json'), join(tempConfigDir, 'roles.json'));

  // Create workspace directories so resolveChipWorkspace() succeeds
  await mkdir(join(KB_ROOT, 'E521.39'), { recursive: true });
  await mkdir(join(KB_ROOT, 'XYZ.999'), { recursive: true });

  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '1h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const internalUser = await userStore.createUser('alice-internal', 'internal-secret', 'internal');
  const customerUser = await userStore.createUser('alice-customer', 'customer-secret', 'customer');
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const { manager, sessions } = createFakeManager();

  const chipCatalog: ChipCatalog | null = overrides.chips === undefined
    ? {
        knowledgeBaseRoot: KB_ROOT,
        chips: [
          { id: 'E521.39', label: 'E521.39 芯片', workspaceDir: 'E521.39' },
          { id: 'XYZ.999', label: 'XYZ Chip', workspaceDir: 'XYZ.999' }
        ]
      }
    : overrides.chips;

  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService,
      ...overrides.auth
    },
    chips: chipCatalog ? { enabled: true, catalog: chipCatalog } : { enabled: false },
    prompts: {
      enabled: true,
      configFile: join(tempConfigDir, 'prompts.json'),
      rolesFile: join(tempConfigDir, 'roles.json'),
      ...overrides.prompts
    }
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  return {
    server,
    dataDir,
    config,
    jwtService,
    userStore,
    manager,
    sessions,
    baseUrl: `http://127.0.0.1:${address.port}`,
    internalUser,
    customerUser,
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
    await rm(dataDir, { recursive: true, force: true });
  }
  if (KB_ROOT) {
    await rm(KB_ROOT, { recursive: true, force: true }).catch(() => {});
  }
}

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('Phase 6: HTTP Server — Prompt Runtime Initialization', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('server starts without prompts config (prompts: enabled: false)', async () => {
    const started = await startServer({ prompts: { enabled: false } });
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it('server starts without chips config (chips: null)', async () => {
    const started = await startServer({ chips: null });
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/health`);
    expect(response.status).toBe(200);
  });

  it('GET /chips returns 401 without authentication', async () => {
    // With chips enabled, /chips requires auth and returns 401 when missing token
    const started = await startServer({ chips: undefined, prompts: { enabled: false } });
    server = started.server;
    dataDir = started.dataDir;

    const response = await fetch(`${started.baseUrl}/chips`);
    expect(response.status).toBe(401);
  });
});

describe('Phase 6: HTTP Server — RBAC Role-Chip Access Control', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('internal role can access E521.39 chip (allowed)', async () => {
    started = await startServer({
      chips: undefined,
      prompts: { enabled: true }
    });
    server = started.server;
    dataDir = started.dataDir;

    const internalToken = started.jwtService.sign(started.internalUser.id, started.internalUser.username, started.internalUser.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${internalToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'analyze',
        chipId: 'E521.39',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.sessionId).toBeDefined();
  });

  it('customer role cannot access XYZ.999 chip (403)', async () => {
    started = await startServer({
      chips: undefined,
      prompts: { enabled: true }
    });
    server = started.server;
    dataDir = started.dataDir;

    const customerToken = started.jwtService.sign(started.customerUser.id, started.customerUser.username, started.customerUser.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${customerToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'analyze',
        chipId: 'XYZ.999',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(403);
    const body = await json(response);
    expect(body.error).toBe('The requested resource is not available to this identity.');
    expect(JSON.stringify(body)).not.toContain('XYZ.999');
  });

  it('admin role can access any chip', async () => {
    started = await startServer({
      chips: undefined,
      prompts: { enabled: true }
    });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'admin task',
        chipId: 'XYZ.999',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
  });

  it('without prompts config, session creation proceeds without error', async () => {
    started = await startServer({ chips: null, prompts: { enabled: false } });
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.customerUser.id, started.customerUser.username, started.customerUser.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'test task',
        sessionMode: 'conversation'
      })
    });

    // Should succeed even without prompts — prompts are optional
    expect(response.status).toBe(201);
  });
});

describe('Phase 6: HTTP Server — Admin Prompt File Management', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('GET /admin/prompts requires admin auth (403 for non-admin)', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    // requireAdmin checks username === config.adminUser, not role field
    const customerToken = started.jwtService.sign(started.customerUser.id, started.customerUser.username, started.customerUser.role);

    const response = await fetch(`${started.baseUrl}/admin/prompts`, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });

    expect(response.status).toBe(403);
  });

  it('GET /admin/prompts returns list of prompt files for admin', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const response = await fetch(`${started.baseUrl}/admin/prompts`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.status).toBe(200);
    const body = await json<{ files: Array<{ path: string; name: string; type: string }> }>(response);
    expect(Array.isArray(body.files)).toBe(true);
    // Should contain at least global.md and role/chip files
    const paths = body.files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith('global.md'))).toBe(true);
  });

  it('GET /admin/prompts includes registered chips that do not have prompt files yet', async () => {
    started = await startServer({ chips: undefined, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const listResponse = await fetch(`${started.baseUrl}/admin/prompts`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(listResponse.status).toBe(200);
    const listBody = await json<{ files: Array<{ path: string; name: string; type: string; exists?: boolean }> }>(listResponse);
    expect(listBody.files).toContainEqual(
      expect.objectContaining({ path: 'chips/XYZ.999.md', name: 'XYZ.999', type: 'chip', exists: false })
    );

    const readResponse = await fetch(`${started.baseUrl}/admin/prompts/chips%2FXYZ.999.md`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    expect(readResponse.status).toBe(200);
    const readBody = await json<{ content: string; missing?: boolean }>(readResponse);
    expect(readBody.missing).toBe(true);
    expect(readBody.content).toContain('# XYZ.999 Chip Prompt');
  });

  it('GET /admin/prompts/global.md returns file content', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const response = await fetch(`${started.baseUrl}/admin/prompts/global.md`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });

    expect(response.status).toBe(200);
    const body = await json<{ content: string }>(response);
    expect(typeof body.content).toBe('string');
    expect(body.content.length).toBeGreaterThan(0);
  });

  it('PUT /admin/prompts/roles/admin.md saves content atomically and cleanup restores original', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);
    const testFile = 'roles/admin.md';
    const newContent = `# Admin Role Prompt — TEST UPDATE\n\nTimestamp: ${Date.now()}`;

    // Save
    const saveResponse = await fetch(`${started.baseUrl}/admin/prompts/${testFile}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: newContent })
    });
    expect(saveResponse.status).toBe(200);
    const saveBody = await json(saveResponse);
    expect(saveBody.saved).toBe(true);

    // Read back — verify atomic write
    const readResponse = await fetch(`${started.baseUrl}/admin/prompts/${testFile}`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const readBody = await json<{ content: string }>(readResponse);
    expect(readBody.content).toBe(newContent);

    // Restore original admin.md content so the test doesn't permanently modify the file
    const restoreResponse = await fetch(`${started.baseUrl}/admin/prompts/${testFile}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: '# Admin Role Prompt\n\nYou are an administrator with full access to the system.\n\n## Additional Context\n- You have access to system configuration and management features\n- You can view all chip documentation and technical materials\n- You should provide guidance on system usage and configuration\n\n## Responsibilities\n- Assist users with system setup and configuration\n- Provide technical support for all chip platforms\n- Monitor system health and provide diagnostics\n' })
    });
    expect(restoreResponse.status).toBe(200);
  });

  it('writes prompt history before save and rolls back to the previous version', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);
    const testFile = 'roles/admin.md';
    const promptPath = join(process.cwd(), 'prompts', 'roles', 'admin.md');
    const originalContent = await readFile(promptPath, 'utf-8');
    const newContent = `# Admin Role Prompt\n\nPhase 33 history test ${Date.now()}`;

    try {
      const saveResponse = await fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent(testFile)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: newContent })
      });
      expect(saveResponse.status).toBe(200);

      const historyResponse = await fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent(testFile)}/history`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(historyResponse.status).toBe(200);
      const history = await json<{ entries: Array<{ relativePath: string; username: string; role: string; content: string }> }>(historyResponse);
      expect(history.entries[0]).toMatchObject({
        relativePath: testFile,
        username: started.admin!.username,
        role: started.admin!.role,
        content: originalContent
      });

      const rollbackResponse = await fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent(testFile)}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(rollbackResponse.status).toBe(200);
      const rollbackBody = await json<{ rolledBack: boolean; content: string }>(rollbackResponse);
      expect(rollbackBody).toMatchObject({ rolledBack: true, content: originalContent });

      const readResponse = await fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent(testFile)}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect((await json<{ content: string }>(readResponse)).content).toBe(originalContent);
    } finally {
      await writeFile(promptPath, originalContent, 'utf-8');
    }
  });

  it('rejects non-admin prompt history and rollback access', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const customerToken = started.jwtService.sign(started.customerUser.id, started.customerUser.username, started.customerUser.role);

    for (const request of [
      fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent('roles/admin.md')}/history`, {
        headers: { Authorization: `Bearer ${customerToken}` }
      }),
      fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent('roles/admin.md')}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${customerToken}` }
      })
    ]) {
      const response = await request;
      expect(response.status).toBe(403);
    }
  });

  it('rejects prompt history and rollback path traversal', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    for (const request of [
      fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent('../config/roles.json')}/history`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      }),
      fetch(`${started.baseUrl}/admin/prompts/${encodeURIComponent('../config/roles.json')}/rollback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` }
      })
    ]) {
      const response = await request;
      expect(response.status).toBe(400);
    }
  });

  it('PUT /admin/prompts with empty path returns 400', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    // Empty file path → immediately caught by `!filePath || filePath.includes('..')`
    const response = await fetch(`${started.baseUrl}/admin/prompts/`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ content: 'test' })
    });

    expect(response.status).toBe(400);
  });
});

describe('Phase 6: HTTP Server — Session Creation with System Prompt', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let started: Awaited<ReturnType<typeof startServer>> | undefined;

  afterEach(async () => {
    await closeServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('session creation passes systemPrompt to spawn when prompts enabled', async () => {
    started = await startServer({
      chips: undefined,
      prompts: { enabled: true }
    });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'analyze',
        chipId: 'E521.39',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
    // Verify spawn was called with systemPrompt parameter
    expect(started.manager.spawn).toHaveBeenCalled();
    const spawnCall = (started.manager.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as any;
    expect(spawnCall).toHaveProperty('systemPrompt');
    expect(typeof spawnCall.systemPrompt).toBe('string');
    expect(spawnCall.systemPrompt).not.toContain('Configured workspace directory');
    expect(spawnCall.systemPrompt).toContain('Selected chip: E521.39');
    expect(spawnCall.systemPrompt).toContain('current working directory');
  });

  it('session creation without chipId succeeds when chips disabled', async () => {
    started = await startServer({ chips: null, prompts: { enabled: true } });
    server = started.server;
    dataDir = started.dataDir;

    const token = started.jwtService.sign(started.customerUser.id, started.customerUser.username, started.customerUser.role);

    const response = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'test task',
        sessionMode: 'conversation'
      })
    });

    expect(response.status).toBe(201);
    const body = await json(response);
    expect(body.sessionId).toBeDefined();
  });

  it('every-turn prompt injection preserves the chip workspace on follow-up sends', async () => {
    started = await startServer({
      chips: undefined,
      prompts: { enabled: true }
    });
    server = started.server;
    dataDir = started.dataDir;

    const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

    const createResponse = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: 'initial question',
        chipId: 'E521.39',
        sessionMode: 'conversation'
      })
    });
    expect(createResponse.status).toBe(201);
    const created = await json<{ sessionId: string }>(createResponse);

    const sendResponse = await fetch(`${started.baseUrl}/sessions/${created.sessionId}/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ data: '你的工作目录是？', submit: true })
    });

    expect(sendResponse.status).toBe(200);
    expect(started.manager.submit).toHaveBeenCalledWith(
      created.sessionId,
      expect.stringContaining('Selected chip: E521.39')
    );
    const submittedPrompt = (started.manager.submit as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as string;
    expect(submittedPrompt).not.toContain('Configured workspace directory');
    expect(submittedPrompt).not.toContain(join(KB_ROOT, 'E521.39'));
    expect(submittedPrompt).toContain('current working directory');
  });
});
