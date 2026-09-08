import { describe, it, expect } from 'vitest';
import { streamLargeScopeDiscovery } from '../src/scope/large-scope-stream.js';
import type { TwoStageResult } from '../src/scope/two-stage.js';

function fakeSink() {
  const out: string[] = [];
  let status = 'running';
  let citations: number | undefined;
  return {
    out, get status() { return status; }, get citations() { return citations; },
    appendOutput: (c: string) => { out.push(c); },
    complete: (meta?: { sourceCitationSummary?: { sourceCount: number } }) => {
      status = 'completed'; citations = meta?.sourceCitationSummary?.sourceCount;
    },
    fail: (m: string) => { out.push(m); status = 'failed'; }
  };
}

describe('streamLargeScopeDiscovery', () => {
  it('成功路径：起始进度 + 阶段进度 + 答案 + citations + cleanup', async () => {
    const sink = fakeSink();
    let cleaned = false;
    const result: TwoStageResult = {
      answer: '逐芯片命中…', usedChipIds: ['E521.31', 'E521.39'], droppedChipIds: [],
      cleanup: async () => { cleaned = true; }
    };
    const runQuery = async (onTrace: (s: string, d: Record<string, unknown>) => void) => {
      onTrace('cc.stage1', { candidatesCount: 3 });
      onTrace('ws.copy', { files: 80 });
      onTrace('cc.stage2', { answerChars: 12 });
      return result;
    };
    const traced: string[] = [];
    await streamLargeScopeDiscovery({
      sink, runQuery: runQuery as never, scopePresetId: 'dynamic-group',
      recordTrace: (stage) => traced.push(stage)
    });
    const text = sink.out.join('');
    expect(text).toContain('正在跨多文档检索');
    expect(text).toContain('正在筛选候选');
    expect(text).toContain('正在精读');
    expect(text).toContain('逐芯片命中…');
    expect(sink.status).toBe('completed');
    expect(sink.citations).toBe(2);
    expect(cleaned).toBe(true);
    // admin Discovery Trace 收到全部后台阶段（spec §3.4 / 验收 §10）
    expect(traced).toEqual(['cc.stage1', 'ws.copy', 'cc.stage2']);
  });

  it('零候选短路：仅起始+筛选进度、中性答案、citations=0、cleanup（T18-c）', async () => {
    const sink = fakeSink();
    let cleaned = false;
    // 模拟 runTwoStageDiscovery 零候选短路：只发 cc.stage1 trace，返回空 usedChipIds + 中性答案，不发 ws.copy/cc.stage2。
    const result: TwoStageResult = {
      answer: '该范围内未发现匹配芯片。', usedChipIds: [], droppedChipIds: [],
      cleanup: async () => { cleaned = true; }
    };
    const runQuery = async (onTrace: (s: string, d: Record<string, unknown>) => void) => {
      onTrace('cc.stage1', { candidatesCount: 0, rawCandidatesCount: 0, truncated: false });
      return result;
    };
    const traced: string[] = [];
    await streamLargeScopeDiscovery({
      sink, runQuery: runQuery as never, scopePresetId: 'dynamic-global',
      recordTrace: (stage) => traced.push(stage)
    });
    const text = sink.out.join('');
    expect(text).toContain('正在跨多文档检索');
    expect(text).toContain('正在筛选候选');
    expect(text).not.toContain('正在精读');   // 短路：无 ws.copy 精读进度
    expect(text).toContain('该范围内未发现匹配芯片。');
    expect(sink.status).toBe('completed');
    expect(sink.citations).toBe(0);           // buildUsedSources([]) → sourceCount 0 → UI「来源」显示 0（连 F1）
    expect(cleaned).toBe(true);
    expect(traced).toEqual(['cc.stage1']);    // 短路后仅 stage1 trace
  });

  it('runQuery 抛错 → fail(中性) + onError 收到真错误', async () => {
    const sink = fakeSink();
    let captured: unknown;
    await streamLargeScopeDiscovery({
      sink, scopePresetId: 'dynamic-global',
      runQuery: async () => { throw new Error('CC exited 1'); },
      onError: (e) => { captured = e; }
    });
    expect(sink.status).toBe('failed');
    expect(sink.out.join('')).toContain('未能完成');
    expect((captured as Error).message).toBe('CC exited 1');
  });

  it('超时 → fail（onError 收到超时错误）', async () => {
    const sink = fakeSink();
    const errors: unknown[] = [];
    let aborted = false;
    await streamLargeScopeDiscovery({
      sink, scopePresetId: 'dynamic-global', timeoutMs: 10,
      runQuery: (_trace, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        });
      }),
      onError: (e) => { errors.push(e); }
    });
    expect(sink.status).toBe('failed');
    expect(aborted).toBe(true);
    expect((errors[0] as Error).message).toContain('timed out');
  });

  it('外部取消会 abort 后台检索且不把已 killed 会话改写成 failed', async () => {
    const sink = fakeSink();
    const controller = new AbortController();
    const running = streamLargeScopeDiscovery({
      sink,
      scopePresetId: 'dynamic-global',
      signal: controller.signal,
      runQuery: (_trace, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      })
    });

    controller.abort(new Error('user cancelled'));
    await running;

    expect(sink.status).toBe('running');
    expect(sink.out.join('')).not.toContain('未能完成');
  });

  it('超时后即使 runQuery 晚到完成，也会清理其工作区且不覆盖 failed 终态', async () => {
    const sink = fakeSink();
    let resolveQuery!: (result: TwoStageResult) => void;
    let cleaned = false;
    const running = streamLargeScopeDiscovery({
      sink,
      scopePresetId: 'dynamic-global',
      timeoutMs: 5,
      runQuery: () => new Promise<TwoStageResult>((resolve) => { resolveQuery = resolve; })
    });

    await running;
    expect(sink.status).toBe('failed');

    resolveQuery({
      answer: 'late answer',
      usedChipIds: [],
      droppedChipIds: [],
      cleanup: async () => { cleaned = true; }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleaned).toBe(true);
    expect(sink.status).toBe('failed');
    expect(sink.out.join('')).not.toContain('late answer');
  });
});
