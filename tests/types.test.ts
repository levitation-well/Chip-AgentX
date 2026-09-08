import { describe, it, expect } from 'vitest';
import type { SpawnParams } from '../src/types.js';

describe('SpawnParams systemPrompt field', () => {
  describe('type validation', () => {
    it('should accept optional systemPrompt string field', () => {
      const params: SpawnParams = {
        agentType: 'claude-code',
        task: 'test task',
        systemPrompt: 'You are a helpful assistant'
      };

      expect(params.systemPrompt).toBe('You are a helpful assistant');
    });

    it('should compile correctly with systemPrompt field', () => {
      const params: SpawnParams = {
        agentType: 'claude-code',
        task: 'Hello',
        cwd: '/test',
        userId: 'user-1',
        chipId: 'E521.39',
        systemPrompt: 'Custom system prompt'
      };

      expect(params.agentType).toBe('claude-code');
      expect(params.task).toBe('Hello');
      expect(params.systemPrompt).toBe('Custom system prompt');
      expect(params.chipId).toBe('E521.39');
    });

    it('should work without systemPrompt field (optional)', () => {
      const params: SpawnParams = {
        agentType: 'claude-code',
        task: 'test'
      };

      expect(params.systemPrompt).toBeUndefined();
    });
  });
});
