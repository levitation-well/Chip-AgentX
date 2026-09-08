import type { IPty } from '@lydell/node-pty';
import type { Writable } from 'node:stream';
import type { ProcessSession, ExitStatusResult } from './types.js';

/**
 * Chunk size for PTY write operations (1KB)
 * Prevents event loop starvation during large writes
 */
const CHUNK_SIZE = 1024;

/**
 * Write data to PTY in chunks with setImmediate() between chunks
 * This prevents blocking the event loop during large writes
 */
export async function chunkedWrite(pty: IPty | Writable, data: string): Promise<void> {
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.slice(i, i + CHUNK_SIZE);

    if (pty instanceof Function || 'write' in pty) {
      (pty as IPty | Writable).write(chunk);
    }

    if (i + CHUNK_SIZE < data.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Truncate output to maxChars, keeping only the most recent characters
 */
export function truncateOutput(session: ProcessSession, maxChars: number): void {
  if (session.aggregated.length > maxChars) {
    const excess = session.aggregated.length - maxChars;
    session.aggregated = session.aggregated.slice(excess);
    session.truncated = true;
  }
}

/**
 * Generate a cryptographically secure session ID using randomUUID
 */
export function generateSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Map exit code and signal to standardized status
 */
export function mapExitStatus(
  code: number | null,
  signal: string | null
): ExitStatusResult {
  if (signal !== null) {
    return {
      status: 'killed',
      exitSignal: signal
    };
  }

  if (code === 0) {
    return {
      status: 'completed',
      exitCode: code ?? undefined
    };
  }

  return {
    status: 'failed',
    exitCode: code ?? undefined
  };
}

/**
 * Default PTY columns (200 - wide enough for AI agent output)
 */
export const DEFAULT_PTY_COLS = 200;

/**
 * Default PTY rows (80 - standard terminal height)
 */
export const DEFAULT_PTY_ROWS = 80;

/**
 * Default LANG environment variable for PTY
 */
export const DEFAULT_LANG = 'en_US.UTF-8';
