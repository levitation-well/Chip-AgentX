import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpawnParams, ProcessAdapter } from '../src/types.js';

// Create mock adapter factory
function createMockAdapter() {
  const stateHandlers: Array<(state: any) => void> = [];
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onState: vi.fn((handler: (state: any) => void) => {
      stateHandlers.push(handler);
    }),
    removeDataHandler: vi.fn(),
    removeExitHandler: vi.fn(),
    removeStateHandler: vi.fn(),
    emitState: (state: any) => {
      stateHandlers.forEach((handler) => handler(state));
    },
    pid: 12345
  };
}

// Mock tree-kill to prevent actual process termination
vi.mock('tree-kill', () => ({
  default: vi.fn((_pid: number, _signal: string, callback: () => void) => {
    callback();
  })
}));

// Mock the adapters at module level
vi.mock('../src/adapters/index.js', () => {
  const mockPtyAdapter = createMockAdapter();
  const mockChildAdapter = createMockAdapter();
  mockChildAdapter.pid = 12346;
  (mockChildAdapter as any).claudeSessionId = '00000000-0000-4000-8000-000000000301';
  (mockChildAdapter as any).turnState = 'running';
  (mockChildAdapter as any).turnCount = 1;
  
  return {
    createAdapter: vi.fn((agentType: string) => {
      if (agentType === 'claude-code') {
        return mockChildAdapter;
      }
      return mockPtyAdapter;
    })
  };
});

describe('SessionManager API', () => {
  let SessionManager: any;
  let manager: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/index.js');
    SessionManager = mod.SessionManager;
    manager = new SessionManager();
  });

  afterEach(() => {
    if (manager) {
      manager.destroy();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a SessionManager instance', () => {
      expect(manager).toBeDefined();
      expect(typeof manager.spawn).toBe('function');
      expect(typeof manager.poll).toBe('function');
      expect(typeof manager.log).toBe('function');
      expect(typeof manager.kill).toBe('function');
      expect(typeof manager.list).toBe('function');
    });

    it('should accept custom options', () => {
      const customManager = new SessionManager({
        maxConcurrentSessions: 4,
        noOutputTimeoutMs: 60000
      });
      expect(customManager).toBeDefined();
      customManager.destroy();
    });
  });

  describe('retained output offsets', () => {
    it('maps absolute offsets into the retained tail after truncation', async () => {
      const cappedManager = new SessionManager({ maxOutputChars: 10 });
      const session = await cappedManager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test'
      });

      (cappedManager as any).registry.appendOutput(session.id, '1234567890');
      (cappedManager as any).registry.appendOutput(session.id, 'abcdef');

      expect(cappedManager.log(session.id)).toMatchObject({
        output: '7890abcdef',
        truncated: true,
        totalChars: 16,
        offset: 6
      });
      expect(cappedManager.log(session.id, 10)).toMatchObject({
        output: 'abcdef',
        totalChars: 16,
        offset: 10
      });
      expect(cappedManager.log(session.id, 0)).toMatchObject({
        output: '7890abcdef',
        totalChars: 16,
        offset: 6
      });
      expect(cappedManager.tail(session.id, 4)).toMatchObject({
        output: 'cdef',
        totalChars: 16,
        offset: 12
      });

      cappedManager.destroy();
    });
  });

  describe('spawn', () => {
    it('should create a session with unique ID', async () => {
      const params: SpawnParams = {
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test'
      };

      const session = await manager.spawn(params);
      
      expect(session).toBeDefined();
      expect(session.id).toBeDefined();
      expect(typeof session.id).toBe('string');
      expect(session.agentType).toBe('claude-code');
      expect(session.status).toBe('running');
    });

    it('should create sessions with different agent types', async () => {
      const agentTypes: SpawnParams['agentType'][] = ['claude-code', 'codex', 'opencode', 'pi'];
      
      for (const agentType of agentTypes) {
        const session = await manager.spawn({
          agentType,
          task: `test task for ${agentType}`,
          cwd: '/test'
        });
        expect(session.agentType).toBe(agentType);
        expect(session.status).toBe('running');
        manager.kill(session.id);
      }
    });

    it('should reject invalid agent types', async () => {
      const params = {
        agentType: 'invalid-agent' as any,
        task: 'test'
      };

      await expect(manager.spawn(params)).rejects.toThrow('Unknown agent type');
    });

    it('should enforce max concurrent sessions limit', async () => {
      const limitedManager = new SessionManager({
        maxConcurrentSessions: 1
      });

      await limitedManager.spawn({
        agentType: 'claude-code',
        task: 'task 1',
        cwd: '/test'
      });

      await expect(limitedManager.spawn({
        agentType: 'claude-code',
        task: 'task 2',
        cwd: '/test'
      })).rejects.toThrow('Max concurrent sessions');

      limitedManager.destroy();
    });

    it('should use default cwd when not provided', async () => {
      const session = await manager.spawn({
        agentType: 'claude-code',
        task: 'test task'
      });

      expect(session.cwd).toBeDefined();
      expect(typeof session.cwd).toBe('string');
    });

    it('should set startedAt timestamp', async () => {
      const before = Date.now();
      const session = await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test'
      });
      const after = Date.now();

      expect(session.startedAt).toBeGreaterThanOrEqual(before);
      expect(session.startedAt).toBeLessThanOrEqual(after);
    });

    it('should create claude-code conversation sessions with turn metadata', async () => {
      const session = await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test',
        sessionMode: 'conversation'
      });

      expect(session).toMatchObject({
        sessionMode: 'conversation',
        turnState: 'running',
        turnCount: 1,
        claudeSessionId: '00000000-0000-4000-8000-000000000301'
      });
    });

    it('should reject duplicate caller-supplied session IDs', async () => {
      await manager.spawn({
        sessionId: 'stable-session-id',
        agentType: 'claude-code',
        task: 'first task',
        cwd: '/test'
      });

      await expect(
        manager.spawn({
          sessionId: 'stable-session-id',
          agentType: 'claude-code',
          task: 'second task',
          cwd: '/test'
        })
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    it('should update claude-code conversation turn state without finishing the session', async () => {
      const session = await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test',
        sessionMode: 'conversation'
      });
      const { createAdapter } = await import('../src/adapters/index.js');
      const adapter = (createAdapter as any)('claude-code');

      adapter.emitState({
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: '00000000-0000-4000-8000-000000000301'
      });

      expect(manager.list().find((item: any) => item.id === session.id)).toMatchObject({
        status: 'running',
        sessionMode: 'conversation',
        turnState: 'idle',
        turnCount: 1
      });
    });
  });

  describe('list', () => {
    it('should return all sessions', async () => {
      await manager.spawn({ agentType: 'claude-code', task: 'task 1', cwd: '/test' });
      
      const sessions = manager.list();
      
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
    });

    it('should return empty array when no sessions exist', () => {
      const sessions = manager.list();
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBe(0);
    });

    it('should include session details in list', async () => {
      const created = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });
      
      const sessions = manager.list();
      const found = sessions.find((s: any) => s.id === created.id);
      
      expect(found).toBeDefined();
      expect(found.agentType).toBe('claude-code');
      expect(found.status).toBe('running');
    });
  });

  describe('log', () => {
    it('should return empty log for unknown session', () => {
      const result = manager.log('unknown-session-id');
      
      expect(result.output).toBe('');
      expect(result.totalChars).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.offset).toBe(0);
    });

    it('should return log with offset parameter', () => {
      const result = manager.log('unknown-session-id', 10);
      expect(result.offset).toBe(10);
    });
  });

  describe('poll', () => {
    it('should return exited for unknown session', async () => {
      const result = await manager.poll('unknown-session-id', 100);
      
      expect(result.exited).toBe(true);
      expect(result.hasOutput).toBe(false);
    });

    it('should return poll result within timeout', async () => {
      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });
      
      const result = await manager.poll(session.id, 100);
      
      expect(typeof result.exited).toBe('boolean');
      expect(typeof result.hasOutput).toBe('boolean');
    });
  });

  describe('kill', () => {
    it('should not throw for unknown session', async () => {
      await expect(manager.kill('unknown-session-id')).resolves.not.toThrow();
    });

    it('should handle kill gracefully', async () => {
      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });
      
      await expect(manager.kill(session.id)).resolves.not.toThrow();
    });

    it('treats DELETE of an already-idle conversation as a no-op', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');
      const session = await manager.spawn({
        agentType: 'claude-code',
        task: 'completed turn',
        cwd: '/test',
        sessionMode: 'conversation'
      });
      const adapter = (createAdapter as any).mock.results.at(-1).value;
      adapter.emitState({
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: session.claudeSessionId
      });
      adapter.kill.mockClear();

      await manager.kill(session.id);

      expect(adapter.kill).not.toHaveBeenCalled();
      expect(manager.getSession(session.id)).toMatchObject({
        status: 'running',
        turnState: 'idle',
        turnCount: 1
      });
    });
  });

  describe('send and submit', () => {
    it('should not throw for unknown session', async () => {
      await expect(manager.send('unknown-session-id', 'test')).resolves.not.toThrow();
      await expect(manager.submit('unknown-session-id', 'test')).resolves.not.toThrow();
    });

    it('should send data to session', async () => {
      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });
      
      await expect(manager.send(session.id, 'test data')).resolves.not.toThrow();
    });

    it('should submit data with newline', async () => {
      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });
      
      await expect(manager.submit(session.id, 'test data')).resolves.not.toThrow();
    });
  });

  describe('tail', () => {
    it('should return empty tail for unknown session', () => {
      const result = manager.tail('unknown-session-id', 100);
      
      expect(result.output).toBe('');
      expect(result.totalChars).toBe(0);
    });
  });

  describe('event emission', () => {
    it('should be an EventEmitter', () => {
      expect(typeof manager.on).toBe('function');
      expect(typeof manager.off).toBe('function');
      expect(typeof manager.emit).toBe('function');
    });

    it('should handle output event listener', async () => {
      let outputReceived = false;
      manager.on('output', () => {
        outputReceived = true;
      });

      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });

      expect(typeof session.id).toBe('string');
      
      manager.off('output', () => {
        outputReceived = true;
      });
    });

    it('should handle exit event listener', async () => {
      let exitReceived = false;
      manager.on('exit', () => {
        exitReceived = true;
      });

      const session = await manager.spawn({ 
        agentType: 'claude-code', 
        task: 'test task',
        cwd: '/test'
      });

      expect(typeof session.id).toBe('string');
      
      manager.off('exit', () => {
        exitReceived = true;
      });
    });
  });

  describe('destroy', () => {
    it('should destroy all sessions', async () => {
      await manager.spawn({ agentType: 'claude-code', task: 'task 1', cwd: '/test' });
      await manager.spawn({ agentType: 'claude-code', task: 'task 2', cwd: '/test' });
      
      expect(manager.list().length).toBe(2);
      
      manager.destroy();
      
      expect(manager.list().length).toBe(0);
    });

    it('should not throw when destroying empty manager', () => {
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  describe('trusted systemPrompt propagation', () => {
    it('should pass systemPrompt to the adapter as a direct trusted option', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');

      await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test',
        systemPrompt: 'You are a chip expert'
      });

      const adapter = (createAdapter as any)('claude-code');
      expect(adapter.spawn).toHaveBeenCalledWith(
        '/test',
        {},
        200,
        80,
        'test task',
        { systemPrompt: 'You are a chip expert' }
      );
    });

    it('should leave trusted options empty when systemPrompt is undefined', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');

      await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test'
      });

      const adapter = (createAdapter as any)('claude-code');
      expect(adapter.spawn).toHaveBeenCalledWith(
        '/test',
        {},
        200,
        80,
        'test task',
        {}
      );
    });

    it('should preserve existing env vars while keeping systemPrompt separate', async () => {
      const { createAdapter } = await import('../src/adapters/index.js');

      await manager.spawn({
        agentType: 'claude-code',
        task: 'test task',
        cwd: '/test',
        env: { CUSTOM_VAR: 'value' },
        systemPrompt: 'System prompt here'
      });

      const adapter = (createAdapter as any)('claude-code');
      expect(adapter.spawn).toHaveBeenCalledWith(
        '/test',
        { CUSTOM_VAR: 'value' },
        200,
        80,
        'test task',
        { systemPrompt: 'System prompt here' }
      );
    });
  });
});
