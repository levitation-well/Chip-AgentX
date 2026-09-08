(function () {
  const ticketNoPattern = /^(FB|DS|AP)-\d{8}-\d{4}$/;
  const maxFiles = 3;
  const maxBytes = 100 * 1024 * 1024;
  const allowedExts = new Set(['.pdf', '.zip', '.7z', '.md', '.markdown', '.txt', '.c', '.h', '.cs', '.cpp', '.cxx', '.cc', '.hpp', '.hh']);

  const queryForm = document.getElementById('ticket-query-form');
  const queryInput = document.getElementById('ticket-no-input');
  const queryResult = document.getElementById('ticket-query-result');
  const queryError = document.getElementById('ticket-query-error');
  const feedbackForm = document.getElementById('feedback-ticket-form');
  const fileInput = document.getElementById('feedback-attachments');
  const hasFileInput = document.getElementById('feedback-has-attachments');
  const feedbackStatus = document.getElementById('feedback-ticket-status');
  const datasheetForm = document.getElementById('datasheet-ticket-form');
  const datasheetFileInput = document.getElementById('datasheet-attachments');
  const datasheetStatus = document.getElementById('datasheet-ticket-status');
  const accountApplicationForm = document.getElementById('account-application-form');
  const accountApplicationStatus = document.getElementById('account-application-status');
  const myTicketsStatus = document.getElementById('my-tickets-status');
  const myTicketsList = document.getElementById('my-tickets-list');
  const ticketSystemLayout = document.getElementById('ticket-system-layout');
  const ticketSidebarToggle = document.getElementById('ticket-sidebar-toggle');

  const typeLabels = {
    feedback: 'tickets.type.feedback',
    datasheet_submission: 'tickets.type.datasheet',
    account_application: 'tickets.type.application'
  };

  const statusLabels = {
    submitted: 'tickets.status.submitted',
    received: 'tickets.status.received',
    evaluating: 'tickets.status.evaluating',
    accepted: 'tickets.status.accepted',
    in_development: 'tickets.status.in_development',
    launched: 'tickets.status.launched',
    deferred: 'tickets.status.deferred',
    rejected: 'tickets.status.rejected',
    closed: 'tickets.status.closed',
    reviewing: 'tickets.status.reviewing',
    needs_more_info: 'tickets.status.needs_more_info',
    archived: 'tickets.status.archived',
    pending_review: 'tickets.status.pending_review',
    approved: 'tickets.status.approved'
  };

  function i18n(key, params) {
    return window.AgentXI18n?.t?.(key, params || undefined) || key;
  }

  function typeLabel(value) {
    return typeLabels[value] ? i18n(typeLabels[value]) : text(value);
  }

  function statusLabel(value) {
    return statusLabels[value] ? i18n(statusLabels[value]) : text(value);
  }

  function text(value, fallback = i18n('tickets.noneValue')) {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function setTicketSidebarCollapsed(collapsed, options = {}) {
    if (!ticketSystemLayout || !ticketSidebarToggle) return;
    ticketSystemLayout.classList.toggle('sidebar-collapsed', collapsed);
    ticketSidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    ticketSidebarToggle.textContent = collapsed ? '‹' : '›';
    ticketSidebarToggle.title = collapsed ? i18n('tickets.sidebar.expand') : i18n('tickets.sidebar.collapse');
    if (!options.skipStore) {
      localStorage.setItem('agentx.tickets.sidebarCollapsed', collapsed ? '1' : '0');
    }
  }

  function initTicketSidebarCollapse() {
    if (!ticketSidebarToggle) return;
    const stored = localStorage.getItem('agentx.tickets.sidebarCollapsed');
    const mobileDefault = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    setTicketSidebarCollapsed(stored === null ? mobileDefault : stored === '1', { skipStore: true });
    ticketSidebarToggle.addEventListener('click', () => {
      setTicketSidebarCollapsed(!ticketSystemLayout.classList.contains('sidebar-collapsed'));
    });
  }

  function formatDate(value) {
    if (!value) {
      return i18n('tickets.noneValue');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return window.AgentXI18n?.formatDate?.(date, { dateStyle: 'medium', timeStyle: 'short', hour12: false })
      || date.toLocaleString('zh-CN', { hour12: false });
  }

  function clear(node) {
    if (node) {
      node.replaceChildren();
    }
  }

  function setError(node, message) {
    if (node) {
      node.textContent = message;
    }
  }

  function appendField(list, label, value) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    const data = document.createElement('strong');
    key.textContent = label;
    data.textContent = value;
    row.append(key, data);
    list.append(row);
  }

  function renderPublicTicket(ticket, target) {
    clear(target);
    const card = document.createElement('article');
    card.className = 'ticket-result-card';
    const title = document.createElement('h3');
    title.textContent = ticket.ticketNo;
    const list = document.createElement('div');
    list.className = 'ticket-result-fields';
    appendField(list, i18n('tickets.field.type'), typeLabel(ticket.type));
    appendField(list, i18n('tickets.field.status'), statusLabel(ticket.status));
    appendField(list, i18n('tickets.field.createdAt'), formatDate(ticket.createdAt));
    appendField(list, i18n('tickets.field.updatedAt'), formatDate(ticket.updatedAt));
    appendField(list, i18n('tickets.field.publicNote'), text(ticket.publicNote));
    appendField(list, i18n('tickets.field.moreInfo'), ticket.needsMoreInfo ? i18n('tickets.yes') : i18n('tickets.no'));
    appendField(list, i18n('tickets.field.result'), text(ticket.result));
    card.append(title, list);
    // 沟通记录：管理员对用户可见的回复（后端已按受众脱敏，绝不含内部备注）。
    const messages = Array.isArray(ticket.messages) ? ticket.messages : [];
    if (messages.length > 0) {
      const thread = document.createElement('div');
      thread.className = 'ticket-message-thread';
      const heading = document.createElement('h4');
      heading.textContent = i18n('tickets.timeline');
      thread.append(heading);
      for (const message of messages) {
        const item = document.createElement('div');
        item.className = 'ticket-message user';
        const head = document.createElement('div');
        head.className = 'ticket-message-head';
        const who = document.createElement('strong');
        who.textContent = message.authorLabel || message.authorRole || i18n('tickets.admin');
        const when = document.createElement('span');
        when.textContent = formatDate(message.createdAt);
        head.append(who, when);
        const body = document.createElement('p');
        body.className = 'ticket-message-text';
        body.textContent = message.text || '';
        item.append(head, body);
        thread.append(item);
      }
      card.append(thread);
    }
    target.append(card);
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, options);
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = new Error(body && typeof body.error === 'string' ? body.error : 'request_failed');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function validateFiles(files, options = {}) {
    if (options.requireFile && (!files || files.length === 0)) {
      return i18n('tickets.validation.fileRequired');
    }
    if (!files || files.length === 0) {
      return '';
    }
    if (files.length > maxFiles) {
      return i18n('tickets.validation.fileCount', { count: maxFiles });
    }
    let total = 0;
    for (const file of files) {
      total += file.size;
      if (file.size > maxBytes || total > maxBytes) {
        return i18n('tickets.validation.fileSize');
      }
      const name = file.name || '';
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (!allowedExts.has(ext)) {
        return i18n('tickets.validation.fileType');
      }
    }
    return '';
  }

  function createTicketLookupButton(ticketNo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary-button compact-button';
    button.textContent = i18n('tickets.queryThis');
    button.addEventListener('click', () => {
      if (!queryInput || !queryForm) {
        window.location.assign(`/tickets?ticketNo=${encodeURIComponent(ticketNo)}`);
        return;
      }
      queryInput.value = ticketNo;
      document.getElementById('ticket-query')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      queryForm.requestSubmit();
    });
    return button;
  }

  function syncFileState() {
    if (!hasFileInput || !fileInput) {
      return;
    }
    fileInput.disabled = !hasFileInput.checked;
    if (!hasFileInput.checked) {
      fileInput.value = '';
    }
  }

  async function submitFeedback(event) {
    event.preventDefault();
    if (!feedbackForm || !feedbackStatus) {
      return;
    }
    feedbackStatus.textContent = '';
    const fileMessage = validateFiles(fileInput && !fileInput.disabled ? fileInput.files : []);
    if (fileMessage) {
      feedbackStatus.textContent = fileMessage;
      return;
    }

    const formData = new FormData(feedbackForm);
    if (fileInput && fileInput.disabled) {
      formData.delete('attachments');
      formData.delete('hasAttachments');
    }
    const headers = new Headers();
    const token = window.AgentXAuth && typeof window.AgentXAuth.getToken === 'function' ? window.AgentXAuth.getToken() : '';
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const submit = feedbackForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
    }
    feedbackStatus.textContent = i18n('tickets.submitting');

    try {
      const body = await fetchJson('/api/tickets/feedback', { method: 'POST', headers, body: formData });
      const ticket = body.ticket || {};
      feedbackStatus.replaceChildren();
      const message = document.createElement('span');
      message.textContent = i18n('tickets.submitted', { ticketNo: ticket.ticketNo || i18n('tickets.generated') });
      feedbackStatus.append(message);
      if (ticket.ticketNo) {
        feedbackStatus.append(' ', createTicketLookupButton(ticket.ticketNo));
      }
      feedbackForm.reset();
      syncFileState();
      loadMyTickets();
    } catch {
      feedbackStatus.textContent = i18n('tickets.feedbackFailed');
    } finally {
      if (submit) {
        submit.disabled = false;
      }
    }
  }

  async function submitDatasheet(event) {
    event.preventDefault();
    if (!datasheetForm || !datasheetStatus) {
      return;
    }
    datasheetStatus.textContent = '';
    const fileMessage = validateFiles(datasheetFileInput ? datasheetFileInput.files : [], { requireFile: true });
    if (fileMessage) {
      datasheetStatus.textContent = fileMessage;
      return;
    }

    const formData = new FormData(datasheetForm);
    const headers = new Headers();
    const token = window.AgentXAuth && typeof window.AgentXAuth.getToken === 'function' ? window.AgentXAuth.getToken() : '';
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const submit = datasheetForm.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
    }
    datasheetStatus.textContent = i18n('tickets.materialSubmitting');

    try {
      const body = await fetchJson('/api/tickets/datasheet', { method: 'POST', headers, body: formData });
      const ticket = body.ticket || {};
      datasheetStatus.replaceChildren();
      const message = document.createElement('span');
      message.textContent = i18n('tickets.submitted', { ticketNo: ticket.ticketNo || i18n('tickets.generated') });
      datasheetStatus.append(message);
      if (ticket.ticketNo) {
        datasheetStatus.append(' ', createTicketLookupButton(ticket.ticketNo));
      }
      datasheetForm.reset();
      loadMyTickets();
    } catch {
      datasheetStatus.textContent = i18n('tickets.materialFailed');
    } finally {
      if (submit) {
        submit.disabled = false;
      }
    }
  }

  async function submitAccountApplication(event) {
    event.preventDefault();
    if (!accountApplicationForm || !accountApplicationStatus) {
      return;
    }
    accountApplicationStatus.textContent = '';
    const submit = accountApplicationForm.querySelector('button[type="submit"]');
    const passwordInput = accountApplicationForm.elements.password;
    const formData = new FormData(accountApplicationForm);
    const body = {
      username: String(formData.get('username') || '').trim(),
      password: String(formData.get('password') || ''),
      company: String(formData.get('company') || '').trim(),
      reason: String(formData.get('reason') || '').trim(),
      heardFrom: String(formData.get('heardFrom') || '').trim(),
      occupation: String(formData.get('occupation') || '').trim(),
      favoriteFeature: String(formData.get('favoriteFeature') || '').trim(),
      expectedFeature: String(formData.get('expectedFeature') || '').trim(),
      contact: String(formData.get('contact') || '').trim()
    };
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const token = window.AgentXAuth && typeof window.AgentXAuth.getToken === 'function' ? window.AgentXAuth.getToken() : '';
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    if (submit) {
      submit.disabled = true;
    }
    accountApplicationStatus.textContent = i18n('tickets.applicationSubmitting');

    try {
      const responseBody = await fetchJson('/api/tickets/account-application', {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
      if (passwordInput) {
        passwordInput.value = '';
      }
      const ticket = responseBody.ticket || {};
      accountApplicationStatus.replaceChildren();
      const message = document.createElement('span');
      message.textContent = i18n('tickets.applicationSubmitted', { ticketNo: ticket.ticketNo || i18n('tickets.generated') });
      accountApplicationStatus.append(message);
      if (ticket.ticketNo) {
        accountApplicationStatus.append(' ', createTicketLookupButton(ticket.ticketNo));
      }
      accountApplicationForm.reset();
      if (passwordInput) {
        passwordInput.value = '';
      }
      loadMyTickets();
    } catch {
      if (passwordInput) {
        passwordInput.value = '';
      }
      accountApplicationStatus.textContent = i18n('tickets.applicationFailed');
    } finally {
      if (submit) {
        submit.disabled = false;
      }
    }
  }

  async function queryTicket(event) {
    event.preventDefault();
    if (!queryInput || !queryResult || !queryError) {
      return;
    }
    const ticketNo = queryInput.value.trim().toUpperCase();
    queryInput.value = ticketNo;
    clear(queryResult);
    setError(queryError, '');
    if (!ticketNoPattern.test(ticketNo)) {
      setError(queryError, i18n('tickets.query.invalid'));
      return;
    }
    try {
      const body = await fetchJson(`/api/tickets/${encodeURIComponent(ticketNo)}/public`);
      if (!body.ticket || !body.ticket.ticketNo) {
        setError(queryError, i18n('tickets.query.notFound'));
        return;
      }
      renderPublicTicket(body.ticket, queryResult);
    } catch (error) {
      // 404 means the ticket number does not exist; anything else (5xx,
      // network failure) is a generic lookup failure, not "not found".
      setError(queryError, i18n(error?.status === 404 ? 'tickets.query.notFound' : 'tickets.query.failed'));
    }
  }

  function renderMyTickets(items) {
    clear(myTicketsList);
    if (!Array.isArray(items) || items.length === 0) {
      myTicketsStatus.textContent = i18n('tickets.none');
      return;
    }
    myTicketsStatus.textContent = i18n('tickets.count', {
      count: window.AgentXI18n?.formatNumber?.(items.length) || items.length
    });
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'my-ticket-row';
      const top = document.createElement('div');
      const no = document.createElement('strong');
      const state = document.createElement('span');
      no.textContent = item.ticketNo;
      state.textContent = statusLabel(item.status);
      top.append(no, state);
      const title = document.createElement('p');
      title.textContent = text(item.title, i18n('tickets.untitled'));
      const meta = document.createElement('small');
      meta.textContent = `${typeLabel(item.type)} · ${formatDate(item.updatedAt || item.createdAt)} · ${i18n('tickets.moreInfo', {
        value: item.needsMoreInfo ? i18n('tickets.yes') : i18n('tickets.no')
      })}`;
      card.append(top, title, meta);
      card.addEventListener('click', () => {
        if (queryInput) queryInput.value = item.ticketNo;
        queryForm?.requestSubmit();
      });
      myTicketsList.append(card);
    }
  }

  async function loadMyTickets() {
    if (!myTicketsStatus || !myTicketsList) {
      return;
    }
    const auth = window.AgentXAuth;
    const token = auth && typeof auth.getToken === 'function' ? auth.getToken() : '';
    if (!token) {
      clear(myTicketsList);
      myTicketsStatus.textContent = i18n('tickets.loginRequired');
      return;
    }
    myTicketsStatus.textContent = i18n('tickets.mineLoading');
    try {
      const response = typeof auth.authFetch === 'function'
        ? await auth.authFetch('/api/my/tickets', { skipAuthRedirect: true })
        : await fetch('/api/my/tickets', { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401) {
        clear(myTicketsList);
        myTicketsStatus.textContent = i18n('tickets.loginRequired');
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        throw new Error('load_failed');
      }
      renderMyTickets(body.items || []);
    } catch {
      clear(myTicketsList);
      myTicketsStatus.textContent = i18n('tickets.mineFailed');
    }
  }

  if (queryForm) queryForm.addEventListener('submit', queryTicket);
  if (feedbackForm) feedbackForm.addEventListener('submit', submitFeedback);
  if (datasheetForm) datasheetForm.addEventListener('submit', submitDatasheet);
  if (accountApplicationForm) accountApplicationForm.addEventListener('submit', submitAccountApplication);
  if (hasFileInput) hasFileInput.addEventListener('change', syncFileState);
  if (fileInput) fileInput.addEventListener('change', () => {
    const message = validateFiles(fileInput.files);
    if (feedbackStatus) feedbackStatus.textContent = message;
    if (hasFileInput && fileInput.files.length > 0) {
      hasFileInput.checked = true;
      syncFileState();
    }
  });
  if (datasheetFileInput) datasheetFileInput.addEventListener('change', () => {
    const message = validateFiles(datasheetFileInput.files, { requireFile: true });
    if (datasheetStatus) datasheetStatus.textContent = message;
  });

  syncFileState();
  initTicketSidebarCollapse();
  const initialTicketNo = new URLSearchParams(window.location.search).get('ticketNo');
  if (initialTicketNo && queryInput && queryForm) {
    queryInput.value = initialTicketNo;
    queryForm.requestSubmit();
  }
  loadMyTickets();
  window.addEventListener('localechange', () => {
    setTicketSidebarCollapsed(ticketSystemLayout?.classList.contains('sidebar-collapsed'), { skipStore: true });
    void loadMyTickets();
  });
})();
