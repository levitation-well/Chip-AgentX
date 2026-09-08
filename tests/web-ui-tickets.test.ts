/**
 * B8 工单双向消息前端合约：admin 回复 UI + 用户只读线程。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('B8 ticket two-way message UI', () => {
  it('admin.html exposes the message thread container and reply form', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('id="ticket-admin-messages"');
    expect(html).toContain('id="ticket-admin-reply-form"');
    expect(html).toContain('id="ticket-admin-reply-text"');
    expect(html).toContain('id="ticket-admin-reply-internal"');
  });

  it('admin.js wires the reply submit + thread rendering against the messages endpoint', () => {
    const src = readPublicFile('admin.js');
    expect(src).toContain('submitAdminTicketReply');
    expect(src).toContain('renderTicketMessageThread');
    expect(src).toContain('/messages');
    // XSS-safe: message text rendered via textContent, never innerHTML
    expect(src).toContain('body.textContent = message.text');
    // internal-audience messages get a badge admins can distinguish
    expect(src).toContain("'内部'");
  });

  it('tickets.js renders the redacted message thread read-only for users', () => {
    const src = readPublicFile('tickets.js');
    expect(src).toContain('ticket.messages');
    expect(src).toContain('ticket-message-thread');
    expect(src).toContain('body.textContent = message.text');
    // user side never POSTs to the admin reply endpoint (read-only thread)
    expect(src).not.toContain('/messages');
  });
});
