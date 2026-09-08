import { describe, expect, it } from 'vitest';
import {
  decideScopeScale,
  DEFAULT_SCOPE_SMALL_THRESHOLD,
  ScopeTooLargeError
} from '../src/scope/scale.js';

describe('decideScopeScale', () => {
  it('返回 small tier 当文件数等于默认阈值 200', () => {
    const result = decideScopeScale(200);
    expect(result.tier).toBe('small');
    expect(result.fileCount).toBe(200);
    expect(result.threshold).toBe(DEFAULT_SCOPE_SMALL_THRESHOLD);
  });

  it('返回 small tier 当文件数为 0', () => {
    expect(decideScopeScale(0).tier).toBe('small');
  });

  it('返回 small tier 当文件数为 1', () => {
    expect(decideScopeScale(1).tier).toBe('small');
  });

  it('返回 large tier 当文件数为 201', () => {
    const result = decideScopeScale(201);
    expect(result.tier).toBe('large');
    expect(result.fileCount).toBe(201);
    expect(result.threshold).toBe(DEFAULT_SCOPE_SMALL_THRESHOLD);
  });

  it('返回 large tier 当文件数远超阈值', () => {
    expect(decideScopeScale(1000).tier).toBe('large');
  });

  it('使用自定义阈值：边界值恰好等于阈值时为 small', () => {
    const result = decideScopeScale(50, { threshold: 50 });
    expect(result.tier).toBe('small');
    expect(result.threshold).toBe(50);
  });

  it('使用自定义阈值：超出一个时为 large', () => {
    const result = decideScopeScale(51, { threshold: 50 });
    expect(result.tier).toBe('large');
  });

  it('返回完整决策对象，包含 fileCount 和 threshold', () => {
    const result = decideScopeScale(100, { threshold: 300 });
    expect(result).toEqual({ tier: 'small', fileCount: 100, threshold: 300 });
  });
});

describe('ScopeTooLargeError', () => {
  it('statusCode 为 413', () => {
    const error = new ScopeTooLargeError(250, 200);
    expect(error.statusCode).toBe(413);
  });

  it('message 包含文件数量', () => {
    const error = new ScopeTooLargeError(250, 200);
    expect(error.message).toContain('250');
  });

  it('message 包含阈值', () => {
    const error = new ScopeTooLargeError(250, 200);
    expect(error.message).toContain('200');
  });

  it('message 说明索引模式将在后续版本支持', () => {
    const error = new ScopeTooLargeError(250, 200);
    expect(error.message).toMatch(/index|later version/i);
  });

  it('是 Error 的子类', () => {
    const error = new ScopeTooLargeError(300, 200);
    expect(error).toBeInstanceOf(Error);
  });

  it('fileCount 和 threshold 属性正确', () => {
    const error = new ScopeTooLargeError(777, 200);
    expect(error.fileCount).toBe(777);
    expect(error.threshold).toBe(200);
  });
});

describe('DEFAULT_SCOPE_SMALL_THRESHOLD', () => {
  it('默认阈值为 200', () => {
    expect(DEFAULT_SCOPE_SMALL_THRESHOLD).toBe(200);
  });
});
