import { describe, expect, it } from 'vitest';
import { getMessage, listMessages, normalizeMessageLocale } from '../src/i18n/index.js';

describe('i18n message catalog foundation', () => {
  it('looks up zh-CN and en-US messages with locale fallback', () => {
    expect(getMessage('account.onboarding.profile', 'zh-CN')).toBe('完善资料');
    expect(getMessage('account.onboarding.profile', 'en-US')).toBe('Complete profile');
    expect(getMessage('account.onboarding.profile', 'fr-FR')).toBe('完善资料');
    expect(getMessage('missing.key', 'en-US')).toBe('missing.key');
  });

  it('merges fallback catalog entries for incomplete locale catalogs', () => {
    const messages = listMessages(
      'en-US',
      {
        'zh-CN': {
          shared: '共享',
          onlyFallback: '仅默认'
        },
        'en-US': {
          shared: 'Shared'
        }
      },
      'zh-CN'
    );

    expect(messages).toEqual({
      shared: 'Shared',
      onlyFallback: '仅默认'
    });
    expect(normalizeMessageLocale('bad-locale')).toBe('zh-CN');
  });
});
