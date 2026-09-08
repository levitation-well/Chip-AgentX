import { describe, it, expect } from 'vitest';
import {
  composeGovernedPrompt,
  composeSystemPrompt,
  appendSourceCitationPromptGuardrails,
  getPromptFilePath,
  selectPromptFragments
} from '../../src/prompts/composer.js';
import type { PromptCatalog, PromptFragment } from '../../src/prompts/types.js';

describe('prompts/composer.ts', () => {
  describe('composeSystemPrompt', () => {
    it('should produce correct three-layer format with === separators', () => {
      const result = composeSystemPrompt({
        global: 'You are a helpful AI assistant.',
        role: 'You are an admin with full access.',
        chip: 'You specialize in E521.39 chip.',
        roleName: 'admin',
        chipName: 'E521.39'
      });

      expect(result).toContain('=== GLOBAL ===');
      expect(result).toContain('You are a helpful AI assistant.');
      expect(result).toContain('=== ADMIN ===');
      expect(result).toContain('You are an admin with full access.');
      expect(result).toContain('=== E521.39 ===');
      expect(result).toContain('You specialize in E521.39 chip.');
    });

    it('should use correct separator format: === LAYER_NAME ===', () => {
      const result = composeSystemPrompt({
        global: 'Global content',
        role: 'Customer role content',
        roleName: 'customer'
      });

      expect(result).toContain('=== GLOBAL ===');
      expect(result).toContain('=== CUSTOMER ===');
      expect(result).toContain('Customer role content');
    });

    it('should produce valid single-layer prompt with only global layer', () => {
      const result = composeSystemPrompt({
        global: 'Only global content here'
      });

      expect(result).toContain('=== GLOBAL ===');
      expect(result).toContain('Only global content here');
      expect(result).not.toContain('=== CUSTOMER ===');
      expect(result).not.toContain('=== INTERNAL ===');
    });

    it('should produce correct two-layer format with global + role (no chip)', () => {
      const result = composeSystemPrompt({
        global: 'Global content',
        role: 'Internal role content',
        roleName: 'internal'
      });

      expect(result).toContain('=== GLOBAL ===');
      expect(result).toContain('Global content');
      expect(result).toContain('=== INTERNAL ===');
      expect(result).toContain('Internal role content');
      expect(result).not.toContain('=== E521.39 ===');
    });

    it('should trim whitespace from each layer', () => {
      const result = composeSystemPrompt({
        global: '  \n  Global with whitespace  \n  ',
        role: '\t\nRole content\t\n  ',
        chip: '   Chip content   ',
        roleName: 'admin',
        chipName: 'E521.39'
      });

      expect(result).not.toContain('  Global');
      expect(result).not.toContain('Role content  \n  ');
      expect(result).toContain('Global with whitespace');
      expect(result).toContain('Role content');
      expect(result).toContain('Chip content');
    });

    it('should not include layer if content is empty', () => {
      const result = composeSystemPrompt({
        global: '',
        role: 'Role content',
        chip: '',
        roleName: 'admin',
        chipName: 'E521.39'
      });

      expect(result).not.toContain('=== GLOBAL ===');
      expect(result).toContain('=== ADMIN ===');
      expect(result).not.toContain('=== E521.39 ===');
    });

    it('should not include layer if content is whitespace only', () => {
      const result = composeSystemPrompt({
        global: '   \n\t  ',
        role: 'Role content',
        roleName: 'customer'
      });

      expect(result).not.toContain('=== GLOBAL ===');
      expect(result).toContain('=== CUSTOMER ===');
    });

    it('should not include layer if name is missing', () => {
      const result = composeSystemPrompt({
        global: 'Global content',
        role: 'Role content',
        chip: 'Chip content',
        // roleName missing
        chipName: 'E521.39'
      });

      expect(result).toContain('=== GLOBAL ===');
      expect(result).not.toContain('=== CUSTOMER ===');
      expect(result).not.toContain('=== INTERNAL ===');
      expect(result).toContain('=== E521.39 ===');
    });

    it('should join layers with double newline', () => {
      const result = composeSystemPrompt({
        global: 'Layer 1',
        role: 'Layer 2',
        chip: 'Layer 3',
        roleName: 'admin',
        chipName: 'E521.39'
      });

      const parts = result.split('\n\n');
      expect(parts.length).toBe(3);
    });

    it('should handle uppercase role names correctly', () => {
      const result = composeSystemPrompt({
        role: 'Content',
        roleName: 'internal'
      });

      expect(result).toContain('=== INTERNAL ===');
    });
  });

  describe('selectPromptFragments', () => {
    const baseFragment: PromptFragment = {
      id: 'base',
      content: 'Base fragment',
      enabled: true,
      entrypoints: ['chat'],
      models: ['haiku'],
      languages: ['zh-CN'],
      roles: ['customer'],
      userLevels: ['standard'],
      chipIds: ['E521.39'],
      resourceScopes: ['public'],
      priority: 0,
      version: 1,
      injectionPolicy: 'first_turn'
    };

    const select = (fragments: PromptFragment[]) => selectPromptFragments({
      fragments,
      entrypoint: 'chat',
      model: 'haiku',
      language: 'zh-CN',
      role: 'customer',
      userLevel: 'standard',
      resourceScope: 'public',
      chipId: 'E521.39'
    });

    it('should filter disabled and never fragments', () => {
      const result = select([
        baseFragment,
        { ...baseFragment, id: 'disabled', content: 'Disabled', enabled: false },
        { ...baseFragment, id: 'never', content: 'Never', injectionPolicy: 'never' }
      ]);

      expect(result.map((fragment) => fragment.id)).toEqual(['base']);
    });

    it('should filter by entrypoint, model, language, role, resource scope, and chip', () => {
      const result = select([
        baseFragment,
        { ...baseFragment, id: 'entrypoint', entrypoints: ['mcp'] },
        { ...baseFragment, id: 'model', models: ['sonnet'] },
        { ...baseFragment, id: 'language', languages: ['en-US'] },
        { ...baseFragment, id: 'role', roles: ['internal'] },
        { ...baseFragment, id: 'resource', resourceScopes: ['private'] },
        { ...baseFragment, id: 'chip', chipIds: ['E521.40'] }
      ]);

      expect(result.map((fragment) => fragment.id)).toEqual(['base']);
    });

    it('should allow wildcard scopes', () => {
      const wildcard: PromptFragment = {
        ...baseFragment,
        id: 'wildcard',
        models: ['*'],
        languages: ['*'],
        roles: ['*'],
        userLevels: ['*'],
        chipIds: ['*'],
        resourceScopes: ['*']
      };

      expect(select([wildcard]).map((fragment) => fragment.id)).toEqual(['wildcard']);
    });

    it('should sort selected fragments by priority descending then id', () => {
      const result = select([
        { ...baseFragment, id: 'middle', priority: 5 },
        { ...baseFragment, id: 'z-high', priority: 10 },
        { ...baseFragment, id: 'a-high', priority: 10 },
        { ...baseFragment, id: 'low', priority: 1 }
      ]);

      expect(result.map((fragment) => fragment.id)).toEqual(['a-high', 'z-high', 'middle', 'low']);
    });
  });

  describe('composeGovernedPrompt', () => {
    it('should compose base prompt and governed fragments in priority order', () => {
      const fragments: PromptFragment[] = [
        {
          id: 'low',
          content: 'Low priority.',
          enabled: true,
          entrypoints: ['chat'],
          models: ['*'],
          languages: ['*'],
          roles: ['*'],
          userLevels: ['*'],
          chipIds: ['*'],
          resourceScopes: ['*'],
          priority: 1,
          version: 1,
          injectionPolicy: 'first_turn'
        },
        {
          id: 'high',
          content: 'High priority.',
          enabled: true,
          entrypoints: ['chat'],
          models: ['*'],
          languages: ['*'],
          roles: ['*'],
          userLevels: ['*'],
          chipIds: ['*'],
          resourceScopes: ['*'],
          priority: 20,
          version: 1,
          injectionPolicy: 'every_turn'
        }
      ];

      const result = composeGovernedPrompt({
        basePrompt: 'Legacy prompt.',
        fragments,
        entrypoint: 'chat',
        model: 'haiku',
        language: 'zh-CN',
        role: 'customer',
        resourceScope: 'public',
        chipId: 'E521.39'
      });

      expect(result.split('\n\n')).toEqual(['Legacy prompt.', 'High priority.', 'Low priority.']);
    });
  });

  describe('appendSourceCitationPromptGuardrails', () => {
    it('adds citation and leakage guardrails without replacing the existing prompt', () => {
      const result = appendSourceCitationPromptGuardrails('Base role prompt.');

      expect(result).toContain('Base role prompt.');
      expect(result).toContain('=== SOURCE CITATION SAFETY ===');
      expect(result).toContain('system-captured source seeds');
      expect(result).toContain('not sentence-level semantic citations');
      expect(result).toContain('Never reveal API keys, JWTs, cookies, passwords, access tokens');
    });

    it('does not duplicate guardrails when already present', () => {
      const once = appendSourceCitationPromptGuardrails('Base role prompt.');
      const twice = appendSourceCitationPromptGuardrails(once);

      expect(twice.match(/SOURCE CITATION SAFETY/g)).toHaveLength(1);
    });
  });

  describe('getPromptFilePath', () => {
    const mockCatalog: PromptCatalog = {
      baseDir: '/project/prompts',
      files: {
        global: 'global.md',
        roles: 'roles',
        chips: 'chips'
      },
      defaultRole: 'customer'
    };

    it('should return global prompt path', () => {
      const result = getPromptFilePath(mockCatalog, 'global');
      expect(result).toContain('global.md');
    });

    it('should return role prompt path with name', () => {
      const result = getPromptFilePath(mockCatalog, 'role', 'admin');
      expect(result).toContain('roles');
      expect(result).toContain('admin.md');
    });

    it('should return chip prompt path with name', () => {
      const result = getPromptFilePath(mockCatalog, 'chip', 'E521.39');
      expect(result).toContain('chips');
      expect(result).toContain('E521.39.md');
    });

    it('should throw when role name missing for role type', () => {
      expect(() => getPromptFilePath(mockCatalog, 'role')).toThrow('Role name required');
    });

    it('should throw when chip name missing for chip type', () => {
      expect(() => getPromptFilePath(mockCatalog, 'chip')).toThrow('Chip name required');
    });

    it('should handle special characters in chip name', () => {
      const result = getPromptFilePath(mockCatalog, 'chip', 'E521.39');
      expect(result).toContain('E521.39.md');
    });
  });
});
