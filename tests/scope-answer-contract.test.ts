/**
 * 测试：scope 输出契约指令
 * TDD：先运行看 FAIL（函数未导出），实现后应全 PASS。
 */
import { describe, it, expect } from 'vitest';
import { scopeOutputContractInstructions } from '../src/scope/answer-contract.js';

describe('scopeOutputContractInstructions()', () => {
  it('返回非空字符串', () => {
    const result = scopeOutputContractInstructions();
    expect(typeof result).toBe('string');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('包含逐芯片分组作答的要求（per-chip grouping）', () => {
    const result = scopeOutputContractInstructions();
    // 关键子串：per-chip 或 each chip 或 per chip
    expect(result.toLowerCase()).toMatch(/per[- ]chip|each chip/);
  });

  it('包含命中依据/出处的要求（evidence / source）', () => {
    const result = scopeOutputContractInstructions();
    expect(result.toLowerCase()).toMatch(/evidence|source|section|chapter/);
  });

  it('包含对无命中芯片的说明要求（no match / not supported）', () => {
    const result = scopeOutputContractInstructions();
    expect(result.toLowerCase()).toMatch(/no[t]? (support|match|mention|found|relevant)|not found|no match/);
  });

  it('包含禁止臆造/杜撰的要求（do not fabricate）', () => {
    const result = scopeOutputContractInstructions();
    expect(result.toLowerCase()).toMatch(/do not (fabricate|invent|make up)|no[t]? fabricat|hallucin/);
  });

  it('包含不泄露文件系统路径的约束（no path disclosure）', () => {
    const result = scopeOutputContractInstructions();
    expect(result.toLowerCase()).toMatch(/path|filesystem|cwd|disclose/);
  });

  it('文案精炼——少于 25 行', () => {
    const result = scopeOutputContractInstructions();
    const lines = result.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(25);
  });
});
