/* eslint-disable @typescript-eslint/no-explicit-any */
import { SessionManager } from '../../index.js';
import { outputJSON } from '../shared.js';

/**
 * Register list command - list session status
 */
export function registerList(cli: any) {
  cli.command('list')
    .option('--no-color', 'Disable color output')
    .action((_options: {
      noColor?: boolean;
    }) => {
      const manager = new SessionManager();

      const sessions = manager.listWithPid();

      // D-09: JSON output format
      // D-07: Session status summary (running/finished)
      outputJSON({
        sessions: sessions.map(session => ({
          id: session.id,
          agentType: session.agentType,
          status: session.status,
          cwd: session.cwd,
          task: session.task,
          startedAt: session.startedAt,
          finishedAt: session.finishedAt,
          exitCode: session.exitCode,
          totalOutputChars: session.totalOutputChars,
          pid: session.pid
        })),
        total: sessions.length,
        running: sessions.filter(s => s.status === 'running').length,
        finished: sessions.filter(s => s.status !== 'running').length
      });

      manager.destroy();
      process.exit(0);
    });
}
