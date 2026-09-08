import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';

function createManager() {
  const sessions: any[] = [];
  return {
    sessions,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: `session-${sessions.length + 1}`,
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: Date.now(),
        cwd: params.cwd ?? process.cwd(),
        task: params.task,
        totalOutputChars: 0,
        chipId: params.chipId,
        documentId: params.documentId,
        scopePresetId: params.scopePresetId,
        allowedChipIds: params.allowedChipIds,
        allowedDocumentIds: params.allowedDocumentIds,
        scopeDescriptor: params.scopeDescriptor,
        scopeWorkspace: params.scopeWorkspace,
        usedSources: params.usedSources,
        sourceCitationSummary: params.sourceCitationSummary,
        modelId: params.modelId,
        creditUnits: params.creditUnits
      };
      sessions.push(session);
      return session;
    }),
    log: vi.fn().mockReturnValue({ output: 'x'.repeat(10), truncated: false, totalChars: 10, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'tail', truncated: false, totalChars: 10, offset: 6 }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    on: vi.fn(),
    off: vi.fn()
  };
}

function createLogger(records: any[]) {
  const record = (level: string, event: string, message: string, context?: { metadata?: unknown; userId?: string }) => {
    const entry = {
      timestamp: '2026-05-09T00:00:00.000Z',
      level,
      event,
      message,
      userId: context?.userId,
      metadata: context?.metadata
    };
    records.push(entry);
    return entry;
  };
  return {
    debug: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('debug', event, message, context)),
    info: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('info', event, message, context)),
    warn: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('warn', event, message, context)),
    error: vi.fn((event: string, message: string, context?: { metadata?: unknown; userId?: string }) => record('error', event, message, context)),
    log: vi.fn()
  };
}

async function startProtocolServer() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentx-mcp-http-protocol-'));
  const kbRoot = join(dataDir, 'kb');
  const userAccessFile = join(dataDir, 'user-chip-access.json');
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.39', 'datasheet.md'), 'safe datasheet', 'utf-8');
  await writeFile(userAccessFile, JSON.stringify({ users: {} }, null, 2), 'utf-8');
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const resourceGrants = {
    brands: ['ELMOS'],
    productLines: ['ELMOS Lighting'],
    chipIds: ['E521.39'],
    documentIds: ['doc-e52139-datasheet'],
    scopePresetIds: ['scope-preset-elmos-lighting'],
    mcpTools: ['agentx_whoami', 'agent_spawn', 'agent_list', 'agent_log', 'agent_poll', 'agent_send', 'agent_kill']
  };
  const user = await userStore.createUser('alice', 'alice-secret', 'customer', { resourceGrants });
  const mcpKey = await userStore.addMcpKey(user.id, 'remote', { resourceGrants });
  const logs: any[] = [];
  const manager = createManager();
  const server = createHttpServer({
    manager: manager as any,
    auth: {
      enabled: true,
      config,
      userStore,
      jwtService: new JwtService(config)
    },
    persistence: { enabled: true, dataDir, fileLogging: false },
    logger: createLogger(logs) as never,
    chips: {
      enabled: true,
      userAccessFile,
      catalog: {
        knowledgeBaseRoot: kbRoot,
        chips: [
          {
            id: 'E521.39',
            label: 'E521.39',
            brand: 'ELMOS',
            productLines: ['ELMOS Lighting'],
            applicationTags: ['Automotive lighting'],
            documentIds: ['doc-e52139-datasheet'],
            workspaceDir: 'E521.39'
          }
        ]
      }
    },
    resources: {
      enabled: true,
      catalog: {
        documents: [
          {
            documentId: 'doc-e52139-datasheet',
            label: 'E521.39 Datasheet',
            visibility: 'customer',
            status: 'approved',
            brands: ['ELMOS'],
            productLines: ['ELMOS Lighting'],
            applicationTags: ['Automotive lighting'],
            chipIds: ['E521.39']
          }
        ],
        scopePresets: [
          {
            scopePresetId: 'scope-preset-elmos-lighting',
            label: 'ELMOS Lighting',
            visibility: 'customer',
            status: 'approved',
            brands: ['ELMOS'],
            productLines: ['ELMOS Lighting'],
            applicationTags: ['Automotive lighting'],
            chipIds: ['E521.39'],
            documentIds: ['doc-e52139-datasheet'],
            requiredGrants: {
              brands: ['ELMOS'],
              productLines: ['ELMOS Lighting'],
              scopePresetIds: ['scope-preset-elmos-lighting']
            }
          }
        ]
      }
    },
    prompts: { enabled: false }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dataDir,
    logs,
    manager,
    mcpKey,
    server
  };
}

async function connectClient(baseUrl: string, key: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } }
  });
  const client = new Client({ name: 'agentx-protocol-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

function parseToolText(result: Awaited<ReturnType<Client['callTool']>>) {
  const text = (result.content[0] as { text: string }).text;
  try {
    return JSON.parse(text) as any;
  } catch {
    throw new Error(`Expected JSON tool result, received: ${text}`);
  }
}

function rpcBody(method = 'tools/list') {
  return {
    jsonrpc: '2.0',
    id: 2,
    method,
    params: {}
  };
}

function initializeBody() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentx-protocol-test', version: '1.0.0' }
    }
  };
}

async function readRpcResponse(response: Response) {
  const text = await response.text();
  if (text.trimStart().startsWith('{')) {
    return JSON.parse(text);
  }
  const payload = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  return JSON.parse(payload);
}

async function initializeRawTransport(baseUrl: string, key: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(initializeBody())
  });
  expect(response.status).toBe(200);
  return response.headers.get('mcp-session-id')!;
}

async function postRpc(baseUrl: string, key: string, body = rpcBody(), sessionId?: string) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {})
    },
    body: JSON.stringify(body)
  });
}

async function closeServer(server: Server | undefined) {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe('remote MCP protocol lifecycle', () => {
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

  it('rejects missing session and wrong session POST requests', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;

    const missingSession = await postRpc(started.baseUrl, started.mcpKey.key);
    const wrongSession = await postRpc(started.baseUrl, started.mcpKey.key, rpcBody(), 'wrong session');

    expect(missingSession.status).toBe(400);
    expect(wrongSession.status).toBe(404);
  });

  it('supports resource discovery requests even when clients probe before using tools', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;
    const sessionId = await initializeRawTransport(started.baseUrl, started.mcpKey.key);

    const resources = await postRpc(started.baseUrl, started.mcpKey.key, rpcBody('resources/list'), sessionId);
    const templates = await postRpc(started.baseUrl, started.mcpKey.key, rpcBody('resources/templates/list'), sessionId);

    expect(resources.status).toBe(200);
    expect(templates.status).toBe(200);
    expect(await readRpcResponse(resources)).toMatchObject({
      result: {
        resources: [
          expect.objectContaining({
            uri: 'agentx://capabilities',
            name: 'agentx-capabilities'
          })
        ]
      }
    });
    expect(await readRpcResponse(templates)).toMatchObject({
      result: { resourceTemplates: [] }
    });
  });

  it('supports GET SSE path and DELETE /mcp cleanup without killing AgentX session', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;
    const rawSessionId = await initializeRawTransport(started.baseUrl, started.mcpKey.key);
    const sse = await fetch(`${started.baseUrl}/mcp`, {
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${started.mcpKey.key}`,
        'mcp-session-id': rawSessionId
      }
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-type')).toContain('text/event-stream');
    await sse.body?.cancel();

    const first = await connectClient(started.baseUrl, started.mcpKey.key);

    try {
      const spawnResult = parseToolText(await first.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'keep running', chipId: 'E521.39' }
      }));
      const sessionId = first.transport.sessionId!;

      const deleted = await fetch(`${started.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${started.mcpKey.key}`,
          'mcp-session-id': sessionId
        }
      });
      expect([200, 202, 204]).toContain(deleted.status);
      expect(started.manager.kill).not.toHaveBeenCalled();

      const reused = await postRpc(started.baseUrl, started.mcpKey.key, rpcBody(), sessionId);
      expect(reused.status).toBe(404);

      const second = await connectClient(started.baseUrl, started.mcpKey.key);
      try {
        await expect(second.client.callTool({
          name: 'agent_log',
          arguments: { sessionId: spawnResult.sessionId }
        })).resolves.toBeTruthy();
      } finally {
        await second.client.close();
      }
    } finally {
      await first.client.close().catch(() => undefined);
    }

    expect(started.logs.some((record) => record.event === 'mcp_transport_close')).toBe(true);
  });

  it('does not expose raw output through remote MCP agent_log or exited agent_poll', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;
    const client = await connectClient(started.baseUrl, started.mcpKey.key);

    try {
      const spawnResult = parseToolText(await client.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'sanitize', chipId: 'E521.39' }
      }));
      started.manager.log.mockReturnValue({
        output: JSON.stringify({
          type: 'result',
          result: [
            'Final answer: E521.39 uses PWM_CTRL. Source: public datasheet.',
            'tool_call: hidden',
            'D:\\repo\\chip-agentx\\internal.md',
            '/opt/chip-agentx/datasheets/E521.39/raw.md'
          ].join('\n')
        }),
        truncated: false,
        totalChars: 220,
        offset: 0
      });
      started.manager.poll.mockResolvedValue({ hasOutput: true, exited: true, exitCode: 0 });

      const logBody = parseToolText(await client.client.callTool({
        name: 'agent_log',
        arguments: { sessionId: spawnResult.sessionId }
      }));
      const pollBody = parseToolText(await client.client.callTool({
        name: 'agent_poll',
        arguments: { sessionId: spawnResult.sessionId, timeoutMs: 1 }
      }));

      for (const body of [logBody, pollBody]) {
        expect(body.output).toBe('Final answer: E521.39 uses PWM_CTRL. Source: public datasheet.');
        expect(body.rawOutputExposed).toBe(false);
        expect(body.outputMeta).toMatchObject({ rawOutputExposed: false, source: 'result' });
        expect(JSON.stringify(body)).not.toContain('tool_call');
        expect(JSON.stringify(body)).not.toContain('D:\\repo\\chip-agentx');
        expect(JSON.stringify(body)).not.toContain('/opt/chip-agentx/datasheets');
      }
    } finally {
      await client.client.close();
    }
  });

  it('spawns Remote MCP scope sessions through copy workspace without exposing paths', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;
    const client = await connectClient(started.baseUrl, started.mcpKey.key);

    try {
      const whoami = parseToolText(await client.client.callTool({ name: 'agentx_whoami', arguments: {} }));
      const scope = whoami.permissions.resources.find((resource: { type: string }) => resource.type === 'scopePreset');
      const spawnResult = parseToolText(await client.client.callTool({
        name: 'agent_spawn',
        arguments: {
          agentType: 'claude-code',
          task: 'scope search',
          scopePresetId: scope.id,
          documentId: 'doc-e52139-datasheet'
        }
      }));
      const serialized = JSON.stringify(spawnResult);

      const spawnParams = started.manager.spawn.mock.calls[0][0];
      expect(spawnParams.cwd).toContain('scope-');
      expect(spawnParams.chipId).toBeUndefined();
      expect(spawnParams).toMatchObject({
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-e52139-datasheet',
        scopeWorkspace: expect.objectContaining({
          mode: 'copy',
          fileCount: 1,
          scopePresetId: 'scope-preset-elmos-lighting'
        })
      });
      expect(spawnResult).toMatchObject({
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-e52139-datasheet',
        scopeWorkspace: expect.objectContaining({ mode: 'copy', fileCount: 1 })
      });
      expect(serialized).not.toMatch(/cwd|workspacePath|sourcePath|internalManifestPath|knowledgeBaseRoot|agentx-mcp-http-protocol|D:\\|\/tmp|\\\\/i);

      started.manager.log.mockReturnValue({
        output: JSON.stringify({ type: 'result', result: 'Final answer. Source: E521.39 Datasheet.' }),
        truncated: false,
        totalChars: 90,
        offset: 0
      });
      const logBody = parseToolText(await client.client.callTool({
        name: 'agent_log',
        arguments: { sessionId: spawnResult.sessionId }
      }));
      expect(logBody.outputMeta.citations).toMatchObject({
        captureKind: 'system_captured_source_seed',
        sourceCount: 1,
        sources: [
          expect.objectContaining({
            documentId: 'doc-e52139-datasheet',
            displayTitle: 'E521.39 Datasheet',
            filename: 'datasheet.md'
          })
        ]
      });
      expect(logBody.outputMeta.citationNotice).toContain('system-captured source seed');
      expect(JSON.stringify(logBody.outputMeta.citations)).not.toMatch(/cwd|workspacePath|sourcePath|internalManifestPath|knowledgeBaseRoot|agentx-mcp-http-protocol|D:\\|\/tmp|\\\\/i);
    } finally {
      await client.client.close();
    }
  });

  it('returns 413 for oversized body and clamps tail, limit, and timeoutMs', async () => {
    const started = await startProtocolServer();
    server = started.server;
    dataDir = started.dataDir;
    const client = await connectClient(started.baseUrl, started.mcpKey.key);

    try {
      const spawnResult = parseToolText(await client.client.callTool({
        name: 'agent_spawn',
        arguments: { agentType: 'claude-code', task: 'limits', chipId: 'E521.39' }
      }));
      await client.client.callTool({ name: 'agent_log', arguments: { sessionId: spawnResult.sessionId, tail: 999999 } });
      await client.client.callTool({ name: 'agent_log', arguments: { sessionId: spawnResult.sessionId, limit: 999999 } });
      await client.client.callTool({ name: 'agent_poll', arguments: { sessionId: spawnResult.sessionId, timeoutMs: 999999 } });

      expect(started.manager.tail).toHaveBeenCalledWith(spawnResult.sessionId, 200000);
      expect(started.manager.log).toHaveBeenCalledWith(spawnResult.sessionId, undefined, 200000);
      expect(started.manager.poll).toHaveBeenCalledWith(spawnResult.sessionId, 30000);
    } finally {
      await client.client.close();
    }

    const tooLarge = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.mcpKey.key}`,
        'Content-Type': 'application/json'
      },
      body: 'x'.repeat(1_048_577)
    });
    expect(tooLarge.status).toBe(413);
  });
});
