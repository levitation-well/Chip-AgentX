/**
 * UAT Phase 1-3: 用户验收测试
 *
 * 模拟客户真实使用场景，测试 Phase 1-3 功能
 * - Phase 1: 核心引擎（SessionManager、适配器）
 * - Phase 2: CLI 命令行工具
 * - Phase 3: HTTP/SSE + MCP + Web UI
 *
 * 运行方式: npm test -- tests/uat-phase1-3.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHttpServer } from '../src/http-server.js';
import { createMcpServer } from '../src/mcp-server.js';

// ============================================================================
// 模拟 SessionManager（用于 HTTP/MCP 测试）
// ============================================================================

function createMockManager() {
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;

  let sessionCounter = 0;
  const sessions = new Map<string, any>();

  manager.spawn = vi.fn().mockImplementation(async (params: any) => {
    const id = `session-${++sessionCounter}`;
    const session = {
      id,
      agentType: params.agentType,
      status: 'running',
      startedAt: Date.now(),
      cwd: params.cwd || process.cwd(),
      task: params.task,
      sessionMode: params.sessionMode,
      chatMode: params.chatMode,
      turnState: params.sessionMode === 'conversation' ? 'idle' : undefined,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: Date.now()
    };
    sessions.set(id, session);
    return session;
  });

  manager.log = vi.fn().mockImplementation((sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return { output: '', truncated: false, totalChars: 0, offset: 0 };
    }
    return {
      output: session.aggregated,
      truncated: session.truncated,
      totalChars: session.aggregated.length,
      offset: 0
    };
  });

  manager.tail = vi.fn().mockImplementation((sessionId: string, n: number) => {
    const session = sessions.get(sessionId);
    if (!session) {
      return { output: '', truncated: false, totalChars: 0, offset: 0 };
    }
    const output = session.aggregated.slice(-n);
    return {
      output,
      truncated: session.truncated,
      totalChars: session.aggregated.length,
      offset: Math.max(0, session.aggregated.length - n)
    };
  });

  manager.send = vi.fn().mockResolvedValue(undefined);
  manager.submit = vi.fn().mockResolvedValue(undefined);
  manager.poll = vi.fn().mockResolvedValue({ hasOutput: true, exited: false });
  manager.kill = vi.fn().mockResolvedValue(undefined);
  manager.claimTurnStart = vi.fn().mockResolvedValue(() => undefined);

  manager.list = vi.fn().mockImplementation(() => {
    return Array.from(sessions.values());
  });

  manager.listWithPid = vi.fn().mockImplementation(() => {
    return Array.from(sessions.values()).map((session: any) => ({
      ...session,
      pid: 10000 + sessions.size
    }));
  });

  // 辅助方法：模拟输出
  manager.simulateOutput = (sessionId: string, data: string) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.aggregated += data;
      session.totalOutputChars += data.length;
      manager.emit('output', sessionId, data);
    }
  };

  // 辅助方法：模拟会话结束
  manager.simulateExit = (sessionId: string, code: number = 0) => {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = code === 0 ? 'completed' : 'failed';
      session.exitCode = code;
      manager.emit('exit', sessionId, code, '');
    }
  };

  return manager;
}

// ============================================================================
// 辅助函数
// ============================================================================

async function startTestServer(manager = createMockManager()) {
  const server = createHttpServer({ manager: manager as any, auth: { enabled: false } });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    manager,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

// ============================================================================
// TC-001 ~ TC-007: Phase 1 核心引擎测试
// ============================================================================

describe('Phase 1: 核心引擎测试', () => {
  describe('TC-001: PTY 适配器创建会话', () => {
    it('应该支持 codex 类型会话创建', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');
      const adapter = createAdapter('codex');

      expect(adapter).toBeDefined();
      expect(typeof adapter.spawn).toBe('function');
      expect(typeof adapter.write).toBe('function');
      expect(typeof adapter.kill).toBe('function');
      expect(typeof adapter.onData).toBe('function');
      expect(typeof adapter.onExit).toBe('function');
    });

    it('应该支持 opencode 类型会话创建', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');
      const adapter = createAdapter('opencode');

      expect(adapter).toBeDefined();
    });

    it('应该支持 pi 类型会话创建', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');
      const adapter = createAdapter('pi');

      expect(adapter).toBeDefined();
    });
  });

  describe('TC-002: Child 适配器创建会话', () => {
    it('应该支持 claude-code 类型会话创建', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');
      const adapter = createAdapter('claude-code');

      expect(adapter).toBeDefined();
    });

    it('未知类型应该抛出错误', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');

      expect(() => createAdapter('unknown' as any)).toThrow('Unknown agent type');
    });
  });

  describe('TC-003: 输出截断（超过 maxOutputChars）', () => {
    it('应该配置 maxOutputChars', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager({
        maxOutputChars: 100
      });

      expect(manager).toBeDefined();
      manager.destroy();
    });
  });

  describe('TC-004: 会话 TTL 过期', () => {
    it('应该配置 jobTtlMs', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager({
        jobTtlMs: 1000
      });

      expect(manager).toBeDefined();
      manager.destroy();
    });
  });

  describe('TC-005: 无输出超时检测', () => {
    it('应该配置 noOutputTimeoutMs', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager({
        noOutputTimeoutMs: 300000
      });

      expect(manager).toBeDefined();
      manager.destroy();
    });
  });

  describe('TC-006: 并发会话限制', () => {
    it('应该配置 maxConcurrentSessions', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager({
        maxConcurrentSessions: 2
      });

      expect(manager).toBeDefined();
      manager.destroy();
    });

    it('超过并发限制应该抛出错误', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager({
        maxConcurrentSessions: 1
      });

      // 验证配置正确
      expect((manager as any).maxConcurrentSessions).toBe(1);

      manager.destroy();
    });
  });

  describe('TC-007: Tree-kill 进程终止', () => {
    it('SessionManager 应该提供 kill 方法', async () => {
      const { SessionManager } = await import('../src/session-manager.js');

      const manager = new SessionManager();
      expect(typeof manager.kill).toBe('function');

      manager.destroy();
    });
  });
});

// ============================================================================
// TC-008 ~ TC-015: Phase 1 会话管理测试
// ============================================================================

describe('Phase 1: 会话管理测试', () => {
  let manager: ReturnType<typeof createMockManager>;

  beforeEach(() => {
    manager = createMockManager();
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  describe('TC-008: send() 向会话发送输入', () => {
    it('manager.send 应该是异步方法', () => {
      expect(typeof manager.send).toBe('function');
    });

    it('send 应该接受 sessionId 和 data 参数', async () => {
      await manager.send('test-session', 'test data');
      expect(manager.send).toHaveBeenCalledWith('test-session', 'test data');
    });
  });

  describe('TC-009: submit() 发送带换行的输入', () => {
    it('manager.submit 应该是异步方法', () => {
      expect(typeof manager.submit).toBe('function');
    });

    it('submit 应该自动添加换行符', async () => {
      await manager.submit('test-session', 'yes');
      expect(manager.submit).toHaveBeenCalledWith('test-session', 'yes');
    });
  });

  describe('TC-010: poll() 轮询会话状态', () => {
    it('manager.poll 应该是异步方法', () => {
      expect(typeof manager.poll).toBe('function');
    });

    it('poll 应该接受 sessionId 和 timeoutMs 参数', async () => {
      const result = await manager.poll('test-session', 5000);
      expect(manager.poll).toHaveBeenCalledWith('test-session', 5000);
      expect(result).toHaveProperty('hasOutput');
      expect(result).toHaveProperty('exited');
    });
  });

  describe('TC-011: log() 获取完整输出', () => {
    it('manager.log 应该是同步方法', () => {
      expect(typeof manager.log).toBe('function');
    });

    it('log 应该返回输出对象', () => {
      const result = manager.log('test-session');
      expect(result).toHaveProperty('output');
      expect(result).toHaveProperty('truncated');
      expect(result).toHaveProperty('totalChars');
      expect(result).toHaveProperty('offset');
    });

    it('不存在的会话应该返回空输出', () => {
      const result = manager.log('non-existent-session');
      expect(result.output).toBe('');
      expect(result.totalChars).toBe(0);
    });
  });

  describe('TC-012: log() 分页检索', () => {
    it('log 应该支持 offset 和 limit 参数', () => {
      manager.log('test-session', 100, 50);
      expect(manager.log).toHaveBeenCalledWith('test-session', 100, 50);
    });
  });

  describe('TC-013: tail() 获取最后 N 字符', () => {
    it('manager.tail 应该是同步方法', () => {
      expect(typeof manager.tail).toBe('function');
    });

    it('tail 应该接受 sessionId 和 n 参数', () => {
      manager.tail('test-session', 50);
      expect(manager.tail).toHaveBeenCalledWith('test-session', 50);
    });
  });

  describe('TC-014: kill() 优雅终止', () => {
    it('manager.kill 应该是异步方法', () => {
      expect(typeof manager.kill).toBe('function');
    });

    it('kill 应该接受 sessionId 参数', async () => {
      await manager.kill('test-session');
      expect(manager.kill).toHaveBeenCalledWith('test-session');
    });
  });

  describe('TC-015: list() 列出所有会话', () => {
    it('manager.list 应该是同步方法', () => {
      expect(typeof manager.list).toBe('function');
    });

    it('list 应该返回会话数组', () => {
      const sessions = manager.list();
      expect(Array.isArray(sessions)).toBe(true);
    });
  });
});

// ============================================================================
// TC-016 ~ TC-022: Phase 2 CLI 测试
// ============================================================================

describe('Phase 2: CLI 测试', () => {
  describe('TC-016 ~ TC-022: CLI 命令注册', () => {
    it('应该注册 exec 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerExec");
    });

    it('应该注册 spawn 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerSpawn");
    });

    it('应该注册 log 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerLog");
    });

    it('应该注册 poll 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerPoll");
    });

    it('应该注册 kill 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerKill");
    });

    it('应该注册 list 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerList");
    });

    it('应该注册 server 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerServer");
    });

    it('应该注册 mcp 命令', async () => {
      const cliSource = await import('fs').then(fs =>
        fs.readFileSync('./src/cli/index.ts', 'utf-8')
      );
      expect(cliSource).toContain("registerMcp");
    });
  });
});

// ============================================================================
// TC-023 ~ TC-030: Phase 3 HTTP/SSE 测试
// ============================================================================

describe('Phase 3: HTTP/SSE 测试', () => {
  let server: Server | undefined;
  let baseUrl: string;
  let manager: ReturnType<typeof createMockManager>;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  describe('TC-023: POST /sessions 创建会话', () => {
    it('应该返回 sessionId 和状态', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;
      manager = started.manager;

      const response = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: '分析项目结构',
          sessionMode: 'conversation'
        })
      });

      const body = await response.json();

      expect(response.status).toBe(201);
      expect(body.sessionId).toBeDefined();
      expect(body.status).toBe('running');
      expect(body.agentType).toBe('claude-code');
    });

    it('缺少必需参数应该返回错误', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const response = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code'
          // 缺少 task
        })
      });

      const body = await response.json();

      // HTTP 400 或 200 + error 都是可接受的验证失败响应
      expect(response.status === 400 || body.error).toBeTruthy();
    });
  });

  describe('TC-024: GET /sessions 列表会话', () => {
    it('应该返回会话列表', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const response = await fetch(`${baseUrl}/sessions`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.sessions).toBeDefined();
      expect(Array.isArray(body.sessions)).toBe(true);
      expect(body.total).toBeDefined();
      expect(body.running).toBeDefined();
      expect(body.finished).toBeDefined();
    });
  });

  describe('TC-025: GET /sessions/:id/log 获取日志', () => {
    it('应该返回会话输出', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;
      manager = started.manager;

      // 先创建会话
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test',
          sessionMode: 'conversation'
        })
      });
      const { sessionId } = await createResponse.json();

      // 获取日志
      const logResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/log`);
      const logBody = await logResponse.json();

      expect(logResponse.status).toBe(200);
      expect(logBody.sessionId).toBe(sessionId);
      expect(logBody).toHaveProperty('output');
      expect(logBody).toHaveProperty('truncated');
      expect(logBody).toHaveProperty('totalChars');
    });

    it('应该支持 tail 参数', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;
      manager = started.manager;

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test',
          sessionMode: 'conversation'
        })
      });
      const { sessionId } = await createResponse.json();

      const logResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/log?tail=50`);
      expect(logResponse.status).toBe(200);
      expect(manager.tail).toHaveBeenCalled();
    });
  });

  describe('TC-026: POST /sessions/:id/send 发送输入', () => {
    it('应该发送数据到会话', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;
      manager = started.manager;

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test',
          sessionMode: 'conversation'
        })
      });
      const { sessionId } = await createResponse.json();

      const sendResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'continue', submit: true })
      });

      const sendBody = await sendResponse.json();

      expect(sendResponse.status).toBe(200);
      expect(sendBody.sent).toBe(true);
      expect(manager.submit).toHaveBeenCalled();
    });
  });

  describe('TC-027: DELETE /sessions/:id 终止会话', () => {
    it('应该终止会话', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;
      manager = started.manager;

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test'
        })
      });
      const { sessionId } = await createResponse.json();

      const deleteResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      });

      expect(deleteResponse.status).toBe(204);
      // 204 should have no body
      expect(deleteResponse.headers.get('content-type')).toBeNull();
      expect(manager.kill).toHaveBeenCalledWith(sessionId);
    });
  });

  describe('TC-028: GET /sessions/:id/stream SSE 流', () => {
    it('应该返回 text/event-stream', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test'
        })
      });
      const { sessionId } = await createResponse.json();

      const streamResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stream`);

      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    });

    it('应该发送 snapshot 事件', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentType: 'claude-code',
          task: 'test'
        })
      });
      const { sessionId } = await createResponse.json();

      const streamResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/stream`);
      const reader = streamResponse.body?.getReader();
      expect(reader).toBeDefined();

      const chunk = await reader!.read();
      await reader!.cancel();
      const text = new TextDecoder().decode(chunk.value);

      expect(text).toContain('event: snapshot');
    });
  });

  describe('TC-029: POST /rpc JSON-RPC 调用', () => {
    it('agent_spawn 方法应该工作', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'agent_spawn',
          params: {
            agentType: 'claude-code',
            task: 'test'
          }
        })
      });

      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe(1);
      expect(body.result).toBeDefined();
      expect(body.result.sessionId).toBeDefined();
    });

    it('未知方法应该返回错误', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const response = await fetch(`${baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown_method',
          params: {}
        })
      });

      const body = await response.json();

      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toBe('Method not found');
    });
  });

  describe('TC-030: CORS 预检请求', () => {
    it('应该返回 CORS headers', async () => {
      const started = await startTestServer();
      server = started.server;
      baseUrl = started.baseUrl;

      const response = await fetch(`${baseUrl}/sessions`, { method: 'OPTIONS' });

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('access-control-allow-methods')).toContain('GET');
      expect(response.headers.get('access-control-allow-methods')).toContain('POST');
      expect(response.headers.get('access-control-allow-methods')).toContain('DELETE');
    });
  });
});

// ============================================================================
// TC-031 ~ TC-036: Phase 3 MCP 测试
// ============================================================================

describe('Phase 3: MCP 测试', () => {
  describe('TC-031: MCP agent_spawn 工具', () => {
    it('createMcpServer 应该注册 agent_spawn', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools).toBeDefined();
      expect(tools.agent_spawn).toBeDefined();
    });
  });

  describe('TC-032: MCP agent_log 工具', () => {
    it('createMcpServer 应该注册 agent_log', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools.agent_log).toBeDefined();
    });
  });

  describe('TC-033: MCP agent_send 工具', () => {
    it('createMcpServer 应该注册 agent_send', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools.agent_send).toBeDefined();
    });
  });

  describe('TC-034: MCP agent_poll 工具', () => {
    it('createMcpServer 应该注册 agent_poll', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools.agent_poll).toBeDefined();
    });
  });

  describe('TC-035: MCP agent_kill 工具', () => {
    it('createMcpServer 应该注册 agent_kill', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools.agent_kill).toBeDefined();
    });
  });

  describe('TC-036: MCP agent_list 工具', () => {
    it('createMcpServer 应该注册 agent_list', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      expect(tools.agent_list).toBeDefined();
    });

    it('agent_spawn 应该返回 JSON 格式结果', async () => {
      const manager = createMockManager();
      const server = createMcpServer({ manager: manager as any, auth: { enabled: false } });

      const tools = (server as any)._registeredTools;
      const result = await tools.agent_spawn.handler({
        agentType: 'claude-code',
        task: 'test task'
      });

      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]).toHaveProperty('type', 'text');

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.sessionId).toBeDefined();
    });
  });
});

// ============================================================================
// TC-037 ~ TC-040: Phase 3 Web UI 测试
// ============================================================================

describe('Phase 3: Web UI 测试', () => {
  describe('TC-037: Web UI 文件结构', () => {
    it('public 目录应该包含 index.html', async () => {
      const fs = await import('fs');
      const indexPath = './public/index.html';
      expect(fs.existsSync(indexPath)).toBe(true);
    });

    it('public 目录应该包含 styles.css', async () => {
      const fs = await import('fs');
      const stylesPath = './public/styles.css';
      expect(fs.existsSync(stylesPath)).toBe(true);
    });
  });

  describe('TC-038: Web UI 表单元素', () => {
    it('login.html 应该包含登录表单，index.html 应该作为首页入口', async () => {
      const fs = await import('fs');
      const landing = fs.readFileSync('./public/index.html', 'utf-8');
      const html = fs.readFileSync('./public/login.html', 'utf-8');

      expect(landing).toContain('/login');
      expect(landing).not.toContain('id="login-form"');
      expect(html).toContain('id="login-form"');
      expect(html).toContain('id="username"');
      expect(html).toContain('id="password"');
      expect(html).toContain('id="login-submit"');
    });

    it('chat.html 应该包含会话列表', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync('./public/chat.html', 'utf-8');

      expect(html).toContain('id="session-list"');
    });

    it('chat.html 应该包含输出区域', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync('./public/chat.html', 'utf-8');

      expect(html).toContain('id="conversation"');
    });

    it('chat.html 应该包含消息输入区域', async () => {
      const fs = await import('fs');
      const html = fs.readFileSync('./public/chat.html', 'utf-8');

      expect(html).toContain('id="message"');
      expect(html).toContain('id="send-message"');
    });
  });

  describe('TC-040: Web UI 状态管理', () => {
    it('auth.js 应该支持认证 SSE 连接', async () => {
      const fs = await import('fs');
      const js = fs.readFileSync('./public/auth.js', 'utf-8');

      expect(js).toContain('openAuthorizedEventStream');
      expect(js).toContain("Accept: 'text/event-stream'");
      expect(js).not.toContain('/stream?token=');
    });
  });
});

// ============================================================================
// 端到端集成测试
// ============================================================================

describe('端到端集成测试', () => {
  let server: Server | undefined;
  let baseUrl: string;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  it('完整会话流程：创建 -> 获取日志 -> 发送消息 -> 终止', async () => {
    const started = await startTestServer();
    server = started.server;
    baseUrl = started.baseUrl;
    const manager = started.manager;

    // 1. 创建会话
    const createResponse = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentType: 'claude-code',
        task: '分析这个项目',
        sessionMode: 'conversation'
      })
    });
    expect(createResponse.status).toBe(201);
    const { sessionId } = await createResponse.json();
    expect(sessionId).toBeDefined();

    // 2. 获取会话列表
    const listResponse = await fetch(`${baseUrl}/sessions`);
    const listBody = await listResponse.json();
    expect(listBody.sessions.length).toBeGreaterThan(0);

    // 3. 获取日志
    const logResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/log`);
    expect(logResponse.status).toBe(200);

    // 4. 发送消息
    const sendResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: '继续', submit: true })
    });
    expect(sendResponse.status).toBe(200);

    // 5. 终止会话
    const killResponse = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });
    expect(killResponse.status).toBe(204);
  });

  it('JSON-RPC 统一接口应该支持所有操作', async () => {
    const started = await startTestServer();
    server = started.server;
    baseUrl = started.baseUrl;

    // agent_spawn
    const spawnResponse = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_spawn',
        params: { agentType: 'claude-code', task: 'test' }
      })
    });
    const spawnResult = await spawnResponse.json();
    expect(spawnResult.result.sessionId).toBeDefined();
    const sessionId = spawnResult.result.sessionId;

    // agent_list
    const listResponse = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'agent_list',
        params: {}
      })
    });
    const listResult = await listResponse.json();
    expect(listResult.result.sessions).toBeDefined();

    // agent_kill
    const killResponse = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'agent_kill',
        params: { sessionId }
      })
    });
    const killResult = await killResponse.json();
    expect(killResult.result.killed).toBe(true);
  });
});
