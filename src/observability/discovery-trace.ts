import path from 'node:path';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { appendJsonLine, readJsonLinesTail } from '../persistence/json-file.js';
import { redactDebugValue } from './redaction.js';
import type { Logger } from '../logging/logger.js';

/**
 * Discovery Trace 最小落点（spec §6.9）。
 *
 * 每次后端启动经隔离闸的 Claude Code 会话落一条 `cc.launch` 事件（含实际加固 flags），
 * 失败（非零退出）落一条 `error` 事件，供后续 admin 调试页面观测。
 * scope 分支额外落 `scope.resolve`（范围解析完成）与 `scope.materialize`（工作区物化完成）。
 *
 * 约定：
 * - `detail` 落库前整体过 `redactDebugValue`（绝对路径 → `[REDACTED_PATH]`，敏感 key → `[REDACTED_SECRET]`），
 *   所以原始路径既不会落 jsonl 也不会落日志。
 * - jsonl 落 `<dataDir>/discovery-traces.jsonl`，读取时按 `maxEvents` / `limit` 截断到最近 N 条。
 */
export type DiscoveryTraceStage =
  | 'cc.launch'
  | 'error'
  | 'scope.resolve'
  | 'scope.materialize'
  | 'cc.stage1'
  | 'auth.recheck'
  | 'ws.copy'
  | 'cc.stage2';

export interface DiscoveryTraceEvent {
  traceId: string;
  sessionId: string;
  turnId?: string;
  stage: DiscoveryTraceStage;
  status: 'ok' | 'error';
  detail: Record<string, unknown>;
  ts: string;
}

export interface DiscoveryTraceStoreOptions {
  dataDir: string;
  logger?: Logger;
  maxEvents?: number;
}

export interface DiscoveryTraceRecordInput {
  traceId?: string;
  sessionId: string;
  turnId?: string;
  stage: DiscoveryTraceStage;
  status?: 'ok' | 'error';
  detail: Record<string, unknown>;
}

export interface DiscoveryTraceListOptions {
  limit?: number;
  sessionId?: string;
}

const DEFAULT_MAX_EVENTS = 500;
const TRACE_FILE_NAME = 'discovery-traces.jsonl';

/**
 * V10：discovery-traces.jsonl 落 dataDir 根目录、只 append 从不裁剪，曾无界增长。
 * 硬顶行数——超过后 `record()` 自剪重写为最近 N 行，防止文件本身无限变大。
 * 与 `maxEvents`（读取截断上限，默认 500）是两件事：这里是「文件最多留多少行」，
 * 硬顶需明显大于任何合理的 maxEvents，避免自剪影响正常读取窗口。
 */
export const DISCOVERY_TRACE_HARD_LINE_CAP = 5000;

// 自剪检查节流：避免每次 record() 都重新 stat + 计行数，只在写入次数达到间隔时检查一次。
const TRIM_CHECK_INTERVAL = 200;

export class DiscoveryTraceStore {
  private readonly filePath: string;
  private readonly logger?: Logger;
  private readonly maxEvents: number;
  // 串行化 append，避免并发写入交错（M1 量小，链式 Promise 足够）。
  private writeChain: Promise<void> = Promise.resolve();
  // 自剪检查节流计数器：只在写入次数达到 TRIM_CHECK_INTERVAL 的整数倍时才 stat + 计行数。
  private writeCountSinceTrimCheck = 0;

  constructor(opts: DiscoveryTraceStoreOptions) {
    this.filePath = path.join(opts.dataDir, TRACE_FILE_NAME);
    this.logger = opts.logger;
    this.maxEvents = opts.maxEvents && opts.maxEvents > 0 ? opts.maxEvents : DEFAULT_MAX_EVENTS;
  }

  record(input: DiscoveryTraceRecordInput): Promise<void> {
    const event: DiscoveryTraceEvent = {
      traceId: input.traceId ?? input.sessionId,
      sessionId: input.sessionId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      stage: input.stage,
      status: input.status ?? (input.stage === 'error' ? 'error' : 'ok'),
      // 落库前整体脱敏：路径不会明文落库/落日志。
      detail: redactDebugValue(input.detail ?? {}),
      ts: new Date().toISOString()
    };

    this.writeChain = this.writeChain
      .catch(() => {
        // 上一次失败不应阻断后续写入。
      })
      .then(() => appendJsonLine(this.filePath, event))
      .then(() => this.maybeTrim());

    const queued = this.writeChain;

    this.logger?.info('discovery_trace', input.stage, { sessionId: input.sessionId, metadata: event });

    return queued;
  }

  async list(opts: DiscoveryTraceListOptions = {}): Promise<DiscoveryTraceEvent[]> {
    // 等待挂起的写入落盘（含自剪重写），保证 list 读到最新且已裁剪的数据。
    await this.writeChain.catch(() => {});

    // 有界尾读：只读文件末尾最多 N 行再 parse，不整文件读入内存。
    // 当调用方按 sessionId 过滤时，不能先按全局 maxEvents 尾窗口收窄再过滤——
    // 该 session 的事件可能已被之后其它会话产生的事件顶出这个较小的窗口
    // （尤其是 sessionHasStage1 这类无 limit 的查询，只关心某个 session 是否存在过
    // 某个阶段，而非「最近 N 条全局事件」）。故 sessionId 路径改用远大于 maxEvents
    // 的窗口（文件自剪硬顶 DISCOVERY_TRACE_HARD_LINE_CAP）尾读，过滤 sessionId 之后
    // 再对结果套 maxEvents/limit 截断；文件本身已被 record() 自剪到硬顶以内，
    // 故此路径仍是有界读取，不会退化为无界整文件扫描。
    const tailWindow = opts.sessionId !== undefined ? DISCOVERY_TRACE_HARD_LINE_CAP : this.maxEvents;
    let events = await readJsonLinesTail<DiscoveryTraceEvent>(this.filePath, tailWindow);

    if (opts.sessionId !== undefined) {
      events = events.filter((event) => event.sessionId === opts.sessionId);
      if (events.length > this.maxEvents) {
        events = events.slice(events.length - this.maxEvents);
      }
    }

    if (opts.limit !== undefined && opts.limit >= 0 && events.length > opts.limit) {
      events = events.slice(events.length - opts.limit);
    }

    return events;
  }

  /**
   * 每写入 TRIM_CHECK_INTERVAL 次 append 后检查一次文件行数；超过硬顶时自剪重写为
   * 最近 DISCOVERY_TRACE_HARD_LINE_CAP 行，避免文件无界增长。用节流而非每次都检查，
   * 是因为检查本身需要一次 stat + 尾读，频繁做会抵消有界读取带来的收益。
   */
  private async maybeTrim(): Promise<void> {
    this.writeCountSinceTrimCheck += 1;
    if (this.writeCountSinceTrimCheck < TRIM_CHECK_INTERVAL) {
      return;
    }
    this.writeCountSinceTrimCheck = 0;

    let fileStat;
    try {
      fileStat = await stat(this.filePath);
    } catch {
      return;
    }
    if (fileStat.size === 0) {
      return;
    }

    // 粗略估计行数：先按硬顶+1 行的窗口尾读一次，若不足以判断超限则整文件读一次计行数。
    // 只在真正接近/超过硬顶时才会走到整文件读这条慢路径，常态下（未超限）走尾读快路径。
    const probe = await readJsonLinesTail<DiscoveryTraceEvent>(this.filePath, DISCOVERY_TRACE_HARD_LINE_CAP + 1);
    if (probe.length <= DISCOVERY_TRACE_HARD_LINE_CAP) {
      return;
    }

    const trimmed = probe.slice(probe.length - DISCOVERY_TRACE_HARD_LINE_CAP);
    await this.rewriteFile(trimmed);
  }

  private async rewriteFile(events: DiscoveryTraceEvent[]): Promise<void> {
    const tempPath = path.join(
      path.dirname(this.filePath),
      `${path.basename(this.filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    const body = events.map((event) => JSON.stringify(event)).join('\n') + (events.length > 0 ? '\n' : '');
    try {
      await writeFile(tempPath, body, 'utf8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      this.logger?.warn('discovery_trace_trim_failed', 'Failed to self-trim discovery-traces.jsonl', {
        metadata: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }
}

/**
 * scope 分支落点 helper（M2 Task 3）。
 *
 * 在 web 建会话 scope 分支拿到 spawnResult.sessionId 后调用，落两条 trace：
 * - `scope.resolve`：范围解析完成，记录 scopePresetId / scopeId / allowedChipCount /
 *   allowedDocumentCount / fileCount（均来自脱敏 safeSummary，不含绝对路径）。
 * - `scope.materialize`：工作区物化完成，记录 scopeId / fileCount / mode。
 *   当 `options.emitMaterialize === false` 时跳过此条（large 档未物化，不应伪造此事件）。
 *
 * 两条均 status='ok'，traceId 默认等于 sessionId，与同会话的 cc.launch 归并。
 * 默认行为（不传 options）与旧版完全一致，所有现有调用方无需修改。
 */
export function recordScopeTrace(
  store: DiscoveryTraceStore,
  sessionId: string,
  scopeSession: {
    scopePresetId: string;
    safeSummary: {
      scopeId: string;
      scopePresetId: string;
      fileCount: number;
      allowedChipCount: number;
      allowedDocumentCount: number;
      mode: string;
    };
  },
  options?: { emitMaterialize?: boolean }
): void {
  const { safeSummary } = scopeSession;

  // scope.resolve：范围解析结果（脱敏字段，无绝对路径）
  void store.record({
    sessionId,
    stage: 'scope.resolve',
    status: 'ok',
    traceId: sessionId,
    detail: {
      scopePresetId: safeSummary.scopePresetId,
      scopeId: safeSummary.scopeId,
      allowedChipCount: safeSummary.allowedChipCount,
      allowedDocumentCount: safeSummary.allowedDocumentCount,
      fileCount: safeSummary.fileCount
    }
  });

  // scope.materialize：工作区物化结果（仅脱敏摘要）。
  // large 档未物化时调用方传 { emitMaterialize: false } 跳过，避免伪造此事件。
  if (options?.emitMaterialize !== false) {
    void store.record({
      sessionId,
      stage: 'scope.materialize',
      status: 'ok',
      traceId: sessionId,
      detail: {
        scopeId: safeSummary.scopeId,
        fileCount: safeSummary.fileCount,
        mode: safeSummary.mode
      }
    });
  }
}
