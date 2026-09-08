import { describe, expect, it } from 'vitest';
import {
  normalizeSkinId,
  readSkinPreference,
  writeSkinPreference,
  type SkinStorage
} from '../webui/src/skin-runtime.js';

const skins = ['cal', 'voltagent'] as const;

describe('skin runtime storage safety', () => {
  it('accepts supported skins and falls back for stale values', () => {
    expect(normalizeSkinId('voltagent', skins, 'cal')).toBe('voltagent');
    expect(normalizeSkinId('notion', skins, 'cal')).toBe('cal');
    expect(normalizeSkinId(null, skins, 'cal')).toBe('cal');
  });

  it('falls back when browser storage reads are blocked', () => {
    const storage: SkinStorage = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => undefined
    };
    expect(readSkinPreference(storage, 'agentx.webui.skin', skins, 'cal')).toBe('cal');
    expect(readSkinPreference(undefined, 'agentx.webui.skin', skins, 'cal')).toBe('cal');
  });

  it('reports blocked writes without throwing', () => {
    const storage: SkinStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); }
    };
    expect(writeSkinPreference(storage, 'agentx.webui.skin', 'voltagent')).toBe(false);
  });
});
