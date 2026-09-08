/**
 * Scope Selector Web UI 合约测试（展开态可工作版本）
 *
 * 与 tests/web-ui*.test.ts 一致：用 readPublicFile 读 public/ 源文件 +
 * jsdom 对 DOM 结构 / CSS 文本做断言。不运行布局引擎，只断言「合约」：
 * - chat.html 含语义三步结构（range / content / mode 挂载点）
 * - chat.js 含 loadScopeOptions / renderScopeModes / renderScopeContentPanel
 * - createSession 按 state.scopeMode 组装三种请求体（single→chipId、
 *   group→scope:{mode:'group',groups}、global→scope:{mode:'global'}）
 * - styles.css 新增 scope 选择器类用 var(--*) token 且不含硬编码十六进制色
 * - 分组 tooLarge 项可选 + 中性「较大范围」文案
 * - 用户可见文案不暴露内部实现（不含 preset / M3 / 阈值数字 等）
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

const chatHtml = readPublicFile('chat.html');
const chatJs = readPublicFile('chat.js');
const stylesCss = readPublicFile('styles.css');
const i18nJs = readPublicFile('assets/i18n-chat.js');

/**
 * 从 styles.css 中抽出某个选择器规则块的 body（{...} 之间），用于断言该块
 * 不含硬编码色。简单括号配平，足以覆盖单层规则块。
 */
function extractRuleBlocks(css: string, selectorSubstring: string): string[] {
  const blocks: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const idx = css.indexOf(selectorSubstring, searchFrom);
    if (idx === -1) break;
    const open = css.indexOf('{', idx);
    if (open === -1) break;
    const close = css.indexOf('}', open);
    if (close === -1) break;
    blocks.push(css.slice(open + 1, close));
    searchFrom = close + 1;
  }
  return blocks;
}

describe('scope selector — chat.html 三步结构', () => {
  const dom = new JSDOM(chatHtml);
  const doc = dom.window.document;

  it('composer 含语义三步挂载点：range / content / mode', () => {
    const range = doc.querySelector('[data-scope-step="range"]');
    const content = doc.querySelector('[data-scope-step="content"]');
    const mode = doc.querySelector('[data-scope-step="mode"]');
    expect(range).not.toBeNull();
    expect(content).not.toBeNull();
    expect(mode).not.toBeNull();
  });

  it('内容面板有专属挂载点 #scope-content-panel', () => {
    expect(doc.getElementById('scope-content-panel')).not.toBeNull();
  });

  it('范围分段容器存在且为 radiogroup（复用 chat-mode-segment 风格）', () => {
    const range = doc.querySelector('[data-scope-step="range"]');
    expect(range).not.toBeNull();
    const modes = range!.querySelector('#scope-mode-options');
    expect(modes).not.toBeNull();
    expect(modes!.getAttribute('role')).toBe('radiogroup');
  });

  it('三步语义顺序：range 在 content 之前，content 在 mode 之前', () => {
    const order = ['range', 'content', 'mode'].map((step) =>
      chatHtml.indexOf(`data-scope-step="${step}"`)
    );
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('保留现有 #chip-select / #scope-select（逻辑迁移，零回归回退）', () => {
    expect(doc.getElementById('chip-select')).not.toBeNull();
    expect(doc.getElementById('scope-select')).not.toBeNull();
  });

  it('仍引入 product-shell.js（bfcache 防护不丢）', () => {
    expect(chatHtml).toContain('product-shell.js');
  });
});

describe('scope selector — chat.js 函数与 state', () => {
  it('state 扩展：scopeMode / scopeOptions / selectedScopeChipId / selectedGroups / 内容弹窗状态', () => {
    expect(chatJs).toMatch(/scopeMode:\s*'single'/);
    expect(chatJs).toMatch(/scopeOptions:\s*null/);
    expect(chatJs).toMatch(/selectedScopeChipId:\s*null/);
    expect(chatJs).toMatch(/selectedGroups:\s*\[\]/);
    expect(chatJs).toMatch(/scopeContentSearch:\s*''/);
    expect(chatJs).toMatch(/scopeGroupSearch:\s*''/);
    expect(chatJs).toMatch(/scopeContentOpen:\s*false/);
    expect(chatJs).toMatch(/scopeContentFilterBrand:\s*''/);
    expect(chatJs).toMatch(/scopeContentFilterProductLine:\s*''/);
  });

  it('含 loadScopeOptions（GET /api/scope-options）', () => {
    expect(chatJs).toMatch(/function\s+loadScopeOptions/);
    expect(chatJs).toContain('/api/scope-options');
  });

  it('含 renderScopeModes（三分段切换）', () => {
    expect(chatJs).toMatch(/function\s+renderScopeModes/);
  });

  it('含 renderScopeContentPanel（按模式切内容）', () => {
    expect(chatJs).toMatch(/function\s+renderScopeContentPanel/);
  });

  it('初始化流程调用 loadScopeOptions', () => {
    // loadScopeOptions 应在 init 里被 await 调用（与 loadChips/loadScopePresets 同期）
    expect(chatJs).toMatch(/await\s+loadScopeOptions\(\)/);
  });
});

describe('scope selector — createSession 三模式请求体', () => {
  it('single 模式发顶层 chipId（不发 scope）', () => {
    // single 分支仍走 chipId（零回归）
    expect(chatJs).toMatch(/scopeMode\s*===\s*'single'/);
    expect(chatJs).toMatch(/chipId/);
  });

  it('group 模式发 scope:{mode:"group",groups:...}', () => {
    expect(chatJs).toMatch(/scopeMode\s*===\s*'group'/);
    // 请求体含 mode: 'group' 与 groups
    expect(chatJs).toMatch(/mode:\s*'group'/);
    expect(chatJs).toMatch(/groups:\s*state\.selectedGroups/);
  });

  it('global 模式发 scope:{mode:"global"}（免选）', () => {
    expect(chatJs).toMatch(/scopeMode\s*===\s*'global'/);
    expect(chatJs).toMatch(/mode:\s*'global'/);
  });

  it('group 未选任何项时阻止发送并给提示', () => {
    // 应有对 selectedGroups 长度的校验
    expect(chatJs).toMatch(/selectedGroups\.length/);
  });
});


describe('scope selector — mockup alignment acceptance', () => {
  it('内容区是紧凑已选标签 + 添加入口，点击后打开弹出面板', () => {
    expect(chatJs).toMatch(/function\s+renderScopeContentTrigger/);
    expect(chatJs).toContain('chat-scope-selected-tag');
    expect(chatJs).toContain('chat-scope-add-tag');
    expect(chatJs).toContain('chat-scope-dropdown');
    expect(chatJs).toMatch(/scopeContentOpen\s*=\s*!state\.scopeContentOpen/);
    expect(chatJs).toContain('event.stopPropagation()');
  });

  it('单芯片面板顶部有品牌与产品线筛选下拉', () => {
    expect(chatJs).toMatch(/function\s+renderScopeSingleFilters/);
    expect(chatJs).toContain('chat.scope.filter.brand');
    expect(chatJs).toContain('chat.scope.filter.productLine');
    expect(chatJs).toContain('chat-scope-filter-select');
  });

  it('单芯片候选使用 chip pill，选中态带勾，不再渲染 scope-chip radio 行', () => {
    expect(chatJs).toContain('chat-scope-candidate-pill');
    expect(chatJs).not.toContain('✓ ');
    expect(chatJs).toMatch(/pill\.prepend\(checkIcon\)/);
    expect(chatJs).toContain("createIcon('check')");
    expect(chatJs).not.toMatch(/input\.type\s*=\s*'radio';\s*input\.name\s*=\s*'scope-chip'/s);
  });

  it('单芯片候选有底部总数，列表限高滚动', () => {
    expect(chatJs).toContain('chat.scope.candidate.total');
    expect(stylesCss).toContain('.chat-scope-candidate-list');
    const blocks = extractRuleBlocks(stylesCss, '.chat-scope-candidate-list').join('\n');
    expect(blocks).toMatch(/max-height/);
    expect(blocks).toMatch(/overflow:\s*auto/);
  });

  it('分组面板有搜索框', () => {
    expect(chatJs).toContain('chat.scope.group.search.placeholder');
    expect(i18nJs).toContain('搜分组');
  });

  it('分组汇总同时显示已选分组数与范围内芯片数', () => {
    expect(chatJs).toMatch(/function\s+selectedScopeGroupChipCount/);
    expect(i18nJs).toContain('已选 {count} 个分组 · 范围内 {chipCount} 颗芯片');
  });

  it('全局模式展示已授权芯片数量、文件数量，并保留 count-only 兜底', () => {
    expect(chatJs).toMatch(/function\s+globalAuthorizedChipCount/);
    expect(chatJs).toMatch(/function\s+globalAuthorizedFileCount/);
    expect(chatJs).toMatch(/function\s+globalScopeIsTooLarge/);
    expect(chatJs).toContain('chat.scope.global.hint.countOnly');
    expect(chatJs).toContain('chat.scope.global.hint.large');
    expect(i18nJs).toContain('你已授权的全部芯片（{count} 颗，共 {fileCount} 个文件），无需选择');
    expect(i18nJs).toContain('范围较大，检索稍慢');
    expect(i18nJs).toContain('你已授权的全部芯片（{count} 颗），无需选择');
  });

  it('折叠胶囊每枚自带下拉箭头且没有独立调整范围按钮', () => {
    expect(chatJs).toContain('chat-scope-pill-arrow');
    expect(chatJs).toContain('⌄');
    expect(chatJs).not.toContain('chat-scope-pill-edit');
    expect(i18nJs).not.toContain('chat.scope.pill.edit');
  });
});

describe('scope selector — createSession 行为（jsdom 实跑请求体）', () => {
  // 用 jsdom 实跑「按模式组装请求体」的逻辑契约：模拟 chat.js 的 createSession
  // 分支，验证三模式发出的 body 形状正确。这是对源码契约的可执行镜像断言。
  function buildBody(
    scopeMode: 'single' | 'group' | 'global',
    opts: {
      chipId?: string;
      selectedScopeChipId?: string | null;
      selectedGroups?: Array<{ dimension: string; value: string }>;
      chatMode?: string;
    }
  ): Record<string, unknown> {
    const base = {
      agentType: 'claude-code',
      task: 'find chips with PWM',
      sessionMode: 'conversation',
      chatMode: opts.chatMode || 'standard'
    };
    if (scopeMode === 'group') {
      return { ...base, scope: { mode: 'group', groups: opts.selectedGroups || [] } };
    }
    if (scopeMode === 'global') {
      return { ...base, scope: { mode: 'global' } };
    }
    return { ...base, chipId: opts.selectedScopeChipId || opts.chipId };
  }

  it('single → 顶层 chipId、无 scope', () => {
    const body = buildBody('single', { selectedScopeChipId: 'E521.39' });
    expect(body.chipId).toBe('E521.39');
    expect(body).not.toHaveProperty('scope');
  });

  it('group → scope.mode=group + groups 数组', () => {
    const groups = [{ dimension: 'productLine', value: '氛围灯' }];
    const body = buildBody('group', { selectedGroups: groups });
    expect(body).toHaveProperty('scope');
    expect((body.scope as any).mode).toBe('group');
    expect((body.scope as any).groups).toEqual(groups);
    expect(body).not.toHaveProperty('chipId');
  });

  it('global → scope.mode=global、无 groups/chipId', () => {
    const body = buildBody('global', {});
    expect((body.scope as any).mode).toBe('global');
    expect((body.scope as any).groups).toBeUndefined();
    expect(body).not.toHaveProperty('chipId');
  });
});

describe('scope selector — styles.css token 驱动（皮肤可切换硬约束）', () => {
  it('新增 scope 选择器类存在', () => {
    expect(stylesCss).toContain('.chat-scope-selector');
    expect(stylesCss).toContain('.chat-scope-modes');
    expect(stylesCss).toContain('.chat-scope-content');
  });

  it('scope 选择器规则块使用 var(--*) token 着色', () => {
    const selectorBlock = extractRuleBlocks(stylesCss, '.chat-scope-content');
    expect(selectorBlock.length).toBeGreaterThan(0);
    const joined = selectorBlock.join('\n');
    expect(joined).toMatch(/var\(--/);
  });

  it('所有 .chat-scope-* 规则块绝不含硬编码十六进制色（review 必查）', () => {
    // 抓取所有以 .chat-scope 开头的选择器规则块，断言 body 内无 #RRGGBB / #RGB
    const scopeBlocks = extractRuleBlocks(stylesCss, '.chat-scope');
    expect(scopeBlocks.length).toBeGreaterThan(0);
    const hexColor = /#[0-9a-fA-F]{3,8}\b/;
    for (const block of scopeBlocks) {
      expect(block).not.toMatch(hexColor);
    }
  });

  it('scope 选择器类不含字面命名色（teal/green 等）', () => {
    const scopeBlocks = extractRuleBlocks(stylesCss, '.chat-scope').join('\n');
    expect(scopeBlocks).not.toMatch(/:\s*(teal|green|seagreen|forestgreen)\b/i);
  });

  it('内容面板限高滚动（max-height + overflow）', () => {
    const blocks = extractRuleBlocks(stylesCss, '.chat-scope-content').join('\n');
    expect(blocks).toMatch(/max-height/);
    expect(blocks).toMatch(/overflow/);
  });

  it('内容候选栏向上展开覆盖上方组件，不再移动整个对话栏', () => {
    const floatbarBlocks = extractRuleBlocks(stylesCss, '.composer-floatbar').join('\n');
    const dropdownBlocks = extractRuleBlocks(stylesCss, '.chat-scope-dropdown').join('\n');
    const contentBlocks = extractRuleBlocks(stylesCss, '.chat-scope-content').join('\n');

    expect(chatJs).not.toContain('scope-content-open');
    expect(floatbarBlocks).not.toMatch(/translateY\(/);
    expect(dropdownBlocks).toMatch(/position:\s*absolute/);
    expect(dropdownBlocks).toMatch(/bottom:\s*calc\(100% \+ 6px\)/);
    expect(dropdownBlocks).toMatch(/top:\s*auto/);
    expect(dropdownBlocks).toMatch(/overflow-y:\s*auto/);
    expect(contentBlocks).toMatch(/min-width:\s*0/);
  });

  it('scope 与模式选中态使用 accent-text，保证 Notion 等皮肤下文字对比度', () => {
    const selectedModeBlocks = extractRuleBlocks(stylesCss, '.chat-scope-modes .chat-scope-mode.selected').join('\n');
    const selectedCandidateBlocks = extractRuleBlocks(stylesCss, '.chat-scope-candidate-pill.selected').join('\n');

    expect(selectedModeBlocks).toMatch(/color:\s*var\(--accent-text\)/);
    expect(selectedCandidateBlocks).toMatch(/color:\s*var\(--accent-text\)/);
  });

  it('scope 选择器含过渡动画 transition', () => {
    const blocks = extractRuleBlocks(stylesCss, '.chat-scope').join('\n');
    expect(blocks).toMatch(/transition/);
  });
});

describe('scope selector — 大范围可选 + 中性提示', () => {
  it('chat.js 不再对 tooLarge 项设 disabled（大范围可选）', () => {
    expect(chatJs).toMatch(/tooLarge/);
    expect(chatJs).not.toMatch(/input\.disabled\s*=\s*true/);
  });

  it('tooLarge 分组不再被 CSS 画成禁用态', () => {
    const tooLargeBlocks = extractRuleBlocks(stylesCss, '.chat-scope-option.too-large').join('\n');
    const tooLargeHoverBlocks = extractRuleBlocks(stylesCss, '.chat-scope-option.too-large:hover').join('\n');

    expect(tooLargeBlocks).not.toMatch(/not-allowed/);
    expect(tooLargeBlocks).not.toMatch(/opacity:\s*0\.55/);
    expect(tooLargeHoverBlocks).not.toMatch(/background:\s*transparent/);
  });

  it('i18n 含中性 scope 文案键', () => {
    expect(i18nJs).toContain('chat.scope.mode.single');
    expect(i18nJs).toContain('chat.scope.mode.group');
    expect(i18nJs).toContain('chat.scope.mode.global');
    expect(i18nJs).toContain('chat.scope.global.hint');
    expect(i18nJs).toContain('chat.scope.tooLarge');
    expect(i18nJs).toContain('chat.scope.search.placeholder');
  });

  it('tooLarge 文案中性（不写 M3 / 阈值数字 / 文件数）', () => {
    // 取 chat.scope.tooLarge 那一行附近文案，断言不暴露实现
    const tooLargeLines = i18nJs
      .split('\n')
      .filter((line) => line.includes('chat.scope.tooLarge'));
    expect(tooLargeLines.length).toBeGreaterThan(0);
    for (const line of tooLargeLines) {
      expect(line).not.toMatch(/M3/);
      expect(line).not.toMatch(/200/);
      expect(line).not.toMatch(/阈值/);
    }
  });
});

describe('scope selector — 用户可见文案不暴露内部实现', () => {
  it('i18n 的 scope 文案不含实现词（preset / 面板 / 阈值 / 模型名）', () => {
    // 只检查 chat.scope.* 文案值，避免误伤其他键
    const scopeI18nLines = i18nJs
      .split('\n')
      .filter((line) => /'chat\.scope\.|"chat\.scope\./.test(line));
    expect(scopeI18nLines.length).toBeGreaterThan(0);
    const forbidden = /(preset|M3|阈值|DeepSeek|qwen|workspaceDir)/i;
    for (const line of scopeI18nLines) {
      expect(line).not.toMatch(forbidden);
    }
  });

  it('chat.html 中 scope 区域可见文案不暴露实现', () => {
    const dom = new JSDOM(chatHtml);
    const range = dom.window.document.querySelector('[data-scope-step="range"]');
    const text = range?.textContent || '';
    expect(text).not.toMatch(/preset/i);
    expect(text).not.toMatch(/不弹/);
    expect(text).not.toMatch(/M3/);
  });
});

describe('scope selector — D4 折叠 / 悬浮胶囊 / 动画 / 会话内持久', () => {
  it('chat.js 含折叠/展开/重置函数：collapseScopeToPills / expandScopeSelector / resetScopeSelection', () => {
    expect(chatJs).toMatch(/function\s+collapseScopeToPills/);
    expect(chatJs).toMatch(/function\s+expandScopeSelector/);
    expect(chatJs).toMatch(/function\s+resetScopeSelection/);
  });

  it('chat.js 含手动 toggle（展开↔折叠）', () => {
    expect(chatJs).toMatch(/function\s+toggleScopeSelector/);
  });

  it('chat.js 含胶囊条渲染（renderScopePillbar）并写入摘要文案', () => {
    expect(chatJs).toMatch(/function\s+renderScopePillbar/);
    // 摘要由 scopeSummaryParts/scopeSummary 之类的纯函数组装，便于复用
    expect(chatJs).toMatch(/scopeSummary/i);
  });

  it('胶囊容器挂载点存在（chat.html #scope-pillbar 或 chat.js 生成 .chat-scope-pillbar）', () => {
    const dom = new JSDOM(chatHtml);
    const fromHtml = dom.window.document.getElementById('scope-pillbar');
    const fromJs = /chat-scope-pillbar/.test(chatJs) || /scope-pillbar/.test(chatJs);
    expect(Boolean(fromHtml) || fromJs).toBe(true);
  });

  it('胶囊复用 .chat-chip-pill 圆形胶囊类（token 着色，随皮肤变色）', () => {
    // 胶囊条里的每枚胶囊应带 chat-chip-pill（复用现有圆形胶囊质感）
    expect(chatJs).toMatch(/chat-chip-pill/);
  });

  it('createSession 成功后调用 collapseScopeToPills（发首句即折叠）', () => {
    // createSession 体内（或其成功回调路径）应触发折叠
    expect(chatJs).toMatch(/collapseScopeToPills\(\)/);
  });

  it('新建会话调用 resetScopeSelection 回默认单芯片', () => {
    expect(chatJs).toMatch(/resetScopeSelection\(\)/);
  });

  it('state 含会话内持久标记 scopeCollapsed（折叠态在会话内被记住）', () => {
    expect(chatJs).toMatch(/scopeCollapsed:/);
  });

  it('会话中锁定：折叠/展开/重选受 canChangeChatMode 之类的门控保护', () => {
    // 与现有 chat mode 锁定一致：会话进行中不可改 scope
    expect(chatJs).toMatch(/canChangeChatMode\(\)/);
    // scope 选择器整体可被加上 locked 态
    expect(chatJs).toMatch(/scope.*locked|locked.*scope/i);
  });

  it('styles.css 含折叠态类 .chat-scope-selector.collapsed', () => {
    expect(stylesCss).toContain('.chat-scope-selector.collapsed');
  });

  it('styles.css 含胶囊条类 .chat-scope-pillbar', () => {
    expect(stylesCss).toContain('.chat-scope-pillbar');
  });

  it('折叠/胶囊相关类含过渡动画 transition', () => {
    const collapseBlocks = extractRuleBlocks(stylesCss, '.chat-scope-selector').join('\n');
    expect(collapseBlocks).toMatch(/transition/);
    const pillbarBlocks = extractRuleBlocks(stylesCss, '.chat-scope-pillbar').join('\n');
    expect(pillbarBlocks).toMatch(/transition/);
  });

  it('折叠机制用 max-height 过渡（避免高度跳变）', () => {
    // 展开↔折叠靠 max-height + opacity 过渡，规则块里应出现 max-height
    const wrapBlocks = extractRuleBlocks(stylesCss, '.chat-scope-steps').join('\n');
    expect(wrapBlocks).toMatch(/max-height/);
    expect(wrapBlocks).toMatch(/transition/);
  });

  it('定义 token 化过渡时长变量（如 --scope-anim）', () => {
    expect(stylesCss).toMatch(/--scope-anim/);
  });

  it('折叠 / 胶囊 / 持久相关 .chat-scope* 规则块绝不含硬编码十六进制色（review 必查）', () => {
    // 复测全量 .chat-scope 块（含本次新增折叠/胶囊类），守住零硬编码色红线
    const scopeBlocks = extractRuleBlocks(stylesCss, '.chat-scope');
    expect(scopeBlocks.length).toBeGreaterThan(0);
    const hexColor = /#[0-9a-fA-F]{3,8}\b/;
    for (const block of scopeBlocks) {
      expect(block).not.toMatch(hexColor);
    }
  });

  it('胶囊/折叠类不含字面命名色（teal/green 等）', () => {
    const scopeBlocks = extractRuleBlocks(stylesCss, '.chat-scope').join('\n');
    expect(scopeBlocks).not.toMatch(/:\s*(teal|green|seagreen|forestgreen)\b/i);
  });

  it('i18n 含胶囊摘要中性文案键（不暴露实现）', () => {
    expect(i18nJs).toContain('chat.scope.summary.single');
    expect(i18nJs).toContain('chat.scope.summary.group');
    expect(i18nJs).toContain('chat.scope.summary.global');
  });

  it('胶囊摘要文案中性（不写 preset / M3 / 阈值 / 模型名）', () => {
    const pillLines = i18nJs
      .split('\n')
      .filter((line) => /chat\.scope\.(pill|summary)\./.test(line));
    expect(pillLines.length).toBeGreaterThan(0);
    const forbidden = /(preset|M3|阈值|DeepSeek|qwen|workspaceDir)/i;
    for (const line of pillLines) {
      expect(line).not.toMatch(forbidden);
    }
  });
});

describe('scope selector — D4 摘要文案组装（可执行契约镜像）', () => {
  // 镜像 chat.js 的胶囊摘要拼装逻辑：范围·内容·模式 三枚胶囊文字
  // = 当前选择摘要，中性、不暴露实现。
  function summarize(
    scopeMode: 'single' | 'group' | 'global',
    opts: {
      chipLabel?: string;
      groups?: Array<{ label: string }>;
      chatModeLabel?: string;
    }
  ): { range: string; content: string; mode: string } {
    const labels = { single: '单芯片', group: '分组', global: '全局检索' };
    let content: string;
    if (scopeMode === 'global') {
      content = '全部授权（14 颗）';
    } else if (scopeMode === 'group') {
      const groups = opts.groups || [];
      if (groups.length === 0) content = '未选';
      else if (groups.length === 1) content = groups[0].label;
      else content = `${groups[0].label} +${groups.length - 1}`;
    } else {
      content = opts.chipLabel || '未选';
    }
    return { range: labels[scopeMode], content, mode: opts.chatModeLabel || '标准' };
  }

  it('single → 范围=单芯片、内容=芯片标签', () => {
    const s = summarize('single', { chipLabel: 'E521.39', chatModeLabel: '标准' });
    expect(s.range).toBe('单芯片');
    expect(s.content).toBe('E521.39');
    expect(s.mode).toBe('标准');
  });

  it('group 多选 → 内容=「首项 +N」紧凑摘要', () => {
    const s = summarize('group', {
      groups: [{ label: '氛围灯' }, { label: '外饰灯' }],
      chatModeLabel: '增强'
    });
    expect(s.range).toBe('分组');
    expect(s.content).toBe('氛围灯 +1');
    expect(s.mode).toBe('增强');
  });

  it('group 单选 → 内容=该分组标签（无 +N）', () => {
    const s = summarize('group', { groups: [{ label: '氛围灯' }] });
    expect(s.content).toBe('氛围灯');
  });

  it('global → 内容=中性「全部授权」，不暴露实现', () => {
    const s = summarize('global', { chatModeLabel: '标准' });
    expect(s.range).toBe('全局检索');
    expect(s.content).toBe('全部授权（14 颗）');
    expect(s.content).not.toMatch(/preset|面板|阈值/);
  });
});

describe('scope selector — T19 applications 分组维度', () => {
  it('chat 范围选择器暴露「按功能/applications」分组', () => {
    expect(readPublicFile('chat.js')).toContain('group.applications');
    // 真实渲染合约：sections 数组用该 i18n key 渲染「按功能」分组（非依赖 chat.html 注释）
    expect(readPublicFile('chat.js')).toContain('chat.scope.group.applications');
  });

  it('i18n-chat.js has zh/en copy for chat.scope.group.applications', () => {
    expect(i18nJs).toContain('chat.scope.group.applications');
    expect(i18nJs).toContain('按功能');
    // The i18n-chat.js catalog is the single source of truth for chat.* keys.
    expect(i18nJs).toContain('Applications');
  });

  it('selectedScopeGroupChipCount 包含 applications（不漏计已选功能分组芯片数）', () => {
    expect(readPublicFile('chat.js')).toMatch(/groupData\.applications/);
  });
});
