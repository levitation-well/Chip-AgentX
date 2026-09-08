/**
 * B11 Task 2.5：datasheet 工单提交时，sourceDeclaration（来源声明）必须进入工单 payload。
 *
 * 现状（修复前）：POST /api/tickets/datasheet 的 createTicket payload 只带
 * vendor / partNumberOrKeywords / sourceNote / note，遗漏了 sourceDeclaration，
 * 仅靠 buildDatasheetUploadReview 的 `?? sourceNote` 兜底掩盖。本测试钉死
 * payload.sourceDeclaration 为权威来源字段。
 */
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createHttpServer } from '../src/http-server.js';
import { TicketStore } from '../src/tickets/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-datasheet-submit-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startServer() {
  const dataDir = await tempDir();
  const authDir = await tempDir();
  const config: AuthConfig = {
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: '24h',
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10),
    dataDir: authDir
  };
  const userStore = new UserStore(config);
  await userStore.init();
  const jwtService = new JwtService(config);
  const ticketStore = new TicketStore({ dataDir, now: () => new Date('2026-06-25T08:30:00.000Z') });
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    prompts: { enabled: false },
    persistence: { dataDir },
    tickets: { store: ticketStore },
    product: { config: { edition: 'public' } }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    ticketStore
  };
}

function datasheetForm(fields: { sourceDeclaration: string; sourceNote?: string }): FormData {
  const form = new FormData();
  form.set('title', 'YTM32B1ME0 datasheet');
  form.set('vendor', 'YuntuSemi');
  form.set('partNumberOrKeywords', 'YTM32B1ME0');
  if (fields.sourceNote) form.set('sourceNote', fields.sourceNote);
  form.set('sourceDeclaration', fields.sourceDeclaration);
  form.set('disclaimerAccepted', 'on');
  form.append(
    'attachments',
    new Blob(['# public datasheet\n'], { type: 'text/markdown' }),
    'ytm32.md'
  );
  return form;
}

async function json(response: Response) {
  return (await response.json()) as any;
}

describe('POST /api/tickets/datasheet captures sourceDeclaration in payload', () => {
  it('persists the distinct sourceDeclaration into the ticket payload', async () => {
    const started = await startServer();
    try {
      // sourceDeclaration 与 sourceNote 用不同值，证明 payload 取的是 sourceDeclaration 而非兜底的 sourceNote
      const response = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({ sourceDeclaration: '来源 X', sourceNote: '随手记的备注' })
      });
      expect(response.status).toBe(201);
      const body = await json(response);
      const ticketNo = body.ticket.ticketNo;

      const stored = await started.ticketStore.getTicket(ticketNo);
      expect(stored.payload.sourceDeclaration).toBe('来源 X');
      // 兜底字段仍各自保留，不互相串值
      expect(stored.payload.sourceNote).toBe('随手记的备注');
    } finally {
      await new Promise<void>((resolve, reject) =>
        started.server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
