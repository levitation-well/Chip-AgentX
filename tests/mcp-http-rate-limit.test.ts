import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  initializeBody,
  initializeRawTransport,
  postRpc,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';

describe('remote MCP HTTP rate limits', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('rate limits /mcp/verify failures without exposing key details', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { verifyRateLimitMax: 2, rateLimitWindowMs: 60_000 }
    });
    server = started.server;
    dataDir = started.dataDir;

    const attempts = await Promise.all(
      [1, 2, 3].map(() =>
        fetch(`${started.baseUrl}/mcp/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'not-a-real-key' })
        })
      )
    );
    const limitedBody = await attempts[2]!.json();

    expect(attempts.map((response) => response.status)).toEqual([200, 200, 429]);
    expect(limitedBody).toEqual({ valid: false });
    expect(JSON.stringify(limitedBody)).not.toContain('revoked');
    expect(JSON.stringify(limitedBody)).not.toContain('alice');
    expect(JSON.stringify(started.logs)).not.toContain('not-a-real-key');
    expect(started.logs.some((record) => record.event === 'mcp_rate_limited')).toBe(true);
  });

  it('rate limits repeated /mcp initialize requests by remote IP and key fingerprint', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { rateLimitMax: 1, rateLimitWindowMs: 60_000 }
    });
    server = started.server;
    dataDir = started.dataDir;

    const first = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const second = await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(initializeBody())
    });
    const body = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(body.error.message).toContain('Rate limit');
    expect(JSON.stringify(started.logs)).not.toContain(started.aliceKey.key);
    expect(started.logs.some((record) => JSON.stringify(record).includes('mcp:init'))).toBe(true);
  });

  it('rate limits subsequent /mcp requests for an established transport', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { rateLimitMax: 1, rateLimitWindowMs: 60_000 }
    });
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const sessionId = initialize.headers.get('mcp-session-id')!;

    const first = await postRpc(started.baseUrl, started.aliceKey.key, sessionId);
    const second = await postRpc(started.baseUrl, started.aliceKey.key, sessionId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(started.logs.some((record) => record.event === 'mcp_rate_limited')).toBe(true);
  });
});
