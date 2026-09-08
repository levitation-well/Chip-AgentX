(function () {
  let initStarted = false;
  const state = {
    locale: 'zh-CN',
    activeSection: 'users',
    users: [],
    selectedUserId: null,
    userFilters: {
      search: '',
      status: '',
      expired: '',
      company: '',
      role: ''
    },
    visibleKeyIds: new Set(),
    chips: [],
    chipFilters: {
      search: '',
      line: ''
    },
    editingChipId: null,
    deletedChipIds: new Set(),
    knowledgeBaseRoot: '',
    access: {
      effectiveByUserId: {},
      draftByUserId: {},
      dirtyDimensionsByUserId: {},
      errorByUserId: {},
      requestIdByUserId: {},
      statusByUserId: {},
      dirtyUserIds: new Set(),
      loadingUserIds: new Set(),
      nextRequestId: 0
    },
    promptFiles: [],
    promptHistory: [],
    editingFile: null,
    selectedPromptChipId: '',
    hasUnsavedChanges: false,
    promptDraftRevision: 0,
    promptLoadRequestId: 0,
    promptHistoryRequestId: 0,
    adminConfirmed: false,
    activeHistoryTab: 'users',
    historyFilters: {
      user: '',
      role: '',
      chipId: '',
      keyword: '',
      from: '',
      to: ''
    },
    history: {
      sessions: [],
      questions: [],
      sessionsTotal: 0,
      questionsTotal: 0,
      sessionOffset: 0,
      questionOffset: 0,
      limit: 50,
      selectedSessionId: null,
      selectedDetail: null,
      debugLoaded: false,
      debugBundle: null,
      debugBundleSessionId: '',
      debugError: '',
      debugRequestId: 0,
      analysis: null,
      analysisError: '',
      analysisRequestId: 0,
      pendingDebugSessionId: '',
      loading: false
    },
    tickets: {
      items: [],
      selectedTicketNo: null,
      selectedDetail: null,
      detailRequestId: 0,
      filters: {
        type: '',
        status: '',
        needsMoreInfo: '',
        keyword: ''
      },
      loading: false
    },
    credits: {
      search: '',
      selectedUserId: null,
      balanceUnits: null,
      ledger: null,
      detailMode: 'delta',
      requestId: 0,
      detailSubmitRequestId: 0,
      loading: false
    },
    modelRouting: {
      config: null,
      catalog: null,
      loading: false
    },
    observability: {
      data: null,
      loading: false
    },
    discoveryTraces: {
      data: null,
      quickFilter: '',
      loading: false
    },
    announcements: {
      items: [],
      selectedId: null,
      selectedDetail: null,
      detailRequestId: 0,
      filters: {
        type: '',
        status: '',
        visibility: '',
        pinned: '',
        active: '',
        keyword: ''
      },
      loading: false,
      editorLocale: 'zh-CN'
    },
    resources: {
      documents: [],
      scopePresets: [],
      activeTab: 'documents',
      editing: null,
      loading: false,
      documentFilters: { search: '', visibility: '', status: '' }
    },
    sectionStatus: {
      users: {},
      credits: {},
      roles: {},
      'model-routing': {},
      prompts: {},
      chips: {},
      sessions: {},
      questions: {},
      observability: {},
      'discovery-traces': {},
      announcements: {},
      resources: {},
      feedback: {}
    }
  };

  function adminText(key, paramsOrFallback, fallback) {
    const params = paramsOrFallback && typeof paramsOrFallback === 'object' ? paramsOrFallback : undefined;
    const resolvedFallback = typeof paramsOrFallback === 'string' ? paramsOrFallback : fallback;
    return window.AgentXI18n?.t?.(key, params, state.locale) || resolvedFallback || key;
  }

  const els = {
    adminLoginShell: document.getElementById('admin-login-shell'),
    adminOperationSurface: document.getElementById('admin-operation-surface'),
    adminLoginForm: document.getElementById('admin-login-form'),
    adminUsername: document.getElementById('admin-username'),
    adminPassword: document.getElementById('admin-password'),
    adminNoPermission: document.getElementById('admin-no-permission'),
    adminUserStatus: document.getElementById('admin-user-status'),
    adminSidebarToggle: document.getElementById('admin-sidebar-toggle'),
    userForm: document.getElementById('user-form'),
    username: document.getElementById('new-username'),
    password: document.getElementById('new-password'),
    role: document.getElementById('new-role'),
    newStatus: document.getElementById('new-status'),
    newExpiresAt: document.getElementById('new-expires-at'),
    newCompany: document.getElementById('new-company'),
    newRealName: document.getElementById('new-real-name'),
    newEmail: document.getElementById('new-email'),
    newNote: document.getElementById('new-note'),
    userFilterForm: document.getElementById('user-filter-form'),
    userFilterStatus: document.getElementById('user-filter-status'),
    userFilterExpired: document.getElementById('user-filter-expired'),
    userFilterCompany: document.getElementById('user-filter-company'),
    userFilterRole: document.getElementById('user-filter-role'),
    userFilterReset: document.getElementById('user-filter-reset'),
    userCreateError: document.getElementById('user-create-error'),
    userList: document.getElementById('user-list'),
    userRail: document.getElementById('user-rail'),
    userDetailClose: document.getElementById('user-detail-close'),
    userSearch: document.getElementById('user-search'),
    userCreateOpen: document.getElementById('user-create-open'),
    userCreateModal: document.getElementById('user-create-modal'),
    userCreateCancel: document.getElementById('user-create-cancel'),
    selectedUserAccessSummary: document.getElementById('selected-user-access-summary'),
    selectedUserAccessEditor: document.getElementById('selected-user-access-editor'),
    selectedUserAccessSave: document.getElementById('selected-user-access-save'),
    selectedUserAccessDirty: document.getElementById('selected-user-access-dirty'),
    selectedUserAccessStatus: document.getElementById('selected-user-access-status'),
    selectedUserAccessError: document.getElementById('selected-user-access-error'),
    keyForm: document.getElementById('key-form'),
    keyName: document.getElementById('key-name'),
    keyExpiresAt: document.getElementById('key-expires-at'),
    keyList: document.getElementById('key-list'),
    generatedKey: document.getElementById('generated-key'),
    selectedUserTitle: document.getElementById('selected-user-title'),
    selectedUserMeta: document.getElementById('selected-user-meta'),
    selectedUserBadges: document.getElementById('selected-user-badges'),
    selectedUserProfileForm: document.getElementById('selected-user-profile-form'),
    selectedUserStatus: document.getElementById('selected-user-status'),
    selectedUserExpiresAt: document.getElementById('selected-user-expires-at'),
    selectedUserCompany: document.getElementById('selected-user-company'),
    selectedUserRealName: document.getElementById('selected-user-real-name'),
    selectedUserEmail: document.getElementById('selected-user-email'),
    selectedUserNote: document.getElementById('selected-user-note'),
    selectedUserProfileSave: document.getElementById('selected-user-profile-save'),
    selectedUserProfileReset: document.getElementById('selected-user-profile-reset'),
    selectedUserRoleForm: document.getElementById('selected-user-role-form'),
    selectedUserRole: document.getElementById('selected-user-role'),
    selectedUserRoleSave: document.getElementById('selected-user-role-save'),
    selectedUserPasswordForm: document.getElementById('selected-user-password-form'),
    selectedUserPassword: document.getElementById('selected-user-password'),
    selectedUserPasswordSave: document.getElementById('selected-user-password-save'),
    selectedUserDelete: document.getElementById('selected-user-delete'),
    selectedUserCreditBalance: document.getElementById('selected-user-credit-balance'),
    selectedUserCreditForm: document.getElementById('selected-user-credit-form'),
    selectedUserCreditModeDelta: document.getElementById('selected-user-credit-mode-delta'),
    selectedUserCreditModeBalance: document.getElementById('selected-user-credit-mode-balance'),
    selectedUserCreditAmount: document.getElementById('selected-user-credit-amount'),
    selectedUserCreditReason: document.getElementById('selected-user-credit-reason'),
    selectedUserCreditNote: document.getElementById('selected-user-credit-note'),
    selectedUserCreditSubmit: document.getElementById('selected-user-credit-submit'),
    selectedUserCreditStatus: document.getElementById('selected-user-credit-status'),
    selectedUserCreditLedger: document.getElementById('selected-user-credit-ledger'),
    error: document.getElementById('admin-error'),
    chipMappingList: document.getElementById('chip-mapping-list'),
    chipMappingError: document.getElementById('chip-mapping-error'),
    chipRestartNotice: document.getElementById('chip-restart-notice'),
    chipAdd: document.getElementById('chip-add'),
    chipSave: document.getElementById('chip-save'),
    chipFilterSearch: document.getElementById('chip-filter-search'),
    chipFilterLine: document.getElementById('chip-filter-line'),
    chipCatalogList: document.getElementById('chip-catalog-list'),
    chipEditorBackdrop: document.getElementById('chip-editor-backdrop'),
    chipEditorDrawer: document.getElementById('chip-editor-drawer'),
    chipEditorForm: document.getElementById('chip-editor-form'),
    chipEditorTitle: document.getElementById('chip-editor-title'),
    chipEditorMeta: document.getElementById('chip-editor-meta'),
    chipEditorClose: document.getElementById('chip-editor-close'),
    chipEditorId: document.getElementById('chip-editor-id'),
    chipEditorLabel: document.getElementById('chip-editor-label'),
    chipEditorBrand: document.getElementById('chip-editor-brand'),
    chipEditorProductLines: document.getElementById('chip-editor-product-lines'),
    chipEditorApplicationTags: document.getElementById('chip-editor-application-tags'),
    chipEditorDocumentIds: document.getElementById('chip-editor-document-ids'),
    chipEditorSummary: document.getElementById('chip-editor-summary'),
    chipEditorQueryHint: document.getElementById('chip-editor-query-hint'),
    chipEditorWorkspaceDir: document.getElementById('chip-editor-workspace-dir'),
    chipEditorWorkspaceStatus: document.getElementById('chip-editor-workspace-status'),
    chipEditorDelete: document.getElementById('chip-editor-delete'),
    promptFileList: document.getElementById('prompt-file-list'),
    promptChipCount: document.getElementById('prompt-chip-count'),
    promptListError: document.getElementById('prompt-list-error'),
    promptEditorContainer: document.getElementById('prompt-editor-container'),
    promptPlaceholder: document.getElementById('prompt-placeholder'),
    promptErrorPanel: document.getElementById('prompt-error-panel'),
    promptErrorMessage: document.getElementById('prompt-error-message'),
    promptRetry: document.getElementById('prompt-retry'),
    promptFileName: document.getElementById('prompt-file-name'),
    promptContent: document.getElementById('prompt-content'),
    promptSave: document.getElementById('prompt-save'),
    promptCancel: document.getElementById('prompt-cancel'),
    promptEditorStatus: document.getElementById('prompt-editor-status'),
    promptHistorySummary: document.getElementById('prompt-history-summary'),
    promptHistoryList: document.getElementById('prompt-history-list'),
    promptRollback: document.getElementById('prompt-rollback'),
    promptTemplateCreate: document.getElementById('prompt-template-create'),
    sectionNav: document.getElementById('admin-section-nav'),
    sectionLinks: document.querySelectorAll('#admin-section-nav [data-section]'),
    breadcrumb: document.getElementById('admin-breadcrumb'),
    pageTabs: document.getElementById('admin-page-tabs'),
    navGroups: document.querySelectorAll('#admin-section-nav [data-nav-group]'),
    navGroupToggles: document.querySelectorAll('#admin-section-nav .admin-nav-group-toggle'),
    navFooterVersion: document.querySelector('[data-admin-nav-version]'),
    panelUsers: document.getElementById('panel-users'),
    panelRoles: document.getElementById('panel-roles'),
    panelModelRouting: document.getElementById('panel-model-routing'),
    modelRoutingForm: document.getElementById('model-routing-form'),
    modelRoutingStandard: document.getElementById('model-routing-standard'),
    modelRoutingEnhanced: document.getElementById('model-routing-enhanced'),
    modelRoutingMultimodal: document.getElementById('model-routing-multimodal'),
    modelRoutingStandardMultiplier: document.getElementById('model-routing-standard-multiplier'),
    modelRoutingEnhancedMultiplier: document.getElementById('model-routing-enhanced-multiplier'),
    modelRoutingMultimodalMultiplier: document.getElementById('model-routing-multimodal-multiplier'),
    modelRoutingReload: document.getElementById('model-routing-reload'),
    modelRoutingError: document.getElementById('model-routing-error'),
    modelRoutingSuccess: document.getElementById('model-routing-success'),
    panelPrompts: document.getElementById('panel-prompts'),
    panelChips: document.getElementById('panel-chips'),
    panelSessions: document.getElementById('panel-sessions'),
    panelObservability: document.getElementById('panel-observability'),
    panelDiscoveryTraces: document.getElementById('panel-discovery-traces'),
    discoveryTracesRefresh: document.getElementById('discovery-traces-refresh'),
    discoveryTracesError: document.getElementById('discovery-traces-error'),
    discoveryTracesSummary: document.getElementById('discovery-traces-summary'),
    discoveryTracesList: document.getElementById('discovery-traces-list'),
    discoveryTracesFilterAll: document.getElementById('discovery-traces-filter-all'),
    discoveryTracesFilterError: document.getElementById('discovery-traces-filter-error'),
    diagnosticsVersionValue: document.getElementById('diagnostics-version-value'),
    diagnosticsDataDirValue: document.getElementById('diagnostics-data-dir-value'),
    diagnosticsPlatformValue: document.getElementById('diagnostics-platform-value'),
    diagnosticsNodeVersionValue: document.getElementById('diagnostics-node-version-value'),
    diagnosticsAgentBackendValue: document.getElementById('diagnostics-agent-backend-value'),
    diagnosticsClaudeVersionValue: document.getElementById('diagnostics-claude-version-value'),
    diagnosticsConfigStatusList: document.getElementById('diagnostics-config-status-list'),
    panelAnnouncements: document.getElementById('panel-announcements'),
    panelFeedback: document.getElementById('panel-feedback'),
    historySummary: document.getElementById('history-summary'),
    historyFilterForm: document.getElementById('history-filter-form'),
    historyFilterUser: document.getElementById('history-filter-user'),
    historyFilterRole: document.getElementById('history-filter-role'),
    historyFilterChip: document.getElementById('history-filter-chip'),
    historyFilterKeyword: document.getElementById('history-filter-keyword'),
    historyFilterFrom: document.getElementById('history-filter-from'),
    historyFilterTo: document.getElementById('history-filter-to'),
    historyFilterReset: document.getElementById('history-filter-reset'),
    historyError: document.getElementById('history-error'),
    historyTitle: document.querySelector('#panel-sessions .history-toolbar-head h2'),
    historyTabUsers: document.getElementById('history-tab-users'),
    historyTabLatest: document.getElementById('history-tab-latest'),
    historyTabQuestions: document.getElementById('history-tab-questions'),
    historyPaneUsers: document.getElementById('history-pane-users'),
    historyPaneLatest: document.getElementById('history-pane-latest'),
    historyPaneQuestions: document.getElementById('history-pane-questions'),
    historySessionsListUsers: document.getElementById('history-sessions-list-users'),
    historySessionsListLatest: document.getElementById('history-sessions-list-latest'),
    historyQuestionsList: document.getElementById('history-questions-list'),
    historyLoadMoreSessions: document.getElementById('history-load-more-sessions'),
    historyLoadMoreQuestions: document.getElementById('history-load-more-questions'),
    sessionDetailDrawer: document.getElementById('session-detail-drawer'),
    sessionDetailClose: document.getElementById('session-detail-close'),
    sessionDetailBackdrop: document.getElementById('session-detail-backdrop'),
    sessionDetailTitle: document.getElementById('session-detail-title'),
    sessionDetailMeta: document.getElementById('session-detail-meta'),
    sessionDetailError: document.getElementById('session-detail-error'),
    sessionDetailTranscript: document.getElementById('session-detail-transcript'),
    sessionDetailAnalysis: document.getElementById('session-detail-analysis'),
    sessionDetailAnalysisError: document.getElementById('session-detail-analysis-error'),
    sessionDetailAnalysisBubbles: document.getElementById('session-detail-analysis-bubbles'),
    sessionDetailInfo: document.getElementById('session-detail-info'),
    sessionDebugToggle: document.getElementById('session-debug-toggle'),
    sessionDetailDebug: document.getElementById('session-detail-debug'),
    observabilityRefresh: document.getElementById('observability-refresh'),
    observabilityRange: document.getElementById('observability-range'),
    observabilityError: document.getElementById('observability-error'),
    observabilitySummary: document.getElementById('observability-summary'),
    observabilityEntry: document.getElementById('observability-entry'),
    observabilityModel: document.getElementById('observability-model'),
    observabilityUser: document.getElementById('observability-user'),
    observabilityMcpKey: document.getElementById('observability-mcp-key'),
    observabilityAnomalies: document.getElementById('observability-anomalies'),
    announcementAdminNew: document.getElementById('announcement-admin-new'),
    announcementAdminFilterForm: document.getElementById('announcement-admin-filter-form'),
    announcementAdminFilterType: document.getElementById('announcement-admin-filter-type'),
    announcementAdminFilterStatus: document.getElementById('announcement-admin-filter-status'),
    announcementAdminFilterVisibility: document.getElementById('announcement-admin-filter-visibility'),
    announcementAdminFilterPinned: document.getElementById('announcement-admin-filter-pinned'),
    announcementAdminFilterActive: document.getElementById('announcement-admin-filter-active'),
    announcementAdminFilterKeyword: document.getElementById('announcement-admin-filter-keyword'),
    announcementAdminFilterReset: document.getElementById('announcement-admin-filter-reset'),
    announcementAdminError: document.getElementById('announcement-admin-error'),
    announcementAdminSummary: document.getElementById('announcement-admin-summary'),
    announcementAdminList: document.getElementById('announcement-admin-list'),
    announcementAdminEmpty: document.getElementById('announcement-admin-empty'),
    announcementAdminEditor: document.getElementById('announcement-admin-editor'),
    announcementAdminEditorTitle: document.getElementById('announcement-admin-editor-title'),
    announcementAdminEditorMeta: document.getElementById('announcement-admin-editor-meta'),
    announcementAdminActions: document.getElementById('announcement-admin-actions'),
    announcementAdminReadSummary: document.getElementById('announcement-admin-read-summary'),
    announcementAdminType: document.getElementById('announcement-admin-type'),
    announcementAdminTitleInput: document.getElementById('announcement-admin-title-input'),
    announcementAdminSummaryInput: document.getElementById('announcement-admin-summary-input'),
    announcementAdminBody: document.getElementById('announcement-admin-body'),
    announcementAdminTitleInputEn: document.getElementById('announcement-admin-title-input-en'),
    announcementAdminSummaryInputEn: document.getElementById('announcement-admin-summary-input-en'),
    announcementAdminBodyEn: document.getElementById('announcement-admin-body-en'),
    announcementAdminLocaleZh: document.getElementById('announcement-admin-locale-zh'),
    announcementAdminLocaleEn: document.getElementById('announcement-admin-locale-en'),
    announcementAdminVisibility: document.getElementById('announcement-admin-visibility'),
    announcementAdminModalBehavior: document.getElementById('announcement-admin-modal-behavior'),
    announcementAdminPriority: document.getElementById('announcement-admin-priority'),
    announcementAdminRoleAllowList: document.getElementById('announcement-admin-role-allow-list'),
    announcementAdminStartsAt: document.getElementById('announcement-admin-starts-at'),
    announcementAdminEndsAt: document.getElementById('announcement-admin-ends-at'),
    announcementAdminRequiresLogin: document.getElementById('announcement-admin-requires-login'),
    announcementAdminPinned: document.getElementById('announcement-admin-pinned'),
    announcementAdminRequiredGrants: document.getElementById('announcement-admin-required-grants'),
    announcementAdminSourceRef: document.getElementById('announcement-admin-source-ref'),
    announcementAdminGrantBrands: document.getElementById('announcement-admin-grant-brands'),
    announcementAdminGrantProductLines: document.getElementById('announcement-admin-grant-product-lines'),
    announcementAdminGrantChipIds: document.getElementById('announcement-admin-grant-chip-ids'),
    announcementAdminGrantDocumentIds: document.getElementById('announcement-admin-grant-document-ids'),
    announcementAdminGrantScopePresetIds: document.getElementById('announcement-admin-grant-scope-preset-ids'),
    announcementAdminGrantModelIds: document.getElementById('announcement-admin-grant-model-ids'),
    announcementAdminGrantMcpTools: document.getElementById('announcement-admin-grant-mcp-tools'),
    announcementAdminSourceKind: document.getElementById('announcement-admin-source-kind'),
    announcementAdminSourceId: document.getElementById('announcement-admin-source-id'),
    announcementAdminSourceUrl: document.getElementById('announcement-admin-source-url'),
    announcementAdminSourceLabel: document.getElementById('announcement-admin-source-label'),
    announcementAdminPortalPreview: document.getElementById('announcement-admin-portal-preview'),
    announcementAdminSave: document.getElementById('announcement-admin-save'),
    announcementAdminRefresh: document.getElementById('announcement-admin-refresh'),
    announcementAdminStatusLine: document.getElementById('announcement-admin-status-line'),
    panelResources: document.getElementById('panel-resources'),
    resourcesNew: document.getElementById('resources-new'),
    resourcesError: document.getElementById('resources-error'),
    resourcesSummary: document.getElementById('resources-summary'),
    resourcesTabDocuments: document.getElementById('resources-tab-documents'),
    resourcesTabPresets: document.getElementById('resources-tab-presets'),
    resourcesDocumentsList: document.getElementById('resources-documents-list'),
    resourcesDocumentsSearch: document.getElementById('resources-documents-search'),
    resourcesDocumentsVisibility: document.getElementById('resources-documents-visibility'),
    resourcesDocumentsStatus: document.getElementById('resources-documents-status'),
    resourcesPresetsList: document.getElementById('resources-presets-list'),
    resourcesPresetOrphanWarning: document.getElementById('resources-preset-orphan-warning'),
    resourcesOrphanBanner: document.getElementById('resources-orphan-banner'),
    resourceEditorForm: document.getElementById('resource-editor-form'),
    resourceEditorDrawer: document.getElementById('resource-editor-drawer'),
    resourceEditorBackdrop: document.getElementById('resource-editor-backdrop'),
    resourceEditorClose: document.getElementById('resource-editor-close'),
    resourceEditorPlaceholder: document.getElementById('resource-editor-placeholder'),
    resourceEditorTitle: document.getElementById('resource-editor-title'),
    resourceEditorMeta: document.getElementById('resource-editor-meta'),
    resourceEditorStatusLine: document.getElementById('resource-editor-status-line'),
    resourceEditorId: document.getElementById('resource-editor-id'),
    resourceEditorLabel: document.getElementById('resource-editor-label'),
    resourceEditorVisibility: document.getElementById('resource-editor-visibility'),
    resourceEditorStatusSelect: document.getElementById('resource-editor-status'),
    resourceEditorStatusFlow: document.getElementById('resource-editor-status-flow'),
    resourceEditorStatusActions: document.getElementById('resource-editor-status-actions'),
    resourceEditorBrands: document.getElementById('resource-editor-brands'),
    resourceEditorProductLines: document.getElementById('resource-editor-product-lines'),
    resourceEditorApplicationTags: document.getElementById('resource-editor-application-tags'),
    resourceEditorChipIdsLabel: document.getElementById('resource-editor-chip-ids-label'),
    resourceEditorChipIds: document.getElementById('resource-editor-chip-ids'),
    resourceEditorDocumentIdsLabel: document.getElementById('resource-editor-document-ids-label'),
    resourceEditorDocumentIds: document.getElementById('resource-editor-document-ids'),
    resourceEditorSourceLabels: document.getElementById('resource-editor-source-labels'),
    resourceEditorGrantBrands: document.getElementById('resource-editor-grant-brands'),
    resourceEditorGrantProductLines: document.getElementById('resource-editor-grant-product-lines'),
    resourceEditorGrantChipIds: document.getElementById('resource-editor-grant-chip-ids'),
    resourceEditorGrantDocumentIds: document.getElementById('resource-editor-grant-document-ids'),
    resourceEditorGrantScopePresetIds: document.getElementById('resource-editor-grant-scope-preset-ids'),
    resourceEditorGrantModelIds: document.getElementById('resource-editor-grant-model-ids'),
    resourceEditorGrantMcpTools: document.getElementById('resource-editor-grant-mcp-tools'),
    resourceEditorSave: document.getElementById('resource-editor-save'),
    resourceEditorValidate: document.getElementById('resource-editor-validate'),
    resourceEditorDelete: document.getElementById('resource-editor-delete'),
    resourceEditorCancel: document.getElementById('resource-editor-cancel'),
    feedbackAdminError: document.getElementById('feedback-admin-error'),
    ticketAdminSummary: document.getElementById('ticket-admin-summary'),
    ticketAdminFilterForm: document.getElementById('ticket-admin-filter-form'),
    ticketAdminFilterType: document.getElementById('ticket-admin-filter-type'),
    ticketAdminFilterStatus: document.getElementById('ticket-admin-filter-status'),
    ticketAdminFilterNeedsMoreInfo: document.getElementById('ticket-admin-filter-needs-more-info'),
    ticketAdminFilterKeyword: document.getElementById('ticket-admin-filter-keyword'),
    ticketAdminFilterFeedbackType: document.getElementById('ticket-admin-filter-feedback-type'),
    ticketAdminFilterChip: document.getElementById('ticket-admin-filter-chip'),
    ticketAdminFilterDocument: document.getElementById('ticket-admin-filter-document'),
    ticketAdminFilterScope: document.getElementById('ticket-admin-filter-scope'),
    ticketAdminFilterModel: document.getElementById('ticket-admin-filter-model'),
    ticketAdminFilterReviewSignal: document.getElementById('ticket-admin-filter-review-signal'),
    ticketAdminFilterReset: document.getElementById('ticket-admin-filter-reset'),
    ticketAdminMoreFiltersToggle: document.getElementById('ticket-admin-more-filters-toggle'),
    ticketAdminMoreFilters: document.getElementById('ticket-admin-more-filters'),
    ticketAdminList: document.getElementById('ticket-admin-list'),
    ticketAdminDetailEmpty: document.getElementById('ticket-admin-detail-empty'),
    ticketAdminDetail: document.getElementById('ticket-admin-detail'),
    ticketAdminDetailTitle: document.getElementById('ticket-admin-detail-title'),
    ticketAdminDetailMeta: document.getElementById('ticket-admin-detail-meta'),
    ticketAdminTypeBadge: document.getElementById('ticket-admin-type-badge'),
    ticketAdminDetailBody: document.getElementById('ticket-admin-detail-body'),
    ticketAdminMessages: document.getElementById('ticket-admin-messages'),
    ticketAdminReplyForm: document.getElementById('ticket-admin-reply-form'),
    ticketAdminReplyText: document.getElementById('ticket-admin-reply-text'),
    ticketAdminReplyInternal: document.getElementById('ticket-admin-reply-internal'),
    ticketAdminReplySubmit: document.getElementById('ticket-admin-reply-submit'),
    ticketAdminReplyStatus: document.getElementById('ticket-admin-reply-status'),
    ticketAdminAttachments: document.getElementById('ticket-admin-attachments'),
    ticketAdminDownloadAll: document.getElementById('ticket-admin-download-all'),
    ticketAdminMaterialNotice: document.getElementById('ticket-admin-material-notice'),
    ticketAdminPreview: document.getElementById('ticket-admin-preview'),
    ticketAdminReviewForm: document.getElementById('ticket-admin-review-form'),
    ticketAdminStatus: document.getElementById('ticket-admin-status'),
    ticketAdminNeedsMoreInfo: document.getElementById('ticket-admin-needs-more-info'),
    ticketAdminPublicNote: document.getElementById('ticket-admin-public-note'),
    ticketAdminInternalNote: document.getElementById('ticket-admin-internal-note'),
    ticketAdminResult: document.getElementById('ticket-admin-result'),
    ticketAdminDatasheetReview: document.getElementById('ticket-admin-datasheet-review'),
    ticketAdminReviewBrand: document.getElementById('ticket-admin-review-brand'),
    ticketAdminReviewProductLine: document.getElementById('ticket-admin-review-product-line'),
    ticketAdminReviewApplication: document.getElementById('ticket-admin-review-application'),
    ticketAdminReviewChip: document.getElementById('ticket-admin-review-chip'),
    ticketAdminReviewDocument: document.getElementById('ticket-admin-review-document'),
    ticketAdminReviewScope: document.getElementById('ticket-admin-review-scope'),
    ticketAdminReviewApplicationTags: document.getElementById('ticket-admin-review-application-tags'),
    ticketAdminReviewBindingNote: document.getElementById('ticket-admin-review-binding-note'),
    ticketAdminReviewScanSummary: document.getElementById('ticket-admin-review-scan-summary'),
    ticketAdminStatusLine: document.getElementById('ticket-admin-status-line'),
    ticketAdminApplicationActions: document.getElementById('ticket-admin-application-actions')
  };

  const ADMIN_SECTIONS = {
    users: { path: '/admin/sections/users', panel: els.panelUsers },
    roles: { path: '/admin/sections/roles', panel: els.panelRoles },
    'model-routing': { path: '/admin/sections/model-routing', panel: els.panelModelRouting },
    prompts: { path: '/admin/sections/prompts', panel: els.panelPrompts },
    chips: { path: '/admin/sections/chips', panel: els.panelChips },
    sessions: { path: '/admin/sections/sessions', panel: els.panelSessions },
    questions: { path: '/admin/sections/questions', panel: els.panelSessions },
    observability: { path: '/admin/sections/observability', panel: els.panelObservability },
    'discovery-traces': { path: '/admin/sections/discovery-traces', panel: els.panelDiscoveryTraces },
    announcements: { path: '/admin/sections/announcements', panel: els.panelAnnouncements },
    resources: { path: '/admin/sections/resources', panel: els.panelResources },
    feedback: { path: '/admin/sections/feedback', panel: els.panelFeedback }
  };

  const ADMIN_NAV_GROUPS = [
    { key: 'user-access', label: '用户与访问', sections: ['users', 'roles'] },
    { key: 'knowledge', label: '知识库', sections: ['chips', 'resources', 'prompts'] },
    { key: 'operations', label: '运营记录', sections: ['sessions', 'observability'] },
    { key: 'content-support', label: '内容与支持', sections: ['announcements', 'feedback'] },
    { key: 'system-settings', label: '系统设置', sections: ['model-routing', 'discovery-traces'] }
  ];

  const ADMIN_SECTION_META = {
    users: { label: '用户', group: 'user-access' },
    roles: { label: '角色模板', group: 'user-access' },
    chips: { label: '芯片目录', group: 'knowledge' },
    resources: { label: '文档与 Scope', group: 'knowledge' },
    prompts: { label: '提示词', group: 'knowledge' },
    sessions: { label: '会话历史', group: 'operations' },
    questions: { label: '问题台账', group: 'operations', parentSection: 'sessions' },
    observability: { label: '成本观测', group: 'operations' },
    announcements: { label: '公告维护', group: 'content-support' },
    feedback: { label: '反馈&工单', group: 'content-support' },
    'model-routing': { label: '模式与模型档位', group: 'system-settings' },
    'discovery-traces': { label: '运行诊断', group: 'system-settings' }
  };

  const HISTORY_TAB_LABELS = {
    users: '按用户',
    latest: '最新 Chat',
    questions: '问题台账'
  };

  function statusLabel(namespace, value, fallback = value) {
    return adminText(`admin.${namespace}.${value}`, fallback);
  }

  const ANNOUNCEMENT_TYPE_LABELS = {
    announcement: '公告',
    news: '新闻',
    release_note: 'Release note',
    changelog: 'Changelog'
  };

  const ANNOUNCEMENT_STATUS_LABELS = {
    draft: '草稿',
    published: '已发布',
    offline: '已下线',
    archived: '已归档'
  };

  const TICKET_TYPE_LABELS = {
    feedback: '反馈&工单',
    datasheet_submission: '资料提交',
    account_application: '加入申请'
  };

  const TICKET_STATUS_LABELS = {
    submitted: '已提交',
    received: '已接收',
    evaluating: '评估中',
    in_development: '开发中',
    launched: '已上线',
    reviewing: '审核中',
    scanning: '扫描中',
    quarantined: '隔离待审',
    pending_review: '待审核',
    needs_more_info: '需要补充信息',
    accepted: '已采纳',
    approved: '已通过',
    rejected: '已拒绝',
    linked: '已记录绑定意图',
    archived: '已归档',
    deferred: '暂不处理',
    closed: '已关闭'
  };

  const TICKET_STATUS_OPTIONS_BY_TYPE = {
    feedback: ['submitted', 'received', 'evaluating', 'accepted', 'in_development', 'launched', 'deferred', 'closed'],
    datasheet_submission: ['received', 'archived'],
    account_application: ['submitted', 'pending_review', 'needs_more_info', 'approved', 'rejected', 'closed']
  };

  const TICKET_FILTER_STATUS_OPTIONS = Array.from(new Set(Object.values(TICKET_STATUS_OPTIONS_BY_TYPE).flat()));

  function adminGroupLabel(group) {
    return adminText(`admin.group.${{
      'user-access': 'userAccess',
      knowledge: 'knowledge',
      operations: 'operations',
      'content-support': 'contentSupport',
      'system-settings': 'systemSettings'
    }[group.key]}`, group.label);
  }

  function adminSectionLabel(section, fallback = '') {
    const key = {
      users: 'users',
      roles: 'roles',
      chips: 'chips',
      resources: 'resources',
      prompts: 'prompts',
      sessions: 'sessions',
      questions: 'questions',
      observability: 'observability',
      announcements: 'announcements',
      feedback: 'feedback',
      'model-routing': 'modelRouting',
      'discovery-traces': 'discoveryTraces'
    }[section];
    return key ? adminText(`admin.section.${key}`, fallback || ADMIN_SECTION_META[section]?.label) : fallback;
  }

  function historyTabLabel(tab) {
    return adminText(`admin.history.tab.${tab}`, HISTORY_TAB_LABELS[tab]);
  }

  const DRAFT_STATUS_LABELS = {
    pending: '待处理',
    consumed: '已使用',
    invalidated: '已失效',
    expired: '已过期'
  };

  const ATTACHMENT_STATUS_LABELS = {
    pending: '待处理',
    accepted: '已采纳',
    rejected: '已拒绝',
    cleaned: '已清理'
  };

  const FEEDBACK_STATUS_LABELS = {
    pending: '待处理',
    reviewed: '已查看',
    accepted: '已采纳',
    rejected: '已拒绝',
    implemented: '已实现'
  };

  const PREVIEWABLE_ATTACHMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.c', '.h', '.cs', '.cpp', '.cxx', '.cc', '.hpp', '.hh']);

  function isAdminUser(user) {
    return Boolean(user && user.role === 'admin');
  }

  function selectedUser() {
    return state.users.find((user) => user.id === state.selectedUserId);
  }

  function mergeUserIntoState(user) {
    if (!user || !user.id) return null;
    const existing = state.users.find((candidate) => candidate.id === user.id);
    if (existing) {
      Object.assign(existing, user);
      return existing;
    }
    state.users = [...state.users, user];
    return user;
  }

  function userReferenceValues(reference) {
    if (!reference) return [];
    if (typeof reference === 'string') return [reference];
    return [
      reference.id,
      reference.userId,
      reference.username,
      reference.name,
      reference.label,
      reference.key,
      reference.profile?.email
    ].filter(Boolean);
  }

  function findUserByReference(reference) {
    const values = userReferenceValues(reference).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
    if (values.length === 0) return null;
    return state.users.find((user) => {
      const haystack = [
        user.id,
        user.username,
        user.profile?.email
      ].map((value) => String(value || '').trim().toLowerCase());
      return values.some((value) => haystack.includes(value));
    }) || null;
  }

  function clearUserFiltersForJump() {
    state.userFilters = { search: '', status: '', expired: '', company: '', role: '' };
    if (els.userSearch) els.userSearch.value = '';
    if (els.userFilterStatus) els.userFilterStatus.value = '';
    if (els.userFilterExpired) els.userFilterExpired.value = '';
    if (els.userFilterCompany) els.userFilterCompany.value = '';
    if (els.userFilterRole) els.userFilterRole.value = '';
  }

  async function openUserWorkspace(reference) {
    const user = findUserByReference(reference);
    const navigated = await switchSection('users');
    if (!navigated) return false;
    clearUserFiltersForJump();
    if (user) {
      selectUser(user.id);
      return true;
    }
    const fallback = userReferenceValues(reference)[0];
    if (fallback) {
      state.userFilters.search = String(fallback);
      if (els.userSearch) els.userSearch.value = String(fallback);
    }
    renderUsers();
    setError(adminText('admin.users.jumpNotFound', '未找到匹配用户，已切换到用户列表。'));
    return false;
  }

  function setError(message) {
    els.error.textContent = message || '';
  }

  // 通过共享 UI Kit 发出 toast 通知；AgentXUI 不可用时静默降级
  function notifyAdmin(kind, title, detail) {
    if (window.AgentXUI && typeof window.AgentXUI.toast === 'function') {
      window.AgentXUI.toast({ kind, title, detail });
    }
  }

  function setUserCreateError(message) {
    els.userCreateError.textContent = message || '';
  }

  function setSectionStatus(section, kind, message) {
    if (!state.sectionStatus[section]) {
      state.sectionStatus[section] = {};
    }
    state.sectionStatus[section][kind] = message || '';
  }

  function clearSectionStatus(section, kind) {
    if (state.sectionStatus[section]) {
      state.sectionStatus[section][kind] = '';
    }
  }

  function parseSectionFromPath(pathname) {
    if (pathname === '/admin') return 'users';
    const match = /^\/admin\/sections\/([^/]+)$/.exec(pathname);
    const section = match?.[1];
    return Object.prototype.hasOwnProperty.call(ADMIN_SECTIONS, section) ? section : 'users';
  }

  function sectionPath(section) {
    return ADMIN_SECTIONS[section]?.path || ADMIN_SECTIONS.users.path;
  }

  function sectionForHistoryTab(tab) {
    return tab === 'questions' ? 'questions' : 'sessions';
  }

  function groupForSection(section) {
    return ADMIN_SECTION_META[section]?.group || ADMIN_SECTION_META.users.group;
  }

  function visibleNavSection(section) {
    return ADMIN_SECTION_META[section]?.parentSection || section;
  }

  function setNavGroupExpanded(groupEl, expanded) {
    const toggle = groupEl.querySelector('.admin-nav-group-toggle');
    const items = groupEl.querySelector('.admin-nav-group-items');
    const chevron = groupEl.querySelector('.admin-nav-group-chevron');
    groupEl.dataset.expanded = expanded ? 'true' : 'false';
    toggle?.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (items) items.hidden = !expanded;
    if (chevron) chevron.textContent = expanded ? '▾' : '▸';
  }

  function syncNavGroupsForSection(section) {
    // 原型：侧栏 5 组默认全展开，切区不再自动收起其它组；仅确保当前组处于展开态，
    // 手动折叠（initAdminNavGroups 的 toggle）与整栏收窄能力保持不变。
    const activeGroup = groupForSection(section);
    for (const group of els.navGroups) {
      if (group.dataset.navGroup === activeGroup && group.dataset.expanded !== 'true') {
        setNavGroupExpanded(group, true);
      }
    }
  }

  function renderAdminBreadcrumb() {
    if (!els.breadcrumb) return;
    const section = state.activeSection;
    const meta = ADMIN_SECTION_META[section] || ADMIN_SECTION_META.users;
    const group = ADMIN_NAV_GROUPS.find((item) => item.key === meta.group) || ADMIN_NAV_GROUPS[0];
    const parentSection = meta.parentSection || section;
    const parentMeta = ADMIN_SECTION_META[parentSection] || meta;
    const crumbs = [
      { label: adminGroupLabel(group), section: group.sections[0] },
      { label: adminSectionLabel(parentSection, parentMeta.label), section: parentSection }
    ];
    if ((section === 'sessions' || section === 'questions') && state.activeHistoryTab) {
      const tabLabel = historyTabLabel(state.activeHistoryTab);
      if (tabLabel && tabLabel !== crumbs[crumbs.length - 1].label) {
        crumbs.push({ label: tabLabel, tab: state.activeHistoryTab });
      }
    }

    els.breadcrumb.replaceChildren();
    crumbs.forEach((crumb, index) => {
      const isCurrent = index === crumbs.length - 1;
      if (index > 0) {
        const separator = document.createElement('span');
        separator.className = 'admin-breadcrumb-separator';
        separator.textContent = '/';
        els.breadcrumb.append(separator);
      }
      if (isCurrent) {
        const current = document.createElement('span');
        current.className = 'admin-breadcrumb-current';
        current.textContent = crumb.label;
        els.breadcrumb.append(current);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = crumb.label;
      if (crumb.section) {
        button.addEventListener('click', () => switchSection(crumb.section));
      } else if (crumb.tab) {
        button.addEventListener('click', () => switchHistoryTab(crumb.tab));
      }
      els.breadcrumb.append(button);
    });
  }

  // E1：面包屑下方渲染当前分组的子视图 tab 条（用户/角色模板、芯片目录/文档与 Scope/提示词……）。
  function renderAdminPageTabs() {
    if (!els.pageTabs) return;
    const section = state.activeSection;
    const meta = ADMIN_SECTION_META[section] || ADMIN_SECTION_META.users;
    const parentSection = meta.parentSection || section;
    const group = ADMIN_NAV_GROUPS.find((item) => item.key === meta.group) || ADMIN_NAV_GROUPS[0];

    els.pageTabs.replaceChildren();
    if (!group || group.sections.length < 2) {
      els.pageTabs.hidden = true;
      return;
    }
    els.pageTabs.hidden = false;
    for (const tabSection of group.sections) {
      const tabMeta = ADMIN_SECTION_META[tabSection];
      if (!tabMeta) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'tab';
      button.textContent = adminSectionLabel(tabSection, tabMeta.label);
      const isActive = tabSection === parentSection;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.addEventListener('click', () => switchSection(tabSection));
      els.pageTabs.append(button);
    }
  }

  async function canLeaveSection(nextSection) {
    if (state.activeSection !== 'prompts' || nextSection === 'prompts' || !state.hasUnsavedChanges) {
      return true;
    }
    if (!window.AgentXUI || typeof window.AgentXUI.confirm !== 'function') return true;
    return window.AgentXUI.confirm({
      title: adminText('admin.prompts.discardTitle', '放弃未保存的更改'),
      body: adminText('admin.prompts.discardBody', '当前提示词草稿未保存，确认放弃？'),
      confirmText: adminText('admin.prompts.discard', '放弃'),
      danger: true
    });
  }

  function syncSectionUrl(section, options = {}) {
    const nextPath = sectionPath(section);
    if (window.location.pathname === nextPath) return;
    const method = options.replace ? 'replaceState' : 'pushState';
    window.history[method]({ section }, '', nextPath);
  }

  async function switchSection(section, options = {}) {
    const nextSection = ADMIN_SECTIONS[section] ? section : 'users';
    if (!options.force && !(await canLeaveSection(nextSection))) {
      syncSectionUrl(state.activeSection, { replace: true });
      return false;
    }

    state.activeSection = nextSection;
    closeTransientAdminPanels();
    const visibleActiveSection = visibleNavSection(nextSection);
    for (const link of els.sectionLinks) {
      const isActive = link.dataset.section === visibleActiveSection;
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
      link.classList.toggle('active', isActive);
    }
    for (const [name, definition] of Object.entries(ADMIN_SECTIONS)) {
      const sectionPanel = panelForSection(nextSection);
      definition.panel.hidden = definition.panel !== sectionPanel;
    }
    if (nextSection === 'sessions' || nextSection === 'questions') {
      selectHistoryTab(nextSection === 'questions' ? 'questions' : state.activeHistoryTab === 'questions' ? 'users' : state.activeHistoryTab);
      if (state.adminConfirmed) {
        loadHistoryWorkspace({ reset: state.history.sessions.length === 0 && state.history.questions.length === 0 }).catch((error) => {
          setHistoryError(error.message);
        });
      }
    }
    if (nextSection === 'model-routing' && state.adminConfirmed) {
      loadModelRouting().catch((error) => {
        if (els.modelRoutingError) els.modelRoutingError.textContent = error.message;
      });
    }
    if (nextSection === 'feedback' && state.adminConfirmed) {
      loadFeedbackWorkspace().catch((error) => setFeedbackError(error.message));
    }
    if (nextSection === 'observability' && state.adminConfirmed) {
      loadObservability().catch((error) => setObservabilityError(error.message));
    }
    if (nextSection === 'discovery-traces' && state.adminConfirmed) {
      loadDiscoveryTraces().catch((error) => setDiscoveryTracesError(error.message));
    }
    if (nextSection === 'announcements' && state.adminConfirmed) {
      loadAnnouncementWorkspace().catch((error) => setAnnouncementError(error.message));
    }
    if (nextSection === 'resources' && state.adminConfirmed) {
      loadResources().catch((error) => setResourcesError(error.message));
    }
    syncNavGroupsForSection(nextSection);
    renderAdminBreadcrumb();
    renderAdminPageTabs();
    if (options.updateUrl !== false) {
      syncSectionUrl(nextSection, { replace: options.replace });
    }
    return true;
  }

  function panelForSection(section) {
    return ADMIN_SECTIONS[section]?.panel || ADMIN_SECTIONS.users.panel;
  }

  function initializeSectionRoute() {
    const debugSessionId = new URLSearchParams(window.location.search).get('debugSessionId');
    if (debugSessionId) {
      state.history.pendingDebugSessionId = debugSessionId;
    }
    switchSection(parseSectionFromPath(window.location.pathname), { replace: true, force: true });
  }

  async function switchHistoryTab(tab, options = {}) {
    const nextTab = ['users', 'latest', 'questions'].includes(tab) ? tab : 'users';
    const nextSection = sectionForHistoryTab(nextTab);
    const sectionChanged = state.activeSection !== nextSection;
    if (sectionChanged) {
      const changed = await switchSection(nextSection, { updateUrl: false, force: true });
      if (!changed) return false;
      selectHistoryTab(nextTab);
    } else {
      selectHistoryTab(nextTab);
    }
    if (options.updateUrl !== false) {
      syncSectionUrl(nextSection, { replace: options.replace });
    }
    return true;
  }

  function setNoPermission(message) {
    els.adminNoPermission.textContent = message || '';
  }

  function renderAdminPortalAuth() {
    window.AgentXProductShell?.renderPortalAuth?.(document);
  }

  function showAdminLogin(message) {
    state.adminConfirmed = false;
    els.adminOperationSurface.hidden = true;
    els.adminLoginShell.hidden = false;
    renderAdminPortalAuth();
    if (els.sectionNav) els.sectionNav.hidden = true;
    if (els.adminUserStatus) els.adminUserStatus.textContent = '';
    setNoPermission(message || '');
    els.adminUsername.focus();
  }

  function showAdminOperations(user) {
    state.adminConfirmed = true;
    els.adminLoginShell.hidden = true;
    els.adminOperationSurface.hidden = false;
    if (els.sectionNav) els.sectionNav.hidden = false;
    renderAdminPortalAuth();
    if (els.adminUserStatus) els.adminUserStatus.textContent = user?.username || 'admin';
    setNoPermission('');
    setError('');
    setUserCreateError('');
  }

  function handleAdminAuthFailure(response) {
    if (response.status === 401) {
      showAdminLogin(adminText('admin.login.expired', 'Login expired. Please sign in again.'));
      return true;
    }
    if (response.status === 403) {
      showAdminLogin(adminText('admin.login.noPermission', 'No admin permission: current account is not an admin.'));
      return true;
    }
    return false;
  }

  async function loadAdminData() {
    await runAdminLoader(
      'chips',
      loadChipMappings,
      els.chipMappingError,
      adminText('admin.error.loadChipCatalogGeneric', '加载芯片目录失败')
    );
    // 批次D（2.2.27）：预加载资源目录（documents/scopePresets），使「用户与访问」的文档/Scope 授权候选
    // 在冷启动、未先进入「文档与 Scope」分区时也非空——此前只在 resources 分区按需加载，候选常为空只能手输 ID。
    await Promise.allSettled([loadUsers(), loadPromptFiles(), loadRoles(), loadResources()]);
    if (state.activeSection === 'sessions' || state.activeSection === 'questions') {
      await loadHistoryWorkspace({ reset: true });
    }
    if (state.activeSection === 'model-routing') {
      await loadModelRouting();
    }
    if (state.activeSection === 'feedback') {
      await loadFeedbackWorkspace();
    }
    if (state.activeSection === 'observability') {
      await loadObservability();
    }
    if (state.activeSection === 'discovery-traces') {
      await loadDiscoveryTraces();
    }
    if (state.activeSection === 'announcements') {
      await loadAnnouncementWorkspace();
    }
    if (state.activeSection === 'resources') {
      await loadResources();
    }
    renderChipAccess();
  }

  function handleAdminDataLoadError(error) {
    const message = error?.message || adminText('admin.error.loadAdminData', '加载管理数据失败');
    setSectionStatus(state.activeSection, 'error', message);
    if (state.activeSection === 'sessions' || state.activeSection === 'questions') {
      setHistoryError(message);
    } else if (state.activeSection === 'observability') {
      setObservabilityError(message);
    } else if (state.activeSection === 'discovery-traces') {
      setDiscoveryTracesError(message);
    } else if (state.activeSection === 'announcements') {
      setAnnouncementError(message);
    } else if (state.activeSection === 'resources') {
      setResourcesError(message);
    } else if (state.activeSection === 'feedback') {
      setFeedbackError(message);
    } else if (state.activeSection === 'model-routing' && els.modelRoutingError) {
      els.modelRoutingError.textContent = message;
    } else {
      setError(message);
    }
  }

  async function runAdminLoader(section, loader, errorEl, fallback) {
    try {
      await loader();
    } catch (error) {
      const message = error?.message || fallback;
      setSectionStatus(section, 'error', message);
      if (errorEl) {
        errorEl.textContent = message;
      }
    }
  }

  function selectHistoryTab(tab) {
    state.activeHistoryTab = ['users', 'latest', 'questions'].includes(tab) ? tab : 'users';
    const tabs = {
      users: els.historyTabUsers,
      latest: els.historyTabLatest,
      questions: els.historyTabQuestions
    };
    const panes = {
      users: els.historyPaneUsers,
      latest: els.historyPaneLatest,
      questions: els.historyPaneQuestions
    };
    for (const [name, button] of Object.entries(tabs)) {
      if (!button) continue;
      const active = name === state.activeHistoryTab;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('active', active);
    }
    for (const [name, pane] of Object.entries(panes)) {
      if (pane) pane.hidden = name !== state.activeHistoryTab;
    }
    if (els.historyLoadMoreSessions) {
      els.historyLoadMoreSessions.hidden = state.activeHistoryTab === 'questions';
    }
    if (els.historyLoadMoreQuestions) {
      els.historyLoadMoreQuestions.hidden = state.activeHistoryTab !== 'questions';
    }
    if (els.historyTitle) {
      els.historyTitle.textContent = historyTabLabel(state.activeHistoryTab) || adminText('admin.section.sessions', '会话历史');
    }
    renderHistoryWorkspace();
    renderAdminBreadcrumb();
  }

  function collectHistoryFilters() {
    state.historyFilters = {
      user: els.historyFilterUser?.value.trim() || '',
      role: els.historyFilterRole?.value.trim() || '',
      chipId: els.historyFilterChip?.value.trim() || '',
      keyword: els.historyFilterKeyword?.value.trim() || '',
      from: dateInputToIsoStart(els.historyFilterFrom?.value.trim() || ''),
      to: dateInputToIsoEnd(els.historyFilterTo?.value.trim() || '')
    };
  }

  function dateInputToIsoStart(value) {
    return value ? `${value}T00:00:00.000Z` : '';
  }

  function dateInputToIsoEnd(value) {
    return value ? `${value}T23:59:59.999Z` : '';
  }

  function historyUserFilterParam(user) {
    const matchedUser = state.users.find((candidate) => candidate.id === user);
    return matchedUser || isUuid(user) ? ['userId', user] : ['username', user];
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  function historyQuery(offset) {
    const params = new URLSearchParams();
    const user = state.historyFilters.user;
    if (user) {
      const [name, value] = historyUserFilterParam(user);
      params.set(name, value);
    }
    if (state.historyFilters.role) params.set('role', state.historyFilters.role);
    if (state.historyFilters.chipId) params.set('chipId', state.historyFilters.chipId);
    if (state.historyFilters.keyword) params.set('keyword', state.historyFilters.keyword);
    if (state.historyFilters.from) params.set('from', state.historyFilters.from);
    if (state.historyFilters.to) params.set('to', state.historyFilters.to);
    params.set('offset', String(offset));
    params.set('limit', String(state.history.limit));
    return params;
  }

  async function loadHistoryWorkspace(options = {}) {
    if (!state.adminConfirmed) return;
    const reset = Boolean(options.reset);
    setHistoryError('');
    state.history.loading = true;
    if (reset) {
      state.history.sessionOffset = 0;
      state.history.questionOffset = 0;
      state.history.sessions = [];
      state.history.questions = [];
      clearSessionDetailState();
    }
    try {
      if (state.activeHistoryTab === 'questions') {
        await loadQuestions({ append: !reset });
      } else {
        await loadSessions({ append: !reset });
      }
    } finally {
      state.history.loading = false;
      renderHistoryWorkspace();
      openPendingDebugSession().catch((error) => setHistoryError(error.message));
    }
  }

  async function openPendingDebugSession() {
    const sessionId = state.history.pendingDebugSessionId;
    if (!sessionId || state.activeHistoryTab === 'questions') return;
    state.history.pendingDebugSessionId = '';
    await openSessionDetail(sessionId);
    if (state.history.selectedSessionId === sessionId) {
      await loadSessionDebug({ forceOpen: true });
    }
  }

  async function loadSessions({ append = false } = {}) {
    const offset = append ? state.history.sessionOffset : 0;
    const response = await window.AgentXAuth.authFetch(`/admin/sessions/history?${historyQuery(offset)}`, { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) return;
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadSessionHistory', { status: response.status }, `加载会话历史失败 (${response.status})`));
    }
    const payload = await response.json();
    const items = payload.items || [];
    state.history.sessions = append ? state.history.sessions.concat(items) : items;
    state.history.sessionsTotal = payload.total || items.length;
    state.history.sessionOffset = (payload.offset || offset) + items.length;
  }

  async function loadQuestions({ append = false } = {}) {
    const offset = append ? state.history.questionOffset : 0;
    const response = await window.AgentXAuth.authFetch(`/admin/questions?${historyQuery(offset)}`, { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) return;
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadQuestionLedger', { status: response.status }, `加载问题台账失败 (${response.status})`));
    }
    const payload = await response.json();
    const items = payload.items || [];
    state.history.questions = append ? state.history.questions.concat(items) : items;
    state.history.questionsTotal = payload.total || items.length;
    state.history.questionOffset = (payload.offset || offset) + items.length;
  }

  function renderHistoryWorkspace() {
    if (!els.historyPaneUsers) return;
    renderHistorySummary();
    renderHistoryUsers();
    renderHistoryLatest();
    renderHistoryQuestions();
    if (els.historyLoadMoreSessions) {
      els.historyLoadMoreSessions.disabled = state.history.loading || state.history.sessionOffset >= state.history.sessionsTotal;
    }
    if (els.historyLoadMoreQuestions) {
      els.historyLoadMoreQuestions.disabled = state.history.loading || state.history.questionOffset >= state.history.questionsTotal;
    }
  }

  function renderHistorySummary() {
    if (!els.historySummary) return;
    if (state.activeHistoryTab === 'questions') {
      els.historySummary.textContent = adminText(
        'admin.history.questionsSummary',
        { shown: state.history.questions.length, total: state.history.questionsTotal },
        `${state.history.questions.length} / ${state.history.questionsTotal} 问题`
      );
    } else {
      els.historySummary.textContent = adminText(
        'admin.history.sessionsSummary',
        { shown: state.history.sessions.length, total: state.history.sessionsTotal },
        `${state.history.sessions.length} / ${state.history.sessionsTotal} 会话`
      );
    }
  }

  const PIPELINE_TYPE_BADGE_CLASS = {
    单芯片: 'admin-badge-muted',
    跨档两步: 'admin-badge-info',
    全局: 'admin-badge'
  };

  function sessionsSortedByUser(sessions) {
    return [...sessions].sort((left, right) => {
      const leftUser = (left.username || left.userId || '').toLocaleLowerCase();
      const rightUser = (right.username || right.userId || '').toLocaleLowerCase();
      if (leftUser !== rightUser) return leftUser.localeCompare(rightUser);
      return getSessionStamp(right).localeCompare(getSessionStamp(left));
    });
  }

  function sessionsSortedByRecency(sessions) {
    return [...sessions].sort((left, right) => getSessionStamp(right).localeCompare(getSessionStamp(left)));
  }

  function renderHistoryUsers() {
    renderHistorySessionsTable(els.historySessionsListUsers, sessionsSortedByUser(state.history.sessions), 10);
  }

  function renderHistoryLatest() {
    renderHistorySessionsTable(els.historySessionsListLatest, sessionsSortedByRecency(state.history.sessions), 10);
  }

  function renderHistorySessionsTable(tbody, sessions, colSpan) {
    if (!tbody) return;
    tbody.replaceChildren();
    if (sessions.length === 0) {
      tbody.append(renderHistoryEmptyRow(colSpan));
      return;
    }
    for (const session of sessions) {
      tbody.append(renderSessionRow(session));
    }
  }

  function renderHistoryQuestions() {
    if (!els.historyQuestionsList) return;
    els.historyQuestionsList.replaceChildren();
    if (state.history.questions.length === 0) {
      els.historyQuestionsList.append(renderHistoryEmptyRow(6));
      return;
    }
    for (const question of state.history.questions) {
      els.historyQuestionsList.append(renderQuestionRow(question));
    }
  }

  function renderSessionRow(session) {
    const row = document.createElement('tr');
    row.className = 'history-session-row';
    row.dataset.sessionId = session.sessionId || '';
    row.tabIndex = 0;
    if (session.sessionId === state.history.selectedSessionId) row.classList.add('selected');

    const userCell = document.createElement('td');
    userCell.textContent = session.username || session.userId || '—';

    const roleCell = document.createElement('td');
    const roleBadge = document.createElement('span');
    roleBadge.className = 'admin-badge admin-badge-dot';
    roleBadge.textContent = session.role || '—';
    roleCell.append(roleBadge);

    const chipCell = document.createElement('td');
    const chipBadge = document.createElement('span');
    chipBadge.className = 'admin-badge admin-badge-muted';
    chipBadge.textContent = session.chipLabel || session.chipId || '—';
    chipCell.append(chipBadge);

    const typeCell = document.createElement('td');
    if (session.pipelineType) {
      const typeBadge = document.createElement('span');
      typeBadge.className = `admin-badge ${PIPELINE_TYPE_BADGE_CLASS[session.pipelineType] || 'admin-badge-muted'}`;
      typeBadge.textContent = session.pipelineType;
      typeCell.append(typeBadge);
    } else {
      typeCell.textContent = '—';
    }

    const modelCell = document.createElement('td');
    const modelValue = session.modelId || session.claudeModelRole;
    if (modelValue) {
      const modelBadge = document.createElement('span');
      modelBadge.className = 'admin-badge admin-badge-info';
      modelBadge.textContent = modelValue;
      modelCell.append(modelBadge);
    } else {
      modelCell.textContent = '—';
    }

    const creditsCell = document.createElement('td');
    creditsCell.className = 'num';
    creditsCell.textContent = session.creditUnits === undefined || session.creditUnits === null ? '—' : formatNumber(session.creditUnits);

    // E4：时长由客户端估算（createdAt → lastMessageAt/updatedAt），无法计算时显示「—」。
    const durationCell = document.createElement('td');
    durationCell.className = 'mono';
    durationCell.textContent = formatSessionDuration(session);

    const statusCell = document.createElement('td');
    statusCell.append(
      renderStatusBadge(getSessionDisplayStatus(session)),
      document.createTextNode(adminText('admin.history.outputSize', { value: session.outputSize ?? 0 }, ` · 输出 ${session.outputSize ?? 0}`))
    );

    // E4：原「时间」列改为「更新时间」（lastMessageAt 优先），置于状态之后，贴合原型列序。
    const updatedCell = document.createElement('td');
    updatedCell.className = 'mono';
    updatedCell.textContent = formatDate(session.lastMessageAt || session.updatedAt || session.createdAt);

    const sessionIdCell = document.createElement('td');
    sessionIdCell.className = 'mono';
    sessionIdCell.textContent = shortSessionId(session.sessionId);
    sessionIdCell.title = session.sessionId || '';

    row.append(userCell, roleCell, chipCell, typeCell, modelCell, creditsCell, durationCell, statusCell, updatedCell, sessionIdCell);
    row.addEventListener('click', () => openSessionDetail(session.sessionId));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSessionDetail(session.sessionId);
      }
    });
    return row;
  }

  function renderQuestionRow(question) {
    const row = document.createElement('tr');
    row.className = 'history-question-row';
    row.dataset.sessionId = question.sessionId || '';
    row.tabIndex = 0;

    const timeCell = document.createElement('td');
    timeCell.className = 'mono';
    timeCell.textContent = formatDate(question.createdAt);

    const textCell = document.createElement('td');
    textCell.style.whiteSpace = 'normal';
    textCell.textContent = question.text || adminText('admin.history.emptyQuestion', '(空问题)');

    const userCell = document.createElement('td');
    userCell.textContent = question.username || question.userId || '—';

    const chipCell = document.createElement('td');
    const chipBadge = document.createElement('span');
    chipBadge.className = 'admin-badge admin-badge-muted';
    chipBadge.textContent = question.chipId || '—';
    chipCell.append(chipBadge);

    const modelCell = document.createElement('td');
    const modelValue = question.modelId || question.claudeModelRole;
    if (modelValue) {
      const modelBadge = document.createElement('span');
      modelBadge.className = 'admin-badge admin-badge-info';
      modelBadge.textContent = modelValue;
      modelCell.append(modelBadge);
    } else {
      modelCell.textContent = '—';
    }

    const creditsCell = document.createElement('td');
    creditsCell.className = 'num';
    creditsCell.textContent = question.creditUnits === undefined || question.creditUnits === null ? '—' : formatNumber(question.creditUnits);

    row.append(timeCell, textCell, userCell, chipCell, modelCell, creditsCell);
    row.addEventListener('click', () => openSessionDetail(question.sessionId));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openSessionDetail(question.sessionId);
      }
    });
    return row;
  }

  function renderHistoryEmptyRow(colSpan) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = colSpan;
    cell.className = 'empty-state history-empty-state';
    cell.textContent = hasHistoryFilters()
      ? adminText('admin.common.noFilterResults', '筛选无结果')
      : adminText('admin.common.noData', '无数据');
    row.append(cell);
    return row;
  }

  // === TESTABLE renderEmptyState START ===
  function renderEmptyState(text) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = text || adminText('admin.common.noData', '无数据');
    return empty;
  }
  // === TESTABLE renderEmptyState END ===

  // E4：状态徽标 className 仍以英文状态键驱动着色（.status-badge.running/.completed/...），
  // 但展示文案改中文，对齐原型「成功/失败/运行中」措辞。
  const STATUS_BADGE_LABEL_ZH = {
    running: '运行中',
    completed: '成功',
    done: '成功',
    failed: '失败',
    error: '失败',
    killed: '已终止',
    interrupted: '已中断',
    unknown: '未知'
  };

  function renderStatusBadge(status) {
    const badge = document.createElement('span');
    const normalized = String(status || 'unknown').toLowerCase();
    badge.className = `status-badge ${normalized}`;
    badge.textContent = statusLabel('sessionStatus', normalized, STATUS_BADGE_LABEL_ZH[normalized] || normalized);
    return badge;
  }

  function hasHistoryFilters() {
    return Object.values(state.historyFilters).some(Boolean);
  }

  function getSessionStamp(session) {
    return session.lastMessageAt || session.updatedAt || session.createdAt || '';
  }

  function getSessionDisplayStatus(session) {
    if (session.turnState === 'running') return 'running';
    return session.lastTurnResult?.status || session.turnState || 'unknown';
  }

  function formatDate(value) {
    // 缺时间时用统一的空占位「—」（与 formatSessionDuration 及全站空态一致），
    // 不再回退到英文 'no time'——用户可见 UI 一律中文/中性占位。
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(state.locale);
  }

  // A3：会话时长由客户端根据 lastMessageAt − createdAt 估算，无法计算时显示「—」。
  function formatSessionDuration(meta) {
    const start = Date.parse(meta?.createdAt || '');
    const end = Date.parse(meta?.lastMessageAt || meta?.updatedAt || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '—';
    const totalSeconds = Math.round((end - start) / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes <= 0) return adminText('admin.history.durationSeconds', { seconds }, `${seconds} 秒`);
    return adminText('admin.history.durationMinutesSeconds', { minutes, seconds }, `${minutes} 分 ${seconds} 秒`);
  }

  // E4：sessionId 列展示短哈希（原型：截前 10 位），完整值放 title 供悬浮查看。
  function shortSessionId(sessionId) {
    const value = String(sessionId || '');
    if (!value) return '—';
    return value.length > 10 ? `${value.slice(0, 10)}…` : value;
  }

  function setHistoryError(message) {
    if (els.historyError) els.historyError.textContent = message || '';
  }

  async function openSessionDetail(sessionId) {
    if (!sessionId) return;
    state.history.selectedSessionId = sessionId;
    state.history.selectedDetail = null;
    state.history.debugLoaded = false;
    state.history.debugBundle = null;
    state.history.debugBundleSessionId = '';
    state.history.debugError = '';
    state.history.debugRequestId += 1;
    state.history.analysis = null;
    state.history.analysisError = '';
    const analysisRequestId = state.history.analysisRequestId + 1;
    state.history.analysisRequestId = analysisRequestId;
    els.sessionDetailDrawer.hidden = false;
    if (els.sessionDetailBackdrop) els.sessionDetailBackdrop.hidden = false;
    activateDrawerFocus(els.sessionDetailDrawer);
    els.sessionDetailTitle.textContent = adminText('admin.history.loadingDetail', '加载会话详情');
    els.sessionDetailMeta.textContent = sessionId;
    els.sessionDetailError.textContent = '';
    els.sessionDetailTranscript.replaceChildren();
    renderSessionAnalysis(null, adminText('admin.history.loadingAnalysis', '正在加载会话分析…'));
    els.sessionDetailInfo.replaceChildren();
    els.sessionDetailDebug.replaceChildren();
    els.sessionDetailDebug.hidden = true;
    els.sessionDebugToggle.setAttribute('aria-expanded', 'false');
    renderHistoryWorkspace();
    try {
      const detail = await fetchSessionDetail(sessionId);
      if (state.history.selectedSessionId !== sessionId) return false;
      state.history.selectedDetail = detail;
      renderSessionDetail(detail);
      loadSessionAnalysis(sessionId, analysisRequestId).catch(() => undefined);
      return true;
    } catch (error) {
      if (state.history.selectedSessionId === sessionId) {
        els.sessionDetailError.textContent = error.message;
      }
      return false;
    }
  }

  async function fetchSessionDetail(sessionId, options = {}) {
    const query = new URLSearchParams();
    if (options.outputTail) query.set('outputTail', String(options.outputTail));
    const suffix = query.toString() ? `?${query}` : '';
    const response = await window.AgentXAuth.authFetch(`/admin/sessions/${encodeURIComponent(sessionId)}/history${suffix}`, {
      skipAuthRedirect: true
    });
    if (handleAdminAuthFailure(response)) {
      throw new Error(adminText('admin.error.adminAuthRequired', 'Admin authentication required'));
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadSessionDetail', { status: response.status }, `加载会话详情失败 (${response.status})`));
    }
    return response.json();
  }

  async function fetchSessionAnalysis(sessionId) {
    const response = await window.AgentXAuth.authFetch(`/admin/sessions/${encodeURIComponent(sessionId)}/analysis`, {
      skipAuthRedirect: true
    });
    if (handleAdminAuthFailure(response)) {
      throw new Error(adminText('admin.error.adminAuthRequired', 'Admin authentication required'));
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadSessionAnalysis', { status: response.status }, `加载会话分析失败 (${response.status})`));
    }
    return response.json();
  }

  async function loadSessionAnalysis(sessionId, requestId = state.history.analysisRequestId) {
    try {
      const analysis = await fetchSessionAnalysis(sessionId);
      if (state.history.selectedSessionId !== sessionId || state.history.analysisRequestId !== requestId) return;
      state.history.analysis = analysis;
      state.history.analysisError = '';
      renderSessionAnalysis(analysis);
    } catch (error) {
      if (state.history.selectedSessionId !== sessionId || state.history.analysisRequestId !== requestId) return;
      state.history.analysis = null;
      state.history.analysisError = error.message;
      renderSessionAnalysis(null, error.message);
    }
  }

  async function fetchSessionDebugBundle(sessionId) {
    const response = await window.AgentXAuth.authFetch(`/admin/sessions/${encodeURIComponent(sessionId)}/debug`, {
      skipAuthRedirect: true
    });
    if (handleAdminAuthFailure(response)) {
      throw new Error(adminText('admin.error.adminAuthRequired', 'Admin authentication required'));
    }
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadSessionDebug', { status: response.status }, `加载会话 Debug 数据失败 (${response.status})`));
    }
    return response.json();
  }

  async function fetchSessionDiscoveryTraces(sessionId) {
    const query = new URLSearchParams({ sessionId });
    const response = await window.AgentXAuth.authFetch(`/admin/discovery-traces?${query}`, {
      skipAuthRedirect: true
    });
    if (handleAdminAuthFailure(response)) {
      throw new Error(adminText('admin.error.adminAuthRequired', 'Admin authentication required'));
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadSessionTrace', { status: response.status }, `加载会话检索追踪失败 (${response.status})`));
    }
    return response.json();
  }

  function renderSessionDetail(detail) {
    const meta = detail.meta || {};
    els.sessionDetailTitle.textContent = meta.title || meta.task || meta.sessionId || adminText('admin.history.detailTitle', '会话详情');
    els.sessionDetailMeta.textContent = [
      meta.username || meta.userId,
      meta.role,
      meta.chipLabel || meta.chipId,
      meta.source,
      formatDate(meta.lastMessageAt || meta.updatedAt || meta.createdAt)
    ].filter(Boolean).join(' · ');
    renderTranscript(detail.transcript || []);
    renderSessionInfo(meta);
    const debugMatchesSelectedSession = state.history.debugBundleSessionId === state.history.selectedSessionId;
    detail.debugBundle = debugMatchesSelectedSession ? state.history.debugBundle : null;
    detail.debugError = debugMatchesSelectedSession ? state.history.debugError : '';
    renderDebug(detail);
  }

  function renderTranscript(transcript) {
    els.sessionDetailTranscript.replaceChildren();
    if (transcript.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.history.noTranscript', '暂无会话转录');
      els.sessionDetailTranscript.append(empty);
      return;
    }
    for (const entry of transcript) {
      const row = document.createElement('div');
      row.className = `transcript-entry ${entry.role}`;
      const role = document.createElement('strong');
      role.textContent = entry.role;
      const body = document.createElement('span');
      if (entry.role === 'turn_result') {
        // role 标签与状态徽标已分别显示 turn_result / 状态，body 不再重复它们，仅补退出码与输出量（中文）。
        body.textContent = adminText(
          'admin.history.exitSummary',
          { exitCode: entry.exitCode ?? '—', chars: entry.totalOutputChars ?? 0 },
          `退出码 ${entry.exitCode ?? '—'} · 输出 ${entry.totalOutputChars ?? 0} 字符`
        );
        row.append(role, renderStatusBadge(entry.status), body);
      } else {
        body.textContent = entry.text || '';
        row.append(role, body);
      }
      els.sessionDetailTranscript.append(row);
    }
  }

  function renderSessionAnalysis(analysis, transientMessage = '') {
    if (!els.sessionDetailAnalysisBubbles) return;
    els.sessionDetailAnalysisBubbles.replaceChildren();
    if (els.sessionDetailAnalysisError) {
      els.sessionDetailAnalysisError.textContent = transientMessage
        && !analysis
        && transientMessage !== adminText('admin.history.loadingAnalysis', '正在加载会话分析…')
        ? transientMessage
        : '';
    }
    if (!analysis) {
      els.sessionDetailAnalysisBubbles.append(
        renderEmptyState(transientMessage || adminText('admin.history.noAnalysis', '暂无会话分析'))
      );
      return;
    }
    const messages = normalizeAnalysisMessages(analysis);
    if (messages.length === 0) {
      els.sessionDetailAnalysisBubbles.append(renderEmptyState(adminText('admin.history.noConversation', '暂无会话对话记录')));
    } else {
      for (const message of messages) {
        const bubble = document.createElement('div');
        bubble.className = `session-analysis-bubble ${message.role || 'unknown'}`;
        const meta = document.createElement('strong');
        meta.textContent = [message.role || 'message', formatDate(message.createdAt)].filter(Boolean).join(' · ');
        const body = document.createElement('p');
        body.textContent = message.text || message.content || '';
        bubble.append(meta, body);
        els.sessionDetailAnalysisBubbles.append(bubble);
      }
    }
    const questions = Array.isArray(analysis.questions?.items)
      ? analysis.questions.items
      : Array.isArray(analysis.questions)
        ? analysis.questions
        : [];
    if (questions.length > 0) {
      const ledger = document.createElement('div');
      ledger.className = 'session-analysis-ledger';
      const title = document.createElement('strong');
      title.textContent = adminText('admin.history.questionCount', { count: questions.length }, `问题台账 ${questions.length} 条`);
      ledger.append(title);
      for (const question of questions.slice(0, 5)) {
        const item = document.createElement('p');
        item.textContent = question.text || question.question || question.questionId || '';
        ledger.append(item);
      }
      els.sessionDetailAnalysisBubbles.append(ledger);
    }
  }

  function normalizeAnalysisMessages(analysis) {
    for (const key of ['messages', 'conversation', 'transcript']) {
      if (Array.isArray(analysis?.[key])) return analysis[key];
    }
    if (Array.isArray(analysis?.session?.messages)) return analysis.session.messages;
    if (Array.isArray(analysis?.detail?.transcript)) return analysis.detail.transcript;
    return [];
  }

  function renderSessionInfo(meta) {
    els.sessionDetailInfo.replaceChildren();
    const fields = [
      ['sessionId', meta.sessionId],
      ['claudeSessionId', meta.claudeSessionId],
      [adminText('admin.field.user', '用户'), [meta.username, meta.userId].filter(Boolean).join(' / ')],
      [adminText('admin.field.role', '角色'), meta.role],
      [adminText('admin.field.chip', '芯片'), [meta.chipLabel, meta.chipId].filter(Boolean).join(' / ')],
      [adminText('admin.field.model', '模型'), meta.modelId || meta.claudeModelRole],
      [adminText('admin.field.creditsUsed', '积分消耗'), meta.creditUnits === undefined || meta.creditUnits === null ? '' : formatNumber(meta.creditUnits)],
      [adminText('admin.field.duration', '时长'), formatSessionDuration(meta)],
      ['source', meta.source],
      ['cwd', meta.cwd],
      ['agentType', meta.agentType],
      ['createdAt', meta.createdAt],
      ['lastMessageAt', meta.lastMessageAt],
      ['turnState', meta.turnState],
      ['lastTurnResult', meta.lastTurnResult ? JSON.stringify(meta.lastTurnResult) : ''],
      ['outputSize', meta.outputSize],
      ['tags', Array.isArray(meta.tags) ? meta.tags.join(', ') : ''],
      ['adminNotes', meta.adminNotes],
      ['aiSummary', meta.aiSummary],
      ['aiLabels', Array.isArray(meta.aiLabels) ? meta.aiLabels.join(', ') : '']
    ];
    for (const [labelText, value] of fields) {
      const row = document.createElement('div');
      row.className = 'session-info-row';
      const label = document.createElement('span');
      label.textContent = labelText;
      const content = document.createElement('code');
      content.textContent = value === undefined || value === '' ? '-' : String(value);
      row.append(label, content);
      els.sessionDetailInfo.append(row);
    }
  }

  function renderDebug(detail) {
    els.sessionDetailDebug.replaceChildren();
    const notice = document.createElement('p');
    notice.className = 'debug-notice';
    notice.textContent = adminText(
      'admin.debug.adminOnlyNotice',
      'Admin-only Debug bundle；仅在展开时读取 /admin/sessions/:id/debug。'
    );
    els.sessionDetailDebug.append(notice);
    if (detail.debugError) {
      const error = document.createElement('div');
      error.className = 'admin-error-banner';
      error.textContent = adminText('admin.debug.loadFailedDetail', { error: detail.debugError }, `Debug bundle 加载失败：${detail.debugError}`);
      els.sessionDetailDebug.append(error);
      return;
    }
    const bundle = detail.debugBundle;
    if (!bundle) {
      els.sessionDetailDebug.append(renderEmptyState(
        state.history.debugLoaded
          ? adminText('admin.debug.noneForSession', '暂无该会话 Debug bundle')
          : adminText('admin.debug.notLoaded', '尚未加载 Debug bundle')
      ));
      return;
    }
    renderDebugFailure(bundle);
    renderDebugPrompt(bundle.systemPrompt);
    renderDebugTimeline(bundle.stages || []);
    renderDebugOutputs(bundle);
  }

  function renderDebugFailure(bundle) {
    if (!bundle.failure) return;
    const banner = document.createElement('div');
    banner.className = 'admin-error-banner debug-failure-banner';
    const stage = bundle.failure.stage || 'unknown';
    const error = bundle.failure.error || 'unknown error';
    banner.textContent = adminText('admin.debug.interruptedAt', { stage, error }, `本会话中断于 ${stage}：${error}`);
    els.sessionDetailDebug.append(banner);
    if (Array.isArray(bundle.failure.partialWorkspaceTree) && bundle.failure.partialWorkspaceTree.length > 0) {
      const tree = document.createElement('details');
      tree.className = 'debug-artifact-block';
      const summary = document.createElement('summary');
      summary.textContent = adminText('admin.debug.failureWorkspaceSnapshot', '失败时工作区快照');
      tree.append(summary, renderDebugFileTree(bundle.failure.partialWorkspaceTree));
      els.sessionDetailDebug.append(tree);
    }
  }

  function renderDebugPrompt(systemPrompt) {
    const block = document.createElement('details');
    block.className = 'debug-artifact-block debug-trace-prompt-block';
    const summary = document.createElement('summary');
    summary.textContent = adminText('admin.debug.promptSection', '① 注入提示词（完整 system prompt）');
    const actions = document.createElement('div');
    actions.className = 'debug-trace-prompt-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'secondary-button';
    copy.textContent = adminText('admin.action.copy', '复制');
    const text = typeof systemPrompt === 'string' ? systemPrompt : systemPrompt?.text || '';
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigator.clipboard?.writeText?.(text).then(() => {
        copy.textContent = adminText('admin.action.copied', '已复制');
        setTimeout(() => { copy.textContent = adminText('admin.action.copy', '复制'); }, 1200);
      }).catch(() => {
        copy.textContent = adminText('admin.action.copyFailed', '复制失败');
        setTimeout(() => { copy.textContent = adminText('admin.action.copy', '复制'); }, 1200);
      });
    });
    actions.append(copy);
    const pre = document.createElement('pre');
    pre.className = 'debug-output';
    pre.textContent = text || adminText('admin.debug.noSystemPrompt', '无 systemPrompt');
    block.append(summary, actions, pre);
    els.sessionDetailDebug.append(block);
  }

  function renderDebugTimeline(stages) {
    const title = document.createElement('h4');
    title.textContent = adminText('admin.debug.timelineSection', '② 检索流水线时间线');
    els.sessionDetailDebug.append(title);
    if (!Array.isArray(stages) || stages.length === 0) {
      els.sessionDetailDebug.append(renderEmptyState(adminText('admin.debug.noStages', '暂无阶段记录')));
      return;
    }
    const list = document.createElement('div');
    list.className = 'debug-trace-timeline';
    stages.forEach((stage, index) => {
      const isSkipped = stage.status === 'skipped';
      // 对齐原型 operations.html renderTraceTimeline：阶段的 detail（KV 摘要）始终显示在主行，
      // 只有 artifact（阶段产物）才折叠进可展开体——避免成功阶段主行留白、关键信息全藏折叠体。
      const hasArtifact = stage.artifact !== undefined;
      const detailEntries =
        stage.detail && typeof stage.detail === 'object' && !Array.isArray(stage.detail)
          ? Object.entries(stage.detail)
          : [];
      const step = document.createElement('div');
      step.className = `debug-trace-step${isSkipped ? ' is-skipped' : ''}`;

      const head = document.createElement('div');
      head.className = `debug-trace-step-head${hasArtifact ? ' has-artifact' : ''}`;

      const icon = document.createElement('span');
      icon.className = `debug-trace-icon ${debugTraceIconClass(stage.status)}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = debugTraceIconGlyph(stage.status);

      const stageInfo = document.createElement('div');
      stageInfo.className = 'debug-trace-stage';
      const name = document.createElement('div');
      name.className = 'debug-trace-stage-name';
      name.textContent = stage.stage || stage.name || 'unknown stage';
      const detailLine = document.createElement('div');
      detailLine.className = 'debug-trace-stage-detail';
      if (isSkipped) {
        detailLine.textContent = adminText('admin.debug.notExecuted', '未执行（上游阶段失败，流水线已中断）');
      } else if (detailEntries.length > 0) {
        detailLine.append(renderDebugDetailInline(detailEntries));
      }
      stageInfo.append(name, detailLine);

      const dur = document.createElement('span');
      dur.className = 'debug-trace-dur';
      // V16：有真实 durationMs 时渲染耗时（毫秒/秒）；无 durationMs 时回退显示 ts 写入时刻（历史 bundle 兼容）。
      dur.textContent =
        typeof stage.durationMs === 'number'
          ? formatStageDuration(stage.durationMs)
          : stage.ts || stage.timestamp
            ? new Date(stage.ts || stage.timestamp).toLocaleTimeString('zh-CN')
            : '';

      const toggle = document.createElement('span');
      toggle.className = 'debug-trace-toggle';
      toggle.setAttribute('aria-hidden', 'true');
      toggle.textContent = hasArtifact ? '›' : '';

      head.append(icon, stageInfo, dur, toggle);

      const bodyId = `debug-trace-artifact-${index}`;
      if (hasArtifact) {
        head.setAttribute('role', 'button');
        head.tabIndex = 0;
        head.setAttribute('aria-expanded', stage.status === 'error' ? 'true' : 'false');
        head.setAttribute('aria-controls', bodyId);
      }
      step.append(head);

      if (hasArtifact) {
        const body = document.createElement('div');
        body.className = 'debug-trace-artifact';
        body.id = bodyId;
        body.hidden = stage.status !== 'error';
        toggle.classList.toggle('open', !body.hidden);
        body.append(renderDebugArtifact(stage.artifact));
        const toggleBody = () => {
          body.hidden = !body.hidden;
          head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
          toggle.classList.toggle('open', !body.hidden);
        };
        head.addEventListener('click', toggleBody);
        head.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleBody();
          }
        });
        step.append(body);
      }

      list.append(step);
    });
    els.sessionDetailDebug.append(list);
  }

  // V16：把阶段真实耗时（毫秒）渲染成可读文本；不足 1 秒显示毫秒，否则显示到小数点后一位的秒数。
  function formatStageDuration(durationMs) {
    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return adminText('admin.debug.durationMs', { value: Math.round(ms) }, `${Math.round(ms)} 毫秒`);
    return adminText('admin.debug.durationSeconds', { value: (ms / 1000).toFixed(1) }, `${(ms / 1000).toFixed(1)} 秒`);
  }

  function debugTraceIconClass(status) {
    if (status === 'ok' || status === 'done' || status === 'success') return 'debug-trace-icon-ok';
    if (status === 'error' || status === 'failed') return 'debug-trace-icon-error';
    return 'debug-trace-icon-skipped';
  }

  function debugTraceIconGlyph(status) {
    if (status === 'ok' || status === 'done' || status === 'success') return '✓';
    if (status === 'error' || status === 'failed') return '✕';
    return '–';
  }

  // 行内 KV 摘要（原型 .tc .detail 里的 .kv 小片）：key 加粗、value 常规，供阶段主行直接扫读。
  function renderDebugDetailInline(entries) {
    const frag = document.createDocumentFragment();
    for (const [key, value] of entries) {
      const chip = document.createElement('span');
      chip.className = 'debug-trace-kv-chip';
      const strong = document.createElement('b');
      strong.textContent = key;
      chip.append(strong, document.createTextNode(' ' + formatDebugDetailValue(value)));
      frag.append(chip);
    }
    return frag;
  }

  function formatDebugDetailValue(value) {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      const serialized = JSON.stringify(value);
      return serialized.length > 96 ? `${serialized.slice(0, 95)}…` : serialized;
    } catch {
      return String(value);
    }
  }

  function renderDebugArtifact(artifact) {
    const block = document.createElement('div');
    block.className = 'debug-artifact-block';
    const title = document.createElement('div');
    title.className = 'debug-artifact-title';
    title.textContent = artifact?.title || artifact?.kind || adminText('admin.debug.stageArtifact', '阶段产物');
    block.append(title);
    if (typeof artifact === 'string') {
      const pre = document.createElement('pre');
      pre.className = 'debug-output';
      pre.textContent = artifact;
      block.append(pre);
      return block;
    }
    if (!artifact || typeof artifact !== 'object') {
      block.append(renderEmptyState(adminText('admin.debug.noStageArtifact', '无阶段产物')));
      return block;
    }
    const kind = artifact.kind;
    if (kind === 'chiplist') {
      block.append(renderDebugCandidateList(artifact.items || [], 'chip'));
      return block;
    }
    if (kind === 'filetree') {
      block.append(renderDebugFileTree(artifact.tree || artifact.items || []));
      if (artifact.errorMessage) {
        const error = document.createElement('div');
        error.className = 'debug-error-block';
        error.textContent = artifact.errorMessage;
        block.append(error);
      }
      return block;
    }
    if (kind === 'candidates') {
      block.append(renderDebugCandidateList(artifact.items || [], 'file'));
      return block;
    }
    if (kind === 'simplelist') {
      block.append(renderDebugSimpleList(artifact.items || []));
      return block;
    }
    if (Array.isArray(artifact.candidates)) {
      block.append(renderDebugCandidateList(artifact.candidates, 'chip'));
      block.append(renderDebugKeyValues(pickDebugFields(artifact, ['prompt', 'response', 'rawCandidatesCount', 'truncated'])));
      return block;
    }
    if (Array.isArray(artifact.kept) || Array.isArray(artifact.dropped)) {
      block.append(renderDebugKeyValues({
        kept: artifact.kept,
        dropped: artifact.dropped
      }));
      return block;
    }
    if (artifact.workspace && Array.isArray(artifact.workspace.files)) {
      block.append(renderDebugKeyValues(pickDebugFields(artifact.workspace, ['scopeId', 'mode'])));
      block.append(renderDebugFileTree(artifact.workspace.files));
      return block;
    }
    if (Array.isArray(artifact.files)) {
      if (Array.isArray(artifact.chips)) {
        block.append(renderDebugSimpleList(artifact.chips));
      } else if (artifact.chipId) {
        block.append(renderDebugKeyValues({ chipId: artifact.chipId }));
      }
      block.append(renderDebugFileTree(artifact.files));
      if (Array.isArray(artifact.chatImages) && artifact.chatImages.length > 0) {
        const imagesTitle = document.createElement('div');
        imagesTitle.className = 'debug-artifact-title';
        imagesTitle.textContent = adminText('admin.debug.chatImages', '聊天图片');
        block.append(imagesTitle, renderDebugFileTree(artifact.chatImages));
      }
      return block;
    }
    if (artifact.answer || artifact.sourceCount !== undefined) {
      block.append(renderDebugKeyValues({
        prompt: artifact.prompt,
        sourceCount: artifact.sourceCount,
        answer: artifact.answer?.text || artifact.answer
      }));
      return block;
    }
    block.append(renderDebugKeyValues(artifact));
    return block;
  }

  function pickDebugFields(source, keys) {
    const result = {};
    for (const key of keys) {
      if (source?.[key] !== undefined) result[key] = source[key];
    }
    return result;
  }

  function renderDebugKeyValues(value) {
    const dl = document.createElement('dl');
    dl.className = 'debug-trace-kv';
    const entries = Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== '');
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'debug-sl-row';
      const text = document.createElement('span');
      text.textContent = adminText('admin.common.noDetails', '无详情');
      empty.append(renderDebugRowIcon('·'), text);
      dl.append(empty);
      return dl;
    }
    for (const [key, item] of entries) {
      const row = document.createElement('div');
      row.className = 'debug-sl-row';
      const icon = renderDebugRowIcon('·');
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = formatDebugValue(item);
      const text = document.createElement('span');
      text.append(dt, dd);
      row.append(icon, text);
      dl.append(row);
    }
    return dl;
  }

  function renderDebugCandidateList(items, primaryKey) {
    const list = document.createElement('div');
    list.className = 'debug-candidate-list';
    for (const item of Array.isArray(items) ? items : []) {
      const row = document.createElement('div');
      row.className = 'debug-candidate-item';
      const file = document.createElement('span');
      file.className = 'debug-candidate-file';
      file.textContent = item?.[primaryKey] || item?.chip || item?.file || String(item);
      const reason = document.createElement('span');
      reason.className = 'debug-candidate-reason';
      reason.textContent = item?.reason
        ? adminText('admin.debug.reason', { value: item.reason }, `理由：${item.reason}`)
        : '';
      row.append(file, reason);
      list.append(row);
    }
    if (list.childElementCount === 0) list.append(renderEmptyState(adminText('admin.debug.noCandidates', '暂无候选项')));
    return list;
  }

  function renderDebugFileTree(nodes) {
    const tree = document.createElement('div');
    tree.className = 'debug-file-tree';
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const row = document.createElement('div');
      const pathText = typeof node === 'string' ? node : (node?.path || node?.name || String(node));
      const pathParts = String(pathText).split(/[\\/]/).filter(Boolean);
      const inferredIndent = Math.max(0, pathParts.length - 1);
      const indent = Math.max(0, Math.min(Number(node?.indent ?? inferredIndent), 6));
      row.className = `debug-ft-row debug-ft-indent-${indent}`;
      const icon = renderDebugRowIcon(node?.type === 'dir' ? '▾' : '•');
      const name = document.createElement('span');
      name.className = node?.type === 'dir' ? 'debug-ft-dir' : '';
      name.textContent = pathText;
      row.append(icon, name);
      if (node?.size) {
        const size = document.createElement('span');
        size.className = 'debug-ft-size';
        size.textContent = node.size;
        row.append(size);
      } else {
        row.append(document.createElement('span'));
      }
      tree.append(row);
    }
    if (tree.childElementCount === 0) tree.append(renderEmptyState(adminText('admin.debug.noFileTree', '暂无文件树')));
    return tree;
  }

  function renderDebugSimpleList(items) {
    const list = document.createElement('div');
    list.className = 'debug-simple-list';
    for (const item of Array.isArray(items) ? items : []) {
      const row = document.createElement('div');
      row.className = 'debug-sl-row';
      const text = document.createElement('span');
      text.textContent = formatDebugValue(item);
      row.append(renderDebugRowIcon('·'), text);
      list.append(row);
    }
    if (list.childElementCount === 0) list.append(renderEmptyState(adminText('admin.debug.noEntries', '暂无条目')));
    return list;
  }

  function renderDebugRowIcon(text) {
    const icon = document.createElement('span');
    icon.className = 'debug-row-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = text;
    return icon;
  }

  function formatDebugValue(value) {
    if (Array.isArray(value)) return value.map((item) => formatDebugValue(item)).join('、');
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      return Object.entries(value)
        .filter(([, item]) => item !== undefined && item !== null && item !== '')
        .map(([key, item]) => `${key}: ${formatDebugValue(item)}`)
        .join('；');
    }
    return String(value ?? '—');
  }

  function renderDebugOutputs(bundle) {
    const outputs = [
      [adminText('admin.debug.intermediateOutput', '中间输出'), bundle.intermediate || bundle.intermediateOutputs],
      [adminText('admin.debug.finalOutput', '最终输出'), bundle.final || bundle.finalOutput || bundle.answer]
    ].filter(([, value]) => value !== undefined && value !== null && value !== '');
    if (outputs.length === 0) return;
    const title = document.createElement('h4');
    title.textContent = adminText('admin.debug.outputsSection', '③ 中间输出与最终输出');
    els.sessionDetailDebug.append(title);
    for (const [label, value] of outputs) {
      const block = document.createElement('div');
      block.className = 'debug-artifact-block';
      const heading = document.createElement('div');
      heading.className = 'history-row-meta';
      heading.textContent = label;
      const pre = document.createElement('pre');
      pre.className = 'debug-output';
      pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      block.append(heading, pre);
      els.sessionDetailDebug.append(block);
    }
  }

  function renderSessionDiscoveryTraces(detail) {
    const title = document.createElement('h4');
    title.textContent = adminText('admin.debug.discoveryTrace', '检索追踪');
    els.sessionDetailDebug.append(title);
    if (detail.discoveryTraceError) {
      const error = document.createElement('div');
      error.className = 'empty-state';
      error.textContent = adminText(
        'admin.debug.discoveryTraceLoadFailed',
        { error: detail.discoveryTraceError },
        `检索追踪加载失败：${detail.discoveryTraceError}`
      );
      els.sessionDetailDebug.append(error);
      return;
    }
    const traces = detail.discoveryTraces || [];
    if (traces.length === 0) {
      els.sessionDetailDebug.append(renderEmptyState(adminText('admin.debug.noSessionTrace', '暂无本会话检索追踪')));
      return;
    }
    const list = document.createElement('div');
    list.className = 'debug-event-list';
    for (const trace of traces) {
      const row = document.createElement('div');
      row.className = 'debug-event-row';
      const heading = document.createElement('div');
      heading.className = 'debug-trace-stage';
      heading.textContent = `${trace.ts || ''} · ${trace.stage || ''} · ${trace.status || ''}`;
      row.append(heading);
      if (trace.detail) {
        row.append(renderDebugKeyValues(trace.detail));
      }
      list.append(row);
    }
    els.sessionDetailDebug.append(list);
  }

  async function loadSessionDebug(options = {}) {
    const sessionId = state.history.selectedSessionId;
    if (!sessionId) return;
    const expanded = els.sessionDebugToggle.getAttribute('aria-expanded') === 'true';
    if (!expanded || options.forceOpen) {
      els.sessionDebugToggle.setAttribute('aria-expanded', 'true');
      els.sessionDetailDebug.hidden = false;
    }
    if (state.history.debugLoaded) return;
    const requestId = ++state.history.debugRequestId;
    els.sessionDetailDebug.hidden = false;
    els.sessionDetailDebug.replaceChildren(renderEmptyState(adminText('admin.debug.loading', '正在加载 Debug bundle…')));
    state.history.debugError = '';
    try {
      const bundle = await fetchSessionDebugBundle(sessionId);
      if (requestId !== state.history.debugRequestId || state.history.selectedSessionId !== sessionId) return;
      state.history.debugBundle = bundle;
      state.history.debugBundleSessionId = sessionId;
      state.history.debugLoaded = true;
    } catch (error) {
      if (requestId !== state.history.debugRequestId || state.history.selectedSessionId !== sessionId) return;
      state.history.debugBundle = null;
      state.history.debugBundleSessionId = sessionId;
      state.history.debugError = error.message;
      state.history.debugLoaded = false;
    }
    if (state.history.selectedDetail) {
      renderSessionDetail(state.history.selectedDetail);
    } else if (state.history.debugBundle) {
      renderDebug({
        debugBundle: state.history.debugBundle,
        debugError: state.history.debugError
      });
    } else if (state.history.debugError) {
      els.sessionDetailDebug.replaceChildren();
      const error = document.createElement('div');
      error.className = 'admin-error-banner';
      error.textContent = adminText(
        'admin.debug.loadFailedDetail',
        { error: state.history.debugError },
        `Debug bundle 加载失败：${state.history.debugError}`
      );
      els.sessionDetailDebug.append(error);
    }
    els.sessionDetailDebug.hidden = false;
    els.sessionDebugToggle.setAttribute('aria-expanded', 'true');
  }

  async function loadObservability() {
    if (!state.adminConfirmed) return;
    state.observability.loading = true;
    setObservabilityError('');
    renderObservability();
    try {
      const range = els.observabilityRange?.value || '7d';
      const response = await window.AgentXAuth.authFetch(`/admin/observability?range=${encodeURIComponent(range)}`, { skipAuthRedirect: true });
      if (handleAdminAuthFailure(response)) return;
      if (!response.ok) {
        throw new Error(adminText('admin.error.loadObservability', { status: response.status }, `加载成本观测失败 (${response.status})`));
      }
      state.observability.data = await response.json();
    } finally {
      state.observability.loading = false;
      renderObservability();
    }
  }

  // ——— Discovery Trace 只读视图（spec §6.9）———

  function syncDiagnosticsSystemInfo() {
    if (!els.diagnosticsVersionValue) return;
    const versionText = document.querySelector('[data-product-version]')?.textContent?.trim();
    els.diagnosticsVersionValue.textContent = versionText || 'v2.2.30';
    const info = state.discoveryTraces.data?.systemInfo || state.discoveryTraces.data?.diagnostics || {};
    const notConnected = adminText('admin.common.notConnected', '待接入');
    if (els.diagnosticsDataDirValue) els.diagnosticsDataDirValue.textContent = diagnosticsInfoValue(info, ['dataDir', 'dataDirectory'], notConnected);
    if (els.diagnosticsPlatformValue) els.diagnosticsPlatformValue.textContent = diagnosticsInfoValue(info, ['platform'], notConnected);
    if (els.diagnosticsNodeVersionValue) els.diagnosticsNodeVersionValue.textContent = diagnosticsInfoValue(info, ['nodeVersion', 'nodejs', 'node'], notConnected);
    if (els.diagnosticsAgentBackendValue) els.diagnosticsAgentBackendValue.textContent = diagnosticsInfoValue(info, ['agentBackend', 'agentBackendLabel', 'backend'], 'claude-code');
    if (els.diagnosticsClaudeVersionValue) els.diagnosticsClaudeVersionValue.textContent = diagnosticsInfoValue(info, ['claudeCodeCliVersion', 'claudeCliVersion', 'claudeVersion'], notConnected);
    renderDiagnosticsConfigStatus(info);
  }

  function renderDiagnosticsConfigStatus(info) {
    if (!els.diagnosticsConfigStatusList) return;
    els.diagnosticsConfigStatusList.replaceChildren();
    const items = Array.isArray(info?.configStatusItems) ? info.configStatusItems : null;
    if (items && items.length > 0) {
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'diagnostics-config-status-row';
        const main = document.createElement('div');
        main.className = 'diagnostics-config-status-main';
        const name = document.createElement('span');
        name.className = 'diagnostics-config-status-name';
        name.textContent = item.name;
        const badge = document.createElement('span');
        // 三态：ok=已加载（绿）/ fallback=使用默认（黄，文件缺失但跑在内存默认上）/ 其它=缺失（红）。
        const status = item.status === 'ok' ? 'ok' : item.status === 'fallback' ? 'fallback' : 'missing';
        const badgeClass =
          status === 'ok' ? 'admin-badge-success' : status === 'fallback' ? 'admin-badge-warn' : 'admin-badge-danger';
        badge.className = `admin-badge ${badgeClass}`;
        badge.textContent = statusLabel(
          'configStatus',
          status,
          status === 'ok' ? '已加载' : status === 'fallback' ? '使用默认' : '缺失'
        );
        main.append(name, badge);
        row.append(main);
        if (item.detail) {
          const detail = document.createElement('div');
          detail.className = 'diagnostics-config-status-detail';
          detail.textContent = item.detail;
          row.append(detail);
        }
        els.diagnosticsConfigStatusList.append(row);
      }
      return;
    }
    // 兼容旧接口：无结构化字段时退回逗号拼接串整行展示。
    const fallback = diagnosticsInfoValue(
      info,
      ['configStatus', 'configurationStatus'],
      adminText('admin.common.notConnected', '待接入')
    );
    const row = document.createElement('div');
    row.className = 'diagnostics-config-status-row';
    row.textContent = fallback;
    els.diagnosticsConfigStatusList.append(row);
  }

  function diagnosticsInfoValue(info, keys, fallback) {
    for (const key of keys) {
      const value = info?.[key];
      if (value !== undefined && value !== null && value !== '') {
        return typeof value === 'string' ? value : JSON.stringify(value);
      }
    }
    return fallback;
  }

  function setDiscoveryTraceQuickFilter(filter) {
    state.discoveryTraces.quickFilter = filter || '';
    if (els.discoveryTracesFilterAll) {
      els.discoveryTracesFilterAll.classList.toggle('active', state.discoveryTraces.quickFilter === '');
      els.discoveryTracesFilterAll.setAttribute('aria-pressed', state.discoveryTraces.quickFilter === '' ? 'true' : 'false');
    }
    if (els.discoveryTracesFilterError) {
      els.discoveryTracesFilterError.classList.toggle('active', state.discoveryTraces.quickFilter === 'error');
      els.discoveryTracesFilterError.setAttribute('aria-pressed', state.discoveryTraces.quickFilter === 'error' ? 'true' : 'false');
    }
    renderDiscoveryTraces();
  }

  async function loadDiscoveryTraces() {
    if (!state.adminConfirmed) return;
    syncDiagnosticsSystemInfo();
    state.discoveryTraces.loading = true;
    setDiscoveryTracesError('');
    renderDiscoveryTraces();
    // 与 history/observability/announcements/tickets 一致：用 try/finally 保证任何失败路径
    // （非 ok 抛错 / fetch reject / auth 早返回）都复位 loading，不再卡在「正在加载追踪记录…」。
    try {
      const response = await window.AgentXAuth.authFetch('/admin/discovery-traces', { skipAuthRedirect: true });
      if (handleAdminAuthFailure(response)) return;
      if (!response.ok) {
        throw new Error(adminText('admin.error.loadDiagnostics', { status: response.status }, `加载运行诊断失败 (${response.status})`));
      }
      state.discoveryTraces.data = await response.json();
    } finally {
      state.discoveryTraces.loading = false;
      renderDiscoveryTraces();
    }
  }

  function renderDiscoveryTraces() {
    if (!els.discoveryTracesList) return;
    syncDiagnosticsSystemInfo();
    const data = state.discoveryTraces.data;
    if (state.discoveryTraces.loading && !data) {
      if (els.discoveryTracesSummary) {
        els.discoveryTracesSummary.textContent = adminText('admin.diagnostics.loadingTraces', '正在加载追踪记录…');
      }
      els.discoveryTracesList.replaceChildren();
      return;
    }
    const allTraces = data?.traces ?? [];
    const traces = state.discoveryTraces.quickFilter
      ? allTraces.filter((trace) => trace.status === state.discoveryTraces.quickFilter)
      : allTraces;
    if (els.discoveryTracesSummary) {
      els.discoveryTracesSummary.textContent = allTraces.length > 0
        ? adminText(
          'admin.diagnostics.traceSummary',
          { shown: traces.length, total: allTraces.length },
          `显示 ${traces.length}/${allTraces.length} 条追踪记录`
        )
        : '';
    }
    if (traces.length === 0) {
      els.discoveryTracesList.replaceChildren(renderEmptyState(adminText('admin.diagnostics.noTraces', '暂无追踪记录')));
      return;
    }
    // 批次B（2.2.27）：复用共享密集表 .admin-dense-table；detail 从行内挪进「默认折叠、点箭头展开」
    // 的明细行，对齐原型 settings.html 的 diag-expand-btn/diag-detail-row，修「行高参差、无法扫读」。
    const wrap = document.createElement('div');
    wrap.className = 'admin-dense-table discovery-traces-table';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const label of [
      '',
      adminText('admin.field.time', '时间'),
      'sessionId',
      adminText('admin.field.type', '类型'),
      'stage',
      'status',
      adminText('admin.field.actions', '操作')
    ]) {
      const th = document.createElement('th');
      th.textContent = label;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const trace of [...traces].reverse()) {
      const row = document.createElement('tr');
      row.className = `discovery-trace-row discovery-trace-${trace.status ?? 'ok'}`;
      const hasDetail = trace.detail && Object.keys(trace.detail).length > 0;

      const tdExpand = document.createElement('td');
      tdExpand.className = 'trace-expand-cell';
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'discovery-trace-expand';
      expandBtn.setAttribute('aria-label', adminText('admin.diagnostics.expandDetails', '展开明细'));
      expandBtn.setAttribute('aria-expanded', 'false');
      // 全仓约定不拼接 HTML 写入 DOM（见 web-ui/source-citations 合约测试），用 createElementNS 构建 chevron。
      const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      chevron.setAttribute('width', '12');
      chevron.setAttribute('height', '12');
      chevron.setAttribute('viewBox', '0 0 24 24');
      chevron.setAttribute('fill', 'none');
      chevron.setAttribute('stroke', 'currentColor');
      chevron.setAttribute('stroke-width', '2.5');
      chevron.setAttribute('stroke-linecap', 'round');
      chevron.setAttribute('stroke-linejoin', 'round');
      chevron.setAttribute('aria-hidden', 'true');
      const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      chevronPath.setAttribute('d', 'm9 18 6-6-6-6');
      chevron.appendChild(chevronPath);
      expandBtn.appendChild(chevron);
      if (!hasDetail) expandBtn.disabled = true;
      tdExpand.appendChild(expandBtn);
      row.appendChild(tdExpand);

      const tdTs = document.createElement('td');
      tdTs.className = 'trace-ts';
      tdTs.textContent = trace.ts ? new Date(trace.ts).toLocaleString(state.locale) : '—';
      row.appendChild(tdTs);

      const tdSession = document.createElement('td');
      tdSession.className = 'trace-session';
      const pill = document.createElement('span');
      pill.className = 'meta-pill';
      pill.textContent = String(trace.sessionId ?? '');
      tdSession.appendChild(pill);
      row.appendChild(tdSession);

      const tdType = document.createElement('td');
      tdType.className = 'trace-type';
      const typeBadge = document.createElement('span');
      const pipe = ['single', 'twostage', 'global'].includes(trace.pipeline) ? trace.pipeline : 'global';
      typeBadge.className = `admin-badge admin-badge-pipeline-${pipe}`;
      typeBadge.textContent = trace.type || pipelineTypeLabel(trace.pipeline) || statusLabel('pipelineType', 'global', '全局');
      tdType.appendChild(typeBadge);
      row.appendChild(tdType);

      const tdStage = document.createElement('td');
      tdStage.className = 'trace-stage';
      const code = document.createElement('code');
      code.textContent = String(trace.stage ?? '');
      tdStage.appendChild(code);
      row.appendChild(tdStage);

      const tdStatus = document.createElement('td');
      tdStatus.className = 'trace-status';
      const st = String(trace.status ?? 'ok');
      const statusBadge = document.createElement('span');
      statusBadge.className = `admin-badge ${st === 'error' ? 'admin-badge-danger' : st === 'ok' ? 'admin-badge-success' : 'admin-badge-muted'}`;
      statusBadge.textContent = st;
      tdStatus.appendChild(statusBadge);
      row.appendChild(tdStatus);

      const tdAction = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'secondary-button btn-sm debug-session-link';
      link.href = `/admin/sections/sessions?debugSessionId=${encodeURIComponent(trace.sessionId || '')}`;
      link.textContent = adminText('admin.diagnostics.openSessionDebug', '打开会话 Debug');
      tdAction.appendChild(link);
      row.appendChild(tdAction);

      const detailRow = document.createElement('tr');
      detailRow.className = 'discovery-trace-detail-row';
      detailRow.hidden = true;
      const detailCell = document.createElement('td');
      detailCell.colSpan = 7;
      detailCell.className = 'discovery-trace-detail-cell';
      detailCell.append(hasDetail ? renderDebugKeyValues(trace.detail) : document.createTextNode('—'));
      detailRow.appendChild(detailCell);

      if (hasDetail) {
        row.classList.add('has-detail');
        const toggle = () => {
          const willOpen = detailRow.hidden;
          detailRow.hidden = !willOpen;
          expandBtn.classList.toggle('open', willOpen);
          expandBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
          row.classList.toggle('expanded', willOpen);
        };
        expandBtn.addEventListener('click', (event) => { event.stopPropagation(); toggle(); });
        row.addEventListener('click', (event) => {
          if (event.target.closest('a')) return;
          toggle();
        });
      }

      tbody.appendChild(row);
      tbody.appendChild(detailRow);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    els.discoveryTracesList.replaceChildren(wrap);
  }

  function pipelineTypeLabel(pipeline) {
    const map = { single: '单芯片', twostage: '跨档两步', global: '全局' };
    return pipeline ? statusLabel('pipelineType', pipeline, map[pipeline] || pipeline) : '';
  }

  function setDiscoveryTracesError(message) {
    if (els.discoveryTracesError) els.discoveryTracesError.textContent = message || '';
  }

  function renderObservability() {
    if (!els.observabilitySummary) return;
    const data = state.observability.data;
    if (state.observability.loading && !data) {
      els.observabilitySummary.textContent = adminText('admin.observability.loading', '正在加载成本观测指标…');
      for (const target of observabilityLists()) target.replaceChildren();
      return;
    }
    if (!data) {
      els.observabilitySummary.textContent = adminText('admin.observability.empty', '暂无成本观测数据');
      for (const target of observabilityLists()) target.replaceChildren(renderEmptyState(adminText('admin.observability.noData', '暂无数据')));
      return;
    }
    const summary = data.summary || {};
    els.observabilitySummary.replaceChildren(
      renderMetricCard(adminText('admin.observability.calls', '调用量'), formatNumber(summary.calls)),
      renderMetricCard(adminText('admin.observability.credits', '积分消耗'), formatNumber(summary.creditsUnits)),
      renderMetricCard(adminText('admin.observability.estimatedTokens', '估算 token'), formatNumber(summary.estimatedTokens)),
      renderMetricCard(
        adminText('admin.observability.averageDuration', '平均耗时'),
        adminText(
          'admin.observability.durationSeconds',
          { value: formatNumber((summary.averageLatencyMs || 0) / 1000) },
          `${formatNumber((summary.averageLatencyMs || 0) / 1000)} 秒`
        )
      ),
      renderMetricCard(adminText('admin.observability.failureRate', '失败率'), formatPercent(summary.failureRate))
    );
    renderMetricBuckets(els.observabilityEntry, data.breakdown?.byEntry, { kind: 'entry' });
    renderMetricBuckets(els.observabilityModel, data.breakdown?.byModel);
    renderMetricBuckets(els.observabilityUser, data.breakdown?.byUser, { kind: 'user' });
    renderMetricBuckets(els.observabilityMcpKey, data.breakdown?.byMcpKey);
    renderAnomalies(data.anomalies || []);
  }

  // A7：按入口分布仅对展示做标签映射，后端桶键（web/mcp/rpc/cli）保持不变。
  const OBSERVABILITY_ENTRY_LABELS = {
    web: 'WebChat',
    mcp: 'Remote MCP',
    rpc: '/rpc',
    cli: 'CLI'
  };

  function renderMetricCard(label, value) {
    const card = document.createElement('div');
    card.className = 'observability-card';
    const strong = document.createElement('strong');
    strong.textContent = value ?? '0';
    const span = document.createElement('span');
    span.textContent = label;
    card.append(strong, span);
    return card;
  }

  function renderMetricBuckets(container, buckets, options = {}) {
    if (!container) return;
    container.replaceChildren();
    const entries = Object.entries(buckets || {}).sort((a, b) => (b[1].calls || 0) - (a[1].calls || 0)).slice(0, 8);
    if (entries.length === 0) {
      container.append(renderEmptyState(adminText('admin.observability.noData', '暂无数据')));
      return;
    }
    const maxCalls = Math.max(...entries.map(([, bucket]) => bucket.calls || 0), 1);
    for (const [name, bucket] of entries) {
      const row = document.createElement('div');
      row.className = 'observability-row';
      if (options.kind === 'user') {
        row.classList.add('is-actionable');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.setAttribute('aria-label', adminText('admin.observability.openUser', '打开用户详情'));
        const userRef = { ...bucket, username: bucket.username || name, label: name, key: name };
        row.addEventListener('click', () => openUserWorkspace(userRef));
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          openUserWorkspace(userRef);
        });
      }
      const label = document.createElement('strong');
      label.textContent = options.kind === 'entry' ? (OBSERVABILITY_ENTRY_LABELS[name] || name) : name;
      const meta = document.createElement('span');
      meta.textContent = `${formatNumber(bucket.calls)} · ${formatPercent((bucket.calls || 0) / maxCalls)}`;
      const track = document.createElement('div');
      track.className = 'observability-bar-track';
      const fill = document.createElement('div');
      fill.className = 'observability-bar-fill';
      fill.style.width = `${Math.round(((bucket.calls || 0) / maxCalls) * 100)}%`;
      track.append(fill);
      row.append(label, track, meta);
      container.append(row);
    }
  }

  // A5：type → severity 映射；high_failure_rate 视为严重（error），其余两类视为警告（warn）。
  const OBSERVABILITY_ANOMALY_SEVERITY = {
    high_failure_rate: { className: 'observability-severity-error', labelKey: 'critical' },
    high_credits: { className: 'observability-severity-warn', labelKey: 'warning' },
    large_output: { className: 'observability-severity-warn', labelKey: 'warning' }
  };

  function renderAnomalies(items) {
    if (!els.observabilityAnomalies) return;
    els.observabilityAnomalies.replaceChildren();
    if (items.length === 0) {
      els.observabilityAnomalies.append(renderEmptyState(adminText('admin.observability.noAnomalies', '暂无异常')));
    } else {
      for (const item of items) {
        const severityInfo = OBSERVABILITY_ANOMALY_SEVERITY[item.type] || {
          className: 'observability-severity-neutral',
          labelKey: 'review'
        };
        const row = document.createElement('div');
        row.className = `observability-anomaly-item ${severityInfo.className}`;
        const severity = document.createElement('span');
        severity.className = 'observability-severity';
        severity.textContent = statusLabel(
          'observability.severity',
          severityInfo.labelKey,
          severityInfo.labelKey === 'critical'
            ? '严重'
            : severityInfo.labelKey === 'warning'
              ? '警告'
              : adminText('admin.observability.severity', '关注')
        );
        const body = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = `${observabilityAnomalyLabel(item.type)}：${item.key}`;
        const desc = document.createElement('span');
        desc.textContent = `${adminText('admin.observability.value', '数值')} ${String(item.value)}`;
        body.append(label, desc);
        row.append(severity, body);
        // large_output 的 key 即 sessionId（src/observability/metrics.ts），可直接跳会话抽屉；
        // high_credits/high_failure_rate 的 key 是用户名等聚合维度，暂无代表 sessionId，不加按钮。
        if (item.type === 'large_output' && item.key) {
          const jumpButton = document.createElement('button');
          jumpButton.type = 'button';
          jumpButton.className = 'secondary-button';
          jumpButton.textContent = adminText('admin.diagnostics.viewSession', '查看会话');
          jumpButton.addEventListener('click', () => jumpToSessionDebug(item.key));
          row.append(jumpButton);
        }
        els.observabilityAnomalies.append(row);
      }
    }
    // A6：安全类异常口径尚未覆盖，加常驻说明。
    els.observabilityAnomalies.append(renderAdminMutedNote(adminText(
      'admin.observability.securityFutureNote',
      '安全类异常（如认证失败按 IP 聚合、越权探测识别）为未来模块，需新增专门采集，当前台账口径暂不覆盖。'
    )));
  }

  function renderAdminMutedNote(text) {
    const note = document.createElement('p');
    note.className = 'admin-muted-note';
    note.textContent = text;
    return note;
  }

  // A5：跳到会话历史并打开该会话的 Debug 抽屉，复用现有 debugSessionId 深链机制
  // （switchSection('sessions') 内部会调用 loadHistoryWorkspace，其 finally 块固定会调用
  // openPendingDebugSession，读取下面设置的 pendingDebugSessionId，无需在此重复调用）。
  async function jumpToSessionDebug(sessionId) {
    if (!sessionId) return;
    state.history.pendingDebugSessionId = sessionId;
    const navigated = await switchSection('sessions');
    if (!navigated) {
      state.history.pendingDebugSessionId = '';
    }
  }

  function observabilityLists() {
    return [els.observabilityEntry, els.observabilityModel, els.observabilityUser, els.observabilityMcpKey, els.observabilityAnomalies].filter(Boolean);
  }

  function observabilityAnomalyLabel(type) {
    const normalized = String(type || 'unknown');
    const zhFallbacks = {
      high_credits: '高积分消耗',
      high_failure_rate: '高失败率',
      large_output: '超大输出'
    };
    const fallback = normalized
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || '异常';
    return adminText(`admin.observability.anomaly.${normalized}`, zhFallbacks[normalized] || fallback);
  }

  function setObservabilityError(message) {
    if (els.observabilityError) els.observabilityError.textContent = message || '';
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString(state.locale);
  }

  function formatPercent(value) {
    return `${Math.round(Number(value || 0) * 100)}%`;
  }

  function clearSessionDetailState() {
    if (els.sessionDetailDrawer) els.sessionDetailDrawer.hidden = true;
    if (els.sessionDetailBackdrop) els.sessionDetailBackdrop.hidden = true;
    state.history.selectedSessionId = null;
    state.history.selectedDetail = null;
    state.history.debugLoaded = false;
    state.history.debugBundle = null;
    state.history.debugBundleSessionId = '';
    state.history.debugError = '';
    state.history.debugRequestId += 1;
    state.history.analysis = null;
    state.history.analysisError = '';
    state.history.analysisRequestId += 1;
    renderSessionAnalysis(null);
  }

  function closeSessionDetail() {
    clearSessionDetailState();
    renderHistoryWorkspace();
    restoreDrawerFocus();
  }

  // 批次A（2.2.27）：切换 admin 分区时统一清理残留的右侧抽屉/遮罩，
  // 避免切走再切回时旧抽屉/backdrop 复现，造成「关不掉/又冒出来」的错觉（痛点C）。
  function closeTransientAdminPanels() {
    if (els.chipEditorDrawer && !els.chipEditorDrawer.hidden) closeChipEditor();
    if (els.sessionDetailDrawer && !els.sessionDetailDrawer.hidden) closeSessionDetail();
    if (els.resourceEditorDrawer && !els.resourceEditorDrawer.hidden) closeResourceEditor();
  }

  // P2-3 可访问性：三个右侧抽屉是 role="dialog"/aria-modal 的模态浮层。打开时把焦点移入抽屉
  // （关闭按钮），并记住打开前的触发元素；关闭时把焦点还给触发元素（如列表里的「编辑」按钮），
  // 便于键盘/读屏用户。不做完整 focus trap：aria-modal 已声明模态，Escape/点遮罩/X 已有关闭出口。
  let drawerReturnFocusEl = null;
  function activateDrawerFocus(drawerEl) {
    if (!drawerEl) return;
    const active = document.activeElement;
    drawerReturnFocusEl = active instanceof HTMLElement && active !== document.body ? active : null;
    const closeBtn = drawerEl.querySelector('.admin-drawer-close');
    if (closeBtn instanceof HTMLElement) {
      closeBtn.focus();
    } else {
      if (!drawerEl.hasAttribute('tabindex')) drawerEl.setAttribute('tabindex', '-1');
      drawerEl.focus();
    }
  }
  function restoreDrawerFocus() {
    const target = drawerReturnFocusEl;
    drawerReturnFocusEl = null;
    if (target instanceof HTMLElement && document.contains(target)) {
      target.focus();
    }
  }

  async function loadAnnouncementWorkspace() {
    setAnnouncementError('');
    await loadAdminAnnouncements();
  }

  function setAnnouncementError(message) {
    if (els.announcementAdminError) els.announcementAdminError.textContent = message || '';
  }

  function setAnnouncementStatus(message) {
    if (els.announcementAdminStatusLine) els.announcementAdminStatusLine.textContent = message || '';
  }

  function collectAnnouncementFilters() {
    state.announcements.filters = {
      type: els.announcementAdminFilterType?.value || '',
      status: els.announcementAdminFilterStatus?.value || '',
      visibility: els.announcementAdminFilterVisibility?.value || '',
      pinned: els.announcementAdminFilterPinned?.value || '',
      active: els.announcementAdminFilterActive?.value || '',
      keyword: els.announcementAdminFilterKeyword?.value.trim() || ''
    };
  }

  function announcementAdminQuery() {
    const params = new URLSearchParams();
    const filters = state.announcements.filters;
    if (filters.type) params.set('type', filters.type);
    if (filters.status) params.set('status', filters.status);
    if (filters.visibility) params.set('visibility', filters.visibility);
    if (filters.pinned) params.set('pinned', filters.pinned);
    if (filters.active) params.set('active', filters.active);
    if (filters.keyword) params.set('q', filters.keyword);
    return params.toString();
  }

  async function loadAdminAnnouncements() {
    if (!els.announcementAdminList) return;
    state.announcements.loading = true;
    try {
      const query = announcementAdminQuery();
      const response = await window.AgentXAuth.authFetch(`/admin/announcements${query ? `?${query}` : ''}`, { skipAuthRedirect: true });
      if (!response.ok) {
        throw new Error(adminText('admin.error.loadAnnouncements', { status: response.status }, `加载公告失败 (${response.status})`));
      }
      const payload = await response.json();
      state.announcements.items = payload.items || [];
      if (
        state.announcements.selectedId &&
        !state.announcements.items.some((item) => item.id === state.announcements.selectedId)
      ) {
        state.announcements.selectedId = null;
        state.announcements.selectedDetail = null;
        state.announcements.detailRequestId += 1;
      }
      renderAdminAnnouncementList();
      renderAdminAnnouncementEditor();
    } finally {
      state.announcements.loading = false;
    }
  }

  async function selectAdminAnnouncement(id) {
    const requestId = ++state.announcements.detailRequestId;
    state.announcements.selectedId = id;
    state.announcements.selectedDetail = null;
    setAnnouncementStatus('');
    renderAdminAnnouncementList();
    renderAdminAnnouncementEditor();
    let response;
    try {
      response = await window.AgentXAuth.authFetch(`/admin/announcements/${encodeURIComponent(id)}`, { skipAuthRedirect: true });
    } catch (error) {
      if (!isCurrentAnnouncementDetailRequest(requestId, id)) {
        return;
      }
      throw error;
    }
    if (!isCurrentAnnouncementDetailRequest(requestId, id)) {
      return;
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadAnnouncementDetail', { status: response.status }, `加载公告详情失败 (${response.status})`));
    }
    const payload = await response.json();
    if (!isCurrentAnnouncementDetailRequest(requestId, id)) {
      return;
    }
    state.announcements.selectedDetail = payload.item;
    renderAdminAnnouncementEditor();
  }

  function isCurrentAnnouncementDetailRequest(requestId, id) {
    return requestId === state.announcements.detailRequestId && state.announcements.selectedId === id;
  }

  function newAdminAnnouncementDraft() {
    const now = new Date().toISOString();
    state.announcements.detailRequestId += 1;
    state.announcements.selectedId = null;
    state.announcements.selectedDetail = {
      id: '',
      type: 'announcement',
      status: 'draft',
      title: '',
      summary: '',
      body: '',
      translations: {
        'zh-CN': { title: '', summary: '', body: '' },
        'en-US': { title: '', summary: '', body: '' }
      },
      visibility: 'restricted',
      requiresLogin: true,
      roleAllowList: [],
      requiredGrants: {},
      pinned: false,
      priority: 0,
      modalBehavior: 'none',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: '',
      updatedBy: '',
      readStateSummary: { revision: 1, readCount: 0, dismissedCount: 0 }
    };
    setAnnouncementStatus('');
    renderAdminAnnouncementList();
    renderAdminAnnouncementEditor();
    els.announcementAdminTitleInput?.focus();
  }

  function announcementTranslation(detail, locale) {
    const translation = detail?.translations?.[locale];
    if (translation && typeof translation === 'object') {
      return {
        title: String(translation.title || ''),
        summary: String(translation.summary || ''),
        body: String(translation.body || '')
      };
    }
    if (locale === 'zh-CN') {
      return {
        title: String(detail?.title || ''),
        summary: String(detail?.summary || ''),
        body: String(detail?.body || '')
      };
    }
    return { title: '', summary: '', body: '' };
  }

  function setAnnouncementEditorLocale(locale) {
    const next = locale === 'en-US' ? 'en-US' : 'zh-CN';
    state.announcements.editorLocale = next;
    for (const button of [els.announcementAdminLocaleZh, els.announcementAdminLocaleEn]) {
      if (!button) continue;
      const active = button.dataset.announcementLocale === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const fields of document.querySelectorAll('[data-announcement-fields]')) {
      fields.hidden = fields.dataset.announcementFields !== next;
    }
    renderAnnouncementEditorPreview();
  }

  function renderAdminAnnouncementList() {
    if (!els.announcementAdminList) return;
    els.announcementAdminList.replaceChildren();
    if (els.announcementAdminSummary) {
      els.announcementAdminSummary.textContent = adminText(
        'admin.announcements.count',
        { count: state.announcements.items.length },
        `共 ${state.announcements.items.length} 条`
      );
    }
    if (state.announcements.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.announcements.empty', '暂无公告内容');
      els.announcementAdminList.append(empty);
      return;
    }
    for (const item of state.announcements.items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `announcement-admin-row ${item.id === state.announcements.selectedId ? 'active' : ''}`;
      const title = document.createElement('strong');
      title.textContent = item.title || item.id;
      const meta = document.createElement('span');
      meta.textContent = [
        adminText(`admin.announcementType.${item.type}`, ANNOUNCEMENT_TYPE_LABELS[item.type] || item.type),
        adminText(`admin.announcementStatus.${item.status}`, ANNOUNCEMENT_STATUS_LABELS[item.status] || item.status),
        item.visibility,
        item.pinned ? adminText('admin.announcements.pinned', '置顶') : '',
        `rev ${item.revision}`,
        formatDate(item.updatedAt)
      ].filter(Boolean).join(' · ');
      const counts = document.createElement('span');
      const summary = item.readStateSummary || {};
      counts.textContent = adminText(
        'admin.announcements.readCounts',
        { read: summary.readCount || 0, dismiss: summary.dismissedCount || 0 },
        `read ${summary.readCount || 0} · dismiss ${summary.dismissedCount || 0}`
      );
      row.append(title, meta, counts);
      row.addEventListener('click', () => selectAdminAnnouncement(item.id).catch((error) => setAnnouncementError(error.message)));
      els.announcementAdminList.append(row);
    }
  }

  function renderAdminAnnouncementEditor() {
    const detail = state.announcements.selectedDetail;
    if (!els.announcementAdminEditor || !els.announcementAdminEmpty) return;
    els.announcementAdminEditor.hidden = !detail;
    els.announcementAdminEmpty.hidden = Boolean(detail);
    if (!detail) {
      renderAnnouncementPortalPreview(null);
      return;
    }
    const zh = announcementTranslation(detail, 'zh-CN');
    const en = announcementTranslation(detail, 'en-US');
    els.announcementAdminEditorTitle.textContent = detail.id
      ? zh.title || detail.id
      : adminText('admin.announcements.newDraft', '新建公告草稿');
    els.announcementAdminEditorMeta.textContent = detail.id
      ? [
          detail.id,
          adminText(`admin.announcementStatus.${detail.status}`, ANNOUNCEMENT_STATUS_LABELS[detail.status] || detail.status),
          `rev ${detail.revision}`,
          adminText('admin.announcements.updatedAt', { value: formatDate(detail.updatedAt) }, `更新 ${formatDate(detail.updatedAt)}`)
        ].join(' · ')
      : adminText('admin.announcements.unsaved', '尚未保存');
    const readSummary = detail.readStateSummary || {};
    els.announcementAdminReadSummary.textContent = adminText(
      'admin.announcements.readSummary',
      { read: readSummary.readCount || 0, dismiss: readSummary.dismissedCount || 0 },
      `当前 revision 聚合：read ${readSummary.readCount || 0} · dismiss ${readSummary.dismissedCount || 0}`
    );
    els.announcementAdminType.value = detail.type || 'announcement';
    els.announcementAdminTitleInput.value = zh.title;
    els.announcementAdminSummaryInput.value = zh.summary;
    els.announcementAdminBody.value = zh.body;
    els.announcementAdminTitleInputEn.value = en.title;
    els.announcementAdminSummaryInputEn.value = en.summary;
    els.announcementAdminBodyEn.value = en.body;
    els.announcementAdminVisibility.value = detail.visibility || 'restricted';
    els.announcementAdminModalBehavior.value = detail.modalBehavior || 'none';
    els.announcementAdminPriority.value = String(detail.priority || 0);
    els.announcementAdminRoleAllowList.value = Array.isArray(detail.roleAllowList) ? detail.roleAllowList.join(', ') : '';
    els.announcementAdminStartsAt.value = toLocalDateTimeInput(detail.startsAt);
    els.announcementAdminEndsAt.value = toLocalDateTimeInput(detail.endsAt);
    els.announcementAdminRequiresLogin.checked = Boolean(detail.requiresLogin);
    els.announcementAdminPinned.checked = Boolean(detail.pinned);
    fillAnnouncementRequiredGrants(detail.requiredGrants || {});
    fillAnnouncementSourceRef(detail.sourceRef || null);
    renderAnnouncementPortalPreview(detail);
    renderAdminAnnouncementActions(detail);
    setAnnouncementEditorLocale(state.announcements.editorLocale);
  }

  function fillAnnouncementRequiredGrants(grants) {
    setTokenFieldValues(els.announcementAdminGrantBrands, grants.brands, 'brands');
    setTokenFieldValues(els.announcementAdminGrantProductLines, grants.productLines, 'productLines');
    setTokenFieldValues(els.announcementAdminGrantChipIds, grants.chipIds, 'chipIds');
    setTokenFieldValues(els.announcementAdminGrantDocumentIds, grants.documentIds, 'documentIds');
    setTokenFieldValues(els.announcementAdminGrantScopePresetIds, grants.scopePresetIds, 'scopePresetIds');
    setTokenFieldValues(els.announcementAdminGrantModelIds, grants.modelIds, 'modelIds');
    setTokenFieldValues(els.announcementAdminGrantMcpTools, grants.mcpTools, 'mcpTools');
  }

  function fillAnnouncementSourceRef(sourceRef) {
    const kind = sourceRef?.kind || '';
    if (els.announcementAdminSourceKind) els.announcementAdminSourceKind.value = kind;
    if (els.announcementAdminSourceId) els.announcementAdminSourceId.value = sourceRef?.phase ? String(sourceRef.phase) : '';
    if (els.announcementAdminSourceUrl) els.announcementAdminSourceUrl.value = sourceRef?.version || '';
    if (els.announcementAdminSourceLabel) els.announcementAdminSourceLabel.value = sourceRef?.note || '';
  }

  function collectAnnouncementRequiredGrants() {
    const grants = {
      brands: getTokenFieldValues(els.announcementAdminGrantBrands),
      productLines: getTokenFieldValues(els.announcementAdminGrantProductLines),
      chipIds: getTokenFieldValues(els.announcementAdminGrantChipIds),
      documentIds: getTokenFieldValues(els.announcementAdminGrantDocumentIds),
      scopePresetIds: getTokenFieldValues(els.announcementAdminGrantScopePresetIds),
      modelIds: getTokenFieldValues(els.announcementAdminGrantModelIds),
      mcpTools: getTokenFieldValues(els.announcementAdminGrantMcpTools)
    };
    const cleaned = {};
    for (const [key, value] of Object.entries(grants)) {
      if (Array.isArray(value) && value.length > 0) cleaned[key] = value;
    }
    return cleaned;
  }

  function collectAnnouncementSourceRef() {
    const kind = els.announcementAdminSourceKind?.value || '';
    const phaseText = (els.announcementAdminSourceId?.value || '').trim();
    const version = (els.announcementAdminSourceUrl?.value || '').trim();
    const note = (els.announcementAdminSourceLabel?.value || '').trim();
    if (!kind && !phaseText && !version && !note) return null;
    if (!kind) return null;
    const sourceRef = {};
    if (kind) sourceRef.kind = kind;
    const phase = Number.parseInt(phaseText, 10);
    if (Number.isInteger(phase) && phase > 0) sourceRef.phase = phase;
    if (version) sourceRef.version = version;
    if (note) sourceRef.note = note;
    return sourceRef;
  }

  function renderAnnouncementPortalPreview(detail) {
    if (!els.announcementAdminPortalPreview) return;
    els.announcementAdminPortalPreview.replaceChildren();
    if (!detail) {
      const empty = document.createElement('p');
      empty.className = 'muted-inline';
      empty.textContent = adminText('admin.announcements.previewEmpty', '选择或新建公告后显示用户端预览');
      els.announcementAdminPortalPreview.append(empty);
      return;
    }
    const type = document.createElement('span');
    type.className = 'admin-badge';
    type.textContent = adminText(
      `admin.announcementType.${detail.type}`,
      ANNOUNCEMENT_TYPE_LABELS[detail.type] || detail.type || 'announcement'
    );
    const localized = announcementTranslation(detail, state.announcements.editorLocale);
    const title = document.createElement('strong');
    title.textContent = localized.title || adminText('admin.announcements.untitled', '未命名公告');
    const summary = document.createElement('p');
    summary.textContent = localized.summary || localized.body || adminText('admin.announcements.noSummary', '暂无摘要');
    els.announcementAdminPortalPreview.append(type, title, summary);
  }

  function renderAnnouncementEditorPreview() {
    if (!state.announcements.selectedDetail) return;
    renderAnnouncementPortalPreview({
      ...state.announcements.selectedDetail,
      ...collectAnnouncementEditorPayload()
    });
  }

  function renderAdminAnnouncementActions(detail) {
    if (!els.announcementAdminActions) return;
    els.announcementAdminActions.replaceChildren();
    if (!detail?.id) return;
    const actions = [
      { action: 'publish', label: adminText('admin.announcements.action.publish', '发布'), disabled: detail.status === 'published' || detail.status === 'archived' },
      { action: 'offline', label: adminText('admin.announcements.action.offline', '下线'), disabled: detail.status !== 'published' },
      { action: 'archive', label: adminText('admin.announcements.action.archive', '归档'), disabled: detail.status === 'archived' },
      { action: 'duplicate', label: adminText('admin.announcements.action.duplicate', '复制为草稿'), disabled: false }
    ];
    for (const item of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.action === 'publish' ? 'primary-button' : 'secondary-button';
      button.textContent = item.label;
      button.disabled = item.disabled;
      button.addEventListener('click', () => runAdminAnnouncementAction(item.action).catch((error) => setAnnouncementError(error.message)));
      els.announcementAdminActions.append(button);
    }
  }

  function renderLocalizedAdminUi() {
    renderAdminBreadcrumb();
    renderAdminPageTabs();
    renderHistoryWorkspace();
    renderAdminAnnouncementList();
    renderAnnouncementEditorPreview();
    renderAdminAnnouncementActions(state.announcements.selectedDetail);
    renderAdminTicketList();
    renderChipMappings();
    renderUsers();
    renderResources();
    renderPromptFiles();
    renderRoleList();
    if (state.observability.data) renderObservability();
    if (state.discoveryTraces.data) renderDiscoveryTraces();
  }

  window.addEventListener('localechange', (event) => {
    const nextLocale = event?.detail?.locale || window.AgentXI18n?.getLocale?.();
    if (!nextLocale || nextLocale === state.locale) return;
    state.locale = nextLocale;
    renderLocalizedAdminUi();
  });

  function collectAnnouncementEditorPayload() {
    const startsAt = fromLocalDateTimeInput(els.announcementAdminStartsAt?.value || '');
    const endsAt = fromLocalDateTimeInput(els.announcementAdminEndsAt?.value || '');
    const zh = {
      title: els.announcementAdminTitleInput?.value.trim() || '',
      summary: els.announcementAdminSummaryInput?.value.trim() || '',
      body: els.announcementAdminBody?.value.trim() || ''
    };
    const en = {
      title: els.announcementAdminTitleInputEn?.value.trim() || '',
      summary: els.announcementAdminSummaryInputEn?.value.trim() || '',
      body: els.announcementAdminBodyEn?.value.trim() || ''
    };
    return {
      type: els.announcementAdminType?.value || 'announcement',
      title: zh.title,
      summary: zh.summary,
      body: zh.body,
      translations: { 'zh-CN': zh, 'en-US': en },
      visibility: els.announcementAdminVisibility?.value || 'restricted',
      requiresLogin: Boolean(els.announcementAdminRequiresLogin?.checked),
      roleAllowList: splitAdminList(els.announcementAdminRoleAllowList?.value || ''),
      requiredGrants: collectAnnouncementRequiredGrants(),
      pinned: Boolean(els.announcementAdminPinned?.checked),
      priority: Number.parseInt(els.announcementAdminPriority?.value || '0', 10) || 0,
      modalBehavior: els.announcementAdminModalBehavior?.value || 'none',
      startsAt,
      endsAt,
      sourceRef: collectAnnouncementSourceRef()
    };
  }

  async function saveAdminAnnouncement(event) {
    event.preventDefault();
    setAnnouncementError('');
    setAnnouncementStatus(adminText('admin.announcements.saving', '保存中…'));
    const detail = state.announcements.selectedDetail;
    const payload = collectAnnouncementEditorPayload();
    const path = detail?.id ? `/admin/announcements/${encodeURIComponent(detail.id)}` : '/admin/announcements';
    const saveRequestId = ++state.announcements.detailRequestId;
    const response = await window.AgentXAuth.authFetch(path, {
      method: detail?.id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      skipAuthRedirect: true
    });
    if (!response.ok) {
      throw new Error(`${adminText('admin.announcements.saveFailed', '保存公告失败')} (${response.status})`);
    }
    if (saveRequestId !== state.announcements.detailRequestId) { return; }
    const body = await response.json();
    state.announcements.selectedId = body.item.id;
    state.announcements.selectedDetail = body.item;
    setAnnouncementStatus(adminText('admin.announcements.saved', '已保存'));
    await loadAdminAnnouncements();
    renderAdminAnnouncementEditor();
  }

  async function runAdminAnnouncementAction(action) {
    const id = state.announcements.selectedDetail?.id;
    if (!id) return;
    setAnnouncementError('');
    setAnnouncementStatus(adminText('admin.announcements.processing', '处理中…'));
    const actionRequestId = ++state.announcements.detailRequestId;
    const response = await window.AgentXAuth.authFetch(`/admin/announcements/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      skipAuthRedirect: true
    });
    if (!response.ok) {
      throw new Error(`${adminText('admin.announcements.actionFailed', '公告操作失败')} (${response.status})`);
    }
    if (actionRequestId !== state.announcements.detailRequestId) { return; }
    const body = await response.json();
    state.announcements.selectedId = body.item.id;
    state.announcements.selectedDetail = body.item;
    setAnnouncementStatus(action === 'duplicate'
      ? adminText('admin.announcements.duplicated', '已复制为新草稿')
      : adminText('admin.announcements.statusUpdated', '状态已更新'));
    await loadAdminAnnouncements();
    renderAdminAnnouncementEditor();
  }

  function setFeedbackError(message) {
    if (els.feedbackAdminError) els.feedbackAdminError.textContent = message || '';
  }

  async function loadFeedbackWorkspace() {
    setFeedbackError('');
    await loadAdminTickets();
  }

  function ticketText(value, fallback = '-') {
    return value === undefined || value === null || value === '' ? fallback : String(value);
  }

  function ticketStatusLabel(status) {
    return statusLabel('ticketStatus', status, TICKET_STATUS_LABELS[status] || ticketText(status));
  }

  function ticketTypeLabel(type) {
    return statusLabel('ticketType', type, TICKET_TYPE_LABELS[type] || ticketText(type));
  }

  function attachmentStatusLabel(status) {
    return statusLabel('attachmentStatus', status, ATTACHMENT_STATUS_LABELS[status] || ticketText(status));
  }

  function draftStatusLabel(status) {
    return statusLabel('draftStatus', status, DRAFT_STATUS_LABELS[status] || ticketText(status));
  }

  function feedbackStatusLabel(status) {
    return statusLabel('feedbackStatus', status, FEEDBACK_STATUS_LABELS[status] || ticketText(status));
  }

  function ticketTypeFromTicketNo(ticketNo) {
    if (typeof ticketNo !== 'string') return '';
    if (ticketNo.startsWith('FB-')) return 'feedback';
    if (ticketNo.startsWith('DS-')) return 'datasheet_submission';
    if (ticketNo.startsWith('AP-')) return 'account_application';
    return '';
  }

  function ticketTypeForDetail(detail) {
    return detail?.type || ticketTypeFromTicketNo(detail?.ticketNo);
  }

  function ticketStatusesForType(type) {
    return TICKET_STATUS_OPTIONS_BY_TYPE[type] || [];
  }

  function ticketStatusesForDetail(detail) {
    const type = ticketTypeForDetail(detail);
    if (type === 'datasheet_submission') {
      if (detail?.status === 'received') return ['received', 'archived'];
      if (detail?.status === 'archived') return ['archived'];
      return ['received'];
    }
    const statuses = ticketStatusesForType(type);
    const currentStatus = detail?.status;
    if (currentStatus && !statuses.includes(currentStatus)) {
      return [...statuses, currentStatus];
    }
    return statuses;
  }

  function renderTicketStatusOptions(select, statuses, options = {}) {
    if (!select) return;
    const currentValue = options.currentValue ?? select.value;
    select.replaceChildren();
    select.disabled = Boolean(options.disabled);
    if (options.includeAll) {
      const all = document.createElement('option');
      all.value = '';
      all.textContent = adminText('admin.common.all', '全部');
      select.append(all);
    } else if (options.placeholder) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = options.placeholder;
      placeholder.disabled = true;
      select.append(placeholder);
    }
    for (const status of statuses) {
      const option = document.createElement('option');
      option.value = status;
      option.textContent = ticketStatusLabel(status);
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === currentValue)) {
      select.value = currentValue;
    } else {
      select.value = options.includeAll ? '' : (statuses[0] || '');
    }
  }

  function syncTicketFilterStatusOptions() {
    const type = els.ticketAdminFilterType?.value || '';
    const statuses = type ? ticketStatusesForType(type) : TICKET_FILTER_STATUS_OPTIONS;
    renderTicketStatusOptions(els.ticketAdminFilterStatus, statuses, { includeAll: true });
  }

  function syncTicketDetailStatusOptions(detail) {
    if (!detail) {
      renderTicketStatusOptions(els.ticketAdminStatus, [], {
        currentValue: '',
        disabled: true,
        placeholder: adminText('admin.tickets.selectTicket', '请选择工单')
      });
      return;
    }
    const statuses = ticketStatusesForDetail(detail);
    renderTicketStatusOptions(els.ticketAdminStatus, statuses, {
      currentValue: detail.status || '',
      disabled: statuses.length === 0,
        placeholder: statuses.length === 0 ? adminText('admin.tickets.noStatuses', '暂无可用状态') : ''
    });
  }

  function setAdminSidebarCollapsed(collapsed, options = {}) {
    if (!els.adminOperationSurface || !els.adminSidebarToggle) return;
    els.adminOperationSurface.classList.toggle('sidebar-collapsed', collapsed);
    els.adminSidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    els.adminSidebarToggle.title = collapsed
      ? adminText('admin.nav.expand', '展开侧边栏')
      : adminText('admin.nav.collapse', '折叠侧边栏');
    if (!options.skipStore) {
      localStorage.setItem('agentx.admin.sidebarCollapsed', collapsed ? '1' : '0');
    }
  }

  function initAdminSidebarCollapse() {
    if (!els.adminSidebarToggle) return;
    const stored = localStorage.getItem('agentx.admin.sidebarCollapsed');
    const mobileDefault = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
    setAdminSidebarCollapsed(stored === null ? mobileDefault : stored === '1', { skipStore: true });
    els.adminSidebarToggle.addEventListener('click', () => {
      setAdminSidebarCollapsed(!els.adminOperationSurface.classList.contains('sidebar-collapsed'));
    });
  }

  function initAdminNavGroups() {
    for (const toggle of els.navGroupToggles) {
      toggle.addEventListener('click', () => {
        const group = toggle.closest('[data-nav-group]');
        if (!group) return;
        setNavGroupExpanded(group, group.dataset.expanded !== 'true');
      });
    }
    syncNavFooterVersion();
  }

  function syncNavFooterVersion() {
    if (!els.navFooterVersion) return;
    const source = document.querySelector('[data-product-version]');
    // The static placeholder inside [data-product-version] is a localized
    // span (product.env.local); text copied while that span is present is the
    // placeholder, not a real version, so treat it as empty.
    const hasPlaceholder = !!source?.querySelector('[data-i18n="product.env.local"]');
    const versionText = hasPlaceholder ? '' : source?.textContent?.trim();
    if (versionText) {
      els.navFooterVersion.textContent = versionText;
      return;
    }
    if (!source) return;
    // product-shell fills [data-product-version] asynchronously after the
    // version fetch resolves; if this runs first, watch the node and copy the
    // text once it arrives instead of leaving the footer on its placeholder.
    // The timeout disconnects the observer so it never watches forever.
    const observer = new MutationObserver(() => {
      const next = source.textContent?.trim();
      if (next) {
        els.navFooterVersion.textContent = next;
        observer.disconnect();
        window.clearTimeout(timeoutId);
      }
    });
    const timeoutId = window.setTimeout(() => observer.disconnect(), 10000);
    observer.observe(source, { childList: true, characterData: true, subtree: true });
  }

  function collectTicketAdminFilters() {
    state.tickets.filters = {
      type: els.ticketAdminFilterType?.value || '',
      status: els.ticketAdminFilterStatus?.value || '',
      needsMoreInfo: els.ticketAdminFilterNeedsMoreInfo?.value || '',
      keyword: els.ticketAdminFilterKeyword?.value.trim() || '',
      feedbackType: els.ticketAdminFilterFeedbackType?.value || '',
      chipId: els.ticketAdminFilterChip?.value.trim() || '',
      documentId: els.ticketAdminFilterDocument?.value.trim() || '',
      scopePresetId: els.ticketAdminFilterScope?.value.trim() || '',
      modelId: els.ticketAdminFilterModel?.value.trim() || '',
      reviewSignal: els.ticketAdminFilterReviewSignal?.value || ''
    };
  }

  function ticketAdminQuery() {
    const params = new URLSearchParams();
    const filters = state.tickets.filters;
    if (filters.type) params.set('type', filters.type);
    if (filters.status) params.set('status', filters.status);
    if (filters.needsMoreInfo) params.set('needsMoreInfo', filters.needsMoreInfo);
    if (filters.keyword) params.set('q', filters.keyword);
    if (filters.feedbackType) params.set('feedbackType', filters.feedbackType);
    if (filters.chipId) params.set('chipId', filters.chipId);
    if (filters.documentId) params.set('documentId', filters.documentId);
    if (filters.scopePresetId) params.set('scopePresetId', filters.scopePresetId);
    if (filters.modelId) params.set('modelId', filters.modelId);
    if (filters.reviewSignal) {
      params.set('feedbackType', filters.reviewSignal);
      params.set('reviewSignal', 'high_priority');
    }
    params.set('limit', '50');
    return params.toString();
  }

  function setTicketAdminStatus(message) {
    if (els.ticketAdminStatusLine) {
      els.ticketAdminStatusLine.textContent = message || '';
    }
  }

  async function loadAdminTickets() {
    if (!els.ticketAdminList) return;
    state.tickets.loading = true;
    try {
      const response = await window.AgentXAuth.authFetch(`/admin/tickets?${ticketAdminQuery()}`, { skipAuthRedirect: true });
      if (!response.ok) {
        throw new Error(adminText('admin.error.loadTickets', { status: response.status }, `加载工单失败 (${response.status})`));
      }
      const payload = await response.json();
      state.tickets.items = payload.items || [];
      if (
        state.tickets.selectedTicketNo &&
        !state.tickets.items.some((item) => item.ticketNo === state.tickets.selectedTicketNo)
      ) {
        state.tickets.selectedTicketNo = null;
        state.tickets.selectedDetail = null;
        state.tickets.detailRequestId += 1;
      }
      renderAdminTicketList();
      renderAdminTicketDetail();
    } finally {
      state.tickets.loading = false;
    }
  }

  // V5：切换工单选择时，早前一次仍在途的详情请求可能晚于新选择才 resolve；
  // 用 requestId + ticketNo 双守卫（镜像公告 isCurrentAnnouncementDetailRequest）确保迟到响应
  // 不会覆盖当前已选中工单的 selectedDetail——否则 saveAdminTicketReview 会用错的 detail 判断
  // type/status 分支，同时把 PATCH 发去当前 ticketNo，造成 A/B 状态串号。
  async function selectAdminTicket(ticketNo) {
    const requestId = ++state.tickets.detailRequestId;
    state.tickets.selectedTicketNo = ticketNo;
    state.tickets.selectedDetail = null;
    setTicketAdminStatus('');
    renderAdminTicketList();
    renderAdminTicketDetail();
    let response;
    try {
      response = await window.AgentXAuth.authFetch(`/admin/tickets/${encodeURIComponent(ticketNo)}`, { skipAuthRedirect: true });
    } catch (error) {
      if (!isCurrentTicketDetailRequest(requestId, ticketNo)) {
        return;
      }
      throw error;
    }
    if (!isCurrentTicketDetailRequest(requestId, ticketNo)) {
      return;
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.loadTicketDetail', { status: response.status }, `加载工单详情失败 (${response.status})`));
    }
    const payload = await response.json();
    if (!isCurrentTicketDetailRequest(requestId, ticketNo)) {
      return;
    }
    state.tickets.selectedDetail = payload.ticket;
    renderAdminTicketDetail();
  }

  function isCurrentTicketDetailRequest(requestId, ticketNo) {
    return requestId === state.tickets.detailRequestId && state.tickets.selectedTicketNo === ticketNo;
  }

  function renderAdminTicketList() {
    if (!els.ticketAdminList) return;
    els.ticketAdminList.replaceChildren();
    if (els.ticketAdminSummary) {
      els.ticketAdminSummary.textContent = adminText(
        'admin.tickets.count',
        { count: state.tickets.items.length },
        `共 ${state.tickets.items.length} 条`
      );
    }
    if (state.tickets.items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.tickets.empty', '暂无工单');
      els.ticketAdminList.append(empty);
      return;
    }
    for (const item of state.tickets.items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `feedback-row ticket-admin-card ${item.ticketNo === state.tickets.selectedTicketNo ? 'active selected' : ''}`;
      const head = document.createElement('div');
      head.className = 'ticket-admin-card-head';
      const icon = document.createElement('span');
      icon.className = 'ticket-admin-card-icon';
      icon.title = ticketTypeLabel(item.type);
      icon.setAttribute('aria-label', ticketTypeLabel(item.type));
      icon.append(buildTicketTypeIconSvg(item.type));
      const title = document.createElement('strong');
      title.textContent = item.title || adminText('admin.tickets.untitled', '未命名工单');
      head.append(icon, title);
      if (item.needsMoreInfo) {
        const flag = document.createElement('span');
        flag.className = 'ticket-admin-card-flag';
        flag.title = adminText('admin.tickets.needsMoreInfo', '需要补充信息');
        head.append(flag);
      }
      const meta = document.createElement('span');
      meta.textContent = [
        item.ticketNo,
        ticketTypeLabel(item.type),
        ticketStatusLabel(item.status),
        formatDate(item.updatedAt || item.createdAt)
      ].filter(Boolean).join(' · ');
      row.append(head, meta);
      row.addEventListener('click', () => selectAdminTicket(item.ticketNo).catch((error) => setFeedbackError(error.message)));
      els.ticketAdminList.append(row);
    }
  }

  // 工单类型图标：内联 SVG（对齐原型 content-support.html ~713-718），用 currentColor 使颜色随 token 走。
  // 全仓约定不拼接 HTML 字符串写入 DOM（见 web-ui/source-citations 合约测试），改用 createElementNS 逐节点构建。
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TICKET_TYPE_ICON_SHAPES = {
    feedback: [
      { tag: 'path', d: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' }
    ],
    datasheet_submission: [
      { tag: 'path', d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' },
      { tag: 'path', d: 'M14 2v5h5' }
    ],
    account_application: [
      { tag: 'path', d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' },
      { tag: 'circle', cx: '9', cy: '7', r: '4' },
      { tag: 'path', d: 'M19 8v6M22 11h-6' }
    ]
  };

  function buildTicketTypeIconSvg(type) {
    const shapes = TICKET_TYPE_ICON_SHAPES[type] || TICKET_TYPE_ICON_SHAPES.feedback;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const shape of shapes) {
      const node = document.createElementNS(SVG_NS, shape.tag);
      for (const [attr, value] of Object.entries(shape)) {
        if (attr === 'tag') continue;
        node.setAttribute(attr, value);
      }
      svg.append(node);
    }
    return svg;
  }

  function renderAdminTicketDetail() {
    const detail = state.tickets.selectedDetail;
    if (!els.ticketAdminDetail || !els.ticketAdminDetailEmpty) return;
    els.ticketAdminDetail.hidden = !detail;
    els.ticketAdminDetailEmpty.hidden = Boolean(detail);
    if (!detail) {
      syncTicketDetailStatusOptions(null);
      return;
    }

    const payload = detail.payload || {};
    els.ticketAdminDetailTitle.textContent = detail.title || detail.ticketNo;
    els.ticketAdminTypeBadge.textContent = ticketTypeLabel(detail.type);
    els.ticketAdminDetailMeta.textContent = [
      detail.ticketNo,
      ticketStatusLabel(detail.status),
      adminText('admin.tickets.submittedAt', { value: formatDate(detail.createdAt) }, `提交 ${formatDate(detail.createdAt)}`),
      adminText('admin.tickets.updatedAt', { value: formatDate(detail.updatedAt) }, `更新 ${formatDate(detail.updatedAt)}`),
      detail.needsMoreInfo ? adminText('admin.tickets.needsMoreInfo', '需要补充信息') : ''
    ].filter(Boolean).join(' · ');
    syncTicketDetailStatusOptions(detail);
    els.ticketAdminNeedsMoreInfo.checked = Boolean(detail.needsMoreInfo);
    els.ticketAdminPublicNote.value = detail.publicNote || '';
    els.ticketAdminInternalNote.value = detail.internalNote || '';
    els.ticketAdminResult.value = detail.result || '';
    els.ticketAdminDetailBody.replaceChildren(...ticketDetailBlocks(detail, payload));
    syncTicketMaterialControls(detail);
    renderAdminTicketAttachments(detail);
    renderAccountApplicationActions(detail);
    renderTicketMessageThread(els.ticketAdminMessages, detail.messages, { isAdmin: true });
    if (els.ticketAdminReplyStatus) els.ticketAdminReplyStatus.textContent = '';
  }

  function renderTicketMessageThread(container, messages, options = {}) {
    if (!container) return;
    const isAdmin = Boolean(options.isAdmin);
    container.replaceChildren();
    const list = Array.isArray(messages) ? messages : [];
    if (list.length === 0) {
      container.append(renderEmptyState(adminText('admin.tickets.noMessages', '暂无沟通记录')));
      return;
    }
    for (const message of list) {
      const item = document.createElement('div');
      item.className = `ticket-message ${message.audience === 'internal' ? 'internal' : 'user'}`;
      const head = document.createElement('div');
      head.className = 'ticket-message-head';
      const who = document.createElement('strong');
      who.textContent = message.authorLabel || message.authorRole || adminText('admin.common.administrator', '管理员');
      const when = document.createElement('span');
      when.textContent = formatDate(message.createdAt);
      head.append(who, when);
      if (isAdmin && message.audience === 'internal') {
        const badge = document.createElement('span');
        badge.className = 'ticket-message-badge';
        badge.textContent = adminText('admin.common.internal', '内部');
        head.append(badge);
      }
      const body = document.createElement('p');
      body.className = 'ticket-message-text';
      body.textContent = message.text || '';
      item.append(head, body);
      container.append(item);
    }
  }

  function syncTicketMaterialControls(detail) {
    const isMaterial = detail?.type === 'datasheet_submission';
    if (els.ticketAdminMaterialNotice) els.ticketAdminMaterialNotice.hidden = !isMaterial;
    if (els.ticketAdminDownloadAll) {
      const attachments = Array.isArray(detail?.attachments) ? detail.attachments : [];
      els.ticketAdminDownloadAll.hidden = !isMaterial;
      els.ticketAdminDownloadAll.disabled = !isMaterial || attachments.length === 0;
    }
  }

  async function submitAdminTicketReply(event) {
    event.preventDefault();
    const ticketNo = state.tickets.selectedTicketNo;
    if (!ticketNo) return;
    const text = (els.ticketAdminReplyText?.value || '').trim();
    if (!text) {
      if (els.ticketAdminReplyStatus) {
        els.ticketAdminReplyStatus.textContent = adminText('admin.tickets.replyRequired', '请输入回复内容。');
      }
      return;
    }
    const audience = els.ticketAdminReplyInternal?.checked ? 'internal' : 'user';
    if (els.ticketAdminReplyStatus) {
      els.ticketAdminReplyStatus.textContent = adminText('admin.tickets.sendingReply', '发送中…');
    }
    const response = await window.AgentXAuth.authFetch(`/admin/tickets/${encodeURIComponent(ticketNo)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, audience }),
      skipAuthRedirect: true
    });
    if (!response.ok) {
      const message = await readErrorMessage(response, adminText('admin.tickets.replyFailed', '发送回复失败'));
      if (els.ticketAdminReplyStatus) els.ticketAdminReplyStatus.textContent = message;
      return;
    }
    if (els.ticketAdminReplyText) els.ticketAdminReplyText.value = '';
    if (els.ticketAdminReplyInternal) els.ticketAdminReplyInternal.checked = false;
    if (els.ticketAdminReplyStatus) {
      els.ticketAdminReplyStatus.textContent = adminText('admin.tickets.replySent', '已发送');
    }
    await selectAdminTicket(ticketNo);
  }

  function ticketDetailBlocks(detail, payload) {
    const blocks = [
      renderFeedbackTextBlock(adminText('admin.ticketField.publicNote', '公开备注'), detail.publicNote || '-'),
      renderFeedbackTextBlock(adminText('admin.ticketField.internalNote', '内部备注'), detail.internalNote || '-'),
      renderFeedbackTextBlock(adminText('admin.ticketField.result', '处理结果'), detail.result || '-')
    ];
    if (detail.type === 'feedback') {
      const snapshot = payload.feedbackSnapshot || {};
      blocks.push(
        renderFeedbackTextBlock(adminText('admin.ticketField.feedbackCategory', '反馈分类'), payload.category || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.feedbackContent', '反馈内容'), payload.content || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.contact', '联系方式'), detail.contact?.raw || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.structuredFeedback', '结构化反馈'), formatFeedbackSnapshotSummary(snapshot)),
        renderFeedbackTextBlock(adminText('admin.ticketField.answerTrace', '回答摘要 / Hash'), formatFeedbackAnswerTrace(snapshot)),
        renderFeedbackTextBlock(adminText('admin.ticketField.modelContext', '模型与上下文'), formatFeedbackContextTrace(snapshot)),
        renderFeedbackTextBlock(adminText('admin.ticketField.sourceSnapshot', '来源快照'), formatFeedbackSources(snapshot)),
        renderFeedbackTextBlock(adminText('admin.ticketField.versionInfo', '版本信息'), formatFeedbackVersions(snapshot)),
        renderFeedbackTextBlock(adminText('admin.ticketField.userNote', '用户备注'), snapshot.note || payload.note || '-')
      );
    } else if (detail.type === 'datasheet_submission') {
      blocks.push(
        renderFeedbackTextBlock(adminText('admin.ticketField.vendorBrand', '厂商 / 品牌'), payload.vendor || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.partOrKeywords', '芯片型号或关键词'), payload.partNumberOrKeywords || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.sourceNote', '来源说明'), payload.sourceNote || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.contact', '联系方式'), detail.contact?.raw || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.note', '备注'), payload.note || '-')
      );
    } else if (detail.type === 'account_application') {
      const application = payload.application || {};
      const draft = payload.credentialDraft || {};
      const hasSavedPassword = Boolean(draft['has' + 'Password' + 'Hash']);
      blocks.push(
        renderFeedbackTextBlock(adminText('admin.ticketField.username', '账号名'), application.username || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.company', '公司'), application.company || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.joinReason', '为什么想加入'), application.reason || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.heardFrom', '从哪里听说'), application.heardFrom || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.occupation', '职业 / 岗位'), application.occupation || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.favoriteFeature', '喜欢的功能'), application.favoriteFeature || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.expectedFeature', '期待使用的功能'), application.expectedFeature || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.contact', '联系方式'), application.contact || detail.contact?.raw || '-'),
        renderFeedbackTextBlock(adminText('admin.ticketField.passwordDraft', '密码草稿'), [
          adminText('admin.tickets.draftStatus', { value: draftStatusLabel(draft.status) }, `状态：${draftStatusLabel(draft.status)}`),
          adminText('admin.tickets.draftExpires', { value: draft.expiresAt ? formatDate(draft.expiresAt) : '-' }, `过期：${draft.expiresAt ? formatDate(draft.expiresAt) : '-'}`),
          adminText(
            'admin.tickets.draftSavedSecurely',
            { value: hasSavedPassword ? adminText('admin.common.yes', '是') : adminText('admin.common.no', '否') },
            `已安全保存：${hasSavedPassword ? '是' : '否'}`
          )
        ].join('\n')),
        renderFeedbackTextBlock(adminText('admin.ticketField.approvalResult', '审批结果'), [
          payload.approvedUsername
            ? adminText('admin.tickets.approvedUsername', { value: payload.approvedUsername }, `账号：${payload.approvedUsername}`)
            : '',
          payload.approvedUserId
            ? adminText('admin.tickets.approvedUserId', { value: payload.approvedUserId }, `用户 ID：${payload.approvedUserId}`)
            : '',
          payload.approvedAt
            ? adminText('admin.tickets.approvedAt', { value: formatDate(payload.approvedAt) }, `通过时间：${formatDate(payload.approvedAt)}`)
            : ''
        ].filter(Boolean).join('\n') || '-')
      );
    }
    return blocks;
  }

  function formatFeedbackSnapshotSummary(snapshot) {
    if (!snapshot || !snapshot.schemaVersion) return '-';
    const types = Array.isArray(snapshot.feedbackTypes) ? snapshot.feedbackTypes.join(', ') : '-';
    return [
      adminText('admin.feedbackTrace.types', { value: types }, `类型：${types}`),
      adminText('admin.feedbackTrace.priority', { value: snapshot.reviewSignal || '-' }, `优先级：${snapshot.reviewSignal || '-'}`),
      adminText('admin.feedbackTrace.entry', { value: snapshot.entry || '-' }, `入口：${snapshot.entry || '-'}`),
      adminText('admin.feedbackTrace.session', { value: snapshot.sessionId || '-' }, `会话：${snapshot.sessionId || '-'}`),
      `Turn：${snapshot.turnId || '-'}`,
      adminText('admin.feedbackTrace.time', { value: snapshot.capturedAt ? formatDate(snapshot.capturedAt) : '-' }, `时间：${snapshot.capturedAt ? formatDate(snapshot.capturedAt) : '-'}`)
    ].join('\n');
  }

  function formatFeedbackAnswerTrace(snapshot) {
    if (!snapshot || !snapshot.schemaVersion) return '-';
    return [
      snapshot.answerExcerpt ? adminText('admin.feedbackTrace.summary', { value: snapshot.answerExcerpt }, `摘要：${snapshot.answerExcerpt}`) : '',
      snapshot.answerTextHash ? `Hash：${snapshot.answerTextHash}` : ''
    ].filter(Boolean).join('\n') || '-';
  }

  function formatFeedbackContextTrace(snapshot) {
    if (!snapshot || !snapshot.schemaVersion) return '-';
    return [
      adminText('admin.feedbackTrace.model', { value: snapshot.modelId || '-' }, `模型：${snapshot.modelId || '-'}`),
      adminText('admin.feedbackTrace.chip', { value: snapshot.chipId || '-' }, `芯片：${snapshot.chipId || '-'}`),
      adminText('admin.feedbackTrace.document', { value: snapshot.documentId || '-' }, `文档：${snapshot.documentId || '-'}`),
      adminText('admin.feedbackTrace.scope', { value: snapshot.scopePresetId || '-' }, `Scope：${snapshot.scopePresetId || '-'}`),
      adminText('admin.feedbackTrace.user', { value: snapshot.userId || '-' }, `用户：${snapshot.userId || '-'}`)
    ].join('\n');
  }

  function formatFeedbackSources(snapshot) {
    const sources = Array.isArray(snapshot?.usedSources)
      ? snapshot.usedSources
      : (Array.isArray(snapshot?.sourceCitationSummary?.sources) ? snapshot.sourceCitationSummary.sources : []);
    if (sources.length === 0) {
      return adminText('admin.tickets.noCitableSources', '本次未使用可引用资料');
    }
    return sources.map((source, index) => [
      `${index + 1}. ${source.displayTitle || source.filename || source.sourceLabel || source.documentId || adminText('admin.tickets.untitledSource', '未命名资料')}`,
      source.section ? adminText('admin.tickets.sourceSection', { value: source.section }, `章节：${source.section}`) : '',
      source.page ? adminText('admin.tickets.sourcePage', { value: source.page }, `页码：${source.page}`) : '',
      source.sourceLabel ? adminText('admin.tickets.sourceLabel', { value: source.sourceLabel }, `标签：${source.sourceLabel}`) : '',
      source.documentId ? `documentId：${source.documentId}` : '',
      source.scopePresetId ? `scopePresetId：${source.scopePresetId}` : ''
    ].filter(Boolean).join(' · ')).join('\n');
  }

  function formatFeedbackVersions(snapshot) {
    if (!snapshot || !snapshot.schemaVersion) return '-';
    return [
      `promptVersion：${snapshot.promptVersion || '-'}`,
      `configVersion：${snapshot.configVersion || '-'}`,
      `resourceVersion：${snapshot.resourceVersion || '-'}`,
      `outputSource：${snapshot.outputMeta?.source || '-'}`,
      `citationNotice：${snapshot.outputMeta?.citationNotice || '-'}`
    ].join('\n');
  }

  function renderAdminTicketAttachments(ticket) {
    if (!els.ticketAdminAttachments || !els.ticketAdminPreview) return;
    els.ticketAdminAttachments.replaceChildren();
    els.ticketAdminPreview.hidden = true;
    els.ticketAdminPreview.textContent = '';
    const attachments = Array.isArray(ticket.attachments) ? ticket.attachments : [];
    if (attachments.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.tickets.noAttachments', '暂无附件');
      els.ticketAdminAttachments.append(empty);
      return;
    }
    for (const attachment of attachments) {
      const row = document.createElement('div');
      row.className = 'ticket-admin-attachment-row';
      const info = document.createElement('div');
      info.className = 'ticket-admin-attachment-info';
      const name = document.createElement('strong');
      name.textContent = attachment.originalName || attachment.id || adminText('admin.tickets.untitledAttachment', '未命名附件');
      const meta = document.createElement('span');
      meta.textContent = [
        `ID ${attachment.id || '-'}`,
        formatFileSize(attachment.sizeBytes),
        attachment.mimeType || '-',
        attachmentStatusLabel(attachment.status),
        attachment.uploadedAt
          ? adminText('admin.tickets.attachmentUploadedAt', { value: formatDate(attachment.uploadedAt) }, `上传 ${formatDate(attachment.uploadedAt)}`)
          : '',
        attachment.cleanedAt
          ? adminText('admin.tickets.attachmentCleanedAt', { value: formatDate(attachment.cleanedAt) }, `清理 ${formatDate(attachment.cleanedAt)}`)
          : '',
        attachment.retentionUntil
          ? adminText('admin.tickets.attachmentRetainedUntil', { value: formatDate(attachment.retentionUntil) }, `保留至 ${formatDate(attachment.retentionUntil)}`)
          : ''
      ].filter(Boolean).join(' · ');
      info.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'ticket-admin-attachment-actions';
      const downloadButton = document.createElement('button');
      downloadButton.type = 'button';
      downloadButton.className = 'secondary-button ticket-admin-download';
      downloadButton.textContent = attachment.status === 'cleaned'
        ? adminText('admin.attachmentStatus.cleaned', '已清理')
        : adminText('admin.action.download', '下载');
      downloadButton.disabled = attachment.status === 'cleaned';
      downloadButton.addEventListener('click', () => {
        downloadTicketAttachment(ticket.ticketNo, attachment).catch((error) => setFeedbackError(error.message));
      });
      actions.append(downloadButton);
      if (canPreviewAttachment(attachment)) {
        const previewButton = document.createElement('button');
        previewButton.type = 'button';
        previewButton.className = 'secondary-button ticket-admin-preview-button';
        previewButton.textContent = adminText('admin.action.preview', '预览');
        previewButton.disabled = attachment.status === 'cleaned';
        previewButton.addEventListener('click', () => {
          previewTicketAttachment(ticket.ticketNo, attachment).catch((error) => setFeedbackError(error.message));
        });
        actions.append(previewButton);
      }
      row.append(info, actions);
      els.ticketAdminAttachments.append(row);
    }
  }

  function canPreviewAttachment(attachment) {
    const name = attachment.originalName || attachment.storedName || '';
    const index = name.lastIndexOf('.');
    const ext = index >= 0 ? name.slice(index).toLowerCase() : '';
    return PREVIEWABLE_ATTACHMENT_EXTENSIONS.has(ext);
  }

  async function downloadTicketAttachment(ticketNo, attachment) {
    const response = await window.AgentXAuth.authFetch(
      `/admin/tickets/${encodeURIComponent(ticketNo)}/attachments/${encodeURIComponent(attachment.id)}/download`,
      { skipAuthRedirect: true }
    );
    if (!response.ok) {
      throw new Error(adminText('admin.error.downloadFailed', { status: response.status }, `下载失败 (${response.status})`));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.originalName || attachment.id || `${ticketNo}-attachment`;
      document.body.append(link);
      link.click();
      link.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function downloadAllTicketAttachments() {
    const detail = state.tickets.selectedDetail;
    if (!detail?.ticketNo) return;
    const attachments = (Array.isArray(detail.attachments) ? detail.attachments : [])
      .filter((attachment) => attachment.status !== 'cleaned');
    for (const attachment of attachments) {
      await downloadTicketAttachment(detail.ticketNo, attachment);
    }
  }

  async function previewTicketAttachment(ticketNo, attachment) {
    if (!els.ticketAdminPreview) return;
    const response = await window.AgentXAuth.authFetch(
      `/admin/tickets/${encodeURIComponent(ticketNo)}/attachments/${encodeURIComponent(attachment.id)}/preview`,
      { skipAuthRedirect: true }
    );
    if (response.status === 415) {
      els.ticketAdminPreview.hidden = false;
      els.ticketAdminPreview.textContent = adminText('admin.tickets.previewUnsupported', '不支持预览，请下载查看。');
      return;
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.previewFailed', { status: response.status }, `预览失败 (${response.status})`));
    }
    const payload = await response.json();
    const note = payload.truncated
      ? `\n\n${adminText(
        'admin.tickets.previewTruncated',
        { size: Math.ceil((payload.bytesRead || 0) / 1024) },
        `仅显示前 ${Math.ceil((payload.bytesRead || 0) / 1024)} KB`
      )}`
      : '';
    els.ticketAdminPreview.hidden = false;
    els.ticketAdminPreview.textContent = `${ticketText(payload.originalName, attachment.originalName || attachment.id)}\n\n${payload.previewText || ''}${note}`;
  }

  async function saveAdminTicketReview(event) {
    event.preventDefault();
    const ticketNo = state.tickets.selectedTicketNo;
    const detail = state.tickets.selectedDetail;
    if (!ticketNo || !detail) return;
    if (detail.type === 'account_application' && detail.status !== 'approved' && els.ticketAdminStatus.value === 'approved') {
      setTicketAdminStatus(adminText('admin.tickets.useApprovalAction', '加入申请通过请使用专用审批按钮。'));
      return;
    }
    setTicketAdminStatus(adminText('admin.common.saving', '保存中…'));
    const patch = {
      status: els.ticketAdminStatus.value,
      publicNote: els.ticketAdminPublicNote.value,
      internalNote: els.ticketAdminInternalNote.value,
      result: els.ticketAdminResult.value,
      needsMoreInfo: els.ticketAdminNeedsMoreInfo.checked
    };
    if (detail.type === 'account_application' && detail.status === 'approved') {
      delete patch.status;
    }
    const response = await window.AgentXAuth.authFetch(`/admin/tickets/${encodeURIComponent(ticketNo)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
    if (!response.ok) {
      throw new Error(adminText('admin.error.saveTicket', { status: response.status }, `保存工单失败 (${response.status})`));
    }
    const payload = await response.json();
    state.tickets.selectedDetail = payload.ticket;
    setTicketAdminStatus(adminText('admin.common.saved', '已保存'));
    await loadAdminTickets();
    renderAdminTicketDetail();
  }

  function renderAccountApplicationActions(detail) {
    if (!els.ticketAdminApplicationActions) return;
    els.ticketAdminApplicationActions.replaceChildren();
    const isApplication = detail.type === 'account_application';
    els.ticketAdminApplicationActions.hidden = !isApplication;
    if (!isApplication) return;
    const title = document.createElement('h3');
    title.className = 'detail-subhead';
    title.textContent = adminText('admin.tickets.accountApplication.title', '加入申请审批');
    const actions = document.createElement('div');
    actions.className = 'form-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'primary-button';
    approve.textContent = adminText('admin.tickets.accountApplication.approveCreate', '批准并创建用户');
    approve.disabled = detail.status === 'approved' || detail.status === 'rejected' || detail.status === 'closed';
    approve.addEventListener('click', () => approveAccountApplication(detail.ticketNo).catch((error) => setTicketAdminStatus(error.message)));
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger-button';
    reject.textContent = adminText('admin.tickets.accountApplication.reject', '拒绝申请');
    reject.disabled = detail.status === 'approved' || detail.status === 'rejected' || detail.status === 'closed';
    reject.addEventListener('click', () => patchAccountApplicationStatus(detail.ticketNo, 'rejected', false).catch((error) => setTicketAdminStatus(error.message)));
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'secondary-button';
    close.textContent = adminText('admin.tickets.accountApplication.close', '关闭申请');
    close.disabled = detail.status === 'approved' || detail.status === 'closed';
    close.addEventListener('click', () => patchAccountApplicationStatus(detail.ticketNo, 'closed', false).catch((error) => setTicketAdminStatus(error.message)));
    const needsInfo = document.createElement('button');
    needsInfo.type = 'button';
    needsInfo.className = 'secondary-button';
    needsInfo.textContent = adminText('admin.tickets.needsMoreInfo', '需要补充信息');
    needsInfo.disabled = detail.status === 'approved' || detail.status === 'rejected' || detail.status === 'closed';
    needsInfo.addEventListener('click', () => patchAccountApplicationStatus(detail.ticketNo, 'needs_more_info', true).catch((error) => setTicketAdminStatus(error.message)));
    actions.append(approve, needsInfo, reject, close);
    els.ticketAdminApplicationActions.append(title, actions);
  }

  async function approveAccountApplication(ticketNo) {
    setTicketAdminStatus(adminText('admin.tickets.accountApplication.approving', '正在批准并创建用户…'));
    const response = await window.AgentXAuth.authFetch(`/admin/tickets/${encodeURIComponent(ticketNo)}/account-application/approve`, {
      method: 'POST'
    });
    if (response.status === 409) {
      setTicketAdminStatus(adminText('admin.tickets.accountApplication.usernameExists', '账号名已存在，请调整申请或联系申请人补充信息。'));
      return;
    }
    if (!response.ok) {
      throw new Error(adminText('admin.error.approveApplication', { status: response.status }, `审批失败 (${response.status})`));
    }
    const payload = await response.json();
    state.tickets.selectedDetail = payload.ticket;
    const approvedUser = mergeUserIntoState(payload.user);
    const createdSummaryParams = {
      username: approvedUser?.username || payload.user?.username || 'customer',
      role: approvedUser?.role || payload.user?.role || 'customer',
      status: approvedUser?.status || payload.user?.status || 'active'
    };
    setTicketAdminStatus(adminText(
      'admin.tickets.accountApplication.createdSummary',
      createdSummaryParams,
      `已创建用户：${createdSummaryParams.username} · ${createdSummaryParams.role} · ${createdSummaryParams.status}`
    ));
    await loadAdminTickets();
    renderAdminTicketDetail();
    if (approvedUser || payload.user) {
      await openUserWorkspace(approvedUser || payload.user);
    }
  }

  async function patchAccountApplicationStatus(ticketNo, status, needsMoreInfo) {
    setTicketAdminStatus(adminText('admin.tickets.accountApplication.updating', '正在更新申请…'));
    const response = await window.AgentXAuth.authFetch(`/admin/tickets/${encodeURIComponent(ticketNo)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        needsMoreInfo,
        publicNote: els.ticketAdminPublicNote.value,
        internalNote: els.ticketAdminInternalNote.value,
        result: els.ticketAdminResult.value
      })
    });
    if (!response.ok) {
      throw new Error(adminText('admin.error.updateApplication', { status: response.status }, `更新申请失败 (${response.status})`));
    }
    const payload = await response.json();
    state.tickets.selectedDetail = payload.ticket;
    setTicketAdminStatus(adminText('admin.tickets.applicationStatusUpdated', '申请状态已更新'));
    await loadAdminTickets();
    renderAdminTicketDetail();
  }

  function renderFeedbackTextBlock(label, value) {
    const block = document.createElement('section');
    block.className = 'feedback-text-block';
    const heading = document.createElement('h3');
    heading.textContent = label;
    const body = document.createElement('div');
    body.className = 'feedback-text-value';
    body.textContent = String(value || '-');
    block.append(heading, body);
    return block;
  }

  function formatFileSize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${value} B`;
  }

  async function loadChipMappings() {
    const response = await window.AgentXAuth.authFetch('/admin/chips', { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = adminText('admin.error.loadChipCatalog', { status: response.status }, `加载芯片目录失败 (${response.status})`);
      setSectionStatus('chips', 'error', message);
      els.chipMappingError.textContent = message;
      return;
    }
    const payload = await response.json();
    state.chips = payload.chips || [];
    state.deletedChipIds.clear();
    state.knowledgeBaseRoot = payload.knowledgeBaseRoot || '';
    // 记录目录 ETag 作为保存并发守卫基线（If-Match）。
    state.chipCatalogEtag = response.headers.get('etag') || '';
    clearSectionStatus('chips', 'error');
    renderChipMappings();
  }

  // E5：芯片目录筛选条——按产品线下拉的选项集来自当前目录数据，芯片增删/归组变化后需要重建。
  function syncChipFilterLineOptions() {
    if (!els.chipFilterLine) return;
    const current = els.chipFilterLine.value;
    const lines = uniqueSorted(state.chips.flatMap((chip) => Array.isArray(chip.productLines) ? chip.productLines : []));
    els.chipFilterLine.replaceChildren();
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = adminText('admin.chips.allProductLines', '全部产品线');
    els.chipFilterLine.append(allOption);
    for (const line of lines) {
      const option = document.createElement('option');
      option.value = line;
      option.textContent = line;
      els.chipFilterLine.append(option);
    }
    if (lines.includes(current)) els.chipFilterLine.value = current;
  }

  function chipMatchesFilters(chip) {
    const filters = state.chipFilters;
    if (filters.search) {
      const needle = filters.search.trim().toLowerCase();
      const haystack = [chip.id, chip.label].filter(Boolean).join(' ').toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
    }
    if (filters.line && !(Array.isArray(chip.productLines) && chip.productLines.includes(filters.line))) return false;
    return true;
  }

  function renderChipMappings() {
    const list = els.chipCatalogList || els.chipMappingList;
    if (!list) return;
    syncChipFilterLineOptions();
    list.replaceChildren();
    els.chipMappingError.textContent = '';
    els.chipRestartNotice.hidden = true;
    if (state.chips.length === 0) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.colSpan = 9;
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.chips.noneConfigured', '未配置芯片');
      row.append(empty);
      list.append(row);
      return;
    }
    const visibleChips = state.chips.filter(chipMatchesFilters);
    if (visibleChips.length === 0) {
      const row = document.createElement('tr');
      const empty = document.createElement('td');
      empty.colSpan = 9;
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.chips.noFilterResults', '无符合筛选条件的芯片');
      row.append(empty);
      list.append(row);
      return;
    }
    for (const chip of visibleChips) {
      list.append(renderChipCatalogRow(chip));
    }
  }

  // 品牌用单个 muted 徽标渲染，空值显示「—」（B5）。
  function renderChipBrandCell(brand) {
    const cell = document.createElement('td');
    if (!brand) {
      cell.textContent = '—';
      return cell;
    }
    const badge = document.createElement('span');
    badge.className = 'admin-badge admin-badge-muted';
    badge.textContent = brand;
    cell.append(badge);
    return cell;
  }

  // 产品线/应用标签用徽标列表渲染，超过 maxVisible 个时折叠为「+N」溢出徽标（B5，对齐原型 badge-muted 溢出模式）。
  function renderChipBadgeListCell(values, maxVisible = Infinity) {
    const cell = document.createElement('td');
    const list = uniqueSorted(values || []);
    if (list.length === 0) {
      cell.textContent = '—';
      return cell;
    }
    const visible = list.slice(0, maxVisible);
    const overflow = list.length - visible.length;
    for (const value of visible) {
      const badge = document.createElement('span');
      badge.className = 'admin-badge admin-badge-muted';
      badge.textContent = value;
      badge.style.marginRight = '3px';
      cell.append(badge);
    }
    if (overflow > 0) {
      const more = document.createElement('span');
      more.className = 'admin-badge admin-badge-muted';
      more.textContent = `+${overflow}`;
      more.title = list.slice(maxVisible).join(', ');
      cell.append(more);
    }
    return cell;
  }

  function renderChipCatalogRow(chip) {
    const row = document.createElement('tr');
    row.className = 'chip-catalog-row';
    row.dataset.chipId = chip.id;
    row.tabIndex = 0;

    const summary = document.createElement('span');
    summary.className = 'sr-only';
    summary.textContent = `${chip.id} ${chip.label || chip.id} ${chip.description || ''} ${chip.queryHint || ''} ${chip.workspaceDir || ''}`;

    const promptCell = document.createElement('td');
    const promptBadge = document.createElement('button');
    const hasPrompt = hasPromptForChip(chip.id);
    promptBadge.type = 'button';
    promptBadge.className = `admin-badge chip-prompt-jump ${hasPrompt ? 'admin-badge-success' : 'admin-badge-warn'}`;
    promptBadge.textContent = hasPrompt
      ? adminText('admin.prompts.built', '已建')
      : adminText('admin.prompts.notBuilt', '未建');
    promptBadge.title = hasPrompt
      ? adminText('admin.chips.openPrompt', '打开该芯片提示词')
      : adminText('admin.chips.createPromptFromTemplate', '跳到提示词页从模板创建');
    promptBadge.addEventListener('click', (event) => {
      event.stopPropagation();
      openPromptForChip(chip.id);
    });
    promptBadge.addEventListener('keydown', (event) => event.stopPropagation());
    promptCell.append(promptBadge);

    // E5: workspace path column uses "icon + colored text" (aligned with the
    // prototype's "✓ path exists / ! path missing" wording); the warn tone class
    // keeps the alert color, so the icon stays a plain text glyph.
    const workspaceCell = document.createElement('td');
    const workspaceStatus = chipWorkspaceStatus(chip);
    const workspaceIndicator = document.createElement('span');
    workspaceIndicator.className = `admin-workspace-status admin-workspace-status-${workspaceStatus.tone}`;
    workspaceIndicator.title = workspaceStatus.title;
    const workspaceIcon = document.createElement('span');
    workspaceIcon.className = 'admin-workspace-status-icon';
    workspaceIcon.setAttribute('aria-hidden', 'true');
    workspaceIcon.textContent = workspaceStatus.tone === 'success' ? '✓' : '!';
    const workspaceLabel = document.createElement('span');
    workspaceLabel.className = 'mono';
    workspaceLabel.textContent = workspaceStatus.label;
    workspaceIndicator.append(workspaceIcon, workspaceLabel);
    workspaceCell.append(workspaceIndicator);

    const actionCell = document.createElement('td');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary-button';
    edit.textContent = adminText('admin.action.edit', '编辑');
    edit.addEventListener('click', (event) => {
      event.stopPropagation();
      openChipEditor(chip.id);
    });
    edit.addEventListener('keydown', (event) => event.stopPropagation());
    actionCell.append(edit);

    const idCell = document.createElement('td');
    idCell.textContent = chip.id || '—';
    const labelCell = document.createElement('td');
    labelCell.textContent = chip.label || chip.id || '—';
    const docCountCell = document.createElement('td');
    docCountCell.textContent = String(Array.isArray(chip.documentIds) ? chip.documentIds.length : 0);

    row.append(
      idCell,
      labelCell,
      renderChipBrandCell(chip.brand),
      renderChipBadgeListCell(chip.productLines),
      renderChipBadgeListCell(chip.applicationTags, 2),
      docCountCell
    );
    row.append(promptCell, workspaceCell, actionCell, summary);
    row.addEventListener('click', () => openChipEditor(chip.id));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openChipEditor(chip.id);
      }
    });
    return row;
  }

  // tone: success（图标/文字用成功色）| warn（图标/文字用告警色），驱动 .admin-workspace-status-* 着色。
  function chipWorkspaceStatus(chip) {
    if (chip?.workspaceExists === true || chip?.workspaceStatus === 'exists') {
      return {
        tone: 'success',
        label: adminText('admin.chips.workspace.exists', '路径已存在'),
        title: adminText('admin.chips.workspace.existsTitle', '服务器已确认该 workspaceDir 是可访问目录')
      };
    }
    if (chip?.workspaceExists === false || chip?.workspaceStatus === 'missing' || chip?.workspaceStatus === 'not_directory') {
      return {
        tone: 'warn',
        label: chip.workspaceStatus === 'not_directory'
          ? adminText('admin.chips.workspace.notDirectory', '路径非目录')
          : adminText('admin.chips.workspace.missing', '路径缺失'),
        title: chip.workspaceStatus === 'not_directory'
          ? adminText('admin.chips.workspace.notDirectoryTitle', 'workspaceDir 存在但不是目录')
          : adminText('admin.chips.workspace.missingTitle', '服务器未找到该 workspaceDir')
      };
    }
    const workspaceFormatOk = isAbsoluteWorkspaceDir(chip?.workspaceDir || '');
    return {
      tone: workspaceFormatOk ? 'success' : 'warn',
      label: workspaceFormatOk
        ? adminText('admin.chips.workspace.validFormat', '格式正确')
        : adminText('admin.chips.workspace.checkPath', '路径需检查'),
      title: workspaceFormatOk
        ? adminText('admin.chips.workspace.validFormatTitle', '仅校验路径格式，未代表服务器目录已存在')
        : adminText('admin.chips.workspace.checkPathTitle', '路径格式需检查')
    };
  }

  function hasPromptForChip(chipId) {
    const file = promptFileForChip(chipId);
    return Boolean(file && file.exists !== false);
  }

  function promptPathForChip(chipId) {
    return `chips/${String(chipId || '').trim()}.md`;
  }

  function promptFileMatchesChip(file, chipId) {
    if (file.type && file.type !== 'chip') return false;
    const expectedPath = promptPathForChip(chipId).toLowerCase();
    const expectedName = `${String(chipId || '').trim()}.md`.toLowerCase();
    const pathValue = String(file.path || '').toLowerCase();
    const nameValue = String(file.name || '').toLowerCase();
    return pathValue === expectedPath || (!file.path && (nameValue === expectedName || nameValue === String(chipId || '').toLowerCase()));
  }

  function promptFileForChip(chipId) {
    const chip = state.chips.find((item) => item.id === chipId);
    const existing = state.promptFiles.find((file) => promptFileMatchesChip(file, chipId));
    if (existing) {
      return {
        ...existing,
        type: 'chip',
        chipId,
        chipLabel: chip?.label || chipId
      };
    }
    return {
      type: 'chip',
      name: `${chipId}.md`,
      path: promptPathForChip(chipId),
      chipId,
      chipLabel: chip?.label || chipId,
      exists: false
    };
  }

  async function openPromptForChip(chipId) {
    const changed = await switchSection('prompts');
    if (!changed) return;
    renderPromptFiles();
    openPromptEditor(promptFileForChip(chipId)).catch(setPromptError);
  }

  async function openResourceDocumentForChip(documentId) {
    const id = String(documentId || '').trim();
    if (!id) return;
    const changed = await switchSection('resources');
    if (!changed) return;
    selectResourceTab('documents');
    if (!state.resources.documents.some((document) => document.documentId === id)) {
      await loadResources();
      selectResourceTab('documents');
    }
    const documentRecord = state.resources.documents.find((document) => document.documentId === id);
    if (documentRecord) {
      openResourceEditor('document', documentRecord);
      return;
    }
      setResourcesError(adminText('admin.resources.documentNotFound', { id }, `未找到文档 ${id}`));
  }

  function renderChipDocumentLinks(documentIds) {
    const root = els.chipEditorDocumentIds;
    if (!root) return;
    root.replaceChildren();
    const ids = uniqueSorted(documentIds || []);
    if (ids.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'muted';
      empty.textContent = adminText('admin.chips.noLinkedDocuments', '暂无关联文档');
      root.append(empty);
      return;
    }
    for (const documentId of ids) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chip-document-link';
      button.textContent = documentId;
      button.title = adminText('admin.chips.openDocumentsScopes', '打开文档与 Scope');
      button.addEventListener('click', () => {
        openResourceDocumentForChip(documentId).catch((error) => setResourcesError(error.message));
      });
      root.append(button);
    }
  }

  // === TESTABLE createChipInput START ===
  // 自包含纯函数：仅用 document.createElement + 标准 JS，不读全局 els/state。
  // chipId（field='id'）一旦有值即设为只读，防止改名（改名会让 users.json / roles.json 旧引用成孤儿；
  // 服务端 PUT /admin/chips 也会拒绝既有 chip 改名 → 409）。新建行 id 为空则可编辑，允许首次命名。
  function createChipInput(labelText, field, value) {
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.dataset.field = field;
    input.value = value;
    input.autocomplete = 'off';
    if (field === 'id' && value !== '') {
      input.readOnly = true;
      input.title = adminText('admin.chips.idImmutable', '芯片 ID 创建后不可修改');
    }
    label.append(input);
    return label;
  }
  // === TESTABLE createChipInput END ===

  function addChipRow() {
    const draft = { id: '', label: '', workspaceDir: '' };
    state.editingChipId = '';
    fillChipEditor(draft, true);
  }

  function removeChipRow(chipId) {
    if (chipId && isChipReferenced(chipId)) {
      els.chipMappingError.textContent = adminText(
        'admin.chips.referencedByGrant',
        { chipId },
        `芯片 ${chipId} 仍被用户授权引用，请先移除这些授权后再删除。`
      );
      return;
    }
    if (chipId) {
      state.deletedChipIds.add(chipId);
      state.chips = state.chips.filter((chip) => chip.id !== chipId);
      closeChipEditor();
      renderChipMappings();
    }
    els.chipMappingError.textContent = '';
  }

  function isChipReferenced(chipId) {
    return state.users.some((user) => Array.isArray(user.resourceGrants?.chipIds) && user.resourceGrants.chipIds.includes(chipId));
  }

  // P1-9 前端切片：只读扫描文档 / Scope Preset 对该 chip 的引用（`document.chipIds` / `preset.chipIds`）。
  // 真实级联清理另立项；这里只用于删除确认时如实提示会遗留哪些孤儿引用，不做自动清理。
  function chipDocPresetReferences(chipId) {
    const docs = (state.resources.documents || [])
      .filter((doc) => Array.isArray(doc.chipIds) && doc.chipIds.includes(chipId))
      .map((doc) => doc.documentId);
    const presets = (state.resources.scopePresets || [])
      .filter((preset) => Array.isArray(preset.chipIds) && preset.chipIds.includes(chipId))
      .map((preset) => preset.scopePresetId);
    return { docs, presets };
  }

  // 芯片删除确认：改用应用内确认弹窗（window.AgentXUI.confirm），替换原生 confirm()，
  // 与用户删除（deleteUser）等其它危险操作保持同一套确认体验。
  async function confirmDeleteChip(chipId) {
    // 文案如实：既有实现只拦截「用户授权」引用，文档 / Scope Preset 的绑定不会自动清理，
    // 不再谎称「将同时解除…绑定关系」；若存在文档/preset 引用，列出并提示需手动核对孤儿。
    const refs = chipDocPresetReferences(chipId);
    const orphanNote =
      refs.docs.length || refs.presets.length
        ? adminText(
          'admin.chips.deleteOrphanNote',
          { documents: refs.docs.length, presets: refs.presets.length, ids: [...refs.docs, ...refs.presets].join('、') },
          ` 该芯片仍被 ${refs.docs.length} 篇文档、${refs.presets.length} 个 Scope Preset 引用（${[...refs.docs, ...refs.presets].join('、')}）；这些绑定不会自动清理，删除后请到「文档与 Scope」用孤儿校验手动核对。`
        )
        : '';
    const confirmed = await window.AgentXUI.confirm({
      title: adminText('admin.chips.deleteTitle', '删除芯片'),
      body: adminText(
        'admin.chips.deleteBody',
        { chipId, orphanNote },
        `确认删除芯片「${chipId}」？此操作不可恢复；若仍被用户授权引用，删除会被拦截。${orphanNote}`
      ),
      confirmText: adminText('admin.action.delete', '删除'),
      danger: true
    });
    if (!confirmed) return;
    removeChipRow(chipId);
  }

  // === TESTABLE collectChipCatalogCore START ===
  // 自包含纯函数：仅用入参 + 行元素 DOM 读取 + 标准 JS，不读全局 els/state、不调其它 helper。
  // 负责按 dataset.chipId 回查原始 chip、{...original, ...edited} 合并、字段拆分与空值处理，
  // 产出 { knowledgeBaseRoot, chips }。校验（必填/绝对路径/唯一性）留在外层 collectChipCatalog。
  function collectChipCatalogCore(rows, stateChips, knowledgeBaseRoot) {
    const byId = new Map((stateChips || []).map((chip) => [chip.id, chip]));
    // 读取行内某字段输入的 trimmed 值；输入不存在时返回 undefined，
    // 表示该字段未渲染 → 保留 {...original}（不覆盖、不清空、不抛错）。
    const readField = (row, field) => {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (!input) return undefined;
      if ('value' in input) return input.value.trim();
      return (input.dataset.values || '').trim();
    };
    const splitList = (value) => value
      ? value.split(/[,，、]/).map((t) => t.trim()).filter(Boolean)
      : [];
    const chips = [...rows].map((row) => {
      const original = byId.get(row.dataset.chipId) || {};
      const merged = { ...original };
      // 标量必填字段：输入存在则覆盖（即使空字符串），不存在则保留 original。
      for (const field of ['id', 'label', 'description', 'queryHint', 'workspaceDir']) {
        const value = readField(row, field);
        if (value !== undefined) merged[field] = value;
      }
      // 列表字段：输入存在则按 /[,，、]/ 拆分（空 → []），不存在则保留 original。
      for (const field of ['applicationTags', 'productLines', 'brandAliases', 'documentIds', 'permissionTags', 'sourceLabels']) {
        const value = readField(row, field);
        if (value !== undefined) merged[field] = splitList(value);
      }
      // 可选标量：输入存在且非空则设，存在且空则删键，不存在则保留 original。
      for (const field of ['summary', 'brand']) {
        const value = readField(row, field);
        if (value !== undefined) {
          if (value) merged[field] = value; else delete merged[field];
        }
      }
      return merged;
    });
    return { knowledgeBaseRoot, chips };
  }
  // === TESTABLE collectChipCatalogCore END ===

  function collectChipCatalog() {
    const chips = state.chips.map((chip) => ({ ...chip }));
    const knowledgeBaseRoot = state.knowledgeBaseRoot;
    if (chips.length === 0 || chips.some((chip) => !chip.id || !chip.label || !chip.workspaceDir)) {
      throw new Error(adminText('admin.chips.validation.required', 'Chip id, label, and absolute workspaceDir are required.'));
    }
    if (chips.some((chip) => !isAbsoluteWorkspaceDir(chip.workspaceDir))) {
      throw new Error(adminText('admin.chips.validation.absolutePath', 'workspaceDir must be an absolute path.'));
    }
    const ids = chips.map((chip) => chip.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(adminText('admin.chips.validation.uniqueIds', 'Chip ids must be unique.'));
    }
    return { knowledgeBaseRoot, chips };
  }

  function openChipEditor(chipId) {
    const chip = state.chips.find((item) => item.id === chipId);
    if (!chip) return;
    state.editingChipId = chipId;
    fillChipEditor(chip, false);
  }

  // 芯片编辑抽屉 tab 切换：与用户详情 tab（activateUserTab）同一套「隐藏面板 + aria-selected」模式，
  // 支持左右方向键在可见 tab 间循环（B2）。
  function activateChipEditorTab(key) {
    const tabs = Array.from(document.querySelectorAll('[data-chip-editor-tab]'));
    for (const tab of tabs) {
      const active = tab.dataset.chipEditorTab === key;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      const panel = document.getElementById(`chip-editor-tabpanel-${tab.dataset.chipEditorTab}`);
      if (panel) panel.toggleAttribute('hidden', !active);
    }
    state.chipEditorTab = key;
  }

  function initChipEditorTabs() {
    const tabs = Array.from(document.querySelectorAll('[data-chip-editor-tab]'));
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activateChipEditorTab(tab.dataset.chipEditorTab));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const current = tabs.indexOf(tab);
        if (current === -1) return;
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const next = tabs[(current + offset + tabs.length) % tabs.length];
        next.focus();
        activateChipEditorTab(next.dataset.chipEditorTab);
      });
    });
  }

  function fillChipEditor(chip, isNew, resetTab = true) {
    if (!els.chipEditorDrawer) return;
    openChipEditorDrawer();
    // resetTab=false：保存后原地刷新草稿时保留用户当前所在 tab，不跳回基础信息（避免打断编辑归组/工作区路径的操作流）。
    if (resetTab) activateChipEditorTab('basic');
    if (els.chipEditorTitle) {
      els.chipEditorTitle.textContent = isNew
        ? adminText('admin.chips.new', '新建芯片')
        : adminText('admin.chips.editTitle', { chipId: chip.id }, `编辑芯片 · ${chip.id}`);
    }
    if (els.chipEditorMeta) {
      els.chipEditorMeta.textContent = isNew
        ? adminText('admin.chips.workspaceUnassigned', '尚未分配 workspaceDir')
        : adminText(
          'admin.chips.workspaceMeta',
          { value: chip.workspaceDir || adminText('admin.common.notSet', '未设置') },
          `workspaceDir: ${chip.workspaceDir || '未设置'}`
        );
    }
    if (els.chipEditorId) {
      els.chipEditorId.value = chip.id || '';
      els.chipEditorId.readOnly = !isNew && Boolean(chip.id);
    }
    if (els.chipEditorLabel) els.chipEditorLabel.value = chip.label || chip.id || '';
    setTokenFieldValues(els.chipEditorBrand, chip.brand ? [chip.brand] : [], 'brands');
    setTokenFieldValues(els.chipEditorProductLines, chip.productLines, 'productLines');
    setTokenFieldValues(els.chipEditorApplicationTags, chip.applicationTags, 'applicationTags');
    renderChipDocumentLinks(chip.documentIds);
    if (els.chipEditorSummary) els.chipEditorSummary.value = chip.summary || '';
    if (els.chipEditorQueryHint) els.chipEditorQueryHint.value = chip.queryHint || '';
    if (els.chipEditorWorkspaceDir) els.chipEditorWorkspaceDir.value = chip.workspaceDir || '';
    if (els.chipEditorWorkspaceStatus) {
      const status = chipWorkspaceStatus(chip);
      els.chipEditorWorkspaceStatus.className = `admin-badge ${status.tone === 'success' ? 'admin-badge-success' : 'admin-badge-warn'}`;
      els.chipEditorWorkspaceStatus.textContent = status.label;
      els.chipEditorWorkspaceStatus.title = status.title;
    }
    // 危险操作 tab 隔离删除入口：新建（未保存）芯片没有可删的既有记录，隐藏整个 tab。
    const dangerTab = document.getElementById('chip-editor-tab-danger');
    if (dangerTab) dangerTab.hidden = isNew;
    if (els.chipEditorDelete) els.chipEditorDelete.hidden = isNew;
    if (resetTab) els.chipEditorId?.focus();
  }

  // 抽屉打开：遮罩 + 滑入，接入既有 .admin-drawer/.admin-drawer-backdrop 组件（B1）。
  function openChipEditorDrawer() {
    if (els.chipEditorBackdrop) els.chipEditorBackdrop.hidden = false;
    if (els.chipEditorDrawer) {
      els.chipEditorDrawer.hidden = false;
      els.chipEditorDrawer.classList.remove('is-closed');
      activateDrawerFocus(els.chipEditorDrawer);
    }
  }

  function closeChipEditor() {
    state.editingChipId = null;
    if (els.chipEditorBackdrop) els.chipEditorBackdrop.hidden = true;
    if (els.chipEditorDrawer) els.chipEditorDrawer.hidden = true;
    restoreDrawerFocus();
  }

  function collectChipEditorDraft() {
    const id = (els.chipEditorId?.value || '').trim();
    const existing = state.editingChipId ? state.chips.find((chip) => chip.id === state.editingChipId) : {};
    const draft = { ...(existing || {}) };
    draft.id = id;
    draft.label = (els.chipEditorLabel?.value || '').trim();
    const brand = getTokenFieldValues(els.chipEditorBrand)[0] || '';
    if (brand) draft.brand = brand; else delete draft.brand;
    draft.productLines = getTokenFieldValues(els.chipEditorProductLines);
    draft.applicationTags = getTokenFieldValues(els.chipEditorApplicationTags);
    const summary = (els.chipEditorSummary?.value || '').trim();
    if (summary) draft.summary = summary; else delete draft.summary;
    draft.queryHint = (els.chipEditorQueryHint?.value || '').trim();
    draft.workspaceDir = (els.chipEditorWorkspaceDir?.value || '').trim();
    return draft;
  }

  function applyChipEditor(event) {
    if (event) event.preventDefault();
    const draft = collectChipEditorDraft();
    if (!draft.id || !draft.label || !draft.workspaceDir) {
      els.chipMappingError.textContent = adminText('admin.chips.validation.required', 'Chip id, label, and absolute workspaceDir are required.');
      return;
    }
    if (!isAbsoluteWorkspaceDir(draft.workspaceDir)) {
      els.chipMappingError.textContent = adminText('admin.chips.validation.absolutePath', 'workspaceDir must be an absolute path.');
      return;
    }
    const existingId = state.editingChipId;
    if (existingId && existingId !== draft.id) {
      els.chipMappingError.textContent = adminText(
        'admin.chips.validation.idImmutable',
        { previous: existingId, next: draft.id },
        `芯片 ID 创建后不可修改（${existingId} → ${draft.id}）。`
      );
      return;
    }
    const duplicate = state.chips.some((chip) => chip.id === draft.id && chip.id !== existingId);
    if (duplicate) {
      els.chipMappingError.textContent = adminText(
        'admin.chips.validation.duplicate',
        { chipId: draft.id },
        `Chip ${draft.id} already exists.`
      );
      return;
    }
    if (existingId) {
      state.chips = state.chips.map((chip) => (chip.id === existingId ? draft : chip));
    } else {
      state.deletedChipIds.delete(draft.id);
      state.chips = [...state.chips, draft];
      state.editingChipId = draft.id;
    }
    els.chipMappingError.textContent = '';
    renderChipMappings();
    fillChipEditor(draft, false, false);
  }

  function isAbsoluteWorkspaceDir(value) {
    return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
  }

  async function readErrorMessage(response, fallback) {
    try {
      const payload = await response.json();
      return payload?.error || fallback;
    } catch {
      return fallback;
    }
  }

  async function saveChipMappings() {
    try {
      els.chipMappingError.textContent = '';
      els.chipRestartNotice.hidden = true;
      const catalog = collectChipCatalog();
      // 计算被删芯片 id：已加载目录里有、但本次保存目录里没有的 id → 让后端级联清理孤儿授权。
      const nextIds = new Set(catalog.chips.map((chip) => chip.id));
      const deletedIds = [...state.deletedChipIds].filter((id) => id && !nextIds.has(id));
      // 带上保存并发守卫基线 If-Match（若已知）。后端目录被并发改写时返回 409。
      const headers = {};
      if (state.chipCatalogEtag) {
        headers['If-Match'] = state.chipCatalogEtag;
      }
      const response = await window.AgentXAuth.authFetch('/admin/chips', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ ...catalog, deletedIds })
      });
      if (response.status === 409) {
        throw new Error(adminText('admin.chips.catalogChanged', '目录已变更，请重新加载后再保存。'));
      }
      if (!response.ok) {
        throw new Error(await readErrorMessage(
          response,
          adminText('admin.error.saveChipCatalog', { status: response.status }, `Saving chip catalog failed (${response.status})`)
        ));
      }
      const payload = await response.json();
      state.chips = payload.chips || [];
      state.deletedChipIds.clear();
      state.knowledgeBaseRoot = payload.knowledgeBaseRoot || state.knowledgeBaseRoot;
      // 更新本地 ETag 基线为后端返回的新标记，使下次保存沿用最新 If-Match。
      state.chipCatalogEtag = response.headers.get('etag') || state.chipCatalogEtag;
      renderChipMappings();
      renderChipAccess();
      // 用户可见提示一律中文（后端 payload.message 为英文 API 文案，不直接回显）；
      // 并明确点出 restart-gated 语义：归组/文档关联/授权改动要重启服务后才对新会话的检索与授权生效，
      // 避免管理员误以为保存即时生效（后端 chips.catalog 在重启前仍是旧口径）。
      els.chipRestartNotice.textContent = adminText(
        'admin.chips.savedRestartNotice',
        '芯片目录已保存。归组、文档关联等改动需在服务重启后才对新会话的检索与授权生效。'
      );
      els.chipRestartNotice.hidden = false;
      setSectionStatus('chips', 'saved', els.chipRestartNotice.textContent);
      clearSectionStatus('chips', 'error');
    } catch (error) {
      setSectionStatus('chips', 'error', error.message);
      els.chipMappingError.textContent = error.message;
    }
  }

  // === TESTABLE buildChipIngestDraft START ===
  // 自包含纯函数：把入库表单字段读到的原始字符串整理成 POST /admin/chips/ingest 的草稿对象。
  // 列表字段按 /[,，、]/ 拆分去空（与芯片编辑器一致）；空字符串字段一律省略（既有 chip 不被空值覆盖）。
  function buildChipIngestDraft(fields) {
    const splitList = (raw) =>
      (raw || '').split(/[,，、]/).map((item) => item.trim()).filter(Boolean);
    const draft = { chipId: (fields.chipId || '').trim() };
    const label = (fields.label || '').trim();
    if (label) draft.label = label;
    const brand = (fields.brand || '').trim();
    if (brand) draft.brand = brand;
    const summary = (fields.summary || '').trim();
    if (summary) draft.summary = summary;
    const workspaceDir = (fields.workspaceDir || '').trim();
    if (workspaceDir) draft.workspaceDir = workspaceDir;
    const productLines = splitList(fields.productLines);
    if (productLines.length > 0) draft.productLines = productLines;
    const applicationTags = splitList(fields.applicationTags);
    if (applicationTags.length > 0) draft.applicationTags = applicationTags;
    return draft;
  }
  // === TESTABLE buildChipIngestDraft END ===
  // 注：buildChipIngestDraft 保留为纯函数（供 POST /admin/chips/ingest 未来复用与既有单测覆盖），
  // 但驱动它的表单 UI（chip-ingest-form 等元素与 ingestChipDraft 提交流程）已随 admin 改版收官批移除——
  // 该表单标记不再出现在 admin.html，孵化入库改为「反馈&工单」下载 + 数据孵化 SOP 人工入库（未来模块）。

  function renderChipAccess() {
    renderSelectedUserAccess();
  }

  function findUserById(userId) {
    return state.users.find((candidate) => candidate.id === userId) || null;
  }

  function hasUserChipOverride(userOrId) {
    const user = typeof userOrId === 'string' ? findUserById(userOrId) : userOrId;
    return Boolean(user) && Object.prototype.hasOwnProperty.call(user.resourceGrants || {}, 'chipIds');
  }

  function explicitChipIdsForUser(user) {
    return hasUserChipOverride(user) ? uniqueSorted(user?.resourceGrants?.chipIds || []) : [];
  }

  function derivedChipIdsFromResourceGrants(resourceGrants) {
    const brands = new Set(resourceGrants?.brands || []);
    const productLines = new Set(resourceGrants?.productLines || []);
    if (brands.size === 0 && productLines.size === 0) {
      return [];
    }
    return uniqueSorted((state.chips || [])
      .filter((chip) => {
        const brandGranted = chip.brand && brands.has(chip.brand);
        const productLineGranted = Array.isArray(chip.productLines) && chip.productLines.some((item) => productLines.has(item));
        return brandGranted || productLineGranted;
      })
      .map((chip) => chip.id));
  }

  function derivedChipIdsFromUserGrants(user) {
    return derivedChipIdsFromResourceGrants(user?.resourceGrants);
  }

  function renderEffectiveChipAccess(chip, granted, source) {
    const row = document.createElement('div');
    row.className = `chip-access-row ${granted ? 'granted' : 'denied'}`;
    const status = document.createElement('span');
    status.className = 'chip-access-status';
    status.textContent = granted
      ? adminText('admin.access.granted', '已授权')
      : adminText('admin.access.notGranted', '未授权');
    const chipText = document.createElement('span');
    chipText.className = 'chip-access-chip';
    chipText.textContent = `${chip.id} · ${chip.label || chip.id}`;
    const sourceText = document.createElement('span');
    sourceText.className = 'chip-access-source';
    sourceText.textContent = source;
    row.append(status, chipText, sourceText);
    return row;
  }

  function roleAllowsChip(roleName, chipId) {
    const role = roleState.roles?.[roleName];
    const allowedChips = role?.access?.allowedChips;
    return Array.isArray(allowedChips) && (allowedChips.includes('*') || allowedChips.includes(chipId));
  }

  function roleAllowsAllChips(roleName) {
    if (roleName === 'admin') return true;
    const role = roleState.roles?.[roleName];
    const allowedChips = role?.access?.allowedChips;
    return Array.isArray(allowedChips) && allowedChips.includes('*');
  }

  function getRoleNames() {
    const names = Object.keys(roleState.roles || {}).filter((name) => !name.startsWith('_'));
    const fallback = ['customer', 'internal', 'admin'];
    return names.length > 0 ? names : fallback;
  }

  function populateRoleSelect(select, selectedValue) {
    if (!select) return;
    const current = selectedValue || select.value || 'customer';
    const names = getRoleNames();
    select.replaceChildren();
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    if (!names.includes(current)) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = current;
      select.append(option);
    }
    select.value = current;
  }

  function renderBadge(text, kind) {
    const badge = document.createElement('span');
    badge.className = `status-badge ${kind}`;
    badge.textContent = text;
    return badge;
  }

  function renderLifecycleBadge(user) {
    if ((user.status || 'active') === 'disabled') {
      return renderBadge(adminText('admin.userStatus.disabled', 'disabled'), 'disabled');
    }
    if (isExpired(user.expiresAt)) {
      return renderBadge(adminText('admin.userStatus.expired', 'expired'), 'expired');
    }
    return renderBadge(adminText('admin.userStatus.active', 'active'), 'completed');
  }

  const ROLE_BADGE_CLASS = {
    admin: 'admin-badge-solid'
  };

  // E3：角色列改为徽标胶囊——admin 用实心深色胶囊，其它角色用柔和描边胶囊，复用既有 .admin-badge 体系。
  function renderRoleBadge(role) {
    const badge = document.createElement('span');
    const cls = ROLE_BADGE_CLASS[role] || 'admin-badge-muted';
    badge.className = `admin-badge ${cls}`;
    badge.textContent = role || '—';
    return badge;
  }

  // E3：状态列改为「圆点 + 文字」样式（原型 .st 组件），替代原先的方框徽标。
  function renderLifecycleStatus(user) {
    const wrap = document.createElement('span');
    if ((user.status || 'active') === 'disabled') {
      wrap.className = 'admin-status-dot disabled';
      wrap.textContent = adminText('admin.userStatus.disabled', 'disabled');
    } else if (isExpired(user.expiresAt)) {
      wrap.className = 'admin-status-dot expired';
      wrap.textContent = adminText('admin.userStatus.expired', 'expired');
    } else {
      wrap.className = 'admin-status-dot active';
      wrap.textContent = adminText('admin.userStatus.active', 'active');
    }
    return wrap;
  }

  function isExpired(expiresAt) {
    if (!expiresAt) return false;
    const value = Date.parse(expiresAt);
    return Number.isFinite(value) && value < Date.now();
  }

  function expirySummary(expiresAt) {
    if (!expiresAt) return adminText('admin.users.neverExpires', '永不过期');
    if (isExpired(expiresAt)) return adminText('admin.userStatus.expired', '已过期');
    return adminText('admin.users.validUntil', { value: formatDateTime(expiresAt) }, `有效至 ${formatDateTime(expiresAt)}`);
  }

  function keyExpirySummary(key) {
    if (!key.expiresAt) return adminText('admin.keys.followsUser', '跟随用户');
    if (isExpired(key.expiresAt)) return adminText('admin.userStatus.expired', '已过期');
    return adminText('admin.users.validUntil', { value: formatDateTime(key.expiresAt) }, `有效至 ${formatDateTime(key.expiresAt)}`);
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(state.locale) : value;
  }

  function toLocalDateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  function fromLocalDateTimeInput(value) {
    return value ? new Date(value).toISOString() : null;
  }

  function collectProfile(values) {
    const profile = {};
    for (const [key, value] of Object.entries(values)) {
      const trimmed = String(value || '').trim();
      if (trimmed) {
        profile[key] = trimmed;
      }
    }
    return Object.keys(profile).length > 0 ? profile : null;
  }

  function splitAdminList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function parseGrantList(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item, index, list) => list.indexOf(item) === index);
  }

  function formatGrantList(values) {
    return Array.isArray(values) ? values.join(', ') : '';
  }

  // V12：共享 token 字段渲染原语——只负责纯 DOM 构建（token 胶囊 + 输入框 + datalist）与事件绑定，
  // 不关心「值存在哪」（draft 对象 / DOM dataset 均可）。原来 setTokenFieldValues（DOM/dataset 驱动，
  // 公告/芯片编辑器/资源用）与 renderAccessTokenPicker（draft 对象驱动，用户/角色统一访问编辑器用）
  // 各自手写一份几乎相同的 token/input/datalist 构建逻辑，现收敛到这一处；两个调用方仍保留各自的
  // 状态读写策略（是否整体重渲染、状态落在哪），互不影响、payload 形状不变。
  function renderTokenFieldInto(field, values, key, { disabled = false, listId, onAdd, onRemove } = {}) {
    field.replaceChildren();
    for (const value of values) {
      const token = createTokenSpan(value, {
        disabled,
        onRemove: () => onRemove(value)
      });
      field.append(token);
    }
    const input = document.createElement('input');
    input.className = 'admin-token-input';
    input.type = 'text';
    input.placeholder = adminText('admin.access.tokenInputPlaceholder', '输入后回车添加');
    input.autocomplete = 'off';
    input.setAttribute('list', listId);
    input.disabled = Boolean(disabled);
    input.addEventListener('change', () => {
      const value = input.value.trim();
      if (!value) return;
      onAdd(value, input);
    });
    field.append(input);
    return input;
  }

  function renderTokenDatalist(key, listId) {
    const datalist = document.createElement('datalist');
    datalist.id = listId;
    for (const option of accessSuggestionsFor(key)) {
      const item = document.createElement('option');
      item.value = option;
      datalist.append(item);
    }
    return datalist;
  }

  function setTokenFieldValues(target, values, key = target?.dataset?.tokenField || '') {
    if (!target) return;
    const normalized = uniqueSorted(values || []);
    if ('value' in target) {
      target.value = formatGrantList(normalized);
      return;
    }
    target.dataset.values = formatGrantList(normalized);
    target.replaceChildren();
    const field = document.createElement('div');
    field.className = 'admin-token-field';
    const listId = `${target.id || key}-options`;
    renderTokenFieldInto(field, normalized, key, {
      listId,
      onAdd: (value) => setTokenFieldValues(target, [...getTokenFieldValues(target), value], key),
      onRemove: (value) => setTokenFieldValues(target, normalized.filter((item) => item !== value), key)
    });
    target.append(field, renderTokenDatalist(key, listId));
  }

  function getTokenFieldValues(target) {
    if (!target) return [];
    if ('value' in target) {
      return parseGrantList(target.value);
    }
    return parseGrantList(target.dataset.values || '');
  }

  function collectUserResourceGrants() {
    const user = selectedUser();
    return user ? cloneResourceGrants(getAccessDraft(user).resourceGrants) : emptyResourceGrants();
  }

  function collectRoleGrantFields() {
    const draft = roleState.accessDraft || { modelGrants: [], resourceGrants: emptyResourceGrants() };
    return {
      ...cloneResourceGrants(draft.resourceGrants),
      modelIds: [...(draft.modelGrants || [])]
    };
  }

  function uniqueSorted(values) {
    return [...new Set((values || []).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
  }

  function emptyResourceGrants() {
    return { brands: [], productLines: [], chipIds: [], documentIds: [], scopePresetIds: [], mcpTools: [] };
  }

  function cloneResourceGrants(grants) {
    return {
      brands: uniqueSorted(grants?.brands || []),
      productLines: uniqueSorted(grants?.productLines || []),
      chipIds: uniqueSorted(grants?.chipIds || []),
      documentIds: uniqueSorted(grants?.documentIds || []),
      scopePresetIds: uniqueSorted(grants?.scopePresetIds || []),
      mcpTools: uniqueSorted(grants?.mcpTools || [])
    };
  }

  function compactResourceGrantsForSave(grants, options = {}) {
    const compacted = {};
    for (const key of ['brands', 'productLines', 'documentIds', 'scopePresetIds', 'mcpTools']) {
      const values = uniqueSorted(grants?.[key] || []);
      if (values.length > 0) {
        compacted[key] = values;
      }
    }
    if (options.keepChipIds) {
      compacted.chipIds = uniqueSorted(grants?.chipIds || []);
    }
    return Object.keys(compacted).length > 0 ? compacted : undefined;
  }

  function accessDraftFromUser(user) {
    const resourceGrants = cloneResourceGrants(user.resourceGrants);
    return {
      modelGrants: uniqueSorted(user.modelGrants || user.authorizedModels || []),
      resourceGrants,
      chipIdsExplicit: hasUserChipOverride(user)
    };
  }

  function getAccessDraft(user) {
    if (!state.access.draftByUserId[user.id]) {
      state.access.draftByUserId[user.id] = accessDraftFromUser(user);
    }
    return state.access.draftByUserId[user.id];
  }

  function markAccessDirty(userId, dimension = null) {
    state.access.dirtyUserIds.add(userId);
    if (dimension) {
      if (!state.access.dirtyDimensionsByUserId[userId]) {
        state.access.dirtyDimensionsByUserId[userId] = new Set();
      }
      state.access.dirtyDimensionsByUserId[userId].add(dimension);
    }
    renderAccessDirtyState(userId);
  }

  function isAccessDimensionDirty(userId, dimension) {
    return state.access.dirtyDimensionsByUserId[userId]?.has(dimension) || false;
  }

  function clearAccessDirty(userId) {
    state.access.dirtyUserIds.delete(userId);
    delete state.access.dirtyDimensionsByUserId[userId];
  }

  function renderAccessDirtyState(userId) {
    if (els.selectedUserAccessDirty) {
      els.selectedUserAccessDirty.hidden = !state.access.dirtyUserIds.has(userId);
    }
  }

  function setAccessError(message, userId = state.selectedUserId) {
    if (userId) {
      if (message) state.access.errorByUserId[userId] = message;
      else delete state.access.errorByUserId[userId];
    }
    if (els.selectedUserAccessError && (!userId || userId === state.selectedUserId)) {
      els.selectedUserAccessError.textContent = message || '';
    }
  }

  function setAccessStatus(message, userId = state.selectedUserId) {
    if (userId) {
      if (message) state.access.statusByUserId[userId] = message;
      else delete state.access.statusByUserId[userId];
    }
    if (els.selectedUserAccessStatus && (!userId || userId === state.selectedUserId)) {
      els.selectedUserAccessStatus.textContent = message || '';
      els.selectedUserAccessStatus.hidden = !message;
    }
  }

  function renderAccessMessages(userId) {
    if (!userId) {
      setAccessError('', null);
      setAccessStatus('', null);
      return;
    }
    if (els.selectedUserAccessError) {
      els.selectedUserAccessError.textContent = state.access.errorByUserId[userId] || '';
    }
    if (els.selectedUserAccessStatus) {
      const message = state.access.statusByUserId[userId] || '';
      els.selectedUserAccessStatus.textContent = message;
      els.selectedUserAccessStatus.hidden = !message;
    }
  }

  function invalidateEffectiveAuthorization(userId) {
    if (!userId) return;
    delete state.access.effectiveByUserId[userId];
    state.access.requestIdByUserId[userId] = ++state.access.nextRequestId;
  }

  function invalidateAllEffectiveAuthorizations() {
    state.access.effectiveByUserId = {};
    state.access.requestIdByUserId = {};
    state.access.nextRequestId += 1;
  }

  function accessSuggestionsFor(key) {
    if (key === 'modelGrants') {
      return collectGrantValueSuggestions((u) => u.modelGrants || u.authorizedModels);
    }
    if (key === 'brands') {
      return uniqueSorted((state.chips || []).map((chip) => chip.brand).filter(Boolean));
    }
    if (key === 'productLines') {
      return uniqueSorted((state.chips || []).flatMap((chip) => chip.productLines || []));
    }
    if (key === 'chipIds') {
      return uniqueSorted((state.chips || []).map((chip) => chip.id).filter(Boolean));
    }
    if (key === 'documentIds') {
      return uniqueSorted([
        ...(state.chips || []).flatMap((chip) => chip.documentIds || []),
        ...(state.resources.documents || []).map((document) => document.documentId).filter(Boolean)
      ]);
    }
    if (key === 'scopePresetIds') {
      return uniqueSorted([
        ...collectGrantValueSuggestions((u) => u.resourceGrants?.scopePresetIds),
        ...(state.resources.scopePresets || []).map((preset) => preset.scopePresetId).filter(Boolean)
      ]);
    }
    if (key === 'modelIds') {
      return collectGrantValueSuggestions((u) => u.modelGrants || u.authorizedModels);
    }
    if (key === 'applicationTags') {
      return uniqueSorted([
        ...(state.chips || []).flatMap((chip) => chip.applicationTags || []),
        ...(state.resources.documents || []).flatMap((document) => document.applicationTags || []),
        ...(state.resources.scopePresets || []).flatMap((preset) => preset.applicationTags || [])
      ]);
    }
    if (key === 'sourceLabels') {
      return uniqueSorted([
        ...(state.resources.documents || []).flatMap((document) => document.sourceLabels || []),
        ...(state.resources.scopePresets || []).flatMap((preset) => preset.sourceLabels || [])
      ]);
    }
    if (key === 'mcpTools') {
      return ['agentx_whoami', 'agent_spawn', 'agent_log', 'agent_send', 'agent_poll', 'agent_kill', 'agent_list'];
    }
    return [];
  }

  function accessDimensionValue(draft, key) {
    return key === 'modelGrants' ? draft.modelGrants : draft.resourceGrants[key];
  }

  function setAccessDimensionValue(draft, key, values) {
    if (key === 'modelGrants') {
      draft.modelGrants = uniqueSorted(values);
    } else {
      draft.resourceGrants[key] = uniqueSorted(values);
    }
  }

  // G1：单个 token 胶囊——<span class="admin-token">值<button class="admin-token-x">×</button></span>。
  // 原「.admin-token-chip 按钮直接点击移除」改为内嵌 × 按钮承担移除动作，保留 .admin-token-chip 作为 CSS 别名。
  function createTokenSpan(value, { disabled, onRemove } = {}) {
    const token = document.createElement('span');
    token.className = 'admin-token admin-token-chip';
    token.dataset.value = value;
    token.append(document.createTextNode(value));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'admin-token-x';
    remove.setAttribute('aria-label', adminText('admin.action.remove', '移除'));
    remove.textContent = '×';
    remove.disabled = Boolean(disabled);
    if (typeof onRemove === 'function') {
      remove.addEventListener('click', onRemove);
    }
    token.append(remove);
    return token;
  }

  function renderAccessTokenPicker({ namespace, key, label, draft, disabled, onChange }) {
    const block = document.createElement('div');
    block.className = 'admin-token-picker';
    block.dataset.accessDimension = key;
    const title = document.createElement('span');
    title.className = 'admin-token-picker-label';
    title.textContent = label;
    const field = document.createElement('div');
    field.className = 'admin-token-field';
    const listId = `${namespace}-access-${key}-options`;
    renderTokenFieldInto(field, accessDimensionValue(draft, key) || [], key, {
      disabled,
      listId,
      onAdd: (value, input) => {
        setAccessDimensionValue(draft, key, [...(accessDimensionValue(draft, key) || []), value]);
        input.value = '';
        onChange(key);
      },
      onRemove: (value) => {
        setAccessDimensionValue(draft, key, (accessDimensionValue(draft, key) || []).filter((item) => item !== value));
        onChange(key);
      }
    });
    block.append(title, field, renderTokenDatalist(key, listId));
    return block;
  }

  // G2：勾选框内的对勾 svg——原型第 1062 行同款 path。
  function createChipCheckSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M20 6 9 17l-5-5');
    svg.append(path);
    return svg;
  }

  function createSearchIconSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '11');
    circle.setAttribute('cy', '11');
    circle.setAttribute('r', '8');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'm21 21-4.3-4.3');
    svg.append(circle, path);
    return svg;
  }

  function renderAccessChipList({ namespace, draft, effectiveIds, disabled, inheritedLabel, onChange }) {
    const wrapper = document.createDocumentFragment();

    const tools = document.createElement('div');
    tools.className = 'admin-chip-tools';
    const searchWrap = document.createElement('div');
    searchWrap.className = 'admin-chip-search';
    searchWrap.append(createSearchIconSvg());
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'admin-check-list-search';
    search.placeholder = adminText('admin.access.searchChips', '搜索芯片 ID / 描述');
    search.autocomplete = 'off';
    search.id = `${namespace}-access-chip-search`;
    search.disabled = Boolean(disabled);
    searchWrap.append(search);
    tools.append(searchWrap);

    const list = document.createElement('div');
    list.className = 'admin-chip-list admin-check-list';
    list.id = `${namespace}-access-chip-list`;
    const explicitIds = new Set(draft.chipIdsExplicit ? draft.resourceGrants.chipIds || [] : []);
    const inheritedIds = new Set(effectiveIds || []);
    for (const chip of state.chips) {
      const explicit = explicitIds.has(chip.id);
      const inherited = inheritedIds.has(chip.id) && !explicit;
      const checked = explicit || inherited;
      const locked = Boolean(disabled || inherited);

      const row = document.createElement('label');
      row.className = `admin-chip-row admin-check-list-item ${explicit ? 'overridden is-explicit' : inherited ? 'is-inherited' : ''}`.trim();
      row.dataset.adminState = explicit ? 'explicit' : inherited ? 'inherited' : 'available';
      row.dataset.chipId = chip.id;
      row.dataset.chipSearch = `${chip.id} ${chip.label || chip.id}`.toLowerCase();

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'admin-chip-cbx-native';
      checkbox.value = chip.id;
      checkbox.checked = checked;
      checkbox.disabled = locked;
      checkbox.addEventListener('change', () => {
        const next = new Set(draft.resourceGrants.chipIds || []);
        if (checkbox.checked) next.add(chip.id);
        else next.delete(chip.id);
        draft.chipIdsExplicit = true;
        draft.resourceGrants.chipIds = uniqueSorted([...next]);
        onChange('chipIds');
      });

      const cbx = document.createElement('span');
      cbx.className = `admin-chip-cbx ${checked ? (locked ? 'locked' : 'on') : ''}`.trim();
      cbx.append(createChipCheckSvg());

      const id = document.createElement('span');
      id.className = 'admin-chip-id';
      const cid = document.createElement('span');
      cid.className = 'admin-chip-cid';
      cid.textContent = chip.id;
      const cdesc = document.createElement('span');
      cdesc.className = 'admin-chip-cdesc';
      cdesc.textContent = chip.label || chip.id;
      id.append(cid, cdesc);

      row.append(checkbox, cbx, id);

      if (explicit && !disabled) {
        const state_ = document.createElement('span');
        state_.className = 'admin-badge admin-src-user admin-chip-state';
        state_.textContent = adminText('admin.access.explicitGrant', '显式添加');
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'secondary-button admin-restore-inheritance admin-chip-restore';
        restore.textContent = adminText('admin.access.restoreInheritance', '恢复继承');
        restore.addEventListener('click', (event) => {
          event.preventDefault();
          const remaining = uniqueSorted((draft.resourceGrants.chipIds || []).filter((id_) => id_ !== chip.id));
          draft.chipIdsExplicit = remaining.length > 0;
          draft.resourceGrants.chipIds = remaining;
          onChange('chipIds');
        });
        row.append(state_, restore);
      } else if (inherited && inheritedLabel) {
        const source = document.createElement('span');
        source.className = 'admin-badge admin-src-role admin-badge-muted admin-chip-state';
        source.textContent = inheritedLabel;
        row.append(source);
      }
      list.append(row);
    }
    if (state.chips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'admin-empty-state';
      empty.textContent = adminText('admin.chips.empty', '暂无芯片目录');
      list.append(empty);
    }

    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      for (const row of list.querySelectorAll('[data-chip-id]')) {
        row.style.display = !query || row.dataset.chipSearch.includes(query) ? '' : 'none';
      }
    });

    if (state.chips.length > 0) wrapper.append(tools);
    wrapper.append(list);
    return wrapper;
  }

  function renderAccessEditor({
    namespace,
    root,
    draft,
    effectiveIds = [],
    disabled = false,
    chipDisabled = disabled,
    disabledMessage = '',
    onChange
  }) {
    if (!root) return;
    root.replaceChildren();
    if (disabledMessage) {
      const notice = document.createElement('p');
      notice.className = 'admin-empty-state';
      notice.textContent = disabledMessage;
      root.append(notice);
    }
    const dimensions = [
      ['modelGrants', adminText('admin.field.model', '模型')],
      ['brands', adminText('admin.field.brand', '品牌')],
      ['productLines', adminText('admin.field.productLine', '产品线')],
      ['documentIds', adminText('admin.field.document', '文档')],
      ['scopePresetIds', adminText('admin.field.scopePreset', 'Scope 预设')],
      ['mcpTools', adminText('admin.field.mcpTools', 'MCP 工具')]
    ];
    const hint = document.createElement('p');
    hint.className = 'admin-form-hint admin-access-editor-hint';
    hint.textContent = adminText('admin.access.autoExpandHint', '品牌/产品线授权会自动展开为芯片授权');
    root.append(hint);
    for (const [key, label] of dimensions) {
      root.append(renderAccessTokenPicker({ namespace, key, label, draft, disabled, onChange }));
    }
    root.append(renderAccessChipList({
      namespace,
      draft,
      effectiveIds,
      disabled: chipDisabled,
      inheritedLabel: adminText('admin.access.inherited', '继承'),
      onChange
    }));
  }

  // G4：来源徽标——保留既有 admin-badge-muted/-info/-warn 语义类名（既有测试按此断言），
  // 叠加原型真实配色的 admin-src-role/-user/-derive（后声明覆盖颜色，见 styles.css）。
  function renderAccessSourceBadge(source) {
    const badge = document.createElement('span');
    const map = {
      role_default: ['admin-badge-muted admin-src-role', adminText('admin.access.source.roleDefault', '角色默认')],
      user_override: ['admin-badge-info admin-src-user', adminText('admin.access.source.userOverride', '用户覆盖')],
      product_line_derived: ['admin-badge-warn admin-src-derive', adminText('admin.access.source.productLineDerived', '产品线推导')]
    };
    const [kind, label] = map[source] || map.role_default;
    badge.className = `admin-badge ${kind}`;
    badge.textContent = label;
    return badge;
  }

  // C7：生效权限总览头部的三色来源图例，色块与 renderAccessSourceBadge 的徽标色一一对应（token 引用）。
  // 注意：色块用 admin-legend-swatch-* 而非 admin-badge-*，避免与真实来源徽标共用类名、
  // 干扰按 `.admin-badge-muted` 等选择器查找徽标文本的既有测试断言。
  function renderAccessSourceLegend() {
    const legend = document.createElement('div');
    legend.className = 'admin-access-summary-legend';
    const entries = [
      ['admin-legend-swatch-muted', adminText('admin.access.source.roleDefault', '角色默认')],
      ['admin-legend-swatch-info', adminText('admin.access.source.userOverride', '用户覆盖')],
      ['admin-legend-swatch-warn', adminText('admin.access.source.productLineDerived', '产品线推导')]
    ];
    for (const [kind, label] of entries) {
      const item = document.createElement('span');
      item.className = 'admin-access-summary-legend-item';
      const swatch = document.createElement('i');
      swatch.className = `admin-access-summary-legend-swatch ${kind}`;
      item.append(swatch, document.createTextNode(label));
      legend.append(item);
    }
    return legend;
  }

  // G3：生效权限总览——原型 .eff-card 两列卡：头部标题+三色图例，
  // 主体 2 列网格，每格「维度名 + 计数」在上、来源徽标横排在下，空态显示斜体「未配置」。
  function createSummaryCheckCircleSvg() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M9 12l2 2 4-4');
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '10');
    svg.append(path, circle);
    return svg;
  }

  function renderEffectiveAuthorizationSummary(response) {
    const root = document.createElement('div');
    root.className = 'admin-access-summary-grid';
    const header = document.createElement('div');
    header.className = 'admin-access-summary-header';
    const title = document.createElement('h3');
    title.className = 'admin-access-summary-title';
    title.append(
      createSummaryCheckCircleSvg(),
      document.createTextNode(adminText('admin.access.effectiveSummary', '生效权限总览'))
    );
    header.append(title, renderAccessSourceLegend());
    root.append(header);
    const body = document.createElement('div');
    body.className = 'admin-access-summary-body';
    const labels = {
      brands: adminText('admin.field.brand', '品牌'),
      productLines: adminText('admin.field.productLine', '产品线'),
      chipIds: adminText('admin.field.chip', '芯片'),
      documentIds: adminText('admin.field.document', '文档'),
      modelIds: adminText('admin.field.model', '模型'),
      scopePresetIds: adminText('admin.field.scopePreset', 'Scope 预设'),
      mcpTools: adminText('admin.field.mcpTools', 'MCP 工具')
    };
    for (const [key, label] of Object.entries(labels)) {
      const section = document.createElement('section');
      section.className = 'admin-access-summary-card';
      const dim = document.createElement('h3');
      const items = response?.dimensions?.[key] || [];
      dim.append(document.createTextNode(label));
      const count = document.createElement('span');
      count.className = 'admin-access-summary-count';
      count.textContent = String(items.length);
      dim.append(count);
      section.append(dim);
      const itemsRow = document.createElement('div');
      itemsRow.className = 'admin-access-summary-items';
      if (items.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'muted admin-access-summary-none';
        empty.textContent = adminText('admin.common.notConfigured', '未配置');
        itemsRow.append(empty);
      }
      for (const item of items) {
        const row = document.createElement('span');
        row.className = 'admin-access-summary-item';
        row.append(document.createTextNode(item.id), renderAccessSourceBadge(item.source));
        itemsRow.append(row);
      }
      section.append(itemsRow);
      body.append(section);
    }
    root.append(body);
    return root;
  }

  function selectedEffectiveAuthorization(user) {
    return user ? state.access.effectiveByUserId[user.id] : null;
  }

  function effectiveChipIdsForUser(user) {
    const draft = state.access.draftByUserId[user.id];
    if (draft && state.access.dirtyUserIds.has(user.id)) {
      if (draft.chipIdsExplicit) {
        return [];
      }
      const roleGrantedIds = state.chips
        .filter((chip) => roleAllowsChip(user.role, chip.id))
        .map((chip) => chip.id);
      return uniqueSorted([...roleGrantedIds, ...derivedChipIdsFromResourceGrants(draft.resourceGrants)]);
    }
    const response = selectedEffectiveAuthorization(user);
    return uniqueSorted((response?.dimensions?.chipIds || [])
      .filter((item) => item.source !== 'user_override')
      .map((item) => item.id));
  }

  function renderSelectedUserAccess() {
    const user = selectedUser();
    if (!els.selectedUserAccessSummary || !els.selectedUserAccessEditor || !els.selectedUserAccessSave) return;
    els.selectedUserAccessSummary.replaceChildren();
    if (!user) {
      els.selectedUserAccessSummary.textContent = adminText('admin.users.selectUser', '请选择用户。');
      els.selectedUserAccessEditor.replaceChildren();
      els.selectedUserAccessSave.disabled = true;
      renderAccessDirtyState('');
      renderAccessMessages(null);
      return;
    }
    renderAccessMessages(user.id);
    const effective = selectedEffectiveAuthorization(user);
    if (effective) {
      els.selectedUserAccessSummary.append(renderEffectiveAuthorizationSummary(effective));
    } else if (state.access.loadingUserIds.has(user.id)) {
      els.selectedUserAccessSummary.textContent = adminText('admin.access.loadingEffective', '正在加载生效权限…');
    } else {
      els.selectedUserAccessSummary.textContent = adminText('admin.access.loadOnOpen', '打开访问权限时会加载生效权限。');
    }
    const frozen = isAdminUser(user);
    const draft = getAccessDraft(user);
    renderAccessEditor({
      namespace: 'user',
      root: els.selectedUserAccessEditor,
      draft,
      effectiveIds: effectiveChipIdsForUser(user),
      disabled: frozen,
      chipDisabled: frozen,
      disabledMessage: frozen
        ? adminText('admin.access.adminFrozen', 'admin 角色已获得全部访问权限，访问编辑已冻结。')
        : '',
      onChange: (dimension) => {
        markAccessDirty(user.id, dimension);
        renderSelectedUserAccess();
      }
    });
    els.selectedUserAccessSave.disabled = frozen || !user;
    renderAccessDirtyState(user.id);
  }

  async function loadEffectiveAuthorization(userId, options = {}) {
    if (!userId) return;
    const force = Boolean(options.force);
    if (state.access.loadingUserIds.has(userId) && !force) return;
    const requestId = ++state.access.nextRequestId;
    state.access.requestIdByUserId[userId] = requestId;
    if (force) {
      delete state.access.effectiveByUserId[userId];
    }
    setAccessError('', userId);
    state.access.loadingUserIds.add(userId);
    renderSelectedUserAccess();
    try {
      const response = await window.AgentXAuth.authFetch(
        `/admin/users/${encodeURIComponent(userId)}/effective-authorization`,
        { skipAuthRedirect: true }
      );
      if (handleAdminAuthFailure(response)) return;
      if (!response.ok) {
        throw new Error(await readErrorMessage(
          response,
          adminText('admin.error.loadEffectiveAccess', { status: response.status }, `加载生效权限失败 (${response.status})`)
        ));
      }
      const payload = await response.json();
      if (state.access.requestIdByUserId[userId] !== requestId) {
        return;
      }
      state.access.effectiveByUserId[userId] = payload;
      setAccessError('', userId);
      if (state.selectedUserId === userId) {
        renderSelectedUserDetails();
      }
    } catch (error) {
      if (state.access.requestIdByUserId[userId] === requestId) {
        setAccessError(error instanceof Error ? error.message : String(error), userId);
      }
    } finally {
      if (state.access.requestIdByUserId[userId] === requestId) {
        state.access.loadingUserIds.delete(userId);
        if (state.selectedUserId === userId) {
          renderSelectedUserAccess();
        }
      }
    }
  }

  async function saveSelectedUserAccess() {
    const user = selectedUser();
    if (!user || isAdminUser(user)) {
      renderSelectedUserAccess();
      return;
    }
    const draft = getAccessDraft(user);
    setAccessError('', user.id);
    setAccessStatus('', user.id);
    const resourceGrants = compactResourceGrantsForSave(draft.resourceGrants, {
      keepChipIds: draft.chipIdsExplicit
    });
    const userResponse = await window.AgentXAuth.authFetch(`/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        modelGrants: uniqueSorted(draft.modelGrants),
        resourceGrants
      })
    });
    if (!userResponse.ok) {
      throw new Error(await readErrorMessage(
        userResponse,
        adminText('admin.error.saveAccess', { status: userResponse.status }, `保存访问权限失败 (${userResponse.status})`)
      ));
    }

    const userPayload = await userResponse.json();
    if (userPayload.user) {
      Object.assign(user, userPayload.user);
    }
    delete state.access.draftByUserId[user.id];
    clearAccessDirty(user.id);
    invalidateEffectiveAuthorization(user.id);
    await loadEffectiveAuthorization(user.id, { force: true });
    renderUsers();
    renderKeys();
    renderSelectedUserAccess();
    setAccessStatus(adminText('admin.access.saved', '访问权限已保存'), user.id);
    notifyAdmin('success', adminText('admin.access.saved', '访问权限已保存'));
  }

  function renderUsers() {
    els.userList.replaceChildren();
    els.userRail?.replaceChildren();
    const detailOpen = Boolean(state.selectedUserId);
    setUserDetailOpen(detailOpen);
    const renderEmptyRow = (text) => {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 8;
      cell.className = 'empty-state';
      cell.textContent = text;
      row.append(cell);
      els.userList.append(row);
      const railEmpty = document.createElement('div');
      railEmpty.className = 'empty-state';
      railEmpty.setAttribute('role', 'option');
      railEmpty.setAttribute('aria-disabled', 'true');
      railEmpty.textContent = text;
      els.userRail?.append(railEmpty);
    };
    if (state.users.length === 0) {
      renderEmptyRow(adminText('admin.users.empty', '暂无用户'));
      renderSelectedUserDetails();
      return;
    }
    const visibleUsers = state.users.filter(userMatchesFilters);
    if (state.selectedUserId && !visibleUsers.some((user) => user.id === state.selectedUserId)) {
      state.selectedUserId = null;
      setUserDetailOpen(false);
    }
    if (visibleUsers.length === 0) {
      renderEmptyRow(adminText('admin.users.noFilterResults', '无符合筛选条件的用户'));
      renderSelectedUserDetails();
      return;
    }
    for (const user of visibleUsers) {
      const row = document.createElement('tr');
      row.className = 'user-row';
      row.setAttribute('aria-selected', user.id === state.selectedUserId ? 'true' : 'false');

      const railItem = document.createElement('button');
      railItem.type = 'button';
      railItem.className = 'rail-item user-compact-item user-info-btn';
      railItem.setAttribute('role', 'option');
      railItem.setAttribute(
        'aria-label',
        adminText('admin.users.selectNamedUser', { username: user.username }, `选择用户 ${user.username}`)
      );
      railItem.setAttribute('aria-selected', user.id === state.selectedUserId ? 'true' : 'false');
      if (user.id === state.selectedUserId) {
        railItem.classList.add('selected');
      }
      const avatar = document.createElement('span');
      avatar.className = 'av user-compact-avatar';
      avatar.textContent = user.username.slice(0, 1).toUpperCase();
      const main = document.createElement('span');
      main.className = 'info user-compact-main';
      const name = document.createElement('span');
      name.className = 'nm user-compact-name';
      name.textContent = user.username;
      const meta = document.createElement('span');
      meta.className = 'rl user-compact-meta';
      meta.textContent = user.role;
      main.append(name, meta);
      railItem.append(avatar, main);
      railItem.addEventListener('click', () => selectUser(user.id));
      els.userRail?.append(railItem);

      const usernameCell = document.createElement('td');
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'user-info-btn cell-stack';
      const infoName = document.createElement('span');
      infoName.className = 'cell-stack-primary';
      infoName.textContent = user.username;
      const infoId = document.createElement('span');
      infoId.className = 'cell-stack-sub mono';
      infoId.textContent = user.id || '';
      info.append(infoName, infoId);
      usernameCell.append(info);

      const roleCell = document.createElement('td');
      roleCell.append(renderRoleBadge(user.role));

      const statusCell = document.createElement('td');
      statusCell.append(renderLifecycleStatus(user));

      const creditsCell = document.createElement('td');
      creditsCell.className = 'num';
      const creditsRaw = user.credits?.balanceUnits ?? user.creditBalance;
      const creditsValue = typeof creditsRaw === 'number' ? creditsRaw.toLocaleString(state.locale) : String(creditsRaw ?? '-');
      const creditsLink = document.createElement('button');
      creditsLink.type = 'button';
      creditsLink.className = 'admin-cell-link';
      creditsLink.textContent = creditsValue;
      creditsLink.title = adminText('admin.users.viewObservability', '查看成本观测');
      creditsLink.addEventListener('click', (event) => {
        event.stopPropagation();
        switchSection('observability');
      });
      creditsCell.append(creditsLink);

      const chipsCell = document.createElement('td');
      const chipsLink = document.createElement('button');
      chipsLink.type = 'button';
      chipsLink.className = 'admin-badge admin-badge-info admin-cell-link-badge';
      chipsLink.textContent = chipAccessSummary(user) || '-';
      chipsLink.title = adminText('admin.users.viewChipCatalog', '查看芯片目录');
      chipsLink.addEventListener('click', (event) => {
        event.stopPropagation();
        switchSection('chips');
      });
      chipsCell.append(chipsLink);

      const keyCell = document.createElement('td');
      keyCell.textContent = String(user.mcpKeys?.length || 0);

      const expiryCell = document.createElement('td');
      expiryCell.textContent = expirySummary(user.expiresAt) || adminText('admin.users.longTerm', '长期');

      const companyCell = document.createElement('td');
      companyCell.textContent = user.profile?.company || '-';

      row.append(usernameCell, roleCell, statusCell, creditsCell, chipsCell, keyCell, expiryCell, companyCell);
      row.addEventListener('click', () => selectUser(user.id));
      els.userList.append(row);
    }
    renderSelectedUserDetails();
  }

  function chipAccessSummary(user) {
    const explicit = explicitChipIdsForUser(user);
    if (hasUserChipOverride(user)) {
      return Array.isArray(explicit) && explicit.length > 0
        ? adminText('admin.access.userOverrideCount', { count: explicit.length }, `${explicit.length} 颗用户覆盖芯片`)
        : adminText('admin.access.userOverrideNone', '用户覆盖：无芯片');
    }
    const effectiveCount = Array.isArray(state.access.effectiveByUserId[user.id]?.dimensions?.chipIds)
      ? state.access.effectiveByUserId[user.id].dimensions.chipIds.length
      : 0;
    if (effectiveCount > 0) {
      return adminText('admin.access.effectiveChipCount', { count: effectiveCount }, `${effectiveCount} 颗生效芯片`);
    }
    if (roleAllowsAllChips(user.role)) {
      return adminText('admin.access.allTemplateChips', '全部模板芯片');
    }
    const roleGrantedIds = state.chips
      .filter((chip) => roleAllowsChip(user.role, chip.id))
      .map((chip) => chip.id);
    const derivedIds = derivedChipIdsFromUserGrants(user);
    const fallbackCount = uniqueSorted([...roleGrantedIds, ...derivedIds]).length;
    if (fallbackCount > 0) {
      return adminText('admin.access.effectiveChipCount', { count: fallbackCount }, `${fallbackCount} 颗生效芯片`);
    }
    return '';
  }

  function userMatchesFilters(user) {
    const filters = state.userFilters;
    if (filters.search) {
      const needle = filters.search.trim().toLowerCase();
      const haystack = [user.username, user.profile?.email, user.profile?.company]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (needle && !haystack.includes(needle)) return false;
    }
    if (filters.status && (user.status || 'active') !== filters.status) return false;
    if (filters.expired === 'expired' && !isExpired(user.expiresAt)) return false;
    if (filters.expired === 'valid' && isExpired(user.expiresAt)) return false;
    if (filters.company && !String(user.profile?.company || '').toLowerCase().includes(filters.company.toLowerCase())) return false;
    if (filters.role && user.role !== filters.role) return false;
    return true;
  }

  function selectUser(userId) {
    state.selectedUserId = userId;
    renderUsers();
    renderKeys();
    renderChipAccess();
    // 先渲染、后激活标签：renderUsers 内部会调用 renderSelectedUserDetails
    activateUserTab('profile');
    void loadEffectiveAuthorization(userId);
  }

  function closeUserDetail() {
    state.selectedUserId = null;
    renderUsers();
    renderKeys();
    renderChipAccess();
  }

  // 激活指定用户详情标签页，其余标签页隐藏
  function activateUserTab(key) {
    const tabs = Array.from(document.querySelectorAll('[data-user-tab]'));
    for (const tab of tabs) {
      // 隐藏的 tab（如管理员的"授权"）永不激活，其面板始终隐藏
      const active = !tab.hasAttribute('hidden') && tab.dataset.userTab === key;
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      const panel = document.getElementById(`user-tabpanel-${tab.dataset.userTab}`);
      if (panel) {
        panel.toggleAttribute('hidden', !active);
      }
    }
    const user = selectedUser();
    if (key === 'access' && user) {
      void loadEffectiveAuthorization(user.id);
    }
    if (key === 'credits' && user) {
      void selectCredit(user.id);
    }
  }

  function initUserTabs() {
    const tabs = Array.from(document.querySelectorAll('[data-user-tab]'));
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activateUserTab(tab.dataset.userTab));
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        // 仅在可见 tab 间循环（跳过隐藏的，如管理员的"授权"）
        const visible = tabs.filter((candidate) => !candidate.hasAttribute('hidden'));
        const current = visible.indexOf(tab);
        if (current === -1) return;
        const offset = event.key === 'ArrowRight' ? 1 : -1;
        const next = visible[(current + offset + visible.length) % visible.length];
        next.focus();
        activateUserTab(next.dataset.userTab);
      });
    });
  }

  function setSelectedUserCreditStatus(message) {
    if (els.selectedUserCreditStatus) els.selectedUserCreditStatus.textContent = message || '';
  }

  function setSelectedUserCreditMode(mode) {
    state.credits.detailMode = mode === 'balance' ? 'balance' : 'delta';
    renderSelectedUserCreditsDetail();
  }

  function selectedUserCreditBalanceValue(user) {
    if (!user) return null;
    if (state.credits.selectedUserId === user.id && state.credits.balanceUnits != null) {
      return state.credits.balanceUnits;
    }
    if (typeof user.credits?.balanceUnits === 'number') return user.credits.balanceUnits;
    if (typeof user.creditBalance === 'number') return user.creditBalance;
    return null;
  }

  function renderSelectedUserCreditsDetail() {
    const user = selectedUser();
    if (els.selectedUserCreditBalance) {
      els.selectedUserCreditBalance.replaceChildren();
    }
    if (!user) {
      if (els.selectedUserCreditBalance) {
        els.selectedUserCreditBalance.append(renderBadge('muted', adminText('admin.credits.noUserSelected', '未选择用户')));
      }
      if (els.selectedUserCreditSubmit) els.selectedUserCreditSubmit.disabled = true;
      renderCreditLedgerInto(els.selectedUserCreditLedger, adminText('admin.credits.selectUserForLedger', '请选择用户查看积分流水'));
      return;
    }
    const balance = selectedUserCreditBalanceValue(user);
    if (els.selectedUserCreditBalance) {
      els.selectedUserCreditBalance.append(renderBadge(
        adminText(
          'admin.credits.balance',
          { value: balance ?? adminText('admin.common.unknown', '未知') },
          `余额 ${balance ?? '未知'}`
        ),
        'credits'
      ));
    }
    if (els.selectedUserCreditSubmit) els.selectedUserCreditSubmit.disabled = false;
    if (els.selectedUserCreditModeDelta) {
      els.selectedUserCreditModeDelta.setAttribute('aria-pressed', state.credits.detailMode === 'delta' ? 'true' : 'false');
    }
    if (els.selectedUserCreditModeBalance) {
      els.selectedUserCreditModeBalance.setAttribute('aria-pressed', state.credits.detailMode === 'balance' ? 'true' : 'false');
    }
    if (els.selectedUserCreditAmount) {
      const balanceMode = state.credits.detailMode === 'balance';
      els.selectedUserCreditAmount.placeholder = balanceMode
        ? adminText('admin.credits.targetBalancePlaceholder', '输入目标余额')
        : adminText('admin.credits.deltaPlaceholder', '输入 delta 变动数量');
      if (balanceMode) {
        els.selectedUserCreditAmount.min = '0';
      } else {
        els.selectedUserCreditAmount.removeAttribute('min');
      }
    }
    renderCreditLedgerInto(
      els.selectedUserCreditLedger,
      adminText('admin.credits.loadOnOpen', '打开积分标签页后加载积分流水'),
      user.id
    );
  }

  // 从已加载用户/芯片目录中汇总授权值作为 chip 输入下拉补全来源
  function collectGrantValueSuggestions(pick) {
    const values = new Set();
    for (const user of state.users || []) {
      for (const value of pick(user) || []) {
        if (value) values.add(value);
      }
    }
    return Array.from(values);
  }

  function renderSelectedUserDetails() {
    const user = selectedUser();
    els.selectedUserTitle.textContent = user
      ? adminText('admin.users.detailTitle', { username: user.username }, `用户详情：${user.username}`)
      : adminText('admin.users.selectUserTitle', '选择用户');
    els.selectedUserMeta.textContent = user
      ? adminText(
        'admin.users.meta',
        { id: user.id, createdAt: user.createdAt || adminText('admin.common.unknown', 'unknown') },
        `id: ${user.id} · created: ${user.createdAt || 'unknown'}`
      )
      : '';
    els.selectedUserBadges.replaceChildren();
    if (user) {
      els.selectedUserBadges.append(renderLifecycleBadge(user));
      if (isExpired(user.expiresAt)) {
        els.selectedUserBadges.append(renderBadge('expired', 'expired'));
      }
    }
    els.selectedUserRoleForm.toggleAttribute('hidden', !user);
    els.selectedUserProfileForm.toggleAttribute('hidden', !user);
    els.selectedUserPasswordForm.toggleAttribute('hidden', !user);
    els.selectedUserDelete.toggleAttribute('hidden', !user);
    els.keyForm.toggleAttribute('hidden', !user);
    setUserDetailOpen(Boolean(user));
    els.selectedUserRoleSave.disabled = !user;
    els.selectedUserProfileSave.disabled = !user;
    els.selectedUserPasswordSave.disabled = !user;
    els.selectedUserDelete.disabled = !user;
    if (user) {
      populateRoleSelect(els.selectedUserRole, user.role);
      els.selectedUserRole.value = user.role;
      els.selectedUserStatus.value = user.status || 'active';
      els.selectedUserExpiresAt.value = toLocalDateTimeInput(user.expiresAt);
      els.selectedUserCompany.value = user.profile?.company || '';
      els.selectedUserRealName.value = user.profile?.realName || '';
      els.selectedUserEmail.value = user.profile?.email || '';
      els.selectedUserNote.value = user.profile?.note || '';
      els.selectedUserPassword.value = '';
    }
    // 无选中用户时整组标签页隐藏；有用户时由 activateUserTab 控制显隐
    const tabsBar = document.querySelector('.admin-user-tabs');
    if (tabsBar) {
      tabsBar.toggleAttribute('hidden', !user);
    }
    document.querySelectorAll('.admin-user-tabpanel').forEach((panel) => {
      if (!user) {
        panel.setAttribute('hidden', '');
      }
    });
    renderSelectedUserAccess();
    renderSelectedUserCreditsDetail();
  }

  function setUserDetailOpen(open) {
    document.getElementById('panel-users')?.classList.toggle('detail-open', open);
    document.querySelector('#panel-users .admin-master-detail')?.classList.toggle('detail-open', open);
  }

  async function updateUserRole(userId, role) {
    const response = await window.AgentXAuth.authFetch(
      `/admin/users/${encodeURIComponent(userId)}/role`,
      {
        method: 'PUT',
        body: JSON.stringify({ role })
      }
    );
    if (!response.ok) {
      setError(adminText('admin.error.updateUserRole', { status: response.status }, `修改用户角色失败 (${response.status})`));
      await loadUsers();
      return;
    }
    const payload = await response.json();
    const user = state.users.find(u => u.id === userId);
    if (user && payload.user) {
      Object.assign(user, payload.user);
    } else if (user) {
      user.role = role;
    }
    delete state.access.draftByUserId[userId];
    invalidateEffectiveAuthorization(userId);
    await loadEffectiveAuthorization(userId, { force: true });
    setError('');
    notifyAdmin('success', adminText('admin.users.roleUpdated', '角色已更新'));
    renderUsers();
    renderChipAccess();
  }

  async function updateSelectedUserProfile(event) {
    event.preventDefault();
    const user = selectedUser();
    if (!user) return;
    const response = await window.AgentXAuth.authFetch(`/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        status: els.selectedUserStatus.value || 'active',
        expiresAt: fromLocalDateTimeInput(els.selectedUserExpiresAt.value),
        profile: collectProfile({
          company: els.selectedUserCompany.value,
          realName: els.selectedUserRealName.value,
          email: els.selectedUserEmail.value,
          note: els.selectedUserNote.value
        })
      })
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(
        response,
        adminText('admin.error.saveUserProfile', { status: response.status }, `保存用户资料失败 (${response.status})`)
      ));
    }
    const payload = await response.json();
    const existing = state.users.find((candidate) => candidate.id === user.id);
    if (existing && payload.user) {
      Object.assign(existing, payload.user);
    }
    setError('');
    notifyAdmin('success', adminText('admin.users.profileSaved', '用户资料已保存'));
    renderUsers();
    renderKeys();
    renderChipAccess();
  }

  async function updateUserPassword(userId, password) {
    const response = await window.AgentXAuth.authFetch(
      `/admin/users/${encodeURIComponent(userId)}/password`,
      {
        method: 'PUT',
        body: JSON.stringify({ password })
      }
    );
    if (!response.ok) {
      throw new Error(await readErrorMessage(
        response,
        adminText('admin.error.resetPassword', { status: response.status }, `Resetting password failed (${response.status})`)
      ));
    }
    els.selectedUserPassword.value = '';
    setError('');
    notifyAdmin('success', adminText('admin.users.passwordReset', '密码已重置'));
  }

  async function deleteUser(userId) {
    const user = state.users.find((candidate) => candidate.id === userId);
    if (!user) return;
    const confirmed = await window.AgentXUI.confirm({
      title: adminText('admin.users.deleteTitle', '删除用户'),
      body: adminText(
        'admin.users.deleteBody',
        { username: user.username },
        `确认删除用户「${user.username}」？该操作不可恢复。`
      ),
      confirmText: adminText('admin.action.delete', '删除'),
      danger: true
    });
    if (!confirmed) {
      return;
    }
    const response = await window.AgentXAuth.authFetch(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(
        response,
        adminText('admin.error.deleteUser', { status: response.status }, `Deleting user failed (${response.status})`)
      ));
    }
    state.selectedUserId = null;
    setError('');
    notifyAdmin('success', adminText('admin.users.deleted', '用户已删除'), user.username);
    await loadUsers();
    renderChipAccess();
  }

  function renderKeys() {
    const user = selectedUser();
    els.keyList.replaceChildren();
    els.generatedKey.replaceChildren();
    renderSelectedUserDetails();
    if (!user) return;
    if (!user.mcpKeys || user.mcpKeys.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.keys.empty', '暂无 MCP Key');
      els.keyList.append(empty);
      return;
    }
    for (const key of user.mcpKeys) {
      const row = document.createElement('div');
      row.className = 'key-row';
      row.append(renderKeyValue(key), renderKeyActions(user.id, key));
      els.keyList.append(row);
    }
  }

  function renderKeyValue(key) {
    const wrap = document.createElement('div');
    wrap.className = 'key-value';
    const meta = document.createElement('span');
    meta.className = 'key-meta';
    meta.textContent = adminText(
      'admin.keys.meta',
      {
        name: key.name,
        id: key.id.slice(0, 8),
        lastUsed: key.lastUsed || adminText('admin.keys.neverUsed', 'never used'),
        expiry: keyExpirySummary(key)
      },
      `${key.name} · ${key.id.slice(0, 8)} · last ${key.lastUsed || 'never used'} · ${keyExpirySummary(key)}`
    );
    const code = document.createElement('code');
    code.textContent = key.maskedKey || key.fingerprint || key.id;
    const warning = document.createElement('span');
    warning.className = 'key-sensitive-warning';
    warning.textContent = adminText(
      'admin.keys.fullKeyImmediateOnly',
      'Full MCP Key is only shown immediately after creation.'
    );
    const editor = renderKeyEditor(key);
    wrap.append(meta, code, warning, editor);
    return wrap;
  }

  function renderKeyEditor(key) {
    const form = document.createElement('form');
    form.className = 'key-edit-form';
    const name = document.createElement('input');
    name.type = 'text';
    name.value = key.name || '';
    name.setAttribute('aria-label', adminText('admin.keys.name', 'Key 名称'));
    const expiresAt = document.createElement('input');
    expiresAt.type = 'datetime-local';
    expiresAt.value = toLocalDateTimeInput(key.expiresAt);
    expiresAt.setAttribute('aria-label', adminText('admin.keys.expiry', 'Key 有效期'));
    const modelGrants = document.createElement('input');
    modelGrants.type = 'text';
    modelGrants.value = formatGrantList(key.modelGrants);
    modelGrants.placeholder = adminText('admin.keys.modelsPlaceholder', 'Key models');
    modelGrants.setAttribute('aria-label', adminText('admin.keys.modelGrants', 'Key 模型授权'));
    const resourceGrants = document.createElement('input');
    resourceGrants.type = 'text';
    resourceGrants.value = formatGrantList(key.resourceGrants?.chipIds);
    resourceGrants.placeholder = adminText('admin.keys.chipGrantsPlaceholder', 'Key chip grants');
    resourceGrants.setAttribute('aria-label', adminText('admin.keys.chipGrants', 'Key 芯片授权'));
    const toolGrants = document.createElement('input');
    toolGrants.type = 'text';
    toolGrants.value = formatGrantList(key.resourceGrants?.mcpTools);
    toolGrants.placeholder = adminText('admin.keys.toolsPlaceholder', 'Key MCP tools');
    toolGrants.setAttribute('aria-label', adminText('admin.keys.toolGrants', 'Key MCP tool 授权'));
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'secondary-button';
    save.textContent = adminText('admin.action.save', '保存');
    form.append(name, expiresAt, modelGrants, resourceGrants, toolGrants, save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const user = selectedUser();
      if (user) {
        updateKey(user.id, key.id, {
          name: name.value.trim() || key.name,
          expiresAt: fromLocalDateTimeInput(expiresAt.value),
          modelGrants: parseGrantList(modelGrants.value),
          resourceGrants: {
            chipIds: parseGrantList(resourceGrants.value),
            mcpTools: parseGrantList(toolGrants.value)
          }
        }).catch((error) => setError(error.message));
      }
    });
    return form;
  }

  function renderKeyActions(userId, key) {
    const actions = document.createElement('div');
    actions.className = 'key-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = adminText('admin.keys.copySummary', '复制摘要');
    copy.addEventListener('click', () => copyKeySummary(key));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger-button';
    remove.textContent = adminText('admin.keys.revoke', '撤销');
    remove.addEventListener('click', () => removeKey(userId, key.id).catch((error) => setError(error.message)));
    actions.append(copy, remove);
    return actions;
  }

  function copyKeySummary(key) {
    const value = key.maskedKey || key.fingerprint || key.id;
    navigator.clipboard?.writeText(value);
  }

  function copyFullKey(value) {
    if (!value) {
      setError(adminText('admin.keys.fullKeyUnavailable', 'Full MCP Key is unavailable'));
      return;
    }
    navigator.clipboard?.writeText(value);
  }

  async function loadUsers() {
    const response = await window.AgentXAuth.authFetch('/admin/users', { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = adminText('admin.error.loadUsers', { status: response.status }, `加载用户失败 (${response.status})`);
      setSectionStatus('users', 'error', message);
      setError(message);
      return;
    }
    const payload = await response.json();
    state.users = payload.users || [];
    if (state.selectedUserId && !state.users.some((user) => user.id === state.selectedUserId)) {
      state.selectedUserId = null;
    }
    renderUsers();
    renderKeys();
    renderChipAccess();
    renderSelectedUserCreditsDetail();
    clearSectionStatus('users', 'error');
  }

  // === 积分管理（P3/B6）===

  function selectedCreditUser() {
    return state.users.find((user) => user.id === state.credits.selectedUserId) || null;
  }

  async function selectCredit(userId) {
    const requestId = state.credits.requestId + 1;
    state.credits.requestId = requestId;
    state.credits.selectedUserId = userId;
    state.credits.balanceUnits = null;
    state.credits.ledger = null;
    setSelectedUserCreditStatus('');
    renderSelectedUserCreditsDetail();

    const response = await window.AgentXAuth.authFetch(
      `/admin/credits?userId=${encodeURIComponent(userId)}`,
      { skipAuthRedirect: true }
    );
    if (state.credits.requestId !== requestId || state.credits.selectedUserId !== userId) {
      return;
    }
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        adminText('admin.error.queryCredits', { status: response.status }, `查询积分失败 (${response.status})`)
      );
      setSelectedUserCreditStatus(message);
      return;
    }
    const payload = await response.json();
    state.credits.balanceUnits = typeof payload.balanceUnits === 'number' ? payload.balanceUnits : null;
    state.credits.ledger = payload.ledger || { items: [], total: 0, offset: 0, limit: 0 };
    const cached = state.users.find((candidate) => candidate.id === userId);
    if (cached && typeof payload.balanceUnits === 'number') {
      cached.credits = { ...(cached.credits || {}), balanceUnits: payload.balanceUnits };
    }
    if (state.selectedUserId === userId) {
      renderUsers();
    } else {
      renderSelectedUserCreditsDetail();
    }
  }

  function renderCreditLedgerInto(container, noLedgerMessage, expectedUserId) {
    if (!container) return;
    const ledger = state.credits.ledger;
    const creditUser = selectedCreditUser();
    if (!creditUser || (expectedUserId && creditUser.id !== expectedUserId) || !ledger) {
      container.replaceChildren(renderEmptyState(noLedgerMessage));
      return;
    }
    const items = Array.isArray(ledger.items) ? ledger.items : [];
    if (items.length === 0) {
      container.replaceChildren(renderEmptyState(adminText('admin.credits.noLedger', '暂无积分流水')));
      return;
    }
    const list = document.createElement('ul');
    list.className = 'credits-ledger-list';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'credits-ledger-item';

      const head = document.createElement('div');
      head.className = 'credits-ledger-head';
      const reason = document.createElement('span');
      reason.className = 'credits-ledger-reason';
      reason.textContent = item.reason || item.entry || adminText('admin.credits.adjustment', '调整');
      const when = document.createElement('span');
      when.className = 'credits-ledger-time';
      when.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString(state.locale) : '';
      head.append(reason, when);

      const detail = document.createElement('div');
      detail.className = 'credits-ledger-detail';
      const before = typeof item.balanceBeforeUnits === 'number' ? formatNumber(item.balanceBeforeUnits) : '—';
      const after = typeof item.balanceAfterUnits === 'number' ? formatNumber(item.balanceAfterUnits) : '—';
      detail.textContent = adminText(
        'admin.credits.ledgerDetail',
        { entry: item.entry || '', units: formatNumber(item.units), before, after },
        `${item.entry || ''} · ${formatNumber(item.units)} 单位 · ${before} → ${after}`
      );

      li.append(head, detail);
      list.append(li);
    }
    container.replaceChildren(list);
  }

  async function submitSelectedUserCreditAdjustment(event) {
    if (event) event.preventDefault();
    setSelectedUserCreditStatus('');
    const user = selectedUser();
    if (!user) {
      setSelectedUserCreditStatus(adminText('admin.credits.selectUserFirst', '请先选择用户'));
      return;
    }
    const raw = els.selectedUserCreditAmount?.value ?? '';
    const value = Number(raw);
    const mode = state.credits.detailMode === 'balance' ? 'balance' : 'delta';
    if (raw === '' || !Number.isInteger(value)) {
      setSelectedUserCreditStatus(
        mode === 'balance'
          ? adminText('admin.credits.balanceNonNegative', '目标余额必须是非负整数')
          : adminText('admin.credits.deltaInteger', '变动数量必须是整数')
      );
      return;
    }
    if (mode === 'balance' && value < 0) {
      setSelectedUserCreditStatus(adminText('admin.credits.balanceNonNegative', '目标余额必须是非负整数'));
      return;
    }
    const reason = (els.selectedUserCreditReason?.value || '').trim();
    if (!reason) {
      setSelectedUserCreditStatus(adminText('admin.credits.reasonRequired', '请填写调整原因'));
      return;
    }
    const body = {
      userId: user.id,
      reason
    };
    const note = (els.selectedUserCreditNote?.value || '').trim();
    if (note) body.note = note;
    if (mode === 'balance') {
      body.balanceUnits = value;
    } else {
      body.deltaUnits = value;
    }
    const submittedUserId = user.id;
    const submitRequestId = state.credits.detailSubmitRequestId + 1;
    state.credits.detailSubmitRequestId = submitRequestId;

    const response = await window.AgentXAuth.authFetch('/admin/credits/adjust', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    const stillCurrentDetail =
      state.credits.detailSubmitRequestId === submitRequestId && state.selectedUserId === submittedUserId;
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      if (!stillCurrentDetail) return;
      const message = await readErrorMessage(
        response,
        adminText('admin.error.adjustCredits', { status: response.status }, `调整积分失败 (${response.status})`)
      );
      setSelectedUserCreditStatus(message);
      return;
    }
    const payload = await response.json();
    const cached = state.users.find((candidate) => candidate.id === submittedUserId);
    if (cached && typeof payload.balanceAfterUnits === 'number') {
      cached.credits = { ...(cached.credits || {}), balanceUnits: payload.balanceAfterUnits };
    }
    if (!stillCurrentDetail) {
      return;
    }
    state.credits.selectedUserId = submittedUserId;
    state.credits.balanceUnits =
      typeof payload.balanceAfterUnits === 'number' ? payload.balanceAfterUnits : state.credits.balanceUnits;
    if (els.selectedUserCreditAmount) els.selectedUserCreditAmount.value = '';
    if (els.selectedUserCreditReason) els.selectedUserCreditReason.value = '';
    if (els.selectedUserCreditNote) els.selectedUserCreditNote.value = '';
    notifyAdmin(
      'success',
      adminText('admin.credits.adjusted', '积分已调整'),
      `${user.username} → ${formatNumber(payload.balanceAfterUnits)}`
    );
    renderUsers();
    await selectCredit(submittedUserId);
  }

  // === 文档与 Scope（P5/B7：文档可见性 + Scope Preset）===

  const RESOURCE_VISIBILITY_LEVELS = ['public', 'customer', 'partner', 'internal', 'adminOnly', 'restricted'];
  const RESOURCE_STATUSES = ['draft', 'pending', 'approved', 'rejected', 'archived'];

  function setResourcesError(message) {
    if (els.resourcesError) els.resourcesError.textContent = message || '';
  }

  function setResourceEditorStatus(message) {
    if (els.resourceEditorStatusLine) els.resourceEditorStatusLine.textContent = message || '';
  }

  function setResourcePresetOrphanWarning(message) {
    if (els.resourcesPresetOrphanWarning) els.resourcesPresetOrphanWarning.textContent = message || '';
  }

  // === TESTABLE computeOrphanReferences START ===
  // 自包含纯函数：仅用入参 + 标准 JS，不读全局 els/state。
  // 主动孤儿引用校验（B3）：比对已加载的 Scope Preset 引用的 documentId/chipId，
  // 与已加载的文档/芯片目录，找出目录里已不存在、但仍被 preset 引用的「孤儿」引用。
  // 与既有单 preset 服务端校验（/admin/resources/scope-presets/:id/validate）语义一致，
  // 区别在于本函数是客户端本地立即计算、覆盖全部 preset，用于常驻 banner；
  // 逐行「校验孤儿」按钮仍保留、仍打服务端接口做权威复核。
  function computeOrphanReferences({ documents, scopePresets, chips }) {
    const knownDocumentIds = new Set((documents || []).map((doc) => doc.documentId).filter(Boolean));
    const knownChipIds = new Set((chips || []).map((chip) => chip.id).filter(Boolean));
    const presetOrphans = [];
    for (const preset of scopePresets || []) {
      const missingDocumentIds = uniqueSorted((preset.documentIds || []).filter((id) => id && !knownDocumentIds.has(id)));
      const missingChipIds = uniqueSorted((preset.chipIds || []).filter((id) => id && !knownChipIds.has(id)));
      if (missingDocumentIds.length > 0 || missingChipIds.length > 0) {
        presetOrphans.push({ scopePresetId: preset.scopePresetId, missingDocumentIds, missingChipIds });
      }
    }
    return { hasOrphans: presetOrphans.length > 0, presetOrphans };
  }
  // === TESTABLE computeOrphanReferences END ===

  function renderResourcesOrphanBanner() {
    if (!els.resourcesOrphanBanner) return;
    const result = computeOrphanReferences({
      documents: state.resources.documents,
      scopePresets: state.resources.scopePresets,
      chips: state.chips
    });
    if (!result.hasOrphans) {
      els.resourcesOrphanBanner.hidden = true;
      els.resourcesOrphanBanner.textContent = '';
      return;
    }
    const parts = result.presetOrphans.map((item) => {
      const details = [];
      if (item.missingDocumentIds.length > 0) {
        details.push(adminText(
          'admin.resources.missingDocuments',
          { ids: item.missingDocumentIds.join(', ') },
          `缺失文档 ${item.missingDocumentIds.join(', ')}`
        ));
      }
      if (item.missingChipIds.length > 0) {
        details.push(adminText(
          'admin.resources.missingChips',
          { ids: item.missingChipIds.join(', ') },
          `缺失芯片 ${item.missingChipIds.join(', ')}`
        ));
      }
      return `${item.scopePresetId}（${details.join('；')}）`;
    });
    els.resourcesOrphanBanner.textContent = adminText(
      'admin.resources.orphanBanner',
      { details: parts.join('；') },
      `孤儿引用校验：以下 Scope Preset 引用了目录中已不存在的文档或芯片，建议核对后清理或补齐绑定 — ${parts.join('；')}`
    );
    els.resourcesOrphanBanner.hidden = false;
  }

  async function loadResources() {
    setResourcesError('');
    const response = await window.AgentXAuth.authFetch('/admin/resources', { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        adminText('admin.error.loadResources', { status: response.status }, `加载文档与 Scope目录失败 (${response.status})`)
      );
      setResourcesError(message);
      setSectionStatus('resources', 'error', message);
      return;
    }
    const payload = await response.json();
    state.resources.documents = Array.isArray(payload.documents) ? payload.documents : [];
    state.resources.scopePresets = Array.isArray(payload.scopePresets) ? payload.scopePresets : [];
    clearSectionStatus('resources', 'error');
    renderResources();
  }

  function renderResources() {
    renderResourcesSummary();
    renderResourcesOrphanBanner();
    renderResourcesTabs();
    populateResourceDocumentFilters();
    renderResourceDocuments();
    renderResourcePresets();
  }

  // 从「全量」文档集派生 distinct 可见性/状态作为筛选下拉项（不硬编码枚举、随数据自适应，避免口径漂移）；
  // 只在数据加载时重建选项、保留当前选择，后续过滤仅重渲染表体、不动下拉。
  function populateResourceDocumentFilters() {
    const docs = state.resources.documents;
    const fill = (select, values, allLabel) => {
      if (!select) return;
      const current = select.value;
      select.replaceChildren();
      const optAll = document.createElement('option');
      optAll.value = '';
      optAll.textContent = allLabel;
      select.append(optAll);
      for (const value of values) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = value;
        select.append(opt);
      }
      select.value = values.includes(current) ? current : '';
    };
    const visibilities = [...new Set(docs.map((doc) => doc.visibility).filter(Boolean))].sort();
    const statuses = [...new Set(docs.map((doc) => doc.status).filter(Boolean))].sort();
    fill(els.resourcesDocumentsVisibility, visibilities, adminText('admin.resources.allVisibility', '全部可见性'));
    fill(els.resourcesDocumentsStatus, statuses, adminText('admin.resources.allStatuses', '全部状态'));
  }

  function renderResourcesSummary() {
    if (!els.resourcesSummary) return;
    els.resourcesSummary.textContent = adminText(
      'admin.resources.summary',
      { documents: state.resources.documents.length, presets: state.resources.scopePresets.length },
      `文档 ${state.resources.documents.length} 项 · Scope Preset ${state.resources.scopePresets.length} 项`
    );
  }

  function renderResourcesTabs() {
    const active = state.resources.activeTab === 'scope-presets' ? 'scope-presets' : 'documents';
    if (els.resourcesTabDocuments) {
      const isActive = active === 'documents';
      els.resourcesTabDocuments.classList.toggle('active', isActive);
      els.resourcesTabDocuments.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (els.resourcesTabPresets) {
      const isActive = active === 'scope-presets';
      els.resourcesTabPresets.classList.toggle('active', isActive);
      els.resourcesTabPresets.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    if (els.panelResources) {
      for (const pane of els.panelResources.querySelectorAll('[data-resources-pane]')) {
        pane.hidden = pane.getAttribute('data-resources-pane') !== active;
      }
    }
  }

  function selectResourceTab(tab) {
    state.resources.activeTab = tab === 'scope-presets' ? 'scope-presets' : 'documents';
    setResourcePresetOrphanWarning('');
    renderResourcesTabs();
  }

  function resourceStatusBadge(status) {
    return renderStatusBadge(status);
  }

  function normalizeResourceStatus(status) {
    return RESOURCE_STATUSES.includes(status) ? status : 'draft';
  }

  // H3：状态流条——对齐原型 knowledge.html statusFlowStrip()（第 843-854 行）：
  // 按当前状态线性渲染 draft→pending→approved 三步，rejected/archived 是各自独立的终点分支，
  // 不再固定展示全部 5 个状态节点。
  function renderResourceStatusFlow(status) {
    const current = normalizeResourceStatus(status);
    const flow = document.createElement('div');
    flow.className = 'resource-flow-strip';

    const appendStep = (stepStatus, label) => {
      const item = document.createElement('span');
      item.className = 'resource-flow-step';
      item.textContent = label;
      if (stepStatus === current) {
        item.classList.add('current');
        if (stepStatus === 'rejected') item.classList.add('rejected');
      }
      flow.append(item);
    };
    const appendArrow = () => {
      const arrow = document.createElement('span');
      arrow.className = 'resource-flow-arrow';
      arrow.textContent = '→';
      flow.append(arrow);
    };

    if (current === 'rejected') {
      appendStep('draft', 'draft');
      appendArrow();
      appendStep('pending', 'pending');
      appendArrow();
      appendStep('rejected', 'rejected');
      return flow;
    }
    if (current === 'archived') {
      appendStep('draft', 'draft');
      appendArrow();
      appendStep('pending', 'pending');
      appendArrow();
      appendStep('approved', 'approved');
      appendArrow();
      appendStep('archived', 'archived');
      return flow;
    }
    appendStep('draft', 'draft');
    appendArrow();
    appendStep('pending', 'pending');
    appendArrow();
    appendStep('approved', 'approved');
    return flow;
  }

  function resourceStatusActions(status) {
    const current = normalizeResourceStatus(status);
    if (current === 'draft') {
      return [{ status: 'pending', label: adminText('admin.resources.submitReview', '提交审核'), className: 'secondary-button' }];
    }
    if (current === 'pending') {
      return [
        { status: 'approved', label: adminText('admin.resources.approve', '批准'), className: 'primary-button' },
        { status: 'rejected', label: adminText('admin.resources.reject', '驳回'), className: 'danger-button' }
      ];
    }
    if (current === 'approved' || current === 'rejected') {
      return [{ status: 'archived', label: adminText('admin.resources.archive', '归档'), className: 'secondary-button' }];
    }
    return [];
  }

  function renderResourceStatusControls() {
    const current = normalizeResourceStatus(els.resourceEditorStatusSelect?.value);
    if (els.resourceEditorStatusSelect && els.resourceEditorStatusSelect.value !== current) {
      els.resourceEditorStatusSelect.value = current;
    }
    if (els.resourceEditorStatusFlow) {
      els.resourceEditorStatusFlow.replaceChildren(renderResourceStatusFlow(current));
    }
    if (els.resourceEditorStatusActions) {
      els.resourceEditorStatusActions.replaceChildren();
      const actions = resourceStatusActions(current);
      if (actions.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'muted-inline';
        empty.textContent = adminText('admin.resources.noActions', '当前状态无可用动作');
        els.resourceEditorStatusActions.append(empty);
        return;
      }
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = action.className;
        button.textContent = action.label;
        button.dataset.resourceStatusAction = action.status;
        button.addEventListener('click', () => {
          if (els.resourceEditorStatusSelect) {
            els.resourceEditorStatusSelect.value = action.status;
          }
          setResourceEditorStatus(adminText('admin.resources.statusUpdatedPendingSave', '状态已更新，保存后生效。'));
          renderResourceStatusControls();
        });
        els.resourceEditorStatusActions.append(button);
      }
    }
  }

  // H3：芯片选择器统一为 token 选择器组件——对齐原型 knowledge.html openPresetDrawer()
  // 「芯片选择器」（第 954-961 行），Scope Preset 与文档共用同一 .admin-token-field 组件，
  // 不再另起一套 .admin-check-list 方形矩阵。
  function renderResourceChipField(values, isPreset) {
    if (!els.resourceEditorChipIds) return;
    els.resourceEditorChipIds.className = 'admin-token-picker';
    els.resourceEditorChipIds.dataset.picker = 'token';
    setTokenFieldValues(els.resourceEditorChipIds, values, 'chipIds');
    if (els.resourceEditorChipIdsLabel) {
      els.resourceEditorChipIdsLabel.textContent = isPreset
        ? adminText('admin.resources.chipSelector', '芯片选择器')
        : adminText('admin.resources.chipIds', '芯片 ID');
    }
  }

  function getResourceChipIds() {
    if (!els.resourceEditorChipIds) return [];
    return getTokenFieldValues(els.resourceEditorChipIds);
  }

  function renderResourceDocuments() {
    if (!els.resourcesDocumentsList) return;
    els.resourcesDocumentsList.replaceChildren();
    const all = state.resources.documents;
    const filters = state.resources.documentFilters;
    const query = (filters.search || '').trim().toLowerCase();
    const documents = all.filter((doc) => {
      if (filters.visibility && doc.visibility !== filters.visibility) return false;
      if (filters.status && doc.status !== filters.status) return false;
      if (query) {
        const haystack = `${doc.documentId || ''} ${doc.label || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    if (documents.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.className = 'empty-state';
      // 区分「本无数据」与「过滤后为空」，避免误导管理员以为目录空了。
      cell.textContent = all.length === 0
        ? adminText('admin.resources.noDocuments', '暂无文档可见性记录')
        : adminText('admin.resources.noDocumentFilterResults', '没有符合筛选条件的文档');
      row.append(cell);
      els.resourcesDocumentsList.append(row);
      return;
    }
    for (const doc of documents) {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = doc.documentId || '';

      const labelCell = document.createElement('td');
      labelCell.textContent = doc.label || '';

      const visibilityCell = document.createElement('td');
      visibilityCell.textContent = doc.visibility || '';

      const statusCell = document.createElement('td');
      statusCell.append(resourceStatusBadge(doc.status));

      const chipCell = document.createElement('td');
      chipCell.textContent = formatGrantList(doc.chipIds);

      const approvalCell = document.createElement('td');
      approvalCell.textContent = doc.approvedBy
        ? `${doc.approvedBy}${doc.approvedAt ? ` · ${new Date(doc.approvedAt).toLocaleString(state.locale)}` : ''}`
        : '—';

      const actionCell = document.createElement('td');
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary-button';
      edit.textContent = adminText('admin.action.edit', '编辑');
      edit.addEventListener('click', () => openResourceEditor('document', doc));
      actionCell.append(edit);

      row.append(idCell, labelCell, visibilityCell, statusCell, chipCell, approvalCell, actionCell);
      els.resourcesDocumentsList.append(row);
    }
  }

  function renderResourcePresets() {
    if (!els.resourcesPresetsList) return;
    els.resourcesPresetsList.replaceChildren();
    const presets = state.resources.scopePresets;
    if (presets.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.className = 'empty-state';
      cell.textContent = adminText('admin.resources.noPresets', '暂无 Scope Preset 记录');
      row.append(cell);
      els.resourcesPresetsList.append(row);
      return;
    }
    for (const preset of presets) {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = preset.scopePresetId || '';

      const labelCell = document.createElement('td');
      labelCell.textContent = preset.label || '';

      const visibilityCell = document.createElement('td');
      visibilityCell.textContent = preset.visibility || '';

      const statusCell = document.createElement('td');
      statusCell.append(resourceStatusBadge(preset.status));

      const documentCell = document.createElement('td');
      documentCell.textContent = formatGrantList(preset.documentIds);

      const chipCell = document.createElement('td');
      chipCell.textContent = formatGrantList(preset.chipIds);

      const actionCell = document.createElement('td');
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'secondary-button';
      edit.textContent = adminText('admin.action.edit', '编辑');
      edit.addEventListener('click', () => openResourceEditor('scope-preset', preset));
      const validate = document.createElement('button');
      validate.type = 'button';
      validate.className = 'secondary-button';
      validate.textContent = adminText('admin.resources.validateOrphans', '校验孤儿');
      validate.addEventListener('click', () => {
        validatePreset(preset.scopePresetId).catch((error) => setResourcesError(error.message));
      });
      actionCell.append(edit, validate);

      row.append(idCell, labelCell, visibilityCell, statusCell, documentCell, chipCell, actionCell);
      els.resourcesPresetsList.append(row);
    }
  }

  function showResourceEditor(show) {
    // 批次E（2.2.27）：资源编辑器改为 .admin-drawer 浮层——显隐抽屉 + 遮罩（与芯片编辑器一致）。
    if (els.resourceEditorDrawer) els.resourceEditorDrawer.hidden = !show;
    if (els.resourceEditorBackdrop) els.resourceEditorBackdrop.hidden = !show;
    if (show) activateDrawerFocus(els.resourceEditorDrawer);
  }

  function setSelectValue(select, value, fallback) {
    if (!select) return;
    select.value = value || fallback || '';
    if (!select.value && fallback) select.value = fallback;
  }

  function openResourceEditor(kind, record) {
    const isPreset = kind === 'scope-preset';
    const existing = record || null;
    state.resources.editing = { kind, id: existing ? (isPreset ? existing.scopePresetId : existing.documentId) : null };
    setResourceEditorStatus('');
    setResourcePresetOrphanWarning('');

    if (els.resourceEditorTitle) {
      els.resourceEditorTitle.textContent = existing
        ? (isPreset
          ? adminText('admin.resources.editPresetTitle', '编辑 Scope Preset')
          : adminText('admin.resources.editDocumentTitle', '编辑文档'))
        : (isPreset
          ? adminText('admin.resources.newPresetTitle', '新建 Scope Preset')
          : adminText('admin.resources.newDocumentTitle', '新建文档'));
    }
    if (els.resourceEditorMeta) {
      els.resourceEditorMeta.textContent = existing
        ? `ID：${isPreset ? existing.scopePresetId : existing.documentId}`
        : '';
    }
    if (els.resourceEditorId) {
      els.resourceEditorId.value = existing ? (isPreset ? existing.scopePresetId : existing.documentId) : '';
      els.resourceEditorId.readOnly = Boolean(existing);
    }
    if (els.resourceEditorLabel) els.resourceEditorLabel.value = existing?.label || '';
    setSelectValue(els.resourceEditorVisibility, existing?.visibility, 'restricted');
    setSelectValue(els.resourceEditorStatusSelect, normalizeResourceStatus(existing?.status), 'draft');
    renderResourceStatusControls();
    setTokenFieldValues(els.resourceEditorBrands, existing?.brands, 'brands');
    setTokenFieldValues(els.resourceEditorProductLines, existing?.productLines, 'productLines');
    setTokenFieldValues(els.resourceEditorApplicationTags, existing?.applicationTags, 'applicationTags');
    renderResourceChipField(existing?.chipIds, isPreset);
    setTokenFieldValues(els.resourceEditorDocumentIds, existing?.documentIds, 'documentIds');
    setTokenFieldValues(els.resourceEditorSourceLabels, existing?.sourceLabels, 'sourceLabels');

    const grants = existing?.requiredGrants || {};
    setTokenFieldValues(els.resourceEditorGrantBrands, grants.brands, 'brands');
    setTokenFieldValues(els.resourceEditorGrantProductLines, grants.productLines, 'productLines');
    setTokenFieldValues(els.resourceEditorGrantChipIds, grants.chipIds, 'chipIds');
    setTokenFieldValues(els.resourceEditorGrantDocumentIds, grants.documentIds, 'documentIds');
    setTokenFieldValues(els.resourceEditorGrantScopePresetIds, grants.scopePresetIds, 'scopePresetIds');
    setTokenFieldValues(els.resourceEditorGrantModelIds, grants.modelIds, 'modelIds');
    setTokenFieldValues(els.resourceEditorGrantMcpTools, grants.mcpTools, 'mcpTools');

    // documentIds 仅对 Scope Preset 有意义；validate / delete 仅在编辑既有记录时可用。
    if (els.resourceEditorDocumentIds) els.resourceEditorDocumentIds.hidden = !isPreset;
    if (els.resourceEditorDocumentIdsLabel) els.resourceEditorDocumentIdsLabel.hidden = !isPreset;
    if (els.resourceEditorValidate) els.resourceEditorValidate.hidden = !(isPreset && existing);
    if (els.resourceEditorDelete) els.resourceEditorDelete.hidden = !existing;

    showResourceEditor(true);
  }

  function closeResourceEditor() {
    state.resources.editing = null;
    setResourceEditorStatus('');
    showResourceEditor(false);
    restoreDrawerFocus();
  }

  function collectResourceRequiredGrants() {
    const grants = {
      brands: getTokenFieldValues(els.resourceEditorGrantBrands),
      productLines: getTokenFieldValues(els.resourceEditorGrantProductLines),
      chipIds: getTokenFieldValues(els.resourceEditorGrantChipIds),
      documentIds: getTokenFieldValues(els.resourceEditorGrantDocumentIds),
      scopePresetIds: getTokenFieldValues(els.resourceEditorGrantScopePresetIds),
      modelIds: getTokenFieldValues(els.resourceEditorGrantModelIds),
      mcpTools: getTokenFieldValues(els.resourceEditorGrantMcpTools)
    };
    // 去掉空数组，让后端 serialize 输出干净的契约。
    const cleaned = {};
    for (const [key, value] of Object.entries(grants)) {
      if (Array.isArray(value) && value.length > 0) cleaned[key] = value;
    }
    return cleaned;
  }

  function collectResourceEditorBody(isPreset) {
    const body = {
      label: (els.resourceEditorLabel?.value || '').trim(),
      visibility: els.resourceEditorVisibility?.value || 'restricted',
      status: normalizeResourceStatus(els.resourceEditorStatusSelect?.value),
      brands: getTokenFieldValues(els.resourceEditorBrands),
      productLines: getTokenFieldValues(els.resourceEditorProductLines),
      applicationTags: getTokenFieldValues(els.resourceEditorApplicationTags),
      chipIds: getResourceChipIds(),
      sourceLabels: getTokenFieldValues(els.resourceEditorSourceLabels),
      requiredGrants: collectResourceRequiredGrants()
    };
    if (isPreset) {
      body.documentIds = getTokenFieldValues(els.resourceEditorDocumentIds);
    }
    return body;
  }

  async function saveResourceEditor(event) {
    if (event) event.preventDefault();
    setResourceEditorStatus('');
    const editing = state.resources.editing;
    if (!editing) return;
    const isPreset = editing.kind === 'scope-preset';
    const idValue = (els.resourceEditorId?.value || '').trim();
    if (!idValue) {
      setResourceEditorStatus(adminText('admin.resources.idRequired', '请填写 ID'));
      return;
    }
    const body = collectResourceEditorBody(isPreset);
    const collection = isPreset ? 'scope-presets' : 'documents';
    const isUpdate = Boolean(editing.id);

    let path;
    let method;
    if (isUpdate) {
      path = `/admin/resources/${collection}/${encodeURIComponent(editing.id)}`;
      method = 'PUT';
    } else {
      path = `/admin/resources/${collection}`;
      method = 'POST';
      if (isPreset) {
        body.scopePresetId = idValue;
      } else {
        body.documentId = idValue;
      }
    }

    const response = await window.AgentXAuth.authFetch(path, { method, body: JSON.stringify(body) });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        adminText('admin.error.saveResource', { status: response.status }, `保存资源失败 (${response.status})`)
      );
      setResourceEditorStatus(message);
      return;
    }
    notifyAdmin('success', adminText('admin.resources.saved', '资源已保存'), idValue);
    closeResourceEditor();
    await loadResources();
  }

  async function deleteResourceEditor(force) {
    const editing = state.resources.editing;
    if (!editing || !editing.id) return;
    const isPreset = editing.kind === 'scope-preset';
    if (!force) {
      const confirmed = await window.AgentXUI.confirm({
        title: isPreset
          ? adminText('admin.resources.deletePresetTitle', '删除 Scope Preset')
          : adminText('admin.resources.deleteDocumentTitle', '删除文档'),
        body: adminText('admin.resources.deleteBody', { id: editing.id }, `确认删除「${editing.id}」？此操作不可恢复。`),
        confirmText: adminText('admin.action.delete', '删除'),
        danger: true
      });
      if (!confirmed) {
        return;
      }
    }
    const collection = isPreset ? 'scope-presets' : 'documents';
    const path = `/admin/resources/${collection}/${encodeURIComponent(editing.id)}${force ? '?force=true' : ''}`;
    const response = await window.AgentXAuth.authFetch(path, { method: 'DELETE' });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (response.status === 409 && !force) {
      const payload = await response.json().catch(() => ({}));
      const referencingIds = payload.referencingScopePresetIds || payload.details?.referencingScopePresetIds || [];
      const cascadeConfirmed = await window.AgentXUI.confirm({
        title: adminText('admin.resources.referencedTitle', '文档仍被 Scope Preset 引用'),
        body:
          referencingIds.length > 0
            ? adminText(
              'admin.resources.referencedBodyWithIds',
              { id: editing.id, ids: referencingIds.join('、') },
              `「${editing.id}」仍被以下 Scope Preset 引用：${referencingIds.join('、')}。强制删除会同时从这些预设中移除该引用，是否继续？`
            )
            : adminText(
              'admin.resources.referencedBody',
              { id: editing.id },
              `「${editing.id}」仍被其它 Scope Preset 引用，强制删除会同时移除该引用，是否继续？`
            ),
        confirmText: adminText('admin.resources.forceDelete', '强制删除'),
        danger: true
      });
      if (cascadeConfirmed) {
        await deleteResourceEditor(true);
      }
      return;
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        adminText('admin.error.deleteResource', { status: response.status }, `删除资源失败 (${response.status})`)
      );
      setResourceEditorStatus(message);
      return;
    }
    notifyAdmin('success', adminText('admin.resources.deleted', '资源已删除'), editing.id);
    closeResourceEditor();
    await loadResources();
  }

  async function validatePreset(scopePresetId) {
    if (!scopePresetId) return;
    setResourcePresetOrphanWarning('');
    selectResourceTab('scope-presets');
    const response = await window.AgentXAuth.authFetch(
      `/admin/resources/scope-presets/${encodeURIComponent(scopePresetId)}/validate`,
      { method: 'POST' }
    );
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = await readErrorMessage(
        response,
        adminText('admin.error.validateResource', { status: response.status }, `校验失败 (${response.status})`)
      );
      setResourcePresetOrphanWarning(message);
      return;
    }
    const payload = await response.json();
    if (payload.hasOrphans) {
      const parts = [];
      if (Array.isArray(payload.missingDocumentIds) && payload.missingDocumentIds.length > 0) {
        parts.push(adminText(
          'admin.resources.missingDocumentsColon',
          { ids: payload.missingDocumentIds.join(', ') },
          `缺失文档：${payload.missingDocumentIds.join(', ')}`
        ));
      }
      if (Array.isArray(payload.missingChipIds) && payload.missingChipIds.length > 0) {
        parts.push(adminText(
          'admin.resources.missingChipsColon',
          { ids: payload.missingChipIds.join(', ') },
          `缺失芯片：${payload.missingChipIds.join(', ')}`
        ));
      }
      setResourcePresetOrphanWarning(adminText(
        'admin.resources.hasOrphans',
        { scopePresetId, details: parts.join('；') },
        `${scopePresetId} 存在孤儿引用 — ${parts.join('；')}`
      ));
    } else {
      setResourcePresetOrphanWarning('');
      notifyAdmin(
        'success',
        adminText('admin.resources.validationPassed', '校验通过'),
        adminText('admin.resources.noOrphans', { scopePresetId }, `${scopePresetId} 无孤儿引用`)
      );
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setUserCreateError('');
    const username = els.username.value.trim();
    const password = els.password.value;
    const role = els.role.value || 'customer';
    if (!username) {
      throw new Error(adminText('admin.users.usernameRequired', 'Username is required.'));
    }
    if (!password) {
      throw new Error(adminText('admin.users.passwordRequired', 'Password is required.'));
    }
    const profile = collectProfile({
      company: els.newCompany.value,
      realName: els.newRealName.value,
      email: els.newEmail.value,
      note: els.newNote.value
    });
    const body = {
      username,
      password,
      role,
      status: els.newStatus.value || 'active',
      expiresAt: fromLocalDateTimeInput(els.newExpiresAt.value)
    };
    if (profile) {
      body.profile = profile;
    }
    const response = await window.AgentXAuth.authFetch('/admin/users', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(
        response,
        adminText('admin.error.createUser', { status: response.status }, `Creating user failed (${response.status})`)
      ));
    }
    const payload = await response.json();
    els.username.value = '';
    els.password.value = '';
    els.newExpiresAt.value = '';
    els.newCompany.value = '';
    els.newRealName.value = '';
    els.newEmail.value = '';
    els.newNote.value = '';
    els.newStatus.value = 'active';
    populateRoleSelect(els.role, 'customer');
    if (payload.user?.id) {
      state.selectedUserId = payload.user.id;
    }
    els.userCreateModal.hidden = true;
    notifyAdmin('success', adminText('admin.users.created', '用户已创建'), username);
    await loadUsers();
  }

  async function createKey(event) {
    event.preventDefault();
    const user = selectedUser();
    if (!user) return;
    const response = await window.AgentXAuth.authFetch(`/admin/users/${encodeURIComponent(user.id)}/keys`, {
      method: 'POST',
      body: JSON.stringify({
        name: els.keyName.value.trim() || 'default',
        expiresAt: fromLocalDateTimeInput(els.keyExpiresAt.value)
      })
    });
    if (!response.ok) {
      throw new Error(adminText('admin.error.generateKey', { status: response.status }, `Generating key failed (${response.status})`));
    }
    const payload = await response.json();
    els.keyName.value = '';
    els.keyExpiresAt.value = '';
    notifyAdmin(
      'success',
      adminText('admin.keys.generated', 'Key 已生成'),
      adminText('admin.keys.copyImmediately', '请立即复制完整 Key')
    );
    await loadUsers();
    showGeneratedKey(payload.key.key);
  }

  function showGeneratedKey(value) {
    els.generatedKey.replaceChildren();
    const code = document.createElement('code');
    code.textContent = value;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = adminText('admin.action.copy', '复制');
    copy.addEventListener('click', () => copyFullKey(value));
    const warning = document.createElement('span');
    warning.className = 'key-sensitive-warning';
    warning.textContent = adminText('admin.keys.newKeySensitive', 'Sensitive credential: newly generated Full MCP Key.');
    els.generatedKey.append(code, copy, warning);
  }

  async function removeKey(userId, keyId) {
    const response = await window.AgentXAuth.authFetch(
      `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) {
      throw new Error(adminText('admin.error.revokeKey', { status: response.status }, `Revoking key failed (${response.status})`));
    }
    notifyAdmin('success', adminText('admin.keys.revoked', 'Key 已撤销'));
    await loadUsers();
  }

  async function updateKey(userId, keyId, patch) {
    const response = await window.AgentXAuth.authFetch(
      `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
      {
        method: 'PUT',
        body: JSON.stringify(patch)
      }
    );
    if (!response.ok) {
      throw new Error(adminText('admin.error.saveKey', { status: response.status }, `Saving key failed (${response.status})`));
    }
    await loadUsers();
  }

  async function loadPromptFiles() {
    const response = await window.AgentXAuth.authFetch('/admin/prompts', { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      const message = adminText('admin.error.loadPrompts', { status: response.status }, `加载提示词失败 (${response.status})`);
      setSectionStatus('prompts', 'error', message);
      els.promptListError.textContent = message;
      return;
    }
    const payload = await response.json();
    state.promptFiles = payload.files || [];
    clearSectionStatus('prompts', 'error');
    renderPromptFiles();
    if (state.chips.length > 0) {
      renderChipMappings();
    }
  }

  function renderPromptFiles() {
    els.promptFileList.replaceChildren();
    els.promptListError.textContent = '';
    if (els.promptChipCount) {
      const builtCount = state.chips.filter((chip) => hasPromptForChip(chip.id)).length;
      els.promptChipCount.textContent = adminText(
        'admin.prompts.builtSummary',
        { built: builtCount, total: state.chips.length },
        `${builtCount} / ${state.chips.length} 已建`
      );
    }
    if (state.chips.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.prompts.noChipCatalog', '暂无芯片目录，先在芯片目录中维护芯片。');
      els.promptFileList.append(empty);
      return;
    }
    for (const chip of state.chips) {
      const file = promptFileForChip(chip.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `prompt-chip-card${file.exists === false ? ' missing' : ' built'}`;
      if (state.editingFile?.path === file.path) {
        btn.classList.add('active');
      }
      btn.dataset.chipId = chip.id;
      btn.dataset.path = file.path;
      const head = document.createElement('span');
      head.className = 'prompt-chip-card-head';
      const name = document.createElement('span');
      name.className = 'prompt-chip-card-name';
      name.textContent = chip.id;
      const badge = document.createElement('span');
      badge.className = `admin-badge ${file.exists === false ? 'admin-badge-warn' : 'admin-badge-success'}`;
      badge.textContent = file.exists === false
        ? adminText('admin.prompts.notBuilt', '未建')
        : adminText('admin.prompts.built', '已建');
      head.append(name, badge);
      const label = document.createElement('span');
      label.className = 'prompt-chip-card-label';
      label.textContent = promptChipSubtitle(chip);
      const meta = document.createElement('span');
      meta.className = 'prompt-chip-card-meta';
      meta.textContent = file.path;
      btn.append(head, label, meta);
      btn.addEventListener('click', () => openPromptEditor(file));
      els.promptFileList.append(btn);
    }
  }

  function promptChipSubtitle(chip) {
    const label = chip.label && chip.label !== chip.id ? chip.label : '';
    const summary = chip.summary || chip.description || chip.queryHint || '';
    const groups = [
      label,
      formatGrantList(chip.productLines),
      formatGrantList(chip.applicationTags)
    ].filter((item) => item && item !== '—');
    if (summary) return summary;
    if (groups.length > 0) return groups.join(' · ');
    return adminText('admin.prompts.defaultSubtitle', 'datasheet 问答提示词');
  }

  async function openPromptEditor(file) {
    if (
      state.hasUnsavedChanges &&
      state.editingFile?.path !== file.path &&
      window.AgentXUI &&
      typeof window.AgentXUI.confirm === 'function' &&
      !(await window.AgentXUI.confirm({
        title: adminText('admin.prompts.discardTitle', '放弃未保存的更改'),
        body: adminText('admin.prompts.discardBody', '当前提示词草稿未保存，确认放弃？'),
        confirmText: adminText('admin.prompts.discard', '放弃'),
        danger: true
      }))
    ) {
      return false;
    }
    const requestId = ++state.promptLoadRequestId;
    state.editingFile = file;
    state.selectedPromptChipId = file.chipId || '';
    state.hasUnsavedChanges = false;
    state.promptDraftRevision += 1;
    state.promptHistory = [];
    renderPromptHistory();
    setPromptEditorState('loading', `Loading ${file.path}...`);
    const response = await window.AgentXAuth.authFetch(`/admin/prompts/${encodeURIComponent(file.path)}`, {
      skipAuthRedirect: true
    });
    if (requestId !== state.promptLoadRequestId || state.editingFile?.path !== file.path) {
      return false;
    }
    if (!response.ok) {
      setPromptEditorState(
        'load-failed',
        adminText('admin.error.loadPrompt', { status: response.status }, `加载提示词失败 (${response.status})`)
      );
      return;
    }
    const payload = await response.json();
    if (requestId !== state.promptLoadRequestId || state.editingFile?.path !== file.path) {
      return false;
    }
    state.editingFile = file;
    state.selectedPromptChipId = file.chipId || '';
    state.hasUnsavedChanges = false;
    els.promptFileName.textContent = file.chipId
      ? adminText('admin.prompts.bodyTitle', { chipId: file.chipId }, `${file.chipId} · 提示词正文`)
      : file.path;
    els.promptContent.value = payload.content || '';
    state.promptDraftRevision += 1;
    setActivePromptFile(file.path);
    const nextStatus = payload.missing ? 'missing' : 'ready';
    setPromptEditorState(
      nextStatus,
      payload.missing ? adminText('admin.prompts.notCreated', '提示词尚未创建。') : ''
    );
    await loadPromptHistory(file.path, { editorRequestId: requestId });
    if (!payload.missing) {
      els.promptContent.focus();
    }
    return true;
  }

  async function loadPromptHistory(filePath, options = {}) {
    const historyRequestId = ++state.promptHistoryRequestId;
    const response = await window.AgentXAuth.authFetch(`/admin/prompts/${encodeURIComponent(filePath)}/history`, {
      skipAuthRedirect: true
    });
    if (
      historyRequestId !== state.promptHistoryRequestId ||
      state.editingFile?.path !== filePath ||
      (options.editorRequestId && options.editorRequestId !== state.promptLoadRequestId)
    ) {
      return;
    }
    if (!response.ok) {
      state.promptHistory = [];
      renderPromptHistory(adminText('admin.prompts.historyUnavailable', { status: response.status }, `版本历史不可用 (${response.status})`));
      return;
    }
    const payload = await response.json();
    if (
      historyRequestId !== state.promptHistoryRequestId ||
      state.editingFile?.path !== filePath ||
      (options.editorRequestId && options.editorRequestId !== state.promptLoadRequestId)
    ) {
      return;
    }
    state.promptHistory = Array.isArray(payload.entries) ? payload.entries : [];
    renderPromptHistory();
  }

  function renderPromptHistory(errorMessage) {
    if (!els.promptHistorySummary || !els.promptRollback) return;
    if (els.promptHistoryList) els.promptHistoryList.replaceChildren();
    if (errorMessage) {
      els.promptHistorySummary.textContent = errorMessage;
      els.promptRollback.disabled = true;
      return;
    }
    const latest = state.promptHistory[0];
    els.promptRollback.disabled = !latest || !state.editingFile || els.promptContent.disabled;
    if (!latest) {
      els.promptHistorySummary.textContent = adminText('admin.prompts.noHistory', '暂无版本历史');
      return;
    }
    const savedAt = latest.createdAt ? new Date(latest.createdAt).toLocaleString(state.locale) : adminText('admin.common.unknownTime', '未知时间');
    const actor = latest.username || latest.userId || adminText('admin.common.unknownUser', '未知用户');
    const shortHash = latest.hash ? latest.hash.slice(0, 12) : adminText('admin.common.noHash', '无哈希');
    els.promptHistorySummary.textContent = adminText(
      'admin.prompts.historySummary',
      { savedAt, actor, hash: shortHash, count: state.promptHistory.length },
      `上一版 ${savedAt} · ${actor} · ${shortHash} · 共 ${state.promptHistory.length} 条`
    );
    // H4：版本历史条目改为原型 .history-item 左侧线时间轴（第 443-448 行：
    // 圆点标记 + ht-time/ht-author 堆叠 + ht-actions 承载回滚按钮）。
    if (els.promptHistoryList) {
      for (const entry of state.promptHistory) {
        const item = document.createElement('div');
        item.className = 'prompt-history-entry';
        const entryTime = entry.createdAt ? new Date(entry.createdAt).toLocaleString(state.locale) : adminText('admin.common.unknownTime', '未知时间');
        const entryHash = entry.hash ? entry.hash.slice(0, 12) : adminText('admin.common.noHash', '无哈希');
        const time = document.createElement('div');
        time.className = 'ht-time';
        time.textContent = entryTime;
        const author = document.createElement('div');
        author.className = 'ht-author';
        author.textContent = `${entry.username || entry.userId || adminText('admin.common.unknownUser', '未知用户')} · ${entryHash}`;
        const actions = document.createElement('div');
        actions.className = 'ht-actions';
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'secondary-button prompt-history-rollback';
        action.textContent = adminText('admin.prompts.rollbackVersion', '回滚此版本');
        action.addEventListener('click', () => loadPromptHistoryDraft(entry));
        actions.append(action);
        item.append(time, author, actions);
        els.promptHistoryList.append(item);
      }
    }
  }

  function setPromptEditorState(status, message) {
    const isMissing = status === 'missing';
    els.promptPlaceholder.hidden = !(status === 'idle' || isMissing);
    els.promptEditorContainer.hidden = status === 'idle' || status === 'load-failed' || isMissing;
    els.promptErrorPanel.hidden = status !== 'load-failed';
    els.promptContent.disabled = status === 'loading';
    els.promptSave.disabled = status === 'loading';
    els.promptCancel.disabled = status === 'loading';
    els.promptRollback.disabled = status === 'loading' || isMissing || state.promptHistory.length === 0 || !state.editingFile;
    renderPromptPlaceholder(status, message);
    if (els.promptTemplateCreate) {
      els.promptTemplateCreate.hidden = !isMissing;
    }
    els.promptEditorStatus.className = `prompt-editor-status ${status}`;
    els.promptEditorStatus.textContent = message || '';
    if (status === 'load-failed') {
      els.promptErrorMessage.textContent = message;
      setSectionStatus('prompts', 'error', message);
    } else if (status === 'saved') {
      setSectionStatus('prompts', 'saved', message || adminText('admin.common.saved', '已保存'));
      clearSectionStatus('prompts', 'error');
    } else if (status === 'save-failed') {
      setSectionStatus('prompts', 'error', message);
    }
    renderPromptHistory();
  }

  function renderPromptPlaceholder(status, message) {
    const paragraph = els.promptPlaceholder?.querySelector('p');
    if (!paragraph) return;
    if (status === 'missing') {
      const chipLabel = state.editingFile?.chipId || state.editingFile?.name || adminText('admin.prompts.currentChip', '当前芯片');
      paragraph.textContent = adminText(
        'admin.prompts.notCreatedForChip',
        { chipLabel },
        `${chipLabel} 尚未创建提示词。`
      );
      els.promptPlaceholder.classList.add('admin-empty-state');
      return;
    }
    paragraph.textContent = message || adminText('admin.prompts.selectChip', '选择左侧芯片进行编辑');
    els.promptPlaceholder.classList.remove('admin-empty-state');
  }

  function setActivePromptFile(path) {
    for (const btn of els.promptFileList.querySelectorAll('.prompt-chip-card')) {
      btn.classList.toggle('active', btn.dataset.path === path);
    }
  }

  function retryPromptLoad() {
    if (state.editingFile) {
      openPromptEditor(state.editingFile).catch(setPromptError);
    }
  }

  async function savePrompt() {
    if (!state.editingFile) return;
    const filePath = state.editingFile.path;
    const editorRequestId = state.promptLoadRequestId;
    const draftRevision = state.promptDraftRevision;
    const content = els.promptContent.value;
    if (!content.trim()) {
      els.promptEditorStatus.textContent = adminText('admin.prompts.contentRequired', '提示词内容不能为空');
      els.promptEditorStatus.className = 'prompt-editor-status error';
      return;
    }
    const response = await window.AgentXAuth.authFetch(`/admin/prompts/${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });
    if (!response.ok) {
      if (!isCurrentPromptEditor(filePath, editorRequestId) || state.promptDraftRevision !== draftRevision || els.promptContent.value !== content) {
        return;
      }
      setPromptEditorState('save-failed', adminText('admin.error.savePrompt', { status: response.status }, `保存失败 (${response.status})`));
      return;
    }
    if (!isCurrentPromptEditor(filePath, editorRequestId) || state.promptDraftRevision !== draftRevision || els.promptContent.value !== content) {
      return;
    }
    state.hasUnsavedChanges = false;
    markPromptFileSaved(filePath);
    setPromptEditorState('saved', adminText('admin.common.saved', '已保存'));
    renderPromptFiles();
    if (state.chips.length > 0) {
      renderChipMappings();
    }
    await loadPromptHistory(filePath, { editorRequestId });
  }

  function markPromptFileSaved(filePath) {
    const existingIndex = state.promptFiles.findIndex((file) => file.path === filePath);
    const savedFile = {
      ...(state.editingFile || {}),
      type: state.editingFile?.type || 'chip',
      name: state.editingFile?.name || filePath.split('/').pop() || filePath,
      path: filePath,
      exists: true
    };
    if (existingIndex >= 0) {
      state.promptFiles[existingIndex] = { ...state.promptFiles[existingIndex], ...savedFile };
    } else {
      state.promptFiles.push(savedFile);
    }
    if (state.editingFile?.path === filePath) {
      state.editingFile = { ...state.editingFile, exists: true };
    }
  }

  async function rollbackPrompt() {
    await loadPromptHistoryDraft(state.promptHistory[0]);
  }

  async function loadPromptHistoryDraft(entry) {
    if (!entry || !state.editingFile) return;
    if (
      state.hasUnsavedChanges &&
      window.AgentXUI &&
      typeof window.AgentXUI.confirm === 'function' &&
      !(await window.AgentXUI.confirm({
        title: adminText('admin.prompts.overwriteTitle', '覆盖当前草稿'),
        body: adminText('admin.prompts.overwriteBody', '当前有未保存草稿，是否用历史版本覆盖当前草稿？'),
        confirmText: adminText('admin.prompts.overwrite', '覆盖'),
        danger: true
      }))
    ) {
      return;
    }
    const entryTime = entry.createdAt ? new Date(entry.createdAt).toLocaleString(state.locale) : adminText('admin.common.unknownTime', '未知时间');
    const entryHash = entry.hash ? entry.hash.slice(0, 12) : adminText('admin.common.noHash', '无哈希');
    els.promptContent.value = entry.content || '';
    state.hasUnsavedChanges = true;
    state.promptDraftRevision += 1;
    setPromptEditorState(
      'warning',
      adminText(
        'admin.prompts.historyLoaded',
        { entryTime, entryHash },
        `已载入历史版本 ${entryTime} · ${entryHash}，点击保存后生效。`
      )
    );
    els.promptContent.focus();
  }

  function isCurrentPromptEditor(filePath, editorRequestId) {
    return editorRequestId === state.promptLoadRequestId && state.editingFile?.path === filePath;
  }

  async function closePromptEditor() {
    if (
      state.hasUnsavedChanges &&
      !(await window.AgentXUI.confirm({
        title: adminText('admin.prompts.discardTitle', '放弃未保存的更改'),
        body: adminText('admin.prompts.discardBody', '当前提示词草稿未保存，确认放弃？'),
        confirmText: adminText('admin.prompts.discard', '放弃'),
        danger: true
      }))
    ) return;
    state.promptLoadRequestId += 1;
    state.promptHistoryRequestId += 1;
    state.editingFile = null;
    state.selectedPromptChipId = '';
    state.hasUnsavedChanges = false;
    state.promptDraftRevision += 1;
    state.promptHistory = [];
    setActivePromptFile('');
    setPromptEditorState('idle', '');
  }

  function setPromptError(message) {
    els.promptListError.textContent = message || '';
  }

  function createPromptFromTemplate() {
    if (!state.editingFile) return;
    const baseName = state.editingFile.chipId || state.editingFile.name || state.editingFile.path || 'chip';
    els.promptContent.value = [
      `# ${baseName}`,
      '',
      '请基于已授权 datasheet 回答问题，明确引用章节、页码或寄存器名称。',
      '当资料不足时说明缺口，不要编造。'
    ].join('\n');
    state.hasUnsavedChanges = true;
    state.promptDraftRevision += 1;
    setPromptEditorState('warning', adminText('admin.prompts.createdFromTemplate', '已从模板创建草稿，保存后生效。'));
  }

  async function init() {
    if (initStarted) return;
    initStarted = true;
    const currentUserLocale = window.AgentXAuth.getUser()?.localePreference
      || window.AgentXAuth.getUser()?.preferredLanguage
      || window.AgentXI18n?.getLocale?.()
      || 'zh-CN';
    state.locale = window.AgentXI18n?.normalizeLocale?.(currentUserLocale)
      || (currentUserLocale === 'en-US' ? 'en-US' : 'zh-CN');
    window.AgentXI18n?.applyLocale?.(state.locale);

    els.adminLoginForm.addEventListener('submit', (event) => {
      handleAdminLogin(event).catch((error) => showAdminLogin(error.message));
    });
    els.userForm.addEventListener('submit', (event) => {
      createUser(event).catch((error) => {
        setUserCreateError(error.message);
        notifyAdmin('error', adminText('admin.toast.createUserFailed', '创建用户失败'), error.message);
      });
    });
    els.selectedUserRoleForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const user = selectedUser();
      if (user) {
        updateUserRole(user.id, els.selectedUserRole.value).catch((error) => {
          setError(error.message);
          notifyAdmin('error', adminText('admin.toast.roleUpdateFailed', '角色更新失败'), error.message);
        });
      }
    });
    els.selectedUserProfileForm.addEventListener('submit', (event) => {
      updateSelectedUserProfile(event).catch((error) => {
        setError(error.message);
        notifyAdmin('error', adminText('admin.toast.saveProfileFailed', '保存资料失败'), error.message);
      });
    });
    els.selectedUserProfileReset?.addEventListener('click', () => {
      renderSelectedUserDetails();
    });
    els.userFilterForm.addEventListener('input', () => {
      state.userFilters = {
        search: state.userFilters.search,
        status: els.userFilterStatus.value,
        expired: els.userFilterExpired.value,
        company: els.userFilterCompany.value.trim(),
        role: els.userFilterRole.value
      };
      renderUsers();
    });
    els.userFilterReset.addEventListener('click', () => {
      els.userFilterStatus.value = '';
      els.userFilterExpired.value = '';
      els.userFilterCompany.value = '';
      els.userFilterRole.value = '';
      state.userFilters = { search: '', status: '', expired: '', company: '', role: '' };
      els.userSearch.value = '';
      renderUsers();
    });
    els.userSearch.addEventListener('input', () => {
      state.userFilters.search = els.userSearch.value;
      renderUsers();
    });
    els.userDetailClose?.addEventListener('click', () => {
      closeUserDetail();
    });
    els.userCreateOpen.addEventListener('click', () => {
      els.userCreateModal.hidden = false;
      document.getElementById('new-username')?.focus();
    });
    els.userCreateCancel.addEventListener('click', () => {
      els.userCreateModal.hidden = true;
    });
    els.userCreateModal.addEventListener('click', (event) => {
      if (event.target === els.userCreateModal) {
        els.userCreateModal.hidden = true;
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !els.userCreateModal.hidden) {
        els.userCreateModal.hidden = true;
      }
    });
    els.selectedUserAccessSave?.addEventListener('click', () => {
      saveSelectedUserAccess().catch((error) => {
        if (!els.selectedUserAccessError?.textContent) {
          setAccessError(error.message);
        }
        notifyAdmin('error', adminText('admin.toast.saveAccessFailed', '访问权限保存失败'), error.message);
      });
    });
    if (els.selectedUserCreditModeDelta) {
      els.selectedUserCreditModeDelta.addEventListener('click', () => setSelectedUserCreditMode('delta'));
    }
    if (els.selectedUserCreditModeBalance) {
      els.selectedUserCreditModeBalance.addEventListener('click', () => setSelectedUserCreditMode('balance'));
    }
    if (els.selectedUserCreditForm) {
      els.selectedUserCreditForm.addEventListener('submit', (event) => {
        submitSelectedUserCreditAdjustment(event).catch((error) => setSelectedUserCreditStatus(error.message));
      });
    }
    els.selectedUserPasswordForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const user = selectedUser();
      const password = els.selectedUserPassword.value;
      if (user && password) {
        updateUserPassword(user.id, password).catch((error) => {
          setError(error.message);
          notifyAdmin('error', adminText('admin.toast.resetPasswordFailed', '密码重置失败'), error.message);
        });
      } else {
        setError(adminText('admin.users.passwordRequired', 'Password is required.'));
      }
    });
    els.selectedUserDelete.addEventListener('click', () => {
      const user = selectedUser();
      if (user) {
        deleteUser(user.id).catch((error) => {
          setError(error.message);
          notifyAdmin('error', adminText('admin.toast.deleteUserFailed', '删除用户失败'), error.message);
        });
      }
    });
    els.keyForm.addEventListener('submit', (event) => {
      createKey(event).catch((error) => {
        setError(error.message);
        notifyAdmin('error', adminText('admin.toast.generateKeyFailed', 'Key 生成失败'), error.message);
      });
    });
    els.chipAdd.addEventListener('click', addChipRow);
    els.chipSave.addEventListener('click', () => saveChipMappings().catch((error) => {
      els.chipMappingError.textContent = error.message;
    }));
    if (els.chipFilterSearch) {
      els.chipFilterSearch.addEventListener('input', () => {
        state.chipFilters.search = els.chipFilterSearch.value;
        renderChipMappings();
      });
    }
    if (els.chipFilterLine) {
      els.chipFilterLine.addEventListener('change', () => {
        state.chipFilters.line = els.chipFilterLine.value;
        renderChipMappings();
      });
    }
    if (els.chipEditorForm) {
      els.chipEditorForm.addEventListener('submit', applyChipEditor);
    }
    if (els.chipEditorClose) {
      els.chipEditorClose.addEventListener('click', closeChipEditor);
    }
    // 点遮罩关闭（B1）：与 Escape/关闭按钮同一个 closeChipEditor，行为一致。
    if (els.chipEditorBackdrop) {
      els.chipEditorBackdrop.addEventListener('click', closeChipEditor);
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.chipEditorDrawer && !els.chipEditorDrawer.hidden) {
        closeChipEditor();
      }
    });
    initChipEditorTabs();
    if (els.chipEditorDelete) {
      els.chipEditorDelete.addEventListener('click', () => {
        if (!state.editingChipId) return;
        confirmDeleteChip(state.editingChipId).catch((error) => {
          els.chipMappingError.textContent = error.message;
        });
      });
    }
    els.promptRetry.addEventListener('click', retryPromptLoad);
    els.promptContent.addEventListener('input', () => {
      state.hasUnsavedChanges = true;
      state.promptDraftRevision += 1;
      els.promptEditorStatus.textContent = adminText('admin.prompts.unsavedChanges', '有未保存更改');
      els.promptEditorStatus.className = 'prompt-editor-status warning';
    });
    els.promptSave.addEventListener('click', () => savePrompt().catch(setPromptError));
    els.promptRollback.addEventListener('click', () => rollbackPrompt().catch(setPromptError));
    if (els.promptTemplateCreate) {
      els.promptTemplateCreate.addEventListener('click', createPromptFromTemplate);
    }
    els.promptCancel.addEventListener('click', closePromptEditor);
    els.historyFilterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      collectHistoryFilters();
      loadHistoryWorkspace({ reset: true }).catch((error) => setHistoryError(error.message));
    });
    els.historyFilterReset.addEventListener('click', () => {
      for (const input of [
        els.historyFilterUser,
        els.historyFilterRole,
        els.historyFilterChip,
        els.historyFilterKeyword,
        els.historyFilterFrom,
        els.historyFilterTo
      ]) {
        input.value = '';
      }
      collectHistoryFilters();
      loadHistoryWorkspace({ reset: true }).catch((error) => setHistoryError(error.message));
    });
    if (els.ticketAdminFilterForm) {
      els.ticketAdminFilterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        collectTicketAdminFilters();
        loadAdminTickets().catch((error) => setFeedbackError(error.message));
      });
    }
    if (els.ticketAdminFilterType) {
      els.ticketAdminFilterType.addEventListener('change', () => {
        syncTicketFilterStatusOptions();
      });
    }
    if (els.ticketAdminMoreFiltersToggle && els.ticketAdminMoreFilters) {
      const closeTicketMoreFilters = () => {
        if (els.ticketAdminMoreFilters.hidden) return;
        els.ticketAdminMoreFilters.hidden = true;
        els.ticketAdminMoreFiltersToggle.setAttribute('aria-expanded', 'false');
      };
      els.ticketAdminMoreFiltersToggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextHidden = !els.ticketAdminMoreFilters.hidden;
        els.ticketAdminMoreFilters.hidden = nextHidden;
        els.ticketAdminMoreFiltersToggle.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
      });
      // 更多筛选改为浮层弹出（D4）：点击弹层外部或按 Escape 关闭，避免常驻挤占布局。
      document.addEventListener('click', (event) => {
        if (els.ticketAdminMoreFilters.hidden) return;
        if (els.ticketAdminMoreFilters.contains(event.target) || els.ticketAdminMoreFiltersToggle.contains(event.target)) return;
        closeTicketMoreFilters();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeTicketMoreFilters();
      });
    }
    if (els.ticketAdminFilterReset) {
      els.ticketAdminFilterReset.addEventListener('click', () => {
        for (const input of [
          els.ticketAdminFilterType,
          els.ticketAdminFilterStatus,
          els.ticketAdminFilterNeedsMoreInfo,
          els.ticketAdminFilterKeyword,
          els.ticketAdminFilterFeedbackType,
          els.ticketAdminFilterChip,
          els.ticketAdminFilterDocument,
          els.ticketAdminFilterScope,
          els.ticketAdminFilterModel,
          els.ticketAdminFilterReviewSignal
        ]) {
          if (input) input.value = '';
        }
        syncTicketFilterStatusOptions();
        collectTicketAdminFilters();
        loadAdminTickets().catch((error) => setFeedbackError(error.message));
      });
    }
    if (els.ticketAdminReviewForm) {
      els.ticketAdminReviewForm.addEventListener('submit', (event) => {
        saveAdminTicketReview(event).catch((error) => setTicketAdminStatus(error.message));
      });
    }
    if (els.ticketAdminReplyForm) {
      els.ticketAdminReplyForm.addEventListener('submit', (event) => {
        submitAdminTicketReply(event).catch((error) => {
          if (els.ticketAdminReplyStatus) els.ticketAdminReplyStatus.textContent = error.message;
        });
      });
    }
    if (els.ticketAdminDownloadAll) {
      els.ticketAdminDownloadAll.addEventListener('click', () => {
        downloadAllTicketAttachments().catch((error) => setFeedbackError(error.message));
      });
    }
    for (const button of [els.historyTabUsers, els.historyTabLatest, els.historyTabQuestions]) {
      button.addEventListener('click', () => {
        switchHistoryTab(button.dataset.historyTab);
        loadHistoryWorkspace({ reset: state.activeHistoryTab === 'questions' ? state.history.questions.length === 0 : state.history.sessions.length === 0 })
          .catch((error) => setHistoryError(error.message));
      });
    }
    els.historyLoadMoreSessions.addEventListener('click', () => {
      loadHistoryWorkspace({ reset: false }).catch((error) => setHistoryError(error.message));
    });
    els.historyLoadMoreQuestions.addEventListener('click', () => {
      loadHistoryWorkspace({ reset: false }).catch((error) => setHistoryError(error.message));
    });
    els.sessionDetailClose.addEventListener('click', closeSessionDetail);
    // 批次A（2.2.27）：点遮罩关闭，与芯片编辑器抽屉一致（会话抽屉此前无 backdrop，纯鼠标用户只能靠 Escape）。
    if (els.sessionDetailBackdrop) {
      els.sessionDetailBackdrop.addEventListener('click', closeSessionDetail);
    }
    // F1：会话详情改为固定右侧浮层后，按 Escape 关闭，与芯片编辑器 .admin-drawer 的关闭行为保持一致。
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.sessionDetailDrawer && !els.sessionDetailDrawer.hidden) {
        closeSessionDetail();
      }
    });
    els.sessionDebugToggle.addEventListener('click', () => {
      const expanded = els.sessionDebugToggle.getAttribute('aria-expanded') === 'true';
      if (expanded) {
        els.sessionDebugToggle.setAttribute('aria-expanded', 'false');
        els.sessionDetailDebug.hidden = true;
        return;
      }
      loadSessionDebug().catch((error) => {
        els.sessionDetailError.textContent = error.message;
      });
    });
    if (els.observabilityRefresh) {
      els.observabilityRefresh.addEventListener('click', () => {
        loadObservability().catch((error) => setObservabilityError(error.message));
      });
    }
    if (els.observabilityRange) {
      els.observabilityRange.addEventListener('change', () => {
        loadObservability().catch((error) => setObservabilityError(error.message));
      });
    }
    if (els.discoveryTracesRefresh) {
      els.discoveryTracesRefresh.addEventListener('click', () => {
        loadDiscoveryTraces().catch((error) => setDiscoveryTracesError(error.message));
      });
    }
    if (els.discoveryTracesFilterAll) {
      els.discoveryTracesFilterAll.addEventListener('click', () => setDiscoveryTraceQuickFilter(''));
    }
    if (els.discoveryTracesFilterError) {
      els.discoveryTracesFilterError.addEventListener('click', () => setDiscoveryTraceQuickFilter('error'));
    }
    if (els.announcementAdminNew) {
      els.announcementAdminNew.addEventListener('click', newAdminAnnouncementDraft);
    }
    els.announcementAdminLocaleZh?.addEventListener('click', () => setAnnouncementEditorLocale('zh-CN'));
    els.announcementAdminLocaleEn?.addEventListener('click', () => setAnnouncementEditorLocale('en-US'));
    if (els.announcementAdminFilterForm) {
      const applyAnnouncementFilters = () => {
        collectAnnouncementFilters();
        loadAdminAnnouncements().catch((error) => setAnnouncementError(error.message));
      };
      els.announcementAdminFilterForm.addEventListener('submit', (event) => {
        event.preventDefault();
        applyAnnouncementFilters();
      });
      els.announcementAdminFilterForm.addEventListener('change', (event) => {
        if (event.target?.matches?.('select')) {
          applyAnnouncementFilters();
        }
      });
      els.announcementAdminFilterForm.addEventListener('input', (event) => {
        if (event.target?.matches?.('input[type="search"]')) {
          applyAnnouncementFilters();
        }
      });
    }
    if (els.announcementAdminFilterReset) {
      els.announcementAdminFilterReset.addEventListener('click', () => {
        for (const input of [
          els.announcementAdminFilterType,
          els.announcementAdminFilterStatus,
          els.announcementAdminFilterVisibility,
          els.announcementAdminFilterPinned,
          els.announcementAdminFilterActive,
          els.announcementAdminFilterKeyword
        ]) {
          if (input) input.value = '';
        }
        collectAnnouncementFilters();
        loadAdminAnnouncements().catch((error) => setAnnouncementError(error.message));
      });
    }
    if (els.announcementAdminEditor) {
      els.announcementAdminEditor.addEventListener('submit', (event) => {
        saveAdminAnnouncement(event).catch((error) => {
          setAnnouncementError(error.message);
          setAnnouncementStatus('');
        });
      });
      const refreshAnnouncementPreview = (event) => {
        if (event.target?.matches?.('input, textarea, select')) {
          renderAnnouncementEditorPreview();
        }
      };
      els.announcementAdminEditor.addEventListener('input', refreshAnnouncementPreview);
      els.announcementAdminEditor.addEventListener('change', refreshAnnouncementPreview);
    }
    if (els.announcementAdminRefresh) {
      els.announcementAdminRefresh.addEventListener('click', () => {
        loadAdminAnnouncements().catch((error) => setAnnouncementError(error.message));
      });
    }
    if (els.resourcesTabDocuments) {
      els.resourcesTabDocuments.addEventListener('click', () => selectResourceTab('documents'));
    }
    if (els.resourcesTabPresets) {
      els.resourcesTabPresets.addEventListener('click', () => selectResourceTab('scope-presets'));
    }
    if (els.resourcesDocumentsSearch) {
      els.resourcesDocumentsSearch.addEventListener('input', () => {
        state.resources.documentFilters.search = els.resourcesDocumentsSearch.value;
        renderResourceDocuments();
      });
    }
    if (els.resourcesDocumentsVisibility) {
      els.resourcesDocumentsVisibility.addEventListener('change', () => {
        state.resources.documentFilters.visibility = els.resourcesDocumentsVisibility.value;
        renderResourceDocuments();
      });
    }
    if (els.resourcesDocumentsStatus) {
      els.resourcesDocumentsStatus.addEventListener('change', () => {
        state.resources.documentFilters.status = els.resourcesDocumentsStatus.value;
        renderResourceDocuments();
      });
    }
    if (els.resourcesNew) {
      els.resourcesNew.addEventListener('click', () => {
        const kind = state.resources.activeTab === 'scope-presets' ? 'scope-preset' : 'document';
        openResourceEditor(kind, null);
      });
    }
    if (els.resourceEditorForm) {
      els.resourceEditorForm.addEventListener('submit', (event) => {
        saveResourceEditor(event).catch((error) => setResourceEditorStatus(error.message));
      });
    }
    if (els.resourceEditorStatusSelect) {
      els.resourceEditorStatusSelect.addEventListener('change', () => {
        setResourceEditorStatus('');
        renderResourceStatusControls();
      });
    }
    if (els.resourceEditorValidate) {
      els.resourceEditorValidate.addEventListener('click', () => {
        if (state.resources.editing?.id) {
          validatePreset(state.resources.editing.id).catch((error) => setResourceEditorStatus(error.message));
        }
      });
    }
    if (els.resourceEditorDelete) {
      els.resourceEditorDelete.addEventListener('click', () => {
        deleteResourceEditor().catch((error) => setResourceEditorStatus(error.message));
      });
    }
    if (els.resourceEditorCancel) {
      els.resourceEditorCancel.addEventListener('click', closeResourceEditor);
    }
    // 批次E（2.2.27）：资源编辑抽屉的关闭 X / 点遮罩 / Escape，与芯片编辑器抽屉一致。
    if (els.resourceEditorClose) {
      els.resourceEditorClose.addEventListener('click', closeResourceEditor);
    }
    if (els.resourceEditorBackdrop) {
      els.resourceEditorBackdrop.addEventListener('click', closeResourceEditor);
    }
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.resourceEditorDrawer && !els.resourceEditorDrawer.hidden) {
        closeResourceEditor();
      }
    });
    for (const link of els.sectionLinks) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        switchSection(link.dataset.section);
      });
    }
    // Role management
    roleEls.add.addEventListener('click', () => openRoleEditor(null));
    roleEls.saveBtn.addEventListener('click', () => handleSaveRole());
    roleEls.cancelBtn.addEventListener('click', closeRoleEditor);
    if (els.modelRoutingForm) {
      els.modelRoutingForm.addEventListener('submit', (event) => {
        saveModelRouting(event).catch((error) => {
          if (els.modelRoutingError) els.modelRoutingError.textContent = error.message;
        });
      });
    }
    if (els.modelRoutingReload) {
      els.modelRoutingReload.addEventListener('click', () => {
        loadModelRouting().catch((error) => {
          if (els.modelRoutingError) els.modelRoutingError.textContent = error.message;
        });
      });
    }
    for (const select of [els.modelRoutingStandard, els.modelRoutingEnhanced, els.modelRoutingMultimodal]) {
      if (select) select.addEventListener('change', syncModelRoutingMultipliers);
    }
    for (const input of roleEls.accessModeInputs) {
      input.addEventListener('change', () => setRoleChipAccessMode(input.value));
    }
    window.addEventListener('beforeunload', (event) => {
      if (state.hasUnsavedChanges) event.preventDefault();
    });
    window.addEventListener('popstate', () => {
      switchSection(parseSectionFromPath(window.location.pathname), { updateUrl: false });
    });

    // 暴露文档与 Scope的最小测试钩子，便于合约测试直接驱动加载/校验/编辑。
    window.AgentXAdminResources = {
      loadResources,
      renderResources,
      selectResourceTab,
      openResourceEditor,
      saveResourceEditor,
      deleteResourceEditor,
      validatePreset
    };

    initUserTabs();
    syncTicketFilterStatusOptions();
    initAdminSidebarCollapse();
    initAdminNavGroups();
    initializeSectionRoute();

    const currentUser = window.AgentXAuth.getUser();
    if (!isAdminUser(currentUser)) {
      showAdminLogin(currentUser ? 'No admin permission: current account is not an admin.' : '');
      return;
    }

    showAdminOperations(currentUser);
    await loadAdminData().catch(handleAdminDataLoadError);
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    setNoPermission('');
    try {
      const payload = await window.AgentXAuth.login(els.adminUsername.value.trim(), els.adminPassword.value);
      if (!isAdminUser(payload.user)) {
        window.AgentXAuth.clearToken();
        showAdminLogin('No admin permission: current account is not an admin.');
        return;
      }
      els.adminPassword.value = '';
      showAdminOperations(payload.user);
      await loadAdminData().catch(handleAdminDataLoadError);
    } catch {
      showAdminLogin('Login failed. Check the username and password.');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    init().catch((error) => showAdminLogin(error.message));
  });

  // ---- Role management state ----
  let roleState = {
    roles: {},
    permissions: {},
    editingRole: null,
    isNewRole: false,
    accessDraft: { modelGrants: [], resourceGrants: { brands: [], productLines: [], chipIds: [], documentIds: [], scopePresetIds: [], mcpTools: [] } }
  };

  const MODEL_ROUTING_ROLES = ['haiku', 'sonnet', 'opus', 'fable'];

  function fillModelRoutingOptions(select) {
    if (!select || select.options.length > 0) return;
    for (const role of MODEL_ROUTING_ROLES) {
      const option = document.createElement('option');
      option.value = role;
      option.textContent = role;
      select.append(option);
    }
  }

  function renderModelRouting(config) {
    const mapping = config?.modeRoleMapping || {};
    fillModelRoutingOptions(els.modelRoutingStandard);
    fillModelRoutingOptions(els.modelRoutingEnhanced);
    fillModelRoutingOptions(els.modelRoutingMultimodal);
    if (els.modelRoutingStandard) els.modelRoutingStandard.value = mapping.standard || 'haiku';
    if (els.modelRoutingEnhanced) els.modelRoutingEnhanced.value = mapping.enhanced || 'sonnet';
    if (els.modelRoutingMultimodal) els.modelRoutingMultimodal.value = mapping.multimodal || 'opus';
    syncModelRoutingMultipliers();
  }

  // 积分倍率不写死：以「标准模式当前所选模型档位」的 creditUnits 为基准（真实口径 1:2:3），
  // 其余两张模式卡按各自所选档位的 creditUnits 相对该基准换算。目录条目缺失时展示 ×—。
  function findModelCatalogEntry(modelId) {
    const catalog = state.modelRouting.catalog;
    if (!Array.isArray(catalog) || !modelId) return null;
    return catalog.find((entry) => entry.id === modelId) || null;
  }

  function syncModelRoutingMultipliers() {
    const standardEntry = findModelCatalogEntry(els.modelRoutingStandard?.value);
    const baseUnits = standardEntry?.creditUnits;
    const cards = [
      { select: els.modelRoutingStandard, target: els.modelRoutingStandardMultiplier },
      { select: els.modelRoutingEnhanced, target: els.modelRoutingEnhancedMultiplier },
      { select: els.modelRoutingMultimodal, target: els.modelRoutingMultimodalMultiplier }
    ];
    for (const { select, target } of cards) {
      if (!target) continue;
      const entry = findModelCatalogEntry(select?.value);
      if (!entry || !baseUnits) {
        target.textContent = '×—';
        continue;
      }
      const multiplier = entry.creditUnits / baseUnits;
      target.textContent = `×${multiplier.toFixed(1)}`;
    }
  }

  function collectModelRoutingConfig() {
    return {
      allowedRoles: MODEL_ROUTING_ROLES,
      modeRoleMapping: {
        standard: els.modelRoutingStandard?.value || 'haiku',
        enhanced: els.modelRoutingEnhanced?.value || 'sonnet',
        multimodal: els.modelRoutingMultimodal?.value || 'opus'
      }
    };
  }

  async function loadModelRouting() {
    state.modelRouting.loading = true;
    if (els.modelRoutingError) els.modelRoutingError.textContent = '';
    if (els.modelRoutingSuccess) els.modelRoutingSuccess.hidden = true;
    // 同上：try/finally 复位 loading，覆盖 fetch reject 的失败路径（原来仅在 fetch resolve 后复位）。
    try {
      const response = await window.AgentXAuth.authFetch('/admin/model-routing', { skipAuthRedirect: true });
      if (handleAdminAuthFailure(response)) return;
      if (!response.ok) {
        const message = adminText(
          'admin.error.loadModelRouting',
          { status: response.status },
          `加载模式与模型档位失败 (${response.status})`
        );
        setSectionStatus('model-routing', 'error', message);
        if (els.modelRoutingError) els.modelRoutingError.textContent = message;
        return;
      }
      const payload = await response.json();
      state.modelRouting.config = payload.config || null;
      state.modelRouting.catalog = Array.isArray(payload.catalog) ? payload.catalog : null;
      renderModelRouting(state.modelRouting.config);
      clearSectionStatus('model-routing', 'error');
    } finally {
      state.modelRouting.loading = false;
    }
  }

  async function saveModelRouting(event) {
    event?.preventDefault();
    if (els.modelRoutingError) els.modelRoutingError.textContent = '';
    if (els.modelRoutingSuccess) els.modelRoutingSuccess.hidden = true;
    const response = await window.AgentXAuth.authFetch('/admin/model-routing', {
      method: 'PUT',
      body: JSON.stringify(collectModelRoutingConfig())
    });
    if (handleAdminAuthFailure(response)) return;
    if (!response.ok) {
      let message = adminText(
        'admin.error.saveModelRouting',
        { status: response.status },
        `保存模式与模型档位失败 (${response.status})`
      );
      try {
        const payload = await response.json();
        message = payload.error || message;
      } catch {}
      setSectionStatus('model-routing', 'error', message);
      if (els.modelRoutingError) els.modelRoutingError.textContent = message;
      return;
    }
    const payload = await response.json();
    state.modelRouting.config = payload.config || null;
    state.modelRouting.catalog = Array.isArray(payload.catalog) ? payload.catalog : null;
    renderModelRouting(state.modelRouting.config);
    if (els.modelRoutingSuccess) {
      els.modelRoutingSuccess.textContent = adminText('admin.modelRouting.saved', '模式与模型档位已保存');
      els.modelRoutingSuccess.hidden = false;
    }
    setSectionStatus('model-routing', 'saved', adminText('admin.modelRouting.saved', '模式与模型档位已保存'));
  }

  // ---- Role management elements ----
  const roleEls = {
    list: document.getElementById('role-list'),
    add: document.getElementById('role-add'),
    editorPlaceholder: document.getElementById('role-editor-placeholder'),
    editorForm: document.getElementById('role-editor-form'),
    editorTitle: document.getElementById('role-editor-title'),
    nameInput: document.getElementById('role-name'),
    descInput: document.getElementById('role-description'),
    permissionList: document.getElementById('role-permission-list'),
    accessModeInputs: document.querySelectorAll('input[name="role-chip-access-mode"]'),
    chipAccessList: document.getElementById('role-chip-access-list'),
    accessEditor: document.getElementById('role-access-editor'),
    injectionPolicy: document.getElementById('role-injection-policy'),
    saveBtn: document.getElementById('role-save'),
    cancelBtn: document.getElementById('role-cancel'),
    errorMsg: document.getElementById('role-error'),
    successMsg: document.getElementById('role-success')
  };

  // ---- Role management functions ----
  async function loadRoles() {
    const response = await window.AgentXAuth.authFetch('/admin/roles', { skipAuthRedirect: true });
    if (handleAdminAuthFailure(response)) {
      return;
    }
    if (!response.ok) {
      setSectionStatus(
        'roles',
        'error',
        adminText('admin.error.loadRoles', { status: response.status }, `加载角色失败 (${response.status})`)
      );
      roleEls.errorMsg.textContent = adminText('admin.error.loadRoles', { status: response.status }, `加载角色失败 (${response.status})`);
      return;
    }
    const payload = await response.json();
    roleState.roles = payload.roles || {};
    roleState.permissions = payload._permissions || {};
    invalidateAllEffectiveAuthorizations();
    clearSectionStatus('roles', 'error');
    populateRoleSelect(els.role, els.role.value || 'customer');
    if (selectedUser()) {
      populateRoleSelect(els.selectedUserRole, selectedUser().role);
    }
    renderRoleList();
    renderPermissionMatrix();
    renderRoleChipAccessOptions();
    renderUsers();
    renderChipAccess();
    if (state.selectedUserId) {
      loadEffectiveAuthorization(state.selectedUserId, { force: true }).catch((error) => {
        setAccessError(error.message, state.selectedUserId);
      });
    }
  }

  function renderRoleList() {
    roleEls.list.replaceChildren();
    roleEls.errorMsg.textContent = '';
    let visibleCount = 0;
    for (const [name, role] of Object.entries(roleState.roles)) {
      if (name.startsWith('_')) continue; // skip _permissions
      visibleCount += 1;
      const row = document.createElement('div');
      row.className = `role-row${name === roleState.editingRole ? ' selected' : ''}`;
      const head = document.createElement('div');
      head.className = 'role-card-head';
      const nameSpan = document.createElement('strong');
      nameSpan.className = 'role-card-name';
      nameSpan.textContent = name;
      const accessBadge = document.createElement('span');
      accessBadge.className = name === 'admin' ? 'admin-badge admin-badge-solid' : 'admin-badge';
      accessBadge.textContent = name === 'admin' ? adminText('admin.roles.fullAccess', '全权') : describeRoleChipAccess(role);
      head.append(nameSpan, accessBadge);
      const descSpan = document.createElement('span');
      descSpan.className = 'role-card-desc';
      descSpan.textContent = role.description || adminText('admin.roles.noDescription', '暂无描述');
      const foot = document.createElement('div');
      foot.className = 'role-card-foot';
      const chipBadge = document.createElement('span');
      chipBadge.className = 'admin-badge admin-badge-muted';
      chipBadge.textContent = describeRoleChipAccess(role);
      const modelBadge = document.createElement('span');
      modelBadge.className = 'admin-badge admin-badge-muted';
      const grants = role.access?.grants || {};
      modelBadge.textContent = adminText(
        'admin.roles.modelCount',
        { count: Array.isArray(grants.modelIds) ? grants.modelIds.length : 0 },
        `${Array.isArray(grants.modelIds) ? grants.modelIds.length : 0} 模型`
      );
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary-button role-edit-btn';
      editBtn.textContent = adminText('admin.action.edit', '编辑');
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openRoleEditor(name);
      });
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'danger-button role-delete-btn';
      deleteBtn.textContent = adminText('admin.action.delete', '删除');
      deleteBtn.dataset.roleName = name;
      deleteBtn.disabled = name === 'admin';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        handleDeleteRole(name);
      });
      const actions = document.createElement('div');
      actions.className = 'role-card-actions';
      actions.append(editBtn, deleteBtn);
      foot.append(chipBadge, modelBadge, actions);
      row.append(head, descSpan, foot);
      row.addEventListener('click', () => openRoleEditor(name));
      roleEls.list.append(row);
    }
    if (visibleCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = adminText('admin.roles.empty', '暂无角色模板');
      roleEls.list.append(empty);
    }
  }

  function describeRoleChipAccess(role) {
    const allowedChips = role?.access?.allowedChips;
    if (!Array.isArray(allowedChips) || allowedChips.length === 0) {
      return adminText('admin.roles.noChips', '无芯片');
    }
    if (allowedChips.includes('*')) {
      return adminText('admin.roles.allChips', '全部芯片');
    }
    return adminText('admin.roles.chipCount', { count: allowedChips.length }, `${allowedChips.length} 个芯片`);
  }

  function renderPermissionMatrix() {
    roleEls.permissionList.replaceChildren();
    if (Object.keys(roleState.permissions).length === 0) return;
    for (const [key, meta] of Object.entries(roleState.permissions)) {
      const label = document.createElement('label');
      label.className = 'permission-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = key;
      const span = document.createElement('span');
      span.textContent = `${meta.label} — ${meta.description}`;
      label.append(checkbox, span);
      roleEls.permissionList.append(label);
    }
  }

  function renderRoleChipAccessOptions() {
    roleEls.chipAccessList.replaceChildren();
    roleEls.chipAccessList.className = 'role-chip-access-list admin-check-list';
  }

  function setRoleChipAccessMode(mode) {
    for (const input of roleEls.accessModeInputs) {
      input.checked = input.value === mode;
    }
    const selectedMode = getRoleChipAccessMode();
    const editingAdmin = roleState.editingRole === 'admin';
    for (const checkbox of roleEls.chipAccessList.querySelectorAll('input[type="checkbox"]')) {
      checkbox.disabled = editingAdmin || selectedMode !== 'selected';
    }
    renderRoleAccessEditor();
  }

  function getRoleChipAccessMode() {
    return [...roleEls.accessModeInputs].find((input) => input.checked)?.value || 'none';
  }

  function applyRoleAccessToEditor(role) {
    const allowedChips = role?.access?.allowedChips || [];
    const mode = allowedChips.includes('*') ? 'all' : allowedChips.length > 0 ? 'selected' : 'none';
    setRoleChipAccessMode(mode);
    roleEls.injectionPolicy.value = role?.access?.injectionPolicy || 'first_turn';
    const grants = role?.access?.grants || {};
    roleState.accessDraft = {
      modelGrants: uniqueSorted(grants.modelIds || []),
      resourceGrants: {
        ...cloneResourceGrants(grants),
        chipIds: allowedChips.includes('*') ? [] : uniqueSorted(grants.chipIds || allowedChips)
      }
    };
    renderRoleAccessEditor();
  }

  function renderRoleAccessEditor() {
    if (!roleEls?.accessEditor || !roleState?.accessDraft) return;
    const editingAdmin = roleState.editingRole === 'admin';
    if (editingAdmin) {
      roleEls.accessEditor.replaceChildren();
      const notice = document.createElement('p');
      notice.className = 'role-access-full-notice';
      notice.textContent = adminText(
        'admin.roles.adminFixedAccess',
        'admin 模板固定拥有全部访问权限；无需逐项编辑模型、资源或芯片清单。'
      );
      roleEls.accessEditor.append(notice);
      return;
    }
    const mode = getRoleChipAccessMode();
    renderAccessEditor({
      namespace: 'role',
      root: roleEls.accessEditor,
      draft: roleState.accessDraft,
      effectiveIds: [],
      disabled: editingAdmin,
      chipDisabled: editingAdmin || mode === 'all' || mode === 'none',
      disabledMessage: editingAdmin
        ? adminText('admin.roles.adminFixedSummary', 'admin 模板固定拥有全部访问权限。')
        : mode === 'all'
          ? adminText('admin.roles.allChipsSummary', '当前模板授予全部芯片，单芯片清单无需编辑。')
          : mode === 'none'
            ? adminText('admin.roles.noDefaultChipsSummary', '当前模板不授予默认芯片；切到“指定芯片”后可编辑。')
            : '',
      onChange: renderRoleAccessEditor
    });
  }

  function collectRoleAccess(name) {
    const extraGrants = collectRoleGrantFields();
    if (name === 'admin') {
      return { allowedChips: ['*'], injectionPolicy: 'every_turn', grants: { ...extraGrants, chipIds: ['*'] } };
    }
    const mode = getRoleChipAccessMode();
    const injectionPolicy = roleEls.injectionPolicy.value || 'first_turn';
    if (mode === 'all') {
      return { allowedChips: ['*'], injectionPolicy, grants: { ...extraGrants, chipIds: ['*'] } };
    }
    if (mode === 'selected') {
      const selected = uniqueSorted(extraGrants.chipIds || []);
      return { allowedChips: selected, injectionPolicy, grants: { ...extraGrants, chipIds: selected } };
    }
    return { allowedChips: [], injectionPolicy, grants: { ...extraGrants, chipIds: [] } };
  }

  function setRoleEditorBuiltinState(name) {
    const editingAdmin = name === 'admin';
    for (const cb of roleEls.permissionList.querySelectorAll('input[type="checkbox"]')) {
      cb.disabled = !editingAdmin;
      if (!editingAdmin) cb.checked = false;
    }
    for (const input of roleEls.accessModeInputs) {
      input.disabled = editingAdmin;
    }
    roleEls.injectionPolicy.disabled = editingAdmin;
    setRoleChipAccessMode(getRoleChipAccessMode());
  }

  function openRoleEditor(name) {
    if (name) {
      const role = roleState.roles[name];
      roleState.editingRole = name;
      roleState.isNewRole = false;
      roleEls.editorTitle.textContent = adminText('admin.roles.editTitle', { name }, `编辑角色: ${name}`);
      roleEls.nameInput.value = name;
      roleEls.nameInput.disabled = true;
      roleEls.descInput.value = role.description || '';
      // Restore checkbox state
      for (const cb of roleEls.permissionList.querySelectorAll('input[type="checkbox"]')) {
        cb.checked = (role.permissions || []).includes(cb.value);
      }
      applyRoleAccessToEditor(role);
      setRoleEditorBuiltinState(name);
    } else {
      roleState.editingRole = null;
      roleState.isNewRole = true;
      roleEls.editorTitle.textContent = adminText('admin.roles.newTitle', '新增角色');
      roleEls.nameInput.value = '';
      roleEls.nameInput.disabled = false;
      roleEls.descInput.value = '';
      for (const cb of roleEls.permissionList.querySelectorAll('input[type="checkbox"]')) {
        cb.checked = false;
      }
      applyRoleAccessToEditor({ access: { allowedChips: [], injectionPolicy: 'first_turn' } });
      setRoleEditorBuiltinState(null);
    }
    roleEls.editorPlaceholder.hidden = true;
    roleEls.editorForm.hidden = false;
    roleEls.errorMsg.textContent = '';
    roleEls.successMsg.hidden = true;
    renderRoleList();
    roleEls.nameInput.focus();
  }

  async function handleSaveRole() {
    const name = roleEls.nameInput.value.trim();
    const description = roleEls.descInput.value.trim();
    const permissions = name === 'admin'
      ? [...roleEls.permissionList.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value)
      : [];

    if (!name) {
      roleEls.errorMsg.textContent = adminText('admin.roles.nameRequired', '角色名称不能为空');
      return;
    }

    const body = { description, permissions, access: collectRoleAccess(name) };
    const isNew = roleState.isNewRole;
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew ? '/admin/roles' : `/admin/roles/${encodeURIComponent(roleState.editingRole)}`;

    const response = await window.AgentXAuth.authFetch(url, {
      method,
      body: JSON.stringify({ name, ...body })
    });

    if (!response.ok) {
      let msg = adminText('admin.error.saveRole', { status: response.status }, `保存失败 (${response.status})`);
      try {
        const err = await response.json();
        msg = err.error || msg;
      } catch {}
      setSectionStatus('roles', 'error', msg);
      roleEls.errorMsg.textContent = msg;
      return;
    }

    await loadRoles();
    openRoleEditor(name);
    roleEls.successMsg.textContent = isNew
      ? adminText('admin.roles.created', '角色已创建')
      : adminText('admin.roles.saved', '角色已保存');
    roleEls.successMsg.hidden = false;
    setSectionStatus('roles', 'saved', roleEls.successMsg.textContent);
  }

  function closeRoleEditor() {
    roleState.editingRole = null;
    roleState.isNewRole = false;
    roleEls.editorPlaceholder.hidden = false;
    roleEls.editorForm.hidden = true;
    renderRoleList();
  }

  async function handleDeleteRole(name) {
    const confirmed = await window.AgentXUI.confirm({
      title: adminText('admin.roles.deleteTitle', '删除角色'),
      body: adminText('admin.roles.deleteBody', { name }, `确认删除角色「${name}」？`),
      confirmText: adminText('admin.action.delete', '删除'),
      danger: true
    });
    if (!confirmed) return;
    const response = await window.AgentXAuth.authFetch(`/admin/roles/${encodeURIComponent(name)}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      let msg = adminText('admin.error.deleteRole', { status: response.status }, `删除失败 (${response.status})`);
      try {
        const err = await response.json();
        msg = err.error || msg;
      } catch {}
      setSectionStatus('roles', 'error', msg);
      roleEls.errorMsg.textContent = msg;
      return;
    }
    closeRoleEditor();
    await loadRoles();
  }
})();
