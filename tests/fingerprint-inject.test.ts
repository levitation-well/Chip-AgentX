import { describe, expect, it } from 'vitest';
import { maybeInjectFingerprint } from '../src/fingerprint/index.js';

const marker = 'agentx-fp:v1.payload.signature';

describe('fingerprint injection helper', () => {
  it('injects ordinary long natural language once', () => {
    const text =
      '这是一段面向用户的自然语言总结，内容足够长，用来说明本次会话完成了哪些事情，以及后续应该如何验证。它没有代码块、路径、命令或结构化 JSON，因此适合附加轻量来源标记。';

    const injected = maybeInjectFingerprint(text, { marker });

    expect(injected).toContain(marker);
    expect(maybeInjectFingerprint(injected, { marker }).match(/agentx-fp:v1/g)).toHaveLength(1);
  });

  it('skips short text and missing marker', () => {
    expect(maybeInjectFingerprint('短回答。', { marker })).toBe('短回答。');
    expect(maybeInjectFingerprint('这是一段足够长的自然语言回答。'.repeat(8), {})).not.toContain('agentx-fp');
  });

  it('skips JSON and fenced code', () => {
    expect(maybeInjectFingerprint('{"ok":true,"message":"hello"}', { marker })).not.toContain(marker);
    expect(maybeInjectFingerprint('说明如下：\n```ts\nconst a = 1;\n```\n请保存。'.repeat(6), { marker })).not.toContain(marker);
  });

  it('skips commands, paths, UUIDs, logs, and machine tables', () => {
    const samples = [
      'git status --short\nnpm test\nnode dist/cli/index.js server'.repeat(8),
      '请检查 D:\\repo\\chip-agentx\\src\\http-server.ts 这个路径，然后继续分析。'.repeat(6),
      '019c6e27-e55b-73d1-87d8-4e01f1f75043 '.repeat(12),
      'INFO server started\nWARN retrying\nERROR failed\nDEBUG details'.repeat(8),
      '| key | value |\n| --- | --- |\n| status | ok |'.repeat(8)
    ];

    for (const sample of samples) {
      expect(maybeInjectFingerprint(sample, { marker })).not.toContain(marker);
    }
  });
});
