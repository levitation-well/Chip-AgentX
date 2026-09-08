/**
 * B2 — Chat 对话流可靠性加固（P6）合约 + 行为测试
 *
 * 直接从 public/chat.js 真实源码取出相关函数（两哨兵之间），用 new Function 注入闭包依赖后求值，
 * 让测试驱动真实控制流，而非镜像副本。覆盖：
 *   - Task 6.1：防御性 SSE JSON.parse + 发送按钮锁 + 缓冲上限 + textarea maxlength
 *   - Task 6.2：停止/取消 + 空 finalize 区分（过滤为空 vs 真空）
 *   - Task 6.3：超时信号 + onerror 退避重连 + 刷新孤儿流清理
 *
 * 测试机制：mock window.AgentXAuth.openAuthorizedEventStream 返回受控 fake EventSource，
 * mock window.AgentXAuth.authFetch（带 headers.get shim）。spy setError 等。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

/**
 * 从源码取出 `function name(` 起、配平花括号止的完整函数字节。
 * 注意：先跳过参数列表（其默认值可能含 `= {}`，会干扰花括号配平），
 * 从参数列表的右括号之后开始数函数体花括号。
 */
function extractFunctionSource(js: string, name: string): string {
  let start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in chat.js`);
  // 保留可能的 async 前缀，否则提取出的函数丢掉 async、内部 await 会语法报错。
  if (js.slice(start - 6, start) === 'async ') {
    start -= 6;
  }
  // 跳过参数列表：从 `(` 配平到对应 `)`，再找其后第一个 `{` 作为函数体起点。
  const parenStart = js.indexOf('(', start);
  let parenDepth = 0;
  let afterParams = -1;
  for (let index = parenStart; index < js.length; index += 1) {
    const char = js[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        afterParams = index + 1;
        break;
      }
    }
  }
  if (afterParams === -1) throw new Error(`${name} params not closed`);
  const bodyStart = js.indexOf('{', afterParams);
  let depth = 0;
  for (let index = bodyStart; index < js.length; index += 1) {
    const char = js[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return js.slice(start, index + 1);
  }
  throw new Error(`${name} body not closed`);
}

/** 受控 fake EventSource：记录监听器，可手动派发，可断言 close。 */
class FakeEventSource {
  listeners = new Map<string, ((event: { data: string }) => void)[]>();
  onerror: ((event?: unknown) => void) | null = null;
  closed = false;
  addEventListener(type: string, handler: (event: { data: string }) => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  close() {
    this.closed = true;
  }
  /** 派发一个事件，返回该次派发是否抛出（用于断言「不崩」）。 */
  emit(type: string, data: string): { threw: boolean; error?: unknown } {
    const handlers = this.listeners.get(type) || [];
    for (const handler of handlers) {
      try {
        handler({ data });
      } catch (error) {
        return { threw: true, error };
      }
    }
    return { threw: false };
  }
  triggerError() {
    if (this.onerror) this.onerror();
  }
}

/** 带 headers.get shim 的 fetch 响应 mock。 */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: () => null },
    json: async () => body
  };
}

/**
 * 构造一个真实 chat.js 流式相关函数的可调用闭包族：openStream / handleFinalAssistantEvent /
 * bufferStreamOutput / closeStream / finalizeAssistantMessage / shouldIgnoreStreamEvent，
 * 注入测试可控的 state、window、setError/renderMessages 等协作者。
 */
function loadStreamHarness(overrides: Record<string, unknown> = {}) {
  const js = readPublicFile('chat.js');
  const fns = [
    'openStream',
    'shouldIgnoreStreamEvent',
    'safeParseStreamEvent',
    'handleFinalAssistantEvent',
    'bufferStreamOutput',
    'closeStream',
    'finalizeAssistantMessage',
    'finalizeFilteredEmpty',
    'setSendControlsBusy',
    'scheduleStreamReconnect',
    'clearStreamReconnect',
    'pollSessionStatus',
    'startTurnTimeoutWatch',
    'clearTurnTimeoutWatch',
    'markStreamActivity',
    'persistActiveStream',
    'clearPersistedActiveStream',
    'readPersistedActiveStream',
    'handleStreamTimeout',
    'cancelActiveTurn',
    'setTurnPhase',
    'finishTurn',
    'isTurnBusy',
    'syncComposerAvailability',
    'hasSelectableMode',
    'modeUnavailableMessage'
  ];
  const bodies = fns
    .map((name) => {
      try {
        return extractFunctionSource(js, name);
      } catch {
        return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');

  const setError = vi.fn();
  const renderMessages = vi.fn();
  const setMessages = vi.fn();
  const showAssistantActivity = vi.fn();
  const refreshLog = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const stopActivityDots = vi.fn();
  const formatPayloadMessages = vi.fn().mockReturnValue([]);
  const formatOutputData = vi.fn((raw: unknown) => String(raw ?? '').trim());
  const appendMessage = vi.fn();
  const nextClientId = vi.fn(() => 'assistant-x');
  const trackRunningSession = vi.fn();
  const completeSessionTurn = vi.fn();
  const mergeSnapshotMessages = vi.fn((_messages: unknown[], _sessionId: string) => state.messages);

  const state = {
    activeSessionId: 's1',
    activeAssistantMessageId: null as string | null,
    eventSource: null as FakeEventSource | null,
    messages: [] as any[],
    streamBuffers: new Map<string, string>(),
    streamReconnectAttempts: 0,
    turnPhase: 'idle',
    turnSessionId: null as string | null,
    inFlight: false,
    imageUploadPending: false,
    searchModes: [{ id: 'standard', available: true, selectable: true, disabledReasons: [] }],
    ...(overrides.state as object || {})
  };

  const els = (overrides.els as object) || {
    sendMessage: { disabled: false } as { disabled: boolean },
    stopMessage: { hidden: true } as { hidden: boolean }
  };

  const deps: Record<string, unknown> = {
    state,
    els,
    setError,
    renderMessages,
    setMessages,
    showAssistantActivity,
    refreshLog,
    loadSessions,
    stopActivityDots,
    formatPayloadMessages,
    formatOutputData,
    appendMessage,
    nextClientId,
    trackRunningSession,
    completeSessionTurn,
    mergeSnapshotMessages,
    i18n: vi.fn((key: string) => key),
    isModeSelectable: vi.fn(() => true),
    selectedChatMode: vi.fn(() => 'standard'),
    activeSession: vi.fn(() => null),
    JSON,
    console,
    window: (overrides.window as object) || {
      AgentXAuth: {
        openAuthorizedEventStream: vi.fn(() => new FakeEventSource())
      },
      setTimeout: (fn: () => void) => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    },
    ...overrides
  };
  delete deps.state;
  const depNames = ['state', ...Object.keys(deps)];
  const depValues = [state, ...Object.values(deps)];
  // 注入 chat.js 中定义在函数外的可靠性常量，供提取出的函数体引用。
  const constPrelude = [
    'const STREAM_BUFFER_MAX_BYTES = 64 * 1024;',
    'const STREAM_IDLE_TIMEOUT_MS = 11 * 60 * 1000;',
    'const STREAM_RECONNECT_BASE_MS = 1000;',
    'const STREAM_RECONNECT_MAX_MS = 30 * 1000;',
    'const STREAM_RECONNECT_MAX_ATTEMPTS = 5;',
    "const ACTIVE_STREAM_STORAGE_KEY = 'agentx.chat.activeStream';",
    "const lookupActivityText = () => '正在查阅资料';",
    "const isLookupActivityText = (text) => text === lookupActivityText();"
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...depNames,
    `${constPrelude}\n${bodies}\nreturn { openStream, shouldIgnoreStreamEvent, handleFinalAssistantEvent, bufferStreamOutput, closeStream, finalizeAssistantMessage };`
  );
  const api = factory(...depValues);
  return {
    api,
    state,
    spies: {
      setError,
      renderMessages,
      setMessages,
      showAssistantActivity,
      refreshLog,
      loadSessions,
      stopActivityDots,
      formatPayloadMessages,
      trackRunningSession,
      completeSessionTurn,
      mergeSnapshotMessages
    }
  };
}

// ───────────────────────────── Task 6.1 ─────────────────────────────
describe('B2 Task 6.1 — 防御性 SSE + 发送按钮锁 + 缓冲上限 + maxlength', () => {
  it('SSE 各事件 JSON.parse 包 try-catch：损坏 JSON → setError、监听不崩', () => {
    const source = new FakeEventSource();
    const harness = loadStreamHarness({
      window: {
        AgentXAuth: { openAuthorizedEventStream: () => source },
        setTimeout: () => 0,
        clearTimeout: () => {},
        setInterval: () => 0,
        clearInterval: () => {},
        sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
      }
    });
    harness.api.openStream('s1');
    expect(harness.state.eventSource).toBe(source);

    // 投递损坏 JSON 到 snapshot/output/state/final，断言不抛 + setError 被调
    for (const type of ['snapshot', 'output', 'state', 'final']) {
      const result = source.emit(type, '{not-json');
      expect(result.threw).toBe(false);
    }
    expect(harness.spies.setError).toHaveBeenCalled();
  });

  it('bufferStreamOutput 设单会话上限：无 newline 超大输入不会无限增长', () => {
    const js = readPublicFile('chat.js');
    const fnSrc = extractFunctionSource(js, 'bufferStreamOutput');
    // 上限相关源码合约：必须出现一个上限常量与 slice 截断
    expect(fnSrc).toMatch(/MAX|cap|65536|64\s*\*\s*1024|limit/i);

    const state = { streamBuffers: new Map<string, string>() };
    // 上限常量定义在函数外，求值时需一并注入。
    // eslint-disable-next-line no-new-func
    const bufferStreamOutput = new Function(
      'state',
      `const STREAM_BUFFER_MAX_BYTES = 64 * 1024;\n${fnSrc}\nreturn bufferStreamOutput;`
    )(state);
    // 投递一个远超 64KB、且不含 newline 的块
    const big = 'a'.repeat(200000);
    bufferStreamOutput('s1', big);
    const stored = state.streamBuffers.get('s1') || '';
    expect(stored.length).toBeLessThanOrEqual(65536);
    // 再追加一块，仍不超过上限（验证持续增量也有界）
    bufferStreamOutput('s1', 'b'.repeat(100000));
    expect((state.streamBuffers.get('s1') || '').length).toBeLessThanOrEqual(65536);
  });

  it('chat.html textarea 含 maxlength', () => {
    const html = readPublicFile('chat.html');
    const textarea = html.match(/<textarea id="message"[^>]*>/);
    expect(textarea).not.toBeNull();
    expect(textarea![0]).toMatch(/maxlength="\d+"/);
  });

  it('sendMessage 通过统一 turn phase 保持忙碌，只有终态才复位（源码合约）', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'sendMessage');
    expect(fn).toContain("setTurnPhase('submitting'");
    expect(fn).toMatch(/if\s*\(\s*isTurnBusy\(\)\s*\)/);
    expect(fn).not.toMatch(/finally\s*\{[\s\S]*setSendControlsBusy\(false\)/);
    expect(js).toContain("setTurnPhase('running'");
    expect(js).toContain('finishTurn(');
    // setSendControlsBusy 真正禁用发送按钮
    const setter = extractFunctionSource(js, 'setSendControlsBusy');
    expect(setter).toMatch(/els\.sendMessage\.disabled\s*=\s*busy\s*\|\|/);
  });
});

// ───────────────────────────── Task 6.2 ─────────────────────────────
describe('B2 Task 6.2 — 停止/取消 + 空 vs 过滤为空 finalize', () => {
  it('chat.html 含停止按钮', () => {
    const html = readPublicFile('chat.html');
    expect(html).toMatch(/id="stop-message"/);
  });

  it('cancelActiveTurn 关闭流 + 置用户取消标志 + 清 loading（源码合约）', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'cancelActiveTurn');
    expect(fn).toMatch(/closeStream/);
    expect(fn).toMatch(/userCancelled|cancelled|canceled/i);
  });

  it('finalizeAssistantMessage 过滤为空时清理 streaming 状态、不卡 spinner（不再静默 return）', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'finalizeAssistantMessage');
    // 过滤为空分支：当 text 为空且 options.filteredEmpty 时，清 active 状态而非直接 return
    expect(fn).toMatch(/filteredEmpty/);
  });

  it('handleFinalAssistantEvent 给 finalize 传 filteredEmpty 标志', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'handleFinalAssistantEvent');
    expect(fn).toMatch(/filteredEmpty/);
  });

  it('行为：空 final（过滤为空）清掉 streaming 的 assistant 占位，不覆盖已渲染真答', () => {
    const js = readPublicFile('chat.js');
    const finalizeSrc = extractFunctionSource(js, 'finalizeAssistantMessage');
    const filteredEmptySrc = extractFunctionSource(js, 'finalizeFilteredEmpty');
    const stopActivityDots = vi.fn();
    const renderMessages = vi.fn();
    const appendMessage = vi.fn();
    const nextClientId = vi.fn(() => 'a');
    const lookupActivityText = () => '正在查阅资料';
    const isLookupActivityText = (text: string) => text === lookupActivityText();
    const state = {
      activeAssistantMessageId: 'streaming-1',
      activeSessionId: 's1',
      messages: [
        // 此前已渲染的真实回答（不得被覆盖）
        { id: 'real-1', role: 'assistant', text: '寄存器 0x10 控制 PWM 占空比。', status: undefined },
        { id: 'streaming-1', role: 'assistant', text: lookupActivityText, status: 'streaming' }
      ] as any[]
    };
    // eslint-disable-next-line no-new-func
    const factory = new Function(
      'state',
      'stopActivityDots',
      'renderMessages',
      'appendMessage',
      'nextClientId',
      'lookupActivityText',
      'isLookupActivityText',
      `${finalizeSrc}\n${filteredEmptySrc}\nreturn finalizeAssistantMessage;`
    );
    const finalizeAssistantMessage = factory(
      state,
      stopActivityDots,
      renderMessages,
      appendMessage,
      nextClientId,
      lookupActivityText,
      isLookupActivityText
    );

    finalizeAssistantMessage('', { filteredEmpty: true });
    // streaming 占位被清状态（status 不再为 streaming），spinner 不再卡住
    const placeholder = state.messages.find((m) => m.id === 'streaming-1');
    expect(placeholder?.status).not.toBe('streaming');
    expect(state.activeAssistantMessageId).toBeNull();
    // 此前的真实回答原样保留，未被空结果覆盖
    const real = state.messages.find((m) => m.id === 'real-1');
    expect(real?.text).toBe('寄存器 0x10 控制 PWM 占空比。');
  });
});

// ───────────────────────────── Task 6.3 ─────────────────────────────
describe('B2 Task 6.3 — 超时信号 + 退避重连 + 刷新孤儿流清理', () => {
  it('onerror 关闭旧源并尝试退避重连（源码合约）', () => {
    const js = readPublicFile('chat.js');
    const open = extractFunctionSource(js, 'openStream');
    // onerror 不再只 setError 文案：须关闭旧源 + 触发重连调度
    expect(open).toMatch(/scheduleStreamReconnect|reconnect/i);
    const reconnect = extractFunctionSource(js, 'scheduleStreamReconnect');
    // 指数退避：基于尝试次数计算延迟
    expect(reconnect).toMatch(/attempt|backoff|Math\.(?:min|pow)/i);
  });

  it('超时信号：先 poll 服务端，running 时保持忙碌并重连', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain("i18n('chat.error.streamReconnect')");
    expect(js).toContain('const STREAM_IDLE_TIMEOUT_MS = 11 * 60 * 1000');
    const watch = extractFunctionSource(js, 'startTurnTimeoutWatch');
    expect(watch).toMatch(/setTimeout|setInterval/);
    const handle = extractFunctionSource(js, 'handleStreamTimeout');
    expect(handle).toMatch(/pollSessionStatus/);
    expect(handle).toMatch(/status === 'running'/);
    expect(handle).toMatch(/openStream/);
  });

  it('刷新孤儿流清理：活动流存 sessionStorage，init 关残留 + PageVisibility', () => {
    const js = readPublicFile('chat.js');
    expect(js).toMatch(/sessionStorage/);
    expect(js).toMatch(/persistActiveStream|agentx\.chat\.activeStream/);
    // init 检测残留旧流并关闭
    const init = extractFunctionSource(js, 'init');
    expect(init).toMatch(/persistActiveStream|activeStream|closeStream/);
    // pagehide / visibilitychange 清理
    expect(js).toMatch(/pagehide|visibilitychange/);
  });
});

describe('V2.2.39 Chat lifecycle regression guards', () => {
  it('merges a user-only SSE snapshot without deleting persisted history or the active loading message', () => {
    const js = readPublicFile('chat.js');
    const mergeSrc = extractFunctionSource(js, 'mergeSnapshotMessages');
    const state = {
      messages: [
        { id: 'u1', role: 'user', text: 'old question', sessionId: 's1', turnId: 't1' },
        { id: 'a1', role: 'assistant', text: 'old answer', sessionId: 's1', turnId: 't1' },
        { id: 'u2-local', role: 'user', text: 'new question', sessionId: 's1', status: 'sent', turnId: 't2' },
        { id: 'loading', role: 'assistant', text: '正在查阅资料', sessionId: 's1', status: 'streaming' }
      ]
    };
    const mergeSnapshotMessages = new Function(
      'state',
      `${mergeSrc}\nreturn mergeSnapshotMessages;`
    )(state);

    const merged = mergeSnapshotMessages([
      { id: 'server-u2', role: 'user', text: 'new question', sessionId: 's1', turnId: 't2' }
    ], 's1');

    expect(merged.map((message: any) => message.text)).toEqual([
      'old question',
      'old answer',
      'new question',
      '正在查阅资料'
    ]);
    expect(merged.find((message: any) => message.turnId === 't2')?.id).toBe('u2-local');
    expect(merged.find((message: any) => message.id === 'loading')?.status).toBe('streaming');

    const openStream = extractFunctionSource(js, 'openStream');
    expect(openStream).toContain('mergeSnapshotMessages(snapshotMessages, sessionId)');
    expect(openStream).toContain('preserveActiveAssistant: true');
  });

  it('uses the server snapshot as the timeline when the local view only has the new optimistic turn', () => {
    const mergeSrc = extractFunctionSource(readPublicFile('chat.js'), 'mergeSnapshotMessages');
    const state = {
      messages: [
        { id: 'u2-local', role: 'user', text: 'new question', sessionId: 's1', status: 'sent' },
        { id: 'loading', role: 'assistant', text: '正在查阅资料', sessionId: 's1', status: 'streaming' }
      ]
    };
    const mergeSnapshotMessages = new Function(
      'state',
      `${mergeSrc}\nreturn mergeSnapshotMessages;`
    )(state);

    const merged = mergeSnapshotMessages([
      { id: 'server-u1', role: 'user', text: 'old question', sessionId: 's1' },
      { id: 'server-a1', role: 'assistant', text: 'old answer', sessionId: 's1' },
      { id: 'server-u2', role: 'user', text: 'new question', sessionId: 's1' }
    ], 's1');

    expect(merged.map((message: any) => message.text)).toEqual([
      'old question',
      'old answer',
      'new question',
      '正在查阅资料'
    ]);
    expect(merged[2].id).toBe('u2-local');
  });

  it('does not duplicate an optimistic turn when a stale snapshot only contains older history', () => {
    const mergeSrc = extractFunctionSource(readPublicFile('chat.js'), 'mergeSnapshotMessages');
    const state = {
      messages: [
        { id: 'u1-local', role: 'user', text: 'old question', sessionId: 's1' },
        { id: 'a1-local', role: 'assistant', text: 'old answer', sessionId: 's1' },
        { id: 'u2-local', role: 'user', text: 'new question', sessionId: 's1', status: 'sent' },
        { id: 'loading', role: 'assistant', text: '正在查阅资料', sessionId: 's1', status: 'streaming' }
      ]
    };
    const mergeSnapshotMessages = new Function(
      'state',
      `${mergeSrc}\nreturn mergeSnapshotMessages;`
    )(state);

    const merged = mergeSnapshotMessages([
      { id: 'server-u1', role: 'user', text: 'old question', sessionId: 's1' },
      { id: 'server-a1', role: 'assistant', text: 'old answer', sessionId: 's1' }
    ], 's1');

    expect(merged.map((message: any) => message.text)).toEqual([
      'old question',
      'old answer',
      'new question',
      '正在查阅资料'
    ]);
    expect(merged.filter((message: any) => message.id === 'u2-local')).toHaveLength(1);
    expect(merged.filter((message: any) => message.id === 'loading')).toHaveLength(1);
  });

  it('marks an existing session row running before the send request resolves', () => {
    const js = readPublicFile('chat.js');
    const beginSrc = extractFunctionSource(js, 'beginSessionTurn');
    const updateSrc = extractFunctionSource(js, 'updateSessionState');
    const state = {
      sessions: [{ id: 's1', turnState: 'idle', status: 'idle' }],
      sessionRunEpochs: new Map(),
      sessionTerminalOverrides: new Map(),
      sessionTerminalRefreshTimers: new Map()
    };
    const scheduleSessionStatusReconciliation = vi.fn();
    const beginSessionTurn = new Function(
      'state',
      'window',
      'renderSessions',
      'renderSessionMeta',
      'syncComposerAvailability',
      'scheduleSessionStatusReconciliation',
      `${updateSrc}\n${beginSrc}\nreturn beginSessionTurn;`
    )(
      state,
      { clearTimeout: vi.fn() },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      scheduleSessionStatusReconciliation
    );

    beginSessionTurn('s1');
    expect(state.sessions[0]).toMatchObject({ turnState: 'running', status: 'running' });
    expect(scheduleSessionStatusReconciliation).not.toHaveBeenCalled();

    const send = extractFunctionSource(js, 'sendMessage');
    expect(send.indexOf('beginSessionTurn(session.id)')).toBeLessThan(send.indexOf('authFetch(`/sessions/'));
    expect(extractFunctionSource(js, 'openStream')).toContain('trackRunningSession(sessionId)');
  });

  it('updates terminal session state immediately and schedules list convergence after persistence', () => {
    const js = readPublicFile('chat.js');
    const completeSrc = extractFunctionSource(js, 'completeSessionTurn');
    const updateSrc = extractFunctionSource(js, 'updateSessionState');
    const state = {
      sessions: [{ id: 's1', turnState: 'running', status: 'running' }],
      sessionRunEpochs: new Map([['s1', 1]]),
      sessionReconcileTimers: new Map(),
      sessionTerminalOverrides: new Map(),
      sessionTerminalRefreshTimers: new Map()
    };
    const scheduleTerminalListConvergence = vi.fn();
    const completeSessionTurn = new Function(
      'state',
      'window',
      'renderSessions',
      'renderSessionMeta',
      'syncComposerAvailability',
      'scheduleTerminalListConvergence',
      `${updateSrc}\n${completeSrc}\nreturn completeSessionTurn;`
    )(
      state,
      { clearTimeout: vi.fn() },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      scheduleTerminalListConvergence
    );

    completeSessionTurn('s1', 'idle');
    expect(state.sessions[0]).toMatchObject({ turnState: 'idle', status: 'idle' });
    expect(state.sessionTerminalOverrides.get('s1')).toBe('idle');
    expect(scheduleTerminalListConvergence).toHaveBeenCalledWith('s1');

    const convergence = extractFunctionSource(js, 'scheduleTerminalListConvergence');
    expect(convergence).toContain('loadSessions()');
    expect(convergence).toContain('SESSION_TERMINAL_REFRESH_DELAYS_MS');
    const select = extractFunctionSource(js, 'selectSession');
    expect(select).toContain('trackRunningSession(backgroundSessionId)');
  });

  it('stops tracking sessions removed by an authoritative list refresh and terminates unavailable polls', () => {
    const js = readPublicFile('chat.js');
    const applyLoadedSessions = new Function(
      'state',
      'window',
      'normalizeSession',
      'isRunningSession',
      'trackRunningSession',
      `${extractFunctionSource(js, 'applyLoadedSessions')}\nreturn applyLoadedSessions;`
    );
    const reconcileTimer = 11;
    const terminalTimer = 12;
    const clearTimeout = vi.fn();
    const state = {
      sessions: [{ id: 'gone', turnState: 'running' }],
      sessionRunEpochs: new Map([['gone', 1]]),
      sessionReconcileTimers: new Map([['gone', reconcileTimer]]),
      sessionTerminalOverrides: new Map([['gone', 'idle']]),
      sessionTerminalRefreshTimers: new Map([['gone', terminalTimer]])
    };

    applyLoadedSessions(
      state,
      { clearTimeout },
      (session: any) => session,
      () => false,
      vi.fn()
    )([]);

    expect(state.sessions).toEqual([]);
    expect(state.sessionRunEpochs.size).toBe(0);
    expect(state.sessionReconcileTimers.size).toBe(0);
    expect(state.sessionTerminalOverrides.size).toBe(0);
    expect(state.sessionTerminalRefreshTimers.size).toBe(0);
    expect(clearTimeout).toHaveBeenCalledWith(reconcileTimer);
    expect(clearTimeout).toHaveBeenCalledWith(terminalTimer);

    const reconcile = extractFunctionSource(js, 'scheduleSessionStatusReconciliation');
    expect(reconcile).toContain("error?.status === 403 || isUnavailableSessionStatusError(error)");
    expect(reconcile).toContain('sessionId === state.activeSessionId && state.turnSessionId === sessionId');
    expect(reconcile).toContain('finishUnavailableSession(sessionId, error, generation)');
    expect(reconcile).toContain("completeSessionTurn(sessionId, 'failed')");
  });

  it('routes an active unavailable status poll through the full terminal cleanup path', async () => {
    const js = readPublicFile('chat.js');
    const scheduled: Array<() => void> = [];
    const finishUnavailableSession = vi.fn().mockResolvedValue(undefined);
    const completeSessionTurn = vi.fn();
    const state = {
      activeSessionId: 's1',
      activeSessionGeneration: 7,
      turnSessionId: 's1',
      sessionRunEpochs: new Map([['s1', 2]]),
      sessionReconcileTimers: new Map()
    };
    const scheduleSessionStatusReconciliation = new Function(
      'state',
      'window',
      'pollSessionStatus',
      'updateSessionState',
      'completeSessionTurn',
      'refreshLog',
      'isCurrentSessionGeneration',
      'setError',
      'closeStream',
      'finishTurn',
      'isUnavailableSessionStatusError',
      'finishUnavailableSession',
      'loadSessions',
      `const SESSION_STATUS_RECONCILE_MS = 1;\n${extractFunctionSource(js, 'scheduleSessionStatusReconciliation')}\nreturn scheduleSessionStatusReconciliation;`
    )(
      state,
      { setTimeout: (callback: () => void) => { scheduled.push(callback); return 1; } },
      vi.fn().mockRejectedValue(Object.assign(new Error('gone'), { status: 404 })),
      vi.fn(),
      completeSessionTurn,
      vi.fn().mockResolvedValue(undefined),
      vi.fn(() => true),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      (error: any) => error?.status === 404 || error?.status === 410,
      finishUnavailableSession,
      vi.fn().mockResolvedValue(undefined)
    );

    scheduleSessionStatusReconciliation('s1', 2);
    scheduled[0]();
    await vi.waitFor(() => {
      expect(finishUnavailableSession).toHaveBeenCalledWith(
        's1',
        expect.objectContaining({ status: 404 }),
        7
      );
    });
    expect(completeSessionTurn).not.toHaveBeenCalled();
  });

  it('keeps terminal reconciliation pending until the delayed assistant transcript converges', async () => {
    const js = readPublicFile('chat.js');
    const scheduled: Array<() => void> = [];
    let settleTranscript!: (value: boolean) => void;
    const transcriptSettled = new Promise<boolean>((resolve) => {
      settleTranscript = resolve;
    });
    const completeSessionTurn = vi.fn();
    const finishTurn = vi.fn();
    const closeStream = vi.fn();
    const refreshTerminalTurnWithRetry = vi.fn(() => transcriptSettled);
    const state = {
      activeSessionId: 's1',
      activeSessionGeneration: 9,
      turnSessionId: 's1',
      sessionRunEpochs: new Map([['s1', 4]]),
      sessionReconcileTimers: new Map()
    };
    const scheduleSessionStatusReconciliation = new Function(
      'state',
      'window',
      'pollSessionStatus',
      'updateSessionState',
      'completeSessionTurn',
      'refreshTerminalTurnWithRetry',
      'latestUserTurnReference',
      'isCurrentSessionGeneration',
      'setError',
      'closeStream',
      'finishTurn',
      'isUnavailableSessionStatusError',
      'finishUnavailableSession',
      'loadSessions',
      `const SESSION_STATUS_RECONCILE_MS = 1;\n${extractFunctionSource(js, 'scheduleSessionStatusReconciliation')}\nreturn scheduleSessionStatusReconciliation;`
    )(
      state,
      { setTimeout: (callback: () => void) => { scheduled.push(callback); return 1; } },
      vi.fn().mockResolvedValue('idle'),
      vi.fn(),
      completeSessionTurn,
      refreshTerminalTurnWithRetry,
      vi.fn(() => ({ turnId: 'turn-4', text: 'question' })),
      (sessionId: string, generation: number) => sessionId === state.activeSessionId
        && generation === state.activeSessionGeneration,
      vi.fn(),
      closeStream,
      finishTurn,
      (error: any) => error?.status === 404 || error?.status === 410,
      vi.fn(),
      vi.fn()
    );

    scheduleSessionStatusReconciliation('s1', 4);
    scheduled[0]();
    await vi.waitFor(() => {
      expect(refreshTerminalTurnWithRetry).toHaveBeenCalledWith(
        's1',
        9,
        4,
        { turnId: 'turn-4', text: 'question' }
      );
    });
    expect(completeSessionTurn).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();

    settleTranscript(true);
    await vi.waitFor(() => {
      expect(completeSessionTurn).toHaveBeenCalledWith('s1', 'idle');
    });
    expect(closeStream).toHaveBeenCalledTimes(1);
    expect(finishTurn).toHaveBeenCalledWith('s1');
  });

  it('clears the active stop state as soon as server state or exit becomes terminal', () => {
    const openStream = extractFunctionSource(readPublicFile('chat.js'), 'openStream');
    const idleBranch = openStream.slice(openStream.indexOf("turnState === 'idle'"));
    expect(idleBranch.indexOf('finishTurn(sessionId)')).toBeLessThan(idleBranch.indexOf('refreshLog('));
    const exitBranch = openStream.slice(openStream.indexOf("source.addEventListener('exit'"));
    expect(exitBranch.indexOf('finishTurn(sessionId)')).toBeLessThan(exitBranch.indexOf('refreshLog('));
  });
});

describe('V2.2.40 running conversation view restoration', () => {
  function loadRunningViewHarness(initialMessages: any[], activeSessionId = 'a') {
    const js = readPublicFile('chat.js');
    const state = {
      activeSessionId,
      activeAssistantMessageId: null as string | null,
      turnPhase: 'idle',
      turnSessionId: null as string | null,
      inFlight: false,
      messageRevision: 0,
      messages: initialMessages.map((message) => ({ ...message }))
    };
    let nextId = 0;
    const stopActivityDots = vi.fn();
    const renderMessages = vi.fn();
    const syncComposerAvailability = vi.fn();
    const appendMessage = vi.fn((role: string, text: string, options: any = {}) => {
      const message = { role, text, ...options };
      state.messages.push(message);
      state.messageRevision += 1;
      renderMessages();
      return message;
    });
    const factory = new Function(
      'state',
      'stopActivityDots',
      'renderMessages',
      'syncComposerAvailability',
      'appendMessage',
      'nextClientId',
      'lookupActivityText',
      'isLookupActivityText',
      `${extractFunctionSource(js, 'setTurnPhase')}\n` +
      `${extractFunctionSource(js, 'clearRunningAssistantPlaceholder')}\n` +
      `${extractFunctionSource(js, 'restoreRunningTurnView')}\n` +
      `${extractFunctionSource(js, 'finishTurn')}\n` +
      'return { restoreRunningTurnView, finishTurn };'
    );
    const api = factory(
      state,
      stopActivityDots,
      renderMessages,
      syncComposerAvailability,
      appendMessage,
      () => `assistant-${++nextId}`,
      () => '正在查阅资料',
      (text: string) => text === '正在查阅资料'
    );
    return { api, state, spies: { appendMessage, stopActivityDots, renderMessages, syncComposerAvailability } };
  }

  it('restores exactly one loading assistant after A -> B -> A while keeping stop controls active', () => {
    const harness = loadRunningViewHarness([
      { id: 'a-u2', role: 'user', text: 'A new question', sessionId: 'a', turnId: 'a-t2' }
    ]);

    expect(harness.api.restoreRunningTurnView('a')).toBe(true);
    expect(harness.state.messages.filter((message: any) => message.sessionId === 'a' && message.status === 'streaming')).toHaveLength(1);
    expect(harness.state).toMatchObject({
      activeAssistantMessageId: 'assistant-1',
      turnPhase: 'running',
      turnSessionId: 'a',
      inFlight: true
    });

    // B is selected and restored independently.
    harness.state.activeSessionId = 'b';
    harness.state.messages = [
      { id: 'b-u3', role: 'user', text: 'B new question', sessionId: 'b', turnId: 'b-t3' }
    ];
    harness.state.activeAssistantMessageId = null;
    expect(harness.api.restoreRunningTurnView('b')).toBe(true);
    expect(harness.state.messages.filter((message: any) => message.sessionId === 'b' && message.status === 'streaming')).toHaveLength(1);

    // Returning to A after refresh replaces the visible transcript, so the
    // running view is reconstructed from A's latest persisted user turn.
    harness.state.activeSessionId = 'a';
    harness.state.messages = [
      { id: 'a-u2-server', role: 'user', text: 'A new question', sessionId: 'a', turnId: 'a-t2' }
    ];
    harness.state.activeAssistantMessageId = null;
    expect(harness.api.restoreRunningTurnView('a')).toBe(true);
    expect(harness.state.messages.map((message: any) => message.text)).toEqual([
      'A new question',
      '正在查阅资料'
    ]);
    expect(harness.state.messages[1].turnId).toBe('a-t2');

    const selectSession = extractFunctionSource(readPublicFile('chat.js'), 'selectSession');
    const refreshLog = extractFunctionSource(readPublicFile('chat.js'), 'refreshLog');
    expect(refreshLog).toContain('sessionStateValue(payload.session || payload)');
    expect(refreshLog.indexOf('updateSessionState(targetSessionId, refreshedTurnState)'))
      .toBeLessThan(refreshLog.indexOf('const refreshedMessages = formatPayloadMessages(payload'));
    const refreshIndex = selectSession.indexOf('await refreshLog()');
    const restoreIndex = selectSession.indexOf('restoreRunningTurnView(sessionId)');
    const streamIndex = selectSession.indexOf("openStream(sessionId, { preserveActiveAssistant: true })");
    expect(refreshIndex).toBeGreaterThan(-1);
    expect(refreshIndex).toBeLessThan(restoreIndex);
    expect(restoreIndex).toBeLessThan(streamIndex);
  });

  it('is idempotent across repeated restores and removes duplicate placeholders for the same turn', () => {
    const harness = loadRunningViewHarness([
      { id: 'u', role: 'user', text: 'question', sessionId: 'a', turnId: 'turn-4' },
      { id: 'p1', role: 'assistant', text: '正在查阅资料', sessionId: 'a', turnId: 'turn-4', status: 'streaming' },
      { id: 'p2', role: 'assistant', text: '正在查阅资料', sessionId: 'a', status: 'streaming' }
    ]);

    expect(harness.api.restoreRunningTurnView('a')).toBe(true);
    expect(harness.api.restoreRunningTurnView('a')).toBe(true);
    const placeholders = harness.state.messages.filter((message: any) => message.status === 'streaming');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]).toMatchObject({ id: 'p1', turnId: 'turn-4' });
    expect(harness.state.activeAssistantMessageId).toBe('p1');
    expect(harness.spies.appendMessage).not.toHaveBeenCalled();
    expect(harness.spies.stopActivityDots).toHaveBeenCalledWith('p2');
  });

  it('does not restore over a terminal answer and finishTurn removes a stale loading placeholder', () => {
    const answered = loadRunningViewHarness([
      { id: 'u', role: 'user', text: 'question', sessionId: 'a', turnId: 'turn-8' },
      { id: 'answer', role: 'assistant', text: 'final answer', sessionId: 'a', turnId: 'turn-8' },
      { id: 'stale', role: 'assistant', text: '正在查阅资料', sessionId: 'a', turnId: 'turn-8', status: 'streaming' }
    ]);
    answered.state.activeAssistantMessageId = 'stale';

    expect(answered.api.restoreRunningTurnView('a')).toBe(false);
    expect(answered.state.messages.map((message: any) => message.text)).toEqual(['question', 'final answer']);
    expect(answered.state.activeAssistantMessageId).toBeNull();

    const terminal = loadRunningViewHarness([
      { id: 'u', role: 'user', text: 'question', sessionId: 'a', turnId: 'turn-9' },
      { id: 'loading', role: 'assistant', text: '正在查阅资料', sessionId: 'a', turnId: 'turn-9', status: 'streaming' }
    ]);
    terminal.state.activeAssistantMessageId = 'loading';
    terminal.state.turnPhase = 'running';
    terminal.state.turnSessionId = 'a';
    terminal.api.finishTurn('a');
    expect(terminal.state.messages.map((message: any) => message.text)).toEqual(['question']);
    expect(terminal.state).toMatchObject({ activeAssistantMessageId: null, turnPhase: 'idle', turnSessionId: null });

    const unavailable = extractFunctionSource(readPublicFile('chat.js'), 'finishUnavailableSession');
    expect(unavailable).toContain('clearRunningAssistantPlaceholder(sessionId)');
  });

  it('keeps another running session placeholder isolated', () => {
    const harness = loadRunningViewHarness([
      { id: 'a-u', role: 'user', text: 'A question', sessionId: 'a', turnId: 'a-turn' },
      { id: 'b-u', role: 'user', text: 'B question', sessionId: 'b', turnId: 'b-turn' },
      { id: 'b-p', role: 'assistant', text: '正在查阅资料', sessionId: 'b', turnId: 'b-turn', status: 'streaming' }
    ]);

    harness.api.restoreRunningTurnView('a');
    expect(harness.state.messages.filter((message: any) => message.sessionId === 'a' && message.status === 'streaming')).toHaveLength(1);
    expect(harness.state.messages.filter((message: any) => message.sessionId === 'b' && message.status === 'streaming')).toHaveLength(1);

    harness.state.activeSessionId = 'b';
    harness.state.activeAssistantMessageId = 'b-p';
    harness.api.restoreRunningTurnView('b');
    expect(harness.state.messages.filter((message: any) => message.sessionId === 'b' && message.status === 'streaming')).toHaveLength(1);
  });

  it('retries terminal history until the matching assistant turn is persisted without crossing a new run epoch', async () => {
    const js = readPublicFile('chat.js');
    const state = {
      activeSessionId: 'a',
      activeSessionGeneration: 4,
      sessionRunEpochs: new Map([['a', 7]]),
      messages: [
        { id: 'u', role: 'user', text: 'question', sessionId: 'a', turnId: 'turn-7' },
        { id: 'p', role: 'assistant', text: '正在查阅资料', sessionId: 'a', turnId: 'turn-7', status: 'streaming' }
      ] as any[]
    };
    const refreshLog = vi.fn().mockImplementation(async () => {
      if (refreshLog.mock.calls.length === 2) {
        state.messages = [
          state.messages[0],
          { id: 'a', role: 'assistant', text: 'answer', sessionId: 'a', turnId: 'turn-7' }
        ];
      }
    });
    const factory = new Function(
      'state',
      'window',
      'refreshLog',
      'isCurrentSessionGeneration',
      'const SESSION_TERMINAL_REFRESH_DELAYS_MS = [0, 250, 750, 1500, 3000];\n' +
      `${extractFunctionSource(js, 'hasAssistantResponseForTurn')}\n` +
      `${extractFunctionSource(js, 'refreshTerminalTurnWithRetry')}\n` +
      'return refreshTerminalTurnWithRetry;'
    );
    const retry = factory(
      state,
      { setTimeout: (callback: () => void) => { callback(); return 1; } },
      refreshLog,
      (sessionId: string, generation: number) => sessionId === state.activeSessionId
        && generation === state.activeSessionGeneration
    );

    await expect(retry('a', 4, 7, { turnId: 'turn-7', text: 'question' })).resolves.toBe(true);
    expect(refreshLog).toHaveBeenCalledTimes(2);

    refreshLog.mockClear();
    state.messages = [
      { id: 'u2', role: 'user', text: 'new question', sessionId: 'a', turnId: 'turn-8' }
    ];
    refreshLog.mockImplementationOnce(async () => {
      state.sessionRunEpochs.set('a', 8);
    });
    await expect(retry('a', 4, 7, { turnId: 'turn-7', text: 'question' })).resolves.toBe(false);
    expect(refreshLog).toHaveBeenCalledTimes(1);
  });

  it('does not let an old session-list response downgrade a newly running epoch', () => {
    const js = readPublicFile('chat.js');
    const applyLoadedSessions = new Function(
      'state',
      'window',
      'normalizeSession',
      'isRunningSession',
      'trackRunningSession',
      `${extractFunctionSource(js, 'applyLoadedSessions')}\nreturn applyLoadedSessions;`
    );
    const state = {
      sessions: [{ id: 'a', turnState: 'running', status: 'running' }],
      sessionRunEpochs: new Map([['a', 2]]),
      sessionReconcileTimers: new Map(),
      sessionTerminalOverrides: new Map(),
      sessionTerminalRefreshTimers: new Map()
    };
    const isRunningSession = (session: any) => (session?.turnState || session?.status) === 'running';
    const apply = applyLoadedSessions(
      state,
      { clearTimeout: vi.fn() },
      (session: any) => ({ ...session }),
      isRunningSession,
      vi.fn()
    );

    apply([{ id: 'a', turnState: 'idle', status: 'idle' }], {
      runEpochSnapshot: new Map([['a', 1]])
    });
    expect(state.sessions[0]).toMatchObject({ turnState: 'running', status: 'running' });

    apply([{ id: 'a', turnState: 'idle', status: 'idle' }], {
      runEpochSnapshot: new Map([['a', 2]])
    });
    expect(state.sessions[0]).toMatchObject({ turnState: 'idle', status: 'idle' });
  });

  it('treats history 403 plus status 403 as an unavailable terminal session', async () => {
    const js = readPublicFile('chat.js');
    const state = { activeSessionId: 'a', activeSessionGeneration: 3 };
    const finishUnavailableSession = vi.fn().mockResolvedValue(undefined);
    const finishIfUnavailable = new Function(
      'state',
      'isUnavailableSessionStatusError',
      'isCurrentSessionGeneration',
      'pollSessionStatus',
      'finishUnavailableSession',
      `${extractFunctionSource(js, 'finishIfSessionBecameUnavailable')}\nreturn finishIfSessionBecameUnavailable;`
    )(
      state,
      (error: any) => error?.status === 404 || error?.status === 410,
      (sessionId: string, generation: number) => sessionId === state.activeSessionId
        && generation === state.activeSessionGeneration,
      vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 })),
      finishUnavailableSession
    );

    await expect(finishIfUnavailable('a', Object.assign(new Error('history forbidden'), { status: 403 }), 3))
      .resolves.toBe(true);
    expect(finishUnavailableSession).toHaveBeenCalledWith('a', expect.objectContaining({ status: 403 }), 3);
  });
});
