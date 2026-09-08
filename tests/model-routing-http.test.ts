import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createFakeManager() {
  const spawn = vi.fn(async (params: any) => ({
    id: 'session-routing-1',
    sessionId: 'session-routing-1',
    agentType: params.agentType,
    status: 'running',
    startedAt: Date.now(),
    cwd: params.cwd ?? '',
    task: params.task,
    userId: params.userId,
    sessionMode: params.sessionMode ?? 'oneshot',
    chatMode: params.chatMode,
    modelId: params.modelId,
    claudeModelRole: params.claudeModelRole,
    creditUnits: params.creditUnits,
    totalOutputChars: 0,
    turnState: 'idle',
    turnCount: 0
  }));
  return {
    spawn,
    log: vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 })),
    tail: vi.fn(() => ({ output: '', truncated: false, totalChars: 0, offset: 0 })),
    send: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    poll: vi.fn(async () => ({ hasOutput: false, exited: false })),
    kill: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    listWithPid: vi.fn(() => []),
    on: vi.fn(),
    off: vi.fn()
  };
}

async function startHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-model-routing-'));
  const configFile = join(dataDir, 'model-routing.json');
  const authConfig: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'root',
    adminPasswordHash: await bcrypt.hash('root-secret', 10),
    dataDir
  };
  const userStore = new UserStore(authConfig);
  await userStore.init();
  const admin = await userStore.findByUsername('root');
  if (!admin) throw new Error('admin user missing');
  const jwtService = new JwtService(authConfig);
  const manager = createFakeManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config: authConfig, userStore, jwtService },
    chips: { enabled: false },
    prompts: { enabled: false },
    persistence: { enabled: false },
    modelRouting: { configFile }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    adminToken: jwtService.sign(admin.id, admin.username, admin.role),
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    manager,
    server
  };
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('model routing admin API', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeServer(server);
    server = undefined;
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it('saves mode to Claude role mapping and applies it to the next session spawn', async () => {
    const started = await startHarness();
    server = started.server;
    dataDir = started.dataDir;

    const getDefault = await fetch(`${started.baseUrl}/admin/model-routing`, {
      headers: { authorization: `Bearer ${started.adminToken}` }
    });
    expect(getDefault.status).toBe(200);
    await expect(getDefault.json()).resolves.toMatchObject({
      config: { modeRoleMapping: { standard: 'haiku', enhanced: 'sonnet', multimodal: 'opus' } }
    });

    const put = await fetch(`${started.baseUrl}/admin/model-routing`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${started.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        allowedRoles: ['haiku', 'sonnet', 'opus', 'fable'],
        modeRoleMapping: { standard: 'fable', enhanced: 'sonnet', multimodal: 'opus' }
      })
    });
    expect(put.status).toBe(200);

    const session = await fetch(`${started.baseUrl}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${started.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ agentType: 'claude-code', task: 'route me', chatMode: 'standard' })
    });
    expect(session.status).toBe(201);
    expect(started.manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      chatMode: 'standard',
      modelId: 'fable',
      claudeModelRole: 'fable',
      creditUnits: 50
    }));
  });

  it('rejects unsupported Claude roles', async () => {
    const started = await startHarness();
    server = started.server;
    dataDir = started.dataDir;

    const put = await fetch(`${started.baseUrl}/admin/model-routing`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${started.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        allowedRoles: ['haiku'],
        modeRoleMapping: { standard: 'not-a-role', enhanced: 'sonnet', multimodal: 'opus' }
      })
    });
    expect(put.status).toBe(400);
  });

  it('applies configured routing to no-auth no-persistence JSON-RPC fallback actions', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agentx-model-routing-rpc-'));
    dataDir = tempDir;
    const configFile = join(tempDir, 'model-routing.json');
    await writeFile(
      configFile,
      JSON.stringify({
        allowedRoles: ['haiku', 'sonnet', 'opus', 'fable'],
        modeRoleMapping: { standard: 'fable', enhanced: 'sonnet', multimodal: 'opus' }
      }),
      'utf8'
    );
    const manager = createFakeManager();
    server = createHttpServer({
      manager: manager as any,
      auth: { enabled: false },
      persistence: { enabled: false },
      modelRouting: { configFile }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'route-rpc',
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'route rpc', chatMode: 'standard' }
      })
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.result).toMatchObject({
      modelId: 'fable',
      claudeModelRole: 'fable',
      creditUnits: 50
    });
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      modelId: 'fable',
      claudeModelRole: 'fable'
    }));
  });
});
