import type { DocumentVisibility, ResourceGrantInput } from '../security/index.js';

export type AnnouncementContentType = 'announcement' | 'news' | 'release_note' | 'changelog';
export type AnnouncementContentStatus = 'draft' | 'published' | 'offline' | 'archived';
export type AnnouncementModalBehavior = 'none' | 'once_per_version' | 'force_until_expiry';
export type AnnouncementLocale = 'zh-CN' | 'en-US';

export interface AnnouncementTranslation {
  title: string;
  summary: string;
  body: string;
}

export type AnnouncementTranslations = {
  'zh-CN': AnnouncementTranslation;
  'en-US'?: AnnouncementTranslation;
};

export interface AnnouncementSourceRef {
  kind: 'manual' | 'phase_release_note' | 'phase_changelog';
  phase?: number;
  version?: string;
  note?: string;
}

export interface AnnouncementContentItem {
  id: string;
  type: AnnouncementContentType;
  status: AnnouncementContentStatus;
  title: string;
  summary: string;
  body: string;
  translations?: AnnouncementTranslations;
  visibility: DocumentVisibility;
  requiresLogin: boolean;
  roleAllowList: string[];
  requiredGrants: ResourceGrantInput;
  pinned: boolean;
  priority: number;
  modalBehavior: AnnouncementModalBehavior;
  startsAt?: string;
  endsAt?: string;
  revision: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  sourceRef?: AnnouncementSourceRef;
}

export interface AnnouncementUserItemState {
  lastReadRevision?: number;
  lastDismissedRevision?: number;
  lastReadAt?: string;
  lastDismissedAt?: string;
}

export interface AnnouncementUserState {
  userId: string;
  items: Record<string, AnnouncementUserItemState>;
}

export interface PublicAnnouncementState {
  read: boolean;
  dismissed: boolean;
  lastReadAt?: string;
  lastDismissedAt?: string;
}

export interface PublicAnnouncementContentItem {
  id: string;
  type: AnnouncementContentType;
  status: 'published';
  title: string;
  summary: string;
  body: string;
  visibility: DocumentVisibility;
  requiresLogin: boolean;
  pinned: boolean;
  priority: number;
  modalBehavior: AnnouncementModalBehavior;
  startsAt?: string;
  endsAt?: string;
  revision: number;
  publishedAt?: string;
  updatedAt: string;
  state?: PublicAnnouncementState;
}

export interface AnnouncementHomeResult {
  modalCandidate: PublicAnnouncementContentItem | null;
  feed: PublicAnnouncementContentItem[];
}

export interface AnnouncementFeedResult {
  items: PublicAnnouncementContentItem[];
}

export interface AnnouncementReadStateSummary {
  revision: number;
  readCount: number;
  dismissedCount: number;
}
