/**
 * B8 工单双向消息：store.addTicketMessage + 受众脱敏 DTO 合约。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TicketStore, toPublicTicketDto, toAdminTicketDto } from '../src/tickets/index.js';

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-ticket-msg-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ticket messages (B8)', () => {
  it('addTicketMessage appends a message, writes an audit entry, and persists across reload', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir });
    const created = await store.createTicket({ type: 'feedback', title: 'Need help' });
    expect(created.messages).toEqual([]);

    const updated = await store.addTicketMessage(
      created.ticketNo,
      { text: 'Admin reply here', authorRole: 'admin', audience: 'user', authorLabel: 'root' },
      { userId: 'admin-1', username: 'root', role: 'admin' }
    );
    expect(updated.messages).toHaveLength(1);
    const message = updated.messages[0]!;
    expect(message.text).toBe('Admin reply here');
    expect(message.audience).toBe('user');
    expect(message.id).toBeTruthy();
    expect(message.createdAt).toBeTruthy();
    expect(updated.auditTrail.some((entry) => entry.action === 'message')).toBe(true);

    // 重新实例化 store（模拟重载）后消息仍在
    const reloaded = new TicketStore({ dataDir });
    const fetched = await reloaded.getTicket(created.ticketNo);
    expect(fetched.messages).toHaveLength(1);
    expect(fetched.messages[0]!.text).toBe('Admin reply here');
  });

  it('rejects empty message text', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir });
    const created = await store.createTicket({ type: 'feedback' });
    await expect(
      store.addTicketMessage(created.ticketNo, { text: '   ', authorRole: 'admin', audience: 'user' })
    ).rejects.toThrow();
  });

  it('public DTO redacts internal messages; admin DTO includes all', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir });
    const created = await store.createTicket({ type: 'feedback' });
    await store.addTicketMessage(created.ticketNo, { text: 'visible to user', authorRole: 'admin', audience: 'user' });
    await store.addTicketMessage(created.ticketNo, { text: 'internal only note', authorRole: 'admin', audience: 'internal' });
    const ticket = await store.getTicket(created.ticketNo);

    const publicDto = toPublicTicketDto(ticket);
    expect(publicDto.messages).toHaveLength(1);
    expect(publicDto.messages[0]!.text).toBe('visible to user');
    expect(publicDto.messages.some((m) => m.audience === 'internal')).toBe(false);
    expect(JSON.stringify(publicDto)).not.toContain('internal only note');

    const adminDto = toAdminTicketDto(ticket);
    expect(adminDto.messages).toHaveLength(2);
    expect(adminDto.messages.map((m) => m.text)).toContain('internal only note');
  });

  it('all three ticket types support messages', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir });
    for (const type of ['feedback', 'datasheet_submission', 'account_application'] as const) {
      const created = await store.createTicket({ type });
      const updated = await store.addTicketMessage(created.ticketNo, {
        text: `reply ${type}`,
        authorRole: 'admin',
        audience: 'user'
      });
      expect(updated.messages).toHaveLength(1);
    }
  });
});
