import {
  type AdminTicketAttachmentDto,
  type AccountApplicationCredentialDraft,
  type AccountApplicationFields,
  type AccountApplicationPayload,
  type AdminTicketDto,
  type CreateTicketInput,
  type PublicTicketDto,
  type TicketAccountBinding,
  type TicketAttachmentMeta,
  type TicketContact,
  type TicketListItem,
  type TicketMessage,
  type TicketMessageDto,
  type TicketPrefix,
  type TicketRecord,
  type TicketSecurityScanStatus,
  type TicketStatus,
  type TicketType
} from './types.js';

export const TICKET_TYPE_PREFIX: Record<TicketType, TicketPrefix> = {
  feedback: 'FB',
  datasheet_submission: 'DS',
  account_application: 'AP'
};

export const TICKET_STATUS_OPTIONS: Record<TicketType, readonly TicketStatus[]> = {
  feedback: ['submitted', 'received', 'evaluating', 'accepted', 'in_development', 'launched', 'deferred', 'closed'],
  datasheet_submission: [
    'submitted',
    'scanning',
    'quarantined',
    'received',
    'reviewing',
    'needs_more_info',
    'accepted',
    'rejected',
    'linked',
    'archived',
    'deferred',
    'closed'
  ],
  account_application: ['submitted', 'pending_review', 'needs_more_info', 'approved', 'rejected', 'closed']
};

const TICKET_NO_PATTERN = /^(FB|DS|AP)-\d{8}-\d{4}$/;
const TICKET_TYPES = new Set<TicketType>(Object.keys(TICKET_TYPE_PREFIX) as TicketType[]);
const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|github_token|mcp[_ -]?key|api[_ -]?key|private[_ -]?key|credentialDraft|passwordHash|jwt|sha256|fingerprint|hash)/i;
const CWD_KEY = /(^cwd$|workingDirectory|workspacePath|absolutePath|storagePath|serverPath|sourcePath|sourceRoot|internalManifestPath|knowledgeBaseRoot)/i;
const SAFE_IDENTIFIER_PAYLOAD_KEY = /^(sessionId|turnId|messageId|modelId|chipId|documentId|scopeId|scopePresetId)$/;
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+/-]+=*|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|mcp[_-]?[A-Za-z0-9_-]{16,}|\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b)/gi;
const INLINE_SECRET_FIELD = /\b(?:authorization|cookie|password|secret|token|mcp[_ -]?key|api[_ -]?key|private[_ -]?key|jwt)\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g;
const POSIX_PRIVATE_PATH = /(^|\s)\/(?:Users|home|opt|var|etc)\/[^\s"'<>]+/g;

export class UnsafeTicketNoError extends Error {
  readonly statusCode = 400;
  constructor(ticketNo: string) {
    super(`Unsafe ticket number: ${ticketNo}`);
  }
}

export class TicketValidationError extends Error {
  readonly statusCode = 400;
}

export function isTicketType(value: unknown): value is TicketType {
  return typeof value === 'string' && TICKET_TYPES.has(value as TicketType);
}

export function isTicketStatusForType(type: TicketType, status: unknown): status is TicketStatus {
  return typeof status === 'string' && TICKET_STATUS_OPTIONS[type].includes(status as TicketStatus);
}

export function assertSafeTicketNo(ticketNo: string): string {
  if (!TICKET_NO_PATTERN.test(ticketNo)) {
    throw new UnsafeTicketNoError(ticketNo);
  }
  return ticketNo;
}

export function toPublicTicketDto(ticket: TicketRecord): PublicTicketDto {
  return {
    ticketNo: ticket.ticketNo,
    type: ticket.type,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    publicNote: ticket.publicNote,
    needsMoreInfo: ticket.needsMoreInfo,
    result: ticket.result,
    // 受众脱敏：面向用户的端点只暴露 audience='user' 的消息，绝不含 internal。
    messages: (ticket.messages ?? []).filter((message) => message.audience === 'user').map(toTicketMessageDto)
  };
}

export function toTicketMessageDto(message: TicketMessage): TicketMessageDto {
  return {
    id: message.id,
    authorRole: message.authorRole,
    authorLabel: sanitizeTicketText(message.authorLabel, 120),
    text: sanitizeTicketText(message.text, 4000) ?? '',
    createdAt: message.createdAt,
    audience: message.audience
  };
}

export function toTicketListItem(ticket: TicketRecord): TicketListItem {
  const item: TicketListItem = {
    ticketNo: ticket.ticketNo,
    type: ticket.type,
    status: ticket.status,
    title: ticket.title,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    needsMoreInfo: ticket.needsMoreInfo,
    accountUserId: ticket.accountBinding?.userId
  };
  const reviewSummary = toSafeUploadReviewSummary(ticket.payload);
  if (reviewSummary) {
    item.uploadReview = reviewSummary;
  }
  return item;
}

export function sanitizeCreateTicketInput(input: CreateTicketInput): CreateTicketInput {
  if (!isTicketType(input.type)) {
    throw new TicketValidationError('Ticket type is required');
  }
  if (input.status !== undefined && !isTicketStatusForType(input.type, input.status)) {
    throw new TicketValidationError('Invalid ticket status');
  }

  return {
    type: input.type,
    status: input.status,
    title: sanitizeTicketText(input.title, 200),
    publicNote: sanitizeTicketText(input.publicNote, 2000),
    internalNote: sanitizeTicketText(input.internalNote, 4000),
    result: sanitizeTicketText(input.result, 2000),
    needsMoreInfo: typeof input.needsMoreInfo === 'boolean' ? input.needsMoreInfo : undefined,
    source: sanitizeTicketText(input.source, 500),
    contact: sanitizeTicketContact(input.contact),
    accountBinding: sanitizeAccountBinding(input.accountBinding),
    attachments: sanitizeAttachments(input.attachments),
    payload:
      input.type === 'account_application'
        ? sanitizeAccountApplicationPayload(input.payload)
        : sanitizeTicketPayload(input.payload)
  };
}

export function toAdminTicketDto(ticket: TicketRecord): AdminTicketDto {
  return {
    ticketNo: ticket.ticketNo,
    type: ticket.type,
    status: ticket.status,
    title: ticket.title,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    publicNote: ticket.publicNote,
    internalNote: ticket.internalNote,
    result: ticket.result,
    needsMoreInfo: ticket.needsMoreInfo,
    source: ticket.source,
    contact: cloneContact(ticket.contact),
    accountBinding: cloneAccountBinding(ticket.accountBinding),
    attachments: ticket.attachments.map(toAdminAttachmentDto),
    auditTrail: ticket.auditTrail.map((entry) => ({
      at: entry.at,
      actor: entry.actor ? { ...entry.actor } : undefined,
      action: entry.action,
      changes: entry.changes ? { ...entry.changes } : undefined
    })),
    // admin 看到全部消息（含 internal）。
    messages: (ticket.messages ?? []).map(toTicketMessageDto),
    payload:
      ticket.type === 'account_application'
        ? redactAccountApplicationPayload(ticket.payload)
        : sanitizeTicketPayload(ticket.payload)
  };
}

function toAdminAttachmentDto(attachment: TicketAttachmentMeta): AdminTicketAttachmentDto {
  const dto = stripUndefined({
    id: attachment.id,
    status: attachment.status,
    originalName: sanitizeTicketText(attachment.originalName, 500),
    mimeType: sanitizeTicketText(attachment.mimeType, 200),
    sizeBytes: attachment.sizeBytes,
    uploadedAt: attachment.uploadedAt,
    cleanedAt: attachment.cleanedAt,
    retentionUntil: attachment.retentionUntil,
    cleanedReason: sanitizeTicketText(attachment.cleanedReason, 500),
    retainedAt: attachment.retainedAt,
    retainedBy: sanitizeTicketText(attachment.retainedBy, 200)
  });
  return dto as AdminTicketAttachmentDto;
}

export function sanitizeTicketText(value: unknown, limit: number): string | undefined {
  const text = trimText(value, limit);
  if (!text) {
    return undefined;
  }
  return text
    .replace(INLINE_SECRET_FIELD, '[redacted]')
    .replace(SECRET_VALUE, '[redacted]')
    .replace(WINDOWS_ABSOLUTE_PATH, '[redacted-path]')
    .replace(POSIX_PRIVATE_PATH, ' [redacted-path]');
}

export function sanitizeTicketContact(value: unknown): TicketContact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const contact: TicketContact = {
    name: sanitizeTicketText(value.name, 120),
    email: sanitizeTicketText(value.email, 160),
    phone: sanitizeTicketText(value.phone, 80),
    company: sanitizeTicketText(value.company, 160),
    raw: sanitizeTicketText(value.raw, 500)
  };
  return hasDefinedValue(contact) ? contact : undefined;
}

export function sanitizeTicketPayload(value: unknown, depth = 0): Record<string, unknown> {
  if (!isRecord(value) || depth > 4) {
    return {};
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'answerTextHash' && typeof entry === 'string' && /^[a-f0-9]{64}$/i.test(entry)) {
      output[key] = entry.toLowerCase();
      continue;
    }
    if (SAFE_IDENTIFIER_PAYLOAD_KEY.test(key) && typeof entry === 'string') {
      const identifier = sanitizePayloadIdentifier(entry);
      if (identifier) {
        output[key] = identifier;
      }
      continue;
    }
    if (SENSITIVE_KEY.test(key) || CWD_KEY.test(key)) {
      continue;
    }
    if (typeof entry === 'string') {
      output[key] = sanitizeTicketText(entry, 1000);
    } else if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      output[key] = entry;
    } else if (Array.isArray(entry)) {
      output[key] = entry.slice(0, 20).map((item) => sanitizePayloadValue(item, depth + 1));
    } else {
      output[key] = sanitizePayloadValue(entry, depth + 1);
    }
  }
  return output;
}

export function sanitizeAccountApplicationFields(value: unknown): AccountApplicationFields | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const username = sanitizeTicketText(value.username, 64);
  if (!username) {
    return undefined;
  }
  return stripUndefined({
    username,
    company: sanitizeTicketText(value.company, 160),
    reason: sanitizeTicketText(value.reason, 1000),
    heardFrom: sanitizeTicketText(value.heardFrom, 240),
    occupation: sanitizeTicketText(value.occupation, 160),
    favoriteFeature: sanitizeTicketText(value.favoriteFeature, 500),
    expectedFeature: sanitizeTicketText(value.expectedFeature, 500),
    contact: sanitizeTicketText(value.contact, 500)
  }) as unknown as AccountApplicationFields;
}

export function redactAccountApplicationPayload(payload: unknown): AdminTicketDto['payload'] {
  const sanitized = sanitizeAccountApplicationPayload(payload);
  if (!isAccountApplicationPayload(sanitized)) {
    return {};
  }
  const applicationPayload = sanitized as unknown as AccountApplicationPayload;
  const { passwordHash: _passwordHash, ...draft } = applicationPayload.credentialDraft;
  return {
    application: { ...applicationPayload.application },
    credentialDraft: {
      ...draft,
      hasPasswordHash: Boolean(applicationPayload.credentialDraft.passwordHash)
    },
    approvedUserId: applicationPayload.approvedUserId,
    approvedUsername: applicationPayload.approvedUsername,
    approvedAt: applicationPayload.approvedAt
  };
}

function sanitizeAccountApplicationPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const application = sanitizeAccountApplicationFields(value.application);
  const credentialDraft = sanitizeAccountApplicationCredentialDraft(value.credentialDraft);
  if (!application || !credentialDraft) {
    return {};
  }
  return stripUndefined({
    application,
    credentialDraft,
    approvedUserId: sanitizeTicketText(value.approvedUserId, 120),
    approvedUsername: sanitizeTicketText(value.approvedUsername, 64),
    approvedAt: sanitizeTicketText(value.approvedAt, 80)
  });
}

function sanitizeAccountApplicationCredentialDraft(value: unknown): AccountApplicationCredentialDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const passwordHash = trimText(value.passwordHash, 200);
  const createdAt = sanitizeTicketText(value.createdAt, 80);
  const expiresAt = sanitizeTicketText(value.expiresAt, 80);
  const status = trimText(value.status, 40);
  if (!passwordHash || !createdAt || !expiresAt || !isCredentialDraftStatus(status)) {
    return undefined;
  }
  return stripUndefined({
    passwordHash,
    createdAt,
    expiresAt,
    status,
    consumedAt: sanitizeTicketText(value.consumedAt, 80),
    invalidatedAt: sanitizeTicketText(value.invalidatedAt, 80),
    invalidatedReason: sanitizeTicketText(value.invalidatedReason, 240)
  }) as unknown as AccountApplicationCredentialDraft;
}

function sanitizePayloadValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return sanitizeTicketText(value, 1000);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizePayloadValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return sanitizeTicketPayload(value, depth);
  }
  return undefined;
}

function sanitizeAccountBinding(value: unknown): TicketAccountBinding | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const userId = trimText(value.userId, 120);
  if (!userId) {
    return undefined;
  }
  return {
    userId,
    username: sanitizeTicketText(value.username, 120),
    role: sanitizeTicketText(value.role, 80)
  };
}

function sanitizeAttachments(value: unknown): TicketAttachmentMeta[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = trimText(entry.id, 120);
    const status = trimText(entry.status, 40);
    if (!id || !isAttachmentStatus(status)) {
      return [];
    }
    return [{
      id,
      status,
      originalName: sanitizeTicketText(entry.originalName, 240),
      storedName: trimText(entry.storedName, 240),
      mimeType: sanitizeTicketText(entry.mimeType, 120),
      sizeBytes: typeof entry.sizeBytes === 'number' && Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : undefined,
      sha256: trimText(entry.sha256, 128),
      storagePath: trimText(entry.storagePath, 500),
      uploadedAt: sanitizeTicketText(entry.uploadedAt, 80),
      cleanedAt: sanitizeTicketText(entry.cleanedAt, 80),
      retentionUntil: sanitizeTicketText(entry.retentionUntil, 80),
      cleanedReason: sanitizeTicketText(entry.cleanedReason, 240),
      retainedAt: sanitizeTicketText(entry.retainedAt, 80),
      retainedBy: sanitizeTicketText(entry.retainedBy, 120)
    }];
  });
}

function toSafeUploadReviewSummary(value: unknown): TicketListItem['uploadReview'] | undefined {
  if (!isRecord(value) || !isRecord(value.uploadReview)) {
    return undefined;
  }
  const review = value.uploadReview;
  const state = trimText(review.state, 40);
  const securityScan = isRecord(review.securityScan) ? review.securityScan : {};
  const securityScanStatus = trimText(securityScan.status, 40);
  const securityScanSummary = sanitizeTicketText(securityScan.summary, 240);
  if (!isDatasheetUploadReviewState(state) || !isSecurityScanStatus(securityScanStatus)) {
    return undefined;
  }
  return {
    state,
    securityScanStatus,
    securityScanSummary: securityScanSummary ?? ''
  };
}

function isAttachmentStatus(value: unknown): value is TicketAttachmentMeta['status'] {
  return value === 'pending' || value === 'accepted' || value === 'rejected' || value === 'cleaned';
}

function isDatasheetUploadReviewState(value: unknown): value is NonNullable<TicketListItem['uploadReview']>['state'] {
  return (
    value === 'submitted' ||
    value === 'scanning' ||
    value === 'quarantined' ||
    value === 'reviewing' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'needs_more_info' ||
    value === 'linked'
  );
}

function isSecurityScanStatus(value: unknown): value is TicketSecurityScanStatus {
  return value === 'pending' || value === 'passed' || value === 'failed' || value === 'not_supported';
}

function trimText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim().replace(/\r\n/g, '\n');
  return text ? text.slice(0, limit) : undefined;
}

function sanitizePayloadIdentifier(value: string): string | undefined {
  const text = value.trim();
  WINDOWS_ABSOLUTE_PATH.lastIndex = 0;
  POSIX_PRIVATE_PATH.lastIndex = 0;
  INLINE_SECRET_FIELD.lastIndex = 0;
  const unsafe = WINDOWS_ABSOLUTE_PATH.test(text) || POSIX_PRIVATE_PATH.test(text) || INLINE_SECRET_FIELD.test(text);
  WINDOWS_ABSOLUTE_PATH.lastIndex = 0;
  POSIX_PRIVATE_PATH.lastIndex = 0;
  INLINE_SECRET_FIELD.lastIndex = 0;
  if (!text || unsafe) {
    return undefined;
  }
  const safe = text.replace(/[^A-Za-z0-9._:-]+/g, '-').slice(0, 160);
  return safe || undefined;
}

function hasDefinedValue(value: object): boolean {
  return Object.values(value).some((entry) => entry !== undefined);
}

function cloneContact(value: TicketContact | undefined): TicketContact | undefined {
  return value ? { ...value } : undefined;
}

function cloneAccountBinding(value: TicketAccountBinding | undefined): TicketAccountBinding | undefined {
  return value ? { ...value } : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isCredentialDraftStatus(value: unknown): value is AccountApplicationCredentialDraft['status'] {
  return value === 'pending' || value === 'consumed' || value === 'invalidated' || value === 'expired';
}

function isAccountApplicationPayload(value: Record<string, unknown>): boolean {
  return isRecord(value.application) && isRecord(value.credentialDraft);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
