/* eslint-disable @typescript-eslint/no-explicit-any */
import { getAuthConfig } from '../../auth/index.js';
import { startMcpServer } from '../../mcp-server.js';

/**
 * Register mcp command - stdio-only MCP server
 */
export function registerMcp(cli: any) {
  cli.command('mcp', 'Start the AgentX MCP stdio server')
    .action(async () => {
      try {
        const apiKey = process.env.MCP_API_KEY;
        if (!apiKey) {
          console.error(JSON.stringify({ error: 'MCP_API_KEY is required for agentx mcp' }, null, 2));
          process.exit(1);
        }

        await startMcpServer({
          auth: {
            enabled: true,
            apiKey,
            config: getAuthConfig()
          }
        });
      } catch (error) {
        console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
        process.exit(1);
      }
    });
}
