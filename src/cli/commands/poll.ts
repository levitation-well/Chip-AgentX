/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputJSON } from '../shared.js';

/**
 * Register poll command - poll session status
 */
export function registerPoll(cli: any) {
  cli.command('poll <session-id>')
    .option('--timeout <ms>', 'Timeout in milliseconds', { default: 5000 })
    .option('--no-color', 'Disable color output')
    .action(async (sessionId: string, options: {
      timeout?: number;
      noColor?: boolean;
    }) => {
      const manager = new SessionManager();
      const timeout = options.timeout ?? 5000;

      const result = await manager.poll(sessionId, timeout);

      // D-09: JSON output format
      outputJSON({
        sessionId,
        hasOutput: result.hasOutput,
        exited: result.exited,
        exitCode: result.exitCode
      });

      manager.destroy();
      process.exit(0);
    });
}
