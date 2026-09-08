import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  InjectionPolicySchema,
  PromptFragmentSchema,
  RoleChipAccessSchema,
  RoleConfigSchema,
  RoleCatalogSchema,
  PromptFileSchema,
  PromptCatalogSchema,
  PromptFileNotFoundError,
  PromptFileEmptyError
} from '../../src/prompts/types.js';

describe('prompts/types.ts', () => {
  describe('InjectionPolicySchema', () => {
    it('should parse "first_turn" as valid injection policy', () => {
      const result = InjectionPolicySchema.parse('first_turn');
      expect(result).toBe('first_turn');
    });

    it('should parse "every_turn" as valid injection policy', () => {
      const result = InjectionPolicySchema.parse('every_turn');
      expect(result).toBe('every_turn');
    });

    it('should parse "never" as valid injection policy', () => {
      const result = InjectionPolicySchema.parse('never');
      expect(result).toBe('never');
    });

    it('should reject invalid injection policy', () => {
      expect(() => InjectionPolicySchema.parse('invalid')).toThrow(z.ZodError);
    });
  });

  describe('PromptFragmentSchema', () => {
    it('should parse a valid governed prompt fragment', () => {
      const valid = {
        id: 'global-safety',
        content: 'Follow safety rules.',
        enabled: true,
        entrypoints: ['chat'],
        models: ['haiku'],
        languages: ['zh-CN'],
        roles: ['customer'],
        userLevels: ['standard'],
        chipIds: ['E521.39'],
        resourceScopes: ['public'],
        priority: 10,
        version: 1,
        injectionPolicy: 'first_turn'
      };

      const result = PromptFragmentSchema.parse(valid);

      expect(result).toEqual(valid);
    });

    it('should fill governance defaults without scenario or taskType', () => {
      const result = PromptFragmentSchema.parse({
        id: 'defaulted',
        content: 'Default scopes.'
      });

      expect(result.enabled).toBe(true);
      expect(result.entrypoints).toEqual(['chat', 'mcp', 'cli']);
      expect(result.models).toEqual(['*']);
      expect(result.languages).toEqual(['*']);
      expect(result.roles).toEqual(['*']);
      expect(result.userLevels).toEqual(['*']);
      expect(result.chipIds).toEqual(['*']);
      expect(result.resourceScopes).toEqual(['*']);
      expect(result.priority).toBe(0);
      expect(result.version).toBe(1);
      expect(result.injectionPolicy).toBe('first_turn');
      expect(result).not.toHaveProperty('scenario');
      expect(result).not.toHaveProperty('taskType');
    });

    it('should reject unknown model ids', () => {
      expect(() => PromptFragmentSchema.parse({
        id: 'bad-model',
        content: 'Bad model.',
        models: ['not-a-real-model']
      })).toThrow(z.ZodError);
    });

    it('should reject scenario and taskType fields', () => {
      expect(() => PromptFragmentSchema.parse({
        id: 'scenario-fragment',
        content: 'Should fail.',
        scenario: 'support',
        taskType: 'qa'
      })).toThrow(z.ZodError);
    });
  });

  describe('RoleChipAccessSchema', () => {
    it('should parse valid RoleChipAccess with allowedChips and injectionPolicy', () => {
      const valid = {
        allowedChips: ['E521.39', 'E521.40'],
        injectionPolicy: 'first_turn'
      };
      const result = RoleChipAccessSchema.parse(valid);
      expect(result).toEqual(valid);
    });

    it('should accept empty allowedChips array', () => {
      const valid = {
        allowedChips: [],
        injectionPolicy: 'every_turn'
      };
      const result = RoleChipAccessSchema.parse(valid);
      expect(result.allowedChips).toEqual([]);
    });

    it('should reject missing allowedChips field', () => {
      const invalid = {
        injectionPolicy: 'first_turn'
      };
      expect(() => RoleChipAccessSchema.parse(invalid)).toThrow(z.ZodError);
    });

    it('should reject invalid injectionPolicy', () => {
      const invalid = {
        allowedChips: ['E521.39'],
        injectionPolicy: 'invalid_policy'
      };
      expect(() => RoleChipAccessSchema.parse(invalid)).toThrow(z.ZodError);
    });
  });

  describe('RoleConfigSchema', () => {
    it('should parse valid RoleConfig with description and access', () => {
      const valid = {
        description: 'Admin role with full access',
        access: {
          allowedChips: ['*'],
          injectionPolicy: 'every_turn'
        }
      };
      const result = RoleConfigSchema.parse(valid);
      expect(result.description).toBe('Admin role with full access');
      expect(result.access.allowedChips).toEqual(['*']);
    });

    it('should reject missing description', () => {
      const invalid = {
        access: {
          allowedChips: ['E521.39'],
          injectionPolicy: 'first_turn'
        }
      };
      expect(() => RoleConfigSchema.parse(invalid)).toThrow(z.ZodError);
    });

    it('should reject missing access field', () => {
      const invalid = {
        description: 'Some role'
      };
      expect(() => RoleConfigSchema.parse(invalid)).toThrow(z.ZodError);
    });
  });

  describe('RoleCatalogSchema', () => {
    it('should parse valid RoleCatalog as record of RoleConfig', () => {
      const valid = {
        admin: {
          description: 'Admin role',
          access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
        },
        customer: {
          description: 'Customer role',
          access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' }
        }
      };
      const result = RoleCatalogSchema.parse(valid);
      expect(result.admin.description).toBe('Admin role');
      expect(result.customer.access.allowedChips).toEqual(['E521.39']);
    });

    it('should accept empty record', () => {
      const result = RoleCatalogSchema.parse({});
      expect(result).toEqual({});
    });
  });

  describe('PromptFileSchema', () => {
    it('should parse valid PromptFile with global, roles, chips paths', () => {
      const valid = {
        global: 'global.md',
        roles: 'roles',
        chips: 'chips'
      };
      const result = PromptFileSchema.parse(valid);
      expect(result.global).toBe('global.md');
      expect(result.roles).toBe('roles');
      expect(result.chips).toBe('chips');
    });

    it('should reject missing global path', () => {
      const invalid = {
        roles: 'roles',
        chips: 'chips'
      };
      expect(() => PromptFileSchema.parse(invalid)).toThrow(z.ZodError);
    });

    it('should reject non-string path values', () => {
      const invalid = {
        global: 123,
        roles: 'roles',
        chips: 'chips'
      };
      expect(() => PromptFileSchema.parse(invalid)).toThrow(z.ZodError);
    });
  });

  describe('PromptCatalogSchema', () => {
    it('should parse valid PromptCatalog with baseDir, files, and defaultRole', () => {
      const valid = {
        baseDir: 'prompts',
        files: {
          global: 'global.md',
          roles: 'roles',
          chips: 'chips'
        },
        defaultRole: 'customer'
      };
      const result = PromptCatalogSchema.parse(valid);
      expect(result.baseDir).toBe('prompts');
      expect(result.defaultRole).toBe('customer');
    });

    it('should default defaultRole to "customer" if not provided', () => {
      const valid = {
        baseDir: 'prompts',
        files: {
          global: 'global.md',
          roles: 'roles',
          chips: 'chips'
        }
      };
      const result = PromptCatalogSchema.parse(valid);
      expect(result.defaultRole).toBe('customer');
    });

    it('should accept valid defaultRole values', () => {
      for (const role of ['admin', 'internal', 'customer'] as const) {
        const valid = {
          baseDir: 'prompts',
          files: {
            global: 'global.md',
            roles: 'roles',
            chips: 'chips'
          },
          defaultRole: role
        };
        expect(PromptCatalogSchema.parse(valid).defaultRole).toBe(role);
      }
    });

    it('should reject invalid defaultRole', () => {
      const invalid = {
        baseDir: 'prompts',
        files: {
          global: 'global.md',
          roles: 'roles',
          chips: 'chips'
        },
        defaultRole: 'superuser'
      };
      expect(() => PromptCatalogSchema.parse(invalid)).toThrow(z.ZodError);
    });
  });

  describe('Error classes', () => {
    describe('PromptFileNotFoundError', () => {
      it('should have correct name and message', () => {
        const error = new PromptFileNotFoundError('/path/to/file.md');
        expect(error.name).toBe('PromptFileNotFoundError');
        expect(error.message).toContain('/path/to/file.md');
        expect(error.message).toContain('not found');
      });

      it('should be an instance of Error', () => {
        const error = new PromptFileNotFoundError('/path/to/file.md');
        expect(error instanceof Error).toBe(true);
      });
    });

    describe('PromptFileEmptyError', () => {
      it('should have correct name and message', () => {
        const error = new PromptFileEmptyError('/path/to/file.md');
        expect(error.name).toBe('PromptFileEmptyError');
        expect(error.message).toContain('/path/to/file.md');
        expect(error.message).toContain('empty');
      });

      it('should be an instance of Error', () => {
        const error = new PromptFileEmptyError('/path/to/file.md');
        expect(error instanceof Error).toBe(true);
      });
    });
  });
});
