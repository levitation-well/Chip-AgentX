(function () {
  const SAFE_KEY_PLACEHOLDER = 'AGENTX_MCP_KEY';
  const state = {
    payload: null,
    selectedTemplate: 'opencode',
    locale: window.AgentXI18n?.getLocale?.() || 'zh-CN'
  };

  const els = {
    userStatus: document.getElementById('mcp-access-user-status'),
    login: document.getElementById('mcp-access-login'),
    refresh: document.getElementById('mcp-access-refresh'),
    status: document.getElementById('mcp-access-status'),
    publicNote: document.getElementById('mcp-access-public-note'),
    onboardingHint: document.getElementById('mcp-access-onboarding-hint'),
    completeStep: document.getElementById('mcp-access-complete-step'),
    remoteUrl: document.getElementById('mcp-access-remote-url'),
    verifyUrl: document.getElementById('mcp-access-verify-url'),
    keyList: document.getElementById('mcp-access-key-list'),
    modelList: document.getElementById('mcp-access-model-list'),
    resourceList: document.getElementById('mcp-access-resource-list'),
    policyList: document.getElementById('mcp-access-policy-list'),
    templateMeta: document.getElementById('mcp-access-template-meta'),
    templateCode: document.getElementById('mcp-access-template-code'),
    templateDownload: document.getElementById('mcp-access-template-download'),
    copyTemplate: document.getElementById('mcp-access-copy-template'),
    copySummary: document.getElementById('mcp-access-copy-summary'),
    tabs: document.querySelector('.mcp-access-template-tabs'),
    downloads: document.getElementById('mcp-access-downloads')
  };

  function setStatus(message, isError) {
    els.status.textContent = message || '';
    els.status.classList.toggle('error-line', Boolean(isError));
  }

  function text(value, fallback = '-') {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    return String(value);
  }

  function i18n(key, params) {
    const fallback = {
      'mcp.public.status': '公共接入说明',
      'mcp.public.note': '未登录用户只能查看公共接入信息、模板下载入口和安全提示。登录后显示当前账号自己的 key 摘要、授权模型和资源摘要。',
      'mcp.private.note': '当前视图只展示本账号可用 key 的 masked/fingerprint、授权模型和资源摘要。',
      'account.onboarding.updated': '上手进度已更新',
      'account.onboarding.failed': '上手进度更新失败'
    };
    return window.AgentXI18n?.t?.(key, params || undefined, state.locale) || fallback[key] || key;
  }

  function applyLocale(locale) {
    state.locale = window.AgentXI18n?.normalizeLocale?.(locale || state.locale) || 'zh-CN';
    window.AgentXI18n?.applyLocale?.(state.locale);
  }

  function clearChildren(element) {
    if (!element) {
      return;
    }
    element.replaceChildren();
  }

  function currentUser() {
    return window.AgentXAuth?.getUser?.() || null;
  }

  async function readJson(response) {
    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {};
    }
    return response.json();
  }

  async function fetchAccessCenter() {
    if (window.AgentXAuth?.getToken?.()) {
      const response = await window.AgentXAuth.authFetch('/api/mcp/access-center', { skipAuthRedirect: true });
      const body = await readJson(response);
      if (!response.ok) {
        throw new Error(body.error || i18n('common.requestFailed', { status: response.status }));
      }
      return body;
    }
    const response = await fetch('/api/mcp/access-center');
    const body = await readJson(response);
    if (!response.ok) {
      throw new Error(body.error || i18n('common.requestFailed', { status: response.status }));
    }
    return body;
  }

  async function updateOnboardingStep(step) {
    if (!window.AgentXAuth?.getToken?.()) {
      return;
    }
    const current = state.payload?.user?.onboarding || {};
    const completed = new Set(current.completedSteps || []);
    completed.add(step);
    const response = await window.AgentXAuth.authFetch('/api/account/onboarding', {
      method: 'PUT',
      body: JSON.stringify({
        status: 'in_progress',
        completedSteps: Array.from(completed)
      }),
      skipAuthRedirect: true
    });
    if (!response.ok) {
      const body = await readJson(response);
      throw new Error(body.error || i18n('common.requestFailed', { status: response.status }));
    }
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
      if (item.id) {
        pill.title = item.id;
      }
      element.append(pill);
    }
  }

  function renderPolicy(policy) {
    clearChildren(els.policyList);
    if (!policy) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = i18n('mcp.dynamic.loginState');
      dd.textContent = i18n('mcp.dynamic.loginVisible');
      els.policyList.append(dt, dd);
      return;
    }
    const rows = [
      [i18n('mcp.dynamic.policyCreate'), policy.allowMcpKeySelfCreate ? i18n('mcp.dynamic.yes') : i18n('mcp.dynamic.no')],
      [i18n('mcp.dynamic.policyRegenerate'), policy.allowMcpKeyRegenerate ? i18n('mcp.dynamic.yes') : i18n('mcp.dynamic.no')],
      [i18n('mcp.dynamic.policyMaxKeys'), window.AgentXI18n?.formatNumber?.(policy.maxMcpKeys || 0, {}, state.locale) || text(policy.maxMcpKeys, '0')],
      [
        i18n('mcp.dynamic.policyDefaultExpiry'),
        policy.defaultMcpKeyTtlDays
          ? i18n('mcp.dynamic.days', { count: window.AgentXI18n?.formatNumber?.(policy.defaultMcpKeyTtlDays, {}, state.locale) || policy.defaultMcpKeyTtlDays })
          : i18n('mcp.dynamic.notAvailable')
      ]
    ];
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      els.policyList.append(dt, dd);
    }
  }

  function renderKeys(keys) {
    clearChildren(els.keyList);
    if (!state.payload?.auth?.authenticated) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('mcp.dynamic.notLoggedIn');
      els.keyList.append(empty);
      return;
    }
    if (!keys || keys.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('mcp.dynamic.noKey');
      els.keyList.append(empty);
      return;
    }
    for (const key of keys) {
      const row = document.createElement('article');
      row.className = `mcp-access-key-row ${key.usable ? 'usable' : 'unavailable'}`;
      row.dataset.keyId = key.keyId;

      const head = document.createElement('div');
      head.className = 'mcp-access-key-head';
      const title = document.createElement('strong');
      title.textContent = key.name || key.keyId;
      const badge = document.createElement('span');
      badge.className = 'meta-pill';
      badge.textContent = key.usable ? 'usable' : text(key.unavailableReason, 'unavailable');
      head.append(title, badge);

      const code = document.createElement('code');
      code.textContent = key.maskedKey || key.fingerprint || key.keyId;

      const meta = document.createElement('small');
      meta.textContent = [
        `keyId ${key.keyId}`,
        `fingerprint ${text(key.fingerprint)}`,
        key.expiresAt
          ? i18n('mcp.dynamic.expires', { value: window.AgentXI18n?.formatDate?.(key.expiresAt, {}, state.locale) || key.expiresAt })
          : i18n('mcp.dynamic.noExpiry'),
        key.lastUsedAt
          ? i18n('mcp.dynamic.lastUsed', { value: window.AgentXI18n?.formatDate?.(key.lastUsedAt, {}, state.locale) || key.lastUsedAt })
          : i18n('mcp.dynamic.neverUsed')
      ].join(' / ');

      const models = document.createElement('div');
      models.className = 'account-pill-list';
      renderPills(models, key.allowedModels || [], i18n('mcp.dynamic.noSeparateModels'));

      row.append(head, code, meta, models);
      els.keyList.append(row);
    }
  }

  function findTemplate(id) {
    return (state.payload?.templates || []).find((template) => template.id === id) || null;
  }

  function selectedEndpoint() {
    return state.payload?.server?.remoteHttpUrl || `${window.location.origin}/mcp`;
  }

  function selectedKeySummary() {
    return state.payload?.availableKeys?.[0] || state.payload?.keySummaries?.[0] || null;
  }

  function templateText(id) {
    const endpoint = selectedEndpoint();
    if (id === 'codex') {
      return [
        'codex mcp add agentx-remote \\',
        `  --url ${endpoint} \\`,
        `  --bearer-token-env-var ${SAFE_KEY_PLACEHOLDER}`,
        '',
        '# 先运行 agentx_whoami({})，再使用返回的 permissions.resources[].id。'
      ].join('\n');
    }
    if (id === 'claude-code') {
      return [
        'claude mcp add --transport http agentx-remote \\',
        `  ${endpoint} \\`,
        `  --header "Authorization: Bearer $${SAFE_KEY_PLACEHOLDER}"`,
        '',
        '# 完整 key 只放在客户本机私有配置或密钥库。'
      ].join('\n');
    }
    return JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          'agentx-remote': {
            type: 'remote',
            url: endpoint,
            enabled: true,
            oauth: false,
            headers: {
              Authorization: `Bearer {env:${SAFE_KEY_PLACEHOLDER}}`
            }
          }
        }
      },
      null,
      2
    );
  }

  function renderTemplate() {
    const id = state.selectedTemplate;
    const template = findTemplate(id);
    els.templateCode.textContent = templateText(id);
    els.templateDownload.href = template?.downloadUrl || `/mcp-templates/${id}.md`;
    els.templateMeta.textContent = template ? `${template.label} / ${template.contentType}` : i18n('mcp.dynamic.templatePlaceholder');
    for (const button of els.tabs.querySelectorAll('button[data-template]')) {
      const selected = button.dataset.template === id;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.classList.toggle('active', selected);
    }
  }

  function renderDownloads(downloads) {
    clearChildren(els.downloads);
    for (const item of downloads || []) {
      const link = document.createElement('a');
      link.className = 'text-link';
      link.href = item.downloadUrl;
      link.textContent = `${item.label} (${item.contentType})`;
      els.downloads.append(link);
    }
  }

  function safeSummaryText() {
    const payload = state.payload || {};
    const key = selectedKeySummary();
    const models = (payload.permissions?.allowedModels || []).map((model) => model.id).join(', ') || 'login-required';
    const resources = (payload.permissions?.resources || []).map((resource) => resource.id).join(', ') || 'login-required';
    return [
      'AgentX MCP Access Summary',
      `endpoint=${payload.server?.remoteHttpUrl || '-'}`,
      `authMode=${payload.server?.authMode || 'bearer-mcp-key'}`,
      `keyId=${key?.keyId || '<CREATE_KEY_IN_ACCOUNT>'}`,
      `fingerprint=${key?.fingerprint || '<FINGERPRINT_AFTER_CREATE>'}`,
      `maskedKey=${key?.maskedKey || '<MASKED_KEY_ONLY>'}`,
      `models=${models}`,
      `resources=${resources}`,
      'secret=<never copy full key from access center>'
    ].join('\n');
  }

  async function copyText(value) {
    if (!value) {
      return;
    }
    await navigator.clipboard?.writeText(value);
    setStatus(i18n('mcp.dynamic.copied'));
  }

  function renderAll() {
    const payload = state.payload || {};
    const user = payload.user;
    const browserUser = currentUser();
    const authenticated = Boolean(payload.auth?.authenticated);
    applyLocale(user?.localePreference || user?.preferredLanguage || state.locale);

    els.userStatus.textContent = authenticated && user ? `${user.username} / ${user.role}` : i18n('mcp.public.status');
    els.login.hidden = authenticated;
    if (!authenticated) {
      els.userStatus.textContent = i18n('mcp.public.status');
    }
    if (els.completeStep) {
      els.completeStep.hidden = !authenticated;
    }
    els.publicNote.textContent = authenticated ? i18n('mcp.private.note') : i18n('mcp.public.note');
    els.remoteUrl.textContent = payload.server?.remoteHttpUrl || '-';
    els.verifyUrl.textContent = payload.server?.verifyUrl || '-';
    renderKeys(payload.keySummaries || []);
    renderPills(
      els.modelList,
      payload.permissions?.allowedModels || [],
      authenticated ? i18n('mcp.dynamic.noModels') : i18n('mcp.dynamic.loginVisible')
    );
    renderPills(
      els.resourceList,
      payload.permissions?.resources || [],
      authenticated ? i18n('mcp.dynamic.noResources') : i18n('mcp.dynamic.loginVisible')
    );
    renderPolicy(payload.permissions?.mcpKeyPolicy);
    renderTemplate();
    renderDownloads(payload.downloads);
  }

  async function loadAccessCenter() {
    setStatus(i18n('mcp.dynamic.loading'));
    try {
      state.payload = await fetchAccessCenter();
      renderAll();
      setStatus(state.payload.auth?.authenticated ? i18n('mcp.dynamic.synced') : i18n('mcp.dynamic.publicLoaded'));
    } catch (error) {
      setStatus(error.message || i18n('mcp.dynamic.failed'), true);
      renderAll();
    }
  }

  els.login.addEventListener('click', () => window.location.assign('/login?next=/mcp-access'));
  els.refresh.addEventListener('click', loadAccessCenter);
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-copy-url]');
    if (!button) {
      return;
    }
    const value = button.dataset.copyUrl === 'verify' ? els.verifyUrl.textContent : els.remoteUrl.textContent;
    copyText(value);
  });
  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-template]');
    if (!button || button.disabled) {
      return;
    }
    state.selectedTemplate = button.dataset.template;
    renderTemplate();
  });
  els.copyTemplate.addEventListener('click', () => copyText(templateText(state.selectedTemplate)));
  els.copySummary.addEventListener('click', () => copyText(safeSummaryText()));
  els.completeStep?.addEventListener('click', () => {
    updateOnboardingStep('mcp_access')
      .then(() => setStatus(i18n('account.onboarding.updated')))
      .catch((error) => setStatus(error.message || i18n('account.onboarding.failed'), true));
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAccessCenter);
  } else {
    loadAccessCenter();
  }
})();
