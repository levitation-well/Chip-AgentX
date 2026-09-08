/**
 * src/scope/two-stage-live.ts
 * 两阶段检索真实 deps 工厂。
 *
 * createLiveTwoStageDeps 把真实 adapter / 文件系统操作包装成
 * runTwoStageDiscovery 所需的 TwoStageDeps 接口，以便：
 *   - 生产路径：直接使用 ClaudeCodeConversationAdapter
 *   - 测试路径：注入假 adapterFactory，不跑真实 claude
 */

import { mkdir, rm, writeFile, copyFile, readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { ClaudeCodeConversationAdapter } from '../adapters/child-adapter.js';
import { resolveChipWorkspace } from '../chips/index.js';
import { scopeLaunchHardening } from './chip-launch.js';
import type { TwoStageCopyResult, TwoStageDeps } from './two-stage.js';
import type { ScopeIndexRow } from './index-retrieval.js';
import type { ChipCatalog } from '../chips/types.js';
import type { ClaudeModelRole } from '../model-routing.js';
import { requireSafeId } from './workspace.js';
import type { ResourceVisibilityCatalog } from '../security/index.js';
import { filterWholeWorkspaceAuthorizedChipIds } from './document-chip-map.js';
import { materializeChatImagesIntoWorkspace } from '../chat-image-workspace.js';
import { containsChatImageInput } from '../search-modes.js';

// 允许 copy 的文件后缀（与 chip-workspace.ts 保持一致）
const ALLOWED_EXTENSIONS = /\.(md|markdown|txt|json|csv|pdf)$/i;
export const DEFAULT_MAX_SCOPE_COPY_FILES = 1_000;
export const DEFAULT_MAX_SCOPE_COPY_BYTES = 512 * 1024 * 1024;

// ---- 类型定义 ----

export interface LiveTwoStageDepsOptions {
  /** 芯片目录 */
  catalog: ChipCatalog;
  /** 数据目录（工作区、INDEX 等均落于此） */
  dataDir: string;
  /** 知识库根目录（用于 scopeLaunchHardening 的 deny 规则） */
  knowledgeBaseRoot: string;
  /** Claude role resolved by AgentX mode routing. */
  claudeModelRole?: ClaudeModelRole;
  /** 可选 trace 回调，透传给 TwoStageDeps.onTrace */
  onTrace?: TwoStageDeps['onTrace'];
  /**
   * 可选 adapter 工厂（**测试注入假 adapter**）。
   * 缺省返回 new ClaudeCodeConversationAdapter()。
   */
  adapterFactory?: () => ClaudeCodeConversationAdapter;
  /** Current resource catalog; read at copy time so admin changes are respected. */
  getResourceCatalog?: () => ResourceVisibilityCatalog | null | undefined;
  signal?: AbortSignal;
  /** Original question and owner used to materialize authenticated chat uploads. */
  question?: string;
  userId?: string;
  maxCopiedFiles?: number;
  maxCopiedBytes?: number;
}

export interface LiveTwoStageDeps extends TwoStageDeps {
  /** 清理 deps 内部持有的所有 index 工作区（供调用方在 runScopeQueryLarge 完成后调用） */
  cleanupAll: () => Promise<void>;
}

// ---- 递归列举文件（只含允许后缀）----

async function listAllowedFiles(base: string, rel: string, out: string[] = []): Promise<string[]> {
  const fullPath = rel ? path.join(base, rel) : base;
  try {
    const entries = await readdir(fullPath, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await listAllowedFiles(base, childRel, out);
      } else if (entry.isFile() && ALLOWED_EXTENSIONS.test(entry.name)) {
        out.push(childRel);
      }
      // symlink 静默跳过（安全行为）
    }
  } catch {
    // 目录不存在或无权限时静默返回已收集结果
  }

  return out;
}

// ---- 工厂主体 ----

/**
 * createLiveTwoStageDeps
 * 生产真实 TwoStageDeps 对象，持有一个共享的 ClaudeCodeConversationAdapter 实例。
 */
export function createLiveTwoStageDeps(opts: LiveTwoStageDepsOptions): LiveTwoStageDeps {
  const { catalog, dataDir, knowledgeBaseRoot, claudeModelRole, onTrace, adapterFactory } = opts;

  // 单例 adapter（整个两阶段共用，resume 机制靠 claudeSessionId 续接）
  const factory = adapterFactory ?? (() => new ClaudeCodeConversationAdapter());
  const adapter = factory();

  // 记录所有已创建的 index 工作区，供 cleanupAll 清理
  const indexWorkspaceClearnups: Array<() => Promise<void>> = [];

  // ── materializeIndex ──────────────────────────────────────────────────────
  async function materializeIndex(rows: ScopeIndexRow[]): Promise<{
    cwd: string;
    cleanup: () => Promise<void>;
    preparedQuestion?: string;
  }> {
    throwIfAborted(opts.signal);
    const dir = path.join(
      path.resolve(dataDir),
      'scope-workspaces',
      `index-${crypto.randomUUID()}`
    );
    await mkdir(dir, { recursive: true });

    const cleanup = () => rm(dir, { recursive: true, force: true });
    try {
      await writeFile(path.join(dir, 'INDEX.json'), JSON.stringify(rows), 'utf8');
      throwIfAborted(opts.signal);
      const preparedQuestion = opts.question
        ? (await materializeChatImagesIntoWorkspace({
            task: opts.question,
            cwd: dir,
            dataDir,
            userId: opts.userId
          })).task
        : undefined;
      if (preparedQuestion && containsChatImageInput(preparedQuestion)) {
        throw new Error('One or more large-scope chat images are unavailable or expired.');
      }
      throwIfAborted(opts.signal);
      indexWorkspaceClearnups.push(cleanup);
      return { cwd: dir, cleanup, ...(preparedQuestion ? { preparedQuestion } : {}) };
    } catch (err) {
      await cleanup().catch(() => {});
      throw err;
    }
  }

  // ── runCcTurn ─────────────────────────────────────────────────────────────
  async function runCcTurn(input: {
    workspaceCwd: string;
    prompt: string;
    resume: boolean;
  }): Promise<string> {
    throwIfAborted(opts.signal);
    // 计算硬化参数（scopeLaunchHardening 是异步）
    const hardening = await scopeLaunchHardening(knowledgeBaseRoot);
    throwIfAborted(opts.signal);

    return new Promise<string>((resolve, reject) => {
      let accumulated = '';
      let settled = false;

      function onData(chunk: string) {
        accumulated += chunk;
      }

      function cleanupHandlers() {
        adapter.removeDataHandler(onData);
        adapter.removeStateHandler?.(onState as Parameters<typeof adapter.removeStateHandler>[0]);
        adapter.removeExitHandler?.(onExit as Parameters<typeof adapter.removeExitHandler>[0]);
        opts.signal?.removeEventListener('abort', onAbort);
      }

      function onAbort() {
        if (settled) return;
        settled = true;
        cleanupHandlers();
        adapter.kill();
        reject(abortReason(opts.signal));
      }

      function onState(state: { turnState?: string }) {
        if (state.turnState === 'idle' && !settled) {
          settled = true;
          cleanupHandlers();
          // 从 stream-json 中提取 assistant 文本
          const text = extractAssistantText(accumulated);
          resolve(text);
        }
      }

      function onExit(code: number) {
        if (!settled) {
          settled = true;
          cleanupHandlers();
          if (code === 0) {
            resolve(extractAssistantText(accumulated));
          } else {
            reject(new Error(`CC turn exited with code ${code}`));
          }
        }
      }

      adapter.onData(onData);
      adapter.onState?.(onState as Parameters<typeof adapter.onState>[0]);
      adapter.onExit(onExit);
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        if (!input.resume) {
          // 首次 turn → spawn 新会话
          adapter.spawn(input.workspaceCwd, {}, 200, 80, input.prompt, {
            ...(claudeModelRole ? { claudeModelRole } : {}),
            permissionMode: hardening.permissionMode,
            allowedTools: hardening.allowedTools,
            denyReadRoots: hardening.denyReadRoots
          });
        } else {
          // 续接会话 → write（adapter 内部用 claudeSessionId --resume）
          adapter.write(input.prompt);
        }
      } catch (error) {
        settled = true;
        cleanupHandlers();
        reject(error);
      }
    });
  }

  // ── copyCandidateFullText ─────────────────────────────────────────────────
  async function copyCandidateFullText(
    cwd: string,
    chipIds: string[],
    allowedDocumentIds: string[]
  ): Promise<TwoStageCopyResult> {
    throwIfAborted(opts.signal);
    let totalFiles = 0;
    let totalBytes = 0;
    const files: TwoStageCopyResult['files'] = [];

    // B4: enforce workspace boundary once for the destination root.
    const realCwd = await realpath(cwd);

    const copyableChipIds = filterWholeWorkspaceAuthorizedChipIds(
      opts.getResourceCatalog?.(),
      chipIds,
      allowedDocumentIds
    );
    for (const chipId of copyableChipIds) {
      throwIfAborted(opts.signal);
      // B4 fix: validate chipId as safe id before using it as a path segment.
      let safeChipId: string;
      try {
        safeChipId = requireSafeId(chipId, 'chipId');
      } catch {
        // unsafe id — skip rather than abort the entire copy.
        continue;
      }

      // resolveChipWorkspace 会验证 chipId 存在且目录有效
      let resolved: Awaited<ReturnType<typeof resolveChipWorkspace>>;
      try {
        resolved = await resolveChipWorkspace(catalog, chipId);
      } catch {
        // chip 不存在或目录不可访问——跳过，不阻断其他 chip
        continue;
      }

      const srcRoot = resolved.cwd;
      const destRoot = path.join(cwd, safeChipId);
      // B4: ensure destRoot is under cwd (post-realpath boundary check).
      const realDestRoot = await realpath(destRoot).catch(async () => {
        // dest may not exist yet — check parent after mkdir.
        await mkdir(destRoot, { recursive: true });
        return realpath(destRoot);
      });
      if (!realDestRoot.startsWith(realCwd + path.sep) && realDestRoot !== realCwd) {
        // destination would escape cwd — skip this chip.
        continue;
      }

      const relFiles = await listAllowedFiles(srcRoot, '');

      for (const rel of relFiles) {
        throwIfAborted(opts.signal);
        const src = path.join(srcRoot, rel);
        const dest = path.join(realDestRoot, rel);
        const sourceStat = await stat(src).catch(() => undefined);
        if (!sourceStat?.isFile()) {
          continue;
        }
        if (
          totalFiles + 1 > (opts.maxCopiedFiles ?? DEFAULT_MAX_SCOPE_COPY_FILES) ||
          totalBytes + sourceStat.size > (opts.maxCopiedBytes ?? DEFAULT_MAX_SCOPE_COPY_BYTES)
        ) {
          throw new Error('Large-scope candidate copy budget exceeded. Narrow the search scope.');
        }
        await mkdir(path.dirname(dest), { recursive: true });
        // B4: per-file boundary check — refuse to copy outside destRoot.
        const realDest = await realpath(path.dirname(dest)).catch(() => realDestRoot);
        if (!realDest.startsWith(realDestRoot + path.sep) && realDest !== realDestRoot) {
          continue;
        }
        await copyFile(src, dest);
        const copiedStat = await stat(dest).catch(() => undefined);
        totalFiles += 1;
        totalBytes += copiedStat?.size ?? sourceStat.size;
        files.push({
          chipId,
          path: path.join(safeChipId, rel).replace(/\\/g, '/'),
          ...(copiedStat ? { size: copiedStat.size } : {})
        });
      }
    }

    return { count: totalFiles, files };
  }

  // ── cleanupAll ────────────────────────────────────────────────────────────
  async function cleanupAll(): Promise<void> {
    await Promise.all(indexWorkspaceClearnups.map((fn) => fn().catch(() => {})));
  }

  return {
    runCcTurn,
    materializeIndex,
    copyCandidateFullText,
    onTrace,
    cleanupAll,
  };
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('large-scope discovery cancelled');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

// ---- 内部：从 stream-json 输出中提取 assistant 文本 ----

/**
 * extractAssistantText
 * 遍历 CC --output-format stream-json 输出的每行，
 * 提取 type='assistant' 消息中 content 数组里的 text 块，拼接返回。
 * 若解析失败（非 stream-json 格式，如测试的假输出），原样返回整个 accumulated。
 */
function extractAssistantText(raw: string): string {
  const lines = raw.split('\n');
  const parts: string[] = [];
  let hadStreamJson = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    const record = obj as Record<string, unknown>;

    if (record['type'] === 'assistant') {
      hadStreamJson = true;
      const message = record['message'];
      if (message && typeof message === 'object' && !Array.isArray(message)) {
        const content = (message as Record<string, unknown>)['content'];
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === 'object' &&
              !Array.isArray(block) &&
              (block as Record<string, unknown>)['type'] === 'text'
            ) {
              const text = (block as Record<string, unknown>)['text'];
              if (typeof text === 'string') {
                parts.push(text);
              }
            }
          }
        }
      }
    }
  }

  // 若未解析到任何 stream-json assistant 行，原样返回（兼容假 adapter 的直接文本输出）
  if (!hadStreamJson) {
    return raw;
  }

  return parts.join('');
}
