import { Readable } from 'node:stream';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredPendingTicketAttachments,
  buildDatasheetUploadReview,
  getTicketAttachmentReviewRoot,
  parseDatasheetSubmissionMultipart,
  parseFeedbackTicketMultipart,
  resolveTicketAttachmentPreview,
  TicketAttachmentUploadError,
  TicketStore
} from '../src/tickets/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-ticket-attachments-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function multipartRequest(parts: Array<{
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  content?: Buffer | string;
}>): IncomingMessage {
  const boundary = `----agentx-test-${Math.random().toString(16).slice(2)}`;
  return multipartRequestFromChunks(boundary, multipartBody(boundary, parts));
}

function multipartBody(boundary: string, parts: Array<{
  name: string;
  value?: string;
  filename?: string;
  contentType?: string;
  content?: Buffer | string;
}>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`
      ));
      chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content ?? 'file'));
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value ?? ''}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function multipartRequestFromChunks(boundary: string, body: Buffer, chunkSizes?: number[]): IncomingMessage {
  const chunks: Buffer[] = [];
  if (!chunkSizes?.length) {
    chunks.push(body);
  } else {
    let offset = 0;
    let index = 0;
    while (offset < body.length) {
      const size = Math.max(1, chunkSizes[index % chunkSizes.length] ?? 1);
      chunks.push(body.subarray(offset, Math.min(body.length, offset + size)));
      offset += size;
      index += 1;
    }
  }
  const stream = Readable.from(chunks) as IncomingMessage;
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return stream;
}

function feedbackParts(extraParts: Parameters<typeof multipartRequest>[0] = []) {
  return [
    { name: 'title', value: 'Upload feedback' },
    { name: 'content', value: 'Please review the attached material.' },
    { name: 'category', value: 'bug' },
    ...extraParts
  ];
}

function contentForExtension(extension: string): Buffer | string {
  if (extension === '.pdf') return '%PDF-1.7\n';
  if (extension === '.zip') return Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  if (extension === '.7z') return Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
  return 'int main(void) { return 0; }\n';
}

function datasheetParts(extraParts: Parameters<typeof multipartRequest>[0] = []) {
  return [
    { name: 'title', value: 'YTM32B1ME0 datasheet' },
    { name: 'vendor', value: 'Yuntu' },
    { name: 'partNumberOrKeywords', value: 'YTM32B1ME0' },
    { name: 'sourceNote', value: 'official public web page' },
    { name: 'sourceDeclaration', value: 'official public web page' },
    { name: 'disclaimerAccepted', value: 'on' },
    { name: 'contact', value: 'engineer@example.com' },
    { name: 'note', value: 'Please review this contribution.' },
    ...extraParts
  ];
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        output.push(fullPath);
      }
    }
  }
  await walk(root);
  return output;
}

describe('ticket attachment multipart handling', () => {
  it('accepts the feedback attachment extension allowlist', async () => {
    for (const extension of ['.pdf', '.zip', '.7z', '.md', '.markdown', '.txt', '.c', '.h', '.cs', '.cpp', '.cxx', '.cc', '.hpp', '.hh']) {
      const dataDir = await tempDir();
      const parsed = await parseFeedbackTicketMultipart(
        multipartRequest(feedbackParts([
          { name: 'attachments', filename: `sample${extension}`, content: contentForExtension(extension) }
        ])),
        { dataDir, now: new Date('2026-05-25T08:30:00.000Z') }
      );

      expect(parsed.fields.title).toBe('Upload feedback');
      expect(parsed.attachments).toHaveLength(1);
      expect(parsed.attachments[0].originalName).toBe(`sample${extension}`);
      expect(parsed.attachments[0].storedName?.endsWith(extension)).toBe(true);
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('previews text and code attachments by ticket and attachment id only', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const ticket = await store.createTicket({ type: 'datasheet_submission', title: 'Preview source' });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const filePath = path.join(reviewRoot, '2026', '05', ticket.ticketNo, 'firmware.cpp');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'int main(void) { return 0; }\n', 'utf8');
    await store.replaceTicketAttachments(ticket.ticketNo, [{
      id: 'code-preview',
      status: 'pending',
      originalName: 'firmware.cpp',
      storedName: 'firmware.cpp',
      mimeType: 'text/x-c++src',
      storagePath: `2026/05/${ticket.ticketNo}/firmware.cpp`,
      uploadedAt: '2026-05-25T08:30:00.000Z'
    }]);

    const preview = await resolveTicketAttachmentPreview({
      ticketStore: store,
      dataDir,
      ticketNo: ticket.ticketNo,
      attachmentId: 'code-preview'
    });

    expect(preview).toMatchObject({
      ticketNo: ticket.ticketNo,
      attachmentId: 'code-preview',
      originalName: 'firmware.cpp',
      previewText: 'int main(void) { return 0; }\n',
      truncated: false,
      bytesRead: 29
    });
    expect(JSON.stringify(preview)).not.toContain('storagePath');
    expect(JSON.stringify(preview)).not.toContain('storedName');
    expect(JSON.stringify(preview)).not.toContain('sha256');
    expect(JSON.stringify(preview)).not.toContain('ticket-attachments');
  });

  it('truncates large text previews at the configured byte limit', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const ticket = await store.createTicket({ type: 'feedback', title: 'Large preview' });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const filePath = path.join(reviewRoot, '2026', '05', ticket.ticketNo, 'notes.md');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'abcdef', 'utf8');
    await store.replaceTicketAttachments(ticket.ticketNo, [{
      id: 'large-preview',
      status: 'pending',
      originalName: 'notes.md',
      storedName: 'notes.md',
      storagePath: `2026/05/${ticket.ticketNo}/notes.md`,
      uploadedAt: '2026-05-25T08:30:00.000Z'
    }]);

    const preview = await resolveTicketAttachmentPreview({
      ticketStore: store,
      dataDir,
      ticketNo: ticket.ticketNo,
      attachmentId: 'large-preview',
      maxBytes: 4
    });

    expect(preview.previewText).toBe('abcd');
    expect(preview.truncated).toBe(true);
    expect(preview.bytesRead).toBe(4);
  });

  it('rejects binary, cleaned, and traversal preview attempts without leaking local paths', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const ticket = await store.createTicket({ type: 'datasheet_submission', title: 'Unsafe preview' });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const ticketDir = path.join(reviewRoot, '2026', '05', ticket.ticketNo);
    await mkdir(ticketDir, { recursive: true });
    await writeFile(path.join(ticketDir, 'manual.pdf'), '%PDF-1.7\n', 'utf8');
    await writeFile(path.join(ticketDir, 'archive.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(path.join(ticketDir, 'archive.7z'), Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]));
    await store.replaceTicketAttachments(ticket.ticketNo, [
      {
        id: 'pdf-preview',
        status: 'pending',
        originalName: 'manual.pdf',
        storedName: 'manual.pdf',
        storagePath: `2026/05/${ticket.ticketNo}/manual.pdf`
      },
      {
        id: 'zip-preview',
        status: 'pending',
        originalName: 'archive.zip',
        storedName: 'archive.zip',
        storagePath: `2026/05/${ticket.ticketNo}/archive.zip`
      },
      {
        id: 'seven-z-preview',
        status: 'pending',
        originalName: 'archive.7z',
        storedName: 'archive.7z',
        storagePath: `2026/05/${ticket.ticketNo}/archive.7z`
      },
      {
        id: 'cleaned-preview',
        status: 'cleaned',
        originalName: 'cleaned.md',
        storedName: 'cleaned.md',
        storagePath: `2026/05/${ticket.ticketNo}/cleaned.md`
      },
      {
        id: 'traversal-preview',
        status: 'pending',
        originalName: 'outside.md',
        storedName: 'outside.md',
        storagePath: '../outside.md'
      }
    ]);

    for (const attachmentId of ['pdf-preview', 'zip-preview', 'seven-z-preview']) {
      await expect(resolveTicketAttachmentPreview({
        ticketStore: store,
        dataDir,
        ticketNo: ticket.ticketNo,
        attachmentId
      })).rejects.toMatchObject({ statusCode: 415, message: 'Attachment preview is not supported' });
    }
    await expect(resolveTicketAttachmentPreview({
      ticketStore: store,
      dataDir,
      ticketNo: ticket.ticketNo,
      attachmentId: 'cleaned-preview'
    })).rejects.toMatchObject({ statusCode: 410 });
    await expect(resolveTicketAttachmentPreview({
      ticketStore: store,
      dataDir,
      ticketNo: ticket.ticketNo,
      attachmentId: 'traversal-preview'
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects disallowed extensions and removes temporary files', async () => {
    for (const extension of ['.exe', '.html']) {
      const dataDir = await tempDir();
      await expect(
        parseFeedbackTicketMultipart(
          multipartRequest(feedbackParts([
            { name: 'attachments', filename: `bad${extension}`, content: 'bad' }
          ])),
          { dataDir }
        )
      ).rejects.toBeInstanceOf(TicketAttachmentUploadError);
      expect(await listFiles(getTicketAttachmentReviewRoot(dataDir))).toHaveLength(0);
    }
  });

  it('enforces attachment count and total size limits with rollback', async () => {
    const tooManyDir = await tempDir();
    await expect(
      parseFeedbackTicketMultipart(
        multipartRequest(feedbackParts([
          { name: 'attachments', filename: 'a.txt', content: 'a' },
          { name: 'attachments', filename: 'b.txt', content: 'b' },
          { name: 'attachments', filename: 'c.txt', content: 'c' },
          { name: 'attachments', filename: 'd.txt', content: 'd' }
        ])),
        { dataDir: tooManyDir }
      )
    ).rejects.toBeInstanceOf(TicketAttachmentUploadError);
    expect(await listFiles(getTicketAttachmentReviewRoot(tooManyDir))).toHaveLength(0);

    const tooLargeDir = await tempDir();
    await expect(
      parseFeedbackTicketMultipart(
        multipartRequest(feedbackParts([
          { name: 'attachments', filename: 'a.txt', content: '123456' },
          { name: 'attachments', filename: 'b.txt', content: '7890' }
        ])),
        { dataDir: tooLargeDir, limits: { maxTotalBytes: 8 } }
      )
    ).rejects.toMatchObject({ statusCode: 413 });
    expect(await listFiles(getTicketAttachmentReviewRoot(tooLargeDir))).toHaveLength(0);
  });

  it('rejects unknown multipart file fields instead of skipping limits', async () => {
    const dataDir = await tempDir();

    await expect(
      parseFeedbackTicketMultipart(
        multipartRequest(feedbackParts([
          { name: 'avatar', filename: 'avatar.txt', content: 'unexpected file field' }
        ])),
        { dataDir }
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Unknown attachment file field' });
    expect(await listFiles(getTicketAttachmentReviewRoot(dataDir))).toHaveLength(0);
  });

  it('parses multipart boundary control bytes split across chunks', async () => {
    const dataDir = await tempDir();
    const boundary = '----agentx-boundary-split-test';
    const body = multipartBody(boundary, feedbackParts([
      { name: 'attachments', filename: 'first.txt', content: 'first file' },
      { name: 'attachments', filename: 'second.md', content: 'second file' }
    ]));
    const delimiter = Buffer.from(`\r\n--${boundary}`);
    const splitAtDelimiterControl = body.indexOf(delimiter) + delimiter.length;
    expect(splitAtDelimiterControl).toBeGreaterThan(delimiter.length);

    const parsed = await parseFeedbackTicketMultipart(
      multipartRequestFromChunks(boundary, body, [splitAtDelimiterControl, 1, 3]),
      { dataDir }
    );

    expect(parsed.fields).toMatchObject({
      title: 'Upload feedback',
      content: 'Please review the attached material.',
      category: 'bug'
    });
    expect(parsed.attachments.map((item) => item.originalName)).toEqual(['first.txt', 'second.md']);
  });

  it('survives byte-by-byte multipart chunking through all boundaries', async () => {
    const dataDir = await tempDir();
    const boundary = '----agentx-byte-fuzz-test';
    const parsed = await parseFeedbackTicketMultipart(
      multipartRequestFromChunks(boundary, multipartBody(boundary, feedbackParts([
        { name: 'attachments', filename: 'first.txt', content: 'first' },
        { name: 'attachments', filename: 'second.md', content: 'second' }
      ])), [1]),
      { dataDir }
    );

    expect(parsed.fields.title).toBe('Upload feedback');
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0].sizeBytes).toBe(5);
    expect(parsed.attachments[1].sizeBytes).toBe(6);
  });

  it('keeps feedback parser compatibility after sharing the parser', async () => {
    const dataDir = await tempDir();
    const parsed = await parseFeedbackTicketMultipart(
      multipartRequest(feedbackParts([
        { name: 'attachments', filename: 'notes.md', content: '# repro\n' }
      ])),
      { dataDir, now: new Date('2026-05-25T08:30:00.000Z') }
    );

    expect(parsed.fields).toMatchObject({
      title: 'Upload feedback',
      content: 'Please review the attached material.',
      category: 'bug',
      hasAttachments: false
    });
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].originalName).toBe('notes.md');
  });

  it('requires at least one datasheet submission attachment', async () => {
    const dataDir = await tempDir();
    await expect(
      parseDatasheetSubmissionMultipart(multipartRequest(datasheetParts()), { dataDir })
    ).rejects.toMatchObject({ statusCode: 400, message: 'Datasheet attachment is required' });
  });

  it('removes temporary files when datasheet field validation fails after upload', async () => {
    const dataDir = await tempDir();
    await expect(
      parseDatasheetSubmissionMultipart(
        multipartRequest([
          { name: 'vendor', value: 'Yuntu' },
          { name: 'attachments', filename: 'orphan.md', content: '# uploaded before validation\n' }
        ]),
        { dataDir }
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Datasheet title is required' });
    expect(await listFiles(getTicketAttachmentReviewRoot(dataDir))).toHaveLength(0);
  });

  it('normalizes datasheet fields and validates attachment content samples', async () => {
    const dataDir = await tempDir();
    const parsed = await parseDatasheetSubmissionMultipart(
      multipartRequest(datasheetParts([
        { name: 'attachments', filename: 'ytm32.pdf', contentType: 'application/pdf', content: '%PDF-1.7\nbody' }
      ])),
      { dataDir }
    );

    expect(parsed.fields).toEqual({
      title: 'YTM32B1ME0 datasheet',
      vendor: 'Yuntu',
      partNumberOrKeywords: 'YTM32B1ME0',
      sourceNote: 'official public web page',
      sourceDeclaration: 'official public web page',
      contact: 'engineer@example.com',
      note: 'Please review this contribution.',
      disclaimerAccepted: true
    });
    expect(parsed.attachments).toHaveLength(1);

    await expect(
      parseDatasheetSubmissionMultipart(
        multipartRequest(datasheetParts([
          { name: 'attachments', filename: 'fake.pdf', contentType: 'application/pdf', content: 'not a PDF' }
        ])),
        { dataDir: await tempDir() }
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Attachment content does not match its extension' });
  });

  it('rejects datasheet submissions without declaration and blocks path traversal filenames', async () => {
    const dataDir = await tempDir();
    await expect(
      parseDatasheetSubmissionMultipart(
        multipartRequest([
          { name: 'title', value: 'Missing declaration' },
          { name: 'attachments', filename: 'safe.md', content: '# safe\n' }
        ]),
        { dataDir }
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Datasheet submission declaration is required' });

    await expect(
      parseDatasheetSubmissionMultipart(
        multipartRequest(datasheetParts([
          { name: 'attachments', filename: '..\\outside.md', content: '# traversal\n' }
        ])),
        { dataDir: await tempDir() }
      )
    ).rejects.toMatchObject({ statusCode: 400, message: 'Attachment filename is not allowed' });
  });

  it('returns a redacted scan contract and quarantines archives without exposing paths', async () => {
    const dataDir = await tempDir();
    const parsed = await parseDatasheetSubmissionMultipart(
      multipartRequest(datasheetParts([
        { name: 'attachments', filename: 'archive.zip', contentType: 'application/zip', content: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }
      ])),
      { dataDir }
    );

    const review = buildDatasheetUploadReview(parsed.fields, parsed.attachments, {
      now: new Date('2026-05-25T08:30:00.000Z')
    });
    const text = JSON.stringify(review);

    expect(review).toMatchObject({
      state: 'quarantined',
      searchable: false,
      visibilityCandidate: 'restricted',
      catalogBinding: null,
      securityScan: {
        status: 'not_supported',
        policyVersion: 'phase39-local-v1'
      }
    });
    expect(review.securityScan.attachments[0]).toMatchObject({
      normalizedName: 'archive.zip',
      extension: '.zip',
      isArchive: true,
      status: 'not_supported',
      fingerprint: expect.any(String)
    });
    expect(text).not.toContain('storagePath');
    expect(text).not.toContain('absolutePath');
    expect(text).not.toContain('ticket-attachments');
    expect(text).not.toContain('D:\\');
    expect(text).not.toContain('/tmp/');
  });
});

describe('ticket attachment retention cleanup', () => {
  it('cleans only expired pending review attachments inside the review root', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const ticket = await store.createTicket({
      type: 'feedback',
      title: 'Retention check',
      attachments: [
        {
          id: 'old-pending',
          status: 'pending',
          storedName: 'old.txt',
          storagePath: '2026/05/FB-20260525-0001/old.txt',
          uploadedAt: '2026-04-24T00:00:00.000Z'
        },
        {
          id: 'fresh-pending',
          status: 'pending',
          storedName: 'fresh.txt',
          storagePath: '2026/05/FB-20260525-0001/fresh.txt',
          uploadedAt: '2026-04-27T00:00:00.000Z'
        },
        {
          id: 'accepted-old',
          status: 'accepted',
          storedName: 'accepted.txt',
          storagePath: '2026/05/FB-20260525-0001/accepted.txt',
          uploadedAt: '2026-04-01T00:00:00.000Z'
        },
        {
          id: 'retained-old',
          status: 'pending',
          storedName: 'retained.txt',
          storagePath: '2026/05/FB-20260525-0001/retained.txt',
          uploadedAt: '2026-04-01T00:00:00.000Z',
          retainedAt: '2026-04-02T00:00:00.000Z'
        },
        {
          id: 'outside-path',
          status: 'pending',
          storedName: 'outside.txt',
          storagePath: '../outside.txt',
          uploadedAt: '2026-04-01T00:00:00.000Z'
        }
      ]
    });
    const ticketDir = path.join(reviewRoot, '2026', '05', ticket.ticketNo);
    await mkdir(ticketDir, { recursive: true });
    for (const name of ['old.txt', 'fresh.txt', 'accepted.txt', 'retained.txt']) {
      await writeFile(path.join(ticketDir, name), name, 'utf8');
    }
    const outsidePath = path.join(dataDir, 'ticket-attachments', 'outside.txt');
    await mkdir(path.dirname(outsidePath), { recursive: true });
    await writeFile(outsidePath, 'outside', 'utf8');

    const result = await cleanupExpiredPendingTicketAttachments({
      ticketStore: store,
      dataDir,
      now: new Date('2026-05-25T08:30:00.000Z')
    });

    expect(result).toEqual({ scanned: 5, cleaned: 1 });
    await expect(stat(path.join(ticketDir, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(ticketDir, 'fresh.txt'))).resolves.toBeTruthy();
    await expect(stat(path.join(ticketDir, 'accepted.txt'))).resolves.toBeTruthy();
    await expect(stat(path.join(ticketDir, 'retained.txt'))).resolves.toBeTruthy();
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe('outside');

    const updated = await store.getTicket(ticket.ticketNo);
    expect(updated.attachments.find((item) => item.id === 'old-pending')).toMatchObject({
      status: 'cleaned',
      cleanedReason: 'expired_pending_retention_30_days'
    });
    expect(updated.attachments.find((item) => item.id === 'fresh-pending')?.status).toBe('pending');
    expect(updated.attachments.find((item) => item.id === 'accepted-old')?.status).toBe('accepted');
    expect(updated.attachments.find((item) => item.id === 'retained-old')?.status).toBe('pending');
    expect(updated.attachments.find((item) => item.id === 'outside-path')?.status).toBe('pending');
  });

  it('keeps pending attachments on processed tickets', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const tickets = await Promise.all([
      store.createTicket({
        type: 'feedback',
        title: 'Accepted feedback',
        status: 'accepted',
        attachments: [{ id: 'accepted-ticket', status: 'pending', storedName: 'accepted.txt', storagePath: '2026/05/FB-20260525-0001/accepted.txt', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'feedback',
        title: 'Closed feedback',
        status: 'closed',
        attachments: [{ id: 'closed-ticket', status: 'pending', storedName: 'closed.txt', storagePath: '2026/05/FB-20260525-0002/closed.txt', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Archived datasheet',
        status: 'archived',
        attachments: [{ id: 'archived-ticket', status: 'pending', storedName: 'archived.txt', storagePath: '2026/05/DS-20260525-0003/archived.txt', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'account_application',
        title: 'Approved account',
        status: 'approved',
        attachments: [{ id: 'approved-ticket', status: 'pending', storedName: 'approved.txt', storagePath: '2026/05/AP-20260525-0004/approved.txt', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'account_application',
        title: 'Rejected account',
        status: 'rejected',
        attachments: [{ id: 'rejected-ticket', status: 'pending', storedName: 'rejected.txt', storagePath: '2026/05/AP-20260525-0005/rejected.txt', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      })
    ]);

    for (const ticket of tickets) {
      const attachment = ticket.attachments[0];
      const filePath = path.join(reviewRoot, attachment.storagePath!);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, ticket.ticketNo, 'utf8');
    }

    const result = await cleanupExpiredPendingTicketAttachments({
      ticketStore: store,
      dataDir,
      now: new Date('2026-05-25T08:30:00.000Z')
    });

    expect(result).toEqual({ scanned: 5, cleaned: 0 });
    for (const ticket of tickets) {
      const updated = await store.getTicket(ticket.ticketNo);
      expect(updated.attachments[0].status).toBe('pending');
      await expect(stat(path.join(reviewRoot, updated.attachments[0].storagePath!))).resolves.toBeTruthy();
    }
  });

  it('applies datasheet_submission pending retention without deleting processed statuses', async () => {
    const dataDir = await tempDir();
    const store = new TicketStore({ dataDir, now: () => new Date('2026-05-25T08:30:00.000Z') });
    const reviewRoot = getTicketAttachmentReviewRoot(dataDir);
    const tickets = await Promise.all([
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Expired submitted datasheet',
        status: 'submitted',
        attachments: [{ id: 'expired-submitted', status: 'pending', storedName: 'submitted.pdf', storagePath: '2026/05/DS-20260525-0001/submitted.pdf', uploadedAt: '2026-04-24T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Fresh reviewing datasheet',
        status: 'reviewing',
        attachments: [{ id: 'fresh-reviewing', status: 'pending', storedName: 'reviewing.pdf', storagePath: '2026/05/DS-20260525-0002/reviewing.pdf', uploadedAt: '2026-04-26T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Accepted datasheet',
        status: 'accepted',
        attachments: [{ id: 'accepted-ds', status: 'pending', storedName: 'accepted.pdf', storagePath: '2026/05/DS-20260525-0003/accepted.pdf', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Archived datasheet',
        status: 'archived',
        attachments: [{ id: 'archived-ds', status: 'pending', storedName: 'archived.pdf', storagePath: '2026/05/DS-20260525-0004/archived.pdf', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      }),
      store.createTicket({
        type: 'datasheet_submission',
        title: 'Closed datasheet',
        status: 'closed',
        attachments: [{ id: 'closed-ds', status: 'pending', storedName: 'closed.pdf', storagePath: '2026/05/DS-20260525-0005/closed.pdf', uploadedAt: '2026-04-01T00:00:00.000Z' }]
      })
    ]);

    for (const ticket of tickets) {
      const attachment = ticket.attachments[0];
      const filePath = path.join(reviewRoot, attachment.storagePath!);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, '%PDF-1.7\n', 'utf8');
    }

    const result = await cleanupExpiredPendingTicketAttachments({
      ticketStore: store,
      dataDir,
      now: new Date('2026-05-25T08:30:00.000Z')
    });

    expect(result).toEqual({ scanned: 5, cleaned: 1 });
    const submitted = await store.getTicket(tickets[0].ticketNo);
    expect(submitted.attachments[0]).toMatchObject({
      status: 'cleaned',
      cleanedReason: 'expired_pending_retention_30_days'
    });
    await expect(stat(path.join(reviewRoot, submitted.attachments[0].storagePath!))).rejects.toMatchObject({ code: 'ENOENT' });

    for (const ticket of tickets.slice(1)) {
      const updated = await store.getTicket(ticket.ticketNo);
      expect(updated.attachments[0].status).toBe('pending');
      await expect(stat(path.join(reviewRoot, updated.attachments[0].storagePath!))).resolves.toBeTruthy();
    }
  });
});
