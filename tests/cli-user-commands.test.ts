import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerUser } from '../src/cli/commands/user.js';

type Action = (...args: unknown[]) => unknown;

const servers = new Set<http.Server>();
const cleanupPaths = new Set<string>();

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as unknown) as (code?: string | number | null | undefined) => never);
});

afterEach(async () => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  processExitSpy.mockRestore();

  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  servers.clear();

  await Promise.all([...cleanupPaths].map((filePath) => rm(filePath, { recursive: true, force: true })));
  cleanupPaths.clear();
});

describe('CLI user commands', () => {
  it('serves whoami, permissions, credits, and models from HTTP APIs with stable json output', async () => {
    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'GET' && url.pathname === '/api/account') {
        return json(res, 200, {
          user: {
            id: 'user-1',
            username: 'alice',
            role: 'customer',
            status: 'active',
            localePreference: 'zh-CN',
            preferredLanguage: 'zh-CN',
            credits: { balanceUnits: 250 }
          },
          permissions: {
            role: 'customer',
            authorizedModels: ['haiku'],
            availableModels: [
              { id: 'haiku', label: 'Standard', mode: 'standard', creditUnits: 50 }
            ],
            searchModes: [{ id: 'standard', modelLabel: 'Standard', available: true, disabledReasons: [] }],
            authorizedTools: ['agentx_whoami'],
            resources: [{ type: 'chip', id: 'E522.94', label: 'E522.94 Rear lighting' }],
            scopeCatalog: [{ id: 'lighting', label: 'Lighting scope' }],
            selfService: { mcpKeys: true, mcpKeyRegenerate: true },
            mcpKeyPolicy: { allowMcpKeySelfCreate: true, allowMcpKeyRegenerate: true },
            authorizationSummary: { usable: true }
          },
          credits: {
            balanceUnits: 250,
            recentLedger: { items: [{ createdAt: '2026-05-30T00:00:00.000Z', entry: 'chat', status: 'charged', units: 50 }] }
          },
          mcpKeys: []
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/account/credits') {
        expect(url.searchParams.get('limit')).toBe('2');
        return json(res, 200, {
          balanceUnits: 250,
          ledger: {
            items: [{ createdAt: '2026-05-30T00:00:00.000Z', entry: 'chat', modelId: 'haiku', status: 'charged', units: 50 }],
            total: 1,
            offset: 0,
            limit: 2
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/search-modes') {
        return json(res, 200, {
          modes: [
            { id: 'standard', modelLabel: 'Standard', available: true, disabledReasons: [] },
            { id: 'enhanced', modelLabel: 'Enhanced', available: false, disabledReasons: [{ code: 'MODEL_NOT_AUTHORIZED' }] }
          ]
        });
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createUserAction();

    await runAction(action, [['whoami'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        user: { username: 'alice', role: 'customer' },
        selfService: { mcpKeys: true, mcpKeyRegenerate: true }
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['permissions'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        authorizedModels: ['haiku'],
        resources: [expect.objectContaining({ id: 'E522.94' })]
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['credits'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token', limit: 2 }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        balanceUnits: 250,
        ledger: { total: 1, limit: 2 }
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['models'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        authorizedModels: ['haiku'],
        searchModes: [expect.objectContaining({ id: 'standard' }), expect.objectContaining({ id: 'enhanced' })]
      }
    });
  });

  it('drops one-time MCP key secrets and keeps template output placeholder-safe', async () => {
    const outputDir = await mkdtemp(join(tmpdir(), 'agentx-cli-template-'));
    cleanupPaths.add(outputDir);
    const outputFile = join(outputDir, 'codex.md');

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'POST' && url.pathname === '/api/account/mcp-keys') {
        return json(res, 201, {
          secret: 'one-time-secret-value',
          key: {
            id: 'key-1',
            name: 'laptop',
            maskedKey: 'mcp_****1234',
            fingerprint: 'fp-1234',
            expiresAt: '2026-06-30T00:00:00.000Z'
          }
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/account/mcp-keys/key-1/regenerate') {
        return json(res, 200, {
          secret: 'rotated-secret-value',
          key: {
            id: 'key-1',
            name: 'laptop',
            maskedKey: 'mcp_****5678',
            fingerprint: 'fp-5678',
            expiresAt: '2026-07-30T00:00:00.000Z'
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/mcp/access-center') {
        return json(res, 200, {
          templates: [
            {
              id: 'codex',
              label: 'Codex handoff',
              clientType: 'codex',
              contentType: 'text/markdown',
              downloadUrl: '/mcp-templates/codex.md'
            }
          ],
          downloads: [
            {
              id: 'agentx-mcp-client-package',
              label: 'AgentX package',
              contentType: 'application/zip',
              downloadUrl: '/downloads/agentx-mcp-client-package.zip'
            }
          ]
        });
      }

      if (req.method === 'GET' && url.pathname === '/mcp-templates/codex.md') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.end(`AGENTX_MCP_KEY=<paste-key-here>\nsecret = runtime-token\n`);
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createUserAction();

    await runAction(action, [['mcp-key', 'create'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token', name: 'laptop' }]);
    const created = readJsonLog();
    expect(created).toMatchObject({
      ok: true,
      data: {
        keyId: 'key-1',
        name: 'laptop',
        maskedKey: 'mcp_****1234',
        fingerprint: 'fp-1234',
        expiresAt: '2026-06-30T00:00:00.000Z'
      }
    });
    expect(JSON.stringify(created)).not.toContain('one-time-secret-value');

    consoleLogSpy.mockClear();
    await runAction(action, [['mcp-key', 'regenerate', 'key-1'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    const regenerated = readJsonLog();
    expect(regenerated).toMatchObject({
      ok: true,
      data: {
        keyId: 'key-1',
        maskedKey: 'mcp_****5678',
        fingerprint: 'fp-5678'
      }
    });
    expect(JSON.stringify(regenerated)).not.toContain('rotated-secret-value');

    consoleLogSpy.mockClear();
    await runAction(action, [['template', 'show', 'codex'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    const template = readJsonLog();
    expect(template).toMatchObject({
      ok: true,
      data: {
        templateId: 'codex',
        fileName: 'codex.md'
      }
    });
    expect(template.data.content).toContain('AGENTX_MCP_KEY=<paste-key-here>');
    expect(template.data.content).not.toContain('runtime-token');

    consoleLogSpy.mockClear();
    await runAction(action, [['template', 'download', 'codex'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token', output: outputFile }]);
    const downloaded = readJsonLog();
    expect(downloaded).toMatchObject({
      ok: true,
      data: {
        templateId: 'codex',
        saved: true
      }
    });
    const savedContent = await readFile(outputFile, 'utf8');
    expect(savedContent).toContain('AGENTX_MCP_KEY=<paste-key-here>');
    expect(savedContent).not.toContain('runtime-token');

    consoleLogSpy.mockClear();
    await runAction(action, [['template', 'package-info'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        downloads: [expect.objectContaining({ id: 'agentx-mcp-client-package' })]
      }
    });
  });

  it('does not probe public ticket details when the requested ticket is not owned by the caller', async () => {
    let publicLookups = 0;
    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'GET' && url.pathname === '/api/my/tickets') {
        return json(res, 200, {
          items: [
            {
              ticketNo: 'DS-20260530-0001',
              type: 'datasheet_submission',
              status: 'submitted',
              title: 'Owned upload',
              createdAt: '2026-05-30T00:00:00.000Z',
              updatedAt: '2026-05-30T00:00:00.000Z',
              needsMoreInfo: false
            }
          ],
          total: 1,
          offset: 0,
          limit: 100
        });
      }

      if (req.method === 'GET' && url.pathname.startsWith('/api/tickets/')) {
        publicLookups += 1;
        return json(res, 200, {
          ticket: {
            ticketNo: 'DS-20260530-9999',
            type: 'datasheet_submission',
            status: 'submitted',
            createdAt: '2026-05-30T00:00:00.000Z',
            updatedAt: '2026-05-30T00:00:00.000Z',
            needsMoreInfo: false
          }
        });
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createUserAction();

    await expect(
      runAction(action, [['tickets', 'get', 'DS-20260530-9999'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }])
    ).rejects.toThrow('process.exit(5)');

    expect(readJsonError()).toMatchObject({
      ok: false,
      error: {
        code: 'NOT_FOUND',
        exitCode: 5
      }
    });
    expect(publicLookups).toBe(0);
  });

  it('submits datasheet uploads through multipart review flow and lists upload status from my tickets only', async () => {
    const uploadDir = await mkdtemp(join(tmpdir(), 'agentx-cli-upload-'));
    cleanupPaths.add(uploadDir);
    const uploadFile = join(uploadDir, 'sample.md');
    await writeFile(uploadFile, '# datasheet\n');

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'POST' && url.pathname === '/api/tickets/datasheet') {
        expect(req.headers['content-type']).toContain('multipart/form-data');
        const body = await readBody(req);
        expect(body).toContain('datasheet-title');
        expect(body).toContain('part-123');
        expect(body).toContain('disclaimerAccepted');
        expect(body).toContain('sample.md');
        return json(res, 201, {
          ticket: {
            ticketNo: 'DS-20260530-0002',
            type: 'datasheet_submission',
            status: 'submitted'
          },
          uploadReview: {
            state: 'submitted',
            securityScanStatus: 'passed'
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/my/tickets') {
        expect(url.searchParams.get('type')).toBe('datasheet_submission');
        return json(res, 200, {
          items: [
            {
              ticketNo: 'DS-20260530-0002',
              type: 'datasheet_submission',
              status: 'submitted',
              title: 'datasheet-title',
              createdAt: '2026-05-30T00:00:00.000Z',
              updatedAt: '2026-05-30T00:10:00.000Z',
              needsMoreInfo: false,
              uploadReview: {
                state: 'submitted',
                securityScanStatus: 'passed',
                securityScanSummary: 'ok'
              }
            }
          ],
          total: 1,
          offset: 0,
          limit: 100
        });
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createUserAction();

    await runAction(action, [[
      'uploads',
      'submit'
    ], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      title: 'datasheet-title',
      partNumber: 'part-123',
      file: uploadFile,
      disclaimerAccepted: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        ticket: { ticketNo: 'DS-20260530-0002' },
        uploadReview: { state: 'submitted', securityScanStatus: 'passed' }
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['uploads', 'status'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        items: [expect.objectContaining({ ticketNo: 'DS-20260530-0002', type: 'datasheet_submission' })]
      }
    });
  });
});

function createUserAction(): Action {
  const cli = createMockCac();
  registerUser(cli);
  const action = cli.actions.get('user [...args]');
  if (!action) {
    throw new Error('Missing user action');
  }
  return action;
}

function createMockCac() {
  const commandNames: string[] = [];
  const actions = new Map<string, Action>();
  let currentCommand = '';
  const cli = {
    command: vi.fn().mockImplementation((name: string) => {
      currentCommand = name;
      commandNames.push(name);
      return cli;
    }),
    option: vi.fn().mockReturnThis(),
    action: vi.fn().mockImplementation((fn: Action) => {
      actions.set(currentCommand, fn);
      return cli;
    }),
    commandNames,
    actions
  };
  return cli;
}

async function runAction(action: Action, args: unknown[]): Promise<void> {
  const result = action(...args);
  if (result instanceof Promise) {
    await result;
  }
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: String(error) }));
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

function json(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function readJsonLog(): any {
  return JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ''));
}

function readJsonError(): any {
  return JSON.parse(String(consoleErrorSpy.mock.calls.at(-1)?.[0] ?? ''));
}
