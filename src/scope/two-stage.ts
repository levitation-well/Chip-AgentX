/**
 * src/scope/two-stage.ts
 * 两阶段检索编排器：
 *   阶段 1 → 给 CC 发送 INDEX，让 CC 输出候选 JSON
 *   阶段 2 → 后端硬规则二次鉴权，copy 候选全文，CC --resume 精读作答
 *
 * 所有 IO（CC 调用、工作区物化、文件 copy）均通过 deps 注入，便于单元测试。
 */
import type { ScopeIndexRow } from './index-retrieval.js';
import { parseCandidateChipIdsDetailed, reauthorizeCandidates } from './index-retrieval.js';

/** stage1 候选数上限：防止宽泛查询返回全部芯片导致 stage2 读整库超时。 */
export const DEFAULT_STAGE1_CANDIDATE_LIMIT = 8;

/** 零候选时的中性答案（不暴露内部机制/路径）。 */
export const NEUTRAL_NO_MATCH_ANSWER = '该范围内未发现匹配芯片。';

// ---- 类型定义 ----

export interface TwoStageDeps {
  /**
   * 执行一次 CC turn（prompt 输入），返回 CC 输出文本。
   * resume:false → 新会话（stage1）；resume:true → 续接同一会话（stage2）。
   */
  runCcTurn: (input: {
    workspaceCwd: string;
    prompt: string;
    resume: boolean;
  }) => Promise<string>;

  /**
   * 将 INDEX 行列表物化为临时工作区目录，返回 cwd 与清理函数。
   */
  materializeIndex: (rows: ScopeIndexRow[]) => Promise<{
    cwd: string;
    cleanup: () => Promise<void>;
    /** Question rewritten to local workspace assets, when applicable. */
    preparedQuestion?: string;
  }>;

  /**
   * 将候选 chipId 对应的全文文件 copy 进 cwd，返回实际 copy 文件数。
   * 新实现可附带相对文件清单，旧测试桩仍可只返回 number。
   */
  copyCandidateFullText: (
    cwd: string,
    chipIds: string[],
    allowedDocumentIds: string[]
  ) => Promise<number | TwoStageCopyResult>;

  /**
   * 可选追踪回调。
   * detail 继续只接收安全摘要（计数/长度）；artifact 是 Layer 2 debug bundle 的可选产物；
   * durationMs 是本阶段真实耗时（毫秒，起止差采集，非近似值，V16）。
   */
  onTrace?: (
    stage: 'cc.stage1' | 'auth.recheck' | 'ws.copy' | 'cc.stage2',
    detail: Record<string, unknown>,
    artifact?: unknown,
    durationMs?: number
  ) => void;
}

export interface TwoStageCopiedFile {
  chipId: string;
  path: string;
  size?: number;
}

export interface TwoStageCopyResult {
  count: number;
  files: TwoStageCopiedFile[];
}

export interface TwoStageResult {
  /** CC stage2 精读给出的最终答案 */
  answer: string;
  /** 二次鉴权后实际被 copy 的候选 chipId 列表 */
  usedChipIds: string[];
  /** 被剔除的越权候选 chipId 列表 */
  droppedChipIds: string[];
  /** 释放工作区资源（调用 materializeIndex 返回的 cleanup） */
  cleanup: () => Promise<void>;
}

export interface ScopeAuthorizationSnapshot {
  allowedChipIds: string[];
  allowedDocumentIds: string[];
}

// ---- 内部 prompt 构建 ----

function buildStage1Prompt(question: string, indexJson: string, limit: number): string {
  return `# 任务：候选芯片筛选（第一阶段）

你正在协助回答以下问题：
${question}

下方是当前授权范围内的芯片 INDEX，每条包含 chipId、标签、简介等元数据。
请仅依据 INDEX 判断哪些芯片最可能与问题相关。

## INDEX
${indexJson}

## 输出要求
只输出一个 JSON 代码块，格式如下，不要包含其他内容：
\`\`\`json
{"candidates":[{"chipId":"<id>","reason":"<简短理由>"},...]}
\`\`\`

只返回与问题最相关的至多 ${limit} 颗芯片；若相关芯片超过 ${limit} 颗，请按相关度排序后只保留前 ${limit} 颗。
若无相关芯片，candidates 为空数组。不要推测 INDEX 之外的芯片。`;
}

function buildStage2Prompt(question: string): string {
  return `# 任务：精读作答（第二阶段）

你在第一阶段选出的候选芯片全文（datasheet 内容）已经放入工作区，请精读后回答：

${question}

作答时请：
1. 直接回答问题，引用具体数值或规格。
2. 在回答末尾列出参考来源（chipId + 文档片段标题）。
3. 若多个芯片均相关，请分别说明。`;
}

// ---- 主函数 ----

/**
 * runTwoStageDiscovery
 * 两阶段检索编排器——编排纯逻辑，IO 全注入。
 */
export async function runTwoStageDiscovery(opts: {
  index: ScopeIndexRow[];
  allowedChipIds: string[];
  allowedDocumentIds?: string[];
  question: string;
  deps: TwoStageDeps;
  candidateLimit?: number;
  /** Resolve the current grants after stage1, immediately before any full-text copy. */
  reauthorize?: () => Promise<ScopeAuthorizationSnapshot>;
  signal?: AbortSignal;
}): Promise<TwoStageResult> {
  const { index, allowedChipIds, question, deps } = opts;
  const limit = opts.candidateLimit ?? DEFAULT_STAGE1_CANDIDATE_LIMIT;
  const trace = deps.onTrace ?? (() => undefined);

  // B3 fix: wrap entire flow in try/catch so cleanup runs on every failure
  // path (stage1 / auth / copy / stage2 throw). On success we leave cleanup
  // to the caller via the returned `cleanup` handle, preserving the
  // existing post-result inspection contract used by tests and SSE.
  let ws: Awaited<ReturnType<typeof deps.materializeIndex>> | undefined;
  try {
    throwIfAborted(opts.signal);
    ws = await deps.materializeIndex(index);
    throwIfAborted(opts.signal);
    const preparedQuestion = ws.preparedQuestion ?? question;

    const indexJson = JSON.stringify(
      index.map((r) => ({
        chipId: r.chipId,
        label: r.label,
        ...(r.brand !== undefined ? { brand: r.brand } : {}),
        ...(r.productLines !== undefined ? { productLines: r.productLines } : {}),
        ...(r.features !== undefined ? { features: r.features } : {}),
        summary: r.summary,
      })),
      null,
      2
    );

    const stage1Prompt = buildStage1Prompt(preparedQuestion, indexJson, limit);
    const stage1StartedAt = Date.now();
    const stage1Response = await deps.runCcTurn({
      workspaceCwd: ws.cwd,
      prompt: stage1Prompt,
      resume: false,
    });
    throwIfAborted(opts.signal);
    const stage1DurationMs = Date.now() - stage1StartedAt;

    const candidateParse = parseCandidateChipIdsDetailed(stage1Response);
    if (!candidateParse.valid) {
      throw new Error('Stage 1 returned malformed candidate JSON.');
    }
    const candidatesAll = candidateParse.chipIds;
    // Hallucinated/unauthorized ids must not consume the legitimate candidate
    // budget and displace an authorized chip that appears later in the model
    // response. Apply the hard snapshot first, then cap the authorized set.
    const initial = reauthorizeCandidates(candidatesAll, allowedChipIds);
    const candidatesRaw = initial.kept.slice(0, limit);
    const truncated = initial.kept.length > limit;
    trace(
      'cc.stage1',
      { candidatesCount: candidatesRaw.length, rawCandidatesCount: candidatesAll.length, truncated },
      {
        prompt: stage1Prompt,
        response: stage1Response,
        candidates: candidatesRaw,
        rawCandidatesCount: candidatesAll.length,
        truncated
      },
      stage1DurationMs
    );

    const authStartedAt = Date.now();
    const currentAuthorization = opts.reauthorize
      ? await opts.reauthorize()
      : { allowedChipIds, allowedDocumentIds: opts.allowedDocumentIds ?? [] };
    throwIfAborted(opts.signal);
    const current = reauthorizeCandidates(candidatesRaw, currentAuthorization.allowedChipIds);
    const kept = current.kept;
    const dropped = [...new Set([...initial.dropped, ...current.dropped])];
    trace(
      'auth.recheck',
      { kept: kept.length, dropped: dropped.length, documents: currentAuthorization.allowedDocumentIds.length },
      { kept, dropped },
      Date.now() - authStartedAt
    );

    if (kept.length === 0) {
      return { answer: NEUTRAL_NO_MATCH_ANSWER, usedChipIds: [], droppedChipIds: dropped, cleanup: wrapCleanup(ws.cleanup) };
    }

    const copyStartedAt = Date.now();
    const copiedResult = normalizeCopyResult(
      await deps.copyCandidateFullText(ws.cwd, kept, currentAuthorization.allowedDocumentIds)
    );
    throwIfAborted(opts.signal);
    const actuallyCopiedChipIds = copiedResult.files.length > 0
      ? [...new Set(copiedResult.files.map((file) => file.chipId))].filter((chipId) => kept.includes(chipId))
      : copiedResult.count > 0
        ? kept
        : [];
    const copyDropped = kept.filter((chipId) => !actuallyCopiedChipIds.includes(chipId));
    const finalDropped = [...new Set([...dropped, ...copyDropped])];
    const copyDurationMs = Date.now() - copyStartedAt;
    trace(
      'ws.copy',
      { chips: actuallyCopiedChipIds.length, files: copiedResult.count, dropped: copyDropped.length },
      { chips: actuallyCopiedChipIds, dropped: copyDropped, files: copiedResult.files },
      copyDurationMs
    );

    if (actuallyCopiedChipIds.length === 0 || copiedResult.count === 0) {
      return {
        answer: NEUTRAL_NO_MATCH_ANSWER,
        usedChipIds: [],
        droppedChipIds: finalDropped,
        cleanup: wrapCleanup(ws.cleanup)
      };
    }

    const stage2Prompt = buildStage2Prompt(preparedQuestion);
    const stage2StartedAt = Date.now();
    const answer = await deps.runCcTurn({
      workspaceCwd: ws.cwd,
      prompt: stage2Prompt,
      resume: true,
    });
    throwIfAborted(opts.signal);
    const stage2DurationMs = Date.now() - stage2StartedAt;
    trace('cc.stage2', { answerChars: answer.length }, { prompt: stage2Prompt, answer }, stage2DurationMs);

    return {
      answer,
      usedChipIds: actuallyCopiedChipIds,
      droppedChipIds: finalDropped,
      cleanup: wrapCleanup(ws.cleanup)
    };
  } catch (err) {
    // B3: any failure path cleans up the partial workspace before rethrowing.
    if (ws) {
      await ws.cleanup().catch(() => {});
    }
    throw err;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('large-scope discovery cancelled');
}

function normalizeCopyResult(value: number | TwoStageCopyResult): TwoStageCopyResult {
  if (typeof value === 'number') {
    return { count: value, files: [] };
  }
  return value;
}

/**
 * B3 fix: wrap the workspace cleanup so callers can safely invoke
 * `result.cleanup()` even though we also run it in the `finally` block.
 * Without this guard the underlying `cleanup()` would be called twice
 * (once from `finally`, once from the caller), which the test suite and
 * idempotent-cleanup implementations both expect to be once.
 */
function wrapCleanup(raw: () => Promise<void>): () => Promise<void> {
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await raw().catch(() => {});
  };
}
