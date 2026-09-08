(function () {
  const tokenKey = 'agentx.auth.token';
  const typeOptions = ['all', 'announcement', 'news', 'release_note', 'changelog'];

  function i18n(key, params) {
    return window.AgentXI18n?.t?.(key, params || undefined) || key;
  }

  function localizedFeedPath(path) {
    if (!/^\/api\/announcements\/(?:home|feed)$/.test(path)) return path;
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}locale=${encodeURIComponent(window.AgentXI18n?.getLocale?.() || 'zh-CN')}`;
  }

  function getToken() {
    try {
      return window.AgentXAuth?.getToken?.() || localStorage.getItem(tokenKey) || '';
    } catch {
      return '';
    }
  }

  async function requestJson(path, options = {}) {
    const token = getToken();
    const useAuthFetch = Boolean(options.authPreferred && token && window.AgentXAuth?.authFetch);
    let response;
    if (useAuthFetch) {
      response = await window.AgentXAuth.authFetch(localizedFeedPath(path), { method: options.method || 'GET', body: options.body });
    } else {
      response = await fetch(localizedFeedPath(path), {
        method: options.method || 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: options.body
      });
    }
    if (response.status === 401 && options.allowAnonymousFallback) {
      response = await fetch(localizedFeedPath(path), { method: options.method || 'GET', body: options.body });
    }
    const contentType = response.headers?.get?.('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : {};
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  function clear(element) {
    element?.replaceChildren();
  }

  function text(value, fallback = '') {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
  }

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return '';
    return window.AgentXI18n?.formatDate?.(
      date,
      { year: 'numeric', month: '2-digit', day: '2-digit' },
      window.AgentXI18n?.getLocale?.()
    ) || new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  function typeLabel(type) {
    const key = {
      announcement: 'ann.type.announcement',
      news: 'ann.type.news',
      release_note: 'ann.type.release',
      changelog: 'ann.type.changelog'
    }[type];
    return key ? i18n(key) : text(type, i18n('ann.type.update'));
  }

  function isRead(item) {
    return item?.state?.read === true;
  }

  function isDismissed(item) {
    return item?.state?.dismissed === true || localStorage.getItem(dismissedKey(item)) === '1';
  }

  function dismissedKey(item) {
    return `dismissed:${item.id}:${item.revision}`;
  }

  function readKey(item) {
    return `read:${item.id}:${item.revision}`;
  }

  function markLocalRead(item) {
    try {
      localStorage.setItem(readKey(item), '1');
    } catch {
      // Local read state is cosmetic for anonymous users.
    }
  }

  function shouldShowModal(item) {
    if (!item || item.type !== 'announcement' || item.modalBehavior === 'none') return false;
    if (item.modalBehavior === 'force_until_expiry') return true;
    return !isDismissed(item);
  }

  async function markRead(item) {
    if (!item) return;
    item.state = { ...(item.state || {}), read: true };
    if (!getToken()) {
      markLocalRead(item);
      return;
    }
    try {
      await requestJson(`/api/announcements/${encodeURIComponent(item.id)}/read`, {
        method: 'POST',
        authPreferred: true,
        body: JSON.stringify({})
      });
    } catch {
      // Optimistic UI only; the server remains the source of truth next load.
    }
  }

  async function markDismissed(item) {
    if (!item) return;
    item.state = { ...(item.state || {}), dismissed: true };
    if (!getToken()) {
      try {
        localStorage.setItem(dismissedKey(item), '1');
      } catch {
        // Dismiss state is best effort for anonymous users.
      }
      return;
    }
    try {
      await requestJson(`/api/announcements/${encodeURIComponent(item.id)}/dismiss`, {
        method: 'POST',
        authPreferred: true,
        body: JSON.stringify({})
      });
    } catch {
      // Optimistic UI only; unauthorized/unknown responses are generic.
    }
  }

  function createMeta(item, compact = false) {
    const meta = document.createElement('div');
    meta.className = 'announcement-meta';
    const type = document.createElement('span');
    type.className = `announcement-type announcement-type-${item.type}`;
    type.textContent = typeLabel(item.type);
    meta.append(type);
    const date = formatDate(item.publishedAt || item.updatedAt);
    if (date) {
      const time = document.createElement('time');
      time.dateTime = item.publishedAt || item.updatedAt;
      time.textContent = date;
      meta.append(time);
    }
    if (!compact && !isRead(item)) {
      const unread = document.createElement('span');
      unread.className = 'announcement-unread-badge';
      unread.textContent = i18n('ann.unread');
      meta.append(unread);
    }
    return meta;
  }

  function createCompactCard(item) {
    const article = document.createElement('article');
    article.className = `announcement-card announcement-card-compact ${isRead(item) ? 'is-read' : 'is-unread'}`;
    article.dataset.announcementId = item.id;

    const header = document.createElement('div');
    header.className = 'announcement-card-head';
    const title = document.createElement('h3');
    title.textContent = text(item.title, i18n('ann.untitled'));
    header.append(title);

    const summary = document.createElement('p');
    summary.textContent = text(item.summary || item.body);

    article.append(createMeta(item, true), header, summary);
    return article;
  }

  function createFullCard(item) {
    const article = document.createElement('article');
    article.className = `announcement-card announcement-card-full ${isRead(item) ? 'is-read' : 'is-unread'}`;
    article.dataset.announcementId = item.id;
    article.dataset.announcementType = item.type;

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.className = 'announcement-summary-row';

    const titleWrap = document.createElement('span');
    titleWrap.className = 'announcement-summary-title';
    const title = document.createElement('strong');
    title.textContent = text(item.title, i18n('ann.untitled'));
    const brief = document.createElement('span');
    brief.textContent = text(item.summary);
    titleWrap.append(title, brief);

    summary.append(createMeta(item), titleWrap);

    const body = document.createElement('div');
    body.className = 'announcement-body';
    const paragraph = document.createElement('p');
    paragraph.textContent = text(item.body || item.summary);
    body.append(paragraph);

    details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (!details.open || article.dataset.readRecorded === 'true') return;
      article.dataset.readRecorded = 'true';
      markRead(item).finally(() => {
        article.classList.remove('is-unread');
        article.classList.add('is-read');
        const badge = article.querySelector('.announcement-unread-badge');
        badge?.remove();
      });
    });

    article.append(details);
    return article;
  }

  function renderList(container, items, options = {}) {
    clear(container);
    const source = items || [];
    const visibleItems = source.slice(0, options.limit || source.length);
    if (visibleItems.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = options.emptyText || i18n('ann.empty');
      container.append(empty);
      return;
    }
    for (const item of visibleItems) {
      container.append(options.full ? createFullCard(item) : createCompactCard(item));
    }
  }

  function renderModal(host, item) {
    clear(host);
    if (!shouldShowModal(item)) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop announcement-modal-backdrop';
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'announcement-modal-title');

    const panel = document.createElement('section');
    panel.className = 'modal-panel announcement-modal-panel';
    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('h2');
    title.id = 'announcement-modal-title';
    title.textContent = text(item.title, i18n('ann.modal.title'));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-button';
    close.setAttribute('aria-label', i18n('ann.modal.close'));
    close.textContent = '×';
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'announcement-modal-body';
    const summary = document.createElement('p');
    summary.textContent = text(item.summary);
    const detail = document.createElement('p');
    detail.textContent = text(item.body || item.summary);
    body.append(createMeta(item, true), summary, detail);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'primary-button';
    ok.textContent = i18n('ann.modal.ok');
    actions.append(ok);

    const dismiss = () => {
      clear(host);
      markDismissed(item);
    };
    close.addEventListener('click', dismiss);
    ok.addEventListener('click', dismiss);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) dismiss();
    });

    panel.append(head, body, actions);
    backdrop.append(panel);
    host.append(backdrop);
  }

  async function initHome() {
    const root = document.querySelector('[data-announcements-home]');
    if (!root) return;
    const list = root.querySelector('[data-announcements-home-feed]');
    const modalHost = document.querySelector('[data-announcement-modal]');
    try {
      const payload = await requestJson('/api/announcements/home', { allowAnonymousFallback: true });
      renderList(list, payload.feed || [], { limit: 4 });
      if (modalHost) renderModal(modalHost, payload.modalCandidate);
    } catch {
      renderList(list, [], { emptyText: i18n('ann.unavailable') });
    }
  }

  function renderFilters(root, items, selected, onSelect) {
    const container = root.querySelector('[data-announcements-filter]');
    if (!container) return;
    clear(container);
    for (const type of typeOptions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = type === selected ? 'announcement-filter-button active' : 'announcement-filter-button';
      button.dataset.announcementFilter = type;
      button.textContent = type === 'all' ? i18n('ann.filter.all') : typeLabel(type);
      const count = document.createElement('span');
      count.textContent = String(type === 'all' ? items.length : items.filter((item) => item.type === type).length);
      button.append(count);
      button.addEventListener('click', () => onSelect(type));
      container.append(button);
    }
  }

  async function initAccount() {
    const root = document.querySelector('[data-announcements-account]');
    if (!root) return;
    const list = root.querySelector('[data-announcements-list]');
    const refresh = root.querySelector('[data-announcements-refresh]');
    let items = [];
    let selected = 'all';
    const draw = () => {
      const filtered = selected === 'all' ? items : items.filter((item) => item.type === selected);
      renderFilters(root, items, selected, (next) => {
        selected = next;
        draw();
      });
      renderList(list, filtered, { full: true });
    };
    const load = async () => {
      try {
        const payload = await requestJson('/api/announcements/feed', { authPreferred: true });
        items = Array.isArray(payload.items) ? payload.items : [];
        draw();
      } catch {
        renderList(list, [], { emptyText: i18n('ann.loadFailed') });
      }
    };
    refresh?.addEventListener('click', load);
    await load();
  }


  async function init() {
    await Promise.all([initHome(), initAccount()]);
  }

  window.AgentXAnnouncements = {
    init,
    markRead,
    markDismissed,
    renderList
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
  window.addEventListener('localechange', () => {
    void init();
  });
})();
