/**
 * src/scope/large-scope-stream.ts
 * 大范围两阶段检索的后台编排器：把 runScopeQueryLarge 的结果以「进度行 + 答案」
 * 流式注入一个托管会话，并把阶段 trace 双写到 admin Discovery Trace。
 *
 * 注意：captureKind 固定为 'system_captured_source_seed'（UsedSourceCaptureKind 的唯一值），
 * 通过 createUsedSourceRecord / createSourceCitationSummary 工厂函数构建，不直接构造对象。
 */
import type { TwoStageResult } from './two-stage.js';
import type { SourceCitationSummary, UsedSourceRecord } from '../source-citations/index.js';
import { createUsedSourceRecord, createSourceCitationSummary } from '../source-citations/index.js';

export type TwoStageStage = 'cc.stage1' | 'auth.recheck' | 'ws.copy' | 'cc.stage2';
export type TwoStageTrace = (
  stage: TwoStageStage,
  detail: Record<string, unknown>,
  artifact?: unknown,
  durationMs?: number
) => void;

export interface LargeScopeSink {
  appendOutput(chunk: string): void;
  complete(meta?: { sourceCitationSummary?: SourceCitationSummary; usedSources?: UsedSourceRecord[] }): void;
  fail(message: string): void;
}

const START_LINE = '正在跨多文档检索相关芯片，请稍候…\n';
const FAIL_LINE = '跨多文档检索未能完成，请稍后重试或缩小范围。';
const PROGRESS: Partial<Record<TwoStageStage, string>> = {
  'cc.stage1': '正在筛选候选…\n',
  'ws.copy': '正在精读相关资料…\n',
  'cc.stage2': '正在生成回答…\n'
};
// 大范围两阶段需分钟级：stage1 读 INDEX 即可 ~70s，stage2 精读候选全文更久。
// 实测 240s 对「未收窄/读整库」偏短而超时；放宽到 600s 给收窄型查询足够余量。
// stage1 候选上限（DEFAULT_STAGE1_CANDIDATE_LIMIT，默认 8）已收窄候选数，与本超时共同抑制宽泛全局查询读整库。
const DEFAULT_TIMEOUT_MS = 600_000;

export async function streamLargeScopeDiscovery(input: {
  sink: LargeScopeSink;
  runQuery: (onTrace: TwoStageTrace, signal: AbortSignal) => Promise<TwoStageResult>;
  scopePresetId: string;
  recordTrace?: (stage: TwoStageStage, detail: Record<string, unknown>, artifact?: unknown, durationMs?: number) => void;
  onError?: (err: unknown) => void;
  timeoutMs?: number;
  chipLabelOf?: (chipId: string) => string;
  signal?: AbortSignal;
}): Promise<void> {
  const { sink, runQuery, recordTrace, onError, scopePresetId } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  sink.appendOutput(START_LINE);

  const onTrace: TwoStageTrace = (stage, detail, artifact, durationMs) => {
    const line = PROGRESS[stage];
    if (line) sink.appendOutput(line);
    recordTrace?.(stage, detail, artifact, durationMs);
  };

  let timer: NodeJS.Timeout | undefined;
  let result: TwoStageResult | undefined;
  const timeoutController = new AbortController();
  const linked = linkAbortSignals(input.signal, timeoutController.signal);
  let timedOut = false;
  let queryPromise: Promise<TwoStageResult> | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      const rejectFromAbort = () => reject(
        linked.signal.reason instanceof Error
          ? linked.signal.reason
          : new Error('large-scope discovery cancelled')
      );
      if (linked.signal.aborted) {
        rejectFromAbort();
      } else {
        linked.signal.addEventListener('abort', rejectFromAbort, { once: true });
      }
    });
    timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(new Error('large-scope discovery timed out'));
    }, timeoutMs);
    queryPromise = Promise.resolve().then(() => runQuery(onTrace, linked.signal));
    // 取消/超时胜出后 queryPromise 可能仍在后台运行；先消费其潜在 rejection，避免
    // unhandledRejection。若实现忽略 AbortSignal 而晚到成功，catch 中还会补做 cleanup。
    queryPromise.catch(() => {});
    result = await Promise.race([queryPromise, aborted]);
    if (linked.signal.aborted) {
      await result.cleanup().catch(() => {});
      result = undefined;
      return;
    }
    sink.appendOutput('\n' + result.answer);

    const usedSources = buildUsedSources(result.usedChipIds, scopePresetId, input.chipLabelOf);
    const sourceCitationSummary = createSourceCitationSummary(usedSources);
    sink.complete({ sourceCitationSummary, usedSources });
  } catch (err) {
    if (queryPromise && !result) {
      void queryPromise.then((lateResult) => lateResult.cleanup()).catch(() => {});
    }
    if (input.signal?.aborted && !timedOut) {
      return;
    }
    onError?.(err);
    sink.fail(FAIL_LINE);
  } finally {
    if (timer) clearTimeout(timer);
    linked.cleanup();
    if (result) await result.cleanup().catch(() => {});
  }
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  for (const signal of signals) {
    if (!signal) continue;
    const listener = () => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason);
      }
    };
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener);
      }
    }
  };
}

function buildUsedSources(
  chipIds: string[],
  scopePresetId: string,
  labelOf?: (id: string) => string
): UsedSourceRecord[] {
  const records: UsedSourceRecord[] = [];
  for (const chipId of chipIds) {
    const record = createUsedSourceRecord({
      scopeId: scopePresetId,
      scopePresetId,
      documentId: chipId,
      displayTitle: labelOf?.(chipId) ?? chipId,
      chipId
    });
    if (record) records.push(record);
  }
  return records;
}
