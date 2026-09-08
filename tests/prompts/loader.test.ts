import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  loadPromptCatalog,
  loadRoleConfig,
  loadPromptFile,
  resolvePromptPath
} from '../../src/prompts/loader.js';
import { PromptFileNotFoundError, PromptFileEmptyError } from '../../src/prompts/types.js';

// Mock the fs module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn()
}));

describe('prompts/loader.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadPromptCatalog', () => {
    it('should parse valid JSON config and return PromptCatalog', async () => {
      const mockConfig = {
        baseDir: 'prompts',
        files: {
          global: 'global.md',
          roles: 'roles',
          chips: 'chips'
        },
        defaultRole: 'customer'
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockConfig));

      const result = await loadPromptCatalog('/path/to/config.json');
      expect(result.baseDir).toBe('prompts');
      expect(result.defaultRole).toBe('customer');
      expect(result.files.global).toBe('global.md');
    });

    it('should throw on invalid JSON', async () => {
      vi.mocked(readFile).mockResolvedValue('invalid json');

      await expect(loadPromptCatalog('/path/to/config.json')).rejects.toThrow();
    });

    it('should throw on missing required fields', async () => {
      const incompleteConfig = {
        baseDir: 'prompts'
        // missing files
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(incompleteConfig));

      await expect(loadPromptCatalog('/path/to/config.json')).rejects.toThrow();
    });

    it('should use customer as defaultRole when not specified', async () => {
      const configWithoutDefault = {
        baseDir: 'prompts',
        files: {
          global: 'global.md',
          roles: 'roles',
          chips: 'chips'
        }
        // defaultRole not specified
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(configWithoutDefault));

      const result = await loadPromptCatalog('/path/to/config.json');
      expect(result.defaultRole).toBe('customer');
    });
  });

  describe('loadRoleConfig', () => {
    it('should parse valid JSON and return RoleCatalog', async () => {
      const mockRoles = {
        admin: {
          description: 'Admin role',
          access: { allowedChips: ['*'], injectionPolicy: 'every_turn' }
        },
        customer: {
          description: 'Customer role',
          access: { allowedChips: ['E521.39'], injectionPolicy: 'first_turn' }
        }
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockRoles));

      const result = await loadRoleConfig('/path/to/roles.json');
      expect(result.admin.description).toBe('Admin role');
      expect(result.customer.access.allowedChips).toEqual(['E521.39']);
    });

    it('should throw on invalid role configuration', async () => {
      const invalidRoles = {
        admin: {
          description: 'Admin role'
          // missing access
        }
      };

      vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidRoles));

      await expect(loadRoleConfig('/path/to/roles.json')).rejects.toThrow();
    });
  });

  describe('loadPromptFile', () => {
    it('should read existing md file and return content string', async () => {
      const content = '# Global System Prompt\n\nYou are a helpful assistant.';
      vi.mocked(readFile).mockResolvedValue(content);

      const result = await loadPromptFile('/path/to/prompts/global.md');
      expect(result).toBe(content);
    });

    it('should throw PromptFileNotFoundError for missing file', async () => {
      const error = new Error('ENOENT: file not found');
      (error as any).code = 'ENOENT';
      vi.mocked(readFile).mockRejectedValue(error);

      await expect(loadPromptFile('/path/to/missing.md')).rejects.toThrow(PromptFileNotFoundError);
    });

    it('should throw PromptFileEmptyError for empty file', async () => {
      vi.mocked(readFile).mockResolvedValue('');

      await expect(loadPromptFile('/path/to/empty.md')).rejects.toThrow(PromptFileEmptyError);
    });

    it('should throw PromptFileEmptyError for whitespace-only file', async () => {
      vi.mocked(readFile).mockResolvedValue('   \n\t\n  ');

      await expect(loadPromptFile('/path/to/whitespace.md')).rejects.toThrow(PromptFileEmptyError);
    });

    it('should throw PromptFileEmptyError for file with only newlines', async () => {
      vi.mocked(readFile).mockResolvedValue('\n\n\n');

      await expect(loadPromptFile('/path/to/newlines.md')).rejects.toThrow(PromptFileEmptyError);
    });

    it('should propagate non-ENOENT errors', async () => {
      const error = new Error('Permission denied');
      vi.mocked(readFile).mockRejectedValue(error);

      await expect(loadPromptFile('/path/to/forbidden.md')).rejects.toThrow('Permission denied');
    });
  });

  describe('resolvePromptPath', () => {
    it('should correctly resolve paths inside prompts directory', () => {
      const baseDir = '/project/prompts';
      const relativePath = 'roles/admin.md';

      const result = resolvePromptPath(baseDir, relativePath);
      expect(result).toContain('roles');
      expect(result).toContain('admin.md');
    });

    it('should correctly resolve nested paths', () => {
      const baseDir = '/project/prompts';
      const relativePath = 'chips/E521.39/special.md';

      const result = resolvePromptPath(baseDir, relativePath);
      expect(result).toContain('chips');
      expect(result).toContain('E521.39');
      expect(result).toContain('special.md');
    });

    it('should reject paths outside prompts directory (traversal attempt)', () => {
      const baseDir = '/project/prompts';
      const maliciousPath = '../config/secrets.json';

      expect(() => resolvePromptPath(baseDir, maliciousPath)).toThrow(/Path traversal detected/);
    });

    it('should reject absolute paths outside baseDir', () => {
      const baseDir = '/project/prompts';
      const maliciousPath = '/etc/passwd';

      expect(() => resolvePromptPath(baseDir, maliciousPath)).toThrow(/Path traversal detected/);
    });

    it('should reject deep traversal attempts', () => {
      const baseDir = '/project/prompts';
      const maliciousPath = '../../../etc/passwd';

      expect(() => resolvePromptPath(baseDir, maliciousPath)).toThrow(/Path traversal detected/);
    });

    it('should handle paths with special characters', () => {
      const baseDir = '/project/prompts';
      const path = 'role with spaces.md';

      const result = resolvePromptPath(baseDir, path);
      expect(result).toContain('role with spaces.md');
    });

    it('handles Windows-style backslash paths on posix-like baseDir', () => {
      const baseDir = '/project/prompts';
      const relativePath = 'roles\\admin.md';

      const result = resolvePromptPath(baseDir, relativePath);
      expect(result).toContain('roles');
      expect(result).toContain('admin.md');
    });

    it('rejects traversal with Windows backslash separators', () => {
      const baseDir = 'D:\\workspace\\prompts';
      const maliciousPath = '..\\..\\windows\\system32\\config';

      expect(() => resolvePromptPath(baseDir, maliciousPath)).toThrow(/Path traversal detected/);
    });
  });
});
