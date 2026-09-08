import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { readJsonFile, writeJsonAtomic } from '../persistence/index.js';
import { normalizeResourceGrantSet, type ResourceGrantInput } from '../security/index.js';
import {
  normalizeAnnouncementVisibility,
  sortAnnouncementContentItems
} from './visibility.js';
import type {
  AnnouncementContentItem,
  AnnouncementContentStatus,
  AnnouncementContentType,
  AnnouncementFeedResult,
  AnnouncementHomeResult,
  AnnouncementLocale,
  AnnouncementModalBehavior,
  AnnouncementReadStateSummary,
  AnnouncementSourceRef,
  AnnouncementTranslations,
  AnnouncementUserItemState,
  AnnouncementUserState,
  PublicAnnouncementContentItem
} from './types.js';
import {
  evaluateAnnouncementVisibility,
  shouldShowAnnouncementModal,
  toPublicAnnouncementDto,
  type AnnouncementViewerContext
} from './visibility.js';

export interface AnnouncementStoreOptions {
  dataDir: string;
  now?: () => Date;
}

interface AnnouncementContentFile {
  items: AnnouncementContentItem[];
}

const CONTENT_TYPES = new Set<AnnouncementContentType>(['announcement', 'news', 'release_note', 'changelog']);
const CONTENT_STATUSES = new Set<AnnouncementContentStatus>(['draft', 'published', 'offline', 'archived']);
const MODAL_BEHAVIORS = new Set<AnnouncementModalBehavior>(['none', 'once_per_version', 'force_until_expiry']);
const USER_STATE_ID_PATTERN = /[^A-Za-z0-9._-]/g;
const FORCE_UNTIL_EXPIRY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export class AnnouncementStore {
  readonly announcementsDir: string;
  readonly userStateDir: string;
  private readonly contentFile: string;
  private readonly now: () => Date;

  constructor(options: AnnouncementStoreOptions) {
    this.announcementsDir = path.join(options.dataDir, 'announcements');
    this.userStateDir = path.join(this.announcementsDir, 'user-state');
    this.contentFile = path.join(this.announcementsDir, 'content.json');
    this.now = options.now ?? (() => new Date());
  }

  async listItems(): Promise<AnnouncementContentItem[]> {
    const file = await readJsonFile<AnnouncementContentFile | AnnouncementContentItem[]>(this.contentFile, { items: [] });
    const rawItems = Array.isArray(file) ? file : Array.isArray(file.items) ? file.items : [];
    return rawItems
      .map(normalizeAnnouncementContentItem)
      .filter((item) => {
        try {
          validateAnnouncementContentItem(item);
          return true;
        } catch {
          return false;
        }
      });
  }

  async replaceItems(items: AnnouncementContentItem[]): Promise<void> {
    const normalized = items.map(normalizeAnnouncementContentItem);
    validateUniqueIds(normalized);
    for (const item of normalized) {
      validateAnnouncementContentItem(item);
    }
    await writeJsonAtomic(this.contentFile, { items: sortAnnouncementContentItems(normalized) });
  }

  async upsertItem(item: AnnouncementContentItem): Promise<AnnouncementContentItem> {
    const normalized = normalizeAnnouncementContentItem(item);
    validateAnnouncementContentItem(normalized);
    const items = await this.listItems();
    const index = items.findIndex((candidate) => candidate.id === normalized.id);
    if (index >= 0) {
      items[index] = normalized;
    } else {
      items.push(normalized);
    }
    validateUniqueIds(items);
    await writeJsonAtomic(this.contentFile, { items: sortAnnouncementContentItems(items) });
    return normalized;
  }

  async getItem(id: string): Promise<AnnouncementContentItem | undefined> {
    const normalizedId = normalizeId(id, 'id');
    return (await this.listItems()).find((item) => item.id === normalizedId);
  }

  async getHome(
    context: AnnouncementViewerContext = {},
    userId?: string,
    locale: AnnouncementLocale = 'zh-CN'
  ): Promise<AnnouncementHomeResult> {
    const state = userId ? await this.getUserState(userId) : undefined;
    const visible = await this.listVisibleDtos(context, state, locale);
    const candidates = visible
      .filter((dto) => dto.type === 'announcement')
      .filter((dto) => shouldShowAnnouncementModalFromDto(dto, state?.items[dto.id]));

    return {
      modalCandidate: candidates[0] ?? null,
      feed: visible.slice(0, 5)
    };
  }

  async getFeed(
    context: AnnouncementViewerContext = {},
    userId?: string,
    locale: AnnouncementLocale = 'zh-CN'
  ): Promise<AnnouncementFeedResult> {
    const state = userId ? await this.getUserState(userId) : undefined;
    return { items: await this.listVisibleDtos(context, state, locale) };
  }

  async markRead(userId: string, item: AnnouncementContentItem): Promise<void> {
    await this.updateUserItemState(userId, item.id, {
      lastReadRevision: item.revision,
      lastReadAt: this.now().toISOString()
    });
  }

  async markDismissed(userId: string, item: AnnouncementContentItem): Promise<void> {
    await this.updateUserItemState(userId, item.id, {
      lastDismissedRevision: item.revision,
      lastDismissedAt: this.now().toISOString()
    });
  }

  async getUserState(userId: string): Promise<AnnouncementUserState> {
    const normalizedUserId = normalizeUserStateId(userId);
    const fallback: AnnouncementUserState = { userId, items: {} };
    const state = await readJsonFile<AnnouncementUserState>(this.userStatePath(normalizedUserId), fallback);
    return normalizeAnnouncementUserState(state, userId);
  }

  async setUserState(state: AnnouncementUserState): Promise<void> {
    const normalized = normalizeAnnouncementUserState(state, state.userId);
    await writeJsonAtomic(this.userStatePath(normalizeUserStateId(normalized.userId)), normalized);
  }

  async getReadStateSummary(item: AnnouncementContentItem): Promise<AnnouncementReadStateSummary> {
    let readCount = 0;
    let dismissedCount = 0;
    for (const state of await this.listUserStates()) {
      const itemState = state.items[item.id];
      if (!itemState) {
        continue;
      }
      if ((itemState.lastReadRevision ?? 0) >= item.revision) {
        readCount += 1;
      }
      if ((itemState.lastDismissedRevision ?? 0) >= item.revision) {
        dismissedCount += 1;
      }
    }
    return { revision: item.revision, readCount, dismissedCount };
  }

  async getReadStateSummaries(items: AnnouncementContentItem[]): Promise<Record<string, AnnouncementReadStateSummary>> {
    const summaries: Record<string, AnnouncementReadStateSummary> = {};
    const states = await this.listUserStates();
    for (const item of items) {
      summaries[item.id] = { revision: item.revision, readCount: 0, dismissedCount: 0 };
    }
    for (const state of states) {
      for (const item of items) {
        const itemState = state.items[item.id];
        if (!itemState) {
          continue;
        }
        if ((itemState.lastReadRevision ?? 0) >= item.revision) {
          summaries[item.id]!.readCount += 1;
        }
        if ((itemState.lastDismissedRevision ?? 0) >= item.revision) {
          summaries[item.id]!.dismissedCount += 1;
        }
      }
    }
    return summaries;
  }

  async canUserAccessItem(item: AnnouncementContentItem, context: AnnouncementViewerContext): Promise<boolean> {
    return evaluateAnnouncementVisibility(item, context).allowed;
  }

  private async listVisibleDtos(
    context: AnnouncementViewerContext,
    state: AnnouncementUserState | undefined,
    locale: AnnouncementLocale
  ): Promise<PublicAnnouncementContentItem[]> {
    const visible = (await this.listItems()).filter((item) => evaluateAnnouncementVisibility(item, context).allowed);
    return sortAnnouncementContentItems(visible).map((item) => toPublicAnnouncementDto(item, state?.items[item.id], locale));
  }

  private async updateUserItemState(
    userId: string,
    itemId: string,
    patch: AnnouncementUserItemState
  ): Promise<void> {
    const state = await this.getUserState(userId);
    const current = state.items[itemId] ?? {};
    state.items[itemId] = { ...current, ...patch };
    await this.setUserState(state);
  }

  private userStatePath(normalizedUserId: string): string {
    return path.join(this.userStateDir, `${normalizedUserId}.json`);
  }

  private async listUserStates(): Promise<AnnouncementUserState[]> {
    let entries: string[];
    try {
      entries = await readdir(this.userStateDir);
    } catch {
      return [];
    }
    const states: AnnouncementUserState[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const fallbackUserId = entry.slice(0, -'.json'.length) || 'unknown';
      const state = await readJsonFile<AnnouncementUserState | null>(path.join(this.userStateDir, entry), null);
      if (state) {
        states.push(normalizeAnnouncementUserState(state, fallbackUserId));
      }
    }
    return states;
  }
}

export function normalizeAnnouncementContentItem(input: unknown): AnnouncementContentItem {
  if (!isRecord(input)) {
    throw new Error('Announcement content item must be an object');
  }
  const translations = normalizeTranslations(input.translations, input);
  const primary = translations['zh-CN'];
  const item: AnnouncementContentItem = {
    id: normalizeId(input.id, 'id'),
    type: normalizeType(input.type),
    status: normalizeStatus(input.status),
    title: primary.title,
    summary: primary.summary,
    body: primary.body,
    translations,
    visibility: normalizeAnnouncementVisibility(input.visibility),
    requiresLogin: input.requiresLogin === true,
    roleAllowList: normalizeStringList(input.roleAllowList),
    requiredGrants: normalizeRequiredGrants(input.requiredGrants),
    pinned: input.pinned === true,
    priority: normalizeInteger(input.priority, 0),
    modalBehavior: normalizeModalBehavior(input.modalBehavior),
    revision: normalizeRevision(input.revision),
    createdAt: normalizeIso(input.createdAt, 'createdAt') ?? new Date(0).toISOString(),
    updatedAt: normalizeIso(input.updatedAt, 'updatedAt') ?? new Date(0).toISOString(),
    createdBy: normalizeRequiredText(input.createdBy, 'createdBy', 120),
    updatedBy: normalizeRequiredText(input.updatedBy, 'updatedBy', 120)
  };
  const startsAt = normalizeIso(input.startsAt, 'startsAt');
  if (startsAt) item.startsAt = startsAt;
  const endsAt = normalizeIso(input.endsAt, 'endsAt');
  if (endsAt) item.endsAt = endsAt;
  const publishedAt = normalizeIso(input.publishedAt, 'publishedAt');
  if (publishedAt) item.publishedAt = publishedAt;
  const sourceRef = normalizeSourceRef(input.sourceRef);
  if (sourceRef) item.sourceRef = sourceRef;
  return item;
}

function normalizeTranslations(
  value: unknown,
  legacy: Record<string, unknown>
): AnnouncementTranslations {
  const source = isRecord(value) ? value : {};
  const zh = normalizeTranslation(source['zh-CN'], legacy, true);
  const translations: AnnouncementTranslations = { 'zh-CN': zh };
  if (isRecord(source['en-US'])) {
    translations['en-US'] = normalizeTranslation(source['en-US'], {}, false);
  }
  return translations;
}

function normalizeTranslation(
  value: unknown,
  fallback: Record<string, unknown>,
  required: boolean
): AnnouncementTranslations['zh-CN'] {
  const source = isRecord(value) ? value : {};
  return {
    title: normalizeTranslationText(source.title ?? fallback.title, 'title', 160, required),
    summary: normalizeTranslationText(source.summary ?? fallback.summary, 'summary', 500, required),
    body: normalizeTranslationText(source.body ?? fallback.body, 'body', 20000, required)
  };
}

function normalizeTranslationText(value: unknown, field: string, maxLength: number, required: boolean): string {
  if (typeof value !== 'string') {
    if (required) {
      throw new Error(`${field} is required`);
    }
    return '';
  }
  const normalized = value.trim().slice(0, maxLength);
  if (required && normalized === '') {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

export function validateAnnouncementContentItem(item: AnnouncementContentItem): void {
  if (item.startsAt && item.endsAt && Date.parse(item.startsAt) >= Date.parse(item.endsAt)) {
    throw new Error('endsAt must be after startsAt');
  }
  if (item.modalBehavior === 'force_until_expiry') {
    if (item.type !== 'announcement') {
      throw new Error('force_until_expiry is only valid for announcements');
    }
    if (item.status === 'published' && !item.endsAt) {
      throw new Error('force_until_expiry requires endsAt');
    }
    if (item.status === 'published' && item.endsAt) {
      const startsAt = Date.parse(item.startsAt ?? item.publishedAt ?? item.createdAt);
      const endsAt = Date.parse(item.endsAt);
      if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt) {
        throw new Error('endsAt must be after startsAt');
      }
      if (endsAt - startsAt > FORCE_UNTIL_EXPIRY_MAX_MS) {
        throw new Error('force_until_expiry duration must not exceed 7 days');
      }
    }
  }
  if (item.status === 'published' && !item.publishedAt) {
    throw new Error('published content requires publishedAt');
  }
}

function shouldShowAnnouncementModalFromDto(
  dto: PublicAnnouncementContentItem,
  state: AnnouncementUserItemState | undefined
): boolean {
  return shouldShowAnnouncementModal(
    {
      ...dto,
      roleAllowList: [],
      requiredGrants: {},
      createdAt: dto.publishedAt ?? dto.updatedAt,
      createdBy: '',
      updatedBy: ''
    },
    state
  );
}

function normalizeAnnouncementUserState(input: unknown, fallbackUserId: string): AnnouncementUserState {
  if (!isRecord(input)) {
    return { userId: fallbackUserId, items: {} };
  }
  const items: Record<string, AnnouncementUserItemState> = {};
  if (isRecord(input.items)) {
    for (const [id, value] of Object.entries(input.items)) {
      if (!isRecord(value)) {
        continue;
      }
      items[normalizeId(id, 'item id')] = {
        ...(normalizeOptionalRevision(value.lastReadRevision) !== undefined
          ? { lastReadRevision: normalizeOptionalRevision(value.lastReadRevision) }
          : {}),
        ...(normalizeOptionalRevision(value.lastDismissedRevision) !== undefined
          ? { lastDismissedRevision: normalizeOptionalRevision(value.lastDismissedRevision) }
          : {}),
        ...(normalizeIso(value.lastReadAt, 'lastReadAt') ? { lastReadAt: normalizeIso(value.lastReadAt, 'lastReadAt') } : {}),
        ...(normalizeIso(value.lastDismissedAt, 'lastDismissedAt')
          ? { lastDismissedAt: normalizeIso(value.lastDismissedAt, 'lastDismissedAt') }
          : {})
      };
    }
  }
  return {
    userId: typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim() : fallbackUserId,
    items
  };
}

function validateUniqueIds(items: AnnouncementContentItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`Duplicate announcement content id '${item.id}'`);
    }
    ids.add(item.id);
  }
}

function normalizeType(value: unknown): AnnouncementContentType {
  if (typeof value === 'string' && CONTENT_TYPES.has(value as AnnouncementContentType)) {
    return value as AnnouncementContentType;
  }
  throw new Error('Invalid announcement content type');
}

function normalizeStatus(value: unknown): AnnouncementContentStatus {
  if (typeof value === 'string' && CONTENT_STATUSES.has(value as AnnouncementContentStatus)) {
    return value as AnnouncementContentStatus;
  }
  return 'draft';
}

function normalizeModalBehavior(value: unknown): AnnouncementModalBehavior {
  if (typeof value === 'string' && MODAL_BEHAVIORS.has(value as AnnouncementModalBehavior)) {
    return value as AnnouncementModalBehavior;
  }
  return 'none';
}

function normalizeRequiredGrants(value: unknown): ResourceGrantInput {
  return isRecord(value) ? normalizeResourceGrantSet(value) : {};
}

function normalizeSourceRef(value: unknown): AnnouncementSourceRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind !== 'manual' && kind !== 'phase_release_note' && kind !== 'phase_changelog') {
    return undefined;
  }
  const sourceRef: AnnouncementSourceRef = { kind };
  if (typeof value.phase === 'number' && Number.isInteger(value.phase) && value.phase > 0) {
    sourceRef.phase = value.phase;
  }
  if (typeof value.version === 'string' && value.version.trim()) {
    sourceRef.version = value.version.trim().slice(0, 80);
  }
  if (typeof value.note === 'string' && value.note.trim()) {
    sourceRef.note = value.note.trim().slice(0, 500);
  }
  return sourceRef;
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.trim())) {
    throw new Error(`${field} must be a safe identifier`);
  }
  return value.trim();
}

function normalizeUserStateId(value: string): string {
  const normalized = value.trim().replace(USER_STATE_ID_PATTERN, '_').slice(0, 128);
  return normalized || 'anonymous';
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value.trim().slice(0, maxLength);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed && !normalized.includes(trimmed)) {
      normalized.push(trimmed);
    }
  }
  return normalized;
}

function normalizeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function normalizeRevision(value: unknown): number {
  const revision = normalizeInteger(value, 1);
  return revision > 0 ? revision : 1;
}

function normalizeOptionalRevision(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid ISO date`);
  }
  return new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
