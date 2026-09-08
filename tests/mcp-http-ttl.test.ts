import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  initializeRawTransport,
  postRpc,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('remote MCP transport TTL and concurrency limits', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('cleans up idle TTL transports and does not kill AgentX session', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { transportIdleTtlMs: 1, transportAbsoluteTtlMs: 60_000 }
    });
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const sessionId = initialize.headers.get('mcp-session-id')!;

    await delay(10);
    const expired = await postRpc(started.baseUrl, started.aliceKey.key, sessionId);

    expect(expired.status).toBe(404);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => record.event === 'mcp_transport_expired')).toBe(true);
    expect(started.logs.some((record) => JSON.stringify(record).includes('idle_timeout'))).toBe(true);
  });

  it('cleans up absolute TTL transports and records reason', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { transportIdleTtlMs: 60_000, transportAbsoluteTtlMs: 1 }
    });
    server = started.server;
    dataDir = started.dataDir;
    const initialize = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const sessionId = initialize.headers.get('mcp-session-id')!;

    await delay(10);
    const expired = await postRpc(started.baseUrl, started.aliceKey.key, sessionId);

    expect(expired.status).toBe(404);
    expect(started.manager.kill).not.toHaveBeenCalled();
    expect(started.logs.some((record) => JSON.stringify(record).includes('absolute_ttl'))).toBe(true);
  });

  it('enforces global max transports during initialize', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { maxTransports: 1, maxTransportsPerUser: 10 }
    });
    server = started.server;
    dataDir = started.dataDir;

    const first = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const second = await initializeRawTransport(started.baseUrl, started.bobKey.key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(started.logs.some((record) => JSON.stringify(record).includes('mcp:transport_limit'))).toBe(true);
  });

  it('enforces per user max transports during initialize', async () => {
    const started = await startMcpHttpTestServer({
      mcpHttpSecurity: { maxTransports: 10, maxTransportsPerUser: 1 }
    });
    server = started.server;
    dataDir = started.dataDir;

    const first = await initializeRawTransport(started.baseUrl, started.aliceKey.key);
    const second = await initializeRawTransport(started.baseUrl, started.aliceKey.key);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(started.logs.some((record) => JSON.stringify(record).includes('mcp:transport_limit_per_user'))).toBe(true);
  });
});
