/**
 * tests/scope-two-stage.test.ts
 * TDD：两阶段检索编排器 runTwoStageDiscovery
 * 全量注入依赖，不依赖真实 CC / 文件系统。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ScopeIndexRow } from '../src/scope/index-retrieval.js';
import { runTwoStageDiscovery } from '../src/scope/two-stage.js';
import type { TwoStageDeps, TwoStageResult } from '../src/scope/two-stage.js';

// ---- 测试数据 ----
const INDEX_ROWS: ScopeIndexRow[] = [
  { chipId: 'A', label: 'Chip A', summary: 'Alpha chip' },
  { chipId: 'B', label: 'Chip B', summary: 'Beta chip' },
  { chipId: 'C', label: 'Chip C', summary: 'Gamma chip' },
];

// CC 第一次回答：包含 A、X（越权）、B 三个候选
const STAGE1_CC_RESPONSE = `我已分析 INDEX，以下是候选列表：

\`\`\`json
{"candidates":[{"chipId":"A","reason":"匹配关键词"},{"chipId":"X","reason":"看起来相关"},{"chipId":"B","reason":"高相关度"}]}
\`\`\`

以上为初步筛选结果。`;

// CC 第二次回答：精读后给出最终答案
const STAGE2_CC_RESPONSE = '最终答案';

const ALLOWED_CHIP_IDS = ['A', 'B', 'C']; // X 不在授权列表

// ---- 每次测试前构造新的 fake deps ----
function makeDeps(overrides?: Partial<TwoStageDeps>): TwoStageDeps {
  const cleanupFn = vi.fn().mockResolvedValue(undefined);

  const runCcTurn = vi.fn().mockImplementation(
    async (input: { workspaceCwd: string; prompt: string; resume: boolean }) => {
      if (!input.resume) {
        return STAGE1_CC_RESPONSE;
      }
      return STAGE2_CC_RESPONSE;
    }
  );

  const materializeIndex = vi.fn().mockResolvedValue({
    cwd: '/ws',
    cleanup: cleanupFn,
  });

  const copyCandidateFullText = vi.fn().mockResolvedValue(2); // 假设复制了 2 个文件

  return {
    runCcTurn,
    materializeIndex,
    copyCandidateFullText,
    ...overrides,
  };
}

// ---- 测试套件 ----
describe('runTwoStageDiscovery', () => {
  it('应按正确顺序调用四个阶段', async () => {
    const deps = makeDeps();
    const callOrder: string[] = [];

    // 包裹 deps 以记录调用顺序
    const wrapped: TwoStageDeps = {
      materializeIndex: vi.fn().mockImplementation(async (rows) => {
        callOrder.push('materializeIndex');
        return (deps.materializeIndex as ReturnType<typeof vi.fn>)(rows);
      }),
      runCcTurn: vi.fn().mockImplementation(async (input) => {
        callOrder.push(input.resume ? 'runCcTurn:stage2' : 'runCcTurn:stage1');
        return (deps.runCcTurn as ReturnType<typeof vi.fn>)(input);
      }),
      copyCandidateFullText: vi.fn().mockImplementation(async (cwd, chipIds) => {
        callOrder.push('copyCandidateFullText');
        return (deps.copyCandidateFullText as ReturnType<typeof vi.fn>)(cwd, chipIds);
      }),
    };

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: wrapped,
    });

    expect(callOrder).toEqual([
      'materializeIndex',
      'runCcTurn:stage1',
      'copyCandidateFullText',
      'runCcTurn:stage2',
    ]);
  });

  it('usedChipIds 只含授权候选 A 和 B，droppedChipIds 含越权的 X', async () => {
    const deps = makeDeps();
    const result: TwoStageResult = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    expect(result.usedChipIds).toEqual(['A', 'B']);
    expect(result.droppedChipIds).toEqual(['X']);
  });

  it('answer 为第二阶段 CC 回答', async () => {
    const deps = makeDeps();
    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    expect(result.answer).toBe('最终答案');
  });

  it('copyCandidateFullText 只被传入 kept（不含越权 X）', async () => {
    const deps = makeDeps();
    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    const copyMock = deps.copyCandidateFullText as ReturnType<typeof vi.fn>;
    expect(copyMock).toHaveBeenCalledTimes(1);
    const [, chipIds] = copyMock.mock.calls[0] as [string, string[]];
    expect(chipIds).toContain('A');
    expect(chipIds).toContain('B');
    expect(chipIds).not.toContain('X');
    expect(chipIds.length).toBe(2);
  });

  it('stage1 后使用当前授权快照，并把当前 allowedDocumentIds 传给 copy', async () => {
    const deps = makeDeps();
    const reauthorize = vi.fn().mockResolvedValue({
      allowedChipIds: ['A'],
      allowedDocumentIds: ['doc-a']
    });

    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      allowedDocumentIds: ['doc-a', 'doc-b'],
      question: '芯片 A 的电压范围是多少？',
      deps,
      reauthorize
    });

    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(result.usedChipIds).toEqual(['A']);
    expect(result.droppedChipIds).toEqual(expect.arrayContaining(['X', 'B']));
    expect(deps.copyCandidateFullText).toHaveBeenCalledWith('/ws', ['A'], ['doc-a']);
  });

  it('stage1 runCcTurn 使用 resume:false，stage2 使用 resume:true', async () => {
    const deps = makeDeps();
    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    const runMock = deps.runCcTurn as ReturnType<typeof vi.fn>;
    expect(runMock).toHaveBeenCalledTimes(2);

    const [call1, call2] = runMock.mock.calls as [
      [{ workspaceCwd: string; prompt: string; resume: boolean }],
      [{ workspaceCwd: string; prompt: string; resume: boolean }],
    ];
    expect(call1[0].resume).toBe(false);
    expect(call2[0].resume).toBe(true);
  });

  it('两次 runCcTurn 都使用 materializeIndex 返回的 cwd', async () => {
    const deps = makeDeps();
    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    const runMock = deps.runCcTurn as ReturnType<typeof vi.fn>;
    const calls = runMock.mock.calls as [[{ workspaceCwd: string; prompt: string; resume: boolean }]];
    for (const [input] of calls) {
      expect(input.workspaceCwd).toBe('/ws');
    }
  });

  it('onTrace 四阶段都被调到，detail 不含路径', async () => {
    const deps = makeDeps();
    const traces: Array<{ stage: string; detail: Record<string, unknown> }> = [];

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: {
        ...deps,
        onTrace: (stage, detail) => {
          traces.push({ stage, detail });
        },
      },
    });

    const stages = traces.map((t) => t.stage);
    expect(stages).toContain('cc.stage1');
    expect(stages).toContain('auth.recheck');
    expect(stages).toContain('ws.copy');
    expect(stages).toContain('cc.stage2');

    // detail 中不允许出现路径（含 '/' 或 '\' 的字符串值）
    for (const { detail } of traces) {
      for (const [key, val] of Object.entries(detail)) {
        if (typeof val === 'string') {
          expect(val, `trace detail key "${key}" 不得含路径`).not.toMatch(/[/\\]/);
        }
      }
    }
  });

  it('onTrace auth.recheck detail 含 kept 和 dropped 计数', async () => {
    const deps = makeDeps();
    let authDetail: Record<string, unknown> | undefined;

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: {
        ...deps,
        onTrace: (stage, detail) => {
          if (stage === 'auth.recheck') authDetail = detail;
        },
      },
    });

    expect(authDetail).toBeDefined();
    expect(authDetail!['kept']).toBe(2);
    expect(authDetail!['dropped']).toBe(1);
  });

  it('onTrace cc.stage2 detail 含 answerChars', async () => {
    const deps = makeDeps();
    let stage2Detail: Record<string, unknown> | undefined;

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: {
        ...deps,
        onTrace: (stage, detail) => {
          if (stage === 'cc.stage2') stage2Detail = detail;
        },
      },
    });

    expect(stage2Detail).toBeDefined();
    expect(stage2Detail!['answerChars']).toBe('最终答案'.length);
  });

  it('onTrace artifact carries stage text, auth decisions, copied files, and final answer without changing detail counts', async () => {
    const deps = makeDeps({
      copyCandidateFullText: vi.fn().mockResolvedValue({
        count: 2,
        files: [
          { chipId: 'A', path: 'A/spec.md', size: 12 },
          { chipId: 'B', path: 'B/spec.md', size: 34 }
        ]
      })
    });
    const traces: Array<{ stage: string; detail: Record<string, unknown>; artifact?: unknown }> = [];

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: {
        ...deps,
        onTrace: (stage, detail, artifact) => {
          traces.push({ stage, detail, artifact });
        },
      },
    });

    expect(traces.find((trace) => trace.stage === 'cc.stage1')?.detail).toMatchObject({
      candidatesCount: 2,
      rawCandidatesCount: 3,
      truncated: false
    });
    expect(traces.find((trace) => trace.stage === 'cc.stage1')?.artifact).toMatchObject({
      response: STAGE1_CC_RESPONSE,
      candidates: ['A', 'B']
    });
    expect(traces.find((trace) => trace.stage === 'auth.recheck')?.artifact).toEqual({
      kept: ['A', 'B'],
      dropped: ['X']
    });
    expect(traces.find((trace) => trace.stage === 'ws.copy')?.detail).toEqual({ chips: 2, files: 2, dropped: 0 });
    expect(traces.find((trace) => trace.stage === 'ws.copy')?.artifact).toEqual({
      chips: ['A', 'B'],
      dropped: [],
      files: [
        { chipId: 'A', path: 'A/spec.md', size: 12 },
        { chipId: 'B', path: 'B/spec.md', size: 34 }
      ]
    });
    expect(traces.find((trace) => trace.stage === 'cc.stage2')?.artifact).toMatchObject({
      answer: STAGE2_CC_RESPONSE
    });
  });

  it('返回的 cleanup 即 materializeIndex 返回的 cleanup', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      materializeIndex: vi.fn().mockResolvedValue({ cwd: '/ws', cleanup: cleanupFn }),
    });

    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps,
    });

    await result.cleanup();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('所有候选都被授权时 droppedChipIds 为空数组', async () => {
    // CC 只返回 A 和 B，都在授权列表中
    const deps = makeDeps({
      runCcTurn: vi.fn().mockImplementation(
        async (input: { resume: boolean }) => {
          if (!input.resume) {
            return '```json\n{"candidates":[{"chipId":"A"},{"chipId":"B"}]}\n```';
          }
          return '最终答案';
        }
      ),
    });

    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '测试问题',
      deps,
    });

    expect(result.droppedChipIds).toEqual([]);
    expect(result.usedChipIds).toEqual(['A', 'B']);
  });

  it('零候选时短路：不调 copy/stage2，返回中性答案且 cleanup 可用', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    const stage2Spy = vi.fn();
    const deps = makeDeps({
      materializeIndex: vi.fn().mockResolvedValue({ cwd: '/ws', cleanup: cleanupFn }),
      runCcTurn: vi.fn().mockImplementation(async (input: { resume: boolean }) => {
        if (input.resume) { stage2Spy(); return '不应被调用'; }
        return '```json\n{"candidates":[]}\n```';
      })
    });
    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS, allowedChipIds: ALLOWED_CHIP_IDS, question: 'q', deps
    });
    expect(result.answer).toBe('该范围内未发现匹配芯片。');
    expect(result.usedChipIds).toEqual([]);
    expect(stage2Spy).not.toHaveBeenCalled();
    expect(deps.copyCandidateFullText).not.toHaveBeenCalled();
    await result.cleanup();
    expect(cleanupFn).toHaveBeenCalled();
  });

  it('treats malformed stage1 output as an execution error instead of a false no-match answer', async () => {
    const cleanupFn = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      materializeIndex: vi.fn().mockResolvedValue({ cwd: '/ws', cleanup: cleanupFn }),
      runCcTurn: vi.fn().mockResolvedValue('not valid candidate JSON')
    });

    await expect(runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: 'q',
      deps
    })).rejects.toThrow('malformed candidate JSON');
    expect(deps.copyCandidateFullText).not.toHaveBeenCalled();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it('候选全为越权时也短路（kept=0、dropped 非空）', async () => {
    const deps = makeDeps({
      runCcTurn: vi.fn().mockImplementation(async (input: { resume: boolean }) =>
        input.resume ? 'x' : '```json\n{"candidates":[{"chipId":"X","reason":"r"},{"chipId":"Y","reason":"r"}]}\n```'
      )
    });
    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS, allowedChipIds: ALLOWED_CHIP_IDS, question: 'q', deps
    });
    expect(result.answer).toBe('该范围内未发现匹配芯片。');
    expect(result.usedChipIds).toEqual([]);
    expect(result.droppedChipIds).toEqual(['X', 'Y']);
    expect(deps.copyCandidateFullText).not.toHaveBeenCalled();
  });

  it('onTrace 携带每阶段真实耗时 durationMs（V16）', async () => {
    const traces: Array<{ stage: string; durationMs?: number }> = [];
    const deps = makeDeps({
      runCcTurn: vi.fn().mockImplementation(async (input: { resume: boolean }) => {
        // stage1 人为耗时更久，stage2 耗时更短，用于断言两者耗时不同且均为正数。
        await new Promise((resolve) => setTimeout(resolve, input.resume ? 5 : 20));
        return input.resume ? STAGE2_CC_RESPONSE : STAGE1_CC_RESPONSE;
      }),
    });

    await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ALLOWED_CHIP_IDS,
      question: '芯片 A 的电压范围是多少？',
      deps: {
        ...deps,
        onTrace: (stage, _detail, _artifact, durationMs) => {
          traces.push({ stage, durationMs });
        },
      },
    });

    const stage1 = traces.find((t) => t.stage === 'cc.stage1');
    const copy = traces.find((t) => t.stage === 'ws.copy');
    const stage2 = traces.find((t) => t.stage === 'cc.stage2');

    expect(stage1?.durationMs).toBeGreaterThan(0);
    expect(copy?.durationMs).toBeGreaterThanOrEqual(0);
    expect(stage2?.durationMs).toBeGreaterThan(0);
    // stage1 人为等待 20ms、stage2 人为等待 5ms：真实起止采集应体现这个差异，
    // 而不是所有阶段共用同一写入时刻（近似值）。
    expect(stage1!.durationMs!).toBeGreaterThan(stage2!.durationMs!);
  });

  it('stage1 候选超过上限时截断到 limit，并在 trace 标 truncated', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `C${i}`);
    const traces: Array<{ stage: string; detail: Record<string, unknown> }> = [];
    const deps = makeDeps({
      runCcTurn: vi.fn().mockImplementation(async (input: { resume: boolean }) =>
        input.resume
          ? '答案'
          : '```json\n' + JSON.stringify({ candidates: many.map((id) => ({ chipId: id, reason: 'r' })) }) + '\n```'
      ),
      onTrace: (stage, detail) => traces.push({ stage, detail }),
    });
    const result = await runTwoStageDiscovery({
      index: many.map((id) => ({ chipId: id, label: id, summary: id })),
      allowedChipIds: many,
      question: 'q',
      deps,
      candidateLimit: 5,
    });
    expect(result.usedChipIds).toHaveLength(5);
    const stage1 = traces.find((t) => t.stage === 'cc.stage1')!;
    expect(stage1.detail).toMatchObject({ candidatesCount: 5, rawCandidatesCount: 12, truncated: true });
    const copyMock = deps.copyCandidateFullText as ReturnType<typeof vi.fn>;
    expect((copyMock.mock.calls[0]![1] as string[]).length).toBe(5);
  });

  it('does not let unauthorized hallucinations consume the authorized candidate limit', async () => {
    const deps = makeDeps({
      runCcTurn: vi.fn().mockImplementation(async (input: { resume: boolean }) =>
        input.resume
          ? '答案'
          : '```json\n{"candidates":[{"chipId":"A"},{"chipId":"X"},{"chipId":"B"}]}\n```'
      )
    });
    const result = await runTwoStageDiscovery({
      index: INDEX_ROWS,
      allowedChipIds: ['A', 'B'],
      question: 'q',
      deps,
      candidateLimit: 2
    });

    expect(result.usedChipIds).toEqual(['A', 'B']);
    expect(result.droppedChipIds).toContain('X');
  });
});
