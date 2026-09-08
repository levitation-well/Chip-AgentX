import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
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
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-tickets-api-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startTicketServer() {
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
  const alice = await userStore.createUser('alice', 'alice-secret', 'customer');
  const bob = await userStore.createUser('bob', 'bob-secret', 'customer');
  const admin = await userStore.findByUsername('admin');
  const jwtService = new JwtService(config);
  const ticketStore = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
  const manager = new EventEmitter() as EventEmitter & Record<string, any>;
  manager.list = vi.fn().mockReturnValue([]);
  manager.listWithPid = vi.fn().mockReturnValue([]);
  const server = createHttpServer({
    manager: manager as any,
    auth: { enabled: true, config, userStore, jwtService },
    chips: {
      enabled: true,
      catalog: {
        knowledgeBaseRoot: dataDir,
        chips: [{
          id: 'YTM32B1ME0',
          label: 'YTM32B1ME0',
          brand: 'YuntuSemi',
          productLines: ['Automotive MCU'],
          applicationTags: ['Body control'],
          documentIds: ['doc-ytm32'],
          workspaceDir: 'chips/YTM32B1ME0'
        }]
      }
    },
    prompts: { enabled: false },
    resources: {
      enabled: true,
      catalog: {
        documents: [{
          documentId: 'doc-ytm32',
          label: 'YTM32 public datasheet',
          visibility: 'restricted',
          status: 'pending',
          brands: ['YuntuSemi'],
          productLines: ['Automotive MCU'],
          applicationTags: ['Body control'],
          chipIds: ['YTM32B1ME0'],
          requiredGrants: { documentIds: ['doc-ytm32'] },
          sourceLabels: ['seed']
        }],
        scopePresets: [{
          scopePresetId: 'scope-ytm32-review',
          label: 'YTM32 review scope',
          visibility: 'restricted',
          status: 'pending',
          brands: ['YuntuSemi'],
          productLines: ['Automotive MCU'],
          applicationTags: ['Body control'],
          chipIds: ['YTM32B1ME0'],
          documentIds: ['doc-ytm32'],
          requiredGrants: { scopePresetIds: ['scope-ytm32-review'] },
          sourceLabels: ['seed']
        }]
      }
    },
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
    ticketStore,
    userStore,
    jwtService,
    alice,
    bob,
    admin
  };
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function token(started: Awaited<ReturnType<typeof startTicketServer>>, user: { id: string; username: string; role: string }): string {
  return started.jwtService.sign(user.id, user.username, user.role);
}

async function json(response: Response) {
  return (await response.json()) as any;
}

function feedbackForm(fields: {
  title?: string;
  content?: string;
  category?: string;
  contact?: string;
  attachments?: Array<{ name: string; content: string; type?: string }>;
}): FormData {
  const form = new FormData();
  form.set('title', fields.title ?? 'Need public portal upload');
  form.set('content', fields.content ?? 'Please add attachment review support.');
  if (fields.category) form.set('category', fields.category);
  if (fields.contact) form.set('contact', fields.contact);
  if (fields.attachments?.length) {
    form.set('hasAttachments', 'true');
    for (const attachment of fields.attachments) {
      form.append(
        'attachments',
        new Blob([attachment.content], { type: attachment.type ?? 'text/plain' }),
        attachment.name
      );
    }
  }
  return form;
}

function datasheetForm(fields: {
  title?: string;
  vendor?: string;
  partNumberOrKeywords?: string;
  sourceNote?: string;
  contact?: string;
  note?: string;
  attachments?: Array<{ name: string; content: string; type?: string }>;
}): FormData {
  const form = new FormData();
  form.set('title', fields.title ?? 'YTM32B1ME0 datasheet');
  if (fields.vendor) form.set('vendor', fields.vendor);
  if (fields.partNumberOrKeywords) form.set('partNumberOrKeywords', fields.partNumberOrKeywords);
  if (fields.sourceNote) form.set('sourceNote', fields.sourceNote);
  form.set('sourceDeclaration', fields.sourceNote ?? 'official public page');
  form.set('disclaimerAccepted', 'on');
  if (fields.contact) form.set('contact', fields.contact);
  if (fields.note) form.set('note', fields.note);
  for (const attachment of fields.attachments ?? [{ name: 'ytm32.md', content: '# public datasheet\n', type: 'text/markdown' }]) {
    form.append(
      'attachments',
      new Blob([attachment.content], { type: attachment.type ?? 'text/plain' }),
      attachment.name
    );
  }
  return form;
}

function accountApplicationBody(fields: Record<string, unknown> = {}) {
  return {
    username: 'new.applicant',
    password: 'ApplySecret123!',
    company: 'Secret Applicant Co',
    reason: 'I want to contribute embedded documents.',
    heardFrom: 'MCP intro',
    occupation: 'FAE',
    favoriteFeature: 'MCP access',
    expectedFeature: 'Datasheet search',
    contact: 'applicant@example.com',
    ...fields
  };
}

describe('tickets HTTP API', () => {
  it('creates anonymous feedback tickets from multipart forms and keeps public output desensitized', async () => {
    const started = await startTicketServer();
    try {
      const response = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        body: feedbackForm({
          title: 'Attachment feedback',
          content: 'The upload includes private reproduction notes.',
          category: 'bug',
          contact: 'alice@example.com',
          attachments: [{ name: 'private-name.pdf', content: '%PDF-1.4', type: 'application/pdf' }]
        })
      });
      const body = await json(response);
      const text = JSON.stringify(body);

      expect(response.status).toBe(201);
      expect(body.ticket.ticketNo).toBe('FB-20260525-0001');
      expect(body.ticket).toMatchObject({ type: 'feedback', status: 'submitted' });
      expect(text).not.toContain('private-name.pdf');
      expect(text).not.toContain('alice@example.com');
      expect(text).not.toContain('storagePath');
      expect(text).not.toContain('payload');

      const detail = await started.ticketStore.getTicket(body.ticket.ticketNo);
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0].originalName).toBe('private-name.pdf');
      expect(detail.attachments[0].storagePath).toContain(`2026/05/${body.ticket.ticketNo}/`);
      expect(detail.accountBinding).toBeUndefined();

      const publicResponse = await fetch(`${started.baseUrl}/api/tickets/${body.ticket.ticketNo}/public`);
      expect(JSON.stringify(await json(publicResponse))).not.toContain('private-name.pdf');
    } finally {
      await closeServer(started.server);
    }
  });

  it('binds authenticated feedback tickets to the current account only', async () => {
    const started = await startTicketServer();
    try {
      const anonymous = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        body: feedbackForm({ title: 'Anonymous idea', content: 'Do not bind later.' })
      });
      expect(anonymous.status).toBe(201);

      const created = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token(started, started.alice)}` },
        body: feedbackForm({ title: 'Alice idea', content: 'Bind this ticket to Alice.' })
      });
      const createdBody = await json(created);
      expect(created.status).toBe(201);

      const mine = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${token(started, started.alice)}` }
      });
      const mineBody = await json(mine);

      expect(mine.status).toBe(200);
      expect(mineBody.items).toHaveLength(1);
      expect(mineBody.items[0].ticketNo).toBe(createdBody.ticket.ticketNo);
      expect(JSON.stringify(mineBody)).not.toContain('Anonymous idea');
    } finally {
      await closeServer(started.server);
    }
  });

  it('creates anonymous and authenticated datasheet submissions with strict public privacy', async () => {
    const started = await startTicketServer();
    try {
      const anonymous = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({
          title: 'Public MCU datasheet',
          vendor: 'Secret Vendor',
          partNumberOrKeywords: 'YTM32B1ME0',
          sourceNote: 'official public page',
          contact: 'datasheet-owner@example.com',
          note: 'internal processing hint',
          attachments: [{ name: 'vendor-secret.md', content: '# datasheet\n', type: 'text/markdown' }]
        })
      });
      const anonymousBody = await json(anonymous);
      const anonymousText = JSON.stringify(anonymousBody);

      expect(anonymous.status).toBe(201);
      expect(anonymousBody.ticket.ticketNo).toBe('DS-20260525-0001');
      expect(anonymousBody.ticket).toMatchObject({ type: 'datasheet_submission', status: 'submitted' });
      expect(anonymousBody.uploadReview).toMatchObject({
        state: 'submitted',
        securityScanStatus: 'passed'
      });
      expect(anonymousText).not.toContain('vendor-secret.md');
      expect(anonymousText).not.toContain('originalName');
      expect(anonymousText).not.toContain('storagePath');
      expect(anonymousText).not.toContain('sha256');
      expect(anonymousText).not.toContain('payload');
      expect(anonymousText).not.toContain('contact');
      expect(anonymousText).not.toContain('Secret Vendor');
      expect(anonymousText).not.toContain('internal processing hint');

      const detail = await started.ticketStore.getTicket(anonymousBody.ticket.ticketNo);
      expect(detail.attachments).toHaveLength(1);
      expect(detail.attachments[0].originalName).toBe('vendor-secret.md');
      expect(detail.attachments[0].storagePath).toContain(`2026/05/${anonymousBody.ticket.ticketNo}/`);
      expect(detail.payload).toMatchObject({
        vendor: 'Secret Vendor',
        note: 'internal processing hint',
        uploadReview: {
          state: 'submitted',
          searchable: false,
          visibilityCandidate: 'restricted',
          catalogBinding: null,
          disclaimerAccepted: true,
          securityScan: { status: 'passed' }
        }
      });
      expect(detail.accountBinding).toBeUndefined();

      const authenticated = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token(started, started.alice)}` },
        body: datasheetForm({ title: 'Alice datasheet submission' })
      });
      const authenticatedBody = await json(authenticated);
      expect(authenticated.status).toBe(201);

      const mine = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${token(started, started.alice)}` }
      });
      const mineBody = await json(mine);

      expect(mine.status).toBe(200);
      expect(mineBody.items.map((item: any) => item.ticketNo)).toEqual([authenticatedBody.ticket.ticketNo]);
      expect(mineBody.items[0].uploadReview).toMatchObject({
        state: 'submitted',
        securityScanStatus: 'passed'
      });
      expect(JSON.stringify(mineBody)).not.toContain(anonymousBody.ticket.ticketNo);
      expect(JSON.stringify(mineBody)).not.toContain('storagePath');
      expect(JSON.stringify(mineBody)).not.toContain('sha256');
    } finally {
      await closeServer(started.server);
    }
  });

  it('creates account application tickets without leaking submitted passwords or private fields', async () => {
    const started = await startTicketServer();
    try {
      const submittedPassword = 'ApplySecret123!';
      const response = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ password: submittedPassword }))
      });
      const body = await json(response);
      const responseText = JSON.stringify(body);

      expect(response.status).toBe(201);
      expect(body.ticket.ticketNo).toBe('AP-20260525-0001');
      expect(body.ticket).toMatchObject({ type: 'account_application', status: 'submitted' });
      expect(responseText).not.toContain(submittedPassword);
      expect(responseText).not.toContain('new.applicant');
      expect(responseText).not.toContain('Secret Applicant Co');
      expect(responseText).not.toContain('applicant@example.com');
      expect(responseText).not.toContain('payload');
      expect(responseText).not.toContain('credentialDraft');
      expect(responseText).not.toContain('passwordHash');

      const detail = await started.ticketStore.getTicket(body.ticket.ticketNo);
      const detailText = JSON.stringify(detail);
      expect(detailText).not.toContain(submittedPassword);
      expect(detailText).not.toContain('plainPassword');
      expect((detail.payload.credentialDraft as any).passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);

      const publicResponse = await fetch(`${started.baseUrl}/api/tickets/${body.ticket.ticketNo}/public`);
      const publicText = JSON.stringify(await json(publicResponse));
      expect(publicText).not.toContain(submittedPassword);
      expect(publicText).not.toContain('new.applicant');
      expect(publicText).not.toContain('Secret Applicant Co');
      expect(publicText).not.toContain('applicant@example.com');
      expect(publicText).not.toContain('payload');
      expect(publicText).not.toContain('passwordHash');
      expect(publicText).not.toContain('plainPassword');
    } finally {
      await closeServer(started.server);
    }
  });

  it('binds authenticated account applications to my tickets only', async () => {
    const started = await startTicketServer();
    try {
      const anonymous = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'anon-user' }))
      });
      expect(anonymous.status).toBe(201);

      const authenticated = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token(started, started.alice)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(accountApplicationBody({ username: 'alice-join' }))
      });
      const authenticatedBody = await json(authenticated);
      expect(authenticated.status).toBe(201);

      const mine = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${token(started, started.alice)}` }
      });
      const mineBody = await json(mine);
      const mineText = JSON.stringify(mineBody);

      expect(mine.status).toBe(200);
      expect(mineBody.items.map((item: any) => item.ticketNo)).toEqual([authenticatedBody.ticket.ticketNo]);
      expect(mineText).not.toContain('anon-user');
      expect(mineText).not.toContain('ApplySecret123!');
      expect(mineText).not.toContain('plainPassword');
    } finally {
      await closeServer(started.server);
    }
  });

  it('lets admins inspect and approve account applications through the safe approval route', async () => {
    const started = await startTicketServer();
    try {
      const submittedPassword = 'ApproveMe123!';
      const created = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'approved-user', password: submittedPassword }))
      });
      const createdBody = await json(created);
      const adminToken = token(started, started.admin!);

      const detail = await fetch(`${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const detailBody = await json(detail);
      const detailText = JSON.stringify(detailBody);
      expect(detail.status).toBe(200);
      expect(detailBody.ticket.payload).toMatchObject({
        application: { username: 'approved-user', company: 'Secret Applicant Co' },
        credentialDraft: { status: 'pending', hasPasswordHash: true }
      });
      expect(detailText).not.toContain(submittedPassword);
      expect(detailText).not.toContain('plainPassword');
      expect(detailText).not.toContain('passwordHash');
      expect(detailText).not.toMatch(/\$2[aby]\$\d{2}\$/);

      const genericApprove = await fetch(`${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });
      expect(genericApprove.status).toBe(400);

      const approved = await fetch(
        `${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}/account-application/approve`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }
      );
      const approvedBody = await json(approved);
      const approvedText = JSON.stringify(approvedBody);

      expect(approved.status).toBe(200);
      expect(approvedBody.ticket.status).toBe('approved');
      expect(approvedBody.ticket.payload.credentialDraft).toMatchObject({
        status: 'consumed',
        hasPasswordHash: true
      });
      expect(approvedBody.user).toMatchObject({
        username: 'approved-user',
        role: 'customer',
        status: 'active',
        mcpKeys: []
      });
      expect(approvedText).not.toContain(submittedPassword);
      expect(approvedText).not.toContain('plainPassword');
      expect(approvedText).not.toContain('passwordHash');
      expect(approvedText).not.toMatch(/\$2[aby]\$\d{2}\$/);
      await expect(started.ticketStore.getTicket(createdBody.ticket.ticketNo)).resolves.toMatchObject({
        status: 'approved'
      });
    } finally {
      await closeServer(started.server);
    }
  });

  it('rejects duplicate account application approval without marking the ticket approved', async () => {
    const started = await startTicketServer();
    try {
      const created = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'alice', password: 'Duplicate123!' }))
      });
      const createdBody = await json(created);
      const adminToken = token(started, started.admin!);

      const approved = await fetch(
        `${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}/account-application/approve`,
        { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const approvedText = JSON.stringify(await json(approved));
      const detail = await started.ticketStore.getTicket(createdBody.ticket.ticketNo);

      expect(approved.status).toBe(409);
      expect(detail.status).not.toBe('approved');
      expect(approvedText).not.toContain('Duplicate123!');
      expect(approvedText).not.toContain('passwordHash');
    } finally {
      await closeServer(started.server);
    }
  });

  it('disables a newly created approval user if ticket approval persistence fails', async () => {
    const started = await startTicketServer();
    try {
      const created = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'rollback-user', password: 'Rollback123!' }))
      });
      const createdBody = await json(created);
      const adminToken = token(started, started.admin!);
      const approveSpy = vi
        .spyOn(started.ticketStore, 'approveAccountApplicationTicket')
        .mockRejectedValueOnce(new Error('simulated ticket write failure'));

      const approved = await fetch(
        `${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}/account-application/approve`,
        { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } }
      );

      expect(approved.status).toBe(500);
      const user = await started.userStore.findByUsername('rollback-user');
      expect(user).toMatchObject({ username: 'rollback-user', status: 'disabled', role: 'customer' });
      await expect(started.userStore.verifyLogin('rollback-user', 'Rollback123!')).resolves.toBeNull();
      approveSpy.mockRestore();
    } finally {
      await closeServer(started.server);
    }
  });

  it('invalidates rejected and closed account application drafts and blocks later approval', async () => {
    const started = await startTicketServer();
    try {
      const created = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'reject-me', password: 'RejectMe123!' }))
      });
      const createdBody = await json(created);
      const adminToken = token(started, started.admin!);

      const rejected = await fetch(`${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' })
      });
      const rejectedBody = await json(rejected);
      expect(rejected.status).toBe(200);
      expect(rejectedBody.ticket.payload.credentialDraft).toMatchObject({
        status: 'invalidated',
        hasPasswordHash: true
      });
      expect(JSON.stringify(rejectedBody)).not.toContain('RejectMe123!');
      expect(JSON.stringify(rejectedBody)).not.toContain('plainPassword');
      expect(JSON.stringify(rejectedBody)).not.toContain('passwordHash');

      const approveAfterReject = await fetch(
        `${started.baseUrl}/admin/tickets/${createdBody.ticket.ticketNo}/account-application/approve`,
        { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } }
      );
      expect(approveAfterReject.status).toBe(409);

      const closedCreated = await fetch(`${started.baseUrl}/api/tickets/account-application`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(accountApplicationBody({ username: 'close-me', password: 'CloseMe123!' }))
      });
      const closedBody = await json(closedCreated);
      const closed = await fetch(`${started.baseUrl}/admin/tickets/${closedBody.ticket.ticketNo}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'closed' })
      });
      const closedPatchBody = await json(closed);
      expect(closed.status).toBe(200);
      expect(closedPatchBody.ticket.payload.credentialDraft.status).toBe('invalidated');
      expect(JSON.stringify(closedPatchBody)).not.toContain('CloseMe123!');
      expect(JSON.stringify(closedPatchBody)).not.toContain('plainPassword');
    } finally {
      await closeServer(started.server);
    }
  });

  it('returns safe API errors for invalid datasheet upload requests', async () => {
    const started = await startTicketServer();
    try {
      const nonMultipart = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Bad request' })
      });
      const nonMultipartText = JSON.stringify(await json(nonMultipart));
      expect(nonMultipart.status).toBe(400);
      expect(nonMultipartText).toContain('Expected multipart datasheet submission form');
      expect(nonMultipartText).not.toContain('ticket-attachments');
      expect(nonMultipartText).not.toContain('D:\\');
      expect(nonMultipartText).not.toContain('/tmp/');

      const noAttachment = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({ attachments: [] })
      });
      const noAttachmentText = JSON.stringify(await json(noAttachment));
      expect(noAttachment.status).toBe(400);
      expect(noAttachmentText).toContain('Datasheet attachment is required');
      expect(noAttachmentText).not.toContain('ticket-attachments');

      const missingDeclaration = new FormData();
      missingDeclaration.set('title', 'Missing declaration');
      missingDeclaration.append('attachments', new Blob(['# safe\n'], { type: 'text/markdown' }), 'safe.md');
      const missingDeclarationResponse = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: missingDeclaration
      });
      const missingDeclarationText = JSON.stringify(await json(missingDeclarationResponse));
      expect(missingDeclarationResponse.status).toBe(400);
      expect(missingDeclarationText).toContain('Datasheet submission declaration is required');
      expect(missingDeclarationText).not.toContain('ticket-attachments');
      expect(missingDeclarationText).not.toContain('D:\\');

      const badContent = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({
          attachments: [{ name: 'fake.pdf', content: 'not a pdf', type: 'application/pdf' }]
        })
      });
      const badContentText = JSON.stringify(await json(badContent));
      expect(badContent.status).toBe(400);
      expect(badContentText).toContain('Attachment content does not match its extension');
      expect(badContentText).not.toContain('storagePath');
      expect(badContentText).not.toContain('ticket-attachments');
      expect(badContentText).not.toContain('D:\\');
      expect(badContentText).not.toContain('/tmp/');
    } finally {
      await closeServer(started.server);
    }
  });

  it('returns safe API errors for invalid feedback upload requests', async () => {
    const started = await startTicketServer();
    try {
      const nonMultipart = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Bad request', content: 'Not multipart' })
      });
      const nonMultipartBody = await json(nonMultipart);
      expect(nonMultipart.status).toBe(400);
      expect(nonMultipartBody.error).toBe('Expected multipart feedback form');
      expect(JSON.stringify(nonMultipartBody)).not.toContain('agentx-tickets-api-');
      expect(JSON.stringify(nonMultipartBody)).not.toContain('ticket-attachments');

      const rejected = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        body: feedbackForm({
          title: 'Executable attachment',
          content: 'This should be rejected.',
          attachments: [{ name: 'malware.exe', content: 'MZ' }]
        })
      });
      const rejectedBody = await json(rejected);
      const rejectedText = JSON.stringify(rejectedBody);
      expect(rejected.status).toBe(400);
      expect(rejectedBody.error).toBe('Attachment type is not allowed');
      expect(rejectedText).not.toContain('agentx-tickets-api-');
      expect(rejectedText).not.toContain('ticket-attachments');
      expect(rejectedText).not.toContain('D:\\');
      expect(rejectedText).not.toContain('/tmp/');

      const unknownFileField = new FormData();
      unknownFileField.set('title', 'Unknown file field');
      unknownFileField.set('content', 'This file field must not bypass limits.');
      unknownFileField.append('avatar', new Blob(['avatar'], { type: 'text/plain' }), 'avatar.txt');
      const unknownResponse = await fetch(`${started.baseUrl}/api/tickets/feedback`, {
        method: 'POST',
        body: unknownFileField
      });
      const unknownBody = await json(unknownResponse);
      expect(unknownResponse.status).toBe(400);
      expect(unknownBody.error).toBe('Unknown attachment file field');
      expect(await started.ticketStore.listAllTicketRecords()).toHaveLength(0);
    } finally {
      await closeServer(started.server);
    }
  });

  it('serves public ticket query without auth and keeps the DTO desensitized', async () => {
    const started = await startTicketServer();
    try {
      const ticket = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Need AUTOSAR feature',
        publicNote: 'received',
        internalNote: 'admin private note',
        contact: { email: 'alice@example.com' },
        accountBinding: { userId: started.alice.id, username: started.alice.username, role: started.alice.role },
        attachments: [{ id: 'att-1', status: 'pending', originalName: 'secret.pdf' }],
        payload: { company: 'ACME', cwd: 'D:\\secret\\repo' }
      });

      const response = await fetch(`${started.baseUrl}/api/tickets/${ticket.ticketNo}/public`);
      const body = await json(response);
      const text = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.ticket).toMatchObject({ ticketNo: ticket.ticketNo, publicNote: 'received' });
      expect(text).not.toContain('internalNote');
      expect(text).not.toContain('contact');
      expect(text).not.toContain('payload');
      expect(text).not.toContain('accountBinding');
      expect(text).not.toContain('attachments');
      expect(text).not.toContain('auditTrail');
      expect(text).not.toContain('alice@example.com');
      expect(text).not.toContain('secret.pdf');
    } finally {
      await closeServer(started.server);
    }
  });

  it('returns public query errors for missing and unsafe ticket numbers', async () => {
    const started = await startTicketServer();
    try {
      const missing = await fetch(`${started.baseUrl}/api/tickets/FB-20260525-9999/public`);
      expect(missing.status).toBe(404);
      expect((await json(missing)).error).toBe('Ticket not found');

      const unsafe = await fetch(`${started.baseUrl}/api/tickets/BAD-20260525-0001/public`);
      expect(unsafe.status).toBe(400);
    } finally {
      await closeServer(started.server);
    }
  });

  it('requires auth for my tickets and returns only current account-bound tickets', async () => {
    const started = await startTicketServer();
    try {
      const aliceTicket = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Alice ticket',
        accountBinding: { userId: started.alice.id, username: started.alice.username, role: started.alice.role }
      });
      await started.ticketStore.createTicket({ type: 'feedback', title: 'Anonymous ticket' });
      await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Bob ticket',
        accountBinding: { userId: started.bob.id, username: started.bob.username, role: started.bob.role }
      });

      const denied = await fetch(`${started.baseUrl}/api/my/tickets`);
      expect(denied.status).toBe(401);

      const response = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${token(started, started.alice)}` }
      });
      const body = await json(response);

      expect(response.status).toBe(200);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].ticketNo).toBe(aliceTicket.ticketNo);
      expect(JSON.stringify(body)).not.toContain('Anonymous ticket');
      expect(JSON.stringify(body)).not.toContain('Bob ticket');
    } finally {
      await closeServer(started.server);
    }
  });

  it('protects admin ticket APIs and lets admins list, detail, and update tickets', async () => {
    const started = await startTicketServer();
    try {
      const ticket = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Bug report',
        internalNote: 'admin note',
        accountBinding: { userId: started.alice.id, username: started.alice.username, role: started.alice.role }
      });
      const userToken = token(started, started.alice);
      const adminToken = token(started, started.admin!);

      const forbidden = await fetch(`${started.baseUrl}/admin/tickets`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(forbidden.status).toBe(403);

      const list = await fetch(`${started.baseUrl}/admin/tickets?type=feedback`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const listBody = await json(list);
      expect(list.status).toBe(200);
      expect(listBody.items).toEqual([expect.objectContaining({ ticketNo: ticket.ticketNo })]);

      const detail = await fetch(`${started.baseUrl}/admin/tickets/${ticket.ticketNo}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const detailBody = await json(detail);
      expect(detail.status).toBe(200);
      expect(detailBody.ticket.internalNote).toBe('admin note');

      const patched = await fetch(`${started.baseUrl}/admin/tickets/${ticket.ticketNo}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'received',
          publicNote: '已收到',
          internalNote: 'confirmed',
          result: '等待评估',
          needsMoreInfo: true,
          ignored: 'not persisted'
        })
      });
      const patchedBody = await json(patched);
      expect(patched.status).toBe(200);
      expect(patchedBody.ticket).toMatchObject({
        status: 'received',
        publicNote: '已收到',
        internalNote: 'confirmed',
        result: '等待评估',
        needsMoreInfo: true
      });
      expect(patchedBody.ticket).not.toHaveProperty('ignored');
      expect(patchedBody.ticket.auditTrail.at(-1)).toMatchObject({ action: 'admin_update' });

      const publicResponse = await fetch(`${started.baseUrl}/api/tickets/${ticket.ticketNo}/public`);
      const publicBody = await json(publicResponse);
      expect(publicBody.ticket).toMatchObject({
        status: 'received',
        publicNote: '已收到',
        result: '等待评估',
        needsMoreInfo: true
      });
      expect(JSON.stringify(publicBody)).not.toContain('confirmed');
    } finally {
      await closeServer(started.server);
    }
  });

  it('filters unified admin ticket lists across feedback, datasheet, and account application tickets', async () => {
    const started = await startTicketServer();
    try {
      const secretHash = '$2b$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve';
      const feedback = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'UDS helper request',
        payload: { category: 'UDS', content: 'Need request parsing support.' }
      });
      const datasheet = await started.ticketStore.createTicket({
        type: 'datasheet_submission',
        title: 'Datasheet upload',
        needsMoreInfo: true,
        payload: { vendor: 'YuntuSemi', partNumberOrKeywords: 'YTM32B1ME0', sourceNote: 'official page' }
      });
      const application = await started.ticketStore.createTicket({
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
      const adminToken = token(started, started.admin!);
      const headers = { Authorization: `Bearer ${adminToken}` };

      const apList = await fetch(`${started.baseUrl}/admin/tickets?type=account_application`, { headers });
      const apBody = await json(apList);
      expect(apList.status).toBe(200);
      expect(apBody.items.map((item: any) => item.ticketNo)).toEqual([application.ticketNo]);

      const needsMoreInfo = await fetch(`${started.baseUrl}/admin/tickets?needsMoreInfo=true`, { headers });
      const needsBody = await json(needsMoreInfo);
      expect(needsMoreInfo.status).toBe(200);
      expect(needsBody.items.map((item: any) => item.ticketNo)).toEqual([datasheet.ticketNo]);

      const usernameSearch = await fetch(`${started.baseUrl}/admin/tickets?q=filter-user`, { headers });
      const usernameBody = await json(usernameSearch);
      expect(usernameSearch.status).toBe(200);
      expect(usernameBody.items.map((item: any) => item.ticketNo)).toEqual([application.ticketNo]);

      const vendorSearch = await fetch(`${started.baseUrl}/admin/tickets?keyword=YTM32`, { headers });
      const vendorBody = await json(vendorSearch);
      expect(vendorSearch.status).toBe(200);
      expect(vendorBody.items.map((item: any) => item.ticketNo)).toEqual([datasheet.ticketNo]);

      const ticketSearch = await fetch(`${started.baseUrl}/admin/tickets?q=${feedback.ticketNo}`, { headers });
      const ticketBody = await json(ticketSearch);
      expect(ticketSearch.status).toBe(200);
      expect(ticketBody.items.map((item: any) => item.ticketNo)).toEqual([feedback.ticketNo]);

      const serialized = JSON.stringify({ apBody, usernameBody, vendorBody });
      expect(serialized).not.toContain(secretHash);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('credentialDraft');
    } finally {
      await closeServer(started.server);
    }
  });

  it('filters structured chat feedback by citation context fields without leaking unsafe client metadata', async () => {
    const started = await startTicketServer();
    try {
      const citationFeedback = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Chat feedback session-safe',
        source: 'message-feedback',
        payload: {
          feedbackSnapshot: {
            schemaVersion: 1,
            sessionId: 'session-safe',
            turnId: 'turn-safe',
            entry: 'web',
            modelId: 'haiku',
            chipId: 'YTM32B1ME0',
            documentId: 'doc-ytm32',
            scopePresetId: 'scope-ytm32-review',
            feedbackTypes: ['bad-citation'],
            reviewSignal: 'high_priority',
            answerTextHash: 'a'.repeat(64),
            answerExcerpt: 'Safe answer summary',
            configVersion: 'phase40-feedback-context-v1',
            usedSources: [{
              captureKind: 'system_captured_source_seed',
              scopeId: 'scope-safe',
              scopePresetId: 'scope-ytm32-review',
              documentId: 'doc-ytm32',
              displayTitle: 'YTM32 public datasheet',
              page: '7'
            }]
          }
        }
      });
      await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Other feedback',
        source: 'message-feedback',
        payload: {
          feedbackSnapshot: {
            schemaVersion: 1,
            sessionId: 'session-other',
            modelId: 'opus',
            chipId: 'OTHER',
            feedbackTypes: ['missing-context'],
            reviewSignal: 'normal',
            answerTextHash: 'b'.repeat(64)
          }
        }
      });
      const headers = { Authorization: `Bearer ${token(started, started.admin!)}` };
      const filtered = await fetch(
        `${started.baseUrl}/admin/tickets?type=feedback&feedbackType=bad-citation&chipId=YTM32B1ME0&documentId=doc-ytm32&scopePresetId=scope-ytm32-review&modelId=haiku&reviewSignal=high_priority`,
        { headers }
      );
      const filteredBody = await json(filtered);
      expect(filtered.status).toBe(200);
      expect(filteredBody.items.map((item: any) => item.ticketNo)).toEqual([citationFeedback.ticketNo]);

      const detail = await fetch(`${started.baseUrl}/admin/tickets/${citationFeedback.ticketNo}`, { headers });
      const detailBody = await json(detail);
      expect(detail.status).toBe(200);
      expect(detailBody.ticket.payload.feedbackSnapshot).toMatchObject({
        chipId: 'YTM32B1ME0',
        documentId: 'doc-ytm32',
        scopePresetId: 'scope-ytm32-review',
        modelId: 'haiku',
        answerTextHash: 'a'.repeat(64)
      });
      expect(JSON.stringify(detailBody)).not.toMatch(/sourcePath|workspacePath|D:\\|\/opt\/|token|cookie|password/i);
    } finally {
      await closeServer(started.server);
    }
  });

  it('lets only admins download datasheet attachments by ticket and attachment id', async () => {
    const started = await startTicketServer();
    try {
      const uploadedContent = '# datasheet contribution\npinout table\n';
      const created = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({
          title: 'Downloadable datasheet',
          attachments: [{ name: 'download-me.md', content: uploadedContent, type: 'text/markdown' }]
        })
      });
      const createdBody = await json(created);
      expect(created.status).toBe(201);

      const detail = await started.ticketStore.getTicket(createdBody.ticket.ticketNo);
      const attachment = detail.attachments[0];
      const downloadPath = `/admin/tickets/${detail.ticketNo}/attachments/${attachment.id}/download`;
      const adminToken = token(started, started.admin!);
      const userToken = token(started, started.alice);

      const adminDetail = await fetch(`${started.baseUrl}/admin/tickets/${detail.ticketNo}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const adminDetailText = JSON.stringify(await json(adminDetail));
      expect(adminDetail.status).toBe(200);
      expect(adminDetailText).toContain('download-me.md');
      expect(adminDetailText).not.toContain('storedName');
      expect(adminDetailText).not.toContain('storagePath');
      expect(adminDetailText).not.toContain('sha256');
      expect(adminDetailText).not.toContain('ticket-attachments');
      expect(adminDetailText).not.toContain('D:\\');
      expect(adminDetailText).not.toContain('/tmp/');

      const publicResponse = await fetch(`${started.baseUrl}/api/tickets/${detail.ticketNo}/public`);
      const publicText = JSON.stringify(await json(publicResponse));
      expect(publicText).not.toContain('/download');
      expect(publicText).not.toContain('attachments');

      const noAuth = await fetch(`${started.baseUrl}${downloadPath}`);
      expect([401, 403]).toContain(noAuth.status);

      const forbidden = await fetch(`${started.baseUrl}${downloadPath}`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(forbidden.status).toBe(403);

      const downloaded = await fetch(`${started.baseUrl}${downloadPath}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get('content-disposition')).toContain('download-me.md');
      expect(await downloaded.text()).toBe(uploadedContent);

      await started.ticketStore.replaceTicketAttachments(detail.ticketNo, [{ ...attachment, status: 'cleaned' }]);
      const cleaned = await fetch(`${started.baseUrl}${downloadPath}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const cleanedText = JSON.stringify(await json(cleaned));
      expect([404, 410]).toContain(cleaned.status);
      expect(cleanedText).not.toContain('ticket-attachments');
      expect(cleanedText).not.toContain('D:\\');
      expect(cleanedText).not.toContain('/tmp/');

      const traversalTicket = await started.ticketStore.createTicket({
        type: 'datasheet_submission',
        title: 'Traversal attempt',
        attachments: [{
          id: 'traversal',
          status: 'pending',
          originalName: 'safe.txt',
          storedName: 'safe.txt',
          storagePath: '../outside.txt',
          uploadedAt: '2026-05-25T08:30:00.000Z'
        }]
      });
      const traversal = await fetch(`${started.baseUrl}/admin/tickets/${traversalTicket.ticketNo}/attachments/traversal/download`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const traversalText = JSON.stringify(await json(traversal));
      expect([403, 404]).toContain(traversal.status);
      expect(traversalText).not.toContain('ticket-attachments');
      expect(traversalText).not.toContain('D:\\');
      expect(traversalText).not.toContain('/tmp/');
    } finally {
      await closeServer(started.server);
    }
  });

  it('lets only admins preview text attachments without exposing storage metadata', async () => {
    const started = await startTicketServer();
    try {
      const uploadedContent = '# datasheet contribution\npinout table\n';
      const userToken = token(started, started.alice);
      const adminToken = token(started, started.admin!);
      const created = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: datasheetForm({
          title: 'Previewable datasheet',
          attachments: [{ name: 'preview-me.md', content: uploadedContent, type: 'text/markdown' }]
        })
      });
      const createdBody = await json(created);
      expect(created.status).toBe(201);

      const detail = await started.ticketStore.getTicket(createdBody.ticket.ticketNo);
      const attachment = detail.attachments[0];
      const previewPath = `/admin/tickets/${detail.ticketNo}/attachments/${attachment.id}/preview`;

      const publicResponse = await fetch(`${started.baseUrl}/api/tickets/${detail.ticketNo}/public`);
      const publicText = JSON.stringify(await json(publicResponse));
      expect(publicText).not.toContain('/preview');
      expect(publicText).not.toContain('attachments');

      const mine = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      const mineText = JSON.stringify(await json(mine));
      expect(mine.status).toBe(200);
      expect(mineText).not.toContain('/preview');
      expect(mineText).not.toContain('attachments');
      expect(mineText).not.toContain('preview-me.md');

      const noAuth = await fetch(`${started.baseUrl}${previewPath}`);
      expect([401, 403]).toContain(noAuth.status);

      const forbidden = await fetch(`${started.baseUrl}${previewPath}`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      expect(forbidden.status).toBe(403);

      const previewed = await fetch(`${started.baseUrl}${previewPath}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const previewBody = await json(previewed);
      const previewText = JSON.stringify(previewBody);
      expect(previewed.status).toBe(200);
      expect(previewBody).toMatchObject({
        ticketNo: detail.ticketNo,
        attachmentId: attachment.id,
        originalName: 'preview-me.md',
        previewText: uploadedContent,
        truncated: false
      });
      expect(previewText).not.toContain('storagePath');
      expect(previewText).not.toContain('storedName');
      expect(previewText).not.toContain('sha256');
      expect(previewText).not.toContain('ticket-attachments');
      expect(previewText).not.toContain('D:\\');
      expect(previewText).not.toContain('/tmp/');

      const pdfCreated = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        body: datasheetForm({
          title: 'PDF preview is unsupported',
          attachments: [{ name: 'no-preview.pdf', content: '%PDF-1.7\n', type: 'application/pdf' }]
        })
      });
      const pdfBody = await json(pdfCreated);
      const pdfDetail = await started.ticketStore.getTicket(pdfBody.ticket.ticketNo);
      const unsupported = await fetch(
        `${started.baseUrl}/admin/tickets/${pdfDetail.ticketNo}/attachments/${pdfDetail.attachments[0].id}/preview`,
        { headers: { Authorization: `Bearer ${adminToken}` } }
      );
      const unsupportedText = JSON.stringify(await json(unsupported));
      expect(unsupported.status).toBe(415);
      expect(unsupportedText).not.toContain('ticket-attachments');
      expect(unsupportedText).not.toContain('storagePath');
    } finally {
      await closeServer(started.server);
    }
  });

  it('lets admins review datasheet metadata candidates without catalog/search exposure', async () => {
    const started = await startTicketServer();
    try {
      const userToken = token(started, started.alice);
      const adminToken = token(started, started.admin!);
      const created = await fetch(`${started.baseUrl}/api/tickets/datasheet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: datasheetForm({
          title: 'Candidate datasheet',
          vendor: 'YuntuSemi',
          partNumberOrKeywords: 'YTM32B1ME0',
          attachments: [{ name: 'candidate.md', content: '# datasheet\n', type: 'text/markdown' }]
        })
      });
      const createdBody = await json(created);
      const ticketNo = createdBody.ticket.ticketNo;

      const userDenied = await fetch(`${started.baseUrl}/admin/tickets/${ticketNo}/datasheet-review`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${userToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'accepted' })
      });
      expect(userDenied.status).toBe(403);

      const accepted = await fetch(`${started.baseUrl}/admin/tickets/${ticketNo}/datasheet-review`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'accepted',
          publicNote: '收到并完成初审',
          internalNote: 'D:\\internal\\review should be redacted',
          metadataCandidate: {
            brand: 'YuntuSemi',
            productLine: 'Automotive MCU',
            application: 'Body control',
            chipId: 'YTM32B1ME0',
            documentId: 'doc-ytm32',
            scopePresetId: 'scope-ytm32-review',
            applicationTags: ['Body control'],
            serverPath: 'D:\\secret\\datasheet.pdf'
          },
          bindingNote: 'accepted only; not searchable'
        })
      });
      const acceptedBody = await json(accepted);
      const acceptedText = JSON.stringify(acceptedBody);
      expect(accepted.status).toBe(200);
      expect(acceptedBody.ticket.status).toBe('accepted');
      expect(acceptedBody.ticket.payload.uploadReview).toMatchObject({
        searchable: false,
        visibilityCandidate: 'restricted',
        catalogBinding: null,
        metadataCandidate: {
          brand: 'YuntuSemi',
          chipId: 'YTM32B1ME0',
          documentId: 'doc-ytm32',
          scopePresetId: 'scope-ytm32-review',
          resolution: {
            brand: 'known',
            productLine: 'known',
            application: 'known',
            chipId: 'known',
            documentId: 'known',
            scopePresetId: 'known'
          }
        },
        bindingIntent: {
          intent: 'accepted',
          searchable: false,
          visibility: 'restricted'
        }
      });
      expect(acceptedText).not.toContain('storagePath');
      expect(acceptedText).not.toContain('sha256');
      expect(acceptedText).not.toContain('fingerprint');
      expect(acceptedText).not.toContain('D:\\');
      expect(acceptedText).not.toContain('serverPath');

      const invalidTransition = await fetch(`${started.baseUrl}/admin/tickets/${ticketNo}/datasheet-review`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'rejected' })
      });
      expect(invalidTransition.status).toBe(400);

      const linked = await fetch(`${started.baseUrl}/admin/tickets/${ticketNo}/datasheet-review`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'linked' })
      });
      const linkedBody = await json(linked);
      expect(linked.status).toBe(200);
      expect(linkedBody.ticket.payload.uploadReview).toMatchObject({
        searchable: false,
        visibilityCandidate: 'restricted',
        catalogBinding: null,
        bindingIntent: { intent: 'linked', searchable: false, visibility: 'restricted' }
      });

      const mine = await fetch(`${started.baseUrl}/api/my/tickets`, {
        headers: { Authorization: `Bearer ${userToken}` }
      });
      const mineText = JSON.stringify(await json(mine));
      expect(mine.status).toBe(200);
      expect(mineText).toContain('linked');
      expect(mineText).not.toContain('metadataCandidate');
      expect(mineText).not.toContain('bindingIntent');
      expect(mineText).not.toContain('candidate.md');
      expect(mineText).not.toContain('doc-ytm32');
      expect(mineText).not.toContain('workspaceDir');
    } finally {
      await closeServer(started.server);
    }
  });

  it('rejects admin status updates that do not belong to the ticket type', async () => {
    const started = await startTicketServer();
    try {
      const ticket = await started.ticketStore.createTicket({ type: 'feedback', title: 'Bad status check' });
      const response = await fetch(`${started.baseUrl}/admin/tickets/${ticket.ticketNo}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token(started, started.admin!)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' })
      });

      expect(response.status).toBe(400);
    } finally {
      await closeServer(started.server);
    }
  });

  it('admin replies are user-visible, internal messages stay admin-only, non-admin reply is rejected (B8)', async () => {
    const started = await startTicketServer();
    try {
      const created = await started.ticketStore.createTicket({
        type: 'feedback',
        title: 'Need a reply',
        accountBinding: { userId: started.alice.id, username: started.alice.username, role: 'customer' }
      });
      const adminToken = token(started, started.admin!);

      const reply = await fetch(`${started.baseUrl}/admin/tickets/${created.ticketNo}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'We are looking into it.' })
      });
      expect(reply.status).toBe(200);
      const replyBody = await json(reply);
      expect(replyBody.ticket.messages).toHaveLength(1);
      expect(replyBody.ticket.messages[0].audience).toBe('user');

      const internal = await fetch(`${started.baseUrl}/admin/tickets/${created.ticketNo}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'internal triage note', audience: 'internal' })
      });
      expect(internal.status).toBe(200);

      const publicResp = await fetch(`${started.baseUrl}/api/tickets/${created.ticketNo}/public`);
      const publicBody = await json(publicResp);
      expect(publicBody.ticket.messages).toHaveLength(1);
      expect(publicBody.ticket.messages[0].text).toBe('We are looking into it.');
      expect(JSON.stringify(publicBody)).not.toContain('internal triage note');

      const adminDetail = await fetch(`${started.baseUrl}/admin/tickets/${created.ticketNo}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const adminBody = await json(adminDetail);
      expect(adminBody.ticket.messages).toHaveLength(2);

      const forbidden = await fetch(`${started.baseUrl}/admin/tickets/${created.ticketNo}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token(started, started.alice)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'I should not be allowed' })
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await closeServer(started.server);
    }
  });
});
