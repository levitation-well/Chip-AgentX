import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer, startMcpServer } from '../src/mcp-server.js';

const TOOL_NAMES = [
  'agentx_whoami',
  'agent_spawn',
  'agent_log',
  'agent_send',
  'agent_poll',
  'agent_kill',
  'agent_list'
] as const;

function createFakeManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;

  manager.spawn = vi.fn().mockResolvedValue({
    id: 'session-12345678',
    agentType: 'claude-code',
    status: 'running',
    startedAt: 123,
    cwd: 'D:/workspace',
    task: 'inspect project'
  });
  manager.log = vi.fn();
  manager.tail = vi.fn();
  manager.send = vi.fn();
  manager.submit = vi.fn();
  manager.poll = vi.fn();
  manager.kill = vi.fn();
  manager.list = vi.fn().mockReturnValue([]);

  return manager;
}

function getRegisteredTools(server: unknown) {
  return (server as { _registeredTools: Record<string, {
    description?: string;
    inputSchema?: unknown;
    handler: (input: unknown) => Promise<unknown>;
  }> })
    ._registeredTools;
}

describe('mcp server', () => {
  it('exports factory and stdio starter functions', () => {
    expect(typeof createMcpServer).toBe('function');
    expect(typeof startMcpServer).toBe('function');
  });

  it('creates an MCP server with all agent tools registered', () => {
    const server = createMcpServer({ manager: createFakeManager() as any, auth: { enabled: false } });
    const registeredTools = getRegisteredTools(server);

    expect(server).toBeTruthy();
    expect(Object.keys(registeredTools).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it('returns JSON text content from tool handlers', async () => {
    const manager = createFakeManager();
    const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });
    const registeredTools = getRegisteredTools(server);

    const result = await registeredTools.agent_spawn.handler({
      agentType: 'claude-code',
      task: 'inspect project',
      cwd: 'D:/workspace'
    });

    expect(manager.spawn).toHaveBeenCalled();
    expect(result).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sessionId: 'session-12345678',
            status: 'running',
            agentType: 'claude-code',
            cwd: 'D:/workspace',
            task: 'inspect project',
            startedAt: 123
          })
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('agentx-fp:v1.');
  });

  it('registers agentx_whoami as a no-argument read-only tool with allowedActions', async () => {
    const server = createMcpServer({
      manager: createFakeManager() as any,
      auth: { enabled: false }
    });
    const registeredTools = getRegisteredTools(server);

    expect(registeredTools.agentx_whoami.description).toContain('current MCP key');
    expect((registeredTools.agentx_whoami.inputSchema as any).def?.shape).toEqual({});

    const result = await registeredTools.agentx_whoami.handler({});
    const body = JSON.parse((result as any).content[0].text);

    expect(body).toMatchObject({
      transport: 'stdio',
      auth: { enabled: false },
      permissions: {
        allowedActions: [...TOOL_NAMES],
        cwdExposed: false,
        canDeploy: false
      }
    });
    expect(body.permissions.allowedActions).toContain('agentx_whoami');
    expect(JSON.stringify(body)).not.toContain('agentx-fp:v1.');
  });

  it('keeps agent_log and agent_poll JSON tool results free of fingerprint markers', async () => {
    const manager = createFakeManager();
    manager.log.mockReturnValue({
      output: 'plain MCP output without display-layer decoration',
      truncated: false,
      totalChars: 43,
      offset: 0,
      limit: undefined
    });
    manager.poll.mockResolvedValue({ hasOutput: true, exited: false, exitCode: null });
    const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });
    const registeredTools = getRegisteredTools(server);

    const logResult = await registeredTools.agent_log.handler({ sessionId: 'session-12345678' });
    const pollResult = await registeredTools.agent_poll.handler({ sessionId: 'session-12345678', timeoutMs: 1 });

    expect(JSON.stringify(logResult)).not.toContain('agentx-fp:v1.');
    expect(JSON.stringify(pollResult)).not.toContain('agentx-fp:v1.');
  });

  it('returns sanitized agent_log and exited agent_poll output projections', async () => {
    const manager = createFakeManager();
    manager.log.mockReturnValue({
      output: JSON.stringify({
        type: 'result',
        result: [
          'Final answer: E522.49 keeps LIN_CTRL. Source: public datasheet.',
          'tool_use_id: call_secret',
          'D:\\repo\\chip-agentx\\internal.md',
          '/opt/chip-agentx/datasheets/E522.49/raw.md'
        ].join('\n')
      }),
      truncated: false,
      totalChars: 240,
      offset: 0,
      limit: undefined
    });
    manager.poll.mockResolvedValue({ hasOutput: true, exited: true, exitCode: 0 });
    const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });
    const registeredTools = getRegisteredTools(server);

    const logBody = JSON.parse((await registeredTools.agent_log.handler({ sessionId: 'session-12345678' }) as any).content[0].text);
    const pollBody = JSON.parse((await registeredTools.agent_poll.handler({ sessionId: 'session-12345678', timeoutMs: 1 }) as any).content[0].text);

    for (const body of [logBody, pollBody]) {
      expect(body.output).toBe('Final answer: E522.49 keeps LIN_CTRL. Source: public datasheet.');
      expect(body.result).toBe(body.output);
      expect(body.rawOutputExposed).toBe(false);
      expect(body.outputMeta).toMatchObject({ rawOutputExposed: false, source: 'result' });
      expect(JSON.stringify(body)).not.toContain('tool_use_id');
      expect(JSON.stringify(body)).not.toContain('D:\\repo\\chip-agentx');
      expect(JSON.stringify(body)).not.toContain('/opt/chip-agentx/datasheets');
    }
  });

  it('keeps registration wired to shared schemas and avoids stdout diagnostics', () => {
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

    for (const toolName of TOOL_NAMES) {
      expect(source).toContain(toolName);
    }
    expect(source).toContain('AgentActionSchemas');
    expect(source).toContain('createSessionActions');
    expect(source).toContain('StdioServerTransport');
    expect(source).not.toContain('console.log');
  });

  it('guides Codex through project investigation lifecycle semantics', () => {
    const server = createMcpServer({ manager: createFakeManager() as any, auth: { enabled: false } });
    const registeredTools = getRegisteredTools(server);

    expect(registeredTools.agent_spawn.description).toContain('project investigation');
    expect(registeredTools.agent_poll.description).toContain('Loop');
    expect(registeredTools.agent_poll.description).toContain('exited=true');
    expect(registeredTools.agent_log.description).toContain('tail');
    expect(registeredTools.agent_log.description).toContain('result');
  });

  it('uses a larger output buffer for MCP sessions so investigation summaries survive noisy logs', () => {
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

    expect(source).toContain('const DEFAULT_MCP_MAX_OUTPUT_CHARS = 2_000_000');
    expect(source).toContain('maxOutputChars: DEFAULT_MCP_MAX_OUTPUT_CHARS');
  });

  it('uses product version as the default MCP server version', () => {
    const source = readFileSync(new URL('../src/mcp-server.ts', import.meta.url), 'utf8');

    expect(source).toContain('getProductVersion');
    expect(source).toContain('version: options.version ?? getProductVersion()');
    expect(source).not.toContain("const DEFAULT_MCP_VERSION = '0.1.0'");
  });

  it('keeps default MCP server version anchored to AgentX when launched from a host project cwd', async () => {
    const originalCwd = process.cwd();
    const hostProject = await mkdtemp(path.join(tmpdir(), 'agentx-host-mcp-'));
    await writeFile(path.join(hostProject, 'package.json'), JSON.stringify({ version: '9.9.9-host' }), 'utf8');

    try {
      process.chdir(hostProject);
      const server = createMcpServer({ manager: createFakeManager() as any, auth: { enabled: false } });
      const serverInfo = (server as any).server._serverInfo;

      expect(serverInfo.version).toBe('2.2.45');
      expect(serverInfo.version).not.toBe('9.9.9-host');
    } finally {
      process.chdir(originalCwd);
    }
  });
});
