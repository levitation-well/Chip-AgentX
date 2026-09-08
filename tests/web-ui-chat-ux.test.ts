import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function extractFunctionSource(js: string, name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in chat.js`);
  const bodyStart = js.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < js.length; index += 1) {
    const char = js[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return js.slice(start, index + 1);
  }
  throw new Error(`${name} body not closed`);
}

describe('chat webui ux polish', () => {
  it('image upload button uses an inline SVG plus, not a text glyph', () => {
    const html = readPublicFile('chat.html');
    const control = html.match(/<label id="image-upload-control"[\s\S]*?<\/label>/);
    if (!control) throw new Error('image-upload-control not found');
    expect(control[0]).toContain('<svg');
    expect(control[0]).toMatch(/sr-only|aria-label/);

    const css = readPublicFile('styles.css');
    expect(css).not.toContain('.chat-hifi-image-upload span::before');
    expect(css).toMatch(/\.chat-hifi-image-upload svg\s*\{/);
  });

  it('user bubble mirrors assistant bubble chrome while keeping right-side direction', () => {
    const css = readPublicFile('styles.css');
    const rule = css.match(/body\.chat-page \.message\.user \.message-bubble\s*\{([^}]+)\}/);
    if (!rule) throw new Error('.message.user .message-bubble rule not found');
    expect(rule[1]).toMatch(/color:\s*var\(--text\)/);
    expect(rule[1]).toMatch(/background:\s*var\(--surface\)/);
    expect(rule[1]).toMatch(/border-color:\s*var\(--border\)/);
    expect(rule[1]).toContain('box-shadow');
    expect(rule[1]).toMatch(/border-bottom-right-radius/);
    expect(rule[1]).not.toContain('accent-text');
    expect(rule[1]).not.toContain('linear-gradient');
  });

  it('error card drops the wrapping bubble chrome', () => {
    const js = readPublicFile('chat.js');
    expect(js).toMatch(/classList\.add\(['"]is-error['"]\)/);

    const css = readPublicFile('styles.css');
    const rule = css.match(/body\.chat-page \.message-bubble\.is-error\s*\{([^}]+)\}/);
    if (!rule) throw new Error('.message-bubble.is-error rule not found');
    expect(css).toContain('body.chat-page .message.assistant .message-bubble.is-error');
    expect(rule[1]).toMatch(/background:\s*transparent/);
    expect(rule[1]).toMatch(/border:\s*0/);
    expect(rule[1]).toMatch(/box-shadow:\s*none/);
    expect(rule[1]).toMatch(/padding:\s*0/);
  });

  it('empty-session placeholder has no copy button', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'appendMessageElement');
    const actionsIdx = fn.indexOf("actions.className = 'message-actions'");
    const copyAppendIdx = fn.indexOf('actions.append(copy)');
    expect(actionsIdx).toBeGreaterThan(-1);
    expect(copyAppendIdx).toBeGreaterThan(actionsIdx);
    const copyBlock = fn.slice(actionsIdx, copyAppendIdx);
    expect(copyBlock).toContain("if (message.id !== 'empty-session')");
  });

  it('feedback chips are local toggles flushed once on close', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'createFeedbackPanel');
    expect(fn).toContain('toggleReason');
    expect(fn).toContain('toggleReasonSet');
    expect(fn).toContain('flushFeedback');
    expect(fn).toMatch(/flushFeedback\(\)/);
    expect(fn).not.toMatch(/selectReason[\s\S]*postMessageFeedback\(\[value\]/);
  });

  it('retry does not clobber a non-empty composer draft', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'retryAssistantTurn');
    const guardIdx = fn.indexOf('els.message.value.trim()');
    const assignIdx = fn.indexOf('els.message.value = userText');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(guardIdx);
  });

  it('drops hidden mode-meta DOM and stale locale-hint fallback', () => {
    const js = readPublicFile('chat.js');
    expect(js).not.toContain("className = 'chat-mode-meta'");
    expect(js).not.toContain('modeMetaText');
    expect(js).not.toContain('chat.locale.hint');
    const css = readPublicFile('styles.css');
    expect(css).not.toContain('.chat-hifi-modes .chat-mode-meta');
  });

  it('feedback uses mutually-exclusive thumbs and a floating reason popover', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain('message-feedback-thumb');
    expect(js).toContain('nextFeedbackVote');
    expect(js).toMatch(/setAttribute\('aria-pressed'/);
    expect(js).toContain('message-feedback-popover');
    expect(js).toMatch(/setAttribute\('role',\s*'dialog'\)/);
    expect(js).toContain("popover.setAttribute('aria-label', i18n('chat.feedback.reasonLabel'))");
    expect(js).toContain('feedbackOptionValues');
    expect(js).toContain('feedback-chip');
    expect(js).toContain('postMessageFeedback');
    expect(js).toContain("i18n('chat.feedback.note')");
    expect(js).not.toContain('message-feedback-detail');
    expect(js).toContain('closeOpenFeedbackPopover');

    const css = readPublicFile('styles.css');
    // Match the popover's own positioning rule, not the shared panel-surface base group
    // (V2.2.43 Wave2-E) which also ends with this selector.
    const popoverRule = css.match(/body\.chat-page \.message-feedback-popover\s*\{([^}]*position:[^}]+)\}/);
    if (!popoverRule) throw new Error('message-feedback-popover rule not found');
    expect(popoverRule[1]).toMatch(/position:\s*(absolute|fixed)/);
  });

  it('nextFeedbackVote toggles thumbs mutually-exclusively and cancelable', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'nextFeedbackVote');
    const factory = new Function(`${fn}\nreturn nextFeedbackVote;`);
    const nextFeedbackVote = factory() as (
      current: 'none' | 'up' | 'down',
      clicked: 'up' | 'down'
    ) => 'none' | 'up' | 'down';

    expect(nextFeedbackVote('none', 'up')).toBe('up');
    expect(nextFeedbackVote('none', 'down')).toBe('down');
    expect(nextFeedbackVote('up', 'up')).toBe('none');
    expect(nextFeedbackVote('down', 'down')).toBe('none');
    expect(nextFeedbackVote('up', 'down')).toBe('down');
    expect(nextFeedbackVote('down', 'up')).toBe('up');
  });

  it('toggleReasonSet adds and removes reasons idempotently', () => {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'toggleReasonSet');
    const factory = new Function(`${fn}\nreturn toggleReasonSet;`);
    const toggleReasonSet = factory() as (set: Set<string>, value: string) => boolean;

    const set = new Set<string>();
    expect(toggleReasonSet(set, 'a')).toBe(true);
    expect([...set]).toEqual(['a']);
    expect(toggleReasonSet(set, 'a')).toBe(false);
    expect([...set]).toEqual([]);
    toggleReasonSet(set, 'a');
    toggleReasonSet(set, 'b');
    expect([...set].sort()).toEqual(['a', 'b']);
  });

  it('copy button is a skin-aware icon button', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain('function createIcon');
    expect(js).toContain("createIcon('copy')");
    expect(js).toContain("createIcon('check')");
    // 复制按钮用 aria-label 而非可见文字
    expect(js).toContain("copy.setAttribute('aria-label', i18n('chat.copy'))");
    expect(js).not.toContain("copy.textContent = '复制'");

    const css = readPublicFile('styles.css');
    const iconRule = css.match(/body\.chat-page \.message-icon-button\s*\{([^}]+)\}/);
    if (!iconRule) throw new Error('message-icon-button rule not found');
    const hoverRule = css.match(/body\.chat-page \.message-icon-button:hover\s*\{([^}]+)\}/);
    if (!hoverRule) throw new Error('message-icon-button:hover rule not found');
    expect(hoverRule[1]).toContain('var(--accent)');
    expect(hoverRule[1]).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('gives assistant a real bubble via .message-bubble while .message rows stay transparent', () => {
    const css = readPublicFile('styles.css');

    // 外层 .message 退化为透明行容器（无边框/无底色/无阴影/无内边距）
    const message = css.match(/body\.chat-page \.message\s*\{([^}]+)\}/);
    if (!message) throw new Error('message rule not found');
    expect(message[1]).toContain('background: transparent');
    expect(message[1]).toContain('box-shadow: none');
    expect(message[1]).toMatch(/border:\s*0/);

    const userMessage = css.match(/body\.chat-page \.message\.user\s*\{([^}]+)\}/);
    if (!userMessage) throw new Error('message.user rule not found');
    expect(userMessage[1]).toContain('background: transparent');
    expect(userMessage[1]).toContain('box-shadow: none');
    expect(userMessage[1]).toMatch(/border:\s*0/);

    // 真正的气泡盒在 .message-bubble 上：assistant 气泡可见 surface 底 + border 描边 + 轻阴影
    const assistantBubble = css.match(/body\.chat-page \.message\.assistant \.message-bubble\s*\{([^}]+)\}/);
    if (!assistantBubble) throw new Error('.message.assistant .message-bubble rule not found');
    expect(assistantBubble[1]).toContain('var(--surface)');
    expect(assistantBubble[1]).toContain('var(--border)');
    expect(assistantBubble[1]).toContain('box-shadow');

    // User bubbles share the assistant chrome and keep only the opposite tail direction.
    const userBubble = css.match(/body\.chat-page \.message\.user \.message-bubble\s*\{([^}]+)\}/);
    if (!userBubble) throw new Error('.message.user .message-bubble rule not found');
    expect(userBubble[1]).toContain('background: var(--surface)');
    expect(userBubble[1]).toContain('border-color: var(--border)');
    expect(userBubble[1]).toContain('color: var(--text)');
    expect(userBubble[1]).toContain('border-bottom-right-radius');

    // 收紧 AI 左缩进：.message.assistant 不再含 7vw 大左边距
    const assistant = css.match(/body\.chat-page \.message\.assistant\s*\{([^}]+)\}/);
    if (!assistant) throw new Error('message.assistant rule not found');
    expect(assistant[1]).not.toContain('7vw');

    // failed 态错误底色随气泡迁到 .message.failed .message-bubble 上
    const failed = css.match(/body\.chat-page \.message\.failed \.message-bubble\s*\{([^}]+)\}/);
    if (!failed) throw new Error('.message.failed .message-bubble rule not found');
    expect(failed[1]).toContain('var(--danger)');
  });

  it('wraps message content in an inner bubble with actions as a sibling below', () => {
    const js = readPublicFile('chat.js');

    // appendMessageElement 创建了内层 .message-bubble
    expect(js).toContain("bubble.className = 'message-bubble'");
    // 正文与 assistant 引用块进入 bubble，而非直接进 item
    expect(js).toContain('bubble.append(body)');
    expect(js).toMatch(/bubble\.append\(renderCitationBlock\(message\)\)/);
    expect(js).toContain('item.append(bubble)');

    // .message-actions 是 bubble 的兄弟：append 到 item，而不是 append 到 bubble
    expect(js).toContain("actions.className = 'message-actions'");
    expect(js).toContain('item.append(actions)');
    expect(js).not.toContain('bubble.append(actions)');

    // 顺序：bubble 先于 actions 进入 item（气泡在上、动作栏在下）
    expect(js).toMatch(/item\.append\(bubble\)[\s\S]*?item\.append\(actions\)/);
  });

  it('session-meta shows only the conversation title', () => {
    const js = readPublicFile('chat.js');
    const fn = js.match(/function renderSessionMeta\(\)\s*\{([\s\S]*?)\n  \}/);
    if (!fn) throw new Error('renderSessionMeta not found');
    const body = fn[1];
    expect(body).toContain("i18nFormat('chat.session.current'");
    expect(body).not.toContain('units');
    expect(body).not.toContain('modelLabel');
    expect(body).toContain('els.sessionMeta.hidden = true');
  });

  it('expresses mode lock via greyed toggle and removes dead lock-hint markup', () => {
    const html = readPublicFile('chat.html');
    expect(html).not.toContain('chat-mode-lock-hint');
    expect(html).not.toContain('model-credit-status');
    expect(html).not.toContain('chat-locale-hint');
    expect(html).not.toContain('chat-attach-hint');
    expect(html).toContain('composer-floatbar');

    const js = readPublicFile('chat.js');
    expect(js).not.toContain('chat-mode-lock-hint');
    expect(js).not.toContain('chatModeLockHint');
    expect(js).not.toContain('已锁定');
    expect(js).toContain("segment?.classList.toggle('locked'");

    const css = readPublicFile('styles.css');
    expect(css).not.toContain('.chat-mode-reason');
    expect(css).not.toContain('.chat-mode-lock-hint');
    expect(css).not.toContain('.model-credit-status');
    expect(css).not.toContain('.chat-locale-hint');
    expect(css).toContain('.composer-floatbar');
  });

  it('removes sidebar announcements from chat while keeping the news navigation entry', () => {
    const html = readPublicFile('chat.html');
    const productShell = readPublicFile('product-shell.js');
    expect(html).not.toContain('data-announcements-chat');
    expect(html).not.toContain('data-announcements-chat-feed');
    expect(html).not.toContain('/announcements.js');
    expect(html).toContain('data-portal-nav');
    expect(productShell).toContain("{ href: '/updates', key: 'portal.nav.updates', label: '新闻' }");
    expect(html).not.toContain('data-product-changelog');
  });

  it('aligns action row below bubble per role', () => {
    const css = readPublicFile('styles.css');

    const userActions = css.match(/body\.chat-page \.message\.user \.message-actions\s*\{([^}]+)\}/);
    if (!userActions) throw new Error('.message.user .message-actions rule not found');
    expect(userActions[1]).toContain('justify-content: flex-end');
    expect(userActions[1]).toContain('background: transparent');
    expect(userActions[1]).toContain('box-shadow: none');
    expect(userActions[1]).toMatch(/border:\s*0/);

    const assistantActions = css.match(/body\.chat-page \.message\.assistant \.message-actions\s*\{([^}]+)\}/);
    if (!assistantActions) throw new Error('.message.assistant .message-actions rule not found');
    expect(assistantActions[1]).toContain('justify-content: flex-start');
  });

  it('centers the icon glyph inside icon buttons', () => {
    const css = readPublicFile('styles.css');

    const iconRule = css.match(/body\.chat-page \.message-icon-button\s*\{([^}]+)\}/);
    if (!iconRule) throw new Error('message-icon-button rule not found');
    expect(iconRule[1]).toContain('line-height: 0');

    // 显式约束内层 SVG，避免 baseline 偏移
    const svgRule = css.match(/body\.chat-page \.message-icon-button svg\s*\{([^}]+)\}/);
    if (!svgRule) throw new Error('message-icon-button svg rule not found');
    expect(svgRule[1]).toContain('display: block');
  });

  it('moves chip pill and mode toggle into a left-aligned composer floatbar', () => {
    const html = readPublicFile('chat.html');
    const { document } = new JSDOM(html).window;

    const floatbar = document.querySelector('.composer-floatbar');
    if (!floatbar) throw new Error('.composer-floatbar not found');
    expect(floatbar.querySelector('.chat-chip-pill')).not.toBeNull();
    expect(floatbar.querySelector('#chat-mode-options')).not.toBeNull();

    const form = document.querySelector('#message-form');
    if (!form) throw new Error('#message-form not found');
    expect(floatbar.compareDocumentPosition(form) & 0x04).toBeTruthy();

    expect(form.querySelector('#image-upload-control')).not.toBeNull();
    expect(form.querySelector('#message')).not.toBeNull();
    expect(form.querySelector('#send-message')).not.toBeNull();
    expect(form.querySelector('#chat-mode-options')).toBeNull();
    expect(form.querySelector('#model-credit-status')).toBeNull();
    expect(form.querySelector('#chat-locale-hint')).toBeNull();
    expect(form.querySelector('#chat-mode-lock-hint')).toBeNull();
    expect(form.querySelector('.chat-attach-hint')).toBeNull();

    const send = document.querySelector('#send-message');
    expect(send?.querySelector('svg')).not.toBeNull();
    expect(send?.textContent?.includes('↑')).toBe(false);

    const upload = document.querySelector('#image-upload-control');
    expect(upload?.getAttribute('title') || '').toContain('粘贴');
  });

  it('drops references to removed composer DOM handles', () => {
    const js = readPublicFile('chat.js');
    expect(js).not.toContain('localeHint:');
    expect(js).not.toContain('modelCreditStatus:');
    expect(js).not.toContain('chatModeLockHint:');
    expect(js).not.toContain('els.localeHint');
    expect(js).not.toContain('els.modelCreditStatus');
    expect(js).not.toContain('els.chatModeLockHint');
    expect(js).not.toContain('renderModelCreditStatus');
    expect(js).toContain("segment?.classList.toggle('selected'");
    expect(js).toContain("segment?.classList.toggle('locked'");
    expect(js).toContain('selectedChatMode()');
  });
});

describe('classifyAssistantError pure function', () => {
  function loadClassifier(): (text: string) => {
    isError: boolean;
    kind?: string;
    friendly?: string;
    retryable?: boolean;
  } {
    const js = readPublicFile('chat.js');
    const fn = extractFunctionSource(js, 'classifyAssistantError');
    const messages: Record<string, string> = {
      'chat.error.authDetail': '认证已失效，请重新登录后再试。',
      'chat.error.rateLimitReset': '上游模型使用额度已达上限，预计 {reset} 后恢复。',
      'chat.error.rateLimitDetail': '上游模型使用额度已达上限，请稍后重试。',
      'chat.error.timeoutDetail': '请求超时，可能是网络或上游服务暂时不可用。',
      'chat.error.genericDetail': '请求失败，请重试。'
    };
    const translate = (key: string, params?: Record<string, unknown>) =>
      (messages[key] || key).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params || {}, name) ? String(params?.[name]) : match
      );
    const factory = new Function('i18n', `${fn}\nreturn classifyAssistantError;`);
    return factory(translate) as ReturnType<typeof loadClassifier>;
  }

  it('classifies a session-limit rate-limit error and extracts reset time', () => {
    const classify = loadClassifier();
    const result = classify("You've hit your session limit · resets 2:50pm (Asia/Shanghai)");
    expect(result.isError).toBe(true);
    expect(result.kind).toBe('rate-limit');
    expect(result.retryable).toBe(true);
    expect(result.friendly).toMatch(/额度|使用/);
    expect(result.friendly).toContain('2:50pm');
  });

  it('classifies a 401 auth error', () => {
    const classify = loadClassifier();
    const result = classify('Failed to authenticate. API Error: 401 Invalid authentication credentials');
    expect(result.isError).toBe(true);
    expect(result.kind).toBe('auth');
    expect(result.friendly).toMatch(/鉴权|认证/);
  });

  it('classifies a connection timeout error', () => {
    const classify = loadClassifier();
    const result = classify('Error: connect ETIMEDOUT 10.0.0.1:443');
    expect(result.isError).toBe(true);
    expect(result.kind).toBe('timeout');
    expect(result.friendly).toMatch(/超时/);
  });

  it('does NOT misclassify a long normal answer that merely mentions "limit"', () => {
    const classify = loadClassifier();
    const longAnswer = [
      '该芯片的工作温度范围为 -40°C 到 85°C。',
      '关于电流上限（current limit）：在过流保护触发前，',
      '器件可持续输出最大 3A 负载电流，超过该阈值后会进入限流保护模式。',
      '以下是寄存器配置说明：写入 0x1F 到 CTRL 寄存器以启用 API Error 上报通道，',
      '该通道用于诊断，不影响正常工作。更多细节见数据手册第 12 章。',
      '注意：该限制（usage limit）为硬件设定，无法通过软件解除。',
      '如果系统日志中出现 limit reached 字样，应先确认它描述的是电流阈值、温度阈值还是保护状态，',
      '再结合状态寄存器、负载曲线和应用场景判断是否需要调整硬件设计或散热条件。',
      '这类说明属于正常数据手册内容，不代表上游 AI 服务发生 API Error 或 quota 问题。'
    ].join('\n');
    expect(longAnswer.trim().length).toBeGreaterThan(320);
    expect(classify(longAnswer).isError).toBe(false);
  });

  it('returns isError:false for an empty or whitespace string', () => {
    const classify = loadClassifier();
    expect(classify('').isError).toBe(false);
    expect(classify('   \n  ').isError).toBe(false);
  });

  it('falls back to generic for a short error-shaped string', () => {
    const classify = loadClassifier();
    const result = classify('Error: something went wrong');
    expect(result.isError).toBe(true);
    expect(result.kind).toBe('generic');
    expect(result.friendly).toMatch(/失败|重试/);
  });
});

describe('chat error card rendering', () => {
  it('chat.js wires error-card rendering into the assistant branch', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain('function classifyAssistantError');
    expect(js).toContain('function renderErrorCard');
    expect(js).toContain('function retryAssistantTurn');
    expect(js).toContain('message-error-card');

    const appendFn = extractFunctionSource(js, 'appendMessageElement');
    expect(appendFn).toContain('classifyAssistantError');
    expect(appendFn).toContain('errorClassification');
    expect(appendFn).toMatch(/!errorClassification\.isError[\s\S]*renderCitationBlock/);
    expect(appendFn).toMatch(/!errorClassification\.isError[\s\S]*createFeedbackPanel/);
  });

  it('error card contains a retry button and a collapsible technical-detail container', () => {
    const js = readPublicFile('chat.js');
    const body = extractFunctionSource(js, 'renderErrorCard');
    expect(body).toContain("i18n('chat.retry')");
    expect(body).toContain("i18n('chat.details.title')");
    expect(body).toContain('message-error-card__raw');
    expect(body).toContain('retryAssistantTurn');
    expect(body).toMatch(/details|hidden/);
  });
});

describe('chat error card styles', () => {
  it('defines a scoped error-card rule with a left accent border', () => {
    const css = readPublicFile('styles.css');
    const rule = css.match(/body\.chat-page \.message-error-card\s*\{([^}]+)\}/);
    if (!rule) throw new Error('message-error-card rule not found');
    expect(rule[1]).toContain('border-left');
    expect(rule[1]).toContain('var(--danger)');
    expect(rule[1]).not.toMatch(/#[0-9a-fA-F]{6}/);
  });

  it('defines a monospace collapsible raw container', () => {
    const css = readPublicFile('styles.css');
    const raw = css.match(/body\.chat-page \.message-error-card__raw\s*\{([^}]+)\}/);
    if (!raw) throw new Error('message-error-card__raw rule not found');
    expect(raw[1]).toMatch(/font-family:\s*[^;]*mono/i);
    expect(raw[1]).toMatch(/white-space|overflow/);
  });
});
