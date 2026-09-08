import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  connectClient,
  initializeRawTransport,
  parseToolText,
  postRpc,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';

describe('remote MCP key revocation and per-request revalidation', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let extraDirs: string[] = [];

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('revoked key fails on the next /mcp request, cleans transport, and does not kill AgentX session', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'survive transport cleanup', chipId: 'E521.39' }
        })
      );
      const mcpSessionId = connected.transport.sessionId!;
      await started.userStore.removeMcpKey(started.alice.id, started.aliceKey.id);

      const revoked = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);
      const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);

      expect(revoked.status).toBe(401);
      expect(afterCleanup.status).toBe(404);
      expect(started.manager.kill).not.toHaveBeenCalled();
      expect(started.manager.sessions.map((session: any) => session.id)).toContain(spawn.sessionId);
      expect(started.logs.some((record) => record.event === 'mcp_auth_failure')).toBe(true);
      expect(started.logs.some((record) => JSON.stringify(record).includes('auth_revoked'))).toBe(true);
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('wrong user key cannot reuse another user mcp-session-id', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const aliceMcpSessionId = initialize.headers.get('mcp-session-id')!;

    const mismatch = await postRpc(started.baseUrl, started.bobKey.key, aliceMcpSessionId);
    const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, aliceMcpSessionId);

    expect(mismatch.status).toBe(401);
    expect(afterCleanup.status).toBe(404);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => JSON.stringify(record).includes('user_mismatch'))).toBe(true);
  });

  it('same user second key cannot reuse an existing mcp-session-id', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const secondAliceKey = await started.userStore.addMcpKey(started.alice.id, 'alice second remote');
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const aliceMcpSessionId = initialize.headers.get('mcp-session-id')!;

    const mismatch = await postRpc(started.baseUrl, secondAliceKey.key, aliceMcpSessionId);
    const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, aliceMcpSessionId);

    expect(mismatch.status).toBe(401);
    expect(afterCleanup.status).toBe(404);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => JSON.stringify(record).includes('key_mismatch'))).toBe(true);
  });

  it('role changes close an existing mcp-session-id before old permissions are reused', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const aliceMcpSessionId = initialize.headers.get('mcp-session-id')!;
    await started.userStore.updateUser(started.alice.id, { role: 'internal' });

    const changedRole = await postRpc(started.baseUrl, started.aliceKey.key, aliceMcpSessionId);
    const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, aliceMcpSessionId);

    expect(changedRole.status).toBe(401);
    expect(afterCleanup.status).toBe(404);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => JSON.stringify(record).includes('role_changed'))).toBe(true);
  });

  it('missing Authorization is not replaced by mcp-session-id authentication', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const mcpSessionId = initialize.headers.get('mcp-session-id')!;

    const missingBearer = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'mcp-session-id': mcpSessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });

    expect(missingBearer.status).toBe(401);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => record.event === 'mcp_auth_failure')).toBe(true);
  });

  it('disabled user fails on the next /mcp request and only closes the transport', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'survive disabled user cleanup', chipId: 'E521.39' }
        })
      );
      const mcpSessionId = connected.transport.sessionId!;
      await started.userStore.updateUser(started.alice.id, { status: 'disabled' });

      const disabled = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);
      const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);

      expect(disabled.status).toBe(401);
      expect(afterCleanup.status).toBe(404);
      expect(started.manager.kill).not.toHaveBeenCalled();
      expect(started.manager.sessions.map((session: any) => session.id)).toContain(spawn.sessionId);
      expect(started.logs.some((record) => record.event === 'mcp_auth_failure')).toBe(true);
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('expired key fails on the next /mcp request without updating lastUsed', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const mcpSessionId = initialize.headers.get('mcp-session-id')!;
    const before = (await started.userStore.findById(started.alice.id))?.mcpKeys.find(
      (key) => key.id === started.aliceKey.id
    )?.lastUsed;
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      expiresAt: '2000-01-01T00:00:00.000Z'
    });

    const expired = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);
    const after = (await started.userStore.findById(started.alice.id))?.mcpKeys.find(
      (key) => key.id === started.aliceKey.id
    )?.lastUsed;
    const afterCleanup = await postRpc(started.baseUrl, started.aliceKey.key, mcpSessionId);

    expect(expired.status).toBe(401);
    expect(afterCleanup.status).toBe(404);
    expect(after).toBe(before);
    expect(started.manager.kill).not.toHaveBeenCalled();
  });
});

const ALL_MCP_TOOLS = ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill'];

describe('remote MCP per-grant revocation re-verification on log/poll/send (V2)', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;
  let extraDirs: string[] = [];

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
    await Promise.all(extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('denies agent_log/agent_poll/agent_send (read and write) once the chip grant is revoked, without killing the session', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'chip revocation regression', chipId: 'E521.39' }
        })
      );

      await started.userStore.updateUser(started.alice.id, { resourceGrants: { chipIds: [] } });

      const logResult = await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId } });
      const pollResult = await connected.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawn.sessionId } });
      const sendResult = await connected.client.callTool({
        name: 'agent_send',
        arguments: { sessionId: spawn.sessionId, data: 'still here?' }
      });

      for (const result of [logResult, pollResult, sendResult]) {
        expect(result).toMatchObject({ isError: true });
      }
      expect(started.manager.log).not.toHaveBeenCalled();
      expect(started.manager.poll).not.toHaveBeenCalled();
      expect(started.manager.submit).not.toHaveBeenCalled();
      expect(started.manager.send).not.toHaveBeenCalled();
      // Deny must not hard-kill the running process; the no-output timeout reclaims it instead.
      expect(started.manager.kill).not.toHaveBeenCalled();
      expect(started.manager.sessions.map((session: any) => session.id)).toContain(spawn.sessionId);
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('denies agent_log/agent_send once the document grant tied to the session is revoked', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs, { withResources: true });
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], documentIds: ['doc-1'], mcpTools: ALL_MCP_TOOLS }
    });
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      resourceGrants: { chipIds: ['E521.39'], documentIds: ['doc-1'], mcpTools: ALL_MCP_TOOLS }
    });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'document revocation regression', chipId: 'E521.39' }
        })
      );
      // The chip-only spawn path does not persist documentId onto the session; attach it directly
      // so the re-verification path has a document dimension to check, mirroring a scope-session spawn.
      const session = started.manager.sessions.find((candidate: any) => candidate.id === spawn.sessionId);
      session.documentId = 'doc-1';

      await started.userStore.updateUser(started.alice.id, {
        resourceGrants: { chipIds: ['E521.39'], documentIds: [], mcpTools: ALL_MCP_TOOLS }
      });

      const logResult = await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId } });
      const sendResult = await connected.client.callTool({
        name: 'agent_send',
        arguments: { sessionId: spawn.sessionId, data: 'still here?' }
      });

      for (const result of [logResult, sendResult]) {
        expect(result).toMatchObject({ isError: true });
      }
      expect(started.manager.kill).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('denies agent_poll once the scopePreset grant tied to the session is revoked', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs, { withResources: true });
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: { chipIds: ['E521.39'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });
    await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
      resourceGrants: { chipIds: ['E521.39'], scopePresetIds: ['preset-1'], mcpTools: ALL_MCP_TOOLS }
    });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'scope preset revocation regression', chipId: 'E521.39' }
        })
      );
      const session = started.manager.sessions.find((candidate: any) => candidate.id === spawn.sessionId);
      session.scopePresetId = 'preset-1';

      await started.userStore.updateUser(started.alice.id, {
        resourceGrants: { chipIds: ['E521.39'], scopePresetIds: [], mcpTools: ALL_MCP_TOOLS }
      });

      const pollResult = await connected.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawn.sessionId } });

      expect(pollResult).toMatchObject({ isError: true });
      expect(started.manager.kill).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('allows agent_log/agent_poll/agent_send/agent_kill on a dynamic-group scope session for a non-admin user while the group grant remains authorized (V2 x V11 fix)', async () => {
    // Regression for the bug this fix targets: a group-scope agent_spawn (no single
    // chipId/documentId/scopePresetId) stores scopePresetId = 'dynamic-group' on the
    // session. Before the fix, the re-verify path tried to look this up as a real
    // catalog scopePreset, failed to find it, and fell back to an adminOnly-visibility
    // deny — so every follow-up call for a non-admin customer 403'd even though nothing
    // was actually revoked.
    const started = await startGroupScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: {
            agentType: 'claude-code',
            task: 'dynamic group scope regression',
            scope: { mode: 'group', groups: [{ dimension: 'productLine', value: 'Ambient Lighting' }] }
          }
        })
      );

      const session = started.manager.sessions.find((candidate: any) => candidate.id === spawn.sessionId);
      expect(session.scopePresetId).toBe('dynamic-group');
      expect(session.allowedChipIds).toEqual(expect.arrayContaining(['E521.31', 'E521.39']));
      expect(session.chipId).toBeUndefined();

      const logResult = await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId } });
      const pollResult = await connected.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawn.sessionId } });
      const sendResult = await connected.client.callTool({
        name: 'agent_send',
        arguments: { sessionId: spawn.sessionId, data: 'still here?' }
      });
      const killResult = await connected.client.callTool({ name: 'agent_kill', arguments: { sessionId: spawn.sessionId } });

      for (const result of [logResult, pollResult, sendResult, killResult]) {
        expect(result).not.toMatchObject({ isError: true });
      }
      expect(started.manager.log).toHaveBeenCalled();
      expect(started.manager.poll).toHaveBeenCalled();
      expect(started.manager.submit).toHaveBeenCalled();
      expect(started.manager.kill).toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('denies agent_log/agent_poll/agent_send on a dynamic-group scope session once ANY resolved chip grant is revoked (fail closed)', async () => {
    const started = await startGroupScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: {
            agentType: 'claude-code',
            task: 'dynamic group scope revocation regression',
            scope: { mode: 'group', groups: [{ dimension: 'productLine', value: 'Ambient Lighting' }] }
          }
        })
      );
      const session = started.manager.sessions.find((candidate: any) => candidate.id === spawn.sessionId);
      expect(session.allowedChipIds).toEqual(expect.arrayContaining(['E521.31', 'E521.39']));

      // Revoke just ONE of the two chips the dynamic group resolved to — narrow from
      // wildcard to a set that excludes E521.31. The whole dynamic-group session must
      // now be denied (fail closed), proving the fix does not weaken revocation.
      await started.userStore.updateUser(started.alice.id, { resourceGrants: { chipIds: ['E521.39'] } });

      const logResult = await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId } });
      const pollResult = await connected.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawn.sessionId } });
      const sendResult = await connected.client.callTool({
        name: 'agent_send',
        arguments: { sessionId: spawn.sessionId, data: 'still here?' }
      });

      for (const result of [logResult, pollResult, sendResult]) {
        expect(result).toMatchObject({ isError: true });
      }
      expect(started.manager.log).not.toHaveBeenCalled();
      expect(started.manager.poll).not.toHaveBeenCalled();
      expect(started.manager.submit).not.toHaveBeenCalled();
      // Deny must not hard-kill the running process; the no-output timeout reclaims it instead.
      expect(started.manager.kill).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('denies agent_log once the model grant tied to the session is revoked', async () => {
    const started = await startChipScopedMcpHttpTestServer(extraDirs);
    server = started.server;
    dataDir = started.dataDir;
    await started.userStore.updateUser(started.alice.id, { modelGrants: ['haiku'] });
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      const spawn = parseToolText(
        await connected.client.callTool({
          name: 'agent_spawn',
          arguments: { agentType: 'claude-code', task: 'model revocation regression', chipId: 'E521.39' }
        })
      );
      const session = started.manager.sessions.find((candidate: any) => candidate.id === spawn.sessionId);
      session.modelId = 'haiku';

      await started.userStore.updateUser(started.alice.id, { modelGrants: [] });

      const logResult = await connected.client.callTool({ name: 'agent_log', arguments: { sessionId: spawn.sessionId } });

      expect(logResult).toMatchObject({ isError: true });
      expect(started.manager.kill).not.toHaveBeenCalled();
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });
});

async function startChipScopedMcpHttpTestServer(
  extraDirs: string[],
  options: { withResources?: boolean } = {}
) {
  const kbRoot = await mkdtemp(join(tmpdir(), 'agentx-mcp-revocation-kb-'));
  const configDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-revocation-config-'));
  extraDirs.push(kbRoot, configDir);
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
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
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'Revocation regression resource',
            queryHint: 'Use this resource for revocation regression tests',
            workspaceDir: 'E521.39'
          }
        ]
      }
    },
    prompts: { enabled: true, configFile: promptsConfigFile, rolesFile },
    ...(options.withResources
      ? {
          resources: {
            catalog: {
              documents: [
                {
                  documentId: 'doc-1',
                  label: 'Doc 1',
                  visibility: 'customer',
                  status: 'approved',
                  chipIds: ['E521.39']
                }
              ],
              scopePresets: [
                {
                  scopePresetId: 'preset-1',
                  label: 'Preset 1',
                  visibility: 'customer',
                  status: 'approved',
                  chipIds: ['E521.39'],
                  documentIds: ['doc-1']
                }
              ]
            } as never
          }
        }
      : {})
  });
}

/**
 * Two chips sharing a productLine group ("Ambient Lighting"), so a dynamic group-scope
 * agent_spawn (scope: { mode: 'group', groups: [{ dimension: 'productLine', value: ... }] })
 * resolves to BOTH chips and stores scopePresetId = 'dynamic-group' with no chipId —
 * exactly the shape the V2 x V11 re-verify bug fails on.
 */
async function startGroupScopedMcpHttpTestServer(extraDirs: string[]) {
  const kbRoot = await mkdtemp(join(tmpdir(), 'agentx-mcp-group-revocation-kb-'));
  const configDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-group-revocation-config-'));
  extraDirs.push(kbRoot, configDir);
  await mkdir(join(kbRoot, 'E521.31'), { recursive: true });
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.31', 'datasheet.md'), 'E521.31 safe datasheet content', 'utf-8');
  await writeFile(join(kbRoot, 'E521.39', 'datasheet.md'), 'E521.39 safe datasheet content', 'utf-8');
  const promptsBaseDir = join(configDir, 'prompts');
  await mkdir(join(promptsBaseDir, 'roles'), { recursive: true });
  await mkdir(join(promptsBaseDir, 'chips'), { recursive: true });
  const userAccessFile = join(configDir, 'user-chip-access.json');
  const rolesFile = join(configDir, 'roles.json');
  const promptsConfigFile = join(configDir, 'prompts.json');
  await writeFile(userAccessFile, JSON.stringify({ users: {} }, null, 2), 'utf-8');
  await writeFile(join(promptsBaseDir, 'global.md'), 'Global prompt\n', 'utf-8');
  await writeFile(join(promptsBaseDir, 'roles', 'user.md'), 'User prompt\n', 'utf-8');
  await writeFile(join(promptsBaseDir, 'chips', 'E521.31.md'), 'Chip prompt\n', 'utf-8');
  await writeFile(join(promptsBaseDir, 'chips', 'E521.39.md'), 'Chip prompt\n', 'utf-8');
  await writeFile(
    rolesFile,
    JSON.stringify(
      {
        user: { description: 'Default test user', access: { allowedChips: ['*'], injectionPolicy: 'first_turn' } },
        customer: { description: 'Customer', access: { allowedChips: ['*'], injectionPolicy: 'first_turn' } },
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
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.31',
            label: 'E521.31 Chip',
            description: 'Group scope regression resource A',
            queryHint: 'Use this resource for group scope regression tests',
            productLines: ['Ambient Lighting'],
            workspaceDir: 'E521.31'
          },
          {
            id: 'E521.39',
            label: 'E521.39 Chip',
            description: 'Group scope regression resource B',
            queryHint: 'Use this resource for group scope regression tests',
            productLines: ['Ambient Lighting'],
            workspaceDir: 'E521.39'
          }
        ]
      }
    },
    prompts: { enabled: true, configFile: promptsConfigFile, rolesFile }
  });
}
