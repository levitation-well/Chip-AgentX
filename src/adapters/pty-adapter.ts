import { EventEmitter } from 'node:events';
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { ProcessAdapter, AgentType } from '../types.js';
import { chunkedWrite, DEFAULT_PTY_COLS, DEFAULT_PTY_ROWS, DEFAULT_LANG } from '../utils.js';

/**
 * PTY Adapter for interactive agents (Codex, OpenCode, Pi)
 * Uses @lydell/node-pty for cross-platform PTY support
 */
export class PtyAdapter extends EventEmitter implements ProcessAdapter {
  private pty?: IPty;
  private readonly dataHandlers: Array<(data: string) => void> = [];
  private readonly exitHandlers: Array<(code: number, signal: string) => void> = [];
  private currentAgentType?: AgentType;

  /**
   * Spawn a PTY process for the given agent
   */
  spawn(
    cwd: string,
    env: Record<string, string>,
    cols: number = DEFAULT_PTY_COLS,
    rows: number = DEFAULT_PTY_ROWS,
    task: string
  ): void {
    const { command, args } = this.getAgentCommand(this.currentAgentType || 'codex');

    this.pty = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        LANG: DEFAULT_LANG,
        ...env
      }
    });

    this.pty.onData((data: string) => {
      this.dataHandlers.forEach((handler) => handler(data));
    });

    this.pty.onExit(({ exitCode, signal }) => {
      const code = typeof exitCode === 'number' ? exitCode : 0;
      const sig = typeof signal === 'string' ? signal : '';
      this.exitHandlers.forEach((handler) => handler(code, sig));
    });

    // Send task as initial input (some agents read from stdin on start)
    if (task) {
      this.pty.write(task);
    }
  }

  /**
   * Set the agent type before spawning
   */
  setAgentType(agentType: AgentType): void {
    this.currentAgentType = agentType;
  }

  /**
   * Write data to PTY stdin using chunked writes
   */
  async write(data: string): Promise<void> {
    if (this.pty) {
      await chunkedWrite(this.pty, data);
    }
  }

  /**
   * Kill the PTY process
   */
  kill(): void {
    if (this.pty) {
      this.pty.kill();
    }
  }

  /**
   * Resize the PTY terminal
   */
  resize(cols: number, rows: number): void {
    if (this.pty) {
      try {
        this.pty.resize(cols, rows);
      } catch {
        // Ignore resize errors after exit (PR #901)
      }
    }
  }

  /**
   * Register a data handler
   */
  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  /**
   * Register an exit handler
   */
  onExit(handler: (code: number, signal: string) => void): void {
    this.exitHandlers.push(handler);
  }

  /**
   * Remove a data handler
   */
  removeDataHandler(handler: (data: string) => void): void {
    const index = this.dataHandlers.indexOf(handler);
    if (index > -1) {
      this.dataHandlers.splice(index, 1);
    }
  }

  /**
   * Remove an exit handler
   */
  removeExitHandler(handler: (code: number, signal: string) => void): void {
    const index = this.exitHandlers.indexOf(handler);
    if (index > -1) {
      this.exitHandlers.splice(index, 1);
    }
  }

  /**
   * Get the process PID
   */
  get pid(): number | undefined {
    return this.pty?.pid;
  }

  /**
   * Get command and arguments for each agent type
   */
  private getAgentCommand(agentType: AgentType): { command: string; args: string[] } {
    switch (agentType) {
      case 'codex':
        return { command: process.platform === 'win32' ? 'codex.cmd' : 'codex', args: [] };
      case 'opencode':
        return { command: process.platform === 'win32' ? 'opencode.cmd' : 'opencode', args: [] };
      case 'pi':
        return { command: 'pi', args: [] };
      default:
        throw new Error(`Unknown agent type: ${agentType}`);
    }
  }
}
