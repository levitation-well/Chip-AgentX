import type { AuthorizationReasonCode } from './types.js';

const SAFE_MESSAGES: Record<AuthorizationReasonCode, string> = {
  allowed: 'Access allowed.',
  user_disabled: 'Access is not available for this account.',
  user_expired: 'Access is not available for this account.',
  mcp_key_expired: 'Access is not available for this key.',
  invalid_expiry: 'Access is not available.',
  resource_not_granted: 'The requested resource is not available to this identity.',
  visibility_denied: 'The requested resource is not available to this identity.',
  model_not_granted: 'The requested model is not available to this identity.',
  unknown_resource_type: 'The requested resource type is not supported.'
};

export function getSafeAuthorizationMessage(reasonCode: AuthorizationReasonCode): string {
  return SAFE_MESSAGES[reasonCode];
}

export function isSensitiveAuthorizationKey(key: string): boolean {
  return /(authorization|cookie|password|secret|token|api[_-]?key|mcp[_-]?key|private[_-]?key|systemprompt|cwd|path|workspacedir)/i.test(
    key
  );
}

export function redactAuthorizationMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactAuthorizationMetadata(item));
  }
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = isSensitiveAuthorizationKey(key) ? '[REDACTED]' : redactAuthorizationMetadata(nested);
    }
    return redacted;
  }
  return value;
}
