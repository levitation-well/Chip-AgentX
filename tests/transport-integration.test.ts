import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SessionManager,
  createHttpServer,
  startHttpServer,
  createMcpServer,
  startMcpServer
} from '../src/index.js';

function readSource(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('transport integration', () => {
  it('exports transport helpers from the package root', () => {
    expect(typeof SessionManager).toBe('function');
    expect(typeof createHttpServer).toBe('function');
    expect(typeof startHttpServer).toBe('function');
    expect(typeof createMcpServer).toBe('function');
    expect(typeof startMcpServer).toBe('function');
  });

  it('registers server and mcp CLI commands', () => {
    const cliSource = readSource('src/cli/index.ts');

    expect(cliSource).toContain("import { registerServer } from './commands/server.js'");
    expect(cliSource).toContain("import { registerMcp } from './commands/mcp.js'");
    expect(cliSource).toContain('registerServer(cli)');
    expect(cliSource).toContain('registerMcp(cli)');
  });

  it('keeps MCP CLI stdout clean and server CLI local by default', () => {
    const mcpSource = readSource('src/cli/commands/mcp.ts');
    const serverSource = readSource('src/cli/commands/server.ts');
    const httpServerSource = readSource('src/http-server.ts');

    expect(mcpSource).not.toContain('console.log');
    expect(mcpSource).toContain('console.error');
    expect(serverSource).toContain('127.0.0.1');
    expect(httpServerSource).toContain('LOG_EVENTS.serverStarted');
    expect(httpServerSource).toContain('AgentX server listening');
    expect(httpServerSource).toContain('url: `http://${host}:${boundPort}`');
  });
});
