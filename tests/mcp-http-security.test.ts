import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  connectClient,
  initializeBody,
  parseToolText,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';
import { resolveMcpHttpSecurityConfig } from '../src/server/mcp-http-security.js';

describe('remote MCP HTTP security config and CORS', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let extraDirs: string[] = [];

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('resolves body, output, poll, and CORS limits from env and options', () => {
    const fromEnv = resolveMcpHttpSecurityConfig(
      {},
      {
        AGENTX_CORS_ORIGINS: 'https://admin.example, https://mcp.example',
        AGENTX_MCP_MAX_BODY_BYTES: '1234',
        AGENTX_MCP_MAX_OUTPUT_CHARS: '2345',
        AGENTX_MCP_MAX_POLL_TIMEOUT_MS: '3456'
      } as NodeJS.ProcessEnv
    );
    const fromOptions = resolveMcpHttpSecurityConfig({ maxOutputChars: 77, corsOrigins: '*' });

    expect(fromEnv.corsOrigins).toEqual(['https://admin.example', 'https://mcp.example']);
    expect(fromEnv.maxBodyBytes).toBe(1234);
    expect(fromEnv.maxOutputChars).toBe(2345);
    expect(fromEnv.maxPollTimeoutMs).toBe(3456);
    expect(fromOptions.maxOutputChars).toBe(77);
    expect(fromOptions.corsOrigins).toBe('*');
  });

  it('rejects disallowed Origin, allows allowlisted Origin, and allows requests without Origin', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { corsOrigins: ['https://allowed.example'] }
    });
    server = started.server;
    dataDir = started.dataDir;

    const disallowed = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Origin: 'https://blocked.example',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(initializeBody())
    });
    const allowed = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Origin: 'https://allowed.example',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(initializeBody())
    });
    const noOrigin = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(initializeBody())
    });

    expect(disallowed.status).toBe(403);
    expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
    expect(allowed.headers.get('vary')).toBe('Origin');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('Mcp-Session-Id');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('MCP-Protocol-Version');
    expect(noOrigin.status).toBe(200);
  });

  it('supports explicit wildcard CORS and custom max body', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { corsOrigins: '*', maxBodyBytes: 16 }
    });
    server = started.server;
    dataDir = started.dataDir;

    const wildcard = await fetch(`${started.baseUrl}/mcp/verify`, {
      method: 'POST',
      headers: { Origin: 'https://any.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: started.aliceKey.key })
    });
    const tooLarge = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(initializeBody())
    });

    expect(wildcard.headers.get('access-control-allow-origin')).toBe('*');
    expect(tooLarge.status).toBe(413);
  });

  it('applies custom max output and poll limits to remote MCP actions', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs, {
      mcpHttpSecurity: { maxOutputChars: 7, maxPollTimeoutMs: 9 }
    });
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'limits', chipId: 'E521.39' }
        })
      );
      await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId, tail: 999 } });
      await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId, limit: 999 } });
      await connected.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawn.sessionId, timeoutMs: 999 } });

      expect(started.manager.tail).toHaveBeenCalledWith(spawn.sessionId, 7);
      expect(started.manager.log).toHaveBeenCalledWith(spawn.sessionId, undefined, 7);
      expect(started.manager.poll).toHaveBeenCalledWith(spawn.sessionId, 9);
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('narrows remote MCP model authorization to the current key grants', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, {
      modelGrants: ['haiku', 'sonnet']
    });
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      modelGrants: ['haiku']
    });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const whoami = parseToolText(await connected.client.callTool({ name: 'agentx_whoami', arguments: {} }));
      expect(whoami.allowedModels.map((model: { id: string }) => model.id)).toEqual(['haiku']);

      const rejected = await connected.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'pro should be blocked', chipId: 'E521.39', model: 'sonnet' }
      });
      expect(rejected).toMatchObject({ isError: true });
      expect((rejected.content[0] as { text: string }).text).toContain('not available to this identity');
      expect(started.manager.spawn).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('rejects remote MCP multimodal requests even when the key has the model grant', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, {
      modelGrants: ['haiku', 'opus']
    });
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      modelGrants: ['haiku', 'opus']
    });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const whoami = parseToolText(await connected.client.callTool({ name: 'agentx_whoami', arguments: {} }));
      expect(whoami.allowedModels.map((model: { id: string }) => model.id)).toEqual(['haiku', 'opus']);
      expect(whoami.searchModes.find((mode: { id: string }) => mode.id === 'multimodal')).toMatchObject({
        selectable: false,
        disabledReasons: expect.arrayContaining([
          expect.objectContaining({ code: 'ENTRY_NOT_SUPPORTED' })
        ])
      });

      const modelBypass = await connected.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'mimo should be blocked', chipId: 'E521.39', model: 'opus' }
      });
      expect(modelBypass).toMatchObject({ isError: true });
      expect((modelBypass.content[0] as { text: string }).text).toContain('does not support image input');

      const modeBypass = await connected.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'mode should be blocked', chipId: 'E521.39', chatMode: 'multimodal' }
      });
      expect(modeBypass).toMatchObject({ isError: true });
      expect((modeBypass.content[0] as { text: string }).text).toContain('does not support image input');
      expect(started.manager.spawn).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('narrows remote MCP chip and tool authorization to the current key grants before spawn', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      resourceGrants: { chipIds: ['E521.39'], mcpTools: ['agentx_whoami'] }
    });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const whoami = parseToolText(await connected.client.callTool({ name: 'agentx_whoami', arguments: {} }));
      expect(whoami.permissions.allowedActions).toEqual(['agentx_whoami']);
      expect(whoami.permissions.resources.map((resource: { id: string }) => resource.id)).toEqual(['E521.39']);

      const rejectedTool = await connected.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'tool should be blocked', chipId: 'E521.39' }
      });
      expect(rejectedTool).toMatchObject({ isError: true });
      expect((rejectedTool.content[0] as { text: string }).text).toContain('not available to this identity');
      expect(started.manager.spawn).not.toHaveBeenCalled();

      await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
        resourceGrants: { chipIds: ['E521.39'], mcpTools: ['agentx_whoami', 'agent_spawn'] }
      });
      const rejectedChip = await connected.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'chip should be blocked', chipId: 'E522.94' }
      });
      expect(rejectedChip).toMatchObject({ isError: true });
      expect((rejectedChip.content[0] as { text: string }).text).toContain('not available to this identity');
      expect(started.manager.spawn).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });
});

async function startChipScopedMcpHttpTestServer(
  extraDirs: string[],
  options: Parameters<typeof startMcpHttpTestServer>[0] = {}
) {
  const kbRoot = await mkdtemp(join(tmpdir(), 'agentx-mcp-security-kb-'));
  const configDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-security-config-'));
  extraDirs.push(kbRoot, configDir);
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await mkdir(join(kbRoot, 'E522.94'), { recursive: true });
  const promptsBaseDir = join(configDir, 'prompts');
  await mkdir(join(promptsBaseDir, 'roles'), { recursive: true });
  await mkdir(join(promptsBaseDir, 'chips'), { recursive: true });
  const userAccessFile = join(configDir, 'user-chip-access.json');
  const rolesFile = join(configDir, 'roles.json');
  const promptsConfigFile = join(configDir, 'prompts.json');
  await writeFile(userAccessFile, JSON.stringify({ users: {} }, null, 2), 'utf-8');
  await writeFile(join(promptsBaseDir, 'global.md'), 'Global prompt\n', 'utf-8');
  await writeFile(join(promptsBaseDir, 'roles', 'user.md'), 'User prompt\n', 'utf-8');
  await writeFile(join(promptsBaseDir, 'chips', 'E521.39.md'), 'Chip prompt\n', 'utf-8');
  await writeFile(
    rolesFile,
    JSON.stringify(
      {
        user: { description: 'Default test user', access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' } },
        customer: { description: 'Customer', access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' } },
        admin: { description: 'Admin', access: { allowedChips: ['*'], injectionPolicy: 'every_turn' } }
      },
      null,
      2
    ),
    'utf-8'
  );
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

  return startMcpHttpTestServer({
    ...options,
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'Security regression resource',
            queryHint: 'Use this resource for security limit tests',
            workspaceDir: 'E521.39'
          },
          {
            id: 'E522.94',
            label: 'E522.94 Chip',
            description: 'Denied security regression resource',
            queryHint: 'Use this resource for negative security tests',
            workspaceDir: 'E522.94'
          }
        ]
      }
    },
    prompts: { enabled: true, configFile: promptsConfigFile, rolesFile }
  });
}
