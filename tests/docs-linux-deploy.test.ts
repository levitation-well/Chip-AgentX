import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Linux deployment documentation', () => {
  it('documents public Remote MCP reverse proxy, TLS, limits, and client config', () => {
    const doc = readFileSync('docs/linux-deploy.md', 'utf8');

    expect(doc).toContain('Public Remote MCP');
    expect(doc).toContain('公网 Remote MCP');
    expect(doc).toContain('AGENTX_CORS_ORIGINS');
    expect(doc).toContain('AGENTX_MCP_RATE_LIMIT_MAX');
    expect(doc).toContain('AGENTX_MCP_TRANSPORT_IDLE_TTL_MS');
    expect(doc).toContain('proxy_read_timeout');
    expect(doc).toContain('proxy_buffering off');
    expect(doc).toContain('client_max_body_size');
    expect(doc).toContain('/health');
    expect(doc).toContain('/mcp/verify');
    expect(doc).toContain('Authorization: Bearer <MCP_KEY>');
    expect(doc).toContain('MCP-Session-Id');
    expect(doc).toContain('agentx_whoami');
    expect(doc).toContain('cwdExposed=false');
    expect(doc).toContain('agent_spawn.chipId');
    expect(doc).toContain('https://agentx.example.com/mcp');
    expect(doc).not.toContain('Bearer sk-');
  });

  it('keeps README linked to the production deployment section', () => {
    const readme = readFileSync('README.md', 'utf8');

    expect(readme).toContain('docs/linux-deploy.md');
    expect(readme).toContain('Remote MCP client examples');
    expect(readme).toContain('agentx_whoami');
  });
});
