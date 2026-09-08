import type { ModelId } from '../model-catalog.js';

export type BuiltInAuthorizationRole = 'admin' | 'internal' | 'partner' | 'customer' | 'public';

export type DocumentVisibility = 'public' | 'customer' | 'partner' | 'internal' | 'restricted' | 'adminOnly';

export type ScopePresetVisibility = DocumentVisibility;

export type AuthorizationResourceType =
  | 'brand'
  | 'productLine'
  | 'chip'
  | 'document'
  | 'scopePreset'
  | 'model'
  | 'mcpTool';

export type GrantValue = string | '*';

export interface ResourceGrantSet {
  brands: GrantValue[];
  productLines: GrantValue[];
  chipIds: GrantValue[];
  documentIds: GrantValue[];
  scopePresetIds: GrantValue[];
  modelIds: Array<ModelId | '*'>;
  mcpTools: GrantValue[];
}

export type ResourceGrantInput = Partial<ResourceGrantSet>;

export interface RoleAuthorizationTemplate {
  role: BuiltInAuthorizationRole;
  label: string;
  visibilityCeiling: DocumentVisibility;
  defaultGrants: ResourceGrantSet;
  deniedByDefault: boolean;
}

export interface AuthorizationSubjectUser {
  id: string;
  username?: string;
  role: string;
  status?: 'active' | 'disabled';
  expiresAt?: string;
  grants?: ResourceGrantInput;
  modelGrants?: readonly string[] | null;
}

export interface AuthorizationSubjectMcpKey {
  id: string;
  fingerprint?: string;
  expiresAt?: string;
  grants?: ResourceGrantInput;
  modelGrants?: readonly string[] | null;
}

export interface AuthorizationSubject {
  user: AuthorizationSubjectUser;
  key?: AuthorizationSubjectMcpKey;
  roleGrants?: ResourceGrantInput;
}

export interface ComputeEffectiveAuthorizationOptions {
  deriveChipIds?: (grants: ResourceGrantSet) => readonly string[] | undefined;
}

export type AuthorizationReasonCode =
  | 'allowed'
  | 'user_disabled'
  | 'user_expired'
  | 'mcp_key_expired'
  | 'invalid_expiry'
  | 'resource_not_granted'
  | 'visibility_denied'
  | 'model_not_granted'
  | 'unknown_resource_type';

export interface EffectiveAuthorizationSummary {
  subject: {
    userId: string;
    username?: string;
    role: string;
    keyId?: string;
    keyFingerprint?: string;
  };
  usable: boolean;
  reasonCode: AuthorizationReasonCode;
  safeMessage: string;
  visibilityCeiling: DocumentVisibility;
  grants: ResourceGrantSet;
  audit: {
    userId: string;
    role: string;
    keyId?: string;
    keyFingerprint?: string;
    reasonCode: AuthorizationReasonCode;
  };
}

export interface AuthorizationResource {
  type: AuthorizationResourceType;
  id: string;
  visibility?: DocumentVisibility;
  requiredGrants?: ResourceGrantInput;
}

export interface AuthorizationDecision {
  allowed: boolean;
  reasonCode: AuthorizationReasonCode;
  safeMessage: string;
  audit: EffectiveAuthorizationSummary['audit'] & {
    resourceType: AuthorizationResourceType;
    visibility?: DocumentVisibility;
  };
  matchedGrants: string[];
}
