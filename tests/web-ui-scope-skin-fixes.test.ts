/**
 * V2.2.9 体验修复合约测试（与 tests/web-ui*.test.ts 一致：readPublicFile + 文本断言）
 *
 * 修复 1（下拉闪烁）：范围下拉框 .chat-scope-dropdown 的入场动画只在「打开」那一刻
 *   播放一次，不得在每次选中分组/芯片、改筛选、输入搜索导致面板重建时重放。
 *   契约：入场动画从基础块移到 .chat-scope-dropdown.is-entering，chat.js 仅在
 *   下拉从「不可见 → 可见」的那次渲染加 is-entering。
 *
 * 修复 2（检索模式配色）：检索模式分段（.chat-hifi-modes .chat-mode-segment）的文字
 *   颜色必须跟随「查询范围」分段（.chat-scope-mode）：未选 = var(--muted)、
 *   选中 = var(--accent-text)。根因是文字被包进 .chat-mode-title，而全局
 *   .chat-mode-title{color:var(--text)} 覆盖了分段颜色，导致 notion/cal 等深色
 *   accent 皮肤下选中文字深字压深底、未选文字也比查询范围更深。
 *
 * @see public/chat.js renderScopeContentPanel / renderSearchModeOptions
 * @see public/styles.css .chat-scope-dropdown / .chat-hifi-modes .chat-mode-title
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

const chatJs = readPublicFile('chat.js');
const stylesCss = readPublicFile('styles.css');

/** 抽出包含某选择器子串的规则块 body（{...} 之间）。 */
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

describe('V2.2.9 修复1：范围下拉入场动画只在打开时播放（消除选中闪烁）', () => {
  it('.chat-scope-dropdown 基础块不再带 animation（避免重建重放）', () => {
    // 抓「.chat-scope-dropdown {」紧跟的基础块（排除 .is-entering 变体）
    const idx = stylesCss.indexOf('.chat-scope-dropdown {');
    expect(idx).toBeGreaterThan(-1);
    const open = stylesCss.indexOf('{', idx);
    const close = stylesCss.indexOf('}', open);
    const base = stylesCss.slice(open + 1, close);
    expect(base).not.toMatch(/animation\s*:/);
  });

  it('.chat-scope-dropdown.is-entering 块带 scope-dropdown-in 入场动画', () => {
    const blocks = extractRuleBlocks(stylesCss, '.chat-scope-dropdown.is-entering').join('\n');
    expect(blocks).toMatch(/animation\s*:/);
    expect(blocks).toMatch(/scope-dropdown-in/);
  });

  it('@keyframes scope-dropdown-in 仍保留', () => {
    expect(stylesCss).toMatch(/@keyframes\s+scope-dropdown-in/);
  });

  it('chat.js 仅在下拉「打开」那一刻加 is-entering（用 justOpened 门控）', () => {
    expect(chatJs).toContain('is-entering');
    expect(chatJs).toMatch(/justOpened/);
  });
});

describe('V2.2.9 修复2：检索模式分段文字配色跟随查询范围', () => {
  it('hifi 下 .chat-mode-title 颜色改为 inherit（不再被 var(--text) 覆盖）', () => {
    const blocks = extractRuleBlocks(stylesCss, '.chat-hifi-modes .chat-mode-segment .chat-mode-title').join('\n');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks).toMatch(/color\s*:\s*inherit/);
  });

  it('检索模式分段选中态用 accent-text（与查询范围一致，保证深 accent 皮肤对比度）', () => {
    const selected = extractRuleBlocks(
      stylesCss,
      '.chat-hifi-modes .chat-mode-segment.selected'
    ).join('\n');
    expect(selected).toMatch(/color\s*:\s*var\(--accent-text\)/);
  });

  it('检索模式分段未选态用 muted（与查询范围一致）', () => {
    const seg = extractRuleBlocks(stylesCss, '.chat-hifi-modes .chat-mode-segment {').join('\n');
    expect(seg).toMatch(/color\s*:\s*var\(--muted\)/);
  });
});
