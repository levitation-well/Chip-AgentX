import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TicketStore,
  TicketValidationError,
  UnsafeTicketNoError,
  toAdminTicketDto
} from '../src/tickets/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-tickets-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixedStore(dataDir: string): TicketStore {
  return new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
}

describe('TicketStore', () => {
  it('creates all ticket types with readable daily prefixes', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);

    const feedback = await store.createTicket({ type: 'feedback', title: 'Need UDS helper' });
    const datasheet = await store.createTicket({ type: 'datasheet_submission', title: 'YTM32 datasheet' });
    const application = await store.createTicket({ type: 'account_application', title: 'Join request' });

    expect(feedback.ticketNo).toBe('FB-20260525-0001');
    expect(datasheet.ticketNo).toBe('DS-20260525-0001');
    expect(application.ticketNo).toBe('AP-20260525-0001');
    expect(feedback.status).toBe('submitted');
  });

  it('serializes same-process concurrent ticket number generation', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);

    const tickets = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.createTicket({ type: 'feedback', title: `Feedback ${index}` })
      )
    );
    const ticketNos = tickets.map((ticket) => ticket.ticketNo).sort();

    expect(new Set(ticketNos)).toHaveLength(20);
    expect(ticketNos[0]).toBe('FB-20260525-0001');
    expect(ticketNos[19]).toBe('FB-20260525-0020');
  });

  it('writes detail files and a sanitized index', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const ticket = await store.createTicket({
      type: 'feedback',
      title: 'Private report',
      internalNote: 'admin only',
      contact: { email: 'user@example.com' },
      payload: { cwd: 'D:\\repo\\chip-agentx', publicNeed: 'OTA' }
    });

    const detailPath = path.join(dataDir, 'tickets', 'detail', '2026', '05', `${ticket.ticketNo}.json`);
    await expect(stat(detailPath)).resolves.toBeTruthy();
    await expect(stat(path.join(dataDir, 'tickets', 'index.jsonl'))).resolves.toBeTruthy();

    const indexText = await readFile(path.join(dataDir, 'tickets', 'index.jsonl'), 'utf8');
    expect(indexText).toContain(ticket.ticketNo);
    expect(indexText).not.toContain('internalNote');
    expect(indexText).not.toContain('user@example.com');
    expect(indexText).not.toContain('payload');
  });

  it('keeps feedback answerTextHash while stripping unsafe feedback metadata', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const ticket = await store.createTicket({
      type: 'feedback',
      title: 'Message feedback',
      payload: {
        feedbackSnapshot: {
          sessionId: 'session-1',
          answerTextHash: 'A'.repeat(64),
          sourcePath: 'D:\\secret\\raw.md',
          accessToken: 'secret-token',
          outputMeta: {
            answerTextHash: 'B'.repeat(64),
            cookie: 'session=secret'
          }
        }
      }
    });

    const stored = await store.getTicket(ticket.ticketNo);
    const text = JSON.stringify(stored.payload);

    expect(text).toContain('"answerTextHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"');
    expect(text).toContain('"answerTextHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"');
    expect(text).not.toMatch(/sourcePath|accessToken|cookie|D:\\|secret-token|session=secret/i);
  });

  it('rejects statuses outside the ticket type allowlist', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);

    await expect(
      store.createTicket({ type: 'feedback', status: 'approved' as any })
    ).rejects.toBeInstanceOf(TicketValidationError);
  });

  it('rejects unsafe ticket numbers', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);

    await expect(store.getTicket('../secret')).rejects.toBeInstanceOf(UnsafeTicketNoError);
    await expect(store.getTicket('FB-20260525-../../secret')).rejects.toBeInstanceOf(UnsafeTicketNoError);
  });

  it('returns a whitelist-only public DTO', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const ticket = await store.createTicket({
      type: 'feedback',
      title: 'Public summary',
      publicNote: 'received',
      internalNote: 'hidden note',
      contact: { phone: '13800000000' },
      accountBinding: { userId: 'user-1', username: 'alice', role: 'customer' },
      attachments: [{ id: 'file-1', status: 'pending', originalName: 'secret.pdf', storagePath: 'D:\\secret\\file.pdf' }],
      payload: { company: 'ACME', passwordHash: 'hash' }
    });

    const publicTicket = await store.getPublicTicket(ticket.ticketNo);
    const text = JSON.stringify(publicTicket);
    expect(publicTicket).toMatchObject({ ticketNo: ticket.ticketNo, publicNote: 'received' });
    expect(publicTicket).not.toHaveProperty('attachments');
    expect(text).not.toContain('contact');
    expect(text).not.toContain('accountBinding');
    expect(text).not.toContain('internalNote');
    expect(text).not.toContain('payload');
    expect(text).not.toContain('auditTrail');
    expect(text).not.toContain('secret.pdf');
    expect(text).not.toContain('13800000000');
  });

  it('keeps account application secrets internal while public and admin DTOs are safe', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const secretHash = '$2b$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve';
    const ticket = await store.createTicket({
      type: 'account_application',
      title: 'applicant',
      contact: { raw: 'applicant@example.com', company: 'Secret Co' },
      payload: {
        application: {
          username: 'applicant',
          company: 'Secret Co',
          contact: 'applicant@example.com'
        },
        credentialDraft: {
          passwordHash: secretHash,
          plainPassword: 'VisibleSecret123!',
          createdAt: '2026-05-25T08:30:00.000Z',
          expiresAt: '2026-06-24T08:30:00.000Z',
          status: 'pending'
        }
      }
    });

    const internal = await store.getTicket(ticket.ticketNo);
    expect(JSON.stringify(internal)).toContain(secretHash);

    const publicText = JSON.stringify(await store.getPublicTicket(ticket.ticketNo));
    expect(publicText).not.toContain('applicant');
    expect(publicText).not.toContain('Secret Co');
    expect(publicText).not.toContain('applicant@example.com');
    expect(publicText).not.toContain('credentialDraft');
    expect(publicText).not.toContain('passwordHash');
    expect(publicText).not.toContain('plainPassword');
    expect(publicText).not.toContain(secretHash);
    expect(publicText).not.toContain('VisibleSecret123!');

    const adminDto = toAdminTicketDto(internal);
    const adminText = JSON.stringify(adminDto);
    expect(adminDto.payload).toMatchObject({
      application: { username: 'applicant', company: 'Secret Co', contact: 'applicant@example.com' },
      credentialDraft: { status: 'pending', hasPasswordHash: true }
    });
    expect(adminText).toContain('hasPasswordHash');
    expect(adminText).not.toContain('VisibleSecret123!');
    expect(adminText).not.toContain('plainPassword');
    expect(adminText).not.toContain('passwordHash');
    expect(adminText).not.toContain(secretHash);
  });

  it('keeps internal attachment storage fields out of admin DTOs', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const ticket = await store.createTicket({
      type: 'datasheet_submission',
      title: 'attachment privacy',
      attachments: [{
        id: 'att-1',
        status: 'pending',
        originalName: 'driver.c',
        storedName: 'internal-driver.c',
        mimeType: 'text/x-c',
        sizeBytes: 42,
        sha256: 'abc123',
        storagePath: '2026/05/DS-20260525-0001/internal-driver.c',
        uploadedAt: '2026-05-25T08:30:00.000Z',
        retentionUntil: '2026-06-24T08:30:00.000Z'
      }]
    });

    const adminDto = toAdminTicketDto(await store.getTicket(ticket.ticketNo));
    expect(adminDto.attachments).toEqual([{
      id: 'att-1',
      status: 'pending',
      originalName: 'driver.c',
      mimeType: 'text/x-c',
      sizeBytes: 42,
      uploadedAt: '2026-05-25T08:30:00.000Z',
      retentionUntil: '2026-06-24T08:30:00.000Z'
    }]);
    const adminText = JSON.stringify(adminDto);
    expect(adminText).not.toContain('storedName');
    expect(adminText).not.toContain('storagePath');
    expect(adminText).not.toContain('sha256');
    expect(adminText).not.toContain('internal-driver.c');
    expect(adminText).not.toContain('ticket-attachments');
  });

  it('lists only tickets bound to the requested account', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const aliceTicket = await store.createTicket({
      type: 'feedback',
      title: 'Alice ticket',
      accountBinding: { userId: 'user-1', username: 'alice' }
    });
    await store.createTicket({ type: 'feedback', title: 'Anonymous ticket' });
    await store.createTicket({
      type: 'feedback',
      title: 'Bob ticket',
      accountBinding: { userId: 'user-2', username: 'bob' }
    });

    const result = await store.listTicketsForAccount('user-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].ticketNo).toBe(aliceTicket.ticketNo);
  });

  it('enforces datasheet upload review state transitions and exposes only safe owner status summaries', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const ticket = await store.createTicket({
      type: 'datasheet_submission',
      title: 'State machine',
      accountBinding: { userId: 'user-1', username: 'alice' },
      payload: {
        uploadReview: {
          state: 'submitted',
          searchable: false,
          visibilityCandidate: 'restricted',
          catalogBinding: null,
          disclaimerAccepted: true,
          securityScan: {
            status: 'passed',
            summary: 'All local checks passed',
            scannedAt: '2026-05-25T08:30:00.000Z',
            policyVersion: 'phase39-local-v1',
            attachments: [{
              id: 'att-1',
              normalizedName: 'safe.md',
              extension: '.md',
              sizeBytes: 12,
              fingerprint: 'abcdef123456',
              isArchive: false,
              status: 'passed',
              summary: 'passed'
            }]
          },
          metadataCandidate: { applicationTags: [] }
        }
      }
    });

    await expect(store.updateTicket(ticket.ticketNo, { status: 'scanning' })).resolves.toMatchObject({ status: 'scanning' });
    await expect(store.updateTicket(ticket.ticketNo, { status: 'linked' })).rejects.toBeInstanceOf(TicketValidationError);
    await expect(store.updateTicket(ticket.ticketNo, { status: 'accepted' })).resolves.toMatchObject({ status: 'accepted' });
    await expect(store.updateTicket(ticket.ticketNo, { status: 'linked' })).resolves.toMatchObject({ status: 'linked' });

    const mine = await store.listTicketsForAccount('user-1');
    const serialized = JSON.stringify(mine);
    expect(mine.items[0].uploadReview).toEqual({
      state: 'linked',
      securityScanStatus: 'passed',
      securityScanSummary: 'All local checks passed'
    });
    expect(serialized).not.toContain('sha256');
    expect(serialized).not.toContain('storagePath');
    expect(serialized).not.toContain('ticket-attachments');
  });

  it('filters admin ticket lists by keyword without changing list DTO privacy', async () => {
    const dataDir = await tempDir();
    const store = fixedStore(dataDir);
    const secretHash = '$2b$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve';
    const feedback = await store.createTicket({
      type: 'feedback',
      title: 'UDS helper request',
      payload: { category: 'UDS', content: 'Need request parsing support.' }
    });
    const datasheet = await store.createTicket({
      type: 'datasheet_submission',
      title: 'Datasheet upload',
      payload: { vendor: 'YuntuSemi', partNumberOrKeywords: 'YTM32B1ME0', sourceNote: 'official page' }
    });
    const application = await store.createTicket({
      type: 'account_application',
      title: 'Join request',
      payload: {
        application: {
          username: 'filter-user',
          company: 'Filter Corp',
          occupation: 'FAE'
        },
        credentialDraft: {
          passwordHash: secretHash,
          createdAt: '2026-05-25T08:30:00.000Z',
          expiresAt: '2026-06-24T08:30:00.000Z',
          status: 'pending'
        }
      }
    });

    await expect(store.listTickets({ keyword: 'uds' })).resolves.toMatchObject({
      items: [expect.objectContaining({ ticketNo: feedback.ticketNo })]
    });
    await expect(store.listTickets({ keyword: 'YTM32' })).resolves.toMatchObject({
      items: [expect.objectContaining({ ticketNo: datasheet.ticketNo })]
    });
    await expect(store.listTickets({ keyword: 'filter-user' })).resolves.toMatchObject({
      items: [expect.objectContaining({ ticketNo: application.ticketNo })]
    });

    const serializedList = JSON.stringify(await store.listTickets({ keyword: 'filter' }));
    expect(serializedList).not.toContain(secretHash);
    expect(serializedList).not.toContain('passwordHash');
    expect(serializedList).not.toContain('credentialDraft');
    expect(serializedList).not.toContain('plainPassword');
  });
});
