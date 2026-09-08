(function () {
  if (!window.AgentXAuth.requireLogin('/login')) {
    return;
  }

  const state = {
    account: null,
    credits: null,
    oneTimeSecret: null,
    locale: 'zh-CN',
    accountLoadRequestId: 0,
    activeView: 'overview',
    resourceFilter: 'all',
    resourceSearch: '',
    resourceCollapsed: false
  };

  const els = {
    refresh: document.getElementById('account-refresh'),
    userStatus: document.getElementById('account-user-status'),
    status: document.getElementById('account-status'),
    localeSelect: document.getElementById('account-locale'),
    localeResult: document.getElementById('account-locale-result'),
    username: document.getElementById('account-username'),
    role: document.getElementById('account-role'),
    accountAvailability: document.getElementById('account-availability'),
    creditBalance: document.getElementById('account-credit-balance'),
    keyCount: document.getElementById('account-key-count'),
    profileForm: document.getElementById('account-profile-form'),
    profileResult: document.getElementById('account-profile-result'),
    passwordForm: document.getElementById('account-password-form'),
    passwordResult: document.getElementById('account-password-result'),
    currentPassword: document.getElementById('account-current-password'),
    newPassword: document.getElementById('account-new-password'),
    confirmPassword: document.getElementById('account-confirm-password'),
    profileRealName: document.getElementById('profile-real-name'),
    profileCompany: document.getElementById('profile-company'),
    profileJobTitle: document.getElementById('profile-job-title'),
    profileEmail: document.getElementById('profile-email'),
    profileContact: document.getElementById('profile-contact'),
    profileUsagePurpose: document.getElementById('profile-usage-purpose'),
    profileFocusBrands: document.getElementById('profile-focus-brands'),
    profileFocusProductLines: document.getElementById('profile-focus-product-lines'),
    profileFocusChipDirections: document.getElementById('profile-focus-chip-directions'),
    modeList: document.getElementById('account-mode-list'),
    resourceCatalog: document.getElementById('account-resource-catalog'),
    resourceBody: document.getElementById('account-resource-body'),
    resourceList: document.getElementById('account-resource-list'),
    resourceToggle: document.getElementById('account-resource-toggle'),
    resourceSearch: document.getElementById('account-resource-search'),
    resourceFilters: Array.from(document.querySelectorAll('[data-resource-filter]')),
    resourceCountAll: document.getElementById('account-resource-count-all'),
    resourceCountChip: document.getElementById('account-resource-count-chip'),
    resourceCountDocument: document.getElementById('account-resource-count-document'),
    resourceCountScope: document.getElementById('account-resource-count-scope'),
    resourceCountOther: document.getElementById('account-resource-count-other'),
    policyList: document.getElementById('account-policy-list'),
    keyPolicyNote: document.getElementById('account-key-policy-note'),
    secretPanel: document.getElementById('account-secret-panel'),
    secretValue: document.getElementById('account-secret-value'),
    copySecret: document.getElementById('account-copy-secret'),
    clearSecret: document.getElementById('account-clear-secret'),
    keyForm: document.getElementById('account-key-form'),
    keyName: document.getElementById('account-key-name'),
    keyExpires: document.getElementById('account-key-expires'),
    createKey: document.getElementById('account-create-key'),
    keyError: document.getElementById('account-key-error'),
    keyList: document.getElementById('account-key-list'),
    creditsList: document.getElementById('account-credits-list'),
    creditsDetailBalance: document.getElementById('account-credits-detail-balance'),
    creditsDetailTotal: document.getElementById('account-credits-detail-total'),
    overviewSync: document.getElementById('account-overview-sync'),
    overviewModeCount: document.getElementById('account-overview-mode-count'),
    overviewModeList: document.getElementById('account-overview-mode-list'),
    overviewResourceSummary: document.getElementById('account-overview-resource-summary'),
    overviewPolicySummary: document.getElementById('account-overview-policy-summary'),
    overviewKeyPreview: document.getElementById('account-overview-key-preview'),
    overviewCreditBalance: document.getElementById('account-overview-credit-balance'),
    overviewCreditRecent: document.getElementById('account-overview-credit-recent'),
    viewTriggers: Array.from(document.querySelectorAll('[data-account-view]')),
    viewOpeners: Array.from(document.querySelectorAll('[data-account-open-view]')),
    viewPanels: Array.from(document.querySelectorAll('[data-account-view-panel]'))
  };

  function text(value, fallback = '-') {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    return String(value);
  }

  function i18n(key, params) {
    return window.AgentXI18n?.t?.(key, params || undefined, state.locale) || key;
  }

  function applyLocale(locale) {
    state.locale = window.AgentXI18n?.normalizeLocale?.(locale) || 'zh-CN';
    window.AgentXI18n?.applyLocale?.(state.locale);
    if (els.localeSelect) {
      els.localeSelect.value = state.locale;
    }
  }

  function setStatus(message, isError = false) {
    els.status.textContent = message;
    els.status.classList.toggle('error-line', isError);
  }

  function setResult(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle('error-line', isError);
  }

  // 统一通过 AgentXUI toast 发出反馈（组件不存在时静默降级）
  function notify(kind, title, detail) {
    if (window.AgentXUI && typeof window.AgentXUI.toast === 'function') {
      window.AgentXUI.toast({ kind, title, detail });
    }
  }

  async function readResponse(response) {
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {};
    }
    return response.json();
  }

  async function requestJson(path, options) {
    const response = await window.AgentXAuth.authFetch(path, options);
    const body = await readResponse(response);
    if (!response.ok) {
      throw new Error(body.error || i18n('common.requestFailed', { status: response.status }));
    }
    return body;
  }

  function splitList(value) {
    return String(value || '')
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function joinList(value) {
    return Array.isArray(value) ? value.join('\n') : '';
  }

  function dateToIsoEndOfDay(value) {
    if (!value) {
      return undefined;
    }
    return new Date(`${value}T23:59:59.000Z`).toISOString();
  }

  function fillProfile(profile = {}) {
    els.profileRealName.value = profile.realName || '';
    els.profileCompany.value = profile.company || '';
    els.profileJobTitle.value = profile.jobTitle || '';
    els.profileEmail.value = profile.email || '';
    els.profileContact.value = profile.contact || '';
    els.profileUsagePurpose.value = profile.usagePurpose || '';
    els.profileFocusBrands.value = joinList(profile.focusBrands);
    els.profileFocusProductLines.value = joinList(profile.focusProductLines);
    els.profileFocusChipDirections.value = joinList(profile.focusChipDirections);
  }

  function collectProfile() {
    return {
      realName: els.profileRealName.value,
      company: els.profileCompany.value,
      jobTitle: els.profileJobTitle.value,
      email: els.profileEmail.value,
      contact: els.profileContact.value,
      usagePurpose: els.profileUsagePurpose.value,
      focusBrands: splitList(els.profileFocusBrands.value),
      focusProductLines: splitList(els.profileFocusProductLines.value),
      focusChipDirections: splitList(els.profileFocusChipDirections.value)
    };
  }

  function clearChildren(element) {
    element.replaceChildren();
  }

  function renderPills(element, items, emptyText) {
    clearChildren(element);
    if (!items || items.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted-line';
      empty.textContent = emptyText;
      element.append(empty);
      return;
    }
    for (const item of items) {
      const pill = document.createElement('span');
      pill.className = 'account-pill';
      pill.textContent = item.label || item.id || String(item);
      if (item.id && item.label && item.id !== item.label) {
        pill.title = item.id;
      }
      element.append(pill);
    }
  }

  const RESOURCE_TYPES = {
    chip: { key: 'account.resources.chips', label: '芯片', order: 0 },
    document: { key: 'account.resources.documents', label: '文档', order: 1 },
    scopePreset: { label: 'Scope', order: 2 },
    other: { key: 'portal.common.other', label: '其他', order: 3 }
  };

  function resourceTypeLabel(group) {
    const type = RESOURCE_TYPES[group];
    return type.key ? i18n(type.key) : type.label;
  }

  function resourceGroup(type) {
    return RESOURCE_TYPES[type] ? type : 'other';
  }

  function resourceIdentity(resource) {
    const type = text(resource?.type, 'unknown');
    const id = text(resource?.id, text(resource?.label, 'unknown'));
    return `${type}:${id}`;
  }

  function normalizedResources(resources) {
    return (Array.isArray(resources) ? resources : [])
      .map((resource) => ({
        ...resource,
        type: text(resource?.type, 'unknown'),
        id: text(resource?.id, text(resource?.label, 'unknown')),
        label: text(resource?.label, text(resource?.id, i18n('account.dynamic.unnamedResource')))
      }))
      .sort((left, right) => {
        const typeOrder = RESOURCE_TYPES[resourceGroup(left.type)].order - RESOURCE_TYPES[resourceGroup(right.type)].order;
        return typeOrder || left.label.localeCompare(right.label, 'zh-CN', { numeric: true }) || resourceIdentity(left).localeCompare(resourceIdentity(right));
      });
  }

  function resourceCounts(resources) {
    const counts = { all: resources.length, chip: 0, document: 0, scopePreset: 0, other: 0 };
    for (const resource of resources) {
      counts[resourceGroup(resource.type)] += 1;
    }
    return counts;
  }

  function renderResourceItems(container, resources, emptyText) {
    clearChildren(container);
    if (resources.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted-line account-resource-empty';
      empty.textContent = emptyText;
      container.append(empty);
      return;
    }
    for (const resource of resources) {
      const item = document.createElement('article');
      item.className = 'account-resource-item';
      item.dataset.resourceIdentity = resourceIdentity(resource);

      const type = document.createElement('span');
      type.className = `account-resource-type account-resource-type-${resourceGroup(resource.type)}`;
      type.textContent = resourceGroup(resource.type) === 'other' ? resource.type : resourceTypeLabel(resourceGroup(resource.type));

      const copy = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = resource.label;
      const identity = document.createElement('code');
      identity.textContent = resourceIdentity(resource);
      copy.append(label, identity);
      item.append(type, copy);
      container.append(item);
    }
  }

  function renderResourceCatalog() {
    const resources = normalizedResources(state.account?.permissions?.resources || []);
    const counts = resourceCounts(resources);
    els.resourceCountAll.textContent = String(counts.all);
    els.resourceCountChip.textContent = String(counts.chip);
    els.resourceCountDocument.textContent = String(counts.document);
    els.resourceCountScope.textContent = String(counts.scopePreset);
    els.resourceCountOther.textContent = String(counts.other);

    for (const button of els.resourceFilters) {
      const active = button.dataset.resourceFilter === state.resourceFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    const query = state.resourceSearch.trim().toLocaleLowerCase();
    const filtered = resources.filter((resource) => {
      const groupMatches = state.resourceFilter === 'all' || resourceGroup(resource.type) === state.resourceFilter;
      const searchText = `${resource.label} ${resource.id} ${resource.type}`.toLocaleLowerCase();
      return groupMatches && (!query || searchText.includes(query));
    });

    clearChildren(els.resourceList);
    for (const group of ['chip', 'document', 'scopePreset', 'other']) {
      const groupItems = filtered.filter((resource) => resourceGroup(resource.type) === group);
      if (groupItems.length === 0) {
        continue;
      }
      const section = document.createElement('section');
      section.className = 'account-resource-group';
      section.dataset.resourceGroup = group;
      const heading = document.createElement('div');
      heading.className = 'account-resource-group-heading';
      const title = document.createElement('h4');
      title.textContent = resourceTypeLabel(group);
      const count = document.createElement('span');
      count.textContent = i18n('account.dynamic.items', { count: groupItems.length });
      heading.append(title, count);
      const list = document.createElement('div');
      list.className = 'account-resource-list';
      renderResourceItems(list, groupItems, '');
      section.append(heading, list);
      els.resourceList.append(section);
    }
    if (filtered.length === 0) {
      renderResourceItems(
        els.resourceList,
        [],
        i18n(resources.length === 0 ? 'account.dynamic.noResources' : 'account.dynamic.noMatchingResources')
      );
    }

    els.resourceBody.hidden = state.resourceCollapsed;
    els.resourceToggle.textContent = i18n(
      state.resourceCollapsed ? 'account.resources.expand' : 'account.resources.collapse'
    );
    els.resourceToggle.setAttribute('aria-expanded', String(!state.resourceCollapsed));
  }

  function showAccountResources() {
    state.resourceCollapsed = false;
    renderResourceCatalog();
    els.resourceCatalog.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    els.resourceCatalog.focus({ preventScroll: true });
  }

  function resourceSummary(resources) {
    const counts = resourceCounts(normalizedResources(resources));
    const parts = [];
    if (counts.chip) parts.push(i18n('account.dynamic.resourceSummary', { label: resourceTypeLabel('chip'), count: counts.chip }));
    if (counts.document) parts.push(i18n('account.dynamic.resourceSummary', { label: resourceTypeLabel('document'), count: counts.document }));
    if (counts.scopePreset) parts.push(`Scope ${counts.scopePreset}`);
    if (counts.other) parts.push(i18n('account.dynamic.resourceSummary', { label: resourceTypeLabel('other'), count: counts.other }));
    return parts.join(' · ') || i18n('account.dynamic.noEffectiveResources');
  }

  function renderKeyDifference(keyResources, accountResources) {
    const details = document.createElement('details');
    details.className = 'account-key-difference';
    const summary = document.createElement('summary');
    summary.textContent = i18n('account.dynamic.difference');
    const body = document.createElement('div');
    body.className = 'account-key-difference-grid';
    const keyIds = new Set(keyResources.map(resourceIdentity));
    const missing = accountResources.filter((resource) => !keyIds.has(resourceIdentity(resource)));
    for (const [titleText, items, emptyText] of [
      [i18n('account.dynamic.keyResources', { count: keyResources.length }), keyResources, i18n('account.dynamic.noKeyResources')],
      [i18n('account.dynamic.accountMissing', { count: missing.length }), missing, i18n('account.dynamic.noDifference')]
    ]) {
      const section = document.createElement('section');
      const title = document.createElement('h5');
      title.textContent = titleText;
      const list = document.createElement('div');
      list.className = 'account-key-difference-list';
      renderResourceItems(list, items, emptyText);
      section.append(title, list);
      body.append(section);
    }
    details.append(summary, body);
    return details;
  }

  function modeLabel(mode) {
    const key = mode?.id && `account.dynamic.mode.${mode.id}`;
    const localized = key && i18n(key);
    return (localized && localized !== key ? localized : '') || mode?.label || mode?.id || i18n('account.dynamic.mode.unknown');
  }

  function modeDescription(mode) {
    const key = mode?.id && `account.dynamic.mode.${mode.id}Body`;
    const localized = key && i18n(key);
    return (localized && localized !== key ? localized : '') || mode?.description || '';
  }

  function renderAvailableModes(modes = []) {
    clearChildren(els.modeList);
    const availableModes = modes.filter((mode) => mode?.available !== false && mode?.selectable !== false);
    if (availableModes.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted-line';
      empty.textContent = i18n('account.dynamic.noModes');
      els.modeList.append(empty);
      return;
    }

    for (const mode of availableModes) {
      const row = document.createElement('div');
      row.className = 'account-mode-row';
      const badge = document.createElement('span');
      badge.className = 'status-badge success';
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.setAttribute('aria-hidden', 'true');
      badge.append(tick, document.createTextNode(modeLabel(mode)));
      const description = document.createElement('span');
      description.textContent = modeDescription(mode);
      row.append(badge, description);
      els.modeList.append(row);
    }
  }

  function renderPolicy(policy = {}) {
    clearChildren(els.policyList);
    const rows = [
      [i18n('account.dynamic.policy.create'), i18n(policy.allowMcpKeySelfCreate ? 'account.dynamic.yes' : 'account.dynamic.no')],
      [i18n('account.dynamic.policy.regenerate'), i18n(policy.allowMcpKeyRegenerate ? 'account.dynamic.yes' : 'account.dynamic.no')],
      [i18n('account.dynamic.policy.max'), text(policy.maxMcpKeys, '0')],
      [i18n('account.dynamic.policy.ttl'), policy.defaultMcpKeyTtlDays
        ? i18n('account.dynamic.days', { count: policy.defaultMcpKeyTtlDays })
        : i18n('account.dynamic.notAvailable')]
    ];
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      els.policyList.append(dt, dd);
    }
  }

  function clearOneTimeSecret() {
    state.oneTimeSecret = null;
    els.secretValue.textContent = '';
    els.secretPanel.hidden = true;
  }

  function showOneTimeSecret(secret) {
    state.oneTimeSecret = secret;
    els.secretValue.textContent = secret;
    els.secretPanel.hidden = false;
  }

  function renderCredits() {
    clearChildren(els.creditsList);
    const ledger = state.credits?.ledger || state.account?.credits?.recentLedger;
    const items = ledger?.items || [];
    els.creditsDetailBalance.textContent = text(
      state.credits?.balanceUnits ?? state.account?.credits?.balanceUnits
    );
    els.creditsDetailTotal.textContent = String(ledger?.total ?? items.length);
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('account.dynamic.noCredits');
      els.creditsList.append(empty);
      return;
    }

    const scroller = document.createElement('div');
    scroller.className = 'account-ledger-scroll';
    const table = document.createElement('table');
    table.className = 'account-ledger-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of [
      i18n('account.dynamic.ledger.time'),
      i18n('account.dynamic.ledger.type'),
      i18n('account.dynamic.ledger.model'),
      i18n('account.dynamic.ledger.units'),
      i18n('account.dynamic.ledger.status')
    ]) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.append(th);
    }
    thead.append(headRow);
    const tbody = document.createElement('tbody');
    for (const item of items) {
      const row = document.createElement('tr');
      for (const value of [
        item.createdAt || '-',
        creditEntryLabel(item.entry),
        item.modelId || '-',
        String(item.units ?? 0)
      ]) {
        const td = document.createElement('td');
        td.textContent = value;
        row.append(td);
      }
      const statusCell = document.createElement('td');
      const badge = document.createElement('span');
      badge.className = 'ledger-status';
      badge.dataset.status = item.status || 'unknown';
      badge.textContent = creditStatusLabel(item.status);
      const reason = creditReasonLabel(item.reason, item.entry);
      if (reason) {
        badge.title = reason;
      }
      statusCell.append(badge);
      row.append(statusCell);
      tbody.append(row);
    }
    table.append(thead, tbody);
    scroller.append(table);
    els.creditsList.append(scroller);
  }

  function availableModes() {
    return (state.account?.permissions?.searchModes || [])
      .filter((mode) => mode?.available !== false && mode?.selectable !== false);
  }

  function isExpired(value) {
    if (!value) {
      return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  }

  function activeMcpKeys() {
    const user = state.account?.user || {};
    if ((user.status && user.status !== 'active') || isExpired(user.expiresAt)) {
      return [];
    }
    return (state.account?.mcpKeys || []).filter((key) => !isExpired(key.expiresAt));
  }

  function accountAvailability(user = {}) {
    if (isExpired(user.expiresAt)) {
      return { label: i18n('account.dynamic.expired'), tone: 'error' };
    }
    if (user.status === 'disabled') {
      return { label: i18n('account.dynamic.disabled'), tone: 'error' };
    }
    return { label: i18n('account.dynamic.healthy'), tone: 'success' };
  }

  function keyActivityTime(key) {
    for (const value of [key.lastUsed, key.createdAt]) {
      const timestamp = Date.parse(value || '');
      if (Number.isFinite(timestamp)) {
        return timestamp;
      }
    }
    return 0;
  }

  function localizedCreditValue(category, value, emptyFallbackKey, unknownFallbackKey = emptyFallbackKey) {
    if (!value) {
      return i18n(emptyFallbackKey);
    }
    const key = 'account.dynamic.credit.' + category + '.' + value;
    const localized = i18n(key);
    return localized === key ? i18n(unknownFallbackKey) : localized;
  }

  function creditEntryLabel(value) {
    return localizedCreditValue(
      'entry',
      value,
      'account.dynamic.credit.usage',
      'account.dynamic.credit.unknownEntry'
    );
  }

  function creditStatusLabel(value) {
    return localizedCreditValue('status', value, 'account.dynamic.credit.unknownStatus');
  }

  function creditReasonLabel(value, entry) {
    if (!value) {
      return '';
    }
    if (entry === 'admin') {
      return String(value);
    }
    const key = 'account.dynamic.credit.reason.' + value;
    const localized = i18n(key);
    return localized === key ? i18n('account.dynamic.credit.reason.other') : localized;
  }

  function keyExpiryLabel(key) {
    return key.expiresAt
      ? i18n('account.dynamic.key.expires', { date: key.expiresAt })
      : i18n('account.dynamic.key.noExpiry');
  }

  function keyLastUsedLabel(key) {
    return key.lastUsed
      ? i18n('account.dynamic.key.lastUsed', { date: key.lastUsed })
      : i18n('account.dynamic.key.neverUsed');
  }

  function renderOverviewKeys(keys) {
    clearChildren(els.overviewKeyPreview);
    const recentKeys = [...keys].sort((left, right) => keyActivityTime(right) - keyActivityTime(left)).slice(0, 3);
    if (recentKeys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('account.dynamic.noKeys');
      els.overviewKeyPreview.append(empty);
      return;
    }
    for (const key of recentKeys) {
      const row = document.createElement('div');
      row.className = 'account-key-preview-row';
      const name = document.createElement('strong');
      name.textContent = key.name || i18n('account.dynamic.unnamedKey');
      const masked = document.createElement('code');
      masked.textContent = key.maskedKey || key.fingerprint || key.id;
      const meta = document.createElement('span');
      meta.textContent = [
        keyExpiryLabel(key),
        keyLastUsedLabel(key)
      ].join(' · ');
      row.append(name, masked, meta);
      els.overviewKeyPreview.append(row);
    }
  }

  function renderOverviewCredits() {
    clearChildren(els.overviewCreditRecent);
    els.overviewCreditBalance.textContent = text(
      state.credits?.balanceUnits ?? state.account?.credits?.balanceUnits
    );
    const ledger = state.credits?.ledger || state.account?.credits?.recentLedger || { items: [], total: 0 };
    const latest = ledger.items?.[0];
    if (!latest) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('account.dynamic.noCreditUsage');
      els.overviewCreditRecent.append(empty);
      return;
    }
    const summary = document.createElement('strong');
    summary.textContent = [
      creditEntryLabel(latest.entry),
      i18n('account.dynamic.credit.units', { count: latest.units ?? 0 }),
      creditStatusLabel(latest.status)
    ].join(' · ');
    const meta = document.createElement('span');
    meta.textContent = `${latest.createdAt || '-'} · ${i18n('account.dynamic.recordCount', { count: ledger.total ?? ledger.items.length })}`;
    els.overviewCreditRecent.append(summary, meta);
  }

  function renderOverview() {
    const account = state.account || {};
    const permissions = account.permissions || {};
    const modes = availableModes();
    const keys = activeMcpKeys();
    els.overviewModeCount.textContent = String(modes.length);
    renderPills(
      els.overviewModeList,
      modes.map((mode) => ({ id: mode.id, label: modeLabel(mode) })),
      i18n('account.dynamic.noModes')
    );
    const resourceCount = (permissions.resources || []).length;
    els.overviewResourceSummary.textContent = resourceCount
      ? i18n('account.dynamic.availableResources', { count: resourceCount })
      : i18n('account.dynamic.noResources');
    const policy = permissions.mcpKeyPolicy || {};
    renderPills(els.overviewPolicySummary, [
      {
        label: i18n('account.dynamic.keyCreate', {
          value: i18n(policy.allowMcpKeySelfCreate ? 'account.dynamic.open' : 'account.dynamic.closed')
        })
      },
      {
        label: i18n('account.dynamic.regenerate', {
          value: i18n(policy.allowMcpKeyRegenerate ? 'account.dynamic.open' : 'account.dynamic.closed')
        })
      },
      {
        label: i18n('account.dynamic.defaultTtl', {
          value: policy.defaultMcpKeyTtlDays
            ? i18n('account.dynamic.days', { count: policy.defaultMcpKeyTtlDays })
            : i18n('account.dynamic.notAvailable')
        })
      }
    ], i18n('account.dynamic.noPolicy'));
    renderOverviewKeys(keys);
    renderOverviewCredits();
    els.overviewSync.textContent = i18n('account.synced');
    els.overviewSync.classList.remove('error');
  }

  function renderKeys() {
    const keys = state.account?.mcpKeys || [];
    const policy = state.account?.permissions?.mcpKeyPolicy || {};
    const accountResources = normalizedResources(state.account?.permissions?.resources || []);
    const createDisabled = !policy.allowMcpKeySelfCreate || keys.length >= (policy.maxMcpKeys || 0);
    els.createKey.disabled = createDisabled;
    els.keyPolicyNote.textContent = !policy.allowMcpKeySelfCreate
      ? i18n('account.dynamic.selfCreateDisabled')
      : keys.length >= (policy.maxMcpKeys || 0)
        ? i18n('account.dynamic.keyLimit')
        : i18n('account.dynamic.keyCapacity', { count: policy.maxMcpKeys || 0 });

    clearChildren(els.keyList);
    if (keys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('account.dynamic.noKeys');
      els.keyList.append(empty);
      return;
    }

    for (const key of keys) {
      const row = document.createElement('article');
      row.className = 'account-key-row';
      row.dataset.keyId = key.id;

      const main = document.createElement('div');
      main.className = 'account-key-main';

      const info = document.createElement('div');
      info.className = 'account-key-info';
      const name = document.createElement('strong');
      name.textContent = key.name;
      const masked = document.createElement('code');
      masked.textContent = key.maskedKey || key.fingerprint || key.id;
      const meta = document.createElement('span');
      meta.textContent = [
        i18n('account.dynamic.key.fingerprint', { value: key.fingerprint || '-' }),
        keyExpiryLabel(key),
        keyLastUsedLabel(key)
      ].join(' · ');
      info.append(name, masked, meta);

      const actions = document.createElement('div');
      actions.className = 'account-key-actions';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.dataset.action = 'rename';
      rename.dataset.keyId = key.id;
      rename.textContent = i18n('account.dynamic.rename');
      const copyMasked = document.createElement('button');
      copyMasked.type = 'button';
      copyMasked.dataset.action = 'copy-masked';
      copyMasked.dataset.keyId = key.id;
      copyMasked.textContent = i18n('account.dynamic.copySummary');
      const regenerate = document.createElement('button');
      regenerate.type = 'button';
      regenerate.dataset.action = 'regenerate';
      regenerate.dataset.keyId = key.id;
      regenerate.textContent = i18n('account.dynamic.regenerateAction');
      regenerate.disabled = !policy.allowMcpKeyRegenerate;
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'danger-button';
      revoke.dataset.action = 'revoke';
      revoke.dataset.keyId = key.id;
      revoke.textContent = i18n('account.dynamic.revoke');
      actions.append(rename, copyMasked, regenerate, revoke);

      main.append(info, actions);

      const keyResources = normalizedResources(key.resources || key.authorizedResources || []);
      const hasExplicitGrants = key.resourceGrants !== undefined;
      const scope = document.createElement('section');
      scope.className = `account-key-scope ${hasExplicitGrants ? 'restricted' : 'inherited'}`;
      const scopeSummary = document.createElement('div');
      scopeSummary.className = 'account-key-scope-summary';
      const ratio = document.createElement('strong');
      ratio.className = 'account-key-scope-ratio';
      ratio.textContent = `${keyResources.length}/${accountResources.length}`;
      const scopeCopy = document.createElement('div');
      const scopeTitle = document.createElement('strong');
      scopeTitle.textContent = !hasExplicitGrants
        ? i18n('account.dynamic.inheritedTitle')
        : keyResources.length === 0
          ? i18n('account.dynamic.emptyScope')
          : i18n('account.dynamic.restrictedTitle');
      const scopeMeta = document.createElement('span');
      scopeMeta.textContent = `${resourceSummary(keyResources)}. ${i18n(
        hasExplicitGrants ? 'account.dynamic.restrictedMeta' : 'account.dynamic.inheritedMeta'
      )}`;
      scopeCopy.append(scopeTitle, scopeMeta);
      scopeSummary.append(ratio, scopeCopy);

      const scopeActions = document.createElement('div');
      scopeActions.className = 'account-key-scope-actions';
      const relation = document.createElement('span');
      relation.className = 'account-key-relation';
      relation.textContent = i18n(hasExplicitGrants ? 'account.dynamic.restricted' : 'account.dynamic.same');
      const viewResources = document.createElement('button');
      viewResources.type = 'button';
      viewResources.className = 'secondary-button';
      viewResources.dataset.viewAccountResources = 'true';
      viewResources.textContent = i18n('account.dynamic.viewResources');
      scopeActions.append(relation, viewResources);
      scope.append(scopeSummary, scopeActions);
      if (hasExplicitGrants) {
        scope.append(renderKeyDifference(keyResources, accountResources));
      }

      row.append(main, scope);
      els.keyList.append(row);
    }
  }

  function renderLocalizedAccount() {
    const account = state.account;
    if (!account) {
      return;
    }

    const user = account.user || {};
    const permissions = account.permissions || {};
    const availability = accountAvailability(user);
    els.accountAvailability.textContent = availability.label;
    els.accountAvailability.className = 'status-badge ' + availability.tone;
    els.accountAvailability.title = user.expiresAt
      ? i18n('account.dynamic.expiryTitle', { date: user.expiresAt })
      : '';
    renderAvailableModes(permissions.searchModes || []);
    renderResourceCatalog();
    renderPolicy(permissions.mcpKeyPolicy || {});
    renderKeys();
    renderCredits();
    renderOverview();
  }

  function renderAccount() {
    const account = state.account;
    if (!account) {
      return;
    }

    const currentUser = window.AgentXAuth.getUser();
    const user = account.user || {};
    const permissions = account.permissions || {};
    els.userStatus.textContent = currentUser
      ? currentUser.username + ' · ' + currentUser.role
      : user.username + ' · ' + user.role;
    els.username.textContent = text(user.username);
    els.role.textContent = text(permissions.role || user.role);
    els.creditBalance.textContent = text(state.credits?.balanceUnits ?? account.credits?.balanceUnits);
    els.keyCount.textContent = String(activeMcpKeys().length);

    fillProfile(user.profile || {});
    window.AgentXI18n?.adoptAccountUser?.(user);
    applyLocale(user.localePreference || user.preferredLanguage || state.locale);
    renderLocalizedAccount();
  }

  async function loadAccount(options = {}) {
    const requestId = ++state.accountLoadRequestId;
    if (!options.keepSecret) {
      clearOneTimeSecret();
    }
    els.overviewSync.textContent = i18n('account.syncing');
    els.overviewSync.classList.remove('error');
    setStatus(i18n('account.dynamic.loading'));
    try {
      const [account, credits] = await Promise.all([
        requestJson('/api/account'),
        requestJson('/api/account/credits?limit=20')
      ]);
      if (requestId !== state.accountLoadRequestId) {
        return false;
      }
      state.account = account;
      state.credits = credits;
      renderAccount();
      setStatus(i18n('account.dynamic.loaded'));
      return true;
    } catch (error) {
      if (requestId !== state.accountLoadRequestId) {
        return false;
      }
      els.overviewSync.textContent = i18n('account.dynamic.syncFailed');
      els.overviewSync.classList.add('error');
      setStatus(error.message || i18n('account.dynamic.loadFailed'), true);
      notify('error', i18n('account.dynamic.loadFailed'), error.message || '');
      return false;
    }
  }

  async function copyText(value) {
    if (!value) {
      return;
    }
    await navigator.clipboard?.writeText(value);
  }

  async function handleProfileSubmit(event) {
    event.preventDefault();
    setResult(els.profileResult, i18n('account.dynamic.saving'));
    try {
      await requestJson('/api/account/profile', {
        method: 'PUT',
        body: JSON.stringify({ profile: collectProfile() })
      });
      setResult(els.profileResult, '');
      await loadAccount({ keepSecret: true });
      notify('success', i18n('account.dynamic.profileSaved'));
    } catch (error) {
      setResult(els.profileResult, error.message || i18n('account.dynamic.saveFailed'), true);
      notify('error', i18n('account.dynamic.saveFailed'), error.message || '');
    }
  }

  async function handlePasswordSubmit(event) {
    event.preventDefault();
    const currentPassword = els.currentPassword.value;
    const newPassword = els.newPassword.value;
    const confirmPassword = els.confirmPassword.value;
    if (newPassword !== confirmPassword) {
      setResult(els.passwordResult, i18n('account.dynamic.passwordMismatch'), true);
      return;
    }
    setResult(els.passwordResult, i18n('account.dynamic.changing'));
    try {
      await requestJson('/api/account/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword })
      });
      els.passwordForm.reset();
      setResult(els.passwordResult, '');
      notify('success', i18n('account.dynamic.passwordChanged'));
    } catch (error) {
      setResult(els.passwordResult, error.message || i18n('account.dynamic.changeFailed'), true);
      notify('error', i18n('account.dynamic.changeFailed'), error.message || '');
    }
  }

  async function handleKeyCreate(event) {
    event.preventDefault();
    els.keyError.textContent = '';
    try {
      const created = await requestJson('/api/account/mcp-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: els.keyName.value,
          expiresAt: dateToIsoEndOfDay(els.keyExpires.value)
        })
      });
      els.keyForm.reset();
      showOneTimeSecret(created.secret);
      await loadAccount({ keepSecret: true });
      notify('success', i18n('account.dynamic.keyCreated'), i18n('account.dynamic.copySecretNow'));
    } catch (error) {
      els.keyError.textContent = error.message || i18n('account.dynamic.createFailed');
      notify('error', i18n('account.dynamic.createFailed'), error.message || '');
    }
  }

  async function handleKeyAction(event) {
    const resourceButton = event.target.closest('button[data-view-account-resources]');
    if (resourceButton) {
      showAccountResources();
      return;
    }
    const button = event.target.closest('button[data-action]');
    if (!button) {
      return;
    }
    const keyId = button.dataset.keyId;
    const key = (state.account?.mcpKeys || []).find((candidate) => candidate.id === keyId);
    if (!key) {
      return;
    }
    els.keyError.textContent = '';
    try {
      if (button.dataset.action === 'copy-masked') {
        await copyText(key.maskedKey || key.fingerprint);
        notify('success', i18n('account.dynamic.copied'), i18n('account.dynamic.summaryCopied'));
        return;
      }
      if (button.dataset.action === 'rename') {
        const nextName = await window.AgentXUI.prompt({
          title: i18n('account.dynamic.renameKeyTitle'),
          label: i18n('account.key.name'),
          value: key.name
        });
        if (!nextName) {
          return;
        }
        await requestJson(`/api/account/mcp-keys/${encodeURIComponent(key.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: nextName })
        });
        await loadAccount({ keepSecret: true });
        notify('success', i18n('account.dynamic.keyRenamed'), nextName);
        return;
      }
      if (button.dataset.action === 'regenerate') {
        const okRegen = await window.AgentXUI.confirm({
          title: i18n('account.dynamic.regenerateTitle'),
          body: i18n('account.dynamic.regenerateBody'),
          confirmText: i18n('account.dynamic.regenerateAction')
        });
        if (!okRegen) {
          return;
        }
        const regenerated = await requestJson(`/api/account/mcp-keys/${encodeURIComponent(key.id)}/regenerate`, {
          method: 'POST'
        });
        showOneTimeSecret(regenerated.secret);
        await loadAccount({ keepSecret: true });
        notify('success', i18n('account.dynamic.keyRegenerated'), i18n('account.dynamic.copyNewSecret'));
        return;
      }
      if (button.dataset.action === 'revoke') {
        const okRevoke = await window.AgentXUI.confirm({
          title: i18n('account.dynamic.revokeTitle'),
          body: i18n('account.dynamic.revokeBody', { name: key.name }),
          confirmText: i18n('account.dynamic.revoke'),
          danger: true
        });
        if (!okRevoke) {
          return;
        }
        const response = await window.AgentXAuth.authFetch(`/api/account/mcp-keys/${encodeURIComponent(key.id)}`, {
          method: 'DELETE'
        });
        if (!response.ok) {
          const body = await readResponse(response);
          throw new Error(body.error || i18n('common.requestFailed', { status: response.status }));
        }
        clearOneTimeSecret();
        await loadAccount();
        notify('success', i18n('account.dynamic.keyRevoked'), key.name);
      }
    } catch (error) {
      els.keyError.textContent = error.message || i18n('account.dynamic.operationFailed');
      notify('error', i18n('account.dynamic.operationFailed'), error.message || '');
    }
  }

  async function updateLocale(locale) {
    setResult(els.localeResult, i18n('common.loading'));
    try {
      await window.AgentXI18n.setLocale(locale, { source: 'account-select' });
      const cachedUser = window.AgentXAuth.getUser();
      if (cachedUser && state.account) state.account = { ...state.account, user: cachedUser };
      applyLocale(window.AgentXI18n.getLocale());
      if (state.account) renderLocalizedAccount();
      setResult(els.localeResult, i18n('account.locale.saved'));
      notify('success', i18n('account.locale.saved'));
    } catch (error) {
      applyLocale(window.AgentXI18n?.getLocale?.() || state.locale);
      setResult(els.localeResult, error.message || i18n('account.locale.failed'), true);
      notify('error', i18n('account.locale.failed'), error.message || '');
    }
  }

  const ACCOUNT_VIEWS = new Set(['overview', 'access', 'credits', 'profile', 'security', 'preferences']);

  function normalizeAccountView(value) {
    const normalized = String(value || '').replace(/^#/, '');
    return ACCOUNT_VIEWS.has(normalized) ? normalized : 'overview';
  }

  function setAccountView(view, options = {}) {
    const next = normalizeAccountView(view);
    const { syncHash = true, replaceHash = false, focus = false } = options;
    state.activeView = next;
    for (const panel of els.viewPanels) {
      panel.hidden = panel.dataset.accountViewPanel !== next;
    }
    for (const trigger of els.viewTriggers) {
      const active = trigger.dataset.accountView === next;
      trigger.classList.toggle('active', active);
      trigger.setAttribute('aria-selected', String(active));
    }
    const targetHash = `#${next}`;
    if (syncHash && window.location.hash !== targetHash) {
      const method = replaceHash ? 'replaceState' : 'pushState';
      window.history[method](null, '', targetHash);
    }
    if (focus) {
      const heading = els.viewPanels
        .find((panel) => panel.dataset.accountViewPanel === next)
        ?.querySelector('h2[tabindex="-1"]');
      heading?.focus();
    }
  }

  function initAccountViews() {
    const requested = normalizeAccountView(window.location.hash);
    setAccountView(requested, {
      syncHash: true,
      replaceHash: window.location.hash !== `#${requested}`,
      focus: false
    });
    for (const trigger of els.viewTriggers) {
      trigger.addEventListener('click', () => setAccountView(trigger.dataset.accountView, { focus: true }));
    }
    for (const opener of els.viewOpeners) {
      opener.addEventListener('click', () => setAccountView(opener.dataset.accountOpenView, { focus: true }));
    }
    window.addEventListener('hashchange', () => {
      const next = normalizeAccountView(window.location.hash);
      setAccountView(next, {
        syncHash: window.location.hash !== `#${next}`,
        replaceHash: true,
        focus: true
      });
    });
  }

  initAccountViews();

  els.refresh.addEventListener('click', () => loadAccount());
  els.localeSelect?.addEventListener('change', () => updateLocale(els.localeSelect.value));
  window.addEventListener('localechange', (event) => {
    state.locale = event.detail?.locale || window.AgentXI18n?.getLocale?.() || state.locale;
    if (els.localeSelect) els.localeSelect.value = state.locale;
    renderLocalizedAccount();
  });
  els.profileForm.addEventListener('submit', handleProfileSubmit);
  els.passwordForm.addEventListener('submit', handlePasswordSubmit);
  els.keyForm.addEventListener('submit', handleKeyCreate);
  els.keyList.addEventListener('click', handleKeyAction);
  els.resourceToggle.addEventListener('click', () => {
    state.resourceCollapsed = !state.resourceCollapsed;
    renderResourceCatalog();
  });
  els.resourceSearch.addEventListener('input', () => {
    state.resourceSearch = els.resourceSearch.value;
    renderResourceCatalog();
  });
  for (const filter of els.resourceFilters) {
    filter.addEventListener('click', () => {
      state.resourceFilter = filter.dataset.resourceFilter;
      renderResourceCatalog();
    });
  }
  els.copySecret.addEventListener('click', () => copyText(state.oneTimeSecret).then(() =>
    notify('success', i18n('account.dynamic.copied'), i18n('account.dynamic.secretCopied'))
  ));
  els.clearSecret.addEventListener('click', clearOneTimeSecret);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => loadAccount());
  } else {
    loadAccount();
  }
})();
