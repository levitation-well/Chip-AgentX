import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp-server.js';
import { UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function getRegisteredTools(server: unknown) {
  return (server as { _registeredTools: Record<string, {
    handler: (input: unknown) => Promise<unknown>;
  }> })._registeredTools;
}

function createFakeManager() {
  return {
    spawn: vi.fn().mockResolvedValue({
      id: 'session-123',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 1,
      cwd: 'D:/workspace',
      task: 'hello',
      userId: 'user-a'
    }),
    log: vi.fn(),
    tail: vi.fn(),
    send: vi.fn(),
    submit: vi.fn(),
    poll: vi.fn(),
    kill: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    listWithPid: vi.fn().mockReturnValue([])
  };
}

async function createStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-auth-'));
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const user = await userStore.createUser('alice', 'alice-secret');
  const mcpKey = await userStore.addMcpKey(user.id, 'stdio');
  return { dataDir, mcpKey, user, userStore };
}

describe('MCP KEY authentication', () => {
  const dataDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('keeps MCP tools usable when auth is explicitly disabled', async () => {
    const manager = createFakeManager();
    const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });
    const tools = getRegisteredTools(server);

    await tools.agent_spawn.handler({ agentType: 'claude-code', task: 'hello' });

    expect(manager.spawn).toHaveBeenCalled();
  });

  it('reports stdio whoami without forging identity when auth is disabled', async () => {
    const manager = createFakeManager();
    const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });
    const tools = getRegisteredTools(server);

    const result = await tools.agentx_whoami.handler({}) as any;
    const body = JSON.parse(result.content[0].text);

    expect(body).toMatchObject({
      transport: 'stdio',
      auth: { enabled: false },
      user: null,
      mcp: { authenticated: false },
      permissions: { cwdExposed: false, canDeploy: false }
    });
    expect(JSON.stringify(body)).not.toContain('MCP_API_KEY');
  });

  it('allows tools with a valid MCP API key and binds sessions to that user', async () => {
    const manager = createFakeManager();
    const { dataDir, mcpKey, user, userStore } = await createStore();
    dataDirs.push(dataDir);
    const server = createMcpServer({
      manager: manager as any,
      auth: { enabled: true, apiKey: mcpKey.key, userStore }
    });
    const tools = getRegisteredTools(server);

    await tools.agent_spawn.handler({ agentType: 'claude-code', task: 'hello' });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ userId: user.id }));
  });

  it('reports stdio whoami for a valid MCP API key without exposing the key', async () => {
    const manager = createFakeManager();
    const { dataDir, mcpKey, user, userStore } = await createStore();
    dataDirs.push(dataDir);
    const server = createMcpServer({
      manager: manager as any,
      auth: { enabled: true, apiKey: mcpKey.key, userStore }
    });
    const tools = getRegisteredTools(server);

    const result = await tools.agentx_whoami.handler({}) as any;
    const body = JSON.parse(result.content[0].text);

    expect(body).toMatchObject({
      transport: 'stdio',
      auth: { enabled: true },
      user: { id: user.id, username: user.username, role: user.role },
      mcp: { authenticated: true, keyId: mcpKey.id },
      permissions: { cwdExposed: false, canDeploy: false }
    });
    expect(JSON.stringify(body)).not.toContain(mcpKey.key);
  });

  it('returns an auth error for invalid keys without creating sessions', async () => {
    const manager = createFakeManager();
    const { dataDir, userStore } = await createStore();
    dataDirs.push(dataDir);
    const server = createMcpServer({
      manager: manager as any,
      auth: { enabled: true, apiKey: 'invalid-key', userStore }
    });
    const tools = getRegisteredTools(server);

    const result = await tools.agent_spawn.handler({ agentType: 'claude-code', task: 'hello' }) as any;

    expect(manager.spawn).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Unauthorized');
  });

  it('returns unauthorized stdio whoami for invalid keys without creating sessions', async () => {
    const manager = createFakeManager();
    const { dataDir, userStore } = await createStore();
    dataDirs.push(dataDir);
    const server = createMcpServer({
      manager: manager as any,
      auth: { enabled: true, apiKey: 'invalid-key', userStore }
    });
    const tools = getRegisteredTools(server);

    const result = await tools.agentx_whoami.handler({}) as any;

    expect(manager.spawn).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain('Unauthorized');
  });

  it('rechecks stdio MCP user/key lifecycle on each call', async () => {
    const manager = createFakeManager();
    const { dataDir, mcpKey, user, userStore } = await createStore();
    dataDirs.push(dataDir);
    const server = createMcpServer({
      manager: manager as any,
      auth: { enabled: true, apiKey: mcpKey.key, userStore }
    });
    const tools = getRegisteredTools(server);

    await tools.agent_spawn.handler({ agentType: 'claude-code', task: 'before disable' });
    await userStore.updateUser(user.id, { status: 'disabled' });
    const disabledResult = await tools.agent_spawn.handler({ agentType: 'claude-code', task: 'after disable' }) as any;
    await userStore.updateUser(user.id, { status: 'active' });
    await userStore.updateMcpKey(user.id, mcpKey.id, { expiresAt: '2000-01-01T00:00:00.000Z' });
    const expiredWhoami = await tools.agentx_whoami.handler({}) as any;

    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(disabledResult.content[0].text).toContain('Unauthorized');
    expect(expiredWhoami.content[0].text).toContain('Unauthorized');
    expect(JSON.stringify(expiredWhoami)).not.toContain(mcpKey.key);
  });
});
