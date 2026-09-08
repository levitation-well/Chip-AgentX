/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputJSON } from '../shared.js';

/**
 * Register log command - retrieve session output
 */
export function registerLog(cli: any) {
  cli.command('log <session-id>')
    .option('--tail <n>', 'Show last N characters of output')
    .option('--offset <offset>', 'Start offset for output')
    .option('--limit <limit>', 'Maximum characters to return')
    .option('--no-color', 'Disable color output')
    .action((sessionId: string, options: {
      tail?: number;
      offset?: number;
      limit?: number;
      noColor?: boolean;
    }) => {
      const manager = new SessionManager();

      let result;
      if (options.tail) {
        // D-04: tail operation - get last N characters
        result = manager.tail(sessionId, options.tail);
      } else {
        // D-04: standard log with offset/limit
        result = manager.log(sessionId, options.offset, options.limit);
      }

      // D-09: JSON output format
      outputJSON({
        sessionId,
        output: result.output,
        truncated: result.truncated,
        totalChars: result.totalChars,
        offset: result.offset,
        limit: result.limit
      });

      manager.destroy();
      process.exit(0);
    });
}
