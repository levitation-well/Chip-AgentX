import type { DocumentVisibilityContract, ResourceVisibilityCatalog } from '../security/index.js';

/**
 * V14 单一事实源：文档 ↔ 芯片映射从资源目录（resources.documents[].chipIds）派生。
 *
 * `chip.documentIds`（chips.json）曾是与本映射并行维护、独立可写的第二事实源，两者会漂移。
 * 从本模块起，运行时读路径统一以 `resources.documents[].chipIds` 反向派生 chipId -> documents，
 * `chip.documentIds` 字段本身为兼容旧 schema 保留，但不再作为授权/检索的权威来源。
 */

/**
 * 返回目录中挂在某 chipId 下的全部文档，按目录中文档声明顺序排列（不改变原始顺序，
 * 仅按 chipIds 命中过滤）。目录为空/缺失时返回空数组，不抛错。
 */
export function documentsForChip(
  catalog: ResourceVisibilityCatalog | null | undefined,
  chipId: string
): DocumentVisibilityContract[] {
  if (!catalog) {
    return [];
  }
  return catalog.documents.filter((document) => document.chipIds.includes(chipId));
}

/**
 * 一次性把目录中出现过的每个 chipId 反向索引成其文档列表，供需要批量查询多颗芯片的调用方复用，
 * 避免对每颗芯片各自线性扫描一遍 documents。保留目录中文档的原始顺序。
 */
export function deriveChipDocumentMap(
  catalog: ResourceVisibilityCatalog | null | undefined
): Map<string, DocumentVisibilityContract[]> {
  const map = new Map<string, DocumentVisibilityContract[]>();
  if (!catalog) {
    return map;
  }
  for (const document of catalog.documents) {
    for (const chipId of document.chipIds) {
      const existing = map.get(chipId);
      if (existing) {
        existing.push(document);
      } else {
        map.set(chipId, [document]);
      }
    }
  }
  return map;
}

/**
 * A chip workspace is the smallest physical copy unit until the resource catalog
 * grows a document-to-file mapping. Therefore a cataloged chip is safe to copy
 * only when every document registered to that chip is present in the current
 * authorization snapshot. Chips without catalog documents retain the legacy
 * chip-level behavior.
 */
export function filterWholeWorkspaceAuthorizedChipIds(
  catalog: ResourceVisibilityCatalog | null | undefined,
  allowedChipIds: readonly string[],
  allowedDocumentIds: readonly string[]
): string[] {
  const documentsByChip = deriveChipDocumentMap(catalog);
  const allowedDocuments = new Set(allowedDocumentIds);
  return allowedChipIds.filter((chipId) => {
    const documents = documentsByChip.get(chipId) ?? [];
    return documents.length === 0 || documents.every((document) => allowedDocuments.has(document.documentId));
  });
}
