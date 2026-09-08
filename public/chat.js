(function () {
  if (!window.AgentXAuth.requireLogin('/login')) {
    return;
  }

  const state = {
    sessions: [],
    activeSessionId: null,
    activeChipId: null,
    chips: [],
    scopePresets: [],
    selectedScopePresetId: '',
    eventSource: null,
    messages: [],
    nextMessageId: 0,
    activeAssistantMessageId: null,
    streamBuffers: new Map(),
    activityTimers: new Map(),
    chatMode: 'standard',
    scopeMode: 'single',
    scopeOptions: null,
    selectedScopeChipId: null,
    selectedGroups: [],
    scopeContentSearch: '',
    scopeGroupSearch: '',
    scopeContentOpen: false,
    scopeContentFilterBrand: '',
    scopeContentFilterProductLine: '',
    scopeCollapsed: false,
    searchModes: [],
    authorizedModels: [],
    creditBalanceUnits: null,
    uploadedImages: [],
    uploadedImageMarkdown: '',
    imageUploadGeneration: 0,
    imageUploadController: null,
    imageUploadPending: false,
    turnPhase: 'idle',
    turnSessionId: null,
    hiddenDuringActiveTurn: false,
    sessionSearchQuery: '',
    restoredScopeLabel: '',
    locale: 'zh-CN',
    firstChatStepRecorded: false,
    inFlight: false,
    userCancelled: false,
    streamReconnectAttempts: 0,
    streamReconnectTimer: null,
    turnTimeoutTimer: null,
    lastStreamActivityAt: 0,
    messageRevision: 0,
    activeSessionGeneration: 0,
    sessionRunEpochs: new Map(),
    sessionReconcileTimers: new Map(),
    sessionTerminalOverrides: new Map(),
    sessionTerminalRefreshTimers: new Map(),
    mobileSidebarReturnFocus: null
  };

  // 流可靠性常量：
  //   大范围两阶段检索最长允许 10 分钟无输出；前端取 10 分钟 + 1 分钟余量，
  //   到点后仍先查询服务端状态，绝不把仍在运行的北京全局检索误判为结束。
  //   重连退避上限与最大重连次数防止断流时无限重试。
  const STREAM_IDLE_TIMEOUT_MS = 11 * 60 * 1000;
  const STREAM_RECONNECT_BASE_MS = 1000;
  const STREAM_RECONNECT_MAX_MS = 30 * 1000;
  const STREAM_RECONNECT_MAX_ATTEMPTS = 5;
  const ACTIVE_STREAM_STORAGE_KEY = 'agentx.chat.activeStream';
  const SESSION_STATUS_RECONCILE_MS = 1500;
  const SESSION_TERMINAL_REFRESH_DELAYS_MS = [0, 250, 750, 1500, 3000];
  let initStarted = false;

  const lookupDotsFrames = ['', '.', '..', '...'];
  const visibleFingerprintPattern = /(?:^|\n)\s*\[?agentx-fp:v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\]?\s*(?=\n|$)/g;
  const allowedChatModes = new Set(['standard', 'enhanced', 'multimodal']);
  const modeOrder = ['standard', 'enhanced', 'multimodal'];
  const feedbackOptionValues = [
    'useful',
    'off-target',
    'missing-context',
    'bad-citation',
    'too-long',
    'safety-risk',
    'deeper-answer'
  ];

  function nextFeedbackVote(current, clicked) {
    if (current === clicked) return 'none';
    return clicked;
  }

  function toggleReasonSet(set, value) {
    if (set.has(value)) {
      set.delete(value);
      return false;
    }
    set.add(value);
    return true;
  }

  const els = {
    sessionList: document.getElementById('session-list'),
    sessionMeta: document.getElementById('session-meta'),
    conversation: document.getElementById('conversation'),
    messageForm: document.getElementById('message-form'),
    message: document.getElementById('message'),
    sendMessage: document.getElementById('send-message'),
    stopMessage: document.getElementById('stop-message'),
    newSession: document.getElementById('new-session'),
    sessionSearch: document.getElementById('session-search'),
    mobileSessionToggle: document.getElementById('mobile-session-toggle'),
    mobileSessionBackdrop: document.getElementById('mobile-session-backdrop'),
    logout: document.getElementById('logout'),
    error: document.getElementById('chat-error'),
    userStatus: document.getElementById('user-status'),
    chipSelect: document.getElementById('chip-select'),
    scopeSelect: document.getElementById('scope-select'),
    scopeSelector: document.getElementById('scope-selector'),
    scopeSteps: document.getElementById('scope-steps'),
    scopePillbar: document.getElementById('scope-pillbar'),
    scopeModeOptions: document.getElementById('scope-mode-options'),
    scopeContentPanel: document.getElementById('scope-content-panel'),
    adminLink: document.getElementById('admin-link'),
    chatGrid: document.getElementById('chat-grid'),
    portalTopbar: document.querySelector('.portal-topbar'),
    sessionSidebar: document.getElementById('session-sidebar'),
    chatWorkspace: document.querySelector('.chat-workspace'),
    chatSidebarToggle: document.getElementById('chat-sidebar-toggle'),
    chatModeOptions: document.getElementById('chat-mode-options'),
    capabilityStatus: document.getElementById('chat-capability-status'),
    chatModeInputs: Array.from(document.querySelectorAll('input[name="chat-mode"]')),
    imageUploadControl: document.getElementById('image-upload-control'),
    imageInput: document.getElementById('chat-image-input')
  };

  function setError(message) {
    if (els.error) els.error.textContent = message || '';
  }

  async function apiErrorFromResponse(response, fallbackMessage) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const detail = [payload?.error, payload?.message, payload?.details?.message]
      .find((value) => typeof value === 'string' && value.trim());
    const code = typeof payload?.code === 'string' && payload.code.trim() ? ` [${payload.code}]` : '';
    const status = response?.status ? ` (${response.status})` : '';
    const error = new Error(detail ? `${fallbackMessage}${status}: ${detail}${code}` : `${fallbackMessage}${status}`);
    error.status = response?.status || 0;
    error.sessionUnavailable = error.status === 404 || error.status === 410;
    return error;
  }

  function i18n(key, params) {
    return window.AgentXI18n?.t?.(key, params, state.locale) || key;
  }

  function i18nFormat(key, params) {
    return i18n(key, params);
  }

  function applyLocale(locale) {
    state.locale = window.AgentXI18n?.normalizeLocale?.(locale)
      || (locale === 'en-US' ? 'en-US' : 'zh-CN');
    window.AgentXI18n?.applyLocale?.(state.locale);
  }

  function lookupActivityText(locale = state.locale) {
    return window.AgentXI18n?.t?.('chat.activity.lookup', undefined, locale) || 'chat.activity.lookup';
  }

  function isLookupActivityText(text) {
    return text === lookupActivityText('zh-CN') || text === lookupActivityText('en-US');
  }

  function renderLocalizedChatUi() {
    renderSessions();
    renderSessionMeta();
    renderSearchModeOptions();
    renderScopeContentPanel();
    renderScopePillbar();
    renderMessages();
  }

  window.addEventListener('localechange', (event) => {
    const nextLocale = event?.detail?.locale || window.AgentXI18n?.getLocale?.();
    if (!nextLocale || nextLocale === state.locale) return;
    state.locale = nextLocale;
    renderLocalizedChatUi();
  });

  async function recordFirstChatOnboardingStep() {
    if (state.firstChatStepRecorded) {
      return;
    }
    state.firstChatStepRecorded = true;
    try {
      const user = window.AgentXAuth.getUser();
      const completed = new Set(user?.onboarding?.completedSteps || []);
      completed.add('first_chat');
      await window.AgentXAuth.authFetch('/api/account/onboarding', {
        method: 'PUT',
        body: JSON.stringify({
          status: 'in_progress',
          completedSteps: Array.from(completed)
        })
      });
    } catch {
      // Onboarding progress is helpful, but it must never block chat.
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Sidebar preferences are optional; storage failures must not block Chat.
    }
  }

  function isNarrowChatViewport() {
    return Boolean(window.matchMedia?.('(max-width: 860px)').matches);
  }

  function setMobileSidebarOpen(open) {
    if (!els.chatGrid) return;
    const nextOpen = Boolean(open && isNarrowChatViewport());
    els.chatGrid.classList.toggle('mobile-sidebar-open', nextOpen);
    els.mobileSessionToggle?.setAttribute('aria-expanded', String(nextOpen));
    if (els.sessionSidebar) {
      els.sessionSidebar.inert = isNarrowChatViewport() && !nextOpen;
      els.sessionSidebar.setAttribute('aria-hidden', String(isNarrowChatViewport() && !nextOpen));
      if (nextOpen) {
        els.sessionSidebar.setAttribute('role', 'dialog');
        els.sessionSidebar.setAttribute('aria-modal', 'true');
      } else {
        els.sessionSidebar.removeAttribute('role');
        els.sessionSidebar.removeAttribute('aria-modal');
      }
    }
    if (els.chatWorkspace) {
      els.chatWorkspace.inert = nextOpen;
    }
    if (els.portalTopbar) {
      els.portalTopbar.inert = nextOpen;
    }
    if (els.mobileSessionBackdrop) {
      els.mobileSessionBackdrop.hidden = !nextOpen;
    }
    if (nextOpen) {
      state.mobileSidebarReturnFocus = document.activeElement;
      window.requestAnimationFrame(() => els.newSession?.focus());
    } else if (state.mobileSidebarReturnFocus && isNarrowChatViewport()) {
      const returnFocus = state.mobileSidebarReturnFocus;
      state.mobileSidebarReturnFocus = null;
      window.requestAnimationFrame(() => returnFocus?.focus?.());
    }
  }

  function setChatSidebarCollapsed(collapsed, options = {}) {
    if (!els.chatGrid || !els.chatSidebarToggle) return;
    if (isNarrowChatViewport()) {
      els.chatGrid.classList.remove('sidebar-collapsed');
      els.chatSidebarToggle.setAttribute('aria-expanded', 'true');
      return;
    }
    els.chatGrid.classList.toggle('sidebar-collapsed', collapsed);
    els.chatSidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    els.chatSidebarToggle.textContent = collapsed ? '›' : '‹';
    els.chatSidebarToggle.title = collapsed
      ? i18n('chat.session.sidebar.expand')
      : i18n('chat.session.sidebar.collapse');
    if (!options.skipStore) {
      safeLocalStorageSet('agentx.chat.sidebarCollapsed', collapsed ? '1' : '0');
    }
  }

  function initChatSidebarCollapse() {
    if (!els.chatSidebarToggle) return;
    const stored = safeLocalStorageGet('agentx.chat.sidebarCollapsed');
    setMobileSidebarOpen(false);
    setChatSidebarCollapsed(isNarrowChatViewport() ? false : stored === '1', { skipStore: true });
    els.chatSidebarToggle.addEventListener('click', () => {
      if (isNarrowChatViewport()) {
        setMobileSidebarOpen(false);
        return;
      }
      setChatSidebarCollapsed(!els.chatGrid.classList.contains('sidebar-collapsed'));
    });
    els.mobileSessionToggle?.addEventListener('click', () => {
      setMobileSidebarOpen(!els.chatGrid.classList.contains('mobile-sidebar-open'));
    });
    els.mobileSessionBackdrop?.addEventListener('click', () => setMobileSidebarOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.chatGrid.classList.contains('mobile-sidebar-open')) {
        event.preventDefault();
        setMobileSidebarOpen(false);
      }
    });
    window.addEventListener('resize', () => {
      setMobileSidebarOpen(false);
      setChatSidebarCollapsed(isNarrowChatViewport() ? false : safeLocalStorageGet('agentx.chat.sidebarCollapsed') === '1', {
        skipStore: true
      });
    });
  }

  function nextClientId(prefix) {
    state.nextMessageId += 1;
    return `${prefix}-${Date.now()}-${state.nextMessageId}`;
  }

  function activeSession() {
    return state.sessions.find((session) => session.id === state.activeSessionId);
  }

  function isCurrentSessionGeneration(sessionId, generation) {
    return sessionId === state.activeSessionId && generation === state.activeSessionGeneration;
  }

  function sessionStateValue(session) {
    return session?.turnState || session?.status || '';
  }

  function isRunningSession(session) {
    return sessionStateValue(session) === 'running';
  }

  function updateSessionState(sessionId, nextState) {
    const session = state.sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    session.turnState = nextState;
    session.status = nextState;
    renderSessions();
    renderSessionMeta();
    syncComposerAvailability();
  }

  function beginSessionTurn(sessionId) {
    if (!sessionId) return 0;
    const epoch = (state.sessionRunEpochs.get(sessionId) || 0) + 1;
    state.sessionRunEpochs.set(sessionId, epoch);
    state.sessionTerminalOverrides.delete(sessionId);
    const terminalTimer = state.sessionTerminalRefreshTimers.get(sessionId);
    if (terminalTimer) window.clearTimeout(terminalTimer);
    state.sessionTerminalRefreshTimers.delete(sessionId);
    updateSessionState(sessionId, 'running');
    return epoch;
  }

  function trackRunningSession(sessionId) {
    if (!sessionId) return;
    let epoch = state.sessionRunEpochs.get(sessionId);
    if (!epoch) {
      epoch = 1;
      state.sessionRunEpochs.set(sessionId, epoch);
    }
    updateSessionState(sessionId, 'running');
    scheduleSessionStatusReconciliation(sessionId, epoch);
  }

  function completeSessionTurn(sessionId, terminalState = 'idle') {
    if (!sessionId) return;
    state.sessionRunEpochs.set(sessionId, (state.sessionRunEpochs.get(sessionId) || 0) + 1);
    const timer = state.sessionReconcileTimers.get(sessionId);
    if (timer) window.clearTimeout(timer);
    state.sessionReconcileTimers.delete(sessionId);
    state.sessionTerminalOverrides.set(sessionId, terminalState === 'running' ? 'idle' : terminalState);
    updateSessionState(sessionId, terminalState === 'running' ? 'idle' : terminalState);
    scheduleTerminalListConvergence(sessionId);
  }

  function scheduleSessionStatusReconciliation(sessionId, epoch, delay = SESSION_STATUS_RECONCILE_MS) {
    if (!sessionId || state.sessionReconcileTimers.has(sessionId)) return;
    const timer = window.setTimeout(() => {
      state.sessionReconcileTimers.delete(sessionId);
      if (state.sessionRunEpochs.get(sessionId) !== epoch) return;
      pollSessionStatus(sessionId)
        .then((status) => {
          if (state.sessionRunEpochs.get(sessionId) !== epoch) return;
          if (status === 'running') {
            updateSessionState(sessionId, 'running');
            scheduleSessionStatusReconciliation(sessionId, epoch);
            return;
          }
          if (sessionId === state.activeSessionId && state.turnSessionId === sessionId) {
            const generation = state.activeSessionGeneration;
            const expectedRunEpoch = epoch;
            const userTurn = latestUserTurnReference(sessionId);
            return refreshTerminalTurnWithRetry(sessionId, generation, expectedRunEpoch, userTurn)
              .then((settled) => {
                if (!settled || !isCurrentSessionGeneration(sessionId, generation)
                  || state.sessionRunEpochs.get(sessionId) !== expectedRunEpoch) return;
                completeSessionTurn(sessionId, status || 'idle');
                closeStream();
                finishTurn(sessionId);
              })
              .catch((error) => {
                if (isUnavailableSessionStatusError(error) || error?.status === 403) {
                  void finishUnavailableSession(sessionId, error, generation);
                  return;
                }
                if (isCurrentSessionGeneration(sessionId, generation)
                  && state.sessionRunEpochs.get(sessionId) === expectedRunEpoch) {
                  setError(error.message || i18n('chat.error.streamStatus'));
                  scheduleSessionStatusReconciliation(sessionId, expectedRunEpoch);
                }
              });
          }
          completeSessionTurn(sessionId, status || 'idle');
        })
        .catch((error) => {
          if (error?.status === 403 || isUnavailableSessionStatusError(error)) {
            if (sessionId === state.activeSessionId && state.turnSessionId === sessionId) {
              const generation = state.activeSessionGeneration;
              void finishUnavailableSession(sessionId, error, generation);
              return;
            }
            completeSessionTurn(sessionId, 'failed');
            loadSessions().catch(() => undefined);
          } else if (state.sessionRunEpochs.get(sessionId) === epoch) {
            scheduleSessionStatusReconciliation(sessionId, epoch);
          }
        });
    }, delay);
    state.sessionReconcileTimers.set(sessionId, timer);
  }

  function scheduleTerminalListConvergence(sessionId, attempt = 0) {
    if (!sessionId || !state.sessionTerminalOverrides.has(sessionId)) return;
    if (state.sessionTerminalRefreshTimers.has(sessionId)) return;
    const delay = SESSION_TERMINAL_REFRESH_DELAYS_MS[Math.min(attempt, SESSION_TERMINAL_REFRESH_DELAYS_MS.length - 1)];
    const timer = window.setTimeout(() => {
      state.sessionTerminalRefreshTimers.delete(sessionId);
      loadSessions()
        .catch(() => undefined)
        .finally(() => {
          if (state.sessionTerminalOverrides.has(sessionId)
            && attempt + 1 < SESSION_TERMINAL_REFRESH_DELAYS_MS.length) {
            scheduleTerminalListConvergence(sessionId, attempt + 1);
          }
        });
    }, delay);
    state.sessionTerminalRefreshTimers.set(sessionId, timer);
  }

  async function loadSearchModes() {
    const response = await window.AgentXAuth.authFetch('/api/search-modes');
    if (!response.ok) {
      throw await apiErrorFromResponse(response, i18n('chat.error.loadModes'));
    }
    const payload = await response.json();
    state.searchModes = normalizeSearchModes(payload.modes || []);
    renderSearchModeOptions();
    setChatMode(firstAvailableMode());
  }

  function normalizeSearchModes(modes) {
    return modes
      .filter((mode) => mode && allowedChatModes.has(mode.id))
      .sort((left, right) => modeOrder.indexOf(left.id) - modeOrder.indexOf(right.id))
      .map((mode) => ({
        id: mode.id,
        label: String(mode.label || chatModeLabel(mode.id)),
        description: String(mode.description || ''),
        defaultModelId: typeof mode.defaultModelId === 'string' ? mode.defaultModelId : '',
        modelLabel: String(mode.modelLabel || mode.defaultModelId || ''),
        creditUnits: Number.isInteger(mode.creditUnits) ? mode.creditUnits : null,
        available: Boolean(mode.available),
        selectable: Boolean(mode.selectable),
        allowsImageInput: Boolean(mode.allowsImageInput),
        locked: Boolean(mode.locked),
        disabledReason: typeof mode.disabledReason === 'string' ? mode.disabledReason : '',
        disabledReasons: Array.isArray(mode.disabledReasons) ? mode.disabledReasons : []
      }));
  }

  function renderSearchModeOptions() {
    if (!els.chatModeOptions) return;
    els.chatModeOptions.replaceChildren();
    for (const mode of state.searchModes) {
      const label = document.createElement('label');
      label.className = 'chat-mode-segment';
      label.dataset.mode = mode.id;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'chat-mode';
      input.value = mode.id;
      input.checked = mode.id === state.chatMode;
      input.addEventListener('change', () => {
        if (!canChangeChatMode()) {
          input.checked = input.value === state.chatMode;
          return;
        }
        setChatMode(input.value);
      });

      const content = document.createElement('span');
      content.className = 'chat-mode-segment-content';

      const title = document.createElement('span');
      title.className = 'chat-mode-title';
      title.textContent = chatModeLabel(mode.id);

      content.append(title);
      label.append(input, content);
      els.chatModeOptions.append(label);
    }
    refreshChatModeInputs();
    syncChatModeControls();
  }

  function refreshChatModeInputs() {
    els.chatModeInputs = Array.from(document.querySelectorAll('input[name="chat-mode"]'));
  }

  function selectedChatMode() {
    const selected = els.chatModeInputs.find((input) => input.checked)?.value || state.chatMode || '';
    return allowedChatModes.has(selected) ? selected : '';
  }

  function setChatMode(mode, options = {}) {
    const requested = allowedChatModes.has(mode) ? mode : undefined;
    state.chatMode = requested && (options.force || isModeSelectable(requested)) ? requested : firstAvailableMode();
    for (const input of els.chatModeInputs) {
      input.checked = input.value === state.chatMode;
    }
    if (!selectedModeAllowsImageInput()) {
      clearPendingImages();
    }
    syncChatModeControls();
  }

  function canChangeChatMode() {
    return !state.activeSessionId && state.messages.filter((message) => message.id !== 'empty-session').length === 0;
  }

  function syncChatModeControls() {
    const locked = !canChangeChatMode();
    const canUploadImages = selectedModeAllowsImageInput();
    for (const input of els.chatModeInputs) {
      const mode = searchModeById(input.value);
      input.disabled = locked || !mode?.selectable || !mode.available;
      const segment = input.closest('.chat-mode-segment');
      segment?.classList.toggle('selected', input.value === state.chatMode);
      segment?.classList.toggle('disabled', input.disabled);
      segment?.classList.toggle('locked', locked);
    }
    if (els.imageUploadControl) {
      els.imageUploadControl.hidden = false;
      els.imageUploadControl.classList.toggle('disabled', !canUploadImages || state.imageUploadPending);
      els.imageUploadControl.title = imageUploadHint(locked, canUploadImages);
    }
    if (els.imageInput) {
      els.imageInput.disabled = !canUploadImages || state.imageUploadPending;
      if (!canUploadImages) {
        clearPendingImages();
      }
    }
    syncComposerAvailability();
    syncScopeLock();
  }

  function firstAvailableMode() {
    for (const mode of modeOrder) {
      if (isModeSelectable(mode)) return mode;
    }
    return '';
  }

  function hasSelectableMode() {
    return state.searchModes.some((mode) => mode.selectable && mode.available);
  }

  function modeUnavailableMessage(modeId = '') {
    const candidates = modeId
      ? state.searchModes.filter((mode) => mode.id === modeId)
      : state.searchModes;
    const reason = candidates
      .flatMap((mode) => [mode.disabledReason, ...(mode.disabledReasons || []).map((entry) => entry?.message)])
      .find((value) => typeof value === 'string' && value.trim());
    return reason || i18n('chat.error.noModes');
  }

  function isTurnBusy() {
    return state.turnPhase !== 'idle';
  }

  function setTurnPhase(phase, options = {}) {
    const allowed = new Set(['idle', 'submitting', 'running', 'stopping']);
    state.turnPhase = allowed.has(phase) ? phase : 'idle';
    state.turnSessionId = state.turnPhase === 'idle'
      ? null
      : (options.sessionId || state.turnSessionId || state.activeSessionId || null);
    state.inFlight = state.turnPhase !== 'idle';
    syncComposerAvailability();
  }

  function finishTurn(sessionId) {
    if (sessionId && state.turnSessionId && sessionId !== state.turnSessionId) return;
    clearRunningAssistantPlaceholder(sessionId || state.turnSessionId || state.activeSessionId);
    setTurnPhase('idle');
  }

  function syncComposerAvailability() {
    const noMode = !hasSelectableMode();
    const selectedModeUnavailable = !isModeSelectable(selectedChatMode());
    const scopeRestartRequired = Boolean(activeSession()?.requiresNewScopeQuery);
    const composerUnavailable = noMode || selectedModeUnavailable || scopeRestartRequired;
    const busy = isTurnBusy();
    const uploadPending = state.imageUploadPending;
    if (els.message) {
      els.message.disabled = composerUnavailable;
      els.message.setAttribute('aria-disabled', String(composerUnavailable));
    }
    if (els.sendMessage) {
      els.sendMessage.disabled = composerUnavailable || busy || uploadPending;
    }
    if (els.stopMessage) {
      const stoppable = state.turnPhase === 'running' || state.turnPhase === 'stopping';
      els.stopMessage.hidden = !stoppable;
      els.stopMessage.disabled = state.turnPhase === 'stopping';
    }
    if (els.capabilityStatus) {
      els.capabilityStatus.hidden = !composerUnavailable;
      els.capabilityStatus.textContent = scopeRestartRequired
        ? i18n('chat.session.restartRequired')
        : composerUnavailable
          ? modeUnavailableMessage(noMode ? '' : selectedChatMode())
          : '';
    }
    const navigationLocked = state.turnPhase === 'submitting';
    if (els.newSession) {
      els.newSession.disabled = navigationLocked;
    }
    for (const row of els.sessionList?.querySelectorAll('.session-row') || []) {
      row.disabled = navigationLocked;
    }
  }

  function isModeSelectable(mode) {
    const entry = searchModeById(mode);
    return Boolean(entry?.selectable && entry.available);
  }

  function selectedMode() {
    return searchModeById(selectedChatMode());
  }

  function selectedModeAllowsImageInput() {
    const mode = selectedMode();
    return Boolean(mode?.id === 'multimodal' && mode.available && mode.selectable && mode.allowsImageInput);
  }

  function searchModeById(mode) {
    return state.searchModes.find((entry) => entry.id === mode);
  }

  function imageUploadHint(locked, canUploadImages) {
    if (canUploadImages) {
      return state.imageUploadPending
        ? i18n('chat.image.uploading')
        : (locked ? i18n('chat.image.addCurrentHint') : i18n('chat.image.addHint'));
    }
    const mode = selectedMode();
    return mode?.id === 'multimodal'
      ? (mode.disabledReason || i18n('chat.error.noModes'))
      : i18n('chat.image.unavailable');
  }

  function clearPendingImages(options = {}) {
    if (options.abort !== false) {
      state.imageUploadGeneration += 1;
      state.imageUploadController?.abort();
    }
    state.imageUploadController = null;
    state.imageUploadPending = false;
    if (els.imageInput) {
      els.imageInput.value = '';
    }
    state.uploadedImages = [];
    if (state.uploadedImageMarkdown && els.message.value.includes(state.uploadedImageMarkdown)) {
      els.message.value = els.message.value
        .replace(state.uploadedImageMarkdown, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimStart();
    }
    state.uploadedImageMarkdown = '';
    if (!options.skipSync) syncComposerAvailability();
  }

  function normalizeSession(session) {
    const scopeDescriptor = normalizeScopeDescriptor(session);
    return {
      ...session,
      id: session.id || session.sessionId,
      chatMode: allowedChatModes.has(session.chatMode) ? session.chatMode : 'standard',
      scopeDescriptor
    };
  }

  function normalizeScopeDescriptor(session = {}) {
    const raw = session.scopeDescriptor && typeof session.scopeDescriptor === 'object'
      ? session.scopeDescriptor
      : {};
    const workspace = session.scopeWorkspace && typeof session.scopeWorkspace === 'object'
      ? session.scopeWorkspace
      : {};
    const presetId = String(session.scopePresetId || raw.scopePresetId || workspace.scopePresetId || '');
    let mode = raw.mode || session.scopeMode || workspace.scopeMode || '';
    if (!SCOPE_MODES.includes(mode)) mode = '';
    if (!mode && presetId === 'dynamic-global') mode = 'global';
    if (!mode && presetId === 'dynamic-group') mode = 'group';
    if (!mode && (session.chipId || raw.chipId)) mode = 'single';
    if (!SCOPE_MODES.includes(mode)) mode = 'single';
    const groups = [raw.groups, session.scopeGroups, workspace.groups]
      .find((value) => Array.isArray(value)) || [];
    return {
      mode,
      chipId: raw.chipId || session.chipId || null,
      groups: groups
        .filter((group) => group && typeof group.dimension === 'string' && typeof group.value === 'string')
        .map((group) => ({ dimension: group.dimension, value: group.value })),
      label: String(raw.label || workspace.label || session.scopeLabel || ''),
      scopePresetId: presetId
    };
  }

  function sessionScopeLabel(session) {
    const descriptor = session.scopeDescriptor || normalizeScopeDescriptor(session);
    if (descriptor.mode === 'global') return descriptor.label || i18n('chat.scope.summary.global');
    if (descriptor.mode === 'group') {
      const labels = descriptor.groups.map((group) => scopeGroupLabel(group));
      return descriptor.label || labels.join('、') || i18n('chat.scope.summary.group');
    }
    return session.chipLabel || scopeChipLabel(descriptor.chipId || session.chipId) || '-';
  }

  function restoreScopeFromSession(session) {
    const descriptor = session?.scopeDescriptor || normalizeScopeDescriptor(session || {});
    state.scopeMode = descriptor.mode;
    state.selectedGroups = descriptor.groups.map((group) => ({ ...group }));
    state.selectedScopeChipId = descriptor.chipId || session?.chipId || null;
    state.restoredScopeLabel = descriptor.label || '';
    state.scopeContentOpen = false;
    renderScopeModes();
    renderScopeContentPanel();
  }

  function renderSessions() {
    els.sessionList.replaceChildren();
    const query = state.sessionSearchQuery.trim().toLowerCase();
    const sessions = query
      ? state.sessions.filter((session) => {
          const haystack = [
            session.title,
            session.task,
            session.chipId,
            sessionScopeLabel(session),
            session.turnState,
            session.status
          ].filter(Boolean).join(' ').toLowerCase();
          return haystack.includes(query);
        })
      : state.sessions;
    if (sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = query ? i18n('chat.session.search.empty') : i18n('chat.session.empty');
      els.sessionList.append(empty);
      return;
    }

    for (const session of sessions) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `session-row ${session.id === state.activeSessionId ? 'active' : ''}`;
      const chipLabel = sessionScopeLabel(session);
      const title = session.title || session.task || String(session.id).slice(0, 8);
      const stateLabel = session.turnState === 'running' || session.status === 'running'
        ? i18n('chat.session.running')
        : i18n('chat.session.history');
      row.textContent = `${chipLabel} / ${stateLabel} / ${title}`;
      row.addEventListener('click', () => {
        if (state.turnPhase === 'submitting') {
          setError(i18n('chat.session.switchBlocked'));
          return;
        }
        setMobileSidebarOpen(false);
        selectSession(session.id).catch((error) => setError(error.message || i18n('chat.error.restore')));
      });
      els.sessionList.append(row);
    }
  }

  function renderSessionMeta() {
    const session = activeSession();
    if (!session) {
      els.sessionMeta.hidden = true;
      els.sessionMeta.textContent = '';
      return;
    }
    const title = session.title || session.task || String(session.id).slice(0, 8);
    els.sessionMeta.textContent = i18nFormat('chat.session.current', { title });
    els.sessionMeta.hidden = false;
  }

  function chatModeLabel(mode) {
    return allowedChatModes.has(mode) ? i18n(`chat.mode.${mode}`) : i18n('chat.mode.standard');
  }

  function modelLabelForId(modelId) {
    if (!modelId) return '';
    const mode = state.searchModes.find((entry) => entry.defaultModelId === modelId);
    return mode?.modelLabel || modelId;
  }

  function renderMessages() {
    clearActivityTimers();
    els.conversation.replaceChildren();
    if (state.messages.length === 0) {
      appendMessageElement({
        id: 'empty-session',
        role: 'assistant',
        text: i18n('chat.session.created')
      });
      return;
    }
    for (const message of state.messages) {
      appendMessageElement(message);
    }
    els.conversation.scrollTop = els.conversation.scrollHeight;
  }

  function classifyAssistantError(text) {
    const raw = String(text || '');
    const trimmed = raw.trim();
    if (!trimmed) {
      return { isError: false };
    }
    if (trimmed.length >= 320) {
      return { isError: false };
    }

    const authPattern = /invalid authentication credentials|\b401\b[\s\S]{0,40}(?:invalid|auth)|failed to authenticate/i;
    const rateLimitPattern = /hit your (?:session|usage) limit|\brate limit\b|\bquota\b/i;
    const timeoutPattern = /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED)\b|request timed out|connect ETIMEDOUT/i;
    const apiErrorPattern = /\bAPI Error\b/i;

    if (authPattern.test(trimmed)) {
      return {
        isError: true,
        kind: 'auth',
        friendly: i18n('chat.error.authDetail'),
        retryable: true
      };
    }

    if (rateLimitPattern.test(trimmed)) {
      const reset = trimmed.match(/resets?\s+([^\n.;·]+?)(?:\s*[·.;\n]|$)/i);
      const resetText = reset ? reset[1].trim() : '';
      const friendly = resetText
        ? i18n('chat.error.rateLimitReset', { reset: resetText })
        : i18n('chat.error.rateLimitDetail');
      return { isError: true, kind: 'rate-limit', friendly, retryable: true };
    }

    if (timeoutPattern.test(trimmed)) {
      return {
        isError: true,
        kind: 'timeout',
        friendly: i18n('chat.error.timeoutDetail'),
        retryable: true
      };
    }

    if (apiErrorPattern.test(trimmed) || /^error[:\s]/i.test(trimmed)) {
      return {
        isError: true,
        kind: 'generic',
        friendly: i18n('chat.error.genericDetail'),
        retryable: true
      };
    }

    return { isError: false };
  }

  function renderErrorCard(message, classification, rawText) {
    const card = document.createElement('div');
    card.className = 'message-error-card';
    card.dataset.errorKind = classification.kind || 'generic';

    const title = document.createElement('div');
    title.className = 'message-error-card__title';
    title.textContent = {
      auth: i18n('chat.error.auth'),
      'rate-limit': i18n('chat.error.rateLimit'),
      timeout: i18n('chat.error.timeout'),
      generic: i18n('chat.error.generic')
    }[classification.kind] || i18n('chat.error.generic');
    card.append(title);

    const bodyText = document.createElement('p');
    bodyText.className = 'message-error-card__body';
    bodyText.textContent = classification.friendly || i18n('chat.error.genericDetail');
    card.append(bodyText);

    const actions = document.createElement('div');
    actions.className = 'message-error-card__actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'message-error-card__retry';
    retry.textContent = i18n('chat.retry');
    if (classification.retryable === false) {
      retry.disabled = true;
    }
    retry.addEventListener('click', () => retryAssistantTurn(message));
    actions.append(retry);
    card.append(actions);

    const details = document.createElement('details');
    details.className = 'message-error-card__details';
    const summary = document.createElement('summary');
    summary.textContent = i18n('chat.details.title');
    details.append(summary);
    const raw = document.createElement('pre');
    raw.className = 'message-error-card__raw';
    raw.textContent = String(rawText || '');
    details.append(raw);
    card.append(details);

    return card;
  }

  function retryAssistantTurn(message) {
    const userText = findUserInputForAssistant(message);
    if (!userText) {
      setError(i18n('chat.message.retryMissing'));
      return;
    }
    if (els.message.value.trim()) {
      setError(i18n('chat.message.retryDraftConflict'));
      return;
    }
    els.message.value = userText;
    sendMessage({ preventDefault() {} });
  }

  function findUserInputForAssistant(message) {
    const index = state.messages.findIndex((item) => item.id === message.id);
    const searchFrom = index === -1 ? state.messages.length - 1 : index - 1;
    for (let i = searchFrom; i >= 0; i -= 1) {
      const candidate = state.messages[i];
      if (candidate.role === 'user') {
        return stripVisibleFingerprintMarker(candidate.text);
      }
    }
    return '';
  }

  function appendMessageElement(message) {
    const item = document.createElement('div');
    item.className = `message ${message.role}${message.status ? ` ${message.status}` : ''}`;
    item.dataset.clientId = message.id;
    if (message.status) {
      item.dataset.status = message.status;
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const body = document.createElement('div');
    body.className = 'message-text message-content';
    const visibleText = stripVisibleFingerprintMarker(message.text);
    if (message.status === 'streaming' && isLookupActivityText(message.text)) {
      body.textContent = visibleText;
      const dots = document.createElement('span');
      dots.className = 'message-activity-dots';
      dots.setAttribute('aria-hidden', 'true');
      body.append(dots);
      startActivityDots(message.id, dots);
    } else {
      renderMessageContent(body, visibleText);
    }
    bubble.append(body);
    const errorClassification = message.role === 'assistant' && !message.status && message.id !== 'empty-session'
      ? classifyAssistantError(visibleText)
      : { isError: false };
    if (errorClassification.isError) {
      bubble.classList.add('is-error');
      body.replaceChildren(renderErrorCard(message, errorClassification, visibleText));
    }
    if (!errorClassification.isError && message.role === 'assistant' && message.id !== 'empty-session') {
      bubble.append(renderCitationBlock(message));
    }
    item.append(bubble);

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (message.id !== 'empty-session') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-action-button message-icon-button';
      copy.setAttribute('aria-label', i18n('chat.copy'));
      copy.title = i18n('chat.copy');
      copy.append(createIcon('copy'));
      copy.addEventListener('click', () => copyMessageText(visibleText, copy));
      actions.append(copy);
    }
    if (!errorClassification.isError && message.role === 'assistant' && !message.status && message.id !== 'empty-session') {
      actions.append(createFeedbackPanel(message, visibleText));
    }
    item.append(actions);

    if (message.status === 'pending' || message.status === 'failed') {
      const status = document.createElement('span');
      status.className = 'message-status';
      status.textContent = message.status === 'failed'
        ? i18n('chat.message.failed')
        : i18n('chat.message.sending');
      item.append(status);
    }

    els.conversation.append(item);
    syncChatModeControls();
  }

  function renderMessageContent(container, text) {
    container.replaceChildren();
    const source = String(text || '');
    if (!source.trim()) {
      container.textContent = '';
      return;
    }

    // 逐行按块级标记分块的小分词器：不依赖空行分隔，单换行即可正确还原
    // 标题 / 表格 / 分隔线 / 引用 / 列表 / 围栏代码 / 段落（不引任何 markdown 库）。
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    const isHeading = (s) => /^#{1,3}\s+/.test(s);
    const isHr = (s) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(s);
    const isQuote = (s) => /^>\s?/.test(s);
    const isList = (s) => /^[-*]\s+/.test(s) || /^\d+\.\s+/.test(s);
    const isTableStart = (idx) =>
      lines[idx].includes('|') &&
      idx + 1 < lines.length &&
      isMarkdownTable(`${lines[idx]}\n${lines[idx + 1]}`);
    let i = 0;
    while (i < lines.length) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) { i++; continue; }                       // 空行＝块分隔，跳过
      if (line.startsWith('```')) {                       // 围栏代码块
        const buf = [raw];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i]); i++; }
        container.append(renderCodeBlock(buf.join('\n')));
        continue;
      }
      if (isTableStart(i)) {                               // 表格（先于 hr，避免与 |---| 相撞）
        const buf = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { buf.push(lines[i]); i++; }
        container.append(renderTable(buf.join('\n')));
        continue;
      }
      if (isHeading(line)) {
        const level = Math.min(3, line.match(/^#+/)[0].length);
        const heading = document.createElement(`h${level + 2}`);
        appendInlineMarkdown(heading, line.replace(/^#{1,3}\s+/, ''));
        container.append(heading);
        i++; continue;
      }
      if (isHr(line)) { container.append(document.createElement('hr')); i++; continue; }
      if (isQuote(line)) {
        const buf = [];
        while (i < lines.length && isQuote(lines[i].trim())) { buf.push(lines[i].trim().replace(/^>\s?/, '')); i++; }
        const quote = document.createElement('blockquote');
        appendInlineMarkdown(quote, buf.join('\n'));
        container.append(quote);
        continue;
      }
      if (isList(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim() && isList(lines[i].trim())) { buf.push(lines[i].trim()); i++; }
        container.append(renderList(buf.join('\n')));
        continue;
      }
      const buf = [];                                     // 段落：消费连续普通行直到空行或块级起始
      while (
        i < lines.length && lines[i].trim() &&
        !lines[i].trim().startsWith('```') && !isHeading(lines[i].trim()) &&
        !isHr(lines[i].trim()) && !isQuote(lines[i].trim()) && !isList(lines[i].trim()) && !isTableStart(i)
      ) { buf.push(lines[i].trim()); i++; }
      if (buf.length) {
        const paragraph = document.createElement('p');
        appendInlineMarkdown(paragraph, buf.join('\n'));
        container.append(paragraph);
      }
    }
  }

  function renderCodeBlock(block) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
    pre.append(code);
    return pre;
  }

  function isMarkdownTable(block) {
    const lines = block.split('\n').map((line) => line.trim());
    return lines.length >= 2 && lines[0].includes('|') && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(lines[1]);
  }

  function renderTable(block) {
    const wrapper = document.createElement('div');
    wrapper.className = 'message-table-wrap';
    const table = document.createElement('table');
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const headerCells = splitTableRow(lines[0]);
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const cell of headerCells) {
      const th = document.createElement('th');
      appendInlineMarkdown(th, cell);
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const line of lines.slice(2)) {
      const row = document.createElement('tr');
      for (const cell of splitTableRow(line)) {
        const td = document.createElement('td');
        appendInlineMarkdown(td, cell);
        row.append(td);
      }
      tbody.append(row);
    }
    table.append(tbody);
    wrapper.append(table);
    return wrapper;
  }

  function splitTableRow(line) {
    return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  }

  function renderList(block) {
    const ordered = /^\d+\.\s+/.test(block.trim());
    const list = document.createElement(ordered ? 'ol' : 'ul');
    for (const line of block.split('\n')) {
      const text = line.replace(/^([-*]|\d+\.)\s+/, '').trim();
      if (!text) continue;
      const li = document.createElement('li');
      appendInlineMarkdown(li, text);
      list.append(li);
    }
    return list;
  }

  function appendInlineMarkdown(parent, text) {
    const pattern = /(!?\[([^\]]*)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)/g;
    let cursor = 0;
    for (const match of String(text || '').matchAll(pattern)) {
      if (match.index > cursor) {
        parent.append(document.createTextNode(text.slice(cursor, match.index)));
      }
      if (match[1]) {
        const alt = match[2] || '';
        const url = (match[3] || '').trim();
        if (match[1].startsWith('!')) {
          const image = renderSafeImage(url, alt);
          parent.append(image || document.createTextNode(
            alt ? `[${i18n('chat.image.filtered')}: ${alt}]` : `[${i18n('chat.image.filtered')}]`
          ));
        } else {
          parent.append(renderSafeLink(url, alt));
        }
      } else if (match[4]) {
        const code = document.createElement('code');
        code.textContent = match[5] || '';
        parent.append(code);
      } else if (match[6]) {
        const strong = document.createElement('strong');
        strong.textContent = match[7] || '';
        parent.append(strong);
      } else if (match[8]) {
        const em = document.createElement('em');
        em.textContent = match[9] || '';
        parent.append(em);
      }
      cursor = (match.index || 0) + match[0].length;
    }
    if (cursor < text.length) {
      parent.append(document.createTextNode(text.slice(cursor)));
    }
  }

  function renderSafeLink(url, label) {
    if (!isSafeLinkUrl(url)) {
      return document.createTextNode(label || url);
    }
    const link = document.createElement('a');
    link.href = url;
    link.textContent = label || url;
    if (/^https?:\/\//i.test(url)) {
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
    }
    return link;
  }

  function renderSafeImage(url, alt) {
    if (!isInternalImageUrl(url)) {
      return null;
    }
    const image = document.createElement('img');
    image.src = url;
    image.alt = alt || i18n('chat.image.platformAlt');
    image.loading = 'lazy';
    image.referrerPolicy = 'same-origin';
    return image;
  }

  function isSafeLinkUrl(url) {
    const value = String(url || '').trim();
    return /^\/(?!\/)/.test(value) || /^https?:\/\//i.test(value);
  }

  function isInternalImageUrl(url) {
    const value = String(url || '').trim();
    return /^\/api\/chat-uploads\//.test(value) || /^\/downloads\//.test(value) || /^\/assets\//.test(value);
  }

  function createIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const paths = {
      copy: ['M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z', 'M5 15H4a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v1'],
      check: ['M20 6 9 17l-5-5'],
      'thumb-up': ['M7 10v12', 'M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z'],
      'thumb-down': ['M17 14V2', 'M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z']
    };
    for (const d of (paths[name] || [])) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  async function copyMessageText(text, button) {
    const restoreCopyIcon = () => { button.replaceChildren(createIcon('copy')); };
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        fallbackCopyText(text);
      }
      button.replaceChildren(createIcon('check'));
      button.classList.add('copied');
      window.setTimeout(() => { restoreCopyIcon(); button.classList.remove('copied'); }, 1200);
    } catch {
      button.title = i18n('chat.copy.failed');
      window.setTimeout(() => { button.title = i18n('chat.copy'); }, 1200);
    }
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy');
    textarea.remove();
    if (!copied) {
      throw new Error(i18n('chat.copy.unavailable'));
    }
  }

  let openFeedbackPopoverCloser = null;
  function closeOpenFeedbackPopover() {
    if (openFeedbackPopoverCloser) {
      const close = openFeedbackPopoverCloser;
      openFeedbackPopoverCloser = null;
      close();
    }
  }

  function createFeedbackPanel(message, text) {
    const panel = document.createElement('div');
    panel.className = 'message-feedback';
    let feedbackVote = 'none';
    const selectedReasons = new Set();
    let lastSubmittedSignature = '';

    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'message-icon-button message-feedback-thumb';
    up.dataset.feedback = 'up';
    up.setAttribute('aria-label', i18n('chat.feedback.useful'));
    up.title = i18n('chat.feedback.useful');
    up.setAttribute('aria-pressed', 'false');
    up.append(createIcon('thumb-up'));

    const down = document.createElement('button');
    down.type = 'button';
    down.className = 'message-icon-button message-feedback-thumb';
    down.dataset.feedback = 'down';
    down.setAttribute('aria-label', i18n('chat.feedback.problem'));
    down.title = i18n('chat.feedback.problem');
    down.setAttribute('aria-pressed', 'false');
    down.append(createIcon('thumb-down'));

    const status = document.createElement('span');
    status.className = 'message-feedback-status';

    const popover = document.createElement('div');
    popover.className = 'message-feedback-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', i18n('chat.feedback.reasonLabel'));
    popover.hidden = true;

    const arrow = document.createElement('span');
    arrow.className = 'message-feedback-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    popover.append(arrow);

    const chipRow = document.createElement('div');
    chipRow.className = 'message-feedback-chips';
    const chipByValue = new Map();
    for (const value of feedbackOptionValues.slice(1)) {
      const label = i18n(`chat.feedback.reason.${value}`);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'feedback-chip';
      chip.dataset.reason = value;
      chip.textContent = label;
      chip.setAttribute('aria-pressed', 'false');
      chip.addEventListener('click', () => toggleReason(value, chip));
      chipByValue.set(value, chip);
      chipRow.append(chip);
    }
    popover.append(chipRow);

    const noteToggle = document.createElement('button');
    noteToggle.type = 'button';
    noteToggle.className = 'message-feedback-note-toggle';
    noteToggle.textContent = i18n('chat.feedback.note');
    noteToggle.setAttribute('aria-expanded', 'false');

    const noteBox = document.createElement('div');
    noteBox.className = 'message-feedback-note-box';
    noteBox.hidden = true;
    const note = document.createElement('textarea');
    note.className = 'message-feedback-note';
    note.rows = 2;
    note.placeholder = i18n('chat.feedback.notePlaceholder');
    const noteSubmit = document.createElement('button');
    noteSubmit.type = 'button';
    noteSubmit.className = 'message-feedback-note-submit';
    noteSubmit.textContent = i18n('chat.feedback.noteSubmit');
    noteBox.append(note, noteSubmit);

    noteToggle.addEventListener('click', () => {
      const willOpen = noteBox.hidden;
      noteBox.hidden = !willOpen;
      noteToggle.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) note.focus();
    });
    noteSubmit.addEventListener('click', () => submitFeedbackNote());
    popover.append(noteToggle, noteBox);

    function syncThumbs() {
      up.setAttribute('aria-pressed', String(feedbackVote === 'up'));
      down.setAttribute('aria-pressed', String(feedbackVote === 'down'));
      up.classList.toggle('dim', feedbackVote === 'down');
      down.classList.toggle('dim', feedbackVote === 'up');
    }

    function openPopover() {
      closeOpenFeedbackPopover();
      popover.hidden = false;
      openFeedbackPopoverCloser = closePopover;
      document.addEventListener('pointerdown', onOutsidePointer, true);
      document.addEventListener('keydown', onEscKey, true);
    }

    function closePopover() {
      void flushFeedback();
      popover.hidden = true;
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      document.removeEventListener('keydown', onEscKey, true);
      if (openFeedbackPopoverCloser === closePopover) openFeedbackPopoverCloser = null;
    }

    function onOutsidePointer(event) {
      if (!popover.contains(event.target) && event.target !== down) closePopover();
    }

    function onEscKey(event) {
      if (event.key === 'Escape') {
        closePopover();
        down.focus();
      }
    }

    function toggleReason(value, chip) {
      const nowSelected = toggleReasonSet(selectedReasons, value);
      chip.classList.toggle('sel', nowSelected);
      chip.setAttribute('aria-pressed', String(nowSelected));
    }

    async function flushFeedback() {
      const reasons = Array.from(selectedReasons);
      const noteText = note.value.trim();
      if (reasons.length === 0 && !noteText) return;
      const signature = `${reasons.slice().sort().join('|')}::${noteText}`;
      if (signature === lastSubmittedSignature) return;
      const ok = await postMessageFeedback(reasons, message, status, noteText);
      if (ok) {
        lastSubmittedSignature = signature;
        status.textContent = i18n('chat.feedback.recorded');
      }
    }

    async function submitFeedbackNote() {
      await flushFeedback();
    }

    up.addEventListener('click', () => {
      feedbackVote = nextFeedbackVote(feedbackVote, 'up');
      syncThumbs();
      if (feedbackVote === 'up') {
        closeOpenFeedbackPopover();
        postMessageFeedback(['useful'], message, status);
      } else {
        status.textContent = '';
      }
    });
    down.addEventListener('click', () => {
      feedbackVote = nextFeedbackVote(feedbackVote, 'down');
      syncThumbs();
      if (feedbackVote === 'down') {
        openPopover();
      } else {
        selectedReasons.forEach((value) => {
          const chip = chipByValue.get(value);
          if (chip) {
            chip.classList.remove('sel');
            chip.setAttribute('aria-pressed', 'false');
          }
        });
        selectedReasons.clear();
        lastSubmittedSignature = '';
        status.textContent = '';
        popover.hidden = true;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('keydown', onEscKey, true);
        if (openFeedbackPopoverCloser === closePopover) openFeedbackPopoverCloser = null;
      }
    });

    panel.append(up, down, status, popover);
    return panel;
  }

  async function postMessageFeedback(selected, message, status, note) {
    if (!message.sessionId) {
      status.textContent = i18n('chat.feedback.contextUnavailable');
      return false;
    }
    const payload = { sessionId: message.sessionId, feedbackTypes: selected };
    if (typeof note === 'string' && note.trim()) {
      payload.note = note.trim();
    }
    if (message.turnId) {
      payload.turnId = message.turnId;
      payload.messageId = message.turnId;
    }
    try {
      const response = await window.AgentXAuth.authFetch('/api/feedback/messages', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`${i18n('chat.feedback.submitFailed')} (${response.status})`);
      }
      status.textContent = i18n('chat.feedback.recorded');
      return true;
    } catch (error) {
      status.textContent = error.message || i18n('chat.feedback.submitFailed');
      return false;
    }
  }

  function renderCitationBlock(message) {
    const summary = normalizeCitationSummary(message.citations || message.outputMeta?.citations || message.sourceCitationSummary);
    const block = document.createElement('div');
    block.className = 'message-citations';
    const title = document.createElement('div');
    title.className = 'message-citations-title';
    title.textContent = i18n('chat.sources.title');
    block.append(title);

    if (!summary || summary.sources.length === 0) {
      const notice = document.createElement('div');
      notice.className = 'message-citation-notice';
      notice.textContent = i18n('chat.sources.none');
      block.append(notice);
      return block;
    }

    const list = document.createElement('ul');
    for (const source of summary.sources) {
      const item = document.createElement('li');
      const main = document.createElement('strong');
      main.textContent = source.displayTitle || source.filename || source.sourceLabel || i18n('chat.sources.unnamed');
      item.append(main);
      const meta = [
        source.filename && source.filename !== source.displayTitle ? source.filename : '',
        source.section ? i18n('chat.sources.section', { value: source.section }) : '',
        source.page ? i18n('chat.sources.page', { value: source.page }) : '',
        source.sourceLabel ? i18n('chat.sources.label', { value: source.sourceLabel }) : ''
      ].filter(Boolean);
      if (meta.length > 0) {
        const metaText = document.createElement('span');
        metaText.textContent = meta.join(' · ');
        item.append(metaText);
      }
      list.append(item);
    }
    block.append(list);
    const notice = document.createElement('div');
    notice.className = 'message-citation-notice';
    notice.textContent = message.outputMeta?.citationNotice || i18n('chat.sources.notice');
    block.append(notice);
    return block;
  }

  function normalizeCitationSummary(value) {
    if (!value || !Array.isArray(value.sources)) {
      return { sources: [] };
    }
    const sources = value.sources
      .map((source) => normalizeCitationSource(source))
      .filter(Boolean)
      .slice(0, 20);
    return { sources };
  }

  function normalizeCitationSource(source) {
    if (!source || source.captureKind !== 'system_captured_source_seed') {
      return null;
    }
    const safe = {
      displayTitle: safeCitationText(source.displayTitle),
      filename: safeCitationText(source.filename),
      section: safeCitationText(source.section),
      page: safeCitationText(source.page),
      sourceLabel: safeCitationText(source.sourceLabel)
    };
    if (!safe.displayTitle && !safe.filename && !safe.sourceLabel) {
      return null;
    }
    return safe;
  }

  function safeCitationText(value) {
    const text = String(value || '').trim();
    if (!text || isUnsafeCitationText(text)) {
      return '';
    }
    return text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
  }

  function isUnsafeCitationText(text) {
    return /(?:[A-Za-z]:[\\/]|\\\\|\/(?:srv|opt|home|var|tmp|workspace|etc|root)\b)/i.test(text) ||
      /\b(?:authorization|cookie|password|secret|token|api[_-]?key|jwt)\s*[:=]/i.test(text);
  }

  function appendMessage(role, text, options = {}) {
    const message = {
      id: options.id || nextClientId(role),
      role,
      text: stripVisibleFingerprintMarker(text),
      status: options.status,
      sessionId: options.sessionId ?? state.activeSessionId,
      turnId: options.turnId,
      citations: options.citations,
      outputMeta: options.outputMeta,
      sourceCitationSummary: options.sourceCitationSummary
    };
    state.messages.push(message);
    state.messageRevision += 1;
    appendMessageElement(message);
    els.conversation.scrollTop = els.conversation.scrollHeight;
    return message;
  }

  function appendOptimisticUserMessage(text) {
    return appendMessage('user', text, {
      id: nextClientId('user'),
      status: 'pending',
      sessionId: state.activeSessionId
    });
  }

  function markMessageStatus(clientId, status) {
    const message = state.messages.find((item) => item.id === clientId);
    if (!message) {
      return;
    }
    message.status = status;
    state.messageRevision += 1;
    renderMessages();
  }

  function setMessages(messages, options = {}) {
    if (!options.preserveActiveAssistant) {
      state.activeAssistantMessageId = null;
    }
    const failedLocalMessages = options.preserveLocalFailures
      ? state.messages.filter((message) => message.status === 'failed' && message.sessionId === state.activeSessionId)
      : [];

    const nextMessages = messages.length > 0 ? [...messages] : [];
    for (const message of failedLocalMessages) {
      const alreadyPresent = nextMessages.some((item) => item.role === message.role && item.text === message.text);
      if (!alreadyPresent) {
        nextMessages.push(message);
      }
    }
    if (areMessagesEquivalent(state.messages, nextMessages)) {
      state.messages = nextMessages;
      if (els.conversation.childElementCount === 0) {
        renderMessages();
      }
      return;
    }
    state.messages = nextMessages;
    state.messageRevision += 1;
    renderMessages();
    syncChatModeControls();
  }

  function mergeSnapshotMessages(snapshotMessages, sessionId) {
    const current = state.messages.filter((message) => message.sessionId === sessionId
      || (message.sessionId == null && ['pending', 'sent', 'streaming'].includes(message.status)));
    const currentStable = current.filter((message) => !['failed', 'streaming'].includes(message.status));
    const matches = (left, right) => left.role === right.role && (
      left.turnId !== undefined && left.turnId !== null
        && right.turnId !== undefined && right.turnId !== null
        ? left.turnId === right.turnId
        : left.text === right.text
    );
    const findSubsequence = (needles, haystack) => {
      const indices = [];
      let cursor = 0;
      for (const needle of needles) {
        while (cursor < haystack.length && !matches(needle, haystack[cursor])) cursor += 1;
        if (cursor >= haystack.length) return null;
        indices.push(cursor);
        cursor += 1;
      }
      return indices;
    };
    const currentInSnapshot = findSubsequence(currentStable, snapshotMessages);
    const snapshotInCurrent = findSubsequence(snapshotMessages, currentStable);
    let merged;
    const consumedCurrent = new Set();

    if (currentInSnapshot) {
      merged = snapshotMessages.map((message) => ({ ...message }));
      currentInSnapshot.forEach((snapshotIndex, currentIndex) => {
        const existing = currentStable[currentIndex];
        merged[snapshotIndex] = { ...existing, ...merged[snapshotIndex], id: existing.id, status: merged[snapshotIndex].status };
        consumedCurrent.add(current.indexOf(existing));
      });
    } else if (snapshotInCurrent) {
      merged = currentStable.map((message) => ({ ...message }));
      currentStable.forEach((message) => consumedCurrent.add(current.indexOf(message)));
      snapshotInCurrent.forEach((currentIndex, snapshotIndex) => {
        const existing = currentStable[currentIndex];
        const incoming = snapshotMessages[snapshotIndex];
        merged[currentIndex] = { ...existing, ...incoming, id: existing.id, status: incoming.status };
        consumedCurrent.add(current.indexOf(existing));
      });
    } else {
      merged = snapshotMessages.map((message) => ({ ...message }));
    }

    for (const [index, message] of current.entries()) {
      if (!consumedCurrent.has(index) && ['pending', 'sent', 'streaming'].includes(message.status)) merged.push(message);
    }
    return merged;
  }

  function areMessagesEquivalent(left, right) {
    if (left.length !== right.length) {
      return false;
    }
    return left.every((message, index) => {
      const other = right[index];
      return other
        && message.role === other.role
        && message.text === other.text
        && message.status === other.status
        && message.sessionId === other.sessionId
        && message.turnId === other.turnId
        && JSON.stringify(message.citations || message.outputMeta?.citations || message.sourceCitationSummary || null) ===
          JSON.stringify(other.citations || other.outputMeta?.citations || other.sourceCitationSummary || null);
    });
  }

  function updateAssistantMessage(text) {
    if (!text) {
      return;
    }
    const active = state.messages.find((message) => message.id === state.activeAssistantMessageId);
    if (active) {
      if (active.text === text) {
        return;
      }
      if (text.startsWith(active.text)) {
        active.text = text;
      } else if (!active.text.endsWith(text)) {
        active.text += text;
      }
      state.messageRevision += 1;
      renderMessages();
      return;
    }
    const message = appendMessage('assistant', text, {
      id: nextClientId('assistant'),
      status: 'streaming',
      sessionId: state.activeSessionId
    });
    state.activeAssistantMessageId = message.id;
  }

  function showAssistantActivity() {
    updateAssistantMessage(lookupActivityText());
  }

  function clearRunningAssistantPlaceholder(sessionId) {
    if (!sessionId) return false;
    const placeholderIds = new Set(state.messages
      .filter((message) => message.sessionId === sessionId
        && message.role === 'assistant'
        && message.status === 'streaming'
        && isLookupActivityText(message.text))
      .map((message) => message.id));
    if (placeholderIds.size === 0) return false;
    for (const messageId of placeholderIds) stopActivityDots(messageId);
    state.messages = state.messages.filter((message) => !placeholderIds.has(message.id));
    if (placeholderIds.has(state.activeAssistantMessageId)) state.activeAssistantMessageId = null;
    state.messageRevision += 1;
    renderMessages();
    return true;
  }

  function restoreRunningTurnView(sessionId) {
    if (!sessionId || sessionId !== state.activeSessionId) return false;
    const sessionMessages = state.messages.filter((message) => message.sessionId === sessionId);
    let latestUserIndex = -1;
    for (let index = sessionMessages.length - 1; index >= 0; index -= 1) {
      if (sessionMessages[index].role === 'user') {
        latestUserIndex = index;
        break;
      }
    }

    setTurnPhase('running', { sessionId });
    if (latestUserIndex < 0) {
      clearRunningAssistantPlaceholder(sessionId);
      return false;
    }

    const latestUser = sessionMessages[latestUserIndex];
    const hasAssistantResponse = sessionMessages.some((message, index) => {
      if (message.role !== 'assistant' || message.status === 'streaming') return false;
      if (latestUser.turnId !== undefined && latestUser.turnId !== null
        && message.turnId !== undefined && message.turnId !== null) {
        return message.turnId === latestUser.turnId;
      }
      return index > latestUserIndex;
    });
    if (hasAssistantResponse) {
      clearRunningAssistantPlaceholder(sessionId);
      return false;
    }

    const placeholders = sessionMessages.filter((message) => message.role === 'assistant'
      && message.status === 'streaming'
      && isLookupActivityText(message.text));
    const matchingPlaceholder = placeholders.find((message) => latestUser.turnId !== undefined
      && latestUser.turnId !== null
      && message.turnId === latestUser.turnId) || placeholders[0];
    if (matchingPlaceholder) {
      for (const duplicate of placeholders) {
        if (duplicate.id === matchingPlaceholder.id) continue;
        stopActivityDots(duplicate.id);
      }
      if (placeholders.length > 1) {
        const duplicateIds = new Set(placeholders
          .filter((message) => message.id !== matchingPlaceholder.id)
          .map((message) => message.id));
        state.messages = state.messages.filter((message) => !duplicateIds.has(message.id));
        state.messageRevision += 1;
        renderMessages();
      }
      matchingPlaceholder.turnId = latestUser.turnId;
      state.activeAssistantMessageId = matchingPlaceholder.id;
      return true;
    }

    const placeholder = appendMessage('assistant', lookupActivityText(), {
      id: nextClientId('assistant'),
      status: 'streaming',
      sessionId,
      turnId: latestUser.turnId
    });
    state.activeAssistantMessageId = placeholder.id;
    return true;
  }

  function latestUserTurnReference(sessionId) {
    const latestUser = [...state.messages].reverse().find((message) => message.sessionId === sessionId && message.role === 'user');
    return latestUser ? { turnId: latestUser.turnId, text: latestUser.text } : null;
  }

  function hasAssistantResponseForTurn(sessionId, userTurn) {
    if (!userTurn) return true;
    const sessionMessages = state.messages.filter((message) => message.sessionId === sessionId);
    const userIndex = sessionMessages.findLastIndex((message) => message.role === 'user' && (
      userTurn.turnId !== undefined && userTurn.turnId !== null
        ? message.turnId === userTurn.turnId
        : message.text === userTurn.text
    ));
    if (userIndex < 0) return false;
    return sessionMessages.some((message, index) => {
      if (message.role !== 'assistant' || message.status === 'streaming') return false;
      if (userTurn.turnId !== undefined && userTurn.turnId !== null
        && message.turnId !== undefined && message.turnId !== null) {
        return message.turnId === userTurn.turnId;
      }
      return index > userIndex;
    });
  }

  async function refreshTerminalTurnWithRetry(sessionId, expectedGeneration, expectedRunEpoch, userTurn) {
    for (const delay of SESSION_TERMINAL_REFRESH_DELAYS_MS) {
      if (!isCurrentSessionGeneration(sessionId, expectedGeneration)
        || state.sessionRunEpochs.get(sessionId) !== expectedRunEpoch) return false;
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (!isCurrentSessionGeneration(sessionId, expectedGeneration)
        || state.sessionRunEpochs.get(sessionId) !== expectedRunEpoch) return false;
      await refreshLog({ discardIfMessagesChanged: true, preserveRunningPlaceholder: true });
      if (!isCurrentSessionGeneration(sessionId, expectedGeneration)
        || state.sessionRunEpochs.get(sessionId) !== expectedRunEpoch) return false;
      if (hasAssistantResponseForTurn(sessionId, userTurn)) return true;
    }
    return true;
  }

  function startActivityDots(messageId, element) {
    stopActivityDots(messageId);
    let index = 0;
    const updateDots = () => {
      element.textContent = lookupDotsFrames[index];
      index = (index + 1) % lookupDotsFrames.length;
    };
    updateDots();
    const timer = window.setInterval(updateDots, 450);
    state.activityTimers.set(messageId, timer);
  }

  function stopActivityDots(messageId) {
    const timer = state.activityTimers.get(messageId);
    if (timer) {
      window.clearInterval(timer);
      state.activityTimers.delete(messageId);
    }
  }

  function clearActivityTimers() {
    for (const timer of state.activityTimers.values()) {
      window.clearInterval(timer);
    }
    state.activityTimers.clear();
  }

  function finalizeAssistantMessage(text, options = {}) {
    if (!text) {
      // 区分两种「无可见文本」：
      //   - 过滤为空（filteredEmpty）：本次有原始输出但被处理后无可见内容，属成功路径。
      //     必须清理 streaming 占位（否则 spinner 永远卡住），但绝不覆盖此前已渲染的真实回答。
      //   - 真空：无任何原始内容，按现状静默返回（错误路径另由分类器处理）。
      if (options.filteredEmpty) {
        finalizeFilteredEmpty();
      }
      return;
    }
    const active = state.messages.find((message) => message.id === state.activeAssistantMessageId);
    if (active) {
      if (!active.text.includes(text)) {
        active.text = text;
      }
      active.status = undefined;
      active.outputMeta = options.outputMeta || active.outputMeta;
      active.citations = options.outputMeta?.citations || active.citations;
      stopActivityDots(active.id);
      state.activeAssistantMessageId = null;
      state.messageRevision += 1;
      renderMessages();
      return;
    }

    const lastAssistant = [...state.messages].reverse().find((message) => message.role === 'assistant');
    if (lastAssistant && (lastAssistant.text === text || lastAssistant.text.includes(text))) {
      lastAssistant.status = undefined;
      lastAssistant.outputMeta = options.outputMeta || lastAssistant.outputMeta;
      lastAssistant.citations = options.outputMeta?.citations || lastAssistant.citations;
      stopActivityDots(lastAssistant.id);
      state.activeAssistantMessageId = null;
      state.messageRevision += 1;
      renderMessages();
      return;
    }
    appendMessage('assistant', text, {
      id: nextClientId('assistant'),
      sessionId: state.activeSessionId,
      outputMeta: options.outputMeta,
      citations: options.outputMeta?.citations
    });
  }

  // 过滤为空：成功但无可见输出。清掉 streaming 占位状态，不卡 spinner；
  // 若占位只是「正在查阅资料」则换成中性提示，绝不覆盖之前已渲染的真实回答。
  function finalizeFilteredEmpty() {
    const active = state.messages.find((message) => message.id === state.activeAssistantMessageId);
    if (active) {
      stopActivityDots(active.id);
      active.status = undefined;
      if (isLookupActivityText(active.text) || !active.text) {
        active.text = i18n('chat.message.filtered');
      }
      state.activeAssistantMessageId = null;
      state.messageRevision += 1;
      renderMessages();
      return;
    }
    // 无活动占位：已有真实回答则保持不动，仅确保不残留 streaming 状态。
    const streaming = state.messages.find((message) => message.status === 'streaming');
    if (streaming) {
      stopActivityDots(streaming.id);
      streaming.status = undefined;
      if (isLookupActivityText(streaming.text) || !streaming.text) {
        streaming.text = i18n('chat.message.filtered');
      }
      state.messageRevision += 1;
      renderMessages();
    }
  }

  function applyLoadedSessions(rawSessions, options = {}) {
    const runEpochSnapshot = options.runEpochSnapshot || new Map();
    const currentById = new Map(state.sessions.map((session) => [session.id, session]));
    const sessions = (rawSessions || []).map(normalizeSession);
    for (const session of sessions) {
      const requestEpoch = runEpochSnapshot.get(session.id) || 0;
      const currentEpoch = state.sessionRunEpochs.get(session.id) || 0;
      const current = currentById.get(session.id);
      if (requestEpoch !== currentEpoch && isRunningSession(current) && !isRunningSession(session)) {
        session.turnState = 'running';
        session.status = 'running';
      }
    }
    for (const current of currentById.values()) {
      const requestEpoch = runEpochSnapshot.get(current.id) || 0;
      const currentEpoch = state.sessionRunEpochs.get(current.id) || 0;
      if (requestEpoch !== currentEpoch && isRunningSession(current)
        && !sessions.some((session) => session.id === current.id)) {
        sessions.push(current);
      }
    }
    const returnedIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of state.sessionRunEpochs.keys()) {
      if (returnedIds.has(sessionId)) continue;
      const reconcileTimer = state.sessionReconcileTimers.get(sessionId);
      if (reconcileTimer) window.clearTimeout(reconcileTimer);
      const terminalTimer = state.sessionTerminalRefreshTimers.get(sessionId);
      if (terminalTimer) window.clearTimeout(terminalTimer);
      state.sessionRunEpochs.delete(sessionId);
      state.sessionReconcileTimers.delete(sessionId);
      state.sessionTerminalOverrides.delete(sessionId);
      state.sessionTerminalRefreshTimers.delete(sessionId);
    }
    for (const session of sessions) {
      const terminalOverride = state.sessionTerminalOverrides.get(session.id);
      if (!terminalOverride) continue;
      if (isRunningSession(session)) {
        session.turnState = terminalOverride;
        session.status = terminalOverride;
      } else {
        state.sessionTerminalOverrides.delete(session.id);
        const timer = state.sessionTerminalRefreshTimers.get(session.id);
        if (timer) window.clearTimeout(timer);
        state.sessionTerminalRefreshTimers.delete(session.id);
      }
    }
    state.sessions = sessions;
    for (const session of sessions) {
      if (isRunningSession(session)) trackRunningSession(session.id);
    }
  }

  async function loadSessions(options = {}) {
    const expectedGeneration = options.sessionGeneration;
    const runEpochSnapshot = new Map(state.sessionRunEpochs);
    const generationIsCurrent = () => expectedGeneration === undefined
      || expectedGeneration === state.activeSessionGeneration;
    const response = await window.AgentXAuth.authFetch('/sessions/history');
    if (!response.ok && response.status === 404) {
      const fallback = await window.AgentXAuth.authFetch('/sessions');
      if (!fallback.ok) {
        throw new Error(`${i18n('chat.error.loadSessions')} (${fallback.status})`);
      }
      const fallbackPayload = await fallback.json();
      if (!generationIsCurrent()) return false;
      applyLoadedSessions(fallbackPayload.sessions, { runEpochSnapshot });
      renderSessions();
      renderSessionMeta();
      syncComposerAvailability();
      return true;
    }
    if (!response.ok) {
      throw new Error(`${i18n('chat.error.loadSessions')} (${response.status})`);
    }
    const payload = await response.json();
    if (!generationIsCurrent()) return false;
    applyLoadedSessions(payload.sessions, { runEpochSnapshot });
    renderSessions();
    renderSessionMeta();
    syncComposerAvailability();
    return true;
  }

  async function createSession(task, submissionGeneration) {
    // 范围选择器三模式组装请求体：
    //   single → 顶层 chipId（现状，零回归）
    //   group  → scope:{ mode:'group', groups:[{dimension,value}] }
    //   global → scope:{ mode:'global' }（免选）
    const base = {
      agentType: 'claude-code',
      task,
      sessionMode: 'conversation',
      chatMode: selectedChatMode(),
      locale: state.locale
    };

    let body;
    let nextActiveChipId = null;
    if (state.scopeMode === 'group') {
      if (state.selectedGroups.length === 0) {
        throw new Error(i18n('chat.scope.group.empty'));
      }
      body = { ...base, scope: { mode: 'group', groups: state.selectedGroups } };
    } else if (state.scopeMode === 'global') {
      body = { ...base, scope: { mode: 'global' } };
    } else {
      const chipId = state.selectedScopeChipId || (els.chipSelect ? els.chipSelect.value : '') || state.activeChipId;
      if (!chipId) {
        throw new Error(i18n('chat.chip.required'));
      }
      body = { ...base, chipId };
      nextActiveChipId = chipId;
    }

    const response = await window.AgentXAuth.authFetch('/sessions', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw await apiErrorFromResponse(response, i18n('chat.error.createSession'));
    }
    const payload = await response.json();
    if (submissionGeneration !== state.activeSessionGeneration || state.activeSessionId !== null) return null;
    // Keep the entire POST -> list refresh -> active-session bridge locked as
    // one submitting transition. The new session is not safe to Stop or leave
    // until it is present in the authoritative session list and selected.
    setTurnPhase('submitting', { sessionId: payload.sessionId });
    if (nextActiveChipId) {
      state.activeChipId = nextActiveChipId;
      syncChipSelector();
    }
    // 发出首句即把三步面板平滑折叠成悬浮胶囊（范围·内容·模式），并在会话内锁定。
    collapseScopeToPills();
    let loaded = false;
    let listRefreshError = null;
    try {
      loaded = await loadSessions({ sessionGeneration: submissionGeneration });
    } catch (error) {
      if (submissionGeneration !== state.activeSessionGeneration || state.activeSessionId !== null) return null;
      // POST already succeeded, so a temporary list failure cannot be treated
      // as a failed create. Install a generation-scoped provisional record and
      // let the session status/SSE path converge without unlocking duplicate
      // submission.
      listRefreshError = error;
      const provisionalState = payload.turnState || payload.status || 'running';
      const provisional = normalizeSession({
        id: payload.sessionId,
        title: task,
        task,
        chipId: body.chipId || null,
        chatMode: base.chatMode,
        turnState: provisionalState,
        status: provisionalState,
        scopeDescriptor: body.scope || (body.chipId ? { mode: 'single', chipId: body.chipId } : undefined)
      });
      state.sessions = [provisional, ...state.sessions.filter((session) => session.id !== payload.sessionId)];
      renderSessions();
      renderSessionMeta();
      loaded = true;
    }
    if (!loaded || submissionGeneration !== state.activeSessionGeneration || state.activeSessionId !== null) return null;
    const selected = await selectSession(payload.sessionId, { suppressRecoverableError: true });
    if (!selected) return null;
    if (listRefreshError) setError(listRefreshError.message || i18n('chat.error.loadSessions'));
    const selectedSession = activeSession();
    if (selectedSession?.turnState === 'running' || selectedSession?.status === 'running') {
      showAssistantActivity();
    }
    return payload.sessionId;
  }

  async function refreshLog(options = {}) {
    const session = activeSession();
    if (!session) {
      setMessages([]);
      return;
    }
    // P1-5 / R-4 (multi-agent audit): capture the session id at request time
    // and re-check that it's still active before mutating UI state. A late
    // response from a previously selected session must not overwrite the
    // current session's messages.
    const targetSessionId = session.id;
    const targetGeneration = state.activeSessionGeneration;
    const requestMessageRevision = state.messageRevision;
    const response = await window.AgentXAuth.authFetch(`/sessions/${encodeURIComponent(targetSessionId)}/history`);
    if (!isCurrentSessionGeneration(targetSessionId, targetGeneration)) return;
    if (!response.ok && response.status === 404) {
      await refreshRunningLog(targetSessionId, targetGeneration);
      return;
    }
    if (!response.ok) {
      throw await apiErrorFromResponse(response, i18n('chat.error.loadOutput'));
    }
    const payload = await response.json();
    if (!isCurrentSessionGeneration(targetSessionId, targetGeneration)) return;
    if (options.discardIfMessagesChanged && requestMessageRevision !== state.messageRevision) return;
    const refreshedTurnState = sessionStateValue(payload.session || payload);
    if (refreshedTurnState) updateSessionState(targetSessionId, refreshedTurnState);
    const refreshedMessages = formatPayloadMessages(payload, { sessionId: targetSessionId });
    if (options.preserveRunningPlaceholder) {
      setMessages(mergeSnapshotMessages(refreshedMessages, targetSessionId), { preserveActiveAssistant: true });
    } else {
      setMessages(refreshedMessages);
    }
  }

  async function refreshRunningLog(sessionId, expectedGeneration = state.activeSessionGeneration) {
    if (!isCurrentSessionGeneration(sessionId, expectedGeneration)) return;
    // F5 (multi-agent audit): capture the session id at request time and
    // re-check before mutating UI state, so a late response from a session
    // the user has since left does not get tagged with the new active
    // session's id.
    const targetSessionId = sessionId;
    const response = await window.AgentXAuth.authFetch(`/sessions/${encodeURIComponent(sessionId)}/log`);
    if (!isCurrentSessionGeneration(targetSessionId, expectedGeneration)) return;
    if (!response.ok) {
      throw await apiErrorFromResponse(response, i18n('chat.error.loadOutput'));
    }
    const payload = await response.json();
    if (!isCurrentSessionGeneration(targetSessionId, expectedGeneration)) return;
    const refreshedTurnState = sessionStateValue(payload.session || payload);
    if (refreshedTurnState) updateSessionState(targetSessionId, refreshedTurnState);
    setMessages(formatPayloadMessages(payload, { sessionId: targetSessionId }));
  }

  async function selectSession(sessionId, options = {}) {
    const inheritedAssistantMessageId = state.activeAssistantMessageId;
    const backgroundSessionId = state.turnPhase === 'running' ? state.turnSessionId : null;
    if (backgroundSessionId && backgroundSessionId !== sessionId) {
      trackRunningSession(backgroundSessionId);
    }
    closeStream();
    clearPendingImages({ skipSync: true });
    state.activeAssistantMessageId = null;
    state.userCancelled = false;
    const selectionGeneration = ++state.activeSessionGeneration;
    state.activeSessionId = sessionId;
    const session = state.sessions.find((s) => s.id === sessionId);
    setTurnPhase('submitting', { sessionId });
    state.activeChipId = session?.chipId || null;
    restoreScopeFromSession(session);
    setChatMode(session?.chatMode || 'standard', { force: true });
    // 进入一个已存在会话：范围不可改，折叠成悬浮胶囊（会话内持久）。
    if (session) {
      state.scopeCollapsed = true;
      renderScopePillbar();
    }
    syncChipSelector();
    syncChatModeControls();
    applyScopeCollapsed();
    renderSessions();
    renderSessionMeta();
    try {
      await refreshLog();
    } catch (error) {
      if (await finishIfSessionBecameUnavailable(sessionId, error, selectionGeneration)) {
        return false;
      }
      if (!isCurrentSessionGeneration(sessionId, selectionGeneration)) return false;
      const inheritedActivity = state.messages.find((message) => message.id === inheritedAssistantMessageId);
      if (inheritedActivity?.status === 'streaming' && isLookupActivityText(inheritedActivity.text)) {
        stopActivityDots(inheritedActivity.id);
        state.messages = state.messages.filter((message) => message.id !== inheritedActivity.id);
        state.messageRevision += 1;
        renderMessages();
      }
      if (session?.turnState === 'running' || session?.status === 'running') {
        trackRunningSession(sessionId);
        setTurnPhase('running', { sessionId });
        openStream(sessionId);
      } else {
        finishTurn(sessionId);
      }
      if (options.suppressRecoverableError) {
        setError(error.message);
        return true;
      }
      throw error;
    }
    if (selectionGeneration !== state.activeSessionGeneration || sessionId !== state.activeSessionId) return false;
    if (session?.turnState === 'running' || session?.status === 'running') {
      trackRunningSession(sessionId);
      restoreRunningTurnView(sessionId);
      openStream(sessionId, { preserveActiveAssistant: true });
    } else {
      finishTurn();
    }
    return true;
  }

  function syncChipSelector() {
    if (state.activeChipId) {
      els.chipSelect.value = state.activeChipId;
      els.chipSelect.disabled = true;
    } else {
      els.chipSelect.disabled = false;
    }
  }

  function closeStream(options = {}) {
    if (state.eventSource) {
      state.eventSource.close();
      state.eventSource = null;
    }
    // 关流即停止超时看门狗；除非是为重连而临时关闭，否则同时取消待重连计划并清持久化记录。
    clearTurnTimeoutWatch();
    if (!options.forReconnect) {
      clearStreamReconnect();
      clearPersistedActiveStream();
    }
    if (state.activeSessionId) {
      state.streamBuffers.delete(state.activeSessionId);
    }
    if (!options.preserveActiveAssistant && state.activeAssistantMessageId) {
      stopActivityDots(state.activeAssistantMessageId);
      state.activeAssistantMessageId = null;
    } else if (!options.preserveActiveAssistant) {
      state.activeAssistantMessageId = null;
    }
  }

  // ── 流可靠性：活动记录 / 超时看门狗 / 退避重连 / 刷新孤儿清理 ───────────────

  // 记录一次流活动并重置超时看门狗：只要还有事件进来就不会误判超时。
  function markStreamActivity() {
    state.lastStreamActivityAt = Date.now();
    startTurnTimeoutWatch();
  }

  // 启动/重置超时看门狗：超过本地阈值仍无活动则按超时处理。
  function startTurnTimeoutWatch() {
    clearTurnTimeoutWatch();
    state.turnTimeoutTimer = window.setTimeout(() => {
      void handleStreamTimeout();
    }, STREAM_IDLE_TIMEOUT_MS);
  }

  function clearTurnTimeoutWatch() {
    if (state.turnTimeoutTimer) {
      window.clearTimeout(state.turnTimeoutTimer);
      state.turnTimeoutTimer = null;
    }
  }

  // 超时：先查服务端真实状态。大范围两阶段检索可能长时间没有 SSE 数据，
  // 只要后端仍在 running 就保持 Composer 锁定并重连，不能在前端制造假终态。
  async function handleStreamTimeout() {
    const sessionId = state.turnSessionId || state.activeSessionId;
    if (!sessionId) return;
    const sessionGeneration = state.activeSessionGeneration;
    closeStream({ forReconnect: true, preserveActiveAssistant: true });
    try {
      const status = await pollSessionStatus(sessionId);
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration) || state.userCancelled) return;
      if (status === 'running') {
        setTurnPhase('running', { sessionId });
        setError(i18n('chat.error.streamContinuing'));
        openStream(sessionId, { preserveActiveAssistant: true });
        return;
      }
      await refreshLog({ discardIfMessagesChanged: true });
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration) || state.userCancelled) return;
      closeStream();
      finishTurn(sessionId);
      await loadSessions({ sessionGeneration });
    } catch (error) {
      if (isCurrentSessionGeneration(sessionId, sessionGeneration) && !state.userCancelled) {
        if (isUnavailableSessionStatusError(error)) {
          await finishUnavailableSession(sessionId, error, sessionGeneration);
          return;
        }
        setError(error.message || i18n('chat.error.streamStatus'));
        scheduleStreamReconnect(sessionId, sessionGeneration);
      }
    }
  }

  // onerror 触发的退避重连：先按尝试次数计算指数退避延迟，到点后 poll 会话状态，
  // 仍在 running 才重开流；超过最大尝试次数则放弃并提示。
  function scheduleStreamReconnect(sessionId, sessionGeneration = state.activeSessionGeneration) {
    if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) {
      return;
    }
    if (state.streamReconnectTimer) {
      return;
    }
    if (state.streamReconnectAttempts >= STREAM_RECONNECT_MAX_ATTEMPTS) {
      closeStream();
      setError(i18n('chat.error.streamDisconnected'));
      return;
    }
    const attempt = state.streamReconnectAttempts;
    state.streamReconnectAttempts = attempt + 1;
    const delay = Math.min(STREAM_RECONNECT_MAX_MS, STREAM_RECONNECT_BASE_MS * Math.pow(2, attempt));
    setError(i18n('chat.error.streamReconnect'));
    state.streamReconnectTimer = window.setTimeout(() => {
      state.streamReconnectTimer = null;
      // 用户已切走会话或主动取消：放弃重连。
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration) || state.userCancelled) {
        return;
      }
      pollSessionStatus(sessionId)
        .then((status) => {
          if (!isCurrentSessionGeneration(sessionId, sessionGeneration) || state.userCancelled) {
            return;
          }
          if (status === 'running') {
            openStream(sessionId, { preserveActiveAssistant: true });
          } else {
            // The status can become idle before the persisted transcript has
            // appended the final assistant message. Keep the restored running
            // placeholder until a bounded, generation-scoped history retry
            // finds that answer (or exhausts the convergence window).
            const expectedRunEpoch = state.sessionRunEpochs.get(sessionId) || 0;
            const userTurn = latestUserTurnReference(sessionId);
            refreshTerminalTurnWithRetry(sessionId, sessionGeneration, expectedRunEpoch, userTurn)
              .then((settled) => {
                if (!settled) return;
                if (!isCurrentSessionGeneration(sessionId, sessionGeneration) || state.userCancelled
                  || state.sessionRunEpochs.get(sessionId) !== expectedRunEpoch) return;
                clearStreamReconnect();
                completeSessionTurn(sessionId, status || 'idle');
                finishTurn(sessionId);
              })
              .catch((error) => {
                if (isUnavailableSessionStatusError(error)) {
                  void finishUnavailableSession(sessionId, error, sessionGeneration);
                  return;
                }
                if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
                setError(error.message || i18n('chat.error.streamStatus'));
                scheduleStreamReconnect(sessionId, sessionGeneration);
              });
          }
        })
        .catch((error) => {
          if (isUnavailableSessionStatusError(error)) {
            void finishUnavailableSession(sessionId, error, sessionGeneration);
            return;
          }
          // 网络或可恢复服务端错误：继续退避重试，直到达到上限。
          scheduleStreamReconnect(sessionId, sessionGeneration);
        });
    }, delay);
  }

  function clearStreamReconnect() {
    if (state.streamReconnectTimer) {
      window.clearTimeout(state.streamReconnectTimer);
      state.streamReconnectTimer = null;
    }
    state.streamReconnectAttempts = 0;
  }

  // poll 会话状态：返回 'running' / 'idle' / 其它；用于判断断流后是否值得重连。
  async function pollSessionStatus(sessionId) {
    const response = await window.AgentXAuth.authFetch(`/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) {
      const unavailable = response.status === 404 || response.status === 410;
      const error = new Error(unavailable
        ? i18n('chat.session.unavailable')
        : i18nFormat('chat.session.statusFailed', { status: response.status }));
      error.status = response.status;
      error.sessionUnavailable = unavailable;
      throw error;
    }
    const payload = await response.json();
    return payload.turnState || payload.status || payload.session?.turnState || payload.session?.status || '';
  }

  function isUnavailableSessionStatusError(error) {
    return Boolean(error?.sessionUnavailable || error?.status === 404 || error?.status === 410);
  }

  async function finishIfSessionBecameUnavailable(sessionId, error, sessionGeneration) {
    if (isUnavailableSessionStatusError(error)) {
      await finishUnavailableSession(sessionId, error, sessionGeneration);
      return true;
    }
    if (error?.status !== 403 || !isCurrentSessionGeneration(sessionId, sessionGeneration)) {
      return false;
    }
    try {
      await pollSessionStatus(sessionId);
    } catch (statusError) {
      if (statusError?.status === 403 || isUnavailableSessionStatusError(statusError)) {
        await finishUnavailableSession(sessionId, statusError, sessionGeneration);
        return true;
      }
    }
    return false;
  }

  // A revoked, expired, or removed session is a real terminal state, not a
  // transient transport failure. Clear every dependent Chat state so the user
  // gets a truthful fresh-session surface instead of a permanently locked
  // Composer or a follow-up that targets an inaccessible session.
  async function finishUnavailableSession(sessionId, error, expectedGeneration) {
    if (!isCurrentSessionGeneration(sessionId, expectedGeneration)) return;
    const terminalGeneration = ++state.activeSessionGeneration;
    closeStream();
    clearRunningAssistantPlaceholder(sessionId);
    // Keep the Composer fail-closed while all authorization-derived resources
    // are refreshed. A stale chip or mode must never become selectable during
    // the terminal transition.
    setTurnPhase('submitting', { sessionId });
    state.activeSessionId = null;
    state.activeChipId = null;
    state.activeAssistantMessageId = null;
    state.hiddenDuringActiveTurn = false;
    state.userCancelled = false;
    state.sessions = [];
    state.chips = [];
    state.scopePresets = [];
    state.scopeOptions = null;
    state.searchModes = [];
    clearPendingImages({ skipSync: true });
    setMessages([]);
    resetScopeSelection();
    renderChipSelect();
    els.scopeSelect?.replaceChildren();
    renderSearchModeOptions();
    syncChipSelector();
    syncChatModeControls();
    renderSessions();
    renderSessionMeta();
    await Promise.allSettled([
      loadSessions({ sessionGeneration: terminalGeneration }),
      loadChips(),
      loadScopePresets(),
      loadSearchModes(),
      loadScopeOptions()
    ]);
    if (terminalGeneration !== state.activeSessionGeneration || state.activeSessionId !== null) return;
    renderScopeModes();
    renderScopeContentPanel();
    renderScopePillbar();
    applyScopeCollapsed();
    syncChipSelector();
    syncChatModeControls();
    finishTurn(sessionId);
    setError(error?.message || i18n('chat.session.unavailable'));
  }

  async function reconcileVisibleTurn() {
    const sessionId = state.turnSessionId || state.activeSessionId;
    if (!sessionId || !isTurnBusy()) return;
    const sessionGeneration = state.activeSessionGeneration;
    state.hiddenDuringActiveTurn = false;
    try {
      const status = await pollSessionStatus(sessionId);
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      if (status === 'running') {
        setTurnPhase('running', { sessionId });
        openStream(sessionId, { preserveActiveAssistant: true });
        return;
      }
      await refreshLog({ discardIfMessagesChanged: true });
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      finishTurn(sessionId);
      closeStream();
      await loadSessions({ sessionGeneration });
    } catch (error) {
      if (isUnavailableSessionStatusError(error)) {
        await finishUnavailableSession(sessionId, error, sessionGeneration);
        return;
      }
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      setError(error.message || i18n('chat.error.restore'));
      scheduleStreamReconnect(sessionId, sessionGeneration);
    }
  }

  // 把当前活动流的 sessionId 写入 sessionStorage：刷新后 init 可据此关闭孤儿流，避免双触发。
  function persistActiveStream(sessionId) {
    try {
      window.sessionStorage.setItem(ACTIVE_STREAM_STORAGE_KEY, String(sessionId || ''));
    } catch {
      // sessionStorage 不可用（隐私模式等）时忽略：仅失去刷新清理能力，不影响主流程。
    }
  }

  function clearPersistedActiveStream() {
    try {
      window.sessionStorage.removeItem(ACTIVE_STREAM_STORAGE_KEY);
    } catch {
      // 同上：忽略存储异常。
    }
  }

  function readPersistedActiveStream() {
    try {
      return window.sessionStorage.getItem(ACTIVE_STREAM_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  }

  async function handleImageFiles(inputFiles) {
    const files = Array.from(inputFiles || []).filter((file) => /^image\//i.test(file?.type || ''));
    if (!selectedModeAllowsImageInput() || files.length === 0) return;
    clearPendingImages({ skipSync: true });
    const generation = state.imageUploadGeneration;
    const controller = new AbortController();
    state.imageUploadController = controller;
    state.imageUploadPending = true;
    state.uploadedImages = files;
    setError('');
    syncChatModeControls();
    const form = new FormData();
    form.append('chatMode', selectedChatMode());
    for (const file of files) {
      form.append('images', file);
    }
    try {
      const response = await window.AgentXAuth.authFetch('/api/chat-uploads/images', {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      if (generation !== state.imageUploadGeneration || controller.signal.aborted) return;
      if (!response.ok) {
        throw await apiErrorFromResponse(response, i18n('chat.error.uploadImage'));
      }
      const payload = await response.json();
      if (generation !== state.imageUploadGeneration || controller.signal.aborted) return;
      const markdown = (payload.images || [])
        .map((image) => `![${image.originalName || i18n('chat.image.defaultName')}](${image.url})`)
        .join('\n');
      state.uploadedImageMarkdown = markdown;
      els.message.value = [els.message.value.trim(), markdown].filter(Boolean).join('\n');
      els.message.focus();
    } catch (error) {
      if (generation !== state.imageUploadGeneration || controller.signal.aborted || error?.name === 'AbortError') return;
      state.uploadedImages = [];
      state.uploadedImageMarkdown = '';
      if (els.imageInput) els.imageInput.value = '';
      setError(error.message || i18n('chat.error.uploadImage'));
    } finally {
      if (generation === state.imageUploadGeneration) {
        state.imageUploadPending = false;
        state.imageUploadController = null;
        syncChatModeControls();
      }
    }
  }

  async function handleImageSelection() {
    await handleImageFiles(els.imageInput?.files || []);
  }

  function imageFilesFromTransfer(transfer) {
    if (!transfer) return [];
    const direct = Array.from(transfer.files || []).filter((file) => /^image\//i.test(file?.type || ''));
    if (direct.length) return direct;
    return Array.from(transfer.items || [])
      .filter((item) => item.kind === 'file' && /^image\//i.test(item.type || ''))
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
  }

  function openStream(sessionId, options = {}) {
    // 内部关流时标记 forReconnect，避免把退避计数器清零；重连时计数应跨连接累积。
    closeStream({ preserveActiveAssistant: options.preserveActiveAssistant, forReconnect: true });
    state.userCancelled = false;
    trackRunningSession(sessionId);
    setTurnPhase('running', { sessionId });
    const source = window.AgentXAuth.openAuthorizedEventStream(sessionId);
    state.eventSource = source;
    // 记录活动流并启动超时看门狗；活动流 sessionId 持久化以便刷新后清理孤儿流。
    persistActiveStream(sessionId);
    markStreamActivity();
    source.addEventListener('snapshot', (event) => {
      if (shouldIgnoreStreamEvent(sessionId, source)) {
        return;
      }
      markStreamActivity();
      clearStreamReconnect();
      const payload = safeParseStreamEvent(event, 'snapshot');
      if (!payload) {
        return;
      }
      const snapshotMessages = formatPayloadMessages(payload, { sessionId });
      setMessages(mergeSnapshotMessages(snapshotMessages, sessionId), {
        preserveLocalFailures: true,
        preserveActiveAssistant: true
      });
    });
    source.addEventListener('output', (event) => {
      if (shouldIgnoreStreamEvent(sessionId, source)) {
        return;
      }
      markStreamActivity();
      clearStreamReconnect();
      const payload = safeParseStreamEvent(event, 'output');
      if (!payload) {
        return;
      }
      bufferStreamOutput(sessionId, payload.data || '');
      showAssistantActivity();
    });
    source.addEventListener('state', (event) => {
      if (shouldIgnoreStreamEvent(sessionId, source)) {
        return;
      }
      markStreamActivity();
      clearStreamReconnect();
      const payload = safeParseStreamEvent(event, 'state');
      if (!payload) {
        return;
      }
      if (payload.state?.turnState === 'running') {
        trackRunningSession(sessionId);
      } else if (payload.state?.turnState === 'idle') {
        completeSessionTurn(sessionId, 'idle');
        finishTurn(sessionId);
        const sessionGeneration = state.activeSessionGeneration;
        refreshLog({ discardIfMessagesChanged: true })
          .then(() => {
            if (!shouldIgnoreStreamEvent(sessionId, source)
              && isCurrentSessionGeneration(sessionId, sessionGeneration)) {
              closeStream();
              finishTurn(sessionId);
              loadSessions({ sessionGeneration }).catch((error) => {
                if (isCurrentSessionGeneration(sessionId, sessionGeneration)) setError(error.message || i18n('chat.error.loadSessions'));
              });
            }
          })
          .catch((error) => {
            if (isUnavailableSessionStatusError(error)) {
              void finishUnavailableSession(sessionId, error, sessionGeneration);
              return;
            }
            if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
            setError(error.message || i18n('chat.error.streamStatus'));
            scheduleStreamReconnect(sessionId, sessionGeneration);
          });
      }
    });
    source.addEventListener('result', (event) => handleFinalAssistantEvent(event, sessionId, source));
    source.addEventListener('final', (event) => handleFinalAssistantEvent(event, sessionId, source));
    source.addEventListener('exit', () => {
      if (shouldIgnoreStreamEvent(sessionId, source)) {
        return;
      }
      const sessionGeneration = state.activeSessionGeneration;
      completeSessionTurn(sessionId, 'idle');
      finishTurn(sessionId);
      closeStream();
      refreshLog({ discardIfMessagesChanged: true })
        .then(() => {
          if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
          finishTurn(sessionId);
          loadSessions({ sessionGeneration }).catch((error) => {
            if (isCurrentSessionGeneration(sessionId, sessionGeneration)) setError(error.message || i18n('chat.error.loadSessions'));
          });
        })
        .catch((error) => {
          if (isUnavailableSessionStatusError(error)) {
            void finishUnavailableSession(sessionId, error, sessionGeneration);
            return;
          }
          if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
          setError(error.message || i18n('chat.error.streamStatus'));
          finishTurn(sessionId);
          loadSessions({ sessionGeneration }).catch((loadError) => {
            if (isCurrentSessionGeneration(sessionId, sessionGeneration)) setError(loadError.message || i18n('chat.error.loadSessions'));
          });
        });
    });
    source.onerror = () => {
      // 断流不再只显示文案：关闭这个失效的源，按指数退避真重连（poll 仍 running 才重开）。
      if (shouldIgnoreStreamEvent(sessionId, source) || state.userCancelled) {
        return;
      }
      if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
      }
      scheduleStreamReconnect(sessionId, state.activeSessionGeneration);
    };
  }

  function shouldIgnoreStreamEvent(sessionId, source) {
    return sessionId !== state.activeSessionId || source !== state.eventSource;
  }

  // 防御性解析 SSE 事件数据：损坏的 JSON 不再让监听器抛错冻结界面，
  // 而是提示用户并跳过该事件（其它事件与监听器保持存活）。不回显原始数据，避免泄露。
  function safeParseStreamEvent(event, eventType) {
    try {
      return JSON.parse(event.data);
    } catch {
      setError(i18n('chat.error.streamMalformed', { eventType }));
      return null;
    }
  }

  function handleFinalAssistantEvent(event, sessionId, source) {
    if (shouldIgnoreStreamEvent(sessionId, source)) {
      return;
    }
    markStreamActivity();
    const sessionGeneration = state.activeSessionGeneration;
    clearStreamReconnect();
    const payload = safeParseStreamEvent(event, 'final');
    if (!payload) {
      return;
    }
    const rawText = payload.data ?? payload.result ?? payload.output ?? '';
    state.streamBuffers.delete(sessionId);
    const formatted = formatOutputData(rawText, { includeResult: true });
    // 区分「过滤为空」（有原始内容但被处理后无可见输出，成功路径）与「真空」（无任何原始内容）。
    const filteredEmpty = !formatted && String(rawText || '').trim().length > 0;
    finalizeAssistantMessage(formatted, {
      outputMeta: payload.outputMeta,
      filteredEmpty
    });
    completeSessionTurn(sessionId, 'idle');
    closeStream();
    finishTurn(sessionId);
    loadSessions({ sessionGeneration }).catch((error) => {
      if (isCurrentSessionGeneration(sessionId, sessionGeneration)) setError(error.message);
    });
  }

  // 单会话流缓冲上限：无 newline 的超大输出不再无限增长，超限即截断保留尾部 64KB。
  const STREAM_BUFFER_MAX_BYTES = 64 * 1024;

  function bufferStreamOutput(sessionId, chunk) {
    const current = state.streamBuffers.get(sessionId) || '';
    let combined = current + String(chunk || '');
    if (combined.length > STREAM_BUFFER_MAX_BYTES) {
      // 超过上限：只保留尾部 64KB，丢弃更早的未成行片段，防止内存无界增长。
      combined = combined.slice(combined.length - STREAM_BUFFER_MAX_BYTES);
    }
    const lines = combined.split(/\r?\n/);
    let remainder = lines.pop() || '';
    if (remainder.length > STREAM_BUFFER_MAX_BYTES) {
      remainder = remainder.slice(remainder.length - STREAM_BUFFER_MAX_BYTES);
    }
    state.streamBuffers.set(sessionId, remainder);
  }

  function validateMessageSubmission(text) {
    if (!text) return '';
    if (activeSession()?.requiresNewScopeQuery) {
      return i18n('chat.session.restartRequired.short');
    }
    if (!hasSelectableMode() || !isModeSelectable(selectedChatMode())) {
      return modeUnavailableMessage(selectedChatMode());
    }
    if (state.imageUploadPending) {
      return i18n('chat.session.imageUploading');
    }
    if (activeSession()) return '';
    if (state.scopeMode === 'group' && state.selectedGroups.length === 0) {
      return i18n('chat.scope.group.empty');
    }
    if (state.scopeMode === 'single') {
      const chipId = state.selectedScopeChipId || (els.chipSelect ? els.chipSelect.value : '') || state.activeChipId;
      if (!chipId) return i18n('chat.chip.required');
    }
    return '';
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (isTurnBusy()) {
      return;
    }
    const rawText = els.message.value;
    const submissionSessionId = state.activeSessionId;
    const text = rawText.trim();
    if (!text) {
      return;
    }
    const validationError = validateMessageSubmission(text);
    if (validationError) {
      setError(validationError);
      els.message.focus();
      return;
    }

    const submissionGeneration = ++state.activeSessionGeneration;
    setError('');
    recordFirstChatOnboardingStep();
    els.message.value = '';
    state.activeAssistantMessageId = null;
    setTurnPhase('submitting', { sessionId: state.activeSessionId });
    const optimistic = appendOptimisticUserMessage(text);
    showAssistantActivity();
    let previousSessionState = 'idle';

    try {
      const session = activeSession();
      if (!session) {
        const createdSessionId = await createSession(text, submissionGeneration);
        if (!createdSessionId) return;
        markMessageStatus(optimistic.id, 'sent');
        clearPendingImages({ abort: false, skipSync: true });
        syncChatModeControls();
        return;
      }

      previousSessionState = sessionStateValue(session) || 'idle';
      beginSessionTurn(session.id);
      const response = await window.AgentXAuth.authFetch(`/sessions/${encodeURIComponent(session.id)}/send`, {
        method: 'POST',
        body: JSON.stringify({ data: text, submit: true, locale: state.locale })
      });
      if (!response.ok) {
        throw await apiErrorFromResponse(response, i18n('chat.error.send'));
      }
      markMessageStatus(optimistic.id, 'sent');
      clearPendingImages({ abort: false, skipSync: true });
      const payload = await response.json();
      if (payload.turnState === 'running' || payload.status === 'running') {
        setTurnPhase('running', { sessionId: session.id });
        openStream(session.id, { preserveActiveAssistant: true });
      } else {
        await refreshLog();
        completeSessionTurn(session.id, payload.turnState || payload.status || 'idle');
        finishTurn(session.id);
      }
    } catch (error) {
      if (state.activeAssistantMessageId) {
        const activeId = state.activeAssistantMessageId;
        stopActivityDots(activeId);
        state.messages = state.messages.filter((message) => message.id !== activeId);
        state.activeAssistantMessageId = null;
        renderMessages();
      }
      markMessageStatus(optimistic.id, 'failed');
      els.message.value = rawText;
      els.message.focus();
      if (submissionSessionId
        && await finishIfSessionBecameUnavailable(submissionSessionId, error, submissionGeneration)) {
        return;
      }
      if (submissionSessionId) completeSessionTurn(submissionSessionId, previousSessionState || 'idle');
      setError(error.message || i18n('chat.error.send'));
      finishTurn();
    }
  }

  // 切换发送/停止控件忙碌态：忙碌时禁用发送按钮（防连点）并显示停止按钮。
  function setSendControlsBusy(busy) {
    if (els.sendMessage) {
      els.sendMessage.disabled = busy || state.imageUploadPending || !hasSelectableMode() || !isModeSelectable(selectedChatMode());
    }
    if (els.stopMessage) {
      els.stopMessage.hidden = !busy || state.turnPhase === 'submitting';
    }
  }

  // DELETE returns only after the server has killed the managed session. Keep
  // the composer in stopping state until that terminal response is received.
  async function cancelActiveTurn() {
    const sessionId = state.turnSessionId || state.activeSessionId;
    if (!sessionId || !isTurnBusy() || state.turnPhase === 'stopping') return;
    const sessionGeneration = ++state.activeSessionGeneration;
    state.userCancelled = true;
    setTurnPhase('stopping', { sessionId });
    closeStream({ preserveActiveAssistant: true });
    try {
      const response = await window.AgentXAuth.authFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
      });
      if (!response.ok) throw await apiErrorFromResponse(response, i18n('chat.error.stop'));
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      try {
        await refreshLog({ discardIfMessagesChanged: true });
      } catch (refreshError) {
        if (isUnavailableSessionStatusError(refreshError)) {
          await finishUnavailableSession(sessionId, refreshError, sessionGeneration);
          return;
        }
      }
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      if (state.activeAssistantMessageId) {
        const active = state.messages.find((message) => message.id === state.activeAssistantMessageId);
        if (active && active.status === 'streaming' && isLookupActivityText(active.text)) {
          stopActivityDots(active.id);
          state.messages = state.messages.filter((message) => message.id !== active.id);
        } else if (active) {
          stopActivityDots(active.id);
          active.status = undefined;
        }
        state.activeAssistantMessageId = null;
      }
      completeSessionTurn(sessionId, 'idle');
      await loadSessions({ sessionGeneration });
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      state.userCancelled = false;
      finishTurn(sessionId);
      setError(i18n('chat.error.stopDone'));
      renderMessages();
    } catch (error) {
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      state.userCancelled = false;
      if (isUnavailableSessionStatusError(error)) {
        await finishUnavailableSession(sessionId, error, sessionGeneration);
        return;
      }
      let status = '';
      let statusUncertain = false;
      try {
        status = await pollSessionStatus(sessionId);
      } catch (statusError) {
        if (isUnavailableSessionStatusError(statusError)) {
          await finishUnavailableSession(sessionId, statusError, sessionGeneration);
          return;
        }
        statusUncertain = true;
      }
      if (!status) statusUncertain = true;
      if (!isCurrentSessionGeneration(sessionId, sessionGeneration)) return;
      if (status === 'running') {
        setTurnPhase('running', { sessionId });
        openStream(sessionId, { preserveActiveAssistant: true });
      } else if (status && isCurrentSessionGeneration(sessionId, sessionGeneration)) {
        finishTurn(sessionId);
      } else if (statusUncertain && isCurrentSessionGeneration(sessionId, sessionGeneration)) {
        // DELETE and the follow-up status probe both failed. The server may
        // still be running, so never manufacture an idle state locally.
        setTurnPhase('running', { sessionId });
        scheduleStreamReconnect(sessionId, sessionGeneration);
      }
      throw error;
    }
  }

  function formatPayloadMessages(payload, options = {}) {
    // P1-5 / R-4 (multi-agent audit): prefer the caller-provided sessionId
    // (captured at request time) over state.activeSessionId (mutable), so
    // late responses cannot stamp messages with the wrong session id.
    const effectiveSessionId = options.sessionId ?? state.activeSessionId;
    if (Array.isArray(payload.messages)) {
      const messages = payload.messages
        .map((message) => ({
          id: nextClientId('server'),
          role: message.role === 'user' ? 'user' : 'assistant',
          text: stripVisibleFingerprintMarker(message.text),
          sessionId: effectiveSessionId,
          turnId: message.turnId,
          citations: message.sourceCitationSummary,
          sourceCitationSummary: message.sourceCitationSummary
        }))
        .filter((message) => message.text.trim() !== '');
      const topLevelCitations = payload.outputMeta?.citations;
      if (topLevelCitations) {
        const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
        if (lastAssistant && !lastAssistant.citations) {
          lastAssistant.citations = topLevelCitations;
          lastAssistant.outputMeta = payload.outputMeta;
        }
      }
      return messages;
    }

    const output = formatOutputData(payload.output || '');
    return output
      ? [{
          id: nextClientId('server'),
          role: 'assistant',
          text: output,
          sessionId: state.activeSessionId,
          outputMeta: payload.outputMeta,
          citations: payload.outputMeta?.citations
        }]
      : [];
  }

  function formatOutputData(rawData, options = {}) {
    const includeResult = options.includeResult !== false;
    const text = String(rawData || '').trim();
    if (!text) {
      return '';
    }
    const items = { plain: [], assistant: [], result: [] };
    for (const line of text.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate.startsWith('{')) {
        if (includeResult) {
          items.plain.push(stripToolProcessMarkup(line));
        }
        continue;
      }
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          items.assistant.push(stripToolProcessMarkup(
            parsed.message.content.filter((part) => part.type === 'text').map((part) => part.text || '').join('')
          ));
        } else if (parsed.type === 'result' && parsed.result !== undefined) {
          items.result.push(stripToolProcessMarkup(String(parsed.result)));
        }
      } catch {
        if (includeResult) {
          items.plain.push(stripToolProcessMarkup(line));
        }
      }
    }

    const candidates = items.result.length > 0
      ? items.result
      : (items.assistant.length > 0 ? [items.assistant[items.assistant.length - 1]] : items.plain);
    const output = candidates
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    if (!includeResult && items.result.length > 0) {
      return '';
    }
    return stripVisibleFingerprintMarker(output.filter(Boolean).join('\n'));
  }

  function stripVisibleFingerprintMarker(text) {
    return String(text || '').replace(visibleFingerprintPattern, '').trim();
  }

  function stripToolProcessMarkup(text) {
    return String(text || '')
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
      .replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, '')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== '')
      .join('\n');
  }

  async function init() {
    // 刷新孤儿流清理：上一页若有活动流，sessionStorage 会残留其 sessionId。
    // 这里在打开任何新流之前关闭残留旧流，并清掉持久化记录，避免新旧流双触发、乱序渲染。
    if (readPersistedActiveStream()) {
      closeStream();
      clearPersistedActiveStream();
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (isTurnBusy() && (state.turnSessionId || state.activeSessionId)) {
          state.hiddenDuringActiveTurn = true;
          closeStream({ preserveActiveAssistant: true, forReconnect: true });
        }
      } else if (document.visibilityState === 'visible' && state.hiddenDuringActiveTurn) {
        reconcileVisibleTurn().catch((error) => setError(error.message));
      }
    };
    window.addEventListener('pagehide', () => closeStream());
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const user = window.AgentXAuth.getUser();
    applyLocale(
      user?.localePreference
      || user?.preferredLanguage
      || window.AgentXI18n?.getLocale?.()
      || 'zh-CN'
    );
    state.authorizedModels = Array.isArray(user?.authorizedModels) ? user.authorizedModels : [];
    state.creditBalanceUnits = Number.isInteger(user?.credits?.balanceUnits) ? user.credits.balanceUnits : null;
    if (els.userStatus) {
      els.userStatus.textContent = user?.username || i18n('chat.common.loggedIn');
    }
    if (els.adminLink) {
      els.adminLink.hidden = user?.role !== 'admin';
    }
    initChatSidebarCollapse();
    try {
      await loadSearchModes();
    } catch (error) {
      state.searchModes = [];
      renderSearchModeOptions();
      setChatMode('');
      setError(error.message || i18n('chat.error.loadModes'));
    }
    if (els.logout) {
      els.logout.addEventListener('click', window.AgentXAuth.logout);
    }
    els.newSession.addEventListener('click', () => {
      if (state.turnPhase === 'submitting') {
        setError(i18n('chat.session.newBlocked'));
        return;
      }
      setMobileSidebarOpen(false);
      state.activeSessionGeneration += 1;
      state.userCancelled = false;
      state.activeSessionId = null;
      state.activeChipId = null;
      state.activeAssistantMessageId = null;
      setChatMode(firstAvailableMode());
      clearPendingImages({ skipSync: true });
      syncChipSelector();
      syncChatModeControls();
      resetScopeSelection();
      closeStream();
      finishTurn();
      setMessages([]);
      renderSessions();
      renderSessionMeta();
      els.message.focus();
    });
    els.message.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        els.messageForm.requestSubmit();
      }
    });
    els.imageInput?.addEventListener('change', () => {
      handleImageSelection().catch((error) => setError(error.message));
    });
    els.message.addEventListener('paste', (event) => {
      const files = imageFilesFromTransfer(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      handleImageFiles(files).catch((error) => setError(error.message));
    });
    els.messageForm.addEventListener('dragover', (event) => {
      if (!selectedModeAllowsImageInput()) return;
      event.preventDefault();
      els.messageForm.classList.add('is-dragover');
    });
    els.messageForm.addEventListener('dragleave', () => els.messageForm.classList.remove('is-dragover'));
    els.messageForm.addEventListener('drop', (event) => {
      els.messageForm.classList.remove('is-dragover');
      const files = imageFilesFromTransfer(event.dataTransfer);
      if (!files.length) return;
      event.preventDefault();
      handleImageFiles(files).catch((error) => setError(error.message));
    });
    els.stopMessage?.addEventListener('click', () => {
      cancelActiveTurn().catch((error) => setError(error.message));
    });
    els.messageForm.addEventListener('submit', (event) => {
      sendMessage(event).catch((error) => setError(error.message));
    });
    els.sessionSearch?.addEventListener('input', () => {
      state.sessionSearchQuery = els.sessionSearch.value;
      renderSessions();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setMobileSidebarOpen(false);
    });
    await loadChips();
    await loadScopePresets();
    await loadScopeOptions();
    renderScopeModes();
    renderScopeContentPanel();
    renderScopePillbar();
    applyScopeCollapsed();
    await loadSessions();
    if (state.sessions.length > 0) {
      await selectSession(state.sessions[0].id);
    } else {
      setMessages([]);
    }
  }

  async function loadChips() {
    const response = await window.AgentXAuth.authFetch('/chips');
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    state.chips = payload.chips || [];
    renderChipSelect();
  }

  async function loadScopePresets() {
    try {
      const response = await window.AgentXAuth.authFetch('/api/scope-presets');
      if (!response.ok) {
        return;
      }
      const payload = await response.json();
      state.scopePresets = payload.presets || [];
    } catch {
      // 拉取失败时保持空列表，仅留"不限范围"首项
      state.scopePresets = [];
    }
    renderScopeSelect();
  }

  function renderScopeSelect() {
    if (!els.scopeSelect) return;
    els.scopeSelect.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = i18n('chat.scope.all');
    els.scopeSelect.append(allOpt);
    for (const preset of state.scopePresets) {
      const opt = document.createElement('option');
      opt.value = preset.scopePresetId;
      opt.textContent = preset.label;
      els.scopeSelect.append(opt);
    }
    els.scopeSelect.addEventListener('change', () => {
      state.selectedScopePresetId = els.scopeSelect.value;
    });
  }

  function renderChipSelect() {
    els.chipSelect.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = i18n('chat.chip.choose');
    placeholder.disabled = true;
    placeholder.selected = true;
    els.chipSelect.append(placeholder);
    for (const chip of state.chips) {
      const opt = document.createElement('option');
      opt.value = chip.id;
      opt.textContent = chip.label;
      els.chipSelect.append(opt);
    }
  }

  // ── 范围选择器（展开态三步：查询范围 → 内容 → 查询模式）─────────────────
  const SCOPE_MODES = ['single', 'group', 'global'];
  // 记录下拉框上一次是否可见：入场动画只在「不可见 → 可见」那次渲染播放一次，
  // 避免选中分组/芯片、改筛选、输入搜索导致面板重建时重放动画造成闪烁。
  let scopeDropdownShown = false;

  async function loadScopeOptions() {
    try {
      const response = await window.AgentXAuth.authFetch('/api/scope-options');
      if (!response.ok) {
        state.scopeOptions = null;
        return;
      }
      state.scopeOptions = await response.json();
    } catch {
      // 拉取失败不阻塞聊天：单芯片模式仍可用现有 chip 列表
      state.scopeOptions = null;
    }
  }

  function scopeChipOptions() {
    return state.scopeOptions?.single?.chips || [];
  }

  function allScopeChipOptions() {
    const chips = scopeChipOptions();
    return chips.length
      ? chips
      : state.chips.map((chip) => ({
          chipId: chip.id,
          label: chip.label,
          brand: chip.brand || '',
          productLines: chip.productLines || [],
          fileCount: 0
        }));
  }

  function globalAuthorizedChipCount() {
    const count = state.scopeOptions?.global?.chipIds?.length;
    return Number.isInteger(count) ? count : allScopeChipOptions().length;
  }

  function globalAuthorizedFileCount() {
    const count = state.scopeOptions?.global?.fileCount;
    return Number.isInteger(count) ? count : null;
  }

  function globalScopeIsTooLarge() {
    return Boolean(state.scopeOptions?.global?.tooLarge);
  }

  function setScopeMode(mode) {
    if (!SCOPE_MODES.includes(mode) || state.scopeMode === mode) {
      return;
    }
    state.scopeMode = mode;
    state.scopeContentOpen = false;
    state.scopeContentSearch = '';
    state.scopeGroupSearch = '';
    renderScopeModes();
    renderScopeContentPanel();
    renderScopePillbar();
    syncScopeLock();
  }

  function renderScopeModes() {
    if (!els.scopeModeOptions) return;
    els.scopeModeOptions.replaceChildren();
    for (const mode of SCOPE_MODES) {
      const label = document.createElement('label');
      label.className = 'chat-scope-mode';
      label.dataset.scopeMode = mode;
      if (mode === state.scopeMode) {
        label.classList.add('selected');
      }

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'scope-mode';
      input.value = mode;
      input.checked = mode === state.scopeMode;
      input.addEventListener('change', () => setScopeMode(mode));

      const text = document.createElement('span');
      text.textContent = i18n(`chat.scope.mode.${mode}`);

      label.append(input, text);
      els.scopeModeOptions.append(label);
    }
  }

  function renderScopeContentPanel() {
    const panel = els.scopeContentPanel;
    if (!panel) return;
    const dropdownVisible = state.scopeMode !== 'global' && state.scopeContentOpen;
    const justOpened = dropdownVisible && !scopeDropdownShown;
    scopeDropdownShown = dropdownVisible;
    panel.replaceChildren();
    panel.classList.remove('is-empty', 'is-open', 'is-global');
    if (state.scopeMode === 'global') {
      state.scopeContentOpen = false;
      panel.classList.add('is-empty', 'is-global');
      renderScopeGlobalHint(panel);
      return;
    }

    panel.append(renderScopeContentTrigger());
    if (state.scopeContentOpen) {
      panel.classList.add('is-open');
      const dropdown = document.createElement('div');
      dropdown.className = 'chat-scope-dropdown';
      // 仅首次打开播放入场动画；面板内重渲染（选中/筛选/搜索）不再触发动画。
      if (justOpened) dropdown.classList.add('is-entering');
      dropdown.dataset.scopeDropdown = state.scopeMode;
      if (state.scopeMode === 'group') {
        renderScopeGroupDropdown(dropdown);
      } else {
        renderScopeSingleDropdown(dropdown);
      }
      panel.append(dropdown);
    }
  }

  function renderScopeContentTrigger() {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'chat-scope-content-trigger';
    trigger.setAttribute('aria-expanded', String(state.scopeContentOpen));
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      state.scopeContentOpen = !state.scopeContentOpen;
      renderScopeContentPanel();
      syncScopeLock();
    });

    const tags = document.createElement('span');
    tags.className = 'chat-scope-selected-tags';
    for (const tag of selectedScopeTags()) {
      const chip = document.createElement('span');
      chip.className = 'chat-scope-selected-tag';
      chip.textContent = tag;
      tags.append(chip);
    }

    const add = document.createElement('span');
    add.className = 'chat-scope-add-tag';
    add.textContent = i18n('chat.scope.add');
    tags.append(add);

    trigger.append(tags);
    return trigger;
  }

  function selectedScopeTags() {
    if (state.scopeMode === 'group') {
      return state.selectedGroups.length
        ? state.selectedGroups.map((group) => scopeGroupLabel(group))
        : [i18n('chat.scope.summary.empty')];
    }
    return [scopeChipLabel(state.selectedScopeChipId) || i18n('chat.scope.summary.empty')];
  }

  function renderScopeGlobalHint(panel) {
    const hint = document.createElement('p');
    hint.className = 'chat-scope-global-hint';
    const fileCount = globalAuthorizedFileCount();
    const key = fileCount === null
      ? 'chat.scope.global.hint.countOnly'
      : globalScopeIsTooLarge()
        ? 'chat.scope.global.hint.large'
        : 'chat.scope.global.hint';
    hint.textContent = i18nFormat(key, {
      count: globalAuthorizedChipCount(),
      fileCount
    });
    panel.append(hint);
  }

  function renderScopeSingleDropdown(dropdown) {
    const chips = allScopeChipOptions();
    dropdown.append(renderScopeSingleFilters(chips));

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'chat-scope-search';
    search.placeholder = i18n('chat.scope.search.placeholder');
    search.value = state.scopeContentSearch;
    search.setAttribute('aria-label', i18n('chat.scope.search.placeholder'));
    search.addEventListener('input', () => {
      state.scopeContentSearch = search.value;
      renderScopeContentPanel();
      syncScopeLock();
      const nextSearch = els.scopeContentPanel?.querySelector('.chat-scope-search');
      nextSearch?.focus();
    });
    dropdown.append(search);

    const listHost = document.createElement('div');
    listHost.className = 'chat-scope-candidate-list';
    dropdown.append(listHost);
    const matched = filteredScopeChips(chips);
    renderScopeSingleList(listHost, matched);

    const footer = document.createElement('div');
    footer.className = 'chat-scope-list-footer';
    footer.textContent = i18nFormat('chat.scope.candidate.total', { count: matched.length });
    dropdown.append(footer);
  }

  function renderScopeSingleFilters(chips) {
    const filters = document.createElement('div');
    filters.className = 'chat-scope-filterbar';

    const label = document.createElement('span');
    label.className = 'chat-scope-filter-label';
    label.textContent = i18n('chat.scope.filter.label');
    filters.append(label);

    filters.append(
      buildScopeFilterSelect(
        'brand',
        i18n('chat.scope.filter.brand'),
        uniqueSorted(chips.map((chip) => chip.brand).filter(Boolean)),
        state.scopeContentFilterBrand,
        (value) => {
          state.scopeContentFilterBrand = value;
          renderScopeContentPanel();
          syncScopeLock();
        }
      )
    );

    filters.append(
      buildScopeFilterSelect(
        'productLine',
        i18n('chat.scope.filter.productLine'),
        uniqueSorted(chips.flatMap((chip) => chip.productLines || [])),
        state.scopeContentFilterProductLine,
        (value) => {
          state.scopeContentFilterProductLine = value;
          renderScopeContentPanel();
          syncScopeLock();
        }
      )
    );

    return filters;
  }

  function buildScopeFilterSelect(name, placeholder, values, current, onChange) {
    const select = document.createElement('select');
    select.className = 'chat-scope-filter-select';
    select.name = `scope-${name}-filter`;
    select.setAttribute('aria-label', placeholder);

    const all = document.createElement('option');
    all.value = '';
    all.textContent = placeholder;
    select.append(all);

    for (const value of values) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    select.value = current || '';
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  function filteredScopeChips(chips) {
    const query = state.scopeContentSearch.trim().toLowerCase();
    const brand = state.scopeContentFilterBrand;
    const productLine = state.scopeContentFilterProductLine;
    return chips
      .filter((chip) => {
        if (brand && chip.brand !== brand) return false;
        if (productLine && !(chip.productLines || []).includes(productLine)) return false;
        if (!query) return true;
        return (
          String(chip.chipId).toLowerCase().includes(query) ||
          String(chip.label || '').toLowerCase().includes(query)
        );
      })
      .sort((left, right) => {
        const leftSelected = left.chipId === state.selectedScopeChipId ? 0 : 1;
        const rightSelected = right.chipId === state.selectedScopeChipId ? 0 : 1;
        return leftSelected - rightSelected || String(left.chipId).localeCompare(String(right.chipId));
      });
  }

  function renderScopeSingleList(host, chips) {
    host.replaceChildren();
    if (chips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-scope-empty';
      empty.textContent = i18n('chat.scope.empty.chips');
      host.append(empty);
      return;
    }

    const groups = new Map();
    for (const chip of chips) {
      const lines = chip.productLines && chip.productLines.length ? chip.productLines : [i18n('chat.scope.group.other')];
      const key = lines[0];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(chip);
    }

    for (const [groupName, groupChips] of groups) {
      const title = document.createElement('div');
      title.className = 'chat-scope-group-title';
      title.textContent = `${groupName} · ${i18nFormat('chat.scope.count.chips', { count: groupChips.length })}`;
      host.append(title);

      const row = document.createElement('div');
      row.className = 'chat-scope-chip-pills';
      for (const chip of groupChips) {
        row.append(buildScopeChipPill(chip));
      }
      host.append(row);
    }
  }

  function buildScopeChipPill(chip) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'chat-scope-candidate-pill';
    const selected = chip.chipId === state.selectedScopeChipId;
    pill.classList.toggle('selected', selected);
    pill.setAttribute('aria-pressed', String(selected));
    pill.textContent = chip.label || chip.chipId;
    if (selected) {
      const checkIcon = createIcon('check');
      checkIcon.style.marginRight = '4px';
      checkIcon.style.verticalAlign = '-2px';
      pill.prepend(checkIcon);
    }
    pill.addEventListener('click', () => {
      state.selectedScopeChipId = chip.chipId;
      state.scopeContentOpen = false;
      renderScopeContentPanel();
      renderScopePillbar();
      syncScopeLock();
    });
    return pill;
  }

  function groupKey(group) {
    return `${group.dimension}:${group.value}`;
  }

  function isGroupSelected(group) {
    return state.selectedGroups.some(
      (selected) => selected.dimension === group.dimension && selected.value === group.value
    );
  }

  function toggleGroupSelection(group, checked) {
    const without = state.selectedGroups.filter(
      (selected) => !(selected.dimension === group.dimension && selected.value === group.value)
    );
    state.selectedGroups = checked
      ? [...without, { dimension: group.dimension, value: group.value }]
      : without;
  }

  function renderScopeGroupDropdown(dropdown) {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'chat-scope-search';
    search.placeholder = i18n('chat.scope.group.search.placeholder');
    search.value = state.scopeGroupSearch;
    search.setAttribute('aria-label', i18n('chat.scope.group.search.placeholder'));
    search.addEventListener('input', () => {
      state.scopeGroupSearch = search.value;
      renderScopeContentPanel();
      syncScopeLock();
      const nextSearch = els.scopeContentPanel?.querySelector('.chat-scope-search');
      nextSearch?.focus();
    });
    dropdown.append(search);

    const groupData = state.scopeOptions?.group || { productLines: [], brands: [], applications: [] };
    const sections = [
      ['chat.scope.group.productLines', groupData.productLines || []],
      ['chat.scope.group.brands', groupData.brands || []],
      ['chat.scope.group.applications', groupData.applications || []]
    ];
    const query = state.scopeGroupSearch.trim().toLowerCase();

    const list = document.createElement('div');
    list.className = 'chat-scope-group-list';
    let rendered = 0;
    for (const [titleKey, groups] of sections) {
      const filtered = query
        ? groups.filter((group) => `${group.label || group.value} ${group.value}`.toLowerCase().includes(query))
        : groups;
      if (!filtered.length) continue;
      rendered += filtered.length;
      const title = document.createElement('div');
      title.className = 'chat-scope-group-title';
      title.textContent = i18n(titleKey);
      list.append(title);
      for (const group of filtered) {
        list.append(buildScopeGroupRow(group));
      }
    }

    if (rendered === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-scope-empty';
      empty.textContent = i18n('chat.scope.empty.groups');
      list.append(empty);
    }

    dropdown.append(list);
    dropdown.append(renderScopeGroupSummary());
  }

  function renderScopeGroupSummary() {
    const summary = document.createElement('div');
    summary.className = 'chat-scope-summary';
    summary.dataset.role = 'scope-group-summary';
    summary.textContent = i18nFormat('chat.scope.selected.summary', {
      count: state.selectedGroups.length,
      chipCount: selectedScopeGroupChipCount()
    });
    return summary;
  }

  function buildScopeGroupRow(group) {
    const row = document.createElement('label');
    row.className = 'chat-scope-option';
    row.dataset.dimension = group.dimension;
    row.dataset.value = group.value;
    const selected = isGroupSelected(group);
    if (selected) {
      row.classList.add('selected');
    }

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = groupKey(group);
    input.checked = selected;

    const label = document.createElement('span');
    label.className = 'chat-scope-option-label';
    label.textContent = group.label || group.value;

    const count = document.createElement('span');
    count.className = 'chat-scope-count';
    count.textContent = i18nFormat('chat.scope.count.chips', { count: (group.chipIds || []).length });

    let tooLargeBadge = null;
    if (group.tooLarge) {
      row.classList.add('too-large');
      tooLargeBadge = document.createElement('span');
      tooLargeBadge.className = 'chat-scope-badge';
      tooLargeBadge.textContent = i18n('chat.scope.tooLarge');
    }

    input.addEventListener('change', () => {
      toggleGroupSelection(group, input.checked);
      renderScopeContentPanel();
      renderScopePillbar();
      syncScopeLock();
    });

    if (tooLargeBadge) {
      row.append(input, label, count, tooLargeBadge);
    } else {
      row.append(input, label, count);
    }
    return row;
  }

  function selectedScopeGroupChipCount() {
    const selectedKeys = new Set(state.selectedGroups.map(groupKey));
    const groupData = state.scopeOptions?.group || { productLines: [], brands: [], applications: [] };
    const all = [...(groupData.productLines || []), ...(groupData.brands || []), ...(groupData.applications || [])];
    const chips = new Set();
    for (const group of all) {
      if (!selectedKeys.has(groupKey(group))) continue;
      for (const chipId of group.chipIds || []) {
        chips.add(chipId);
      }
    }
    return chips.size;
  }

  function uniqueSorted(values) {
    return [...new Set(values.filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right)));
  }

  function resetScopeSelection() {
    // 新会话：回默认「单芯片」并绑定当前芯片，展开三步面板（解锁重选）。
    state.scopeMode = 'single';
    state.selectedGroups = [];
    state.scopeContentSearch = '';
    state.scopeGroupSearch = '';
    state.scopeContentOpen = false;
    state.scopeContentFilterBrand = '';
    state.scopeContentFilterProductLine = '';
    state.selectedScopeChipId = state.activeChipId || null;
    state.restoredScopeLabel = '';
    state.scopeCollapsed = false;
    renderScopeModes();
    renderScopeContentPanel();
    renderScopePillbar();
    applyScopeCollapsed();
  }

  // ── D4：折叠 / 悬浮胶囊 / 动画 / 会话内持久 ─────────────────────────────

  function scopeSummary() {
    const range = i18n(`chat.scope.summary.${state.scopeMode}`);
    const mode = chatModeLabel(state.chatMode);
    let content;
    if (state.scopeMode === 'global') {
      content = i18nFormat('chat.scope.summary.global.content', { count: globalAuthorizedChipCount() });
    } else if (state.scopeMode === 'group') {
      const labels = state.selectedGroups.map((group) => scopeGroupLabel(group));
      if (labels.length === 0) {
        content = state.restoredScopeLabel || i18n('chat.scope.summary.empty');
      } else if (labels.length === 1) {
        content = labels[0];
      } else {
        content = i18nFormat('chat.scope.summary.more', {
          first: labels[0],
          rest: labels.length - 1
        });
      }
    } else {
      content = scopeChipLabel(state.selectedScopeChipId) || i18n('chat.scope.summary.empty');
    }
    return { range, content, mode };
  }

  function scopeGroupLabel(group) {
    const groupData = state.scopeOptions?.group || { productLines: [], brands: [], applications: [] };
    const all = [...(groupData.productLines || []), ...(groupData.brands || []), ...(groupData.applications || [])];
    const found = all.find(
      (item) => item.dimension === group.dimension && item.value === group.value
    );
    return found?.label || group.value;
  }

  function scopeChipLabel(chipId) {
    if (!chipId) return '';
    const fromOptions = scopeChipOptions().find((chip) => chip.chipId === chipId);
    if (fromOptions) return fromOptions.label || fromOptions.chipId;
    const fromChips = state.chips.find((chip) => chip.id === chipId);
    return fromChips?.label || chipId;
  }

  function renderScopePillbar() {
    const bar = els.scopePillbar;
    if (!bar) return;
    bar.replaceChildren();
    const summary = scopeSummary();
    const segments = [
      ['chat.scope.pill.range', summary.range],
      ['chat.scope.pill.content', summary.content],
      ['chat.scope.pill.mode', summary.mode]
    ];
    for (const [labelKey, value] of segments) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chat-chip-pill chat-scope-pill-chip';
      pill.addEventListener('click', () => expandScopeSelector());
      const label = document.createElement('span');
      label.className = 'chat-scope-pill-key';
      label.textContent = i18n(labelKey);
      const text = document.createElement('strong');
      text.className = 'chat-scope-pill-value';
      text.textContent = value;
      const arrow = document.createElement('span');
      arrow.className = 'chat-scope-pill-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '⌄';
      pill.append(label, text, arrow);
      bar.append(pill);
    }
  }

  function applyScopeCollapsed() {
    const root = els.scopeSelector;
    if (!root) return;
    root.classList.toggle('collapsed', state.scopeCollapsed);
    if (els.scopePillbar) {
      els.scopePillbar.hidden = !state.scopeCollapsed;
    }
    if (els.scopeSteps) {
      els.scopeSteps.setAttribute('aria-hidden', state.scopeCollapsed ? 'true' : 'false');
    }
  }

  function collapseScopeToPills() {
    state.scopeCollapsed = true;
    state.scopeContentOpen = false;
    renderScopePillbar();
    applyScopeCollapsed();
  }

  function expandScopeSelector() {
    if (!canChangeChatMode()) {
      return;
    }
    state.scopeCollapsed = false;
    applyScopeCollapsed();
  }

  function toggleScopeSelector() {
    if (state.scopeCollapsed) {
      expandScopeSelector();
    } else {
      collapseScopeToPills();
    }
  }

  function syncScopeLock() {
    const root = els.scopeSelector;
    if (!root) return;
    const locked = !canChangeChatMode();
    root.classList.toggle('scope-locked', locked);
    const interactive = root.querySelectorAll(
      '[data-scope-step="range"] input, [data-scope-step="range"] button,' +
        ' [data-scope-step="content"] input, [data-scope-step="content"] button,' +
        ' [data-scope-step="content"] select, .chat-scope-search'
    );
    for (const node of interactive) {
      node.disabled = locked;
    }
  }

  document.addEventListener('click', (event) => {
    if (!state.scopeContentOpen) return;
    if (event.target.closest('#scope-selector')) return;
    state.scopeContentOpen = false;
    renderScopeContentPanel();
    syncScopeLock();
  });

  if (els.scopePillbar) {
    els.scopePillbar.addEventListener('click', (event) => {
      if (event.target.closest('.chat-scope-pill-chip')) return;
      toggleScopeSelector();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (initStarted) return;
    initStarted = true;
    init().catch((error) => setError(error.message));
  });
})();
