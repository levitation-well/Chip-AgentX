/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputJSON, validateAgentType, resolveCwd } from '../shared.js';

/**
 * Register spawn command - background creation mode
 */
export function registerSpawn(cli: any) {
  // Note: only <...> args belong in the command signature. All options go in .option().
  // Using --cwd <cwd> with a default value so resolveCwd() returns it.
  cli.command('spawn <agent> <task>')
    .option('--cwd <cwd>', 'Working directory for the agent', { default: '' })
    .option('--background', 'Run in background mode', { default: true })
    .option('--cols <cols>', 'Terminal columns', { default: 200 })
    .option('--rows <rows>', 'Terminal rows', { default: 80 })
    .option('--no-color', 'Disable color output')
    .action(async (agent: string, task: string, options: {
      cwd?: string;
      background?: boolean;
      cols?: number;
      rows?: number;
      noColor?: boolean;
    }) => {
      const manager = new SessionManager();
      const agentType = validateAgentType(agent);
      const cwd = resolveCwd(options.cwd);

      // Create background session
      const session = await manager.spawn({
        agentType,
        task,
        cwd,
        cols: options.cols,
        rows: options.rows
      });

      // D-09: JSON output for structured commands
      outputJSON({
        sessionId: session.id,
        status: session.status,
        agentType: session.agentType,
        cwd: session.cwd,
        startedAt: session.startedAt
      });

      // Cleanup manager but keep session alive
      manager.destroy();
      process.exit(0);
    });
}
