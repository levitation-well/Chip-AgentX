import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  connectClient,
  initializeRawTransport,
  postRpc,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';

describe('remote MCP security logging', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('logs initialize, mcp_tool_call, mcp_auth_failure, and close events with diagnostic fields', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const connected = await connectClient(started.baseUrl, started.aliceKey.key);

    try {
      await connected.client.listTools();
      await started.userStore.removeMcpKey(started.alice.id, started.aliceKey.id);
      await postRpc(started.baseUrl, started.aliceKey.key, connected.transport.sessionId!);

      const serialized = JSON.stringify(started.logs);
      expect(started.logs.some((record) => record.event === 'mcp_transport_open')).toBe(true);
      expect(started.logs.some((record) => record.event === 'mcp_tool_call')).toBe(true);
      expect(started.logs.some((record) => record.event === 'mcp_auth_failure')).toBe(true);
      expect(started.logs.some((record) => record.event === 'mcp_transport_close')).toBe(true);
      expect(serialized).toContain('keyFingerprint');
      expect(serialized).toContain('mcpSessionId');
      expect(serialized).toContain('remoteAddress');
      expect(serialized).toContain('reason');
    } finally {
      await connected.client.close().catch(() => undefined);
    }
  });

  it('does not log full Authorization, MCP KEY, JWT, Cookie, password, or secret values', async () => {
    const started = await startMcpHttpTestServer();
    server = started.server;
    dataDir = started.dataDir;
    const jwt = 'eyJhbGciOi.fake.jwt';
    const password = 'plain-password-value';
    const secret = 'secret-value';

    await fetch(`${started.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${started.aliceKey.key}`,
        Cookie: `jwt=${jwt}; password=${password}; secret=${secret}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'agentx-logging-test', version: '1.0.0' }
        }
      })
    });
    await initializeRawTransport(started.baseUrl, 'invalid-mcp-key');

    const serialized = JSON.stringify(started.logs);
    expect(serialized).not.toContain(started.aliceKey.key);
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).not.toContain(jwt);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('invalid-mcp-key');
  });
});
