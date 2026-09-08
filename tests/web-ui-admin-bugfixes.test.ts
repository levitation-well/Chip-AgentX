/**
 * B15 admin 运行时 / 显示 bug 修复合约测试。
 *
 * 直读 public/admin.js 真实源码：
 *  - #1 renderEmptyState 经哨兵抽取后真实求值（之前全仓无定义 → 4 处调用抛 ReferenceError）。
 *  - #2 datasheet 扫描摘要「检索」字段的恒「否」三元（曾两处）已修为 true→是 / false→否。
 *    2026-07-05（round3 批次 D1）：SPEC 明令资料提交工单详情不做 安全扫描/metadata候选/绑定意图
 *    字段组，`formatUploadReviewSummary`/`formatBindingIntent`（该三元的两处出处）随之整体删除，
 *    故本文件不再断言该三元出现次数，只保留「无恒否分支」的防回归检查。
 *
 * (B15 #3「工单类型切换不清状态筛选」经核实不成立：renderTicketStatusOptions 用
 *  `options.currentValue ?? select.value` + includeAll 分支，旧状态对新类型非法时 select.value
 *  已被设为 ''，故不改，本文件不为其断言。)
 *
 * 2.2.19 追加：反馈&工单 section 因 setFeedbackError 全仓无定义而在
 * loadFeedbackWorkspace() 进入即抛 ReferenceError，loadAdminTickets() 从未执行，
 * 工单列表恒空且报错路径同样调用同一未定义函数、无法显示任何错误提示。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function loadRenderEmptyState(documentRef: Document): (text?: string) => HTMLElement {
  const src = readPublicFile('admin.js');
  const startMarker = '=== TESTABLE renderEmptyState START ===';
  const endMarker = '=== TESTABLE renderEmptyState END ===';
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0) {
    throw new Error('renderEmptyState sentinel not found');
  }
  const body = src.slice(src.indexOf('\n', start) + 1, src.lastIndexOf('\n', end));
  // eslint-disable-next-line no-new-func
  const adminText = (_key: string, fallback?: string) => fallback || _key;
  return new Function('document', 'adminText', `${body}\nreturn renderEmptyState;`)(documentRef, adminText);
}

describe('admin.js B15 bugfixes', () => {
  it('#1 defines renderEmptyState returning an empty-state element with given text', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    const renderEmptyState = loadRenderEmptyState(dom.window.document);
    const el = renderEmptyState('暂无追踪记录');
    expect(el.className).toContain('empty-state');
    expect(el.textContent).toBe('暂无追踪记录');
  });

  it('#1 renderEmptyState falls back to 无数据 when no text given', () => {
    const dom = new JSDOM('<!DOCTYPE html><body></body>');
    const renderEmptyState = loadRenderEmptyState(dom.window.document);
    expect(renderEmptyState().textContent).toBe('无数据');
  });

  it('#2 no identical-branch searchable ternary remains', () => {
    const src = readPublicFile('admin.js');
    expect(src).not.toContain("? '否' : '否'");
  });

  it('#2 removed datasheet upload-review formatters no longer carry the identical-branch searchable ternary', () => {
    // round3 D1：formatUploadReviewSummary/formatBindingIntent 整体删除（SPEC 不做 datasheet 审核字段组），
    // 该三元的两处出处一并消失；不再断言出现次数，只需确认相关函数确已移除。
    const src = readPublicFile('admin.js');
    expect(src).not.toContain('function formatUploadReviewSummary');
    expect(src).not.toContain('function formatBindingIntent');
    expect(src).not.toContain('function formatMetadataCandidate');
  });

  it('#3 every setFeedbackError(...) call site has a matching function definition', () => {
    const src = readPublicFile('admin.js');
    // 通用哨兵：任何 setXxxError 被调用却全仓无定义，都会在此断言失败——不止锁 setFeedbackError 一个名字。
    const callSitePattern = /\bset(\w*Error)\s*\(/g;
    const definedNames = new Set<string>();
    const definitionPattern = /function\s+(set\w*Error)\s*\(|const\s+(set\w*Error)\s*=/g;
    let defMatch: RegExpExecArray | null;
    while ((defMatch = definitionPattern.exec(src))) {
      definedNames.add(defMatch[1] || defMatch[2]);
    }
    const calledButUndefined = new Set<string>();
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callSitePattern.exec(src))) {
      const name = `set${callMatch[1]}`;
      if (!definedNames.has(name)) {
        calledButUndefined.add(name);
      }
    }
    expect([...calledButUndefined]).toEqual([]);
  });

  it('#3 setFeedbackError is defined and writes to the feedback-admin-error element', () => {
    const src = readPublicFile('admin.js');
    expect(src).toMatch(/function setFeedbackError\([^)]*\)\s*\{\s*if \(els\.feedbackAdminError\)/);
  });

  it('#3 admin.html carries the feedback-admin-error element wired into els.feedbackAdminError', () => {
    const html = readPublicFile('admin.html');
    const js = readPublicFile('admin.js');
    expect(html).toContain('id="feedback-admin-error"');
    expect(js).toContain("feedbackAdminError: document.getElementById('feedback-admin-error')");
  });
});
