(function () {
  const root = document.querySelector('[data-updates-root]');
  if (!root) return;

  const list = root.querySelector('[data-updates-list]');
  const detail = root.querySelector('[data-updates-detail]');
  const layout = root.querySelector('[data-updates-layout]');
  const filters = Array.from(root.querySelectorAll('[data-updates-filter]'));
  let activeFilter = 'all';
  let items = [];
  let loadState = 'loading';

  const TYPE_TO_FILTER = {
    release_note: 'release',
    changelog: 'release',
    news: 'news',
    announcement: 'announcement'
  };

  function i18n(key) {
    return window.AgentXI18n?.t?.(key) || key;
  }

  function getLocale() {
    return window.AgentXI18n?.getLocale?.() || 'zh-CN';
  }

  function getToken() {
    try {
      return window.AgentXAuth?.getToken?.() || localStorage.getItem('agentx.auth.token') || '';
    } catch {
      return '';
    }
  }

  async function fetchFeed() {
    const path = `/api/announcements/feed?locale=${encodeURIComponent(getLocale())}`;
    const token = getToken();
    let response = await fetch(path, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });
    if (response.status === 401 && token) {
      response = await fetch(path);
    }
    const contentType = response.headers?.get?.('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : {};
    if (!response.ok) {
      throw new Error(payload.error || `Request failed (${response.status})`);
    }
    return Array.isArray(payload.items) ? payload.items : [];
  }

  function filterGroup(item) {
    return TYPE_TO_FILTER[item?.type] || 'news';
  }

  function dateParts(item) {
    const date = new Date(item?.publishedAt || item?.updatedAt || '');
    if (Number.isNaN(date.getTime())) return { day: '--', month: '' };
    const locale = getLocale();
    return {
      day: new Intl.DateTimeFormat(locale, { day: '2-digit' }).format(date),
      month: new Intl.DateTimeFormat(locale, { month: 'short' }).format(date)
    };
  }

  function isUnread(item) {
    return item?.state ? item.state.read === false : false;
  }

  function filteredItems() {
    return activeFilter === 'all' ? items : items.filter((item) => filterGroup(item) === activeFilter);
  }

  function selectedId() {
    try {
      const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
      return items.some((item) => item.id === id) ? id : '';
    } catch {
      return '';
    }
  }

  function setRouteHash(id) {
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  }

  function clearRouteHash() {
    history.replaceState(null, '', window.location.pathname);
  }

  function renderPlaceholder(target, key) {
    if (!target) return;
    const placeholder = document.createElement('p');
    placeholder.className = 'empty-state';
    placeholder.textContent = i18n(key);
    target.replaceChildren(placeholder);
  }

  function renderList() {
    if (!list) return;
    if (loadState === 'loading') {
      renderPlaceholder(list, 'updates.loading');
      return;
    }
    if (loadState === 'error') {
      renderPlaceholder(list, 'updates.loadFailed');
      return;
    }
    const visible = filteredItems();
    if (visible.length === 0) {
      renderPlaceholder(list, 'updates.empty');
      return;
    }

    const activeId = selectedId();
    list.replaceChildren();
    for (const item of visible) {
      const group = filterGroup(item);
      const date = dateParts(item);
      const unread = isUnread(item);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `updates-list-item ann-item ${unread ? 'unread' : ''} ${item.id === activeId ? 'active' : ''}`;
      button.dataset.updateId = item.id;
      button.setAttribute('aria-current', item.id === activeId ? 'true' : 'false');

      const dateEl = document.createElement('span');
      dateEl.className = 'updates-date ann-date';
      const day = document.createElement('strong');
      day.textContent = date.day;
      const month = document.createElement('small');
      month.textContent = date.month;
      dateEl.append(day, month);

      const copy = document.createElement('span');
      copy.className = 'updates-copy ann-main';
      const meta = document.createElement('span');
      meta.className = 'updates-meta row1';
      const type = document.createElement('em');
      type.className = `atype ${group}`;
      type.textContent = i18n(`updates.filter.${group}`);
      meta.append(type);
      if (unread) {
        const badge = document.createElement('small');
        badge.className = 'badge teal dot';
        badge.textContent = i18n('updates.unread');
        meta.append(badge);
      }
      const title = document.createElement('strong');
      title.textContent = item.title || i18n('updates.untitled');
      const summary = document.createElement('span');
      summary.textContent = item.summary || '';
      copy.append(meta, title, summary);
      button.append(dateEl, copy);
      button.addEventListener('click', () => {
        setRouteHash(item.id);
        render();
        detail?.focus?.({ preventScroll: true });
      });
      list.append(button);
    }
  }

  function renderDetail() {
    if (!detail) return;

    const active = items.find((item) => item.id === selectedId()) || null;
    layout?.classList.toggle('has-selection', Boolean(active));
    detail.replaceChildren();

    if (!active) {
      const empty = document.createElement('p');
      empty.className = 'muted-line';
      empty.textContent = i18n('updates.select');
      detail.append(empty);
      return;
    }

    const group = filterGroup(active);
    const date = dateParts(active);

    const dateEl = document.createElement('div');
    dateEl.className = 'updates-detail-date ann-date';
    const day = document.createElement('strong');
    day.textContent = date.day;
    const month = document.createElement('span');
    month.textContent = date.month;
    dateEl.append(day, month);

    const header = document.createElement('header');
    header.className = 'updates-detail-header';
    const meta = document.createElement('span');
    meta.className = 'updates-meta';
    const label = document.createElement('em');
    label.textContent = i18n(`updates.filter.${group}`);
    meta.append(label);
    const heading = document.createElement('h2');
    heading.textContent = active.title || i18n('updates.untitled');
    const brief = document.createElement('p');
    brief.textContent = active.summary || '';
    header.append(meta, heading, brief);

    const body = document.createElement('div');
    body.className = 'updates-detail-body';
    const paragraphs = String(active.body || active.summary || '')
      .split(/\r?\n/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
    for (const paragraph of paragraphs.length ? paragraphs : [active.summary || '']) {
      const p = document.createElement('p');
      p.textContent = paragraph;
      body.append(p);
    }

    detail.append(dateEl, header, body);

    if (Array.isArray(active.links) && active.links.length) {
      const actions = document.createElement('div');
      actions.className = 'updates-detail-actions';
      for (const link of active.links) {
        if (!link || typeof link.href !== 'string') continue;
        const anchor = document.createElement('a');
        anchor.className = 'btn btn-ghost btn-sm secondary-button';
        anchor.href = link.href;
        anchor.textContent = link.label || link.href;
        actions.append(anchor);
      }
      if (actions.childElementCount) detail.append(actions);
    }
  }

  function renderFilters() {
    for (const button of filters) {
      const filter = button.dataset.updatesFilter || 'all';
      const isActive = filter === activeFilter;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      const count = button.querySelector('.ct');
      if (count) {
        count.textContent = String(
          filter === 'all' ? items.length : items.filter((item) => filterGroup(item) === filter).length
        );
      }
    }
  }

  function render() {
    renderFilters();
    renderList();
    renderDetail();
  }

  async function load() {
    loadState = 'loading';
    render();
    try {
      items = await fetchFeed();
      loadState = 'ready';
    } catch {
      items = [];
      loadState = 'error';
    }
    render();
  }

  for (const button of filters) {
    button.addEventListener('click', () => {
      activeFilter = button.dataset.updatesFilter || 'all';
      clearRouteHash();
      render();
    });
  }

  window.addEventListener('hashchange', render);
  window.addEventListener('localechange', () => {
    void load();
  });
  void load();
})();
