/**
 * src/scope/run-scope-query.ts
 * large 档协调器——把 buildScopeIndex / createLiveTwoStageDeps / runTwoStageDiscovery 串起来。
 *
 * 接入点：handleSessionCreate 的 group/global 动态 scope 分支，scale='large' 时
 * 经 streamLargeScopeDiscovery 在后台调用本函数（2.2.10 T18 已接线）。
 */

import type { ChipCatalog } from '../chips/types.js';
import { buildScopeIndex } from './index-retrieval.js';
import { runTwoStageDiscovery } from './two-stage.js';
import { createLiveTwoStageDeps } from './two-stage-live.js';
import type { TwoStageResult } from './two-stage.js';
import type { ClaudeCodeConversationAdapter } from '../adapters/child-adapter.js';
import type { ClaudeModelRole } from '../model-routing.js';
import type { ResourceVisibilityCatalog } from '../security/index.js';
import { filterWholeWorkspaceAuthorizedChipIds } from './document-chip-map.js';
import type { ScopeAuthorizationSnapshot } from './two-stage.js';

export interface RunScopeQueryLargeOptions {
  /** 芯片目录 */
  catalog: ChipCatalog;
  /** 数据目录 */
  dataDir: string;
  /** 知识库根目录 */
  knowledgeBaseRoot: string;
  /** 当前用户允许访问的 chipId 列表 */
  allowedChipIds: string[];
  /** 当前用户允许访问、且属于本范围的 documentId 列表。 */
  allowedDocumentIds?: string[];
  /** Hot-reload aware resource catalog getter used by the final copy gate. */
  getResourceCatalog?: () => ResourceVisibilityCatalog | null | undefined;
  /** Re-resolve current grants after stage1 and before any full-text copy. */
  reauthorize?: () => Promise<ScopeAuthorizationSnapshot>;
  /** 用户问题 */
  question: string;
  /** Claude role resolved by AgentX mode routing; the provider gateway maps this role to the real model. */
  claudeModelRole?: ClaudeModelRole;
  /**
   * 可选 trace 回调——只接收安全摘要（计数/长度），不含路径/原文。
   * 四阶段：'cc.stage1' | 'auth.recheck' | 'ws.copy' | 'cc.stage2'
   * durationMs 是本阶段真实耗时（毫秒，V16）。
   */
  onTrace?: (
    stage: 'cc.stage1' | 'auth.recheck' | 'ws.copy' | 'cc.stage2',
    detail: Record<string, unknown>,
    artifact?: unknown,
    durationMs?: number
  ) => void;
  /**
   * 可选 adapter 工厂（测试注入假 adapter；缺省生产路径用 ClaudeCodeConversationAdapter）。
   */
  adapterFactory?: () => ClaudeCodeConversationAdapter;
  signal?: AbortSignal;
  userId?: string;
}

/**
 * runScopeQueryLarge
 * large 档两阶段检索协调器。
 *
 * 串联：
 *   1. buildScopeIndex(catalog, allowedChipIds) → ScopeIndexRow[]
 *   2. createLiveTwoStageDeps({...}) → TwoStageDeps
 *   3. runTwoStageDiscovery({index, allowedChipIds, question, deps}) → TwoStageResult
 *
 * 调用方负责在使用完 result 后调用 result.cleanup()（streamLargeScopeDiscovery 已在 finally 中代办）。
 */
export async function runScopeQueryLarge(
  opts: RunScopeQueryLargeOptions
): Promise<TwoStageResult> {
  const { catalog, dataDir, knowledgeBaseRoot, allowedChipIds, question, claudeModelRole, onTrace, adapterFactory } =
    opts;
  const allowedDocumentIds = opts.allowedDocumentIds ?? [];
  const initialAllowedDocumentIds = new Set(allowedDocumentIds);
  const getResourceCatalog = opts.getResourceCatalog ?? (() => undefined);
  const initialCopyableChipIds = filterWholeWorkspaceAuthorizedChipIds(
    getResourceCatalog(),
    allowedChipIds,
    allowedDocumentIds
  );

  // 步骤 1：构建授权过滤的 INDEX
  const index = buildScopeIndex(catalog, initialCopyableChipIds);

  // 步骤 2：创建真实 deps（含 adapter、fs 操作）
  const deps = createLiveTwoStageDeps({
    catalog,
    dataDir,
    knowledgeBaseRoot,
    claudeModelRole,
    onTrace,
    adapterFactory,
    getResourceCatalog,
    signal: opts.signal,
    question,
    userId: opts.userId
  });

  // 步骤 3：编排两阶段检索
  return runTwoStageDiscovery({
    index,
    allowedChipIds: initialCopyableChipIds,
    allowedDocumentIds,
    question,
    deps,
    candidateLimit: initialCopyableChipIds.length,
    signal: opts.signal,
    reauthorize: async () => {
      const current = opts.reauthorize
        ? await opts.reauthorize()
        : { allowedChipIds, allowedDocumentIds };
      const currentSnapshotDocumentIds = current.allowedDocumentIds.filter((documentId) =>
        initialAllowedDocumentIds.has(documentId)
      );
      return {
        allowedChipIds: filterWholeWorkspaceAuthorizedChipIds(
          getResourceCatalog(),
          current.allowedChipIds,
          currentSnapshotDocumentIds
        ),
        allowedDocumentIds: currentSnapshotDocumentIds
      };
    }
  });
}
