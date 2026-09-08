import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('CLI auth startup experience', () => {
  it('documents and implements server auth preflight and no-auth escape hatch', () => {
    const source = readFileSync('src/cli/commands/server.ts', 'utf8');

    expect(source).toContain('--no-auth');
    expect(source).toContain('getAuthConfig');
    expect(source).toContain('.env.example');
    expect(source).toContain('enabled: false');
    expect(source).toContain("path.resolve(process.cwd(), 'config', 'roles.json')");
    expect(source).toContain('rolesFile');
    expect(source).toContain('prompts: { enabled: true, rolesFile }');
  });

  it('refuses MCP startup without MCP_API_KEY on stderr', () => {
    const source = readFileSync('src/cli/commands/mcp.ts', 'utf8');

    expect(source).toContain('MCP_API_KEY');
    expect(source).toContain('console.error');
    expect(source).toContain('startMcpServer({');
  });
});
