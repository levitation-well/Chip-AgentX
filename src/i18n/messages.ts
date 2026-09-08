import { DEFAULT_LOCALE_PREFERENCE, isLocalePreference, type LocalePreference } from '../auth/index.js';

export type MessageCatalog = Record<LocalePreference, Record<string, string>>;

export const DEFAULT_MESSAGE_CATALOG: MessageCatalog = {
  'zh-CN': {
    'account.onboarding.profile': '完善资料',
    'account.onboarding.permissions': '查看权限',
    'account.onboarding.mcp_key': '创建 MCP key',
    'account.onboarding.mcp_access': '配置 MCP Access Center',
    'account.onboarding.whoami': '运行 whoami 验证',
    'account.onboarding.first_chat': '完成首次对话',
    'account.onboarding.upload_disclaimer': '确认资料上传声明',
    'common.error.unsupported_locale': '不支持的语言设置'
  },
  'en-US': {
    'account.onboarding.profile': 'Complete profile',
    'account.onboarding.permissions': 'Review permissions',
    'account.onboarding.mcp_key': 'Create MCP key',
    'account.onboarding.mcp_access': 'Configure MCP Access Center',
    'account.onboarding.whoami': 'Run whoami verification',
    'account.onboarding.first_chat': 'Complete first chat',
    'account.onboarding.upload_disclaimer': 'Confirm upload disclaimer',
    'common.error.unsupported_locale': 'Unsupported locale'
  }
};

export function normalizeMessageLocale(locale: unknown, fallback: LocalePreference = DEFAULT_LOCALE_PREFERENCE): LocalePreference {
  return isLocalePreference(locale) ? locale : fallback;
}

export function getMessage(
  key: string,
  locale: unknown,
  catalog: MessageCatalog = DEFAULT_MESSAGE_CATALOG,
  fallbackLocale: LocalePreference = DEFAULT_LOCALE_PREFERENCE
): string {
  const normalizedLocale = normalizeMessageLocale(locale, fallbackLocale);
  return catalog[normalizedLocale]?.[key] ?? catalog[fallbackLocale]?.[key] ?? key;
}

export function listMessages(
  locale: unknown,
  catalog: MessageCatalog = DEFAULT_MESSAGE_CATALOG,
  fallbackLocale: LocalePreference = DEFAULT_LOCALE_PREFERENCE
): Record<string, string> {
  const normalizedLocale = normalizeMessageLocale(locale, fallbackLocale);
  return {
    ...(catalog[fallbackLocale] ?? {}),
    ...(catalog[normalizedLocale] ?? {})
  };
}
