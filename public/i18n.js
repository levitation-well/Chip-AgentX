(function () {
  const DEFAULT_LOCALE = 'zh-CN';
  const SUPPORTED_LOCALES = new Set(['zh-CN', 'en-US']);

  const catalog = {
    'zh-CN': {
      'product.env.local': '本地',
      'action.refresh': '刷新',
      'action.login': '登录',
      'action.logout': '登出',
      'action.save': '保存',
      'action.skip': '跳过',
      'action.reopen': '重新打开',
      'common.loading': '正在加载…',
      'account.title': '用户中心',
      'account.locale.label': '界面语言',
      'account.locale.saved': '语言偏好已保存',
      'account.locale.failed': '语言偏好保存失败',
      'account.onboarding.title': '上手清单',
      'account.onboarding.hint': '这些步骤只记录你自己的进度，不会创建 key 或扩大权限。',
      'account.onboarding.profile': '完善资料',
      'account.onboarding.permissions': '查看权限',
      'account.onboarding.mcp_key': '创建或查看 MCP Key',
      'account.onboarding.mcp_access': '进入 MCP Access Center',
      'account.onboarding.whoami': '运行 whoami / smoke test',
      'account.onboarding.first_chat': '发起第一次 Chat',
      'account.onboarding.upload_disclaimer': '阅读资料上传声明',
      'account.onboarding.done': '已完成',
      'account.onboarding.mark': '标记完成',
      'account.onboarding.status.not_started': '未开始',
      'account.onboarding.status.in_progress': '进行中',
      'account.onboarding.status.skipped': '已跳过',
      'account.onboarding.status.completed': '已完成',
      'account.onboarding.updated': '上手进度已更新',
      'account.onboarding.failed': '上手进度更新失败',
      'account.onboarding.skip': '暂时跳过',
      'account.onboarding.reopen': '重新打开清单',
      'account.onboarding.uploadHint': '资料上传会先进入隔离审核；审核前不会进入 Chat/MCP 检索。',
      'mcp.onboarding.hint': '建议先复制配置模板，填入 Key 后运行 agentx_whoami({}) 验证。',
      'mcp.public.note': '未登录时仅显示公共接入信息。登录后可查看 Key、授权模型与资源详情。',
      'mcp.private.note': '当前账号的 Key、授权模型与资源详情。',
      'mcp.public.status': '公共接入说明',
      'mcp.security.placeholder': '模板只使用 AGENTX_MCP_KEY 占位符，不展示完整 MCP Key。',
      'admin.access.autoExpandHint': '品牌/产品线授权会自动展开为芯片授权',
      'admin.observability.loading': '正在加载成本观测指标…',
      'admin.observability.empty': '暂无成本观测数据',
      'admin.observability.noData': '暂无数据',
      'admin.observability.noAnomalies': '暂无异常',
      'admin.observability.calls': '调用量',
      'admin.observability.credits': '积分消耗',
      'admin.observability.estimatedTokens': '估算 token',
      'admin.observability.averageLatency': '平均延迟',
      'admin.observability.averageDuration': '平均耗时',
      'admin.observability.failureRate': '失败率',
      'admin.observability.severity': '关注',
      'admin.observability.severity.error': '严重',
      'admin.observability.severity.warn': '警告',
      'admin.observability.severity.info': '关注',
      'admin.observability.severity.neutral': '提示',
      'admin.observability.value': '数值',
      'admin.observability.openUser': '打开用户详情',
      'admin.observability.anomaly.high_credits': '高积分消耗',
      'admin.observability.anomaly.high_failure_rate': '高失败率',
      'admin.observability.anomaly.large_output': '超大输出',
      'admin.users.jumpNotFound': '未找到匹配用户，已切换到用户列表。',
      'admin.diagnostics.claudeCode.ok': '已接入',
      'admin.diagnostics.claudeCode.unavailable': '未安装',
      'admin.diagnostics.claudeCode.error': '异常：{detail}',
      'admin.credits.adjustMode.delta': '按 delta 调整',
      'admin.credits.adjustMode.target': '按目标余额调整',
      'admin.credits.modeDelta': '差额',
      'admin.credits.modeTarget': '目标余额',
      'admin.credits.amountPlaceholder': '输入 deltaUnits 或 balanceUnits 数量',
      'admin.credits.deltaSummary': '按差额调整 {n} 单位',
      'admin.credits.targetSummary': '将余额设为 {n} 单位',
      'admin.credits.adjustTitle': '调整积分',
      'admin.credits.confirm': '确认调整',
      'admin.keys.sensitive': '敏感凭据：完整 MCP Key 仅在创建/重置瞬间可见一次，请妥善保存',
      'admin.keys.empty': '暂无 MCP Key',
      'admin.tickets.datasheet.status.received': '已接收',
      'admin.tickets.datasheet.status.archived': '已归档',
      'admin.tickets.accountApplication.approveCreate': '批准并创建用户',
      'admin.tickets.accountApplication.approving': '正在批准并创建用户…',
      'admin.tickets.accountApplication.created': '已创建用户',
      'admin.announcements.preview.title': '门户呈现预览',
      'admin.announcements.preview.hint': '以下是该公告在门户页面上的只读预览',
      'admin.chips.workspace.formatValid': '路径格式正确',
      'admin.chips.workspace.invalid': '路径格式异常',
      'admin.chips.deleteTitle': '删除芯片',
      'admin.chips.documents.empty': '暂无关联文档',
      'admin.roles.deleteTitle': '删除角色模板',
      'admin.resources.deleteTitle': '删除资源',
      'admin.resources.requiredGrants.empty': '无',
      'admin.prompts.discardTitle': '放弃未保存的提示词修改',
      'admin.prompts.discardBody': '当前提示词编辑区有未保存变更，切换文件将丢失这些改动，是否继续？',
      'admin.prompts.discardNative': 'Discard unsaved prompt changes?',
      'admin.prompts.rollbackTitle': '回滚提示词到上一版',
      'admin.prompts.rollbackBody': '当前草稿会被覆盖，提交后无法恢复。是否继续？',
      'admin.prompts.rollbackConfirm': '回滚',
      'admin.debug.stage.skipped': '未执行（上游阶段失败，流水线已中断）',
      'admin.debug.notice': '会话 Debug 取证（仅管理员可见）',
      'admin.keys.noKeys': '暂无 Key，点击「生成新 Key」创建。',
      'common.delete': '删除',
      'common.cancel': '取消',
      'common.confirm': '确认',
      'common.discard': '放弃并继续',
      'common.requestFailed': '请求失败（{status}）',
      'mcp.client.title': 'AgentX MCP 接入中心',
      'mcp.client.legacyNote': '是旧版别名。当前 MCP 接入中心为',
      'mcp.client.legacyBody': '请使用当前页面获取 opencode、Codex、Claude Code 模板、基于 chatMode 的 agent_spawn 示例、AgentX 客户端包与安全的占位符配置。',
      'mcp.client.open': '打开 /mcp-access',
      'updates.filter.all': '全部',
      'updates.filter.release': '版本发布',
      'updates.filter.news': '新闻',
      'updates.filter.announcement': '公告',
      'updates.unread': '未读',
      'updates.untitled': '未命名更新',
      'updates.empty': '暂无可见更新',
      'updates.loading': '正在加载更新…',
      'updates.loadFailed': '更新加载失败，请稍后重试',
      'updates.select': '选择一条查看详情。',
      'agentx.skins.menuLabel': '界面皮肤',
      'agentx.skins.selectorLabel': '皮肤选择器',
      'agentx.skins.enabled': '{name} 皮肤已启用',
      'agentx.skins.cal.mood': '中性日程风',
      'agentx.skins.voltagent.mood': '深空绿终端风'
    },
    'en-US': {
      'product.env.local': 'Local',
      'action.refresh': 'Refresh',
      'action.login': 'Log in',
      'action.logout': 'Log out',
      'action.save': 'Save',
      'action.skip': 'Skip',
      'action.reopen': 'Reopen',
      'common.loading': 'Loading…',
      'account.title': 'Account Center',
      'account.locale.label': 'Interface language',
      'account.locale.saved': 'Language preference saved',
      'account.locale.failed': 'Failed to save language preference',
      'account.onboarding.title': 'Onboarding checklist',
      'account.onboarding.hint': 'These steps only save your own progress. They do not create keys or expand permissions.',
      'account.onboarding.profile': 'Complete profile',
      'account.onboarding.permissions': 'Review permissions',
      'account.onboarding.mcp_key': 'Create or review an MCP key',
      'account.onboarding.mcp_access': 'Open MCP Access Center',
      'account.onboarding.whoami': 'Run whoami / smoke test',
      'account.onboarding.first_chat': 'Start your first Chat',
      'account.onboarding.upload_disclaimer': 'Read the upload disclaimer',
      'account.onboarding.done': 'Done',
      'account.onboarding.mark': 'Mark done',
      'account.onboarding.status.not_started': 'Not started',
      'account.onboarding.status.in_progress': 'In progress',
      'account.onboarding.status.skipped': 'Skipped',
      'account.onboarding.status.completed': 'Completed',
      'account.onboarding.updated': 'Onboarding progress updated',
      'account.onboarding.failed': 'Failed to update onboarding progress',
      'account.onboarding.skip': 'Skip for now',
      'account.onboarding.reopen': 'Reopen checklist',
      'account.onboarding.uploadHint': 'Uploads enter isolated review first. Before approval, they are not searchable from Chat or MCP.',
      'mcp.onboarding.hint': 'Copy a placeholder template first, then run agentx_whoami({}) with your private local key.',
      'mcp.public.note': 'Unauthenticated users can only view public access metadata, template downloads, and safety notes. After login, this page shows only your own key summaries, models, and resources.',
      'mcp.private.note': 'This view only shows masked/fingerprint key summaries, models, and resources for the current account.',
      'mcp.public.status': 'Public access guide',
      'mcp.security.placeholder': 'Templates use the AGENTX_MCP_KEY placeholder only and never show a full MCP key.',
      'admin.access.autoExpandHint': 'Brand and product-line grants automatically expand into chip grants',
      'admin.observability.loading': 'Loading observability metrics…',
      'admin.observability.empty': 'No observability data',
      'admin.observability.noData': 'No data',
      'admin.observability.noAnomalies': 'No anomalies',
      'admin.observability.calls': 'Calls',
      'admin.observability.credits': 'Credits',
      'admin.observability.estimatedTokens': 'Est. tokens',
      'admin.observability.averageLatency': 'Avg latency',
      'admin.observability.averageDuration': 'Avg duration',
      'admin.observability.failureRate': 'Failure rate',
      'admin.observability.severity': 'Review',
      'admin.observability.severity.error': 'Critical',
      'admin.observability.severity.warn': 'Warning',
      'admin.observability.severity.info': 'Review',
      'admin.observability.severity.neutral': 'Notice',
      'admin.observability.value': 'Value',
      'admin.observability.openUser': 'Open user details',
      'admin.observability.anomaly.high_credits': 'High credits',
      'admin.observability.anomaly.high_failure_rate': 'High failure rate',
      'admin.observability.anomaly.large_output': 'Large output',
      'admin.users.jumpNotFound': 'No matching user found. Switched to the user list.',
      'admin.diagnostics.claudeCode.ok': 'Available',
      'admin.diagnostics.claudeCode.unavailable': 'Not installed',
      'admin.diagnostics.claudeCode.error': 'Error: {detail}',
      'admin.credits.adjustMode.delta': 'Adjust by delta',
      'admin.credits.adjustMode.target': 'Adjust by target balance',
      'admin.credits.modeDelta': 'Delta',
      'admin.credits.modeTarget': 'Target balance',
      'admin.credits.amountPlaceholder': 'Enter delta units',
      'admin.credits.deltaSummary': 'Adjust by delta of {n} units',
      'admin.credits.targetSummary': 'Set balance to {n} units',
      'admin.credits.adjustTitle': 'Adjust credits',
      'admin.credits.confirm': 'Confirm adjust',
      'admin.keys.sensitive': 'Sensitive credential: full MCP Key is only visible once during creation or reset. Store it securely.',
      'admin.keys.empty': 'No MCP keys',
      'admin.tickets.datasheet.status.received': 'Received',
      'admin.tickets.datasheet.status.archived': 'Archived',
      'admin.tickets.accountApplication.approveCreate': 'Approve and create user',
      'admin.tickets.accountApplication.approving': 'Approving and creating user…',
      'admin.tickets.accountApplication.created': 'Created user',
      'admin.announcements.preview.title': 'Portal preview',
      'admin.announcements.preview.hint': 'Read-only preview of how this announcement renders on the portal page.',
      'admin.chips.workspace.formatValid': 'Path format valid',
      'admin.chips.workspace.invalid': 'Path format invalid',
      'admin.chips.deleteTitle': 'Delete chip',
      'admin.chips.documents.empty': 'No associated documents yet',
      'admin.roles.deleteTitle': 'Delete role template',
      'admin.resources.deleteTitle': 'Delete resource',
      'admin.resources.requiredGrants.empty': 'None',
      'admin.prompts.discardTitle': 'Discard unsaved prompt changes',
      'admin.prompts.discardBody': 'The prompt editor has unsaved changes that will be lost when switching files. Continue?',
      'admin.prompts.discardNative': 'Discard unsaved prompt changes?',
      'admin.prompts.rollbackTitle': 'Roll prompt back to previous version',
      'admin.prompts.rollbackBody': 'Current draft will be overwritten. This cannot be undone after saving. Continue?',
      'admin.prompts.rollbackConfirm': 'Roll back',
      'admin.debug.stage.skipped': 'Skipped (upstream stage failed; pipeline interrupted)',
      'admin.debug.notice': 'Session debug bundle (admin-only)',
      'admin.keys.noKeys': 'No keys yet. Click "Generate new key" to create one.',
      'common.delete': 'Delete',
      'common.cancel': 'Cancel',
      'common.confirm': 'Confirm',
      'common.discard': 'Discard and continue',
      'common.requestFailed': 'Request failed ({status})',
      'mcp.client.title': 'AgentX MCP Access Center',
      'mcp.client.legacyNote': 'is a legacy alias. The current MCP access center is',
      'mcp.client.legacyBody': 'Use the current page for opencode, Codex, Claude Code templates, chatMode-based agent_spawn examples, the AgentX client package, and safe placeholder-based setup.',
      'mcp.client.open': 'Open /mcp-access',
      'updates.filter.all': 'All',
      'updates.filter.release': 'Releases',
      'updates.filter.news': 'News',
      'updates.filter.announcement': 'Announcements',
      'updates.unread': 'Unread',
      'updates.untitled': 'Untitled update',
      'updates.empty': 'No updates available',
      'updates.loading': 'Loading updates…',
      'updates.loadFailed': 'Failed to load updates. Please try again later.',
      'updates.select': 'Select an update to view details.',
      'agentx.skins.menuLabel': 'Interface skins',
      'agentx.skins.selectorLabel': 'Skin selector',
      'agentx.skins.enabled': '{name} skin enabled',
      'agentx.skins.cal.mood': 'Neutral scheduling OS',
      'agentx.skins.voltagent.mood': 'Void green terminal'
    }
  };

  function normalizeLocale(locale, fallback = DEFAULT_LOCALE) {
    return SUPPORTED_LOCALES.has(locale) ? locale : fallback;
  }

  function fromUser(user) {
    return normalizeLocale(user?.localePreference || user?.preferredLanguage || user?.locale);
  }

  function t(key, locale, fallbackLocale = DEFAULT_LOCALE) {
    const normalized = normalizeLocale(locale, fallbackLocale);
    return catalog[normalized]?.[key] || catalog[fallbackLocale]?.[key] || key;
  }

  function applyLocale(locale) {
    const normalized = normalizeLocale(locale);
    document.documentElement.lang = normalized;
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n, normalized);
    }
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
      node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder, normalized));
    }
    for (const node of document.querySelectorAll('[data-i18n-aria-label]')) {
      node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel, normalized));
    }
    for (const node of document.querySelectorAll('[data-i18n-title]')) {
      node.setAttribute('title', t(node.dataset.i18nTitle, normalized));
    }
    return normalized;
  }

  window.AgentXI18n = {
    DEFAULT_LOCALE,
    catalog,
    normalizeLocale,
    fromUser,
    t,
    applyLocale
  };
})();

// Shared AgentX locale runtime. The compatibility catalog above covers
// shared/Admin keys while page-specific catalogs register below it.
(function () {
  const api = window.AgentXI18n;
  if (!api) return;

  const LOCALE_KEY = 'agentx.locale.preference';
  const EXPLICIT_KEY = 'agentx.locale.explicit';
  const USER_KEY = 'agentx.auth.user';
  const supported = ['zh-CN', 'en-US'];
  const namespaces = new Map();
  const sourceIndexes = new Map(supported.map((locale) => [locale, new Map()]));
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  let currentLocale = resolveInitialLocale();
  let applying = false;
  let observer = null;

  function safeGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSet(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // Locale changes must remain usable when storage is unavailable.
    }
  }

  function readCachedUser() {
    try {
      const raw = safeGet(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function readAuthenticatedUser() {
    const cached = readCachedUser();
    if (cached) return cached;
    try {
      return window.AgentXAuth?.getUser?.() || null;
    } catch {
      return null;
    }
  }

  function browserLocale() {
    const values = Array.isArray(navigator.languages) && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
    return values.some((value) => /^en(?:-|$)/i.test(String(value || ''))) ? 'en-US' : 'zh-CN';
  }

  function resolveInitialLocale() {
    const user = readAuthenticatedUser();
    const accountLocale = user?.localePreference || user?.preferredLanguage || user?.locale;
    if (supported.includes(accountLocale)) return accountLocale;
    if (user) return 'zh-CN';
    const saved = safeGet(LOCALE_KEY);
    if (safeGet(EXPLICIT_KEY) === '1' && supported.includes(saved)) return saved;
    return browserLocale();
  }

  function normalizeLocale(locale, fallback = api.DEFAULT_LOCALE) {
    if (supported.includes(locale)) return locale;
    if (/^en(?:-|$)/i.test(String(locale || ''))) return 'en-US';
    if (/^zh(?:-|$)/i.test(String(locale || ''))) return 'zh-CN';
    return supported.includes(fallback) ? fallback : 'zh-CN';
  }

  function registerCatalog(namespace, localizedCatalog) {
    if (!namespace || !localizedCatalog) return;
    const previous = namespaces.get(namespace) || {};
    const next = { ...previous };
    for (const locale of supported) {
      const values = localizedCatalog[locale] || {};
      next[locale] = { ...(previous[locale] || {}), ...values };
      Object.assign(api.catalog[locale], values);
    }
    namespaces.set(namespace, next);
    rebuildSourceIndexes();
  }

  function rebuildSourceIndexes() {
    for (const index of sourceIndexes.values()) index.clear();
    const keys = new Set([
      ...Object.keys(api.catalog['zh-CN'] || {}),
      ...Object.keys(api.catalog['en-US'] || {})
    ]);
    for (const key of keys) {
      for (const locale of supported) {
        const value = api.catalog[locale]?.[key];
        if (typeof value === 'string' && value && !value.includes('{')) {
          sourceIndexes.get(locale).set(value, key);
        }
      }
    }
  }

  function interpolate(message, params) {
    if (!params || typeof message !== 'string') return message;
    return message.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) =>
      Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    );
  }

  function t(key, paramsOrLocale, maybeLocale) {
    const params = typeof paramsOrLocale === 'object' && paramsOrLocale !== null ? paramsOrLocale : undefined;
    const locale = normalizeLocale(
      typeof paramsOrLocale === 'string' ? paramsOrLocale : maybeLocale || currentLocale
    );
    const message = api.catalog[locale]?.[key] ?? api.catalog['zh-CN']?.[key] ?? key;
    return interpolate(message, params);
  }

  function formatDate(value, options = {}, locale = currentLocale) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(normalizeLocale(locale), options).format(date);
  }

  function formatNumber(value, options = {}, locale = currentLocale) {
    return new Intl.NumberFormat(normalizeLocale(locale), options).format(Number(value));
  }

  function collator(options = {}, locale = currentLocale) {
    return new Intl.Collator(normalizeLocale(locale), options);
  }

  function plural(count, forms, locale = currentLocale) {
    const category = new Intl.PluralRules(normalizeLocale(locale)).select(Number(count));
    const template = forms?.[category] ?? forms?.other ?? '';
    return interpolate(template, { count });
  }

  function isPreserved(node) {
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !parent || Boolean(parent.closest(
      '[data-i18n-preserve], pre, code, script, style, textarea, [contenteditable="true"]'
    ));
  }

  function keyForSource(value) {
    if (!value) return '';
    return sourceIndexes.get('zh-CN').get(value) || sourceIndexes.get('en-US').get(value) || '';
  }

  function translateTextNode(node, locale) {
    if (isPreserved(node)) return;
    const raw = originalText.has(node) ? originalText.get(node) : node.nodeValue;
    const leading = raw.match(/^\s*/)?.[0] || '';
    const trailing = raw.match(/\s*$/)?.[0] || '';
    const source = raw.trim();
    const key = keyForSource(source);
    if (!key) return;
    if (!originalText.has(node)) originalText.set(node, raw);
    node.nodeValue = `${leading}${t(key, locale)}${trailing}`;
  }

  function translateAttribute(element, attribute, locale) {
    const attrMap = originalAttributes.get(element) || {};
    const current = Object.prototype.hasOwnProperty.call(attrMap, attribute)
      ? attrMap[attribute]
      : element.getAttribute(attribute);
    const key = keyForSource(current);
    if (!key) return;
    if (!Object.prototype.hasOwnProperty.call(attrMap, attribute)) {
      attrMap[attribute] = current;
      originalAttributes.set(element, attrMap);
    }
    element.setAttribute(attribute, t(key, locale));
  }

  function applyElement(element, locale) {
    if (!(element instanceof Element)) return;
    const preserved = isPreserved(element);
    for (const [attribute, dataAttribute] of [
      ['placeholder', 'data-i18n-placeholder'],
      ['aria-label', 'data-i18n-aria-label'],
      ['title', 'data-i18n-title'],
      ['alt', 'data-i18n-alt']
    ]) {
      const explicitKey = element.getAttribute(dataAttribute);
      if (explicitKey) {
        element.setAttribute(attribute, t(explicitKey, locale));
      } else if (!preserved && element.hasAttribute(attribute)) {
        translateAttribute(element, attribute, locale);
      }
    }
    if (preserved) return;
    const key = element.getAttribute('data-i18n');
    if (key) element.textContent = t(key, locale);
    for (const child of element.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) translateTextNode(child, locale);
    }
  }

  function applyLocale(locale = currentLocale, root = document) {
    const normalized = normalizeLocale(locale);
    currentLocale = normalized;
    applying = true;
    try {
      document.documentElement.lang = normalized;
      document.documentElement.dataset.agentxLocale = normalized;
      if (root === document) {
        const titleKey = document.documentElement.getAttribute('data-i18n-title');
        if (titleKey) document.title = t(titleKey, normalized);
        else {
          const titleCatalogKey = `page.title.${normalizePageName(location.pathname)}`;
          if (api.catalog[normalized]?.[titleCatalogKey]) document.title = t(titleCatalogKey, normalized);
        }
      }
      if (root instanceof Element) applyElement(root, normalized);
      for (const element of root.querySelectorAll?.('*') || []) applyElement(element, normalized);
      syncSwitches(root);
    } finally {
      applying = false;
    }
    return normalized;
  }

  function normalizePageName(pathname) {
    const clean = String(pathname || '').replace(/^\/|\/$/g, '').replace(/\.html$/, '');
    return clean === '' || clean === 'index' ? 'home' : clean;
  }

  function updateCachedUserLocale(locale) {
    const user = readAuthenticatedUser();
    if (!user) return;
    user.localePreference = locale;
    user.preferredLanguage = locale;
    safeSet(USER_KEY, JSON.stringify(user));
    window.AgentXAuth?.setUser?.(user);
  }

  async function setLocale(locale, options = {}) {
    const normalized = normalizeLocale(locale);
    const previous = currentLocale;
    const persist = options.persist !== false;
    const syncAccount = options.syncAccount !== false;
    currentLocale = normalized;
    if (persist) {
      safeSet(LOCALE_KEY, normalized);
      safeSet(EXPLICIT_KEY, '1');
    }
    applyLocale(normalized);
    window.dispatchEvent(new CustomEvent('localechange', {
      detail: { locale: normalized, previousLocale: previous, source: options.source || 'local' }
    }));

    const token = window.AgentXAuth?.getToken?.();
    if (!syncAccount || !token) {
      if (readCachedUser()) updateCachedUserLocale(normalized);
      return normalized;
    }

    try {
      const response = await window.AgentXAuth.authFetch('/api/account/locale', {
        method: 'PUT',
        body: JSON.stringify({ locale: normalized }),
        skipAuthRedirect: true
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t('account.locale.failed', normalized));
      updateCachedUserLocale(body.user?.localePreference || normalized);
      return normalized;
    } catch (error) {
      currentLocale = previous;
      safeSet(LOCALE_KEY, previous);
      applyLocale(previous);
      window.dispatchEvent(new CustomEvent('localechange', {
        detail: { locale: previous, previousLocale: normalized, source: 'rollback', error }
      }));
      throw error;
    }
  }

  function adoptAccountUser(user) {
    const preferred = user?.localePreference || user?.preferredLanguage || user?.locale;
    const locale = supported.includes(preferred) ? preferred : 'zh-CN';
    updateCachedUserLocale(locale);
    safeSet(LOCALE_KEY, locale);
    currentLocale = locale;
    applyLocale(locale);
    window.dispatchEvent(new CustomEvent('localechange', {
      detail: { locale, source: 'account' }
    }));
    return locale;
  }

  function createSwitch(doc = document) {
    const group = doc.createElement('div');
    group.className = 'agentx-locale-switch';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', t('locale.switch.label'));
    group.dataset.agentxLocaleSwitch = '';
    for (const [locale, label] of [['zh-CN', '中'], ['en-US', 'EN']]) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.dataset.locale = locale;
      button.textContent = label;
      button.setAttribute('aria-label', t(locale === 'zh-CN' ? 'locale.switch.zh' : 'locale.switch.en'));
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await setLocale(locale, { source: 'switch' });
        } catch (error) {
          window.AgentXUI?.toast?.({
            kind: 'error',
            title: t('account.locale.failed'),
            detail: error?.message || ''
          });
        } finally {
          button.disabled = false;
        }
      });
      group.append(button);
    }
    syncSwitches(group);
    return group;
  }

  function mountSwitches(root = document) {
    for (const slot of root.querySelectorAll?.('[data-agentx-locale-root]') || []) {
      if (!slot.querySelector('[data-agentx-locale-switch]')) slot.append(createSwitch(slot.ownerDocument));
    }
    for (const authSlot of root.querySelectorAll?.('[data-portal-auth]') || []) {
      const parent = authSlot.parentElement;
      if (!parent || root.querySelector?.('[data-agentx-locale-switch]')) continue;
      authSlot.insertAdjacentElement('afterend', createSwitch(authSlot.ownerDocument));
    }
  }

  function syncSwitches(root = document) {
    const switches = root.matches?.('[data-agentx-locale-switch]')
      ? [root]
      : root.querySelectorAll?.('[data-agentx-locale-switch]') || [];
    for (const group of switches) {
      group.setAttribute('aria-label', t('locale.switch.label'));
      for (const button of group.querySelectorAll('[data-locale]')) {
        const active = button.dataset.locale === currentLocale;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        button.setAttribute('aria-label', t(
          button.dataset.locale === 'zh-CN' ? 'locale.switch.zh' : 'locale.switch.en'
        ));
      }
    }
  }

  function observeDom() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((records) => {
      if (applying) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            applyLocale(currentLocale, node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            translateTextNode(node, currentLocale);
          }
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  registerCatalog('core', {
    'zh-CN': {
      'locale.switch.label': '界面语言',
      'locale.switch.zh': '切换到中文',
      'locale.switch.en': 'Switch to English',
      'page.title.home': 'AgentX · 工程资料平台',
      'page.title.chat': 'AgentX · 对话',
      'page.title.admin': 'AgentX · 管理控制台',
      'page.title.login': 'AgentX · 登录',
      'page.title.account': 'AgentX · 用户中心',
      'page.title.mcp-access': 'AgentX · MCP 接入中心',
      'page.title.mcp-client': 'AgentX · MCP 接入中心',
      'page.title.tickets': 'AgentX · 工单系统',
      'page.title.feedback': 'AgentX · 需求与反馈',
      'page.title.datasheet-submit': 'AgentX · 资料提交',
      'page.title.updates': 'AgentX · 新闻与更新',
      'page.title.join-application': 'AgentX · 加入申请',
      'page.title.donation-support': 'AgentX · 支持平台运行'
    },
    'en-US': {
      'locale.switch.label': 'Interface language',
      'locale.switch.zh': 'Switch to Chinese',
      'locale.switch.en': 'Switch to English',
      'page.title.home': 'AgentX · Engineering Knowledge Platform',
      'page.title.chat': 'AgentX · Chat',
      'page.title.admin': 'AgentX · Admin',
      'page.title.login': 'AgentX · Log in',
      'page.title.account': 'AgentX · Account',
      'page.title.mcp-access': 'AgentX · MCP Access Center',
      'page.title.mcp-client': 'AgentX · MCP Access Center',
      'page.title.tickets': 'AgentX · Tickets',
      'page.title.feedback': 'AgentX · Feedback',
      'page.title.datasheet-submit': 'AgentX · Submit Material',
      'page.title.updates': 'AgentX · News & Updates',
      'page.title.join-application': 'AgentX · Join',
      'page.title.donation-support': 'AgentX · Support the Platform'
    }
  });

  Object.assign(api, {
    LOCALE_KEY,
    SUPPORTED_LOCALES: Object.freeze([...supported]),
    registerCatalog,
    normalizeLocale,
    getLocale: () => currentLocale,
    resolveInitialLocale,
    t,
    interpolate,
    formatDate,
    formatNumber,
    collator,
    plural,
    applyLocale,
    setLocale,
    adoptAccountUser,
    createSwitch,
    mountSwitches
  });

  document.documentElement.lang = currentLocale;
  document.documentElement.dataset.agentxLocale = currentLocale;

  const initialize = () => {
    mountSwitches(document);
    applyLocale(currentLocale);
    observeDom();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }

  window.addEventListener('storage', (event) => {
    if (event.key !== LOCALE_KEY || !supported.includes(event.newValue)) return;
    const previous = currentLocale;
    currentLocale = event.newValue;
    applyLocale(currentLocale);
    window.dispatchEvent(new CustomEvent('localechange', {
      detail: { locale: currentLocale, previousLocale: previous, source: 'storage' }
    }));
  });
  window.addEventListener('pageshow', () => {
    const resolved = resolveInitialLocale();
    if (resolved !== currentLocale) {
      currentLocale = resolved;
      applyLocale(resolved);
    }
  });
})();
