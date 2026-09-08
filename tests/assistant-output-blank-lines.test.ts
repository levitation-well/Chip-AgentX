import { describe, expect, it } from 'vitest';
import { projectAssistantOutput } from '../src/server/assistant-output-protocol.js';

describe('assistant output preserves paragraph blank lines', () => {
  it('keeps paragraph blank lines and table separator while projecting a result event', () => {
    const raw = JSON.stringify({
      type: 'result',
      result: '### 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n段落一。\n\n段落二。'
    });

    const out = projectAssistantOutput(raw, { allowAssistantFallback: true });

    // 段落之间的空行得以保留（不再被一刀切删除）
    expect(out.text).toMatch(/\n\n/);
    // 表格分隔行逐行保留
    expect(out.text).toMatch(/\|---\|/);
    // 标题与两段正文均在
    expect(out.text).toContain('### 标题');
    expect(out.text).toContain('段落一。');
    expect(out.text).toContain('段落二。');
  });

  it('folds runs of blank lines down to a single separator and trims edges', () => {
    const raw = JSON.stringify({
      type: 'result',
      result: '\n\n第一段。\n\n\n\n第二段。\n\n'
    });

    const out = projectAssistantOutput(raw, { allowAssistantFallback: true });

    // 首尾空行被去除，中间连续多空行折叠成一个
    expect(out.text).toBe('第一段。\n\n第二段。');
  });

  it('still redacts sensitive lines while preserving surrounding blank lines', () => {
    const raw = JSON.stringify({
      type: 'result',
      result: '正文一段。\n\nC:\\secret\\x.md\n\n/opt/chip-agentx/datasheets/E522/datasheet.md\n\n正文二段。'
    });

    const out = projectAssistantOutput(raw, { allowAssistantFallback: true });

    // 敏感路径行被脱敏，文本中不得出现这些路径
    expect(out.text).not.toContain('C:\\secret\\x.md');
    expect(out.text).not.toContain('/opt/chip-agentx/datasheets');
    // 正文仍在
    expect(out.text).toContain('正文一段。');
    expect(out.text).toContain('正文二段。');
    // redacted 元数据记录了对应脱敏标记
    expect(out.metadata.redacted).toContain('workspace-path');
    expect(out.metadata.redacted).toContain('server-path');
    // 整个投影序列化后不得泄露任何敏感路径
    expect(JSON.stringify(out)).not.toMatch(/secret\\x\.md|\/srv\/agentx-datasheets/);
  });
});
