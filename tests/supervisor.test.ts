import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Supervisor } from '../src/supervisor.js';
import type { ProcessAdapter } from '../src/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockAdapter(pid = 12345): any {
  return {
    pid,
    spawn: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    removeDataHandler: vi.fn(),
    removeExitHandler: vi.fn()
  };
}

// Mock tree-kill at module level
vi.mock('tree-kill', () => ({
  default: vi.fn((pid: number, signal: string, cb: (err: Error | null) => void) => {
    cb(null);
  })
}));

describe('Supervisor', () => {
  let supervisor: Supervisor;

  afterEach(() => {
    supervisor?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('register', () => {
    it('adds adapter to internal Map', () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter();
      supervisor.register('reg-1', adapter);
      expect(supervisor.getAdapter('reg-1')).toBe(adapter);
    });

    it('sets a no-output timeout timer', async () => {
      supervisor = new Supervisor(1000);
      const adapter = createMockAdapter();
      supervisor.register('reg-2', adapter);
      await new Promise(r => setTimeout(r, 50));
      // Timer is set — no error means registration succeeded
      expect(supervisor.getAdapter('reg-2')).toBe(adapter);
    });

    it('uses custom timeoutMs when provided', () => {
      supervisor = new Supervisor(5000);
      const adapter = createMockAdapter();
      supervisor.register('reg-3', adapter, 100);
      // If it registers without throwing, custom timeout was accepted
      expect(supervisor.getAdapter('reg-3')).toBe(adapter);
    });
  });

  describe('unregister', () => {
    it('removes adapter from internal Map', () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter();
      supervisor.register('unreg-1', adapter);
      supervisor.unregister('unreg-1');
      expect(supervisor.getAdapter('unreg-1')).toBeUndefined();
    });

    it('clears no-output timeout timer', () => {
      supervisor = new Supervisor(10_000);
      const adapter = createMockAdapter();
      supervisor.register('unreg-2', adapter);
      supervisor.unregister('unreg-2');
      // No error thrown = timer cleared successfully
      expect(supervisor.getAdapter('unreg-2')).toBeUndefined();
    });
  });

  describe('getAdapter', () => {
    it('returns registered adapter', () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter(99999);
      supervisor.register('get-adapter-1', adapter);
      expect(supervisor.getAdapter('get-adapter-1')).toBe(adapter);
    });

    it('returns undefined for unknown session', () => {
      supervisor = new Supervisor();
      expect(supervisor.getAdapter('unknown')).toBeUndefined();
    });
  });

  describe('kill', () => {
    it('calls treeKill with SIGTERM for graceful shutdown', async () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter(54321);
      supervisor.register('kill-1', adapter);
      await supervisor.kill('kill-1', false);
      const treeKill = await import('tree-kill').then(m => m.default);
      expect(treeKill).toHaveBeenCalledWith(54321, 'SIGTERM', expect.any(Function));
    });

    it('calls treeKill with SIGKILL when force=true', async () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter(54322);
      supervisor.register('kill-2', adapter);
      await supervisor.kill('kill-2', true);
      const treeKill = await import('tree-kill').then(m => m.default);
      expect(treeKill).toHaveBeenCalledWith(54322, 'SIGKILL', expect.any(Function));
    });

    it('returns early if adapter not found', async () => {
      supervisor = new Supervisor();
      await expect(supervisor.kill('unknown-kill')).resolves.not.toThrow();
    });

    it('returns early if pid is undefined', async () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter(undefined as any);
      supervisor.register('kill-no-pid', adapter);
      await expect(supervisor.kill('kill-no-pid')).resolves.not.toThrow();
    });
  });

  describe('handleExit', () => {
    it('clears no-output timeout timer', () => {
      supervisor = new Supervisor(30_000);
      const adapter = createMockAdapter();
      supervisor.register('exit-1', adapter);
      supervisor.handleExit('exit-1', 0, '');
      expect(supervisor.getAdapter('exit-1')).toBeUndefined();
    });

    it('removes adapter from internal Map', () => {
      supervisor = new Supervisor();
      const adapter = createMockAdapter();
      supervisor.register('exit-2', adapter);
      supervisor.handleExit('exit-2', 1, 'SIGTERM');
      expect(supervisor.getAdapter('exit-2')).toBeUndefined();
    });

    it('does not throw for unknown sessionId', () => {
      supervisor = new Supervisor();
      expect(() => supervisor.handleExit('unknown-exit', 0, '')).not.toThrow();
    });
  });

  describe('setNoOutputTimeout', () => {
    it('overwrites existing timer', () => {
      supervisor = new Supervisor(10_000);
      const adapter = createMockAdapter();
      supervisor.register('timeout-1', adapter);
      // Should not throw — overwrites existing timer
      supervisor.setNoOutputTimeout('timeout-1', () => {});
      expect(supervisor.getAdapter('timeout-1')).toBe(adapter);
    });

    it('can set timeout for unregistered session', () => {
      supervisor = new Supervisor(10_000);
      expect(() => supervisor.setNoOutputTimeout('orphan', () => {})).not.toThrow();
    });
  });

  describe('clearNoOutputTimeout', () => {
    it('clears existing timer without removing adapter', () => {
      supervisor = new Supervisor(10_000);
      const adapter = createMockAdapter();
      supervisor.register('clear-1', adapter);
      supervisor.clearNoOutputTimeout('clear-1');
      expect(supervisor.getAdapter('clear-1')).toBe(adapter);
    });

    it('does nothing for unknown session', () => {
      supervisor = new Supervisor();
      expect(() => supervisor.clearNoOutputTimeout('unknown-clear')).not.toThrow();
    });
  });

  describe('resetNoOutputTimeout', () => {
    it('re-registers adapter with new timeout', () => {
      supervisor = new Supervisor(5_000);
      const adapter = createMockAdapter();
      supervisor.register('reset-1', adapter);
      // Should overwrite existing timer
      supervisor.resetNoOutputTimeout('reset-1', 1_000);
      expect(supervisor.getAdapter('reset-1')).toBe(adapter);
    });

    it('clears the stale no-output timer when output resets the timeout', async () => {
      vi.useFakeTimers();
      const treeKill = await import('tree-kill').then(m => m.default as any);
      treeKill.mockClear();

      supervisor = new Supervisor(100);
      const adapter = createMockAdapter(12346);
      supervisor.register('reset-2', adapter);

      await vi.advanceTimersByTimeAsync(90);
      supervisor.resetNoOutputTimeout('reset-2', 100);
      await vi.advanceTimersByTimeAsync(20);

      expect(treeKill).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('clears all timers', () => {
      supervisor = new Supervisor(60_000);
      supervisor.register('destroy-1', createMockAdapter());
      supervisor.register('destroy-2', createMockAdapter());
      supervisor.destroy();
      expect(supervisor.getAdapter('destroy-1')).toBeUndefined();
      expect(supervisor.getAdapter('destroy-2')).toBeUndefined();
    });

    it('clears all adapters', () => {
      supervisor = new Supervisor();
      supervisor.register('destroy-3', createMockAdapter());
      supervisor.register('destroy-4', createMockAdapter());
      supervisor.destroy();
      expect(supervisor.getAdapter('destroy-3')).toBeUndefined();
      expect(supervisor.getAdapter('destroy-4')).toBeUndefined();
    });

    it('can be called safely twice', () => {
      supervisor = new Supervisor();
      expect(() => { supervisor.destroy(); supervisor.destroy(); }).not.toThrow();
    });
  });
});
