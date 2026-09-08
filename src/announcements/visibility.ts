import {
  canReadVisibility,
  normalizeResourceGrantSet,
  type DocumentVisibility,
  type EffectiveAuthorizationSummary,
  type ResourceGrantInput,
  type ResourceGrantSet
} from '../security/index.js';
import type { GrantValue } from '../security/types.js';
import type {
  AnnouncementContentItem,
  AnnouncementLocale,
  AnnouncementUserItemState,
  PublicAnnouncementContentItem,
  PublicAnnouncementState
} from './types.js';

export type AnnouncementVisibilityReason =
  | 'allowed'
  | 'not_published'
  | 'not_started'
  | 'expired'
  | 'authentication_required'
  | 'identity_unusable'
  | 'visibility_denied'
  | 'role_denied'
  | 'grant_denied';

export interface AnnouncementVisibilityDecision {
  allowed: boolean;
  reasonCode: AnnouncementVisibilityReason;
  safeMessage: string;
}

export interface AnnouncementViewerContext {
  authorization?: EffectiveAuthorizationSummary;
  now?: Date;
}

const SAFE_UNAVAILABLE_MESSAGE = 'The requested content is not available to this identity.';

export function evaluateAnnouncementVisibility(
  item: AnnouncementContentItem,
  context: AnnouncementViewerContext = {}
): AnnouncementVisibilityDecision {
  const now = context.now ?? new Date();
  const publishDecision = evaluatePublishedWindow(item, now);
  if (!publishDecision.allowed) {
    return publishDecision;
  }

  if (!context.authorization) {
    return item.visibility === 'public' && !item.requiresLogin
      ? allow()
      : deny('authentication_required');
  }

  const summary = context.authorization;
  if (!summary.usable) {
    return deny('identity_unusable');
  }

  if (item.requiresLogin && !summary.subject.userId) {
    return deny('authentication_required');
  }

  if (!canReadVisibility(summary.visibilityCeiling, item.visibility)) {
    return deny('visibility_denied');
  }

  if (item.roleAllowList.length > 0 && !item.roleAllowList.includes(summary.subject.role)) {
    return deny('role_denied');
  }

  if (!hasRequiredGrants(summary.grants, item.requiredGrants)) {
    return deny('grant_denied');
  }

  return allow();
}

export function evaluatePublishedWindow(
  item: AnnouncementContentItem,
  now: Date = new Date()
): AnnouncementVisibilityDecision {
  if (item.status !== 'published') {
    return deny('not_published');
  }
  if (item.startsAt && isAfter(item.startsAt, now)) {
    return deny('not_started');
  }
  if (item.endsAt && isBefore(item.endsAt, now)) {
    return deny('expired');
  }
  return allow();
}

export function toPublicAnnouncementDto(
  item: AnnouncementContentItem,
  state?: AnnouncementUserItemState,
  locale: AnnouncementLocale = 'zh-CN'
): PublicAnnouncementContentItem {
  const translation = item.translations?.[locale] ?? item.translations?.['zh-CN'] ?? {
    title: item.title,
    summary: item.summary,
    body: item.body
  };
  const dto: PublicAnnouncementContentItem = {
    id: item.id,
    type: item.type,
    status: 'published',
    title: translation.title,
    summary: translation.summary,
    body: translation.body,
    visibility: item.visibility,
    requiresLogin: item.requiresLogin,
    pinned: item.pinned,
    priority: item.priority,
    modalBehavior: item.modalBehavior,
    revision: item.revision,
    updatedAt: item.updatedAt
  };
  if (item.startsAt) dto.startsAt = item.startsAt;
  if (item.endsAt) dto.endsAt = item.endsAt;
  if (item.publishedAt) dto.publishedAt = item.publishedAt;
  if (state) dto.state = toPublicState(item, state);
  return dto;
}

export function toPublicState(
  item: Pick<AnnouncementContentItem, 'revision'>,
  state: AnnouncementUserItemState
): PublicAnnouncementState {
  const publicState: PublicAnnouncementState = {
    read: (state.lastReadRevision ?? 0) >= item.revision,
    dismissed: (state.lastDismissedRevision ?? 0) >= item.revision
  };
  if (state.lastReadAt) publicState.lastReadAt = state.lastReadAt;
  if (state.lastDismissedAt) publicState.lastDismissedAt = state.lastDismissedAt;
  return publicState;
}

export function shouldShowAnnouncementModal(
  item: AnnouncementContentItem,
  state?: AnnouncementUserItemState
): boolean {
  if (item.type !== 'announcement' || item.modalBehavior === 'none') {
    return false;
  }
  if (item.modalBehavior === 'force_until_expiry') {
    return true;
  }
  return (state?.lastReadRevision ?? 0) < item.revision && (state?.lastDismissedRevision ?? 0) < item.revision;
}

export function sortAnnouncementContentItems<T extends Pick<AnnouncementContentItem, 'pinned' | 'priority' | 'publishedAt' | 'updatedAt'>>(
  items: T[]
): T[] {
  return [...items].sort((left, right) => {
    const pinned = Number(right.pinned) - Number(left.pinned);
    if (pinned !== 0) return pinned;
    const priority = right.priority - left.priority;
    if (priority !== 0) return priority;
    const publishedAt = compareIsoDesc(left.publishedAt, right.publishedAt);
    if (publishedAt !== 0) return publishedAt;
    return compareIsoDesc(left.updatedAt, right.updatedAt);
  });
}

function hasRequiredGrants(grants: ResourceGrantSet, required: ResourceGrantInput): boolean {
  const normalized = normalizeResourceGrantSet(required);
  return (
    hasGrantValues(grants.brands, normalized.brands) &&
    hasGrantValues(grants.productLines, normalized.productLines) &&
    hasGrantValues(grants.chipIds, normalized.chipIds) &&
    hasGrantValues(grants.documentIds, normalized.documentIds) &&
    hasGrantValues(grants.scopePresetIds, normalized.scopePresetIds) &&
    hasGrantValues(grants.modelIds, normalized.modelIds) &&
    hasGrantValues(grants.mcpTools, normalized.mcpTools)
  );
}

function hasGrantValues(granted: readonly GrantValue[], required: readonly GrantValue[]): boolean {
  if (required.length === 0) {
    return true;
  }
  if (granted.includes('*')) {
    return true;
  }
  if (required.includes('*')) {
    return granted.includes('*');
  }
  return required.some((value) => granted.includes(value));
}

function compareIsoDesc(left: string | undefined, right: string | undefined): number {
  return timestamp(right) - timestamp(left);
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isAfter(iso: string, now: Date): boolean {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed > now.getTime();
}

function isBefore(iso: string, now: Date): boolean {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) && parsed < now.getTime();
}

function allow(): AnnouncementVisibilityDecision {
  return { allowed: true, reasonCode: 'allowed', safeMessage: 'Allowed' };
}

function deny(reasonCode: AnnouncementVisibilityReason): AnnouncementVisibilityDecision {
  return { allowed: false, reasonCode, safeMessage: SAFE_UNAVAILABLE_MESSAGE };
}

export function normalizeAnnouncementVisibility(value: unknown): DocumentVisibility {
  return value === 'public' ||
    value === 'customer' ||
    value === 'partner' ||
    value === 'internal' ||
    value === 'restricted' ||
    value === 'adminOnly'
    ? value
    : 'restricted';
}
