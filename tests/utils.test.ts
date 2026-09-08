import { describe, it, expect } from 'vitest';
import {
  truncateOutput,
  mapExitStatus,
  generateSessionId,
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  DEFAULT_LANG
} from '../src/utils.js';
import type { ProcessSession } from '../src/types.js';

function makeSession(aggregated: string, truncated = false, totalOutputChars?: number): ProcessSession {
  return {
    id: 'test-id',
    agentType: 'claude-code',
    status: 'running',
    startedAt: Date.now(),
    pendingStdout: [],
    aggregated,
    truncated,
    totalOutputChars: totalOutputChars ?? aggregated.length,
    lastOutputAt: Date.now(),
    cwd: '/test',
    task: 'test'
  };
}

describe('truncateOutput', () => {
  it('truncates aggregated output to maxChars keeping the last N characters', () => {
    const session = makeSession('0123456789', false, 10);
    truncateOutput(session, 5);
    expect(session.aggregated).toBe('56789');
    expect(session.truncated).toBe(true);
    expect(session.totalOutputChars).toBe(10);
  });

  it('is a no-op when aggregated length is at or below maxChars', () => {
    const session = makeSession('abc', false, 3);
    truncateOutput(session, 5);
    expect(session.aggregated).toBe('abc');
    expect(session.truncated).toBe(false);
    expect(session.totalOutputChars).toBe(3);
  });

  it('preserves the cumulative totalOutputChars after truncation', () => {
    const longOutput = 'a'.repeat(300);
    const session = makeSession(longOutput, false, 300);
    truncateOutput(session, 200);
    expect(session.aggregated.length).toBe(200);
    expect(session.totalOutputChars).toBe(300);
  });

  it('marks session as truncated when limit is exceeded', () => {
    const session = makeSession('hello world', false, 11);
    truncateOutput(session, 5);
    expect(session.truncated).toBe(true);
  });
});

describe('mapExitStatus', () => {
  it('maps code=0 to status completed', () => {
    const result = mapExitStatus(0, null);
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.exitSignal).toBeUndefined();
  });

  it('maps non-zero code to status failed', () => {
    const result = mapExitStatus(1, null);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('maps non-zero code 127 to status failed', () => {
    const result = mapExitStatus(127, null);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(127);
  });

  it('maps any non-null signal to status killed', () => {
    const result = mapExitStatus(null, 'SIGTERM');
    expect(result.status).toBe('killed');
    expect(result.exitSignal).toBe('SIGTERM');
    expect(result.exitCode).toBeUndefined();
  });

  it('maps SIGKILL signal to status killed', () => {
    const result = mapExitStatus(null, 'SIGKILL');
    expect(result.status).toBe('killed');
    expect(result.exitSignal).toBe('SIGKILL');
  });

  it('treats null code as undefined exitCode', () => {
    const result = mapExitStatus(null, 'SIGINT');
    expect(result.status).toBe('killed');
    expect(result.exitCode).toBeUndefined();
  });
});

describe('generateSessionId', () => {
  it('returns a valid UUID v4 format', () => {
    const id = generateSessionId();
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(id).toMatch(uuidRegex);
  });

  it('returns unique IDs across multiple calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    expect(ids.size).toBe(100);
  });

  it('returns a string of expected length', () => {
    const id = generateSessionId();
    expect(id.length).toBe(36);
  });
});

describe('constants', () => {
  it('DEFAULT_PTY_COLS is 200', () => {
    expect(DEFAULT_PTY_COLS).toBe(200);
  });

  it('DEFAULT_PTY_ROWS is 80', () => {
    expect(DEFAULT_PTY_ROWS).toBe(80);
  });

  it('DEFAULT_LANG is en_US.UTF-8', () => {
    expect(DEFAULT_LANG).toBe('en_US.UTF-8');
  });
});
