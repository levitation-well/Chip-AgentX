import { describe, it, expect } from 'vitest';
import {
  validateChipAccess,
  getRoleConfig,
  getInjectionPolicy,
  canAccessAdmin,
  getAllowedChips
} from '../../src/prompts/access.js';

const mockRoleConfig = {
  admin: {
    description: 'Administrator',
    access: { allowedChips: ['*'], injectionPolicy: 'every_turn' as const }
  },
  internal: {
    description: 'Internal employee',
    access: { allowedChips: [], injectionPolicy: 'every_turn' as const }
  },
  customer: {
    description: 'Customer',
    access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' as const }
  }
};

describe('validateChipAccess', () => {
  it('returns true for admin accessing any chip', () => {
    expect(validateChipAccess('admin', 'E521.39', mockRoleConfig)).toBe(true);
    expect(validateChipAccess('admin', 'XYZ.123', mockRoleConfig)).toBe(true);
  });

  it('returns true for internal accessing any chip', () => {
    expect(validateChipAccess('internal', 'E521.39', mockRoleConfig)).toBe(false);
    expect(validateChipAccess('internal', 'XYZ.123', mockRoleConfig)).toBe(false);
  });

  it('returns true for customer accessing E521.39', () => {
    expect(validateChipAccess('customer', 'E521.39', mockRoleConfig)).toBe(true);
  });

  it('returns false for customer accessing other chips', () => {
    expect(validateChipAccess('customer', 'XYZ.123', mockRoleConfig)).toBe(false);
    expect(validateChipAccess('customer', 'E521.38', mockRoleConfig)).toBe(false);
  });

  it('returns false for unknown role', () => {
    expect(validateChipAccess('hacker', 'E521.39', mockRoleConfig)).toBe(false);
    expect(validateChipAccess('', 'E521.39', mockRoleConfig)).toBe(false);
  });

  it('returns true when no roleConfig provided (backward compat)', () => {
    expect(validateChipAccess('customer', 'XYZ.123')).toBe(true);
  });
});

describe('getInjectionPolicy', () => {
  it('returns every_turn for admin', () => {
    expect(getInjectionPolicy('admin', mockRoleConfig)).toBe('every_turn');
  });

  it('returns every_turn for internal', () => {
    expect(getInjectionPolicy('internal', mockRoleConfig)).toBe('every_turn');
  });

  it('returns first_turn for customer', () => {
    expect(getInjectionPolicy('customer', mockRoleConfig)).toBe('first_turn');
  });

  it('returns first_turn for unknown role', () => {
    expect(getInjectionPolicy('unknown', mockRoleConfig)).toBe('first_turn');
  });
});

describe('canAccessAdmin', () => {
  it('returns true only for admin', () => {
    expect(canAccessAdmin('admin')).toBe(true);
    expect(canAccessAdmin('internal')).toBe(false);
    expect(canAccessAdmin('customer')).toBe(false);
  });
});

describe('getRoleConfig', () => {
  it('returns RoleChipAccess for known role', () => {
    const result = getRoleConfig('admin', mockRoleConfig);
    expect(result).toBeDefined();
    expect(result!.allowedChips).toEqual(['*']);
    expect(result!.injectionPolicy).toBe('every_turn');
  });

  it('returns RoleChipAccess for customer', () => {
    const result = getRoleConfig('customer', mockRoleConfig);
    expect(result).toBeDefined();
    expect(result!.allowedChips).toEqual(['E521.39']);
    expect(result!.injectionPolicy).toBe('first_turn');
  });

  it('returns undefined for unknown role', () => {
    expect(getRoleConfig('hacker', mockRoleConfig)).toBeUndefined();
    expect(getRoleConfig('', mockRoleConfig)).toBeUndefined();
  });

  it('returns undefined when no roleConfig provided', () => {
    expect(getRoleConfig('admin')).toBeUndefined();
  });
});

describe('getAllowedChips', () => {
  it('returns wildcard array for admin', () => {
    expect(getAllowedChips('admin', mockRoleConfig)).toEqual(['*']);
  });

  it('returns empty array for internal', () => {
    expect(getAllowedChips('internal', mockRoleConfig)).toEqual([]);
  });

  it('returns chip list for customer', () => {
    expect(getAllowedChips('customer', mockRoleConfig)).toEqual(['E521.39']);
  });

  it('returns empty array for unknown role', () => {
    expect(getAllowedChips('unknown', mockRoleConfig)).toEqual([]);
  });
});
