(function () {
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) { window.location.reload(); }
  });

  const apiBase = window.location.origin.replace(/\/$/, '');
  const authTokenKey = 'agentx.auth.token';
  const authUserKey = 'agentx.auth.user';
  const defaultVersion = {
    version: '',
    edition: 'internal',
    landingMode: 'disabled',
    branding: {
      enabled: true,
      productName: 'AgentX',
      signature: 'Powered by AgentX',
      tooltip: 'AgentX',
      homepageUrl: '/home'
    },
    fingerprint: { enabled: false, level: 'off', signed: false },
    donation: { enabled: false }
  };

  const PORTAL_NAV_LINKS = [
    { href: '/home', key: 'portal.nav.home', label: '首页' },
    { href: '/chat', key: 'portal.nav.chat', label: '对话' },
    { href: '/mcp-access', key: 'portal.nav.mcp', label: 'MCP' },
    { href: '/tickets', key: 'portal.nav.tickets', label: '工单' },
    { href: '/feedback', key: 'portal.nav.feedback', label: '反馈' },
    { href: '/datasheet-submit', key: 'portal.nav.materials', label: '资料' },
    { href: '/updates', key: 'portal.nav.updates', label: '新闻' },
    { href: '/join-application', key: 'portal.nav.join', label: '加入申请' }
  ];

  function i18n(key, fallback) {
    const value = window.AgentXI18n?.t?.(key);
    return value && value !== key ? value : fallback;
  }

  function normalizePath(pathname) {
    if (typeof pathname !== 'string' || !pathname) {
      return '/home';
    }
    const trimmed = pathname.replace(/\/+$/, '');
    if (trimmed === '' || trimmed === '/index.html') {
      return '/home';
    }
    return trimmed;
  }

  function renderPortalNav(root) {
    const doc = root.ownerDocument || root;
    const view = doc.defaultView || window;
    const current = normalizePath(view && view.location ? view.location.pathname : '');
    for (const slot of root.querySelectorAll('[data-portal-nav]')) {
      slot.replaceChildren();
      for (const item of PORTAL_NAV_LINKS) {
        const link = doc.createElement('a');
        link.className = 'portal-nav-link';
        link.href = item.href;
        link.textContent = i18n(item.key, item.label);
        if (normalizePath(item.href) === current) {
          link.classList.add('active');
          link.setAttribute('aria-current', 'page');
        }
        slot.append(link);
      }
    }
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return '';
    }
    const text = value.trim();
    if (/[\r\n]/.test(text)) {
      return '';
    }
    if (text.startsWith('/') && !text.startsWith('//')) {
      return text;
    }
    try {
      const parsed = new URL(text);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
    } catch {
      return '';
    }
  }

  async function fetchJson(path) {
    const response = await fetch(`${apiBase}${path}`);
    if (!response.ok) {
      throw new Error(`Request failed: ${path}`);
    }
    return response.json();
  }

  async function loadProductInfo() {
    const [version, changelog] = await Promise.all([
      fetchJson('/api/version').catch(() => defaultVersion),
      fetchJson('/api/changelog').catch(() => ({ available: false, entries: [] }))
    ]);
    return {
      version: normalizeVersion(version),
      changelog
    };
  }

  function normalizeVersion(version) {
    version = version || {};
    return {
      ...defaultVersion,
      ...version,
      branding: { ...defaultVersion.branding, ...(version.branding || {}) },
      fingerprint: { ...defaultVersion.fingerprint, ...(version.fingerprint || {}) },
      donation: { ...defaultVersion.donation, ...(version.donation || {}) }
    };
  }

  function renderProductName(root, version) {
    for (const node of root.querySelectorAll('[data-product-name]')) {
      node.textContent = version.branding.productName || 'AgentX';
    }
  }

  function renderVersion(root, version) {
    const label = [version.version ? `v${version.version}` : '', version.edition].filter(Boolean).join(' · ');
    for (const node of root.querySelectorAll('[data-product-version]')) {
      node.textContent = label;
      node.hidden = !label;
      node.setAttribute('title', version.landingMode ? `landing: ${version.landingMode}` : '');
    }
  }

  function renderSignature(root, version) {
    const branding = version.branding || {};
    for (const node of root.querySelectorAll('[data-product-signature]')) {
      node.replaceChildren();
      if (branding.enabled === false) {
        node.hidden = true;
        continue;
      }
      const href = safeUrl(branding.homepageUrl);
      const target = href ? document.createElement('a') : document.createElement('span');
      target.textContent = branding.signature || 'Powered by AgentX';
      if (href) {
        target.href = href;
      }
      if (branding.tooltip) {
        target.title = branding.tooltip;
      }
      node.hidden = false;
      node.append(target);
    }
  }

  function renderLinks(root, version) {
    const branding = version.branding || {};
    const links = {
      github: branding.githubUrl,
      docs: branding.docsUrl,
      home: branding.homepageUrl
    };
    for (const node of root.querySelectorAll('[data-product-link]')) {
      const key = node.getAttribute('data-product-link');
      const href = safeUrl(links[key]);
      if (!href) {
        node.hidden = true;
        node.removeAttribute('href');
        continue;
      }
      node.hidden = false;
      node.setAttribute('href', href);
    }
  }

  function renderChangelog(root, changelog) {
    for (const node of root.querySelectorAll('[data-product-changelog]')) {
      node.replaceChildren();
      if (!changelog || !changelog.available || !Array.isArray(changelog.entries) || changelog.entries.length === 0) {
        node.hidden = true;
        continue;
      }
      const details = document.createElement('details');
      details.className = 'product-changelog';
      const summary = document.createElement('summary');
      summary.textContent = i18n('portal.footer.changelog', '更新日志');
      details.append(summary);

      for (const entry of changelog.entries.slice(0, 3)) {
        const section = document.createElement('section');
        const title = document.createElement('h3');
        title.textContent = [entry.version, entry.date].filter(Boolean).join(' · ');
        const list = document.createElement('ul');
        for (const item of (entry.items || []).slice(0, 6)) {
          const li = document.createElement('li');
          li.textContent = String(item);
          list.append(li);
        }
        section.append(title, list);
        details.append(section);
      }
      node.hidden = false;
      node.append(details);
    }
  }

  function renderFingerprint(root, version) {
    try {
      const fingerprint = version && version.fingerprint ? version.fingerprint : {};
      const marker =
        fingerprint.enabled === true && fingerprint.signed === true && typeof fingerprint.marker === 'string'
          ? fingerprint.marker
          : '';

      upsertMeta('agentx-fingerprint', marker);
      if (marker) {
        document.documentElement.setAttribute('data-agentx-fingerprint', marker);
      } else {
        document.documentElement.removeAttribute('data-agentx-fingerprint');
      }

      for (const node of root.querySelectorAll('[data-product-fingerprint]')) {
        if (!fingerprint.enabled) {
          node.hidden = true;
          node.textContent = '';
          continue;
        }
        const parts = [
          fingerprint.owner,
          fingerprint.deploymentId,
          fingerprint.channel,
          fingerprint.version ? `v${fingerprint.version}` : ''
        ].filter(Boolean);
        node.hidden = parts.length === 0;
        node.textContent = parts.join(' · ');
      }
    } catch {
      // Fingerprint rendering is optional and must never block the product shell.
    }
  }

  function renderDonation(root, version) {
    const donation = version && version.donation ? version.donation : defaultVersion.donation;
    const channels = {
      alipay: {
        label: i18n('portal.donation.alipay', '支付宝'),
        qrUrl: safeUrl(donation.alipayQrUrl),
        link: safeUrl(donation.alipayLink)
      },
      wechat: {
        label: i18n('portal.donation.wechat', '微信'),
        qrUrl: safeUrl(donation.wechatQrUrl),
        link: safeUrl(donation.wechatLink)
      }
    };
    const hasConfiguredPayment = Object.values(channels).some((channel) => channel.qrUrl || channel.link);
    const isOpen = donation.enabled !== false && hasConfiguredPayment;

    for (const node of root.querySelectorAll('[data-donation-status]')) {
      node.textContent = isOpen
        ? i18n('portal.donation.available', '可扫码或跳转')
        : i18n('portal.footer.unavailable', '暂未开放');
      node.classList.toggle('done', isOpen);
    }

    for (const node of root.querySelectorAll('[data-donation-float-note]')) {
      node.textContent = isOpen
        ? i18n('portal.donation.view', '查看二维码/链接')
        : i18n('portal.footer.unavailable', '暂未开放');
    }

    for (const node of root.querySelectorAll('[data-donation-float]')) {
      node.setAttribute('href', '/donation-support');
    }

    for (const [key, channel] of Object.entries(channels)) {
      renderDonationQr(root, key, channel);
      renderDonationLink(root, key, channel);
      renderDonationUnavailable(root, key, channel, donation.enabled !== false);
    }

    initDonationAmountControls(root);
  }

  function currentUser() {
    try {
      const raw = localStorage.getItem(authUserKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function clearSession() {
    localStorage.removeItem(authTokenKey);
    localStorage.removeItem(authUserKey);
  }

  let portalAuthOutsideCloseBound = false;

  // 打开时把用户菜单下拉移到 <body> 下并用 fixed 定位锚定在触发器下方：悬浮胶囊带 backdrop-filter
  // 会成为 fixed 子元素的包含块并以 overflow 裁切，单纯改 position 无法逃逸；移出胶囊到 body 才能彻底脱离
  // 裁切（修复首页等胶囊页下拉被裁切、看不见/点不到）。关闭时移回原菜单。
  function positionPortalDropdown(trigger, dropdown) {
    const rect = trigger.getBoundingClientRect();
    const view = trigger.ownerDocument ? trigger.ownerDocument.defaultView || window : window;
    dropdown.style.position = 'fixed';
    dropdown.style.top = `${Math.round(rect.bottom + 8)}px`;
    dropdown.style.right = `${Math.round(view.innerWidth - rect.right)}px`;
    dropdown.style.left = 'auto';
  }

  function closeAllPortalMenus(doc) {
    for (const openMenu of doc.querySelectorAll('.portal-user-menu.open')) {
      openMenu.classList.remove('open');
      openMenu.querySelector('.portal-user-trigger')?.setAttribute('aria-expanded', 'false');
    }
    for (const floating of doc.querySelectorAll('.portal-user-dropdown.is-floating')) {
      floating.classList.remove('is-floating');
      floating.removeAttribute('style');
      if (floating._ownerMenu) {
        floating._ownerMenu.append(floating);
      }
    }
  }

  function renderPortalAuth(root) {
    const user = currentUser();
    const doc = root.ownerDocument || root;
    for (const node of root.querySelectorAll('[data-portal-auth]')) {
      node.replaceChildren();
      if (!user || !user.username) {
        const link = doc.createElement('a');
        link.href = '/login';
        link.textContent = i18n('portal.auth.login', '登录');
        node.append(link);
        continue;
      }

      const menu = doc.createElement('div');
      menu.className = 'portal-user-menu';

      const trigger = doc.createElement('button');
      trigger.type = 'button';
      trigger.className = 'portal-user-trigger';
      trigger.setAttribute('aria-haspopup', 'menu');
      trigger.setAttribute('aria-expanded', 'false');
      const avatar = doc.createElement('span');
      avatar.className = 'portal-user-avatar';
      avatar.textContent = (user.username || '?').slice(0, 1).toUpperCase();
      avatar.setAttribute('aria-hidden', 'true');
      const name = doc.createElement('span');
      name.textContent = user.username;
      const caret = doc.createElement('span');
      caret.className = 'portal-user-caret';
      caret.textContent = '▾';
      caret.setAttribute('aria-hidden', 'true');
      trigger.append(avatar, name, caret);

      const dropdown = doc.createElement('div');
      dropdown.className = 'portal-user-dropdown';
      dropdown.setAttribute('role', 'menu');

      const accountLink = doc.createElement('a');
      accountLink.href = '/account';
      accountLink.textContent = i18n('portal.auth.account', '用户中心');
      accountLink.setAttribute('role', 'menuitem');
      dropdown.append(accountLink);

      if (serverAdminRole) {
        const adminLink = doc.createElement('a');
        adminLink.href = '/admin';
        adminLink.textContent = i18n('portal.auth.admin', '账户管理');
        adminLink.setAttribute('role', 'menuitem');
        dropdown.append(adminLink);
      }

      const separator = doc.createElement('div');
      separator.className = 'portal-user-separator';
      const logout = doc.createElement('button');
      logout.type = 'button';
      logout.className = 'portal-user-logout';
      logout.textContent = i18n('portal.auth.logout', '登出');
      logout.setAttribute('role', 'menuitem');
      logout.addEventListener('click', () => {
        clearSession();
        window.location.assign('/login');
      });
      dropdown.append(separator, logout);
      dropdown._ownerMenu = menu;

      trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        closeAllPortalMenus(doc);
        if (willOpen) {
          menu.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          (doc.body || doc.documentElement).append(dropdown);
          dropdown.classList.add('is-floating');
          positionPortalDropdown(trigger, dropdown);
        }
      });

      menu.append(trigger, dropdown);
      node.append(menu);
    }

    if (!portalAuthOutsideCloseBound) {
      portalAuthOutsideCloseBound = true;
      doc.addEventListener('click', () => closeAllPortalMenus(doc));
      const reposition = () => {
        for (const floating of doc.querySelectorAll('.portal-user-dropdown.is-floating')) {
          const trigger = floating._ownerMenu ? floating._ownerMenu.querySelector('.portal-user-trigger') : null;
          if (trigger) {
            positionPortalDropdown(trigger, floating);
          }
        }
      };
      const view = doc.defaultView || window;
      view.addEventListener('resize', reposition);
      view.addEventListener('scroll', reposition, true);
    }
  }

  function renderDonationQr(root, key, channel) {
    for (const node of root.querySelectorAll(`[data-donation-qr="${key}"]`)) {
      node.replaceChildren();
      if (!channel.qrUrl) {
        node.hidden = true;
        continue;
      }
      const image = document.createElement('img');
      image.src = channel.qrUrl;
      image.alt = i18n('portal.donation.qrAlt', `${channel.label}捐赠二维码`)
        .replace('{channel}', channel.label);
      image.loading = 'lazy';
      image.decoding = 'async';
      node.hidden = false;
      node.append(image);
    }
  }

  function renderDonationLink(root, key, channel) {
    for (const node of root.querySelectorAll(`[data-donation-link="${key}"]`)) {
      if (!channel.link) {
        node.hidden = true;
        node.removeAttribute('href');
        continue;
      }
      node.hidden = false;
      node.setAttribute('href', channel.link);
      node.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function renderDonationUnavailable(root, key, channel, enabled) {
    for (const node of root.querySelectorAll(`[data-donation-unavailable="${key}"]`)) {
      const hasChannel = Boolean(channel.qrUrl || channel.link);
      node.hidden = hasChannel;
      node.textContent = i18n('portal.footer.unavailable', '暂未开放');
    }
  }

  function initDonationAmountControls(root) {
    for (const donationRoot of root.querySelectorAll('[data-donation-root]')) {
      if (donationRoot.dataset.donationAmountReady === 'true') {
        continue;
      }
      donationRoot.dataset.donationAmountReady = 'true';
      const radios = Array.from(donationRoot.querySelectorAll('input[name="donationAmount"]'));
      const customInput = donationRoot.querySelector('[data-donation-custom-amount]');
      const output = donationRoot.querySelector('[data-donation-selected-amount]');

      const update = () => {
        const selected = radios.find((radio) => radio.checked);
        const isCustomSelected = selected && selected.value === 'custom';
        const currencySuffix = window.AgentXI18n?.getLocale?.() === 'en-US' ? '' : ' 元';
        const currencyPrefix = window.AgentXI18n?.getLocale?.() === 'en-US' ? 'CNY ' : '';
        const customValue =
          customInput && typeof customInput.value === 'string' && customInput.value.trim()
            ? `${currencyPrefix}${customInput.value.trim()}${currencySuffix}`
            : '';
        const fixedAmount = selected && selected.value && !isCustomSelected ? selected.value : '5';
        const fixedValue = `${currencyPrefix}${fixedAmount}${currencySuffix}`;
        if (output) {
          output.textContent = window.AgentXI18n?.getLocale?.() === 'en-US'
            ? `Selected: ${customValue || fixedValue}`
            : `当前选择：${customValue || fixedValue}`;
        }
      };

      for (const radio of radios) {
        radio.addEventListener('change', () => {
          if (customInput && radio.value !== 'custom') {
            customInput.value = '';
          }
          update();
        });
      }
      if (customInput) {
        customInput.addEventListener('input', () => {
          for (const radio of radios) {
            radio.checked = radio.value === 'custom';
          }
          update();
        });
      }
      update();
    }
  }

  function upsertMeta(name, content) {
    let meta = document.head.querySelector(`meta[name="${name}"]`);
    if (!content) {
      if (meta) {
        meta.remove();
      }
      return;
    }
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', name);
      document.head.append(meta);
    }
    meta.setAttribute('content', content);
  }

  function render(root, payload) {
    const version = normalizeVersion(payload?.version || defaultVersion);
    renderProductName(root, version);
    renderVersion(root, version);
    renderSignature(root, version);
    renderLinks(root, version);
    renderChangelog(root, payload?.changelog);
    renderFingerprint(root, version);
    renderDonation(root, version);
    renderPortalNav(root);
    renderPortalAuth(root);
  }

  let serverAdminRole = false;

  async function init(root = document) {
    try {
      render(root, await loadProductInfo());
    } catch {
      render(root, { version: defaultVersion, changelog: { available: false, entries: [] } });
    }
    serverAdminRole = false;
    if (window.AgentXAuth?.getToken?.()) {
      try {
        // The server is the role source of truth. Keep the cached identity on a
        // failed check, but never use its role to expose admin navigation.
        const res = await window.AgentXAuth.authFetch('/auth/me', { skipAuthRedirect: true, keepTokenOn401: true });
        if (res.ok) {
          const me = await res.json();
          serverAdminRole = me.user?.role === 'admin';
          if (me.user) {
            window.AgentXAuth?.setUser?.(me.user);
            window.AgentXI18n?.adoptAccountUser?.(me.user);
          }
        }
      } catch { /* network error — keep serverAdminRole false */ }
    }
    renderPortalAuth(root);
  }

  window.AgentXProductShell = {
    init,
    loadProductInfo,
    render,
    renderFingerprint,
    renderDonation,
    renderPortalNav,
    renderPortalAuth,
    safeUrl
  };

  // 解析期同步渲染一次导航，避免首页等页面出现导航空白闪烁（FOUC）。
  try {
    renderPortalNav(document);
  } catch {
    // 同步渲染失败不应阻塞产品壳；init() 会再次尝试。
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }

  window.addEventListener('localechange', () => {
    renderPortalNav(document);
    renderPortalAuth(document);
    window.AgentXI18n?.mountSwitches?.(document);
    window.AgentXI18n?.applyLocale?.(window.AgentXI18n.getLocale());
  });
})();
