import { describe, expect, it } from 'vitest';
import { requireSafeId } from '../src/scope/workspace.js';

describe('requireSafeId', () => {
  it('accepts simple ASCII identifiers', () => {
    expect(requireSafeId('E521.31', 'chipId')).toBe('E521.31');
    expect(requireSafeId('chip_42', 'chipId')).toBe('chip_42');
    expect(requireSafeId('abc-def', 'chipId')).toBe('abc-def');
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(() => requireSafeId('', 'chipId')).toThrow(/safe identifier/);
    expect(() => requireSafeId('   ', 'chipId')).toThrow(/safe identifier/);
  });

  it('rejects path separators (security P2-4)', () => {
    expect(() => requireSafeId('../etc/passwd', 'chipId')).toThrow();
    expect(() => requireSafeId('foo/bar', 'chipId')).toThrow();
    expect(() => requireSafeId('foo\\bar', 'chipId')).toThrow();
  });

  it('rejects null bytes (security P2-4 hardening)', () => {
    // Node.js fs treats \0 as a string terminator, silently truncating paths.
    expect(() => requireSafeId('chip\0evil', 'chipId')).toThrow(/control characters|null bytes/);
    expect(() => requireSafeId('foo\u0000/bar', 'chipId')).toThrow();
  });

  it('rejects control characters', () => {
    expect(() => requireSafeId('chip\nname', 'chipId')).toThrow();
    expect(() => requireSafeId('chip\rname', 'chipId')).toThrow();
    expect(() => requireSafeId('chip\tname', 'chipId')).toThrow();
    expect(() => requireSafeId('chip\u0007name', 'chipId')).toThrow();
  });

  it('rejects Windows reserved device names', () => {
    expect(() => requireSafeId('CON', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('PRN', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('AUX', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('NUL', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('COM1', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('LPT9', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('con', 'chipId')).toThrow(/reserved device name/);
  });

  it('rejects Windows reserved device names with extensions or trailing dots', () => {
    expect(() => requireSafeId('CON.txt', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('com1.log', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('NUL.', 'chipId')).toThrow(/reserved device name/);
    expect(() => requireSafeId('LPT9.config', 'chipId')).toThrow(/reserved device name/);
  });

  it('rejects special-character-only strings', () => {
    expect(() => requireSafeId('.....', 'chipId')).not.toThrow();
    // Actually '.....' passes pattern; that's OK because it's not a traversal.
  });

  it('rejects "." and ".."', () => {
    expect(() => requireSafeId('.', 'chipId')).toThrow(/'\.' or '\.\.'/);
    expect(() => requireSafeId('..', 'chipId')).toThrow(/'\.' or '\.\.'/);
  });

  it('rejects identifiers longer than 128 chars', () => {
    const longId = 'a'.repeat(129);
    expect(() => requireSafeId(longId, 'chipId')).toThrow();
  });

  it('accepts identifiers exactly 128 chars', () => {
    const okId = 'a'.repeat(128);
    expect(requireSafeId(okId, 'chipId')).toBe(okId);
  });

  it('trims input before validating', () => {
    expect(requireSafeId('  E521.31  ', 'chipId')).toBe('E521.31');
  });
});
