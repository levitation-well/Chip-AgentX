import treeKill from 'tree-kill';
import type { ProcessAdapter } from './types.js';

/**
 * Default no-output timeout (5 minutes)
 */
const DEFAULT_NO_OUTPUT_TIMEOUT_MS = 300_000;

/**
 * Graceful shutdown timeout (3 seconds)
 */
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Supervisor configuration options
 */
export interface SupervisorOptions {
  /**
   * If true, exit the process when the last session exits on Windows.
   * Default: false (safer for programmatic use)
   */
  exitOnLastSession?: boolean;
}

/**
 * Supervisor coordinates timeout management and process termination
 * for all session adapters
 */
export class Supervisor {
  private readonly adapters: Map<string, ProcessAdapter> = new Map();
  private readonly timers: Map<string, NodeJS.Timeout> = new Map();
  private readonly noOutputTimeoutMs: number;
  private readonly exitOnLastSession: boolean;

  constructor(noOutputTimeoutMs: number = DEFAULT_NO_OUTPUT_TIMEOUT_MS, options: SupervisorOptions = {}) {
    this.noOutputTimeoutMs = noOutputTimeoutMs;
    this.exitOnLastSession = options.exitOnLastSession ?? false;
  }

  /**
   * Register a session with the supervisor
   */
  register(sessionId: string, adapter: ProcessAdapter, timeoutMs?: number): void {
    this.clearNoOutputTimeout(sessionId);
    this.adapters.set(sessionId, adapter);

    // Set up no-output timeout
    const timeout = timeoutMs ?? this.noOutputTimeoutMs;
    const timer = setTimeout(() => {
      this.handleNoOutputTimeout(sessionId);
    }, timeout);
    this.timers.set(sessionId, timer);
  }

  /**
   * Unregister a session from the supervisor
   */
  unregister(sessionId: string): void {
    this.adapters.delete(sessionId);
    this.clearNoOutputTimeout(sessionId);
  }

  /**
   * Get an adapter by session ID
   */
  getAdapter(sessionId: string): ProcessAdapter | undefined {
    return this.adapters.get(sessionId);
  }

  /**
   * Kill a session with graceful shutdown (SIGTERM then SIGKILL)
   */
  async kill(sessionId: string, force: boolean = false): Promise<void> {
    const adapter = this.adapters.get(sessionId);
    if (!adapter) {
      return;
    }

    const pid = adapter.pid;
    if (pid === undefined) {
      return;
    }

    if (force) {
      // Force kill with SIGKILL
      await this.treeKill(pid, 'SIGKILL');
    } else {
      // Graceful shutdown with SIGTERM
      await this.treeKill(pid, 'SIGTERM');

      // Wait for graceful shutdown, then force kill if still alive
      await this.waitForProcess(pid, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      // Check if process is still alive
      try {
        await this.treeKill(pid, 'SIGKILL');
      } catch {
        // Process may have already exited
      }
    }
  }

  /**
   * Handle session exit
   */
  handleExit(sessionId: string, _code: number, _signal: string): void {
    this.clearNoOutputTimeout(sessionId);
    this.adapters.delete(sessionId);

    // Windows PTY exit workaround (CORE-06)
    // After PTY kill on Windows, we may need to explicitly exit
    // Only exit if explicitly configured (default: false for SDK safety)
    if (process.platform === 'win32' && this.exitOnLastSession) {
      // Check if this is the last session
      if (this.adapters.size === 0) {
        // Give time for cleanup, then exit if needed
        setTimeout(() => {
          if (this.adapters.size === 0) {
            process.exit(0);
          }
        }, 100);
      }
    }
  }

  /**
   * Set a no-output timeout callback
   */
  setNoOutputTimeout(sessionId: string, callback: () => void): void {
    this.clearNoOutputTimeout(sessionId);
    const timer = setTimeout(callback, this.noOutputTimeoutMs);
    this.timers.set(sessionId, timer);
  }

  /**
   * Clear a no-output timeout
   */
  clearNoOutputTimeout(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(sessionId);
    }
  }

  /**
   * Reset a no-output timeout (called when output is received)
   */
  resetNoOutputTimeout(sessionId: string, timeoutMs?: number): void {
    const adapter = this.adapters.get(sessionId);
    if (adapter) {
      this.register(sessionId, adapter, timeoutMs);
    }
  }

  /**
   * Tree-kill wrapper with promise-based API
   */
  private treeKill(pid: number, signal: string): Promise<void> {
    return new Promise((resolve, reject) => {
      treeKill(pid, signal, (err) => {
        if (err) {
          // ESRCH means process already exited - not an error
          const error = err as NodeJS.ErrnoException;
          if (error.code === 'ESRCH') {
            resolve();
            return;
          }
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Wait for a process to exit within a timeout
   */
  private waitForProcess(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();

      const check = () => {
        try {
          // On Windows, we use tasklist to check if process exists
          if (process.platform === 'win32') {
            // For simplicity, just wait the full timeout
            if (Date.now() - start >= timeoutMs) {
              resolve(false); // Process still alive
              return;
            }
            setTimeout(check, 100);
          } else {
            // On Unix, check /proc
            try {
              process.kill(pid, 0); // Signal 0 just checks if process exists
              if (Date.now() - start >= timeoutMs) {
                resolve(false);
                return;
              }
              setTimeout(check, 100);
            } catch {
              // Process exited
              resolve(true);
            }
          }
        } catch {
          // Process exited
          resolve(true);
        }
      };

      check();
    });
  }

  /**
   * Handle no-output timeout
   */
  private handleNoOutputTimeout(sessionId: string): void {
    const adapter = this.adapters.get(sessionId);
    if (adapter) {
      // Kill session due to no output timeout
      this.kill(sessionId, false).catch((err) => {
        console.error(`Failed to kill session ${sessionId} due to timeout:`, err);
      });
    }
    this.timers.delete(sessionId);
  }

  /**
   * Destroy the supervisor and clear all timers
   */
  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.adapters.clear();
  }
}
