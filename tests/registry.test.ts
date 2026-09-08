import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProcessRegistry } from '../src/registry.js';
import type { RunningSession, SessionManagerOptions } from '../src/types.js';

function makeRunningSession(overrides: Partial<RunningSession> = {}): RunningSession {
  return {
    id: overrides.id ?? 'session-1',
    agentType: 'claude-code',
    status: 'running',
    startedAt: Date.now(),
    pendingStdout: [],
    aggregated: '',
    truncated: false,
    totalOutputChars: 0,
    lastOutputAt: Date.now(),
    cwd: '/test',
    task: 'test task',
    ...overrides
  };
}

function makeOptions(overrides: Partial<SessionManagerOptions> = {}): SessionManagerOptions {
  return {
    jobTtlMs: overrides.jobTtlMs ?? 60_000,
    maxOutputChars: overrides.maxOutputChars ?? 200_000,
    ...overrides
  };
}

describe('ProcessRegistry', () => {
  let registry: ProcessRegistry;

  afterEach(() => {
    registry?.destroy();
    vi.restoreAllMocks();
  });

  describe('register', () => {
    it('adds session to runningSessions Map', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'reg-1' });
      registry.register(session);
      expect(registry.get('reg-1')).toBe(session);
    });

    it('can register multiple sessions with unique IDs', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      registry.register(makeRunningSession({ id: 'multi-1' }));
      registry.register(makeRunningSession({ id: 'multi-2' }));
      registry.register(makeRunningSession({ id: 'multi-3' }));
      expect(registry.list().length).toBe(3);
    });
  });

  describe('unregister', () => {
    it('removes session from runningSessions Map', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'unreg-1' });
      registry.register(session);
      registry.unregister('unreg-1');
      expect(registry.get('unreg-1')).toBeUndefined();
    });

    it('does nothing for unknown session ID', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(() => registry.unregister('unknown-id')).not.toThrow();
    });
  });

  describe('finish', () => {
    it('moves session from running to finished state', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'finish-1' });
      registry.register(session);
      const finished = registry.finish('finish-1', 'completed', 0);
      expect(finished).toBeDefined();
      expect(finished?.status).toBe('completed');
      expect(registry.get('finish-1')).toBe(finished);
    });

    it('emits exit event with sessionId, code, and signal', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'finish-2' });
      registry.register(session);
      let exitArgs: unknown[] = [];
      registry.on('exit', (...args) => { exitArgs = args; });
      registry.finish('finish-2', 'failed', 1);
      expect(exitArgs).toEqual(['finish-2', 1, '']);
    });

    it('returns undefined for unknown session ID', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(registry.finish('unknown', 'completed')).toBeUndefined();
    });

    it('sets finishedAt timestamp on completed sessions', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const before = Date.now();
      const session = makeRunningSession({ id: 'finish-3' });
      registry.register(session);
      const finished = registry.finish('finish-3', 'completed', 0);
      expect(finished!.finishedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('get', () => {
    it('finds session in running map', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'get-1' });
      registry.register(session);
      expect(registry.get('get-1')).toBe(session);
    });

    it('finds session in finished map', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'get-2' });
      registry.register(session);
      registry.finish('get-2', 'completed', 0);
      expect(registry.get('get-2')?.status).toBe('completed');
    });

    it('returns undefined for unknown ID', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(registry.get('unknown-id')).toBeUndefined();
    });

    it('running session takes precedence over finished with same ID', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const running = makeRunningSession({ id: 'same-id' });
      registry.register(running);
      registry.finish('same-id', 'completed', 0);
      expect(registry.get('same-id')?.status).toBe('completed');
    });
  });

  describe('list', () => {
    it('returns all running and finished sessions', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      registry.register(makeRunningSession({ id: 'list-1' }));
      registry.register(makeRunningSession({ id: 'list-2' }));
      registry.register(makeRunningSession({ id: 'list-3' }));
      registry.finish('list-1', 'completed', 0);
      expect(registry.list().length).toBe(3);
    });

    it('returns empty array when no sessions exist', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(registry.list()).toEqual([]);
    });
  });

  describe('listRunning', () => {
    it('returns only running sessions', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      registry.register(makeRunningSession({ id: 'run-1' }));
      registry.register(makeRunningSession({ id: 'run-2' }));
      registry.register(makeRunningSession({ id: 'run-3' }));
      registry.finish('run-1', 'completed', 0);
      const running = registry.listRunning();
      expect(running.length).toBe(2);
      expect(running.every(s => s.status === 'running')).toBe(true);
    });
  });

  describe('appendOutput', () => {
    it('appends chunk to pendingStdout and aggregated', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'append-1' });
      registry.register(session);
      registry.appendOutput('append-1', 'hello');
      registry.appendOutput('append-1', ' world');
      expect(session.aggregated).toBe('hello world');
      expect(session.pendingStdout).toEqual(['hello', ' world']);
    });

    it('updates lastOutputAt timestamp', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'append-2' });
      registry.register(session);
      const before = Date.now();
      registry.appendOutput('append-2', 'test');
      expect(session.lastOutputAt).toBeGreaterThanOrEqual(before);
    });

    it('emits output event with sessionId and chunk', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const session = makeRunningSession({ id: 'append-3' });
      registry.register(session);
      let outputArgs: unknown[] = [];
      registry.on('output', (...args) => { outputArgs = args; });
      registry.appendOutput('append-3', 'output chunk');
      expect(outputArgs).toEqual(['append-3', 'output chunk']);
    });

    it('calls truncateOutput when aggregated exceeds maxOutputChars', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000, maxOutputChars: 10 }));
      const session = makeRunningSession({ id: 'append-4', aggregated: '1234567890' });
      registry.register(session);
      registry.appendOutput('append-4', '0123456789');
      expect(session.truncated).toBe(true);
      expect(session.aggregated.length).toBeLessThanOrEqual(10);
    });

    it('keeps totalOutputChars cumulative after retained output is truncated', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000, maxOutputChars: 10 }));
      const session = makeRunningSession({ id: 'append-5', aggregated: '1234567890', totalOutputChars: 10 });
      registry.register(session);
      registry.appendOutput('append-5', 'abcdef');
      expect(session.aggregated).toBe('7890abcdef');
      expect(session.totalOutputChars).toBe(16);
    });
  });

  describe('getRunningCount', () => {
    it('returns correct count of running sessions', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(registry.getRunningCount()).toBe(0);
      registry.register(makeRunningSession({ id: 'count-1' }));
      registry.register(makeRunningSession({ id: 'count-2' }));
      expect(registry.getRunningCount()).toBe(2);
      registry.finish('count-1', 'completed', 0);
      expect(registry.getRunningCount()).toBe(1);
    });
  });

  describe('cleanupExpired', () => {
    it('removes finished sessions older than TTL', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 50 })); // 50ms TTL
      const oldSession = makeRunningSession({ id: 'expired-1', startedAt: Date.now() - 200 });
      registry.register(oldSession);
      registry.finish('expired-1', 'completed', 0);
      // Manually set finishedAt to the past
      const finished = registry.get('expired-1') as any;
      finished.finishedAt = Date.now() - 100;
      registry.cleanupExpired();
      expect(registry.get('expired-1')).toBeUndefined();
    });

    it('keeps recent finished sessions within TTL', async () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      registry.register(makeRunningSession({ id: 'recent-1' }));
      registry.finish('recent-1', 'completed', 0);
      registry.cleanupExpired();
      expect(registry.get('recent-1')).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('clears all sessions', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      registry.register(makeRunningSession({ id: 'destroy-1' }));
      registry.register(makeRunningSession({ id: 'destroy-2' }));
      registry.finish('destroy-1', 'completed', 0);
      registry.destroy();
      expect(registry.list()).toEqual([]);
    });

    it('stops the sweeper timer', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      const stopSpy = vi.spyOn(registry, 'stopSweeper');
      registry.destroy();
      expect(stopSpy).toHaveBeenCalled();
    });

    it('can be called safely twice', () => {
      registry = new ProcessRegistry(makeOptions({ jobTtlMs: 600_000 }));
      expect(() => { registry.destroy(); registry.destroy(); }).not.toThrow();
    });
  });
});
