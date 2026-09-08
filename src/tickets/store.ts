import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../persistence/json-file.js';
import {
  TICKET_TYPE_PREFIX,
  assertSafeTicketNo,
  isTicketStatusForType,
  isTicketType,
  sanitizeCreateTicketInput,
  sanitizeTicketText,
  toPublicTicketDto,
  toTicketListItem,
  TicketValidationError
} from './sanitize.js';
import {
  type DatasheetAdminReviewUpdate,
  type DatasheetUploadReviewPayload,
  type DatasheetUploadReviewState,
  type AccountApplicationPayload,
  type CreateTicketInput,
  type PublicTicketDto,
  type DatasheetMetadataCandidate,
  type TicketAdminUpdate,
  type TicketAuditEntry,
  type TicketAttachmentMeta,
  type TicketListFilters,
  type TicketListItem,
  type TicketMessage,
  type TicketMessageAudience,
  type TicketPrefix,
  type TicketRecord
} from './types.js';

export class TicketNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(ticketNo: string) {
    super(`Ticket not found: ${ticketNo}`);
  }
}

export interface TicketStoreOptions {
  dataDir: string;
  now?: () => Date;
}

interface CounterFile {
  date: string;
  counters: Partial<Record<TicketPrefix, number>>;
  updatedAt: string;
}

interface TicketUpdateActor {
  userId?: string;
  username?: string;
  role?: string;
}

export class TicketStore {
  readonly ticketsDir: string;
  readonly detailDir: string;
  readonly counterDir: string;
  readonly indexFile: string;
  private readonly now: () => Date;
  private counterQueue: Promise<void> = Promise.resolve();

  constructor(options: TicketStoreOptions) {
    this.ticketsDir = path.join(path.resolve(options.dataDir), 'tickets');
    this.detailDir = path.join(this.ticketsDir, 'detail');
    this.counterDir = path.join(this.ticketsDir, 'counters');
    this.indexFile = path.join(this.ticketsDir, 'index.jsonl');
    this.now = options.now ?? (() => new Date());
  }

  async createTicket(input: CreateTicketInput): Promise<TicketRecord> {
    return this.withCounterQueue(async () => {
      const safeInput = sanitizeCreateTicketInput(input);
      const now = this.now();
      const createdAt = now.toISOString();
      const ticketNo = await this.nextTicketNo(safeInput.type, now);
      const status = safeInput.status ?? 'submitted';
      const ticket: TicketRecord = {
        schemaVersion: 1,
        ticketNo,
        type: safeInput.type,
        status,
        title: safeInput.title,
        createdAt,
        updatedAt: createdAt,
        publicNote: safeInput.publicNote,
        internalNote: safeInput.internalNote,
        result: safeInput.result,
        needsMoreInfo: safeInput.needsMoreInfo ?? false,
        source: safeInput.source,
        contact: safeInput.contact,
        accountBinding: safeInput.accountBinding,
        attachments: safeInput.attachments ?? [],
        auditTrail: [{
          at: createdAt,
          actor: safeInput.accountBinding,
          action: 'created'
        }],
        messages: [],
        payload: safeInput.payload ?? {}
      };
      const uploadReview = getDatasheetUploadReview(ticket.payload);
      if (ticket.type === 'datasheet_submission' && uploadReview) {
        ticket.auditTrail = [
          ...ticket.auditTrail,
          {
            at: createdAt,
            actor: safeInput.accountBinding,
            action: 'upload_scan',
            changes: {
              uploadReviewState: uploadReview.state,
              securityScanStatus: uploadReview.securityScan.status,
              attachmentCount: uploadReview.securityScan.attachments.length
            }
          }
        ];
      }
      await this.writeTicket(ticket);
      await this.rebuildIndex();
      return ticket;
    });
  }

  async getTicket(ticketNo: string): Promise<TicketRecord> {
    assertSafeTicketNo(ticketNo);
    const ticket = (await this.readAllTickets()).find((item) => item.ticketNo === ticketNo);
    if (!ticket) {
      throw new TicketNotFoundError(ticketNo);
    }
    return ticket;
  }

  async getPublicTicket(ticketNo: string): Promise<PublicTicketDto> {
    return toPublicTicketDto(await this.getTicket(ticketNo));
  }

  async listTickets(filters: TicketListFilters = {}): Promise<{
    items: TicketListItem[];
    total: number;
    offset: number;
    limit: number;
  }> {
    const offset = normalizeOffset(filters.offset);
    const limit = normalizeLimit(filters.limit);
    const filtered = (await this.readAllTickets())
      .filter((ticket) => matchesFilters(ticket, filters))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return {
      items: filtered.slice(offset, offset + limit).map(toTicketListItem),
      total: filtered.length,
      offset,
      limit
    };
  }

  async listTicketsForAccount(userId: string, filters: TicketListFilters = {}): Promise<{
    items: TicketListItem[];
    total: number;
    offset: number;
    limit: number;
  }> {
    return this.listTickets({ ...filters, accountUserId: userId });
  }

  async updateTicket(ticketNo: string, patch: TicketAdminUpdate, actor: TicketUpdateActor = {}): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.status !== undefined) {
      if (!isTicketStatusForType(ticket.type, patch.status)) {
        throw new TicketValidationError('Invalid ticket status');
      }
      if (ticket.type === 'account_application' && patch.status === 'approved') {
        throw new TicketValidationError('Account applications must be approved through the approval route');
      }
      if (ticket.type === 'datasheet_submission') {
        assertDatasheetStatusTransition(ticket.status, patch.status);
      }
      if (ticket.status !== patch.status) {
        changes.status = { from: ticket.status, to: patch.status };
        ticket.status = patch.status;
        syncDatasheetUploadReviewState(ticket, patch.status);
      }
    }
    this.applyStringPatch(ticket, changes, 'publicNote', patch.publicNote, 2000);
    this.applyStringPatch(ticket, changes, 'internalNote', patch.internalNote, 4000);
    this.applyStringPatch(ticket, changes, 'result', patch.result, 2000);
    if (patch.needsMoreInfo !== undefined && ticket.needsMoreInfo !== patch.needsMoreInfo) {
      changes.needsMoreInfo = { from: ticket.needsMoreInfo, to: patch.needsMoreInfo };
      ticket.needsMoreInfo = patch.needsMoreInfo;
    }
    if (
      ticket.type === 'account_application' &&
      (patch.status === 'rejected' || patch.status === 'closed') &&
      invalidateAccountApplicationDraft(ticket, patch.status, this.now().toISOString())
    ) {
      changes.credentialDraftStatus = { from: 'pending', to: 'invalidated' };
    }

    const updatedAt = this.now().toISOString();
    ticket.updatedAt = updatedAt;
    const auditEntry: TicketAuditEntry = {
      at: updatedAt,
      actor: {
        userId: actor.userId,
        username: actor.username,
        role: actor.role
      },
      action: 'admin_update',
      changes
    };
    ticket.auditTrail = [...ticket.auditTrail, auditEntry];
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async addTicketMessage(
    ticketNo: string,
    input: { text: string; authorRole: string; audience: TicketMessageAudience; authorLabel?: string },
    actor: TicketUpdateActor = {}
  ): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    const text = sanitizeTicketText(input.text, 4000);
    if (!text) {
      throw new TicketValidationError('Message text is required');
    }
    if (input.audience !== 'user' && input.audience !== 'internal') {
      throw new TicketValidationError('Invalid message audience');
    }
    const createdAt = this.now().toISOString();
    const message: TicketMessage = {
      id: randomUUID(),
      authorRole: input.authorRole,
      authorLabel: sanitizeTicketText(input.authorLabel, 120),
      text,
      createdAt,
      audience: input.audience
    };
    // 旧工单可能没有 messages 字段（schemaVersion 1 早于本特性）→ 兜底为空数组。
    ticket.messages = [...(ticket.messages ?? []), message];
    ticket.updatedAt = createdAt;
    ticket.auditTrail = [
      ...ticket.auditTrail,
      {
        at: createdAt,
        actor: { userId: actor.userId, username: actor.username, role: actor.role },
        action: 'message',
        changes: { messageId: message.id, audience: message.audience }
      }
    ];
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async approveAccountApplicationTicket(
    ticketNo: string,
    approval: {
      userId: string;
      username: string;
      result?: string;
    },
    actor: TicketUpdateActor = {}
  ): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    if (ticket.type !== 'account_application') {
      throw new TicketValidationError('Ticket is not an account application');
    }
    const payload = asAccountApplicationPayload(ticket.payload);
    const draft = payload?.credentialDraft;
    if (!payload || !draft) {
      throw new TicketValidationError('Account application credential draft is missing');
    }
    if (draft.status !== 'pending') {
      throw new TicketValidationError('Account application credential draft is not pending');
    }
    if (Date.parse(draft.expiresAt) <= this.now().getTime()) {
      draft.status = 'expired';
      await this.writeTicket(ticket);
      await this.rebuildIndex();
      throw new TicketValidationError('Account application credential draft has expired');
    }

    const previousStatus = ticket.status;
    const updatedAt = this.now().toISOString();
    draft.status = 'consumed';
    draft.consumedAt = updatedAt;
    ticket.status = 'approved';
    ticket.result = sanitizeTicketText(approval.result, 2000) ?? 'Account approved';
    ticket.updatedAt = updatedAt;
    payload.approvedUserId = approval.userId;
    payload.approvedUsername = approval.username;
    payload.approvedAt = updatedAt;
    ticket.payload = payload as unknown as Record<string, unknown>;
    ticket.auditTrail = [
      ...ticket.auditTrail,
      {
        at: updatedAt,
        actor: {
          userId: actor.userId,
          username: actor.username,
          role: actor.role
        },
        action: 'admin_update',
        changes: {
          status: { from: previousStatus, to: 'approved' },
          credentialDraftStatus: { from: 'pending', to: 'consumed' }
        }
      }
    ];
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async listAllTicketRecords(): Promise<TicketRecord[]> {
    return this.readAllTickets();
  }

  async replaceTicketAttachments(ticketNo: string, attachments: TicketAttachmentMeta[]): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    const safeInput = sanitizeCreateTicketInput({
      type: ticket.type,
      attachments
    });
    ticket.attachments = safeInput.attachments ?? [];
    ticket.updatedAt = this.now().toISOString();
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async updateDatasheetReview(
    ticketNo: string,
    patch: DatasheetAdminReviewUpdate,
    actor: TicketUpdateActor = {}
  ): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    if (ticket.type !== 'datasheet_submission') {
      throw new TicketValidationError('Ticket is not a datasheet submission');
    }
    const uploadReview = getDatasheetUploadReview(ticket.payload);
    if (!uploadReview) {
      throw new TicketValidationError('Datasheet upload review payload is missing');
    }

    const changes: Record<string, unknown> = {};
    const nextStatus = patch.status;
    if (nextStatus !== undefined) {
      assertDatasheetStatusTransition(ticket.status, nextStatus);
      if (ticket.status !== nextStatus) {
        changes.status = { from: ticket.status, to: nextStatus };
        ticket.status = nextStatus;
        uploadReview.state = nextStatus;
      }
    }

    this.applyStringPatch(ticket, changes as Record<string, { from: unknown; to: unknown }>, 'publicNote', patch.publicNote, 2000);
    this.applyStringPatch(ticket, changes as Record<string, { from: unknown; to: unknown }>, 'internalNote', patch.internalNote, 4000);
    this.applyStringPatch(ticket, changes as Record<string, { from: unknown; to: unknown }>, 'result', patch.result, 2000);
    if (patch.needsMoreInfo !== undefined && ticket.needsMoreInfo !== patch.needsMoreInfo) {
      changes.needsMoreInfo = { from: ticket.needsMoreInfo, to: patch.needsMoreInfo };
      ticket.needsMoreInfo = patch.needsMoreInfo;
    }

    if (patch.metadataCandidate !== undefined) {
      const previousKeys = Object.keys(uploadReview.metadataCandidate ?? {}).sort();
      uploadReview.metadataCandidate = normalizeDatasheetMetadataCandidate({
        ...(uploadReview.metadataCandidate ?? { applicationTags: [] }),
        ...patch.metadataCandidate
      });
      changes.metadataCandidateKeys = {
        from: previousKeys,
        to: Object.keys(uploadReview.metadataCandidate).sort()
      };
    }

    if (ticket.status === 'linked') {
      assertDatasheetLinkableMetadata(uploadReview.metadataCandidate);
    }
    if (ticket.status === 'accepted' || ticket.status === 'linked') {
      uploadReview.bindingIntent = {
        intent: ticket.status,
        visibility: 'restricted',
        searchable: false,
        acceptedAt: this.now().toISOString(),
        acceptedBy: actor.username ?? actor.userId,
        metadataCandidate: normalizeDatasheetMetadataCandidate(uploadReview.metadataCandidate),
        note: sanitizeTicketText(patch.bindingNote, 500)
      };
      changes.bindingIntent = {
        intent: uploadReview.bindingIntent.intent,
        searchable: false,
        visibility: 'restricted',
        metadataKeys: Object.keys(uploadReview.bindingIntent.metadataCandidate).sort()
      };
    } else if (ticket.status === 'rejected' || ticket.status === 'needs_more_info') {
      uploadReview.bindingIntent = null;
      changes.bindingIntent = null;
    }

    uploadReview.searchable = false;
    uploadReview.visibilityCandidate = 'restricted';
    uploadReview.catalogBinding = null;
    ticket.payload = {
      ...ticket.payload,
      uploadReview
    };

    const updatedAt = this.now().toISOString();
    ticket.updatedAt = updatedAt;
    ticket.auditTrail = [
      ...ticket.auditTrail,
      {
        at: updatedAt,
        actor: {
          userId: actor.userId,
          username: actor.username,
          role: actor.role
        },
        action: 'datasheet_review',
        changes
      }
    ];
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async replaceTicketPayload(
    ticketNo: string,
    payload: Record<string, unknown>,
    actor: TicketUpdateActor = {}
  ): Promise<TicketRecord> {
    const ticket = await this.getTicket(ticketNo);
    const safeInput = sanitizeCreateTicketInput({
      type: ticket.type,
      payload
    });
    ticket.payload = safeInput.payload ?? {};
    const updatedAt = this.now().toISOString();
    ticket.updatedAt = updatedAt;
    const uploadReview = ticket.type === 'datasheet_submission' ? getDatasheetUploadReview(ticket.payload) : undefined;
    if (uploadReview) {
      ticket.auditTrail = [
        ...ticket.auditTrail,
        {
          at: updatedAt,
          actor: {
            userId: actor.userId,
            username: actor.username,
            role: actor.role
          },
          action: 'upload_scan',
          changes: {
            uploadReviewState: uploadReview.state,
            securityScanStatus: uploadReview.securityScan.status,
            attachmentCount: uploadReview.securityScan.attachments.length
          }
        }
      ];
    }
    await this.writeTicket(ticket);
    await this.rebuildIndex();
    return ticket;
  }

  async rebuildIndex(): Promise<void> {
    await mkdir(this.ticketsDir, { recursive: true });
    const content = (await this.readAllTickets())
      .map(toTicketListItem)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => JSON.stringify(item))
      .join('\n');
    const tempPath = path.join(this.ticketsDir, `index.jsonl.tmp-${process.pid}-${Date.now()}`);
    try {
      await writeFile(tempPath, content ? `${content}\n` : '', 'utf8');
      await rename(tempPath, this.indexFile);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  private async nextTicketNo(type: CreateTicketInput['type'], now: Date): Promise<string> {
    if (!isTicketType(type)) {
      throw new TicketValidationError('Ticket type is required');
    }
    const prefix = TICKET_TYPE_PREFIX[type];
    const dateKey = now.toISOString().slice(0, 10);
    const ticketDate = dateKey.replace(/-/g, '');
    const counterPath = this.counterPath(dateKey);
    const counter = await readJsonFile<CounterFile>(counterPath, {
      date: dateKey,
      counters: {},
      updatedAt: now.toISOString()
    });
    const nextValue = (counter.counters[prefix] ?? 0) + 1;
    counter.date = dateKey;
    counter.counters[prefix] = nextValue;
    counter.updatedAt = now.toISOString();
    await writeJsonAtomic(counterPath, counter);
    return `${prefix}-${ticketDate}-${String(nextValue).padStart(4, '0')}`;
  }

  private async writeTicket(ticket: TicketRecord): Promise<void> {
    assertSafeTicketNo(ticket.ticketNo);
    await writeJsonAtomic(this.detailPath(ticket), ticket);
  }

  private detailPath(ticket: TicketRecord): string {
    assertSafeTicketNo(ticket.ticketNo);
    const date = new Date(ticket.createdAt);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return path.join(this.detailDir, year, month, `${ticket.ticketNo}.json`);
  }

  private counterPath(dateKey: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      throw new TicketValidationError('Invalid counter date');
    }
    return path.join(this.counterDir, `${dateKey}.json`);
  }

  private async readAllTickets(): Promise<TicketRecord[]> {
    const files = await this.listDetailFiles();
    const tickets: TicketRecord[] = [];
    for (const file of files) {
      tickets.push(await readJsonFile<TicketRecord>(file));
    }
    return tickets;
  }

  private async listDetailFiles(): Promise<string[]> {
    const files: string[] = [];
    let years: string[];
    try {
      years = await readdir(this.detailDir);
    } catch {
      return files;
    }
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) {
        continue;
      }
      const yearDir = path.join(this.detailDir, year);
      const months = await readdir(yearDir).catch(() => []);
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) {
          continue;
        }
        const monthDir = path.join(yearDir, month);
        for (const entry of await readdir(monthDir).catch(() => [])) {
          if (/^(FB|DS|AP)-\d{8}-\d{4}\.json$/.test(entry)) {
            files.push(path.join(monthDir, entry));
          }
        }
      }
    }
    return files;
  }

  private applyStringPatch(
    ticket: TicketRecord,
    changes: Record<string, { from: unknown; to: unknown }>,
    field: 'publicNote' | 'internalNote' | 'result',
    value: string | undefined,
    limit: number
  ): void {
    if (value === undefined) {
      return;
    }
    const sanitized = sanitizeTicketText(value, limit);
    if (ticket[field] !== sanitized) {
      changes[field] = { from: ticket[field], to: sanitized };
      ticket[field] = sanitized;
    }
  }

  private withCounterQueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.counterQueue.then(operation, operation);
    this.counterQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

const DATASHEET_REVIEW_TRANSITIONS: Record<DatasheetUploadReviewState, readonly string[]> = {
  submitted: ['scanning', 'quarantined', 'needs_more_info', 'accepted', 'rejected', 'reviewing', 'received', 'closed', 'deferred'],
  scanning: ['quarantined', 'accepted', 'rejected', 'needs_more_info', 'reviewing'],
  quarantined: ['reviewing', 'accepted', 'rejected', 'needs_more_info', 'closed'],
  reviewing: ['needs_more_info', 'accepted', 'rejected', 'closed'],
  needs_more_info: ['submitted', 'scanning', 'reviewing', 'accepted', 'rejected', 'closed'],
  accepted: ['linked', 'archived', 'closed'],
  rejected: ['closed'],
  linked: ['archived', 'closed']
};

const DATASHEET_REVIEW_STATES = new Set<DatasheetUploadReviewState>([
  'submitted',
  'scanning',
  'quarantined',
  'reviewing',
  'accepted',
  'rejected',
  'needs_more_info',
  'linked'
]);

function assertDatasheetStatusTransition(from: string, to: string): void {
  if (from === to) {
    return;
  }
  if (!DATASHEET_REVIEW_STATES.has(from as DatasheetUploadReviewState)) {
    return;
  }
  const allowed = DATASHEET_REVIEW_TRANSITIONS[from as DatasheetUploadReviewState] ?? [];
  if (!allowed.includes(to)) {
    throw new TicketValidationError('Invalid datasheet upload review status transition');
  }
}

function syncDatasheetUploadReviewState(ticket: TicketRecord, status: string): void {
  if (!DATASHEET_REVIEW_STATES.has(status as DatasheetUploadReviewState)) {
    return;
  }
  const uploadReview = getDatasheetUploadReview(ticket.payload);
  if (!uploadReview) {
    return;
  }
  ticket.payload = {
    ...ticket.payload,
    uploadReview: {
      ...uploadReview,
      state: status as DatasheetUploadReviewState
    }
  };
}

function getDatasheetUploadReview(payload: Record<string, unknown>): DatasheetUploadReviewPayload | undefined {
  const review = payload.uploadReview;
  if (!isRecord(review) || !isRecord(review.securityScan) || !Array.isArray(review.securityScan.attachments)) {
    return undefined;
  }
  return review as unknown as DatasheetUploadReviewPayload;
}

function matchesFilters(ticket: TicketRecord, filters: TicketListFilters): boolean {
  if (filters.type && ticket.type !== filters.type) return false;
  if (filters.status && ticket.status !== filters.status) return false;
  if (filters.needsMoreInfo !== undefined && ticket.needsMoreInfo !== filters.needsMoreInfo) return false;
  if (filters.accountUserId && ticket.accountBinding?.userId !== filters.accountUserId) return false;
  if (filters.feedbackType && !matchesFeedbackType(ticket, filters.feedbackType)) return false;
  if (filters.chipId && readFeedbackSnapshotString(ticket, 'chipId') !== filters.chipId) return false;
  if (filters.documentId && readFeedbackSnapshotString(ticket, 'documentId') !== filters.documentId) return false;
  if (filters.scopePresetId && readFeedbackSnapshotString(ticket, 'scopePresetId') !== filters.scopePresetId) return false;
  if (filters.modelId && readFeedbackSnapshotString(ticket, 'modelId') !== filters.modelId) return false;
  if (filters.reviewSignal && readFeedbackSnapshotString(ticket, 'reviewSignal') !== filters.reviewSignal) return false;
  if (filters.keyword && !matchesKeyword(ticket, filters.keyword)) return false;
  return true;
}

function matchesKeyword(ticket: TicketRecord, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return collectTicketKeywordFields(ticket).some((value) => value.toLowerCase().includes(needle));
}

function collectTicketKeywordFields(ticket: TicketRecord): string[] {
  const payload = isRecord(ticket.payload) ? ticket.payload : {};
  const application = isRecord(payload.application) ? payload.application : {};
  const feedbackSnapshot = isRecord(payload.feedbackSnapshot) ? payload.feedbackSnapshot : {};
  return [
    ticket.ticketNo,
    ticket.title,
    ticket.status,
    ticket.type,
    readPayloadString(application, 'username'),
    readPayloadString(application, 'company'),
    readPayloadString(application, 'occupation'),
    readPayloadString(payload, 'vendor'),
    readPayloadString(payload, 'partNumberOrKeywords'),
    readPayloadString(payload, 'sourceNote'),
    readPayloadString(payload, 'category'),
    readPayloadString(payload, 'content')?.slice(0, 1000),
    readPayloadString(feedbackSnapshot, 'sessionId'),
    readPayloadString(feedbackSnapshot, 'turnId'),
    readPayloadString(feedbackSnapshot, 'chipId'),
    readPayloadString(feedbackSnapshot, 'documentId'),
    readPayloadString(feedbackSnapshot, 'scopePresetId'),
    readPayloadString(feedbackSnapshot, 'modelId'),
    readPayloadString(feedbackSnapshot, 'answerTextHash'),
    readPayloadString(feedbackSnapshot, 'answerExcerpt')?.slice(0, 1000)
  ].filter((value): value is string => typeof value === 'string' && value.trim() !== '');
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function matchesFeedbackType(ticket: TicketRecord, feedbackType: string): boolean {
  const snapshotTypes = readFeedbackSnapshotArray(ticket, 'feedbackTypes');
  if (snapshotTypes.includes(feedbackType)) {
    return true;
  }
  const payloadTypes = readPayloadArray(ticket.payload, 'feedbackTypes');
  if (payloadTypes.includes(feedbackType)) {
    return true;
  }
  const category = readPayloadString(ticket.payload, 'category');
  return Boolean(category?.split(',').map((item) => item.trim()).includes(feedbackType));
}

function readFeedbackSnapshotString(ticket: TicketRecord, key: string): string | undefined {
  const snapshot = isRecord(ticket.payload.feedbackSnapshot) ? ticket.payload.feedbackSnapshot : {};
  return readPayloadString(snapshot, key);
}

function readFeedbackSnapshotArray(ticket: TicketRecord, key: string): string[] {
  const snapshot = isRecord(ticket.payload.feedbackSnapshot) ? ticket.payload.feedbackSnapshot : {};
  return readPayloadArray(snapshot, key);
}

function readPayloadArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function invalidateAccountApplicationDraft(ticket: TicketRecord, reason: string, now: string): boolean {
  const payload = asAccountApplicationPayload(ticket.payload);
  const draft = payload?.credentialDraft;
  if (!payload || !draft || draft.status !== 'pending') {
    return false;
  }
  draft.status = 'invalidated';
  draft.invalidatedAt = now;
  draft.invalidatedReason = reason;
  ticket.payload = payload as unknown as Record<string, unknown>;
  return true;
}

function asAccountApplicationPayload(value: Record<string, unknown>): AccountApplicationPayload | undefined {
  if (!isRecord(value) || !isRecord(value.application) || !isRecord(value.credentialDraft)) {
    return undefined;
  }
  const draft = value.credentialDraft as Partial<AccountApplicationPayload['credentialDraft']>;
  if (
    typeof draft.passwordHash !== 'string' ||
    typeof draft.createdAt !== 'string' ||
    typeof draft.expiresAt !== 'string' ||
    (draft.status !== 'pending' && draft.status !== 'consumed' && draft.status !== 'invalidated' && draft.status !== 'expired')
  ) {
    return undefined;
  }
  return value as unknown as AccountApplicationPayload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeDatasheetMetadataCandidate(input: Partial<DatasheetMetadataCandidate>): DatasheetMetadataCandidate {
  return {
    vendor: sanitizeTicketText(input.vendor, 160),
    partNumber: sanitizeTicketText(input.partNumber, 240),
    brand: sanitizeTicketText(input.brand, 160),
    productLine: sanitizeTicketText(input.productLine, 160),
    application: sanitizeTicketText(input.application, 160),
    chipId: sanitizeTicketText(input.chipId, 120),
    documentId: sanitizeTicketText(input.documentId, 160),
    scopePresetId: sanitizeTicketText(input.scopePresetId, 160),
    applicationTags: normalizeStringList(input.applicationTags, 20, 80),
    resolution: input.resolution
  };
}

function assertDatasheetLinkableMetadata(candidate: DatasheetMetadataCandidate): void {
  if (!candidate.chipId && !candidate.documentId && !candidate.scopePresetId) {
    throw new TicketValidationError('Linked datasheet review requires chipId, documentId, or scopePresetId candidate');
  }
}

function normalizeStringList(values: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const output: string[] = [];
  for (const value of values) {
    const safe = sanitizeTicketText(value, maxLength);
    if (safe && !output.includes(safe)) {
      output.push(safe);
    }
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 50;
  }
  return Math.max(0, Math.min(200, Math.floor(value)));
}
