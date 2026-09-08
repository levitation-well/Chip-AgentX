/* eslint-disable @typescript-eslint/no-explicit-any */
import cac from 'cac';
import { registerExec } from './commands/exec.js';
import { registerSpawn } from './commands/spawn.js';
import { registerLog } from './commands/log.js';
import { registerPoll } from './commands/poll.js';
import { registerKill } from './commands/kill.js';
import { registerList } from './commands/list.js';
import { registerServer } from './commands/server.js';
import { registerMcp } from './commands/mcp.js';
import { registerFingerprint } from './commands/fingerprint.js';
import { registerUser } from './commands/user.js';
import { registerAdmin } from './commands/admin.js';
import { outputError, outputHelp } from './shared.js';
import { getProductVersion } from '../product/index.js';

/**
 * Main CLI entry point
 */
export function main() {
  const cli: any = cac('agentx');

  // Global options
  cli.option('--no-color', 'Disable color output');

  // Register commands
  registerExec(cli);
  registerSpawn(cli);
  registerLog(cli);
  registerPoll(cli);
  registerKill(cli);
  registerList(cli);
  registerServer(cli);
  registerMcp(cli);
  registerFingerprint(cli);
  registerUser(cli);
  registerAdmin(cli);

  // Handle version
  cli.version(getProductVersion());

  // Handle help - use console.log (via outputHelp) instead of cac's default
  // console.info so stdout can be captured in tests and redirected on Windows PowerShell.
  cli.help((sections: any[]) => {
    outputHelp(sections.map((s: any) => s.title ? `${s.title}:\n${s.body}` : s.body).join('\n\n'));
  });

  // Parse and run
  try {
    cli.parse();
  } catch (err) {
    outputError(err instanceof Error ? err.message : String(err));
  }
}

// Run if this is the main module
main();
