import crypto from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { TicketValidationError } from './sanitize.js';
import type { TicketStore } from './store.js';
import type {
  DatasheetUploadReviewPayload,
  DatasheetUploadReviewState,
  TicketAttachmentMeta,
  TicketSecurityScanStatus
} from './types.js';

export const TICKET_ATTACHMENT_LIMITS = {
  maxFiles: 3,
  maxFileBytes: 100 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  retentionDays: 30
} as const;

export const FEEDBACK_ATTACHMENT_LIMITS = TICKET_ATTACHMENT_LIMITS;

export const ALLOWED_TICKET_ATTACHMENT_EXTENSIONS = new Set([
  '.pdf',
  '.zip',
  '.7z',
  '.md',
  '.markdown',
  '.txt',
  '.c',
  '.h',
  '.cs',
  '.cpp',
  '.cxx',
  '.cc',
  '.hpp',
  '.hh'
]);

export const TEXT_PREVIEW_ATTACHMENT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.c',
  '.h',
  '.cs',
  '.cpp',
  '.cxx',
  '.cc',
  '.hpp',
  '.hh'
]);

const DEFAULT_TEXT_PREVIEW_MAX_BYTES = 128 * 1024;

export interface FeedbackTicketFields {
  title: string;
  content: string;
  category?: string;
  contact?: string;
  hasAttachments: boolean;
}

export interface DatasheetSubmissionFields {
  title: string;
  vendor?: string;
  partNumberOrKeywords?: string;
  sourceNote?: string;
  sourceDeclaration?: string;
  contact?: string;
  note?: string;
  disclaimerAccepted: boolean;
}

export type TemporaryTicketAttachment = TicketAttachmentMeta & {
  absolutePath: string;
};

export class TicketAttachmentUploadError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

interface MultipartLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
}

interface ParseFeedbackTicketMultipartOptions {
  dataDir: string;
  now?: Date;
  requestId?: string;
  limits?: Partial<MultipartLimits>;
}

interface ParseTicketSubmissionMultipartOptions extends ParseFeedbackTicketMultipartOptions {
  expectedMultipartMessage?: string;
  fieldTooLargeMessage?: string;
}

interface FinalizeTicketAttachmentOptions {
  dataDir: string;
  ticketNo: string;
}

interface CleanupExpiredPendingTicketAttachmentsOptions {
  ticketStore: TicketStore;
  dataDir: string;
  now?: Date;
  retentionDays?: number;
}

type ActivePart =
  | {
      kind: 'field';
      name: string;
      chunks: Buffer[];
      sizeBytes: number;
      maxBytes: number;
    }
  | {
      kind: 'file';
      name: string;
      originalName: string;
      storedName: string;
      mimeType?: string;
      absolutePath: string;
      storagePath: string;
      uploadedAt: string;
      retentionUntil: string;
      handle: FileHandle;
      hash: crypto.Hash;
      sample: Buffer[];
      sampleBytes: number;
      sizeBytes: number;
    }
  | {
      kind: 'skip';
    };

const PROCESSED_TICKET_STATUSES = new Set(['accepted', 'archived', 'closed', 'approved', 'rejected']);
const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC_HEADERS = [
  Buffer.from('PK\x03\x04', 'latin1'),
  Buffer.from('PK\x05\x06', 'latin1'),
  Buffer.from('PK\x07\x08', 'latin1')
];
const SEVEN_Z_MAGIC = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const DANGEROUS_MIME_PATTERN = /(?:text\/html|application\/x-msdownload|application\/x-msdos-program|application\/x-sh|application\/javascript|text\/javascript)/i;

export async function parseTicketSubmissionMultipart(
  request: IncomingMessage,
  options: ParseTicketSubmissionMultipartOptions
): Promise<{ fields: Record<string, string>; attachments: TemporaryTicketAttachment[] }> {
  const boundary = parseMultipartBoundary(request.headers['content-type']);
  if (!boundary) {
    throw new TicketAttachmentUploadError(400, options.expectedMultipartMessage ?? 'Expected multipart ticket submission form');
  }

  const limits = { ...FEEDBACK_ATTACHMENT_LIMITS, ...options.limits };
  const now = options.now ?? new Date();
  const uploadedAt = now.toISOString();
  const retentionUntil = new Date(now.getTime() + limits.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const requestId = safePathSegment(options.requestId ?? crypto.randomUUID());
  const reviewRoot = getTicketAttachmentReviewRoot(options.dataDir);
  const tempDir = path.join(reviewRoot, 'tmp', requestId);
  const fields: Record<string, string> = {};
  const attachments: TemporaryTicketAttachment[] = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const delimiterBuffer = Buffer.from(`\r\n--${boundary}`);
  let buffer = Buffer.alloc(0);
  let state: 'preamble' | 'headers' | 'body' | 'done' = 'preamble';
  let activePart: ActivePart | undefined;
  let totalFileBytes = 0;

  const writePartData = async (data: Buffer) => {
    if (!activePart || activePart.kind === 'skip' || data.length === 0) {
      return;
    }
    if (activePart.kind === 'field') {
      activePart.sizeBytes += data.length;
      if (activePart.sizeBytes > activePart.maxBytes) {
        throw new TicketAttachmentUploadError(400, options.fieldTooLargeMessage ?? 'Ticket submission field is too large');
      }
      activePart.chunks.push(data);
      return;
    }

    const nextFileSize = activePart.sizeBytes + data.length;
    const nextTotalSize = totalFileBytes + data.length;
    if (nextFileSize > limits.maxFileBytes || nextTotalSize > limits.maxTotalBytes) {
      throw new TicketAttachmentUploadError(413, 'Attachment is too large');
    }
    activePart.sizeBytes = nextFileSize;
    totalFileBytes = nextTotalSize;
    if (activePart.sampleBytes < 16) {
      const sampleChunk = data.subarray(0, 16 - activePart.sampleBytes);
      activePart.sample.push(sampleChunk);
      activePart.sampleBytes += sampleChunk.length;
    }
    activePart.hash.update(data);
    await activePart.handle.write(data);
  };

  const finishPart = async () => {
    if (!activePart) {
      return;
    }
    if (activePart.kind === 'field') {
      fields[activePart.name] = Buffer.concat(activePart.chunks).toString('utf8').trim();
    } else if (activePart.kind === 'file') {
      await activePart.handle.close();
      validateAttachmentContent(activePart.originalName, Buffer.concat(activePart.sample));
      attachments.push({
        id: crypto.randomUUID(),
        status: 'pending',
        originalName: activePart.originalName,
        storedName: activePart.storedName,
        mimeType: activePart.mimeType,
        sizeBytes: activePart.sizeBytes,
        sha256: activePart.hash.digest('hex'),
        storagePath: activePart.storagePath,
        uploadedAt: activePart.uploadedAt,
        retentionUntil: activePart.retentionUntil,
        absolutePath: activePart.absolutePath
      });
    }
    activePart = undefined;
  };

  const startPart = async (rawHeaders: string) => {
    const headers = parsePartHeaders(rawHeaders);
    const disposition = parseContentDisposition(headers.get('content-disposition'));
    const name = disposition.name;
    if (!name) {
      if (disposition.filename !== undefined && disposition.filename !== '') {
        throw new TicketAttachmentUploadError(400, 'Unknown attachment file field');
      }
      activePart = { kind: 'skip' };
      return;
    }

    if (disposition.filename === undefined || disposition.filename === '') {
      activePart = {
        kind: 'field',
        name,
        chunks: [],
        sizeBytes: 0,
        maxBytes: fieldLimitBytes(name)
      };
      return;
    }

    if (!isAttachmentFieldName(name)) {
      throw new TicketAttachmentUploadError(400, 'Unknown attachment file field');
    }
    if (attachments.length >= limits.maxFiles) {
      throw new TicketAttachmentUploadError(400, 'Too many attachments');
    }

    const originalName = sanitizeOriginalName(disposition.filename);
    const extension = path.extname(originalName).toLowerCase();
    if (!ALLOWED_TICKET_ATTACHMENT_EXTENSIONS.has(extension)) {
      throw new TicketAttachmentUploadError(400, 'Attachment type is not allowed');
    }
    validateAttachmentMime(extension, headers.get('content-type'));

    await mkdir(tempDir, { recursive: true });
    const storedName = `${crypto.randomUUID()}${extension}`;
    const absolutePath = path.join(tempDir, storedName);
    activePart = {
      kind: 'file',
      name,
      originalName,
      storedName,
      mimeType: headers.get('content-type')?.slice(0, 120),
      absolutePath,
      storagePath: toStoragePath('tmp', requestId, storedName),
      uploadedAt,
      retentionUntil,
      handle: await open(absolutePath, 'wx'),
      hash: crypto.createHash('sha256'),
      sample: [],
      sampleBytes: 0,
      sizeBytes: 0
    };
  };

  const processBuffer = async (flush: boolean) => {
    while (state !== 'done') {
      if (state === 'preamble') {
        const index = buffer.indexOf(boundaryBuffer);
        if (index === -1) {
          if (flush) {
            throw new TicketAttachmentUploadError(400, 'Invalid multipart body');
          }
          buffer = buffer.slice(Math.max(0, buffer.length - boundaryBuffer.length - 4));
          return;
        }
        const controlStart = index + boundaryBuffer.length;
        if (!flush && buffer.length < controlStart + 2) {
          return;
        }
        buffer = buffer.slice(controlStart);
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) {
          state = 'done';
          return;
        }
        if (buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) {
          buffer = buffer.slice(2);
          state = 'headers';
          continue;
        }
        if (!flush && buffer.length < 2) {
          return;
        }
        throw new TicketAttachmentUploadError(400, 'Invalid multipart boundary');
      }

      if (state === 'headers') {
        const index = buffer.indexOf('\r\n\r\n');
        if (index === -1) {
          if (flush) {
            throw new TicketAttachmentUploadError(400, 'Invalid multipart headers');
          }
          return;
        }
        const rawHeaders = buffer.subarray(0, index).toString('latin1');
        buffer = buffer.slice(index + 4);
        await startPart(rawHeaders);
        state = 'body';
        continue;
      }

      const index = buffer.indexOf(delimiterBuffer);
      if (index !== -1) {
        const controlStart = index + delimiterBuffer.length;
        if (!flush && buffer.length < controlStart + 2) {
          return;
        }
        await writePartData(buffer.subarray(0, index));
        buffer = buffer.slice(controlStart);
        await finishPart();
        if (buffer.subarray(0, 2).equals(Buffer.from('--'))) {
          buffer = buffer.slice(2);
          state = 'done';
          return;
        }
        if (buffer.subarray(0, 2).equals(Buffer.from('\r\n'))) {
          buffer = buffer.slice(2);
          state = 'headers';
          continue;
        }
        throw new TicketAttachmentUploadError(400, 'Invalid multipart boundary');
      }

      const safeLength = buffer.length - delimiterBuffer.length - 4;
      if (safeLength > 0) {
        await writePartData(buffer.subarray(0, safeLength));
        buffer = buffer.slice(safeLength);
        continue;
      }
      if (flush) {
        throw new TicketAttachmentUploadError(400, 'Unterminated multipart body');
      }
      return;
    }
  };

  try {
    for await (const chunk of request) {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      await processBuffer(false);
    }
    await processBuffer(true);
    return { fields, attachments };
  } catch (error) {
    if (activePart?.kind === 'file') {
      await activePart.handle.close().catch(() => undefined);
      await rm(activePart.absolutePath, { force: true }).catch(() => undefined);
    }
    await cleanupUploadedFiles(attachments);
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function parseFeedbackTicketMultipart(
  request: IncomingMessage,
  options: ParseFeedbackTicketMultipartOptions
): Promise<{ fields: FeedbackTicketFields; attachments: TemporaryTicketAttachment[] }> {
  const parsed = await parseTicketSubmissionMultipart(request, {
    ...options,
    expectedMultipartMessage: 'Expected multipart feedback form',
    fieldTooLargeMessage: 'Feedback field is too large'
  });
  try {
    return {
      fields: normalizeFeedbackFields(parsed.fields),
      attachments: parsed.attachments
    };
  } catch (error) {
    await cleanupUploadedFiles(parsed.attachments);
    throw error;
  }
}

export async function parseDatasheetSubmissionMultipart(
  request: IncomingMessage,
  options: ParseFeedbackTicketMultipartOptions
): Promise<{ fields: DatasheetSubmissionFields; attachments: TemporaryTicketAttachment[] }> {
  const parsed = await parseTicketSubmissionMultipart(request, {
    ...options,
    expectedMultipartMessage: 'Expected multipart datasheet submission form',
    fieldTooLargeMessage: 'Datasheet field is too large'
  });
  try {
    const fields = normalizeDatasheetSubmissionFields(parsed.fields);
    if (parsed.attachments.length === 0) {
      throw new TicketValidationError('Datasheet attachment is required');
    }
    return {
      fields,
      attachments: parsed.attachments
    };
  } catch (error) {
    await cleanupUploadedFiles(parsed.attachments);
    throw error;
  }
}

export function buildDatasheetUploadReview(
  fields: DatasheetSubmissionFields,
  attachments: TicketAttachmentMeta[],
  options: { now?: Date } = {}
): DatasheetUploadReviewPayload {
  const scannedAt = (options.now ?? new Date()).toISOString();
  const scanAttachments = attachments.map((attachment) => {
    const extension = path.extname(attachment.originalName ?? attachment.storedName ?? '').toLowerCase();
    const isArchive = extension === '.zip' || extension === '.7z';
    const status: TicketSecurityScanStatus = isArchive ? 'not_supported' : 'passed';
    return {
      id: attachment.id,
      normalizedName: attachment.originalName,
      extension,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      fingerprint: attachment.sha256 ? attachment.sha256.slice(0, 12) : undefined,
      isArchive,
      status,
      summary: isArchive
        ? 'Archive received in quarantine for manual review; contents are not expanded or indexed.'
        : 'Local extension, MIME, size, sample, and file identity checks passed.'
    };
  });
  const hasArchive = scanAttachments.some((attachment) => attachment.isArchive);
  const state: DatasheetUploadReviewState = hasArchive ? 'quarantined' : 'submitted';
  return {
    state,
    searchable: false,
    visibilityCandidate: 'restricted',
    catalogBinding: null,
    disclaimerAccepted: fields.disclaimerAccepted,
    sourceDeclaration: fields.sourceDeclaration ?? fields.sourceNote,
    securityScan: {
      status: hasArchive ? 'not_supported' : 'passed',
      summary: hasArchive
        ? 'One or more archives are quarantined for manual review and are not searchable.'
        : 'All submitted files passed local deterministic upload checks and remain isolated for review.',
      scannedAt,
      policyVersion: 'phase39-local-v1',
      attachments: scanAttachments
    },
    metadataCandidate: {
      vendor: fields.vendor,
      partNumber: fields.partNumberOrKeywords,
      applicationTags: []
    }
  };
}

export async function resolveTicketAttachmentDownload(options: {
  ticketStore: TicketStore;
  dataDir: string;
  ticketNo: string;
  attachmentId: string;
}): Promise<{
  ticketNo: string;
  attachment: TicketAttachmentMeta;
  absolutePath: string;
  downloadName: string;
  contentType: string;
  sizeBytes?: number;
}> {
  const ticket = await options.ticketStore.getTicket(options.ticketNo);
  const attachment = ticket.attachments.find((item) => item.id === options.attachmentId);
  if (!attachment) {
    throw new TicketAttachmentUploadError(404, 'Attachment not found');
  }
  if (attachment.status === 'cleaned') {
    throw new TicketAttachmentUploadError(410, 'Attachment has been cleaned');
  }
  if (!attachment.storagePath) {
    throw new TicketAttachmentUploadError(404, 'Attachment not found');
  }

  const reviewRoot = getTicketAttachmentReviewRoot(options.dataDir);
  const absolutePath = resolveReviewStoragePath(reviewRoot, attachment.storagePath);
  if (!absolutePath) {
    throw new TicketAttachmentUploadError(404, 'Attachment not found');
  }

  const fileStat = await stat(absolutePath).catch(() => undefined);
  if (!fileStat || !fileStat.isFile()) {
    throw new TicketAttachmentUploadError(410, 'Attachment has been cleaned');
  }

  return {
    ticketNo: ticket.ticketNo,
    attachment,
    absolutePath,
    downloadName: sanitizeDownloadName(attachment.originalName) || `${ticket.ticketNo}-${attachment.id}`,
    contentType: safeDownloadContentType(attachment.mimeType),
    sizeBytes: fileStat.size
  };
}

export async function resolveTicketAttachmentPreview(options: {
  ticketStore: TicketStore;
  dataDir: string;
  ticketNo: string;
  attachmentId: string;
  maxBytes?: number;
}): Promise<{
  ticketNo: string;
  attachmentId: string;
  originalName?: string;
  mimeType?: string;
  previewText: string;
  truncated: boolean;
  bytesRead: number;
}> {
  const download = await resolveTicketAttachmentDownload(options);
  const extension = path.extname(download.attachment.originalName ?? download.attachment.storedName ?? '').toLowerCase();
  if (!TEXT_PREVIEW_ATTACHMENT_EXTENSIONS.has(extension)) {
    throw new TicketAttachmentUploadError(415, 'Attachment preview is not supported');
  }

  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_TEXT_PREVIEW_MAX_BYTES));
  const buffer = Buffer.alloc(maxBytes + 1);
  const handle = await open(download.absolutePath, 'r');
  let bytesRead = 0;
  try {
    const result = await handle.read(buffer, 0, maxBytes + 1, 0);
    bytesRead = result.bytesRead;
  } finally {
    await handle.close().catch(() => undefined);
  }

  const truncated = bytesRead > maxBytes;
  const previewBuffer = buffer.subarray(0, Math.min(bytesRead, maxBytes));
  if (isBinaryLikePreview(previewBuffer)) {
    throw new TicketAttachmentUploadError(415, 'Attachment preview is not supported');
  }

  return {
    ticketNo: download.ticketNo,
    attachmentId: download.attachment.id,
    originalName: download.attachment.originalName,
    mimeType: download.attachment.mimeType,
    previewText: previewBuffer.toString('utf8'),
    truncated,
    bytesRead: previewBuffer.length
  };
}

export async function finalizeTicketAttachments(
  attachments: TemporaryTicketAttachment[],
  options: FinalizeTicketAttachmentOptions
): Promise<TicketAttachmentMeta[]> {
  if (attachments.length === 0) {
    return [];
  }

  const reviewRoot = getTicketAttachmentReviewRoot(options.dataDir);
  const date = ticketDateParts(options.ticketNo);
  const finalDir = path.join(reviewRoot, date.year, date.month, safePathSegment(options.ticketNo));
  const movedPaths: string[] = [];
  try {
    await mkdir(finalDir, { recursive: true });
    const finalized: TicketAttachmentMeta[] = [];
    for (const attachment of attachments) {
      const storedName = safePathSegment(attachment.storedName ?? `${crypto.randomUUID()}.bin`);
      const finalPath = path.join(finalDir, storedName);
      if (!isPathInside(path.resolve(finalPath), reviewRoot)) {
        throw new TicketAttachmentUploadError(400, 'Invalid attachment storage path');
      }
      await rename(attachment.absolutePath, finalPath);
      movedPaths.push(finalPath);
      finalized.push({
        id: attachment.id,
        status: attachment.status,
        originalName: attachment.originalName,
        storedName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        storagePath: toStoragePath(date.year, date.month, options.ticketNo, storedName),
        uploadedAt: attachment.uploadedAt,
        retentionUntil: attachment.retentionUntil
      });
    }
    await cleanupUploadedFiles(attachments);
    return finalized;
  } catch (error) {
    await Promise.all(movedPaths.map((filePath) => rm(filePath, { force: true }).catch(() => undefined)));
    await cleanupUploadedFiles(attachments);
    throw error;
  }
}

export async function cleanupUploadedFiles(attachments: Array<Partial<TemporaryTicketAttachment>>): Promise<void> {
  await Promise.all(
    attachments.map(async (attachment) => {
      if (typeof attachment.absolutePath === 'string') {
        await rm(attachment.absolutePath, { force: true }).catch(() => undefined);
      }
    })
  );
}

export async function cleanupExpiredPendingTicketAttachments(
  options: CleanupExpiredPendingTicketAttachmentsOptions
): Promise<{ scanned: number; cleaned: number }> {
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? FEEDBACK_ATTACHMENT_LIMITS.retentionDays;
  const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const reviewRoot = getTicketAttachmentReviewRoot(options.dataDir);
  const tickets = await options.ticketStore.listAllTicketRecords();
  let scanned = 0;
  let cleaned = 0;

  for (const ticket of tickets) {
    let changed = false;
    const nextAttachments: TicketAttachmentMeta[] = [];
    const skipPendingCleanupForTicket = PROCESSED_TICKET_STATUSES.has(ticket.status);
    for (const attachment of ticket.attachments) {
      scanned += 1;
      if (
        skipPendingCleanupForTicket ||
        attachment.status !== 'pending' ||
        attachment.retainedAt ||
        !attachment.uploadedAt ||
        new Date(attachment.uploadedAt).getTime() > cutoffMs
      ) {
        nextAttachments.push(attachment);
        continue;
      }

      const storagePath = resolveReviewStoragePath(reviewRoot, attachment.storagePath);
      if (!storagePath) {
        nextAttachments.push(attachment);
        continue;
      }

      await rm(storagePath, { force: true });
      nextAttachments.push({
        ...attachment,
        status: 'cleaned',
        cleanedAt: now.toISOString(),
        cleanedReason: 'expired_pending_retention_30_days'
      });
      cleaned += 1;
      changed = true;
    }

    if (changed) {
      await options.ticketStore.replaceTicketAttachments(ticket.ticketNo, nextAttachments);
    }
  }

  return { scanned, cleaned };
}

export function getTicketAttachmentReviewRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'ticket-attachments', 'review');
}

function parseMultipartBoundary(contentType: string | string[] | undefined): string | undefined {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (!value) {
    return undefined;
  }
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(value);
  return (match?.[1] ?? match?.[2])?.trim();
}

function parsePartHeaders(rawHeaders: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) {
      continue;
    }
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function parseContentDisposition(value: string | undefined): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  if (!value) {
    return result;
  }
  for (const part of value.split(';').slice(1)) {
    const [rawKey, ...rawValueParts] = part.split('=');
    const key = rawKey?.trim().toLowerCase();
    const rawValue = rawValueParts.join('=').trim();
    const parsed = rawValue.startsWith('"') && rawValue.endsWith('"')
      ? rawValue.slice(1, -1).replace(/\\"/g, '"')
      : rawValue;
    if (key === 'name') result.name = parsed;
    if (key === 'filename') result.filename = parsed;
  }
  return result;
}

function normalizeFeedbackFields(fields: Record<string, string>): FeedbackTicketFields {
  const title = limitFieldText(fields.title, 200);
  const content = limitFieldText(fields.content, 4000);
  if (!title) {
    throw new TicketValidationError('Feedback title is required');
  }
  if (!content) {
    throw new TicketValidationError('Feedback content is required');
  }

  return {
    title,
    content,
    category: limitFieldText(fields.category, 80),
    contact: limitFieldText(fields.contact, 500),
    hasAttachments: ['1', 'true', 'yes', 'on'].includes((fields.hasAttachments ?? '').trim().toLowerCase())
  };
}

function normalizeDatasheetSubmissionFields(fields: Record<string, string>): DatasheetSubmissionFields {
  const title = limitFieldText(fields.title, 200);
  if (!title) {
    throw new TicketValidationError('Datasheet title is required');
  }
  const disclaimerAccepted = ['1', 'true', 'yes', 'on'].includes((fields.disclaimerAccepted ?? '').trim().toLowerCase());
  if (!disclaimerAccepted) {
    throw new TicketValidationError('Datasheet submission declaration is required');
  }

  return {
    title,
    vendor: limitFieldText(fields.vendor, 160),
    partNumberOrKeywords: limitFieldText(fields.partNumberOrKeywords ?? fields.keywords ?? fields.partNumber, 240),
    sourceNote: limitFieldText(fields.sourceNote, 1000),
    sourceDeclaration: limitFieldText(fields.sourceDeclaration ?? fields.sourceNote, 1000),
    contact: limitFieldText(fields.contact, 500),
    note: limitFieldText(fields.note, 2000),
    disclaimerAccepted
  };
}

function limitFieldText(value: string | undefined, limit: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, limit) : undefined;
}

function fieldLimitBytes(name: string): number {
  if (name === 'title') return 1024;
  if (name === 'content') return 16 * 1024;
  if (name === 'category') return 1024;
  if (name === 'contact') return 4096;
  if (name === 'sourceNote') return 4096;
  if (name === 'sourceDeclaration') return 4096;
  if (name === 'note') return 8192;
  return 4096;
}

function isAttachmentFieldName(name: string): boolean {
  return name === 'attachments' || name === 'attachments[]' || name === 'file' || name === 'files[]';
}

function sanitizeOriginalName(filename: string): string {
  if (/[\0\\/]/.test(filename) || filename.includes('..')) {
    throw new TicketAttachmentUploadError(400, 'Attachment filename is not allowed');
  }
  const normalized = filename.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized).trim();
  return basename.slice(0, 240) || 'attachment';
}

function validateAttachmentMime(extension: string, value: string | undefined): void {
  const contentType = value?.trim();
  if (!contentType) {
    return;
  }
  if (DANGEROUS_MIME_PATTERN.test(contentType)) {
    throw new TicketAttachmentUploadError(400, 'Attachment MIME type is not allowed');
  }
  if (extension === '.pdf' && !/^(application\/pdf|application\/octet-stream)$/i.test(contentType)) {
    throw new TicketAttachmentUploadError(400, 'Attachment MIME type does not match its extension');
  }
}

function sanitizeDownloadName(filename: string | undefined): string | undefined {
  const cleaned = filename
    ?.replace(/[\r\n"]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 240);
  return cleaned || undefined;
}

function safeDownloadContentType(value: string | undefined): string {
  const contentType = value?.trim();
  if (!contentType || /[\r\n;]/.test(contentType) || contentType.length > 120) {
    return 'application/octet-stream';
  }
  return contentType;
}

function validateAttachmentContent(originalName: string, sample: Buffer): void {
  const extension = path.extname(originalName).toLowerCase();
  const valid =
    extension === '.pdf'
      ? sampleStartsWith(sample, PDF_MAGIC)
      : extension === '.zip'
        ? ZIP_MAGIC_HEADERS.some((magic) => sampleStartsWith(sample, magic))
        : extension === '.7z'
          ? sampleStartsWith(sample, SEVEN_Z_MAGIC)
          : validateTextLikeSample(sample);
  if (!valid) {
    throw new TicketAttachmentUploadError(400, 'Attachment content does not match its extension');
  }
}

function sampleStartsWith(sample: Buffer, magic: Buffer): boolean {
  return sample.length >= magic.length && sample.subarray(0, magic.length).equals(magic);
}

function validateTextLikeSample(sample: Buffer): boolean {
  if (sample.includes(0x00)) {
    return false;
  }
  if (sample.length === 0) {
    return true;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !allowedWhitespace) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.length <= 0.25;
}

function isBinaryLikePreview(sample: Buffer): boolean {
  if (sample.includes(0x00)) {
    return true;
  }
  if (sample.length === 0) {
    return false;
  }
  let controlBytes = 0;
  for (const byte of sample) {
    const allowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !allowedWhitespace) {
      controlBytes += 1;
    }
  }
  return controlBytes / sample.length > 0.05;
}

function safePathSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 240);
  return cleaned || crypto.randomUUID();
}

function toStoragePath(...segments: string[]): string {
  return segments.map(safePathSegment).join('/');
}

function ticketDateParts(ticketNo: string): { year: string; month: string } {
  const match = /^(?:FB|DS|AP)-(\d{4})(\d{2})\d{2}-\d{4}$/.exec(ticketNo);
  if (!match) {
    throw new TicketValidationError('Invalid ticket number');
  }
  return { year: match[1]!, month: match[2]! };
}

function resolveReviewStoragePath(reviewRoot: string, storagePath: string | undefined): string | undefined {
  if (!storagePath) {
    return undefined;
  }
  const candidate = path.isAbsolute(storagePath)
    ? path.resolve(storagePath)
    : path.resolve(reviewRoot, ...storagePath.split(/[\\/]+/));
  return isPathInside(candidate, reviewRoot) ? candidate : undefined;
}

function isPathInside(candidatePath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
