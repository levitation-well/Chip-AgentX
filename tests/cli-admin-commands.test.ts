import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAdmin } from '../src/cli/commands/admin.js';

type Action = (...args: unknown[]) => unknown;

const servers = new Set<http.Server>();

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
});

describe('CLI admin commands', () => {
  it('covers read-only admin surfaces without leaking template secrets or prompt bodies', async () => {
    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-secret-token');

      if (req.method === 'GET' && url.pathname === '/admin/users') {
        return json(res, 200, {
          users: [
            {
              id: 'user-1',
              username: 'alice',
              role: 'customer',
              status: 'active',
              modelGrants: ['haiku'],
              mcpKeys: [
                {
                  id: 'key-1',
                  name: 'alice-laptop',
                  maskedKey: 'mcp_****1234',
                  fingerprint: 'fp-1234',
                  modelGrants: ['haiku']
                }
              ]
            }
          ]
        });
      }

      if (req.method === 'GET' && url.pathname === '/admin/users/user-1') {
        return json(res, 200, {
          user: {
            id: 'user-1',
            username: 'alice',
            role: 'customer',
            status: 'active',
            modelGrants: ['haiku'],
            mcpKeys: [
              {
                id: 'key-1',
                name: 'alice-laptop',
                maskedKey: 'mcp_****1234',
                fingerprint: 'fp-1234',
                modelGrants: ['haiku'],
                resourceGrants: { chipIds: ['E522.94'] }
              }
            ]
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
          downloads: []
        });
      }

      if (req.method === 'GET' && url.pathname === '/mcp-templates/codex.md') {
        return text(res, 200, 'text/markdown; charset=utf-8', 'AGENTX_MCP_KEY=<paste-key-here>\nBearer runtime-secret-token\n');
      }

      if (req.method === 'GET' && url.pathname === '/admin/prompts/roles%2Fadmin.md') {
        return json(res, 200, {
          content: 'System prompt body that should never be echoed back to CLI output.\n'
        });
      }

      if (req.method === 'GET' && url.pathname === '/admin/prompts/roles%2Fadmin.md/history') {
        return json(res, 200, {
          entries: [
            {
              relativePath: 'roles/admin.md',
              createdAt: '2026-05-30T08:00:00.000Z',
              hash: 'prompt-hash-1',
              username: 'admin',
              content: 'Older prompt body'
            }
          ]
        });
      }

      if (req.method === 'GET' && url.pathname === '/admin/tickets/DS-1') {
        return json(res, 200, {
          ticket: {
            ticketNo: 'DS-1',
            status: 'accepted',
            needsMoreInfo: false,
            payload: {
              uploadReview: {
                state: 'accepted',
                metadataCandidate: {
                  chipId: 'E522.94',
                  partNumber: 'PART-94',
                  resolution: { chipId: true }
                },
                bindingIntent: {
                  intent: 'accepted',
                  acceptedAt: '2026-05-30T09:00:00.000Z'
                }
              }
            }
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/admin/chips') {
        return json(res, 200, {
          knowledgeBaseRoot: 'D:\\secret-workspace\\chips',
          chips: [
            {
              id: 'E522.94',
              label: 'E522.94',
              workspaceDir: 'D:\\secret-workspace\\chips\\E522.94'
            }
          ]
        });
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createAdminAction();

    await runAction(action, [['users', 'list'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const users = readJsonLog();
    expect(users).toMatchObject({
      ok: true,
      data: {
        total: 1,
        users: [expect.objectContaining({ username: 'alice' })]
      }
    });
    expect(JSON.stringify(users)).not.toContain('"key":');

    consoleLogSpy.mockClear();
    await runAction(action, [['model-auth', 'get', 'user-1'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const modelAuth = readJsonLog();
    expect(modelAuth).toMatchObject({
      ok: true,
      data: {
        userId: 'user-1',
        modelGrants: ['haiku'],
        mcpKeys: [expect.objectContaining({ fingerprint: 'fp-1234' })]
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['mcp-templates', 'show', 'codex'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const template = readJsonLog();
    expect(template).toMatchObject({
      ok: true,
      data: {
        templateId: 'codex',
        fileName: 'codex.md'
      }
    });
    expect(template.data.content).toContain('AGENTX_MCP_KEY=<paste-key-here>');
    expect(template.data.content).not.toContain('runtime-secret-token');

    consoleLogSpy.mockClear();
    await runAction(action, [['prompts', 'show', 'roles/admin.md'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const promptMeta = readJsonLog();
    expect(promptMeta).toMatchObject({
      ok: true,
      data: {
        path: 'roles/admin.md',
        missing: false
      }
    });
    expect(JSON.stringify(promptMeta)).not.toContain('System prompt body');

    consoleLogSpy.mockClear();
    await runAction(action, [['prompts', 'history', 'roles/admin.md'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const history = readJsonLog();
    expect(history).toMatchObject({
      ok: true,
      data: {
        path: 'roles/admin.md',
        entries: [expect.objectContaining({ hash: 'prompt-hash-1', username: 'admin' })]
      }
    });
    expect(JSON.stringify(history)).not.toContain('Older prompt body');

    consoleLogSpy.mockClear();
    await runAction(action, [['metadata', 'get-candidate', 'DS-1'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        ticketNo: 'DS-1',
        uploadReviewState: 'accepted',
        bindingIntent: expect.objectContaining({ intent: 'accepted' }),
        metadataCandidate: expect.objectContaining({ chipId: 'E522.94' })
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['catalog', 'chips', 'get'], { json: true, baseUrl: server.baseUrl, token: 'runtime-secret-token' }]);
    const chips = readJsonLog();
    expect(chips).toMatchObject({
      ok: true,
      data: {
        knowledgeBaseRoot: '[REDACTED_PATH]',
        chips: [expect.objectContaining({ id: 'E522.94' })]
      }
    });
    expect(JSON.stringify(chips)).not.toContain('workspaceDir');
    expect(JSON.stringify(chips)).not.toContain('D:\\secret-workspace');
  });

  it('enforces confirmation gates and keeps dry-run mutations side-effect free', async () => {
    let creditAdjustCalls = 0;
    let reviewCalls = 0;
    let publishCalls = 0;

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'GET' && url.pathname === '/admin/credits') {
        return json(res, 200, {
          userId: 'user-1',
          username: 'alice',
          balanceUnits: 260,
          ledger: { items: [], total: 0, offset: 0, limit: 5 }
        });
      }

      if (req.method === 'POST' && url.pathname === '/admin/credits/adjust') {
        creditAdjustCalls += 1;
        return json(res, 200, {});
      }

      if (req.method === 'GET' && url.pathname === '/admin/tickets/DS-1') {
        return json(res, 200, {
          ticket: {
            ticketNo: 'DS-1',
            status: 'submitted',
            payload: { uploadReview: { state: 'submitted', metadataCandidate: {} } }
          }
        });
      }

      if (req.method === 'PUT' && url.pathname === '/admin/tickets/DS-1/datasheet-review') {
        reviewCalls += 1;
        return json(res, 200, {});
      }

      if (req.method === 'POST' && url.pathname === '/admin/announcements/announcement-1/publish') {
        publishCalls += 1;
        return json(res, 200, {});
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createAdminAction();

    await expect(
      runAction(action, [[
        'credits',
        'adjust',
        'user-1'
      ], {
        json: true,
        baseUrl: server.baseUrl,
        token: 'runtime-token',
        deltaUnits: 20,
        reason: 'manual_adjust'
      }])
    ).rejects.toThrow('process.exit(2)');
    expect(readJsonError()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        exitCode: 2
      }
    });
    expect(creditAdjustCalls).toBe(0);

    consoleErrorSpy.mockClear();
    consoleLogSpy.mockClear();
    await runAction(action, [[
      'credits',
      'adjust',
      'user-1'
    ], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      deltaUnits: 20,
      reason: 'manual_adjust',
      dryRun: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        dryRun: true,
        action: 'credits.adjust',
        current: expect.objectContaining({ balanceUnits: 260 })
      }
    });
    expect(creditAdjustCalls).toBe(0);

    consoleLogSpy.mockClear();
    await runAction(action, [['uploads-review', 'accept', 'DS-1'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      dryRun: true,
      publicNote: 'looks good'
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        dryRun: true,
        action: 'uploads-review.accept',
        ticketNo: 'DS-1'
      }
    });
    expect(reviewCalls).toBe(0);

    consoleLogSpy.mockClear();
    await runAction(action, [['announcements', 'publish', 'announcement-1'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      dryRun: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        dryRun: true,
        action: 'announcements.publish',
        announcementId: 'announcement-1'
      }
    });
    expect(publishCalls).toBe(0);
  });

  it('executes confirmed admin mutations including role delete without requiring JSON input', async () => {
    let creditAdjustBody: any;
    let promptUpdateBody: any;
    let reviewPatchBody: any;
    let roleDeleteCount = 0;
    let publishCount = 0;

    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(req.headers.authorization).toBe('Bearer runtime-token');

      if (req.method === 'POST' && url.pathname === '/admin/credits/adjust') {
        creditAdjustBody = JSON.parse(await readBody(req));
        return json(res, 200, {
          userId: 'user-1',
          username: 'alice',
          balanceBeforeUnits: 260,
          balanceAfterUnits: 220,
          deltaUnits: -40,
          reason: creditAdjustBody.reason,
          note: creditAdjustBody.note,
          ledgerRecord: { id: 'ledger-1' }
        });
      }

      if (req.method === 'PUT' && url.pathname === '/admin/prompts/roles%2Fadmin.md') {
        promptUpdateBody = JSON.parse(await readBody(req));
        return json(res, 200, { saved: true });
      }

      if (req.method === 'PUT' && url.pathname === '/admin/tickets/DS-1/datasheet-review') {
        reviewPatchBody = JSON.parse(await readBody(req));
        return json(res, 200, {
          ticket: {
            ticketNo: 'DS-1',
            status: reviewPatchBody.status,
            needsMoreInfo: false,
            payload: {
              uploadReview: {
                state: reviewPatchBody.status,
                metadataCandidate: reviewPatchBody.metadataCandidate,
                bindingIntent: { intent: 'linked' }
              }
            }
          }
        });
      }

      if (req.method === 'DELETE' && url.pathname === '/admin/roles/reviewer') {
        roleDeleteCount += 1;
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/admin/announcements/announcement-1/publish') {
        publishCount += 1;
        return json(res, 200, {
          item: {
            id: 'announcement-1',
            type: 'announcement',
            status: 'published',
            title: 'Service notice',
            revision: 3
          }
        });
      }

      res.statusCode = 404;
      res.end();
    });

    const action = createAdminAction();

    await runAction(action, [[
      'credits',
      'adjust',
      'user-1'
    ], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      deltaUnits: -40,
      reason: 'manual_reconcile',
      note: 'phase43',
      yes: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        balanceBeforeUnits: 260,
        balanceAfterUnits: 220,
        deltaUnits: -40
      }
    });
    expect(creditAdjustBody).toMatchObject({
      userId: 'user-1',
      deltaUnits: -40,
      reason: 'manual_reconcile',
      note: 'phase43'
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['prompts', 'update', 'roles/admin.md'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      content: 'Updated prompt body',
      yes: true
    }]);
    const promptUpdate = readJsonLog();
    expect(promptUpdate).toMatchObject({
      ok: true,
      data: {
        saved: true,
        path: 'roles/admin.md'
      }
    });
    expect(promptUpdate.data).not.toHaveProperty('content');
    expect(promptUpdateBody).toEqual({ content: 'Updated prompt body' });

    consoleLogSpy.mockClear();
    await runAction(action, [['uploads-review', 'link', 'DS-1'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      chipId: 'E522.94',
      partNumber: 'PART-94',
      note: 'catalog linked',
      yes: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        ticket: expect.objectContaining({ ticketNo: 'DS-1', status: 'linked' })
      }
    });
    expect(reviewPatchBody).toMatchObject({
      status: 'linked',
      bindingNote: 'catalog linked',
      metadataCandidate: {
        chipId: 'E522.94',
        partNumber: 'PART-94'
      }
    });

    consoleLogSpy.mockClear();
    await runAction(action, [['catalog', 'roles', 'delete', 'reviewer'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      yes: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        deleted: true,
        roleName: 'reviewer'
      }
    });
    expect(roleDeleteCount).toBe(1);

    consoleLogSpy.mockClear();
    await runAction(action, [['announcements', 'publish', 'announcement-1'], {
      json: true,
      baseUrl: server.baseUrl,
      token: 'runtime-token',
      yes: true
    }]);
    expect(readJsonLog()).toMatchObject({
      ok: true,
      data: {
        item: expect.objectContaining({ id: 'announcement-1', status: 'published' })
      }
    });
    expect(publishCount).toBe(1);
  });

  it('surfaces server-side admin forbids as stable FORBIDDEN CLI errors', async () => {
    const server = await startServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      expect(url.pathname).toBe('/admin/users');
      return json(res, 403, { error: 'Forbidden', code: 'FORBIDDEN' });
    });

    const action = createAdminAction();

    await expect(
      runAction(action, [['users', 'list'], { json: true, baseUrl: server.baseUrl, token: 'customer-token' }])
    ).rejects.toThrow('process.exit(4)');
    expect(readJsonError()).toMatchObject({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        exitCode: 4,
        statusCode: 403
      }
    });
  });

  it('retires the legacy catalog chip-access CLI surface without calling the server', async () => {
    let requestCount = 0;
    const server = await startServer((_req, res) => {
      requestCount += 1;
      return json(res, 500, { error: 'should not be called' });
    });

    const action = createAdminAction();

    await expect(
      runAction(action, [['catalog', 'chip-access', 'get'], { json: true, baseUrl: server.baseUrl, token: 'runtime-token' }])
    ).rejects.toThrow('process.exit(2)');
    expect(readJsonError()).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        exitCode: 2,
        message: expect.stringContaining('retired')
      }
    });
    expect(requestCount).toBe(0);
  });
});

function createAdminAction(): Action {
  const cli = createMockCac();
  registerAdmin(cli);
  const action = cli.actions.get('admin [...args]');
  if (!action) {
    throw new Error('Missing admin action');
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

function text(res: http.ServerResponse, statusCode: number, contentType: string, payload: string): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', contentType);
  res.end(payload);
}

function readJsonLog(): any {
  return JSON.parse(String(consoleLogSpy.mock.calls.at(-1)?.[0] ?? ''));
}

function readJsonError(): any {
  return JSON.parse(String(consoleErrorSpy.mock.calls.at(-1)?.[0] ?? ''));
}
