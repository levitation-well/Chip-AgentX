import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createCliHttpClient } from '../src/cli/http-client.js';
import { resolveCliConfig } from '../src/cli/config.js';
import { CliError } from '../src/cli/errors.js';

const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  servers.clear();
});

describe('CLI HTTP foundation', () => {
  it('logs in with username/password and reuses the bearer token', async () => {
    let loginRequests = 0;
    let accountRequests = 0;
    const server = await startServer(async (req, res) => {
      if (req.url === '/auth/login' && req.method === 'POST') {
        loginRequests += 1;
        const body = JSON.parse(await readBody(req));
        expect(body).toMatchObject({ username: 'alice', password: 'super-secret-password' });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ token: 'signed-jwt-token' }));
        return;
      }

      if (req.url === '/api/account' && req.method === 'GET') {
        accountRequests += 1;
        expect(req.headers.authorization).toBe('Bearer signed-jwt-token');
        expect(req.headers['user-agent']).toContain('agentx-cli/');
        expect(typeof req.headers['x-request-id']).toBe('string');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ user: { username: 'alice' } }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    const config = await resolveCliConfig(
      {
        baseUrl: server.baseUrl,
        username: 'alice',
        passwordStdin: true
      },
      {
        readSecretFromStdin: async () => 'super-secret-password'
      }
    );
    const client = createCliHttpClient(config);

    const first = await client.requestJson<{ user: { username: string } }>({ path: '/api/account' });
    const second = await client.requestJson<{ user: { username: string } }>({ path: '/api/account' });

    expect(first.data.user.username).toBe('alice');
    expect(second.data.user.username).toBe('alice');
    expect(loginRequests).toBe(1);
    expect(accountRequests).toBe(2);
  });

  it('supports multipart upload and binary download', async () => {
    const payload = Uint8Array.from([1, 2, 3, 4]);
    const server = await startServer(async (req, res) => {
      if (req.url === '/api/upload' && req.method === 'POST') {
        expect(req.headers['content-type']).toContain('multipart/form-data');
        const body = await readBody(req);
        expect(body).toContain('hello');
        expect(body).toContain('payload.bin');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ uploaded: true }));
        return;
      }

      if (req.url === '/downloads/report.bin' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(Buffer.from(payload));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    const config = await resolveCliConfig({ baseUrl: server.baseUrl, token: 'placeholder-token' });
    const client = createCliHttpClient(config);

    const upload = await client.requestMultipart<{ uploaded: boolean }>({
      path: '/api/upload',
      fields: [
        { name: 'note', value: 'hello' },
        { name: 'file', value: payload, filename: 'payload.bin', contentType: 'application/octet-stream' }
      ]
    });
    const download = await client.download({ path: '/downloads/report.bin' });

    expect(upload.data.uploaded).toBe(true);
    expect(Array.from(download.body)).toEqual(Array.from(payload));
  });

  it('normalizes and redacts HTTP error payloads', async () => {
    const server = await startServer(async (_req, res) => {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'Unauthorized',
          details: {
            authorization: 'Bearer real-secret-token',
            password: 'letmein',
            nested: {
              mcpKey: 'mcp-secret-value'
            }
          }
        })
      );
    });

    const config = await resolveCliConfig({ baseUrl: server.baseUrl, token: 'token-from-flag' });
    const client = createCliHttpClient(config);

    await expect(client.requestJson({ path: '/api/account' })).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
      details: {
        authorization: '[REDACTED]',
        password: '[REDACTED]',
        nested: {
          mcpKey: '[REDACTED]'
        }
      }
    });
  });

  it('maps request timeout to NETWORK_ERROR', async () => {
    const server = await startServer(async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: true }));
    });

    const config = await resolveCliConfig({ baseUrl: server.baseUrl, token: 'token', timeout: 20 });
    const client = createCliHttpClient(config);

    await expect(client.requestJson({ path: '/slow' })).rejects.toMatchObject({
      code: 'NETWORK_ERROR'
    } satisfies Partial<CliError>);
  });
});

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', (error?: Error) => (error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected an IPv4 address');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
