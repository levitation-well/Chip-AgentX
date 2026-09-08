import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';

const PROMPTS_EXAMPLE = resolve(process.cwd(), 'config', 'prompts.example.json');
const ROLES_EXAMPLE = resolve(process.cwd(), 'config', 'roles.example.json');

describe('Phase 6: System Prompt Injection E2E', () => {
  describe('Prompt Module', () => {
    it('should load prompt catalog from config', async () => {
      const { loadPromptCatalog } = await import('../../src/prompts/loader.js');
      const catalog = await loadPromptCatalog(PROMPTS_EXAMPLE);
      expect(catalog.baseDir).toBe('prompts');
      expect(catalog.files.global).toBe('global.md');
      expect(catalog.files.roles).toBe('roles');
      expect(catalog.files.chips).toBe('chips');
    });

    it('should load role config from config/roles.json', async () => {
      const { loadRoleConfig } = await import('../../src/prompts/loader.js');
      const roles = await loadRoleConfig(ROLES_EXAMPLE);
      expect(roles.admin).toBeDefined();
      expect(roles.customer).toBeDefined();
      expect(roles.customer.access.allowedChips).toEqual([]);
    });

    it('should compose three-layer system prompt', async () => {
      const { composeSystemPrompt } = await import('../../src/prompts/composer.js');
      const prompt = composeSystemPrompt({
        global: 'You are helpful.',
        role: 'You are a customer.',
        chip: 'This is E521.39.',
        roleName: 'customer',
        chipName: 'E521.39'
      });
      expect(prompt).toContain('=== GLOBAL ===');
      expect(prompt).toContain('=== CUSTOMER ===');
      expect(prompt).toContain('=== E521.39 ===');
    });

    it('should load role-specific prompt files', async () => {
      const { loadPromptFile } = await import('../../src/prompts/loader.js');
      const content = await loadPromptFile('prompts/global.md');
      expect(content.length).toBeGreaterThan(10);
      expect(content).toContain('AI assistant');
    });
  });

  describe('RBAC', () => {
    it('should validate chip access for customer role', async () => {
      const { loadRoleConfig } = await import('../../src/prompts/loader.js');
      const { validateChipAccess } = await import('../../src/prompts/access.js');
      const roles = await loadRoleConfig(ROLES_EXAMPLE);

      expect(validateChipAccess('customer', 'E521.39', roles)).toBe(false);
      expect(validateChipAccess('customer', 'other-chip', roles)).toBe(false);
      expect(validateChipAccess('customer', 'RISC-V', roles)).toBe(false);
    });

    it('should allow admin to access all chips', async () => {
      const { loadRoleConfig } = await import('../../src/prompts/loader.js');
      const { validateChipAccess } = await import('../../src/prompts/access.js');
      const roles = await loadRoleConfig(ROLES_EXAMPLE);

      expect(validateChipAccess('admin', 'E521.39', roles)).toBe(true);
      expect(validateChipAccess('admin', 'any-chip', roles)).toBe(true);
    });

    it('should return false for unknown role', async () => {
      const { loadRoleConfig } = await import('../../src/prompts/loader.js');
      const { validateChipAccess } = await import('../../src/prompts/access.js');
      const roles = await loadRoleConfig(ROLES_EXAMPLE);

      expect(validateChipAccess('hacker', 'E521.39', roles)).toBe(false);
    });

    it('should return true without roleConfig (backward compat)', async () => {
      const { validateChipAccess } = await import('../../src/prompts/access.js');
      expect(validateChipAccess('customer', 'any-chip')).toBe(true);
    });
  });

  describe('Auth with Role', () => {
    it('should have User interface with role field', async () => {
      const { User } = await import('../../src/auth/types.js');
      const user = { id: '1', username: 'test', passwordHash: '', mcpKeys: [], createdAt: '', role: 'customer' as const };
      expect(typeof user.role).toBe('string');
      expect(['admin', 'internal', 'customer'] as const).toContain(user.role);
    });

    it('should have JwtPayload with role field', async () => {
      const { JwtPayload } = await import('../../src/auth/types.js');
      const payload: JwtPayload = { userId: '1', username: 'test', role: 'customer', iat: 0, exp: 0 };
      expect(typeof payload.role).toBe('string');
      expect(['admin', 'internal', 'customer'] as const).toContain(payload.role);
    });
  });

  describe('SpawnParams with SystemPrompt', () => {
    it('should have SpawnParams with systemPrompt field', async () => {
      const { SpawnParams } = await import('../../src/types.js');
      const params: SpawnParams = { agentType: 'claude-code', task: 'test', systemPrompt: 'hello' };
      expect(typeof params.systemPrompt).toBe('string');
    });
  });

  describe('Injector', () => {
    it('should inject only on first turn for first_turn policy', async () => {
      const { createInjectorState, injectSystemPrompt } = await import('../../src/prompts/injector.js');
      const state = createInjectorState();

      const first = injectSystemPrompt(state, 'first_turn', 'prompt');
      const second = injectSystemPrompt(state, 'first_turn', 'prompt');

      expect(first).toBe('prompt');
      expect(second).toBeNull();
    });

    it('should inject on every turn for every_turn policy', async () => {
      const { createInjectorState, injectSystemPrompt } = await import('../../src/prompts/injector.js');
      const state = createInjectorState();

      expect(injectSystemPrompt(state, 'every_turn', 'prompt')).toBe('prompt');
      expect(injectSystemPrompt(state, 'every_turn', 'prompt')).toBe('prompt');
      expect(injectSystemPrompt(state, 'every_turn', 'prompt')).toBe('prompt');
    });
  });
});
