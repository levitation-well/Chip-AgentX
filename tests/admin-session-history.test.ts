import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpServer } from '../src/http-server.js';
import { JwtService, UserStore, type AuthConfig } from '../src/auth/index.js';
import { createPersistenceRuntime, type PersistenceRuntime } from '../src/persistence/index.js';

const JWT_SECRET = '0123456789abcdef0123456789abcdef';
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-admin-history-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startAdminServer(runtime: PersistenceRuntime) {
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
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer');
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: { enabled: false },
    prompts: { enabled: false },
    persistence: { runtime }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    jwtService,
    server,
    alice,
    admin
  };
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe('admin session history API', () => {
  it('rejects non-admin, lists all users sessions, queries questions, and writes audit log', async () => {
    const auditEvents: string[] = [];
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({
      dataDir,
      auditLogger: {
        log(event) {
          auditEvents.push(event);
          return { timestamp: '2026-05-08T00:00:00.000Z', level: 'info', event, message: event };
        }
      }
    });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-alice',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      chipId: 'E521.39',
      cwd: 'D:/chips/E521.39',
      task: 'Find power pins',
      source: 'web'
    });
    await runtime.recordUserTurn('session-alice', {
      role: 'user',
      text: 'Find power pins',
      createdAt: '2026-05-08T01:00:00.000Z',
      question: {
        sessionId: 'session-alice',
        userId: 'user-alice',
        username: 'alice',
        role: 'customer',
        chipId: 'E521.39',
        source: 'web'
      }
    });
    const started = await startAdminServer(runtime);
    try {
      const userToken = started.jwtService.sign(started.alice.id, started.alice.username, started.alice.role);
      const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);

      const denied = await fetch(`${started.baseUrl}/admin/questions`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(denied.status).toBe(403);

      const list = await fetch(`${started.baseUrl}/admin/sessions/history`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const listBody = await list.json() as any;
      expect(list.status).toBe(200);
      expect(listBody.items).toEqual([expect.objectContaining({ sessionId: 'session-alice', cwd: 'D:/chips/E521.39' })]);
      expect(list.headers.get('cache-control')).toContain('no-store');

      const questions = await fetch(`${started.baseUrl}/admin/questions?keyword=power`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const questionsBody = await questions.json() as any;
      expect(questions.status).toBe(200);
      expect(questionsBody.items).toEqual([expect.objectContaining({ text: 'Find power pins' })]);
      expect(questions.headers.get('cache-control')).toContain('no-store');

      const detail = await fetch(`${started.baseUrl}/admin/sessions/session-alice/history`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(detail.status).toBe(200);
      expect(detail.headers.get('cache-control')).toContain('no-store');
      expect(auditEvents).toEqual(expect.arrayContaining(['admin_question_ledger_read', 'admin_cross_user_read']));
    } finally {
      await closeServer(started.server);
    }
  });

  it('filters sessions by date range and records outputTail audit metadata', async () => {
    const auditRecords: Array<{ event: string; metadata?: unknown }> = [];
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({
      dataDir,
      auditLogger: {
        log(event, _message, context) {
          auditRecords.push({ event, metadata: context?.metadata });
          return { timestamp: '2026-05-08T00:00:00.000Z', level: 'info', event, message: event };
        }
      }
    });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'old-session',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      cwd: 'D:/chips/old',
      task: 'old question',
      source: 'web',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastMessageAt: '2026-05-01T00:00:00.000Z'
    } as any);
    await runtime.recordSessionCreated({
      sessionId: 'new-session',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      cwd: 'D:/chips/new',
      task: 'new question',
      source: 'web',
      createdAt: '2026-05-08T00:00:00.000Z',
      lastMessageAt: '2026-05-08T00:00:00.000Z'
    } as any);
    await runtime.sessionStore.appendOutput('new-session', 'raw output tail');
    await runtime.sessionStore.appendEvent('new-session', { event: 'session_created' });
    const started = await startAdminServer(runtime);
    try {
      const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);
      const list = await fetch(`${started.baseUrl}/admin/sessions/history?from=2026-05-07T00:00:00.000Z&to=2026-05-09T00:00:00.000Z`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const listBody = await list.json() as any;
      expect(list.status).toBe(200);
      expect(listBody.items.map((item: any) => item.sessionId)).toEqual(['new-session']);

      const detail = await fetch(`${started.baseUrl}/admin/sessions/new-session/history?outputTail=5`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const detailBody = await detail.json() as any;
      expect(detail.status).toBe(200);
      expect(detailBody.outputTail.output).toBe(' tail');
      expect(auditRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: 'admin_cross_user_read',
          metadata: expect.objectContaining({
            includeOutputTail: true,
            targetSessionId: 'new-session',
            targetUserId: 'user-alice',
            adminUserId: started.admin!.id
          })
        })
      ]));
    } finally {
      await closeServer(started.server);
    }
  });

  it('returns 404 for missing admin session detail and analysis package does not include output tail by default', async () => {
    const auditEvents: string[] = [];
    const dataDir = await tempDir();
    const runtime = createPersistenceRuntime({
      dataDir,
      auditLogger: {
        log(event) {
          auditEvents.push(event);
          return { timestamp: '2026-05-08T00:00:00.000Z', level: 'info', event, message: event };
        }
      }
    });
    await runtime.init();
    await runtime.recordSessionCreated({
      sessionId: 'session-analysis',
      userId: 'user-alice',
      username: 'alice',
      role: 'customer',
      agentType: 'claude-code',
      cwd: 'D:/chips/E521.39',
      task: 'analysis question',
      source: 'web'
    });
    await runtime.sessionStore.appendOutput('session-analysis', 'raw output should stay out by default');
    const started = await startAdminServer(runtime);
    try {
      const adminToken = started.jwtService.sign(started.admin!.id, started.admin!.username, started.admin!.role);
      const missing = await fetch(`${started.baseUrl}/admin/sessions/missing/history`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ error: 'Session not found' });

      const analysis = await fetch(`${started.baseUrl}/admin/sessions/session-analysis/analysis`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const body = await analysis.json() as any;
      expect(analysis.status).toBe(200);
      expect(body.outputTail).toBeUndefined();
      expect(analysis.headers.get('cache-control')).toContain('no-store');
      expect(auditEvents).toContain('admin_analysis_read');
    } finally {
      await closeServer(started.server);
    }
  });
});
