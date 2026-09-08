import type { RoleCatalog, RoleChipAccess, InjectionPolicy } from './types.js';

/**
 * Validate if a role has access to a specific chip.
 * Returns true if access is allowed, false otherwise.
 */
export function validateChipAccess(
  role: string,
  chipId: string,
  roleConfig?: RoleCatalog
): boolean {
  if (!roleConfig) {
    return true;
  }

  const access = roleConfig[role];
  if (!access || typeof access !== 'object') {
    return false;
  }
  const roleEntry = access as Record<string, unknown>;
  const roleAccess = roleEntry['access'];
  if (!roleAccess || typeof roleAccess !== 'object') {
    return false;
  }
  const chipAccess = roleAccess as { allowedChips?: unknown };
  const allowedChips = chipAccess['allowedChips'];
  if (!Array.isArray(allowedChips)) {
    return false;
  }

  if (allowedChips.includes('*')) {
    return true;
  }

  return allowedChips.includes(chipId);
}

/**
 * Get the chip access configuration for a role.
 */
export function getRoleConfig(role: string, roleConfig?: RoleCatalog): RoleChipAccess | undefined {
  if (!roleConfig) {
    return undefined;
  }
  const entry = roleConfig[role] as Record<string, unknown> | undefined;
  const access = entry?.['access'];
  if (!access || typeof access !== 'object') {
    return undefined;
  }
  return access as RoleChipAccess;
}

/**
 * Get the injection policy for a role.
 */
export function getInjectionPolicy(role: string, roleConfig?: RoleCatalog): InjectionPolicy {
  const access = getRoleConfig(role, roleConfig);
  if (!access) {
    return 'first_turn';
  }
  return access.injectionPolicy;
}

/**
 * Check if a user can access the Admin UI.
 */
export function canAccessAdmin(role: string): boolean {
  return role === 'admin';
}

/**
 * Get allowed chips for a role.
 */
export function getAllowedChips(role: string, roleConfig?: RoleCatalog): string[] {
  const access = getRoleConfig(role, roleConfig);
  if (!access) {
    return [];
  }
  if (access.allowedChips.includes('*')) {
    return ['*'];
  }
  return [...access.allowedChips];
}
