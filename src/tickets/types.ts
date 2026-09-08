export type TicketType = 'feedback' | 'datasheet_submission' | 'account_application';
export type TicketPrefix = 'FB' | 'DS' | 'AP';

export type FeedbackTicketStatus =
  | 'submitted'
  | 'received'
  | 'evaluating'
  | 'accepted'
  | 'in_development'
  | 'launched'
  | 'deferred'
  | 'closed';

export type DatasheetTicketStatus =
  | 'submitted'
  | 'scanning'
  | 'quarantined'
  | 'reviewing'
  | 'needs_more_info'
  | 'accepted'
  | 'rejected'
  | 'linked'
  | 'received'
  | 'archived'
  | 'deferred'
  | 'closed';

export type AccountApplicationTicketStatus =
  | 'submitted'
  | 'pending_review'
  | 'needs_more_info'
  | 'approved'
  | 'rejected'
  | 'closed';

export type TicketStatus = FeedbackTicketStatus | DatasheetTicketStatus | AccountApplicationTicketStatus;

export interface TicketContact {
  name?: string;
  email?: string;
  phone?: string;
  company?: string;
  raw?: string;
}

export interface TicketAccountBinding {
  userId: string;
  username?: string;
  role?: string;
}

export interface TicketAttachmentMeta {
  id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cleaned';
  originalName?: string;
  storedName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  storagePath?: string;
  uploadedAt?: string;
  cleanedAt?: string;
  retentionUntil?: string;
  cleanedReason?: string;
  retainedAt?: string;
  retainedBy?: string;
}

export type DatasheetUploadReviewState =
  | 'submitted'
  | 'scanning'
  | 'quarantined'
  | 'reviewing'
  | 'accepted'
  | 'rejected'
  | 'needs_more_info'
  | 'linked';

export type TicketSecurityScanStatus = 'pending' | 'passed' | 'failed' | 'not_supported';

export interface TicketSecurityScanAttachmentDto {
  id: string;
  normalizedName?: string;
  extension?: string;
  mimeType?: string;
  sizeBytes?: number;
  fingerprint?: string;
  isArchive: boolean;
  status: TicketSecurityScanStatus;
  summary: string;
}

export interface TicketSecurityScanDto {
  status: TicketSecurityScanStatus;
  summary: string;
  scannedAt: string;
  policyVersion: 'phase39-local-v1';
  attachments: TicketSecurityScanAttachmentDto[];
}

export interface DatasheetUploadReviewPayload {
  state: DatasheetUploadReviewState;
  searchable: false;
  visibilityCandidate: 'restricted';
  catalogBinding: null;
  bindingIntent?: DatasheetBindingIntent | null;
  disclaimerAccepted: boolean;
  sourceDeclaration?: string;
  securityScan: TicketSecurityScanDto;
  metadataCandidate: DatasheetMetadataCandidate;
}

export type DatasheetCandidateResolution = 'known' | 'proposed' | 'empty';

export interface DatasheetMetadataCandidate {
  vendor?: string;
  partNumber?: string;
  brand?: string;
  productLine?: string;
  application?: string;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  applicationTags: string[];
  resolution?: Partial<Record<
    'brand' | 'productLine' | 'application' | 'chipId' | 'documentId' | 'scopePresetId',
    DatasheetCandidateResolution
  >>;
}

export interface DatasheetBindingIntent {
  intent: 'accepted' | 'linked';
  visibility: 'restricted';
  searchable: false;
  acceptedAt: string;
  acceptedBy?: string;
  metadataCandidate: DatasheetMetadataCandidate;
  note?: string;
}

export type AdminTicketAttachmentDto = Pick<
  TicketAttachmentMeta,
  | 'id'
  | 'status'
  | 'originalName'
  | 'mimeType'
  | 'sizeBytes'
  | 'uploadedAt'
  | 'cleanedAt'
  | 'retentionUntil'
  | 'cleanedReason'
  | 'retainedAt'
  | 'retainedBy'
>;

export interface TicketAuditEntry {
  at: string;
  actor?: {
    userId?: string;
    username?: string;
    role?: string;
  };
  action: 'created' | 'admin_update' | 'upload_scan' | 'datasheet_review' | 'message';
  changes?: Record<string, unknown>;
}

export type TicketMessageAudience = 'user' | 'internal';

export interface TicketMessage {
  id: string;
  authorRole: string;
  authorLabel?: string;
  text: string;
  createdAt: string;
  audience: TicketMessageAudience;
}

export interface TicketMessageDto {
  id: string;
  authorRole: string;
  authorLabel?: string;
  text: string;
  createdAt: string;
  audience: TicketMessageAudience;
}

export interface AccountApplicationFields {
  username: string;
  company?: string;
  reason?: string;
  heardFrom?: string;
  occupation?: string;
  favoriteFeature?: string;
  expectedFeature?: string;
  contact?: string;
}

export interface AccountApplicationCredentialDraft {
  passwordHash: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'consumed' | 'invalidated' | 'expired';
  consumedAt?: string;
  invalidatedAt?: string;
  invalidatedReason?: string;
}

export interface AccountApplicationPayload {
  application: AccountApplicationFields;
  credentialDraft: AccountApplicationCredentialDraft;
  approvedUserId?: string;
  approvedUsername?: string;
  approvedAt?: string;
}

export type AdminAccountApplicationPayload = Omit<AccountApplicationPayload, 'credentialDraft'> & {
  credentialDraft: Omit<AccountApplicationCredentialDraft, 'passwordHash'> & {
    hasPasswordHash: boolean;
  };
};

export interface TicketRecord {
  schemaVersion: 1;
  ticketNo: string;
  type: TicketType;
  status: TicketStatus;
  title?: string;
  createdAt: string;
  updatedAt: string;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  needsMoreInfo: boolean;
  source?: string;
  contact?: TicketContact;
  accountBinding?: TicketAccountBinding;
  attachments: TicketAttachmentMeta[];
  auditTrail: TicketAuditEntry[];
  messages: TicketMessage[];
  payload: Record<string, unknown>;
}

export interface CreateTicketInput {
  type: TicketType;
  title?: string;
  status?: TicketStatus;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  needsMoreInfo?: boolean;
  source?: string;
  contact?: TicketContact;
  accountBinding?: TicketAccountBinding;
  attachments?: TicketAttachmentMeta[];
  payload?: Record<string, unknown>;
}

export interface TicketListFilters {
  type?: TicketType;
  status?: string;
  needsMoreInfo?: boolean;
  accountUserId?: string;
  keyword?: string;
  feedbackType?: string;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  modelId?: string;
  reviewSignal?: string;
  offset?: number;
  limit?: number;
}

export interface TicketAdminUpdate {
  status?: TicketStatus;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  needsMoreInfo?: boolean;
}

export interface DatasheetAdminReviewUpdate {
  status?: DatasheetUploadReviewState;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  needsMoreInfo?: boolean;
  metadataCandidate?: Partial<DatasheetMetadataCandidate>;
  bindingNote?: string;
}

export interface PublicTicketDto {
  ticketNo: string;
  type: TicketType;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  publicNote?: string;
  needsMoreInfo: boolean;
  result?: string;
  messages: TicketMessageDto[];
}

export interface AdminTicketDto {
  ticketNo: string;
  type: TicketType;
  status: TicketStatus;
  title?: string;
  createdAt: string;
  updatedAt: string;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  needsMoreInfo: boolean;
  source?: string;
  contact?: TicketContact;
  accountBinding?: TicketAccountBinding;
  attachments: AdminTicketAttachmentDto[];
  auditTrail: TicketAuditEntry[];
  messages: TicketMessageDto[];
  payload: Record<string, unknown> | AdminAccountApplicationPayload;
}

export interface TicketListItem {
  ticketNo: string;
  type: TicketType;
  status: TicketStatus;
  title?: string;
  createdAt: string;
  updatedAt: string;
  needsMoreInfo: boolean;
  accountUserId?: string;
  uploadReview?: {
    state: DatasheetUploadReviewState;
    securityScanStatus: TicketSecurityScanStatus;
    securityScanSummary: string;
  };
}
