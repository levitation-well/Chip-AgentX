/**
 * M2 Task4：chat 页范围（scope preset）选择器合约测试
 *
 * 使用 readPublicFile + jsdom/字符串断言，验证：
 * 1. chat.html 含 #scope-select 元素，且在 .composer-floatbar 内
 * 2. chat.js 含 /api/scope-presets 拉取逻辑
 * 3. chat.js 建会话按范围模式组装请求体（2.2.6 范围选择器取代旧 scopePresetId 路径）
 * 4. assets/i18n-chat.js carries the zh/en chat.scope.label keys
 *    (chat.* catalogs were deduplicated out of i18n.js core)
 *
 * 注：2.2.6 起 #scope-select 下拉降级为隐藏回退，新范围选择器见
 *     tests/web-ui-scope-selector.test.ts（范围模式分段 + 内容面板 + scope 描述符）。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('scope preset 选择器 — HTML 结构', () => {
  it('chat.html 包含 #scope-select 元素', () => {
    const html = readPublicFile('chat.html');
    const { document } = new JSDOM(html).window;
    const scopeSelect = document.querySelector('#scope-select');
    expect(scopeSelect).not.toBeNull();
    expect(scopeSelect?.tagName.toLowerCase()).toBe('select');
  });

  it('#scope-select 位于 .composer-floatbar 内（与 chip-pill 同层）', () => {
    const html = readPublicFile('chat.html');
    const { document } = new JSDOM(html).window;
    const floatbar = document.querySelector('.composer-floatbar');
    expect(floatbar).not.toBeNull();
    const scopeSelect = floatbar?.querySelector('#scope-select');
    expect(scopeSelect).not.toBeNull();
  });

  it('#scope-select 的父 label 带 data-i18n 属性（scope label 文案走 i18n）', () => {
    const html = readPublicFile('chat.html');
    const { document } = new JSDOM(html).window;
    // label 或其直接祖先上必须有 data-i18n 属性，或 span 子节点带 data-i18n
    const scopeSelect = document.querySelector('#scope-select');
    expect(scopeSelect).not.toBeNull();
    const parent = scopeSelect?.closest('label');
    expect(parent).not.toBeNull();
    // label 内应存在携带 i18n key 的 span
    const i18nSpan = parent?.querySelector('[data-i18n]');
    expect(i18nSpan).not.toBeNull();
    expect(i18nSpan?.getAttribute('data-i18n')).toBe('chat.scope.label');
  });

  it('#scope-select 首项 value 为空（表示不限范围）', () => {
    const html = readPublicFile('chat.html');
    const { document } = new JSDOM(html).window;
    const first = document.querySelector('#scope-select option');
    expect(first).not.toBeNull();
    expect(first?.getAttribute('value')).toBe('');
  });
});

describe('scope preset 选择器 — chat.js 逻辑', () => {
  it('chat.js 在初始化时拉取 /api/scope-presets', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain('/api/scope-presets');
    // 必须用 authFetch
    const idx = js.indexOf('/api/scope-presets');
    const snippet = js.slice(Math.max(0, idx - 60), idx + 40);
    expect(snippet).toContain('authFetch');
  });

  it('chat.js 有 renderScopeSelect / loadScopePresets 函数（或类似命名）负责填充选择器', () => {
    const js = readPublicFile('chat.js');
    // 至少含以下之一
    const hasFn =
      js.includes('renderScopeSelect') ||
      js.includes('loadScopePresets') ||
      js.includes('fillScopeSelect');
    expect(hasFn).toBe(true);
  });

  it('chat.js 在 els 字典中引用 scopeSelect', () => {
    const js = readPublicFile('chat.js');
    expect(js).toContain("scopeSelect: document.getElementById('scope-select')");
  });

  // 说明：2.2.6 范围选择器（V2.2.6-scope-selector）已用「范围模式分段 + scope 描述符」
  // 取代旧的 #scope-select 下拉 + scopePresetId 建会话路径。WebChat 入口 createSession
  // 现按 state.scopeMode 组装请求体：single→顶层 chipId（零回归）、group→scope:{mode:'group',
  // groups}、global→scope:{mode:'global'}。后端仍接受 scopePresetId（未改），但 UI 不再发送它。
  // 下两条断言已更新为新契约。旧 #scope-select 元素保留为隐藏回退，其结构断言仍在上方保留。
  it('chat.js 的 createSession 按 scopeMode 组装请求体（single→chipId，group/global→scope 描述符）', () => {
    const js = readPublicFile('chat.js');
    const idx = js.indexOf('async function createSession(');
    expect(idx).toBeGreaterThan(-1);
    const bodyStart = js.indexOf('{', idx);
    let depth = 0;
    let end = bodyStart;
    for (let i = bodyStart; i < js.length; i++) {
      if (js[i] === '{') depth++;
      if (js[i] === '}') depth--;
      if (depth === 0) { end = i; break; }
    }
    const fn = js.slice(idx, end + 1);
    // single 走顶层 chipId；group/global 走 scope 描述符
    expect(fn).toMatch(/scopeMode\s*===\s*'group'/);
    expect(fn).toMatch(/scopeMode\s*===\s*'global'/);
    expect(fn).toContain('chipId');
    expect(fn).toMatch(/mode:\s*'group'/);
    expect(fn).toMatch(/mode:\s*'global'/);
  });

  it('chat.js 建会话 body 按模式发 chipId 或 scope 描述符', () => {
    const js = readPublicFile('chat.js');
    // group 模式发 scope.groups，global 模式发 scope.mode=global，single 模式发 chipId
    expect(js).toMatch(/groups:\s*state\.selectedGroups/);
    expect(js).toMatch(/scope:\s*\{\s*mode:\s*'global'\s*\}/);
    expect(js).toMatch(/chipId/);
  });
});

describe('scope preset i18n key', () => {
  it('i18n-chat.js has zh and en translations for chat.scope.label', () => {
    const i18n = readPublicFile('assets/i18n-chat.js');
    expect(i18n).toContain("'chat.scope.label'");
    // Present once per locale catalog (zh-CN + en-US).
    const count = (i18n.match(/'chat\.scope\.label'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('i18n-chat.js has zh and en translations for chat.scope.all (first "no scope" option)', () => {
    const i18n = readPublicFile('assets/i18n-chat.js');
    expect(i18n).toContain("'chat.scope.all'");
    const count = (i18n.match(/'chat\.scope\.all'/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
