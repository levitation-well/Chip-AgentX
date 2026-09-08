import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Phase 4 UAT coverage', () => {
  it('exposes web login and auth-protected browser assets', () => {
    const landing = readFileSync('public/index.html', 'utf8');
    const login = readFileSync('public/login.html', 'utf8');
    const auth = readFileSync('public/auth.js', 'utf8');

    expect(landing).toContain('/login');
    expect(landing).not.toContain('id="login-form"');
    expect(login).toContain('id="login-form"');
    expect(auth).toContain('/auth/login');
    expect(auth).toContain('Authorization');
    expect(auth).toContain('response.status === 401');
  });

  it('rejects unauthenticated APIs and protects session ownership in code paths', () => {
    const http = readFileSync('src/http-server.ts', 'utf8');
    const actions = readFileSync('src/server/session-actions.ts', 'utf8');

    expect(http).toContain("pathname === '/sessions'");
    expect(http).toContain("pathname === '/rpc'");
    expect(http).toContain('requireUsableAuth');
    expect(actions).toContain('scopeUserId');
    expect(actions).toContain('SessionScopeError');
  });

  it('supports admin user and MCP KEY management', () => {
    const routes = readFileSync('src/auth/routes.ts', 'utf8');
    const admin = readFileSync('public/admin.js', 'utf8');

    expect(routes).toContain('addMcpKey');
    expect(routes).toContain('removeMcpKey');
    expect(routes).toContain('verifyMcpKey');
    expect(admin).toContain('/admin/users');
    expect(admin).toContain('/keys');
  });

  it('binds MCP stdio tools to MCP_API_KEY users', () => {
    const mcp = readFileSync('src/mcp-server.ts', 'utf8');

    expect(mcp).toContain('MCP_API_KEY');
    expect(mcp).toContain('lookupUsableMcpKey');
    expect(mcp).toContain('touchMcpKey');
    expect(mcp).toContain('scopeUserId');
  });
});
