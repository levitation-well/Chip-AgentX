import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublic(path: string) {
  return readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
}

describe('Chat and Admin bilingual UI contracts', () => {
  it('loads page catalogs after the shared runtime and before page controllers', () => {
    const chat = readPublic('chat.html');
    const admin = readPublic('admin.html');

    expect(chat.indexOf('/i18n.js?v=2.2.44')).toBeLessThan(chat.indexOf('/assets/i18n-chat.js?v=2.2.45'));
    expect(chat.indexOf('/assets/i18n-chat.js?v=2.2.45')).toBeLessThan(chat.indexOf('/chat.js?v=2.2.44'));
    expect(admin.indexOf('/i18n.js?v=2.2.44')).toBeLessThan(admin.indexOf('/assets/i18n-admin.js?v=2.2.44'));
    expect(admin.indexOf('/assets/i18n-admin.js?v=2.2.44')).toBeLessThan(admin.indexOf('/admin.js?v=2.2.44'));
    expect(chat.indexOf('/i18n.js?v=2.2.44')).toBeLessThan(chat.indexOf('/assets/i18n-portal.js?v=2.2.44'));
    expect(admin.indexOf('/i18n.js?v=2.2.44')).toBeLessThan(admin.indexOf('/assets/i18n-portal.js?v=2.2.44'));
    expect(chat).toContain('data-portal-nav');
    expect(chat).toContain('data-portal-auth');
    expect(admin).toContain('data-portal-auth');
    expect(chat).toContain('data-agentx-locale-root');
    expect(admin).toContain('data-agentx-locale-root');
  });

  it('keeps the admin version pill runtime-driven with a neutral localizable placeholder', () => {
    const admin = readPublic('admin.html');
    const core = readPublic('i18n.js');

    expect(admin).not.toContain('本地 · v');
    expect(admin).toContain('data-product-version><span data-i18n="product.env.local">本地</span>');
    expect(admin).toContain('data-admin-nav-version data-product-version><span data-i18n="product.env.local">本地</span>');
    expect(core).toContain("'product.env.local': '本地'");
    expect(core).toContain("'product.env.local': 'Local'");
    expect(core).not.toContain("'nav.home'");
    expect(core).not.toContain("'nav.account'");
    expect(core).not.toContain("'nav.tickets'");
    expect(core).not.toContain("'nav.admin'");
    expect(core).not.toContain("'nav.chat'");
  });

  it('sends the selected locale on both Chat turn entry points without interrupting an active turn', () => {
    const html = readPublic('chat.html');
    const script = readPublic('chat.js');

    expect(html).not.toContain('id="chat-answer-language"');
    expect(html).not.toContain('data-i18n="chat.locale.hint"');
    expect(script).toMatch(/chatMode:\s*selectedChatMode\(\),\s*locale:\s*state\.locale/);
    expect(script).toMatch(/JSON\.stringify\(\{\s*data:\s*text,\s*submit:\s*true,\s*locale:\s*state\.locale\s*\}\)/);

    const localeHandler = script.slice(
      script.indexOf("window.addEventListener('localechange'"),
      script.indexOf("window.addEventListener('localechange'") + 420
    );
    expect(localeHandler).toContain('renderLocalizedChatUi()');
    expect(script).not.toContain('syncImageUploadControl');
    expect(localeHandler).not.toContain('closeStream');
    expect(localeHandler).not.toContain('cancelActiveTurn');
    expect(localeHandler).not.toContain('finishTurn');
  });

  it('registers symmetric Chinese and English Chat catalogs', () => {
    const catalog = readPublic('assets/i18n-chat.js');

    expect(catalog).toContain("registerCatalog?.('chat'");
    expect(catalog).not.toContain('chat.locale.hint');
    expect(catalog).not.toContain('chat.locale.overrideHint');
    for (const key of [
      'chat.message.placeholder',
      'chat.session.new',
      'chat.scope.mode.global',
      'chat.feedback.reason.bad-citation',
      'chat.error.streamReconnect'
    ]) {
      expect(catalog.match(new RegExp(`'${key.replaceAll('.', '\\.')}'`, 'g'))).toHaveLength(2);
    }
  });

  it('covers every Admin route group and keeps dynamic section labels locale-driven', () => {
    const html = readPublic('admin.html');
    const script = readPublic('admin.js');
    const catalog = readPublic('assets/i18n-admin.js');
    const sections = [
      'users',
      'roles',
      'chips',
      'resources',
      'prompts',
      'sessions',
      'observability',
      'announcements',
      'feedback',
      'model-routing',
      'discovery-traces'
    ];

    for (const section of sections) {
      expect(html).toContain(`href="/admin/sections/${section}"`);
      expect(script).toContain(`${section.includes('-') ? `'${section}'` : section}: { path: '/admin/sections/${section}'`);
    }
    expect(catalog).toContain("registerCatalog?.('admin'");
    expect(script).toContain('adminSectionLabel(tabSection');
    expect(script).toContain('adminGroupLabel(group)');
    expect(script).toContain("window.addEventListener('localechange'");
  });

  it('owns Admin accessibility copy with semantic keys and uses consistent Key terminology', () => {
    const html = readPublic('admin.html');
    const script = readPublic('admin.js');
    const catalog = readPublic('assets/i18n-admin.js');

    for (const key of [
      'admin.aria.subviews',
      'admin.users.listAria',
      'admin.history.userFilterPlaceholder',
      'admin.diagnostics.quickFiltersAria',
      'admin.resources.documentsTableAria',
      'admin.tickets.replyPlaceholder',
      'admin.prompts.contentPlaceholder'
    ]) {
      expect(catalog).toContain(`['${key}'`);
      expect(html).toContain(`="${key}"`);
    }
    for (const [name, source] of [
      ['admin.html', html],
      ['admin.js', script],
      ['assets/i18n-admin.js', catalog]
    ]) {
      expect(source, name).not.toMatch(/\bKEY\b/);
    }
  });

  it('uses bilingual announcement fields and the translations wire payload', () => {
    const html = readPublic('admin.html');
    const script = readPublic('admin.js');

    expect(html).toContain('data-announcement-locale="zh-CN"');
    expect(html).toContain('data-announcement-locale="en-US"');
    expect(html).toContain('id="announcement-admin-title-input-en"');
    expect(html).toContain('id="announcement-admin-summary-input-en"');
    expect(html).toContain('id="announcement-admin-body-en"');
    expect(script).toContain("translations: { 'zh-CN': zh, 'en-US': en }");
    expect(script).toContain("announcementTranslation(detail, 'zh-CN')");
    expect(script).toContain("announcementTranslation(detail, 'en-US')");
    expect(script).toContain("setAnnouncementEditorLocale('en-US')");
  });
});
