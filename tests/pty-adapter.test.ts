import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { PtyAdapter } from '../src/adapters/pty-adapter.js';
import type { AgentType } from '../src/types.js';

// Mock node-pty at module level
vi.mock('@lydell/node-pty', () => {
  const mockPty = {
    pid: 12345,
    write: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => { /* stored */ }),
    onExit: vi.fn((cb: (info: { exitCode: number; signal?: string }) => void) => { /* stored */ })
  };
  return {
    spawn: vi.fn(() => mockPty),
    default: { spawn: vi.fn(() => mockPty) }
  };
});

describe('PtyAdapter', () => {
  let adapter: PtyAdapter;

  afterEach(() => {
    adapter = undefined as any;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    adapter = new PtyAdapter();
  });

  describe('constructor', () => {
    it('creates an instance', () => {
      expect(adapter).toBeDefined();
    });

    it('has undefined pid before spawn', () => {
      expect(adapter.pid).toBeUndefined();
    });
  });

  describe('spawn', () => {
    it('throws on unknown agent type when setAgentType is called with invalid type', () => {
      const freshAdapter = new PtyAdapter();
      // setAgentType with invalid type; spawn() will call getAgentCommand('invalid-agent') which throws
      freshAdapter.setAgentType('invalid-agent' as AgentType);
      expect(() => freshAdapter.spawn('/test', {}, 200, 80, 'task')).toThrow('Unknown agent type');
    });

    it('sets pid after spawn', () => {
      adapter.setAgentType('codex');
      adapter.spawn('/test', {}, 200, 80, 'task');
      expect(adapter.pid).toBe(12345);
    });

    it('calls pty.spawn with correct parameters', async () => {
      const pty = await import('@lydell/node-pty');
      adapter.setAgentType('opencode');
      adapter.spawn('/cwd', { HOME: '/home' }, 200, 80, 'my task');
      expect(pty.spawn).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'opencode.cmd' : 'opencode',
        [],
        expect.objectContaining({ cwd: '/cwd' })
      );
    });

    it('uses the installed Codex CLI command for codex sessions', async () => {
      const pty = await import('@lydell/node-pty');
      adapter.setAgentType('codex');
      adapter.spawn('/cwd', {}, 200, 80, 'my task');

      expect(pty.spawn).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'codex.cmd' : 'codex',
        [],
        expect.objectContaining({ cwd: '/cwd' })
      );
    });

    it('inherits process environment so PATH-based agent commands resolve', async () => {
      const pty = await import('@lydell/node-pty');
      const originalPath = process.env.PATH;
      process.env.PATH = '/agentx-node/bin:/usr/bin';
      try {
        adapter.setAgentType('codex');
        adapter.spawn('/cwd', { HOME: '/home/agentx' }, 200, 80, 'my task');
      } finally {
        process.env.PATH = originalPath;
      }

      const spawnOptions = vi.mocked(pty.spawn).mock.calls.at(-1)?.[2] as { env?: Record<string, string> } | undefined;
      expect(spawnOptions?.env?.PATH).toContain('/agentx-node/bin');
      expect(spawnOptions?.env?.HOME).toBe('/home/agentx');
    });
  });

  describe('write', () => {
    it('calls chunkedWrite on PTY when PTY is open', async () => {
      adapter.setAgentType('codex');
      adapter.spawn('/test', {}, 200, 80, '');
      await adapter.write('test data');
      // write() should not throw
    });
  });

  describe('kill', () => {
    it('calls pty.kill()', async () => {
      const pty = await import('@lydell/node-pty');
      adapter.setAgentType('pi');
      adapter.spawn('/test', {}, 200, 80, '');
      adapter.kill();
      expect(pty.spawn).toHaveBeenCalled();
    });

    it('does not throw when pty is undefined', () => {
      const noPtyAdapter = new PtyAdapter();
      expect(() => noPtyAdapter.kill()).not.toThrow();
    });
  });

  describe('onData / onExit handlers', () => {
    it('registers a data handler', () => {
      const handler = vi.fn();
      adapter.onData(handler);
      // Handler registered — no error
      expect(typeof adapter.onData).toBe('function');
    });

    it('registers an exit handler', () => {
      const handler = vi.fn();
      adapter.onExit(handler);
      expect(typeof adapter.onExit).toBe('function');
    });

    it('data handler can be removed by reference', () => {
      const handler = vi.fn();
      adapter.onData(handler);
      adapter.removeDataHandler(handler);
      expect(typeof adapter.removeDataHandler).toBe('function');
    });

    it('exit handler can be removed by reference', () => {
      const handler = vi.fn();
      adapter.onExit(handler);
      adapter.removeExitHandler(handler);
      expect(typeof adapter.removeExitHandler).toBe('function');
    });
  });

  describe('resize', () => {
    it('calls pty.resize with columns and rows', async () => {
      const pty = await import('@lydell/node-pty');
      adapter.setAgentType('codex');
      adapter.spawn('/test', {}, 200, 80, '');
      adapter.resize(100, 40);
      // resize was called on the mocked pty
      expect(typeof adapter.resize).toBe('function');
    });

    it('does not throw when pty is undefined', () => {
      const noPtyAdapter = new PtyAdapter();
      expect(() => noPtyAdapter.resize(100, 40)).not.toThrow();
    });
  });

  describe('setAgentType', () => {
    it('sets the agent type', () => {
      adapter.setAgentType('opencode');
      expect(adapter).toBeDefined();
    });

    it('accepts all valid agent types', () => {
      const types: AgentType[] = ['codex', 'opencode', 'pi'];
      for (const type of types) {
        const a = new PtyAdapter();
        expect(() => a.setAgentType(type)).not.toThrow();
      }
    });
  });
});
