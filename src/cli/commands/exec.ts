/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputError, validateAgentType, resolveCwd } from '../shared.js';

/**
 * Register exec command - single execution mode with blocking wait
 */
export function registerExec(cli: any) {
  // Note: only <...> args belong in the command signature. All options go in .option().
  // Using --cwd <cwd> with a default value so resolveCwd() returns it.
  cli.command('exec <agent> <task>')
    .option('--cwd <cwd>', 'Working directory for the agent', { default: '' })
    .option('--cols <cols>', 'Terminal columns', { default: 200 })
    .option('--rows <rows>', 'Terminal rows', { default: 80 })
    .option('--no-color', 'Disable color output')
    .action(async (agent: string, task: string, options: {
      cwd?: string;
      cols?: number;
      rows?: number;
      noColor?: boolean;
    }) => {
      if (!task) {
        outputError('<task> is required');
      }

      const manager = new SessionManager({ exitOnLastSession: true });
      const agentType = validateAgentType(agent);
      const cwd = resolveCwd(options.cwd);

      // Create session
      const session = await manager.spawn({
        agentType,
        task,
        cwd,
        cols: options.cols,
        rows: options.rows
      });

      // D-10: Progress indicator
      console.log(`Spawned session ${session.id}`);

      // Stream output to stdout (D-08: raw streaming)
      const outputHandler = (_sessionId: string, data: string) => {
        process.stdout.write(data);
      };
      manager.on('output', outputHandler);

      // Wait for completion
      await new Promise<void>((resolve) => {
        const exitHandler = (_sessionId: string, _code: number, _signal: string) => {
          manager.off('output', outputHandler);
          manager.off('exit', exitHandler);
          resolve();
        };
        manager.on('exit', exitHandler);

        // Also poll periodically for sessions that don't emit exit
        const pollInterval = setInterval(async () => {
          const result = await manager.poll(session.id, 100);
          if (result.exited) {
            clearInterval(pollInterval);
            manager.off('output', outputHandler);
            manager.off('exit', exitHandler);
            resolve();
          }
        }, 1000);
      });

      // D-10: Exit indicator
      console.log(`\nSession ${session.id} exited`);

      // Cleanup
      manager.destroy();
      process.exit(0);
    });
}
