/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputJSON } from '../shared.js';

/**
 * Register kill command - terminate session
 */
export function registerKill(cli: any) {
  cli.command('kill <session-id>')
    .option('--no-color', 'Disable color output')
    .action(async (sessionId: string, _options: {
      noColor?: boolean;
    }) => {
      const manager = new SessionManager();

      await manager.kill(sessionId);

      // D-09: JSON output format
      outputJSON({
        sessionId,
        killed: true
      });

      manager.destroy();
      process.exit(0);
    });
}
