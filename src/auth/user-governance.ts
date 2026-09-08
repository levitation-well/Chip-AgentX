import type { McpKey, User, UserStatus } from './types.js';

export type AccessUnavailableReason =
  | 'user_disabled'
  | 'user_expired'
  | 'mcp_key_expired'
  | 'mcp_key_missing'
  | 'invalid_expiry';

export interface AccessAvailability {
  usable: boolean;
  reason?: AccessUnavailableReason;
  expiresAt?: string;
}

export class AccessUnavailableError extends Error {
  constructor(readonly reason: AccessUnavailableReason) {
    super(reason);
  }
}

export function normalizeUserStatus(status: User['status']): UserStatus {
  return status ?? 'active';
}

export function getUserAvailability(user: User, now: Date = new Date()): AccessAvailability {
  if (normalizeUserStatus(user.status) === 'disabled') {
    return { usable: false, reason: 'user_disabled' };
  }

  const userExpiry = parseExpiry(user.expiresAt);
  if (userExpiry.invalid) {
    return { usable: false, reason: 'invalid_expiry' };
  }
  if (userExpiry.value !== undefined && userExpiry.value < now.getTime()) {
    return { usable: false, reason: 'user_expired', expiresAt: user.expiresAt };
  }

  return { usable: true, expiresAt: user.expiresAt };
}

export function assertUserUsable(user: User, now: Date = new Date()): void {
  const availability = getUserAvailability(user, now);
  if (!availability.usable) {
    throw new AccessUnavailableError(availability.reason ?? 'invalid_expiry');
  }
}

export function getEffectiveMcpKeyExpiresAt(user: User, key: McpKey): string | undefined {
  const userExpiry = parseExpiry(user.expiresAt);
  const keyExpiry = parseExpiry(key.expiresAt);

  if (userExpiry.invalid || keyExpiry.invalid) {
    return key.expiresAt ?? user.expiresAt;
  }
  if (userExpiry.value === undefined) {
    return key.expiresAt;
  }
  if (keyExpiry.value === undefined) {
    return user.expiresAt;
  }
  return keyExpiry.value <= userExpiry.value ? key.expiresAt : user.expiresAt;
}

export function getMcpKeyAvailability(user: User, key: McpKey | undefined, now: Date = new Date()): AccessAvailability {
  if (!key) {
    return { usable: false, reason: 'mcp_key_missing' };
  }

  const userAvailability = getUserAvailability(user, now);
  if (!userAvailability.usable) {
    return userAvailability;
  }

  const keyExpiry = parseExpiry(key.expiresAt);
  if (keyExpiry.invalid) {
    return { usable: false, reason: 'invalid_expiry' };
  }
  if (keyExpiry.value !== undefined && keyExpiry.value < now.getTime()) {
    return { usable: false, reason: 'mcp_key_expired', expiresAt: key.expiresAt };
  }

  return { usable: true, expiresAt: getEffectiveMcpKeyExpiresAt(user, key) };
}

export function assertMcpKeyUsable(user: User, key: McpKey | undefined, now: Date = new Date()): void {
  const availability = getMcpKeyAvailability(user, key, now);
  if (!availability.usable) {
    throw new AccessUnavailableError(availability.reason ?? 'invalid_expiry');
  }
}

function parseExpiry(value: string | undefined): { value?: number; invalid?: true } {
  if (value === undefined) {
    return {};
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? { value: parsed } : { invalid: true };
}
