import { describe, expect, it } from 'vitest';
import {
  ContextBudgetExceededError,
  assertContextBudget,
  evaluateContextBudget,
  estimateTokensFromChars,
  resolveContextBudgetPolicy
} from '../src/context-budget.js';

describe('context budget policy', () => {
  it('uses estimated char/4 token accounting', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(16)).toBe(4);
  });

  it('gives admin and internal larger truncate budgets', () => {
    expect(resolveContextBudgetPolicy({ role: 'admin' }).onExceed).toBe('truncate');
    expect(resolveContextBudgetPolicy({ role: 'internal' }).maxInputTokens).toBeGreaterThan(
      resolveContextBudgetPolicy({ role: 'customer' }).maxInputTokens
    );
  });

  it('rejects customer requests before provider spawn when policy is exceeded', () => {
    const task = 'x'.repeat(resolveContextBudgetPolicy({ role: 'customer' }).maxTaskChars + 1);
    const decision = evaluateContextBudget({ role: 'customer', entry: 'web', task });

    expect(decision).toMatchObject({
      ok: false,
      estimated: true,
      action: 'reject',
      exceeded: expect.arrayContaining(['maxTaskChars'])
    });
    expect(() => assertContextBudget({ role: 'customer', entry: 'web', task })).toThrow(ContextBudgetExceededError);
  });

  it('allows internal overages as truncation-capable decisions', () => {
    const task = 'x'.repeat(resolveContextBudgetPolicy({ role: 'internal' }).maxTaskChars + 1);
    const decision = evaluateContextBudget({ role: 'internal', entry: 'mcp', task });

    expect(decision.ok).toBe(true);
    expect(decision.action).toBe('truncate');
    expect(decision.exceeded).toContain('maxTaskChars');
  });
});
