import type { ChipCatalog } from '../chips/types.js';

/**
 * scope 索引行——发送给 CC 的授权过滤后芯片摘要，不含文件系统路径。
 */
export interface ScopeIndexRow {
  chipId: string;
  label: string;
  brand?: string;
  productLines?: string[];
  features?: string[];
  summary: string;
}

/**
 * 硬规则二次鉴权结果。
 */
export interface ReauthorizeResult {
  kept: string[];
  dropped: string[];
}

export interface CandidateParseResult {
  valid: boolean;
  chipIds: string[];
}

/**
 * buildScopeIndex
 * 遍历 catalog.chips，只取 allowedChipIds 中存在的条目，
 * 生成发送给 CC 的授权过滤 INDEX。
 * 纯函数，无 IO。
 */
export function buildScopeIndex(catalog: ChipCatalog, allowedChipIds: string[]): ScopeIndexRow[] {
  const allowedSet = new Set(allowedChipIds);
  const rows: ScopeIndexRow[] = [];

  for (const chip of catalog.chips) {
    if (!allowedSet.has(chip.id)) {
      continue;
    }

    const row: ScopeIndexRow = {
      chipId: chip.id,
      label: chip.label,
      // summary 优先级：summary > description > queryHint > label
      summary: chip.summary ?? chip.description ?? chip.queryHint ?? chip.label
    };

    if (chip.brand !== undefined) {
      row.brand = chip.brand;
    }
    if (chip.productLines !== undefined) {
      row.productLines = chip.productLines;
    }
    if (chip.applicationTags !== undefined) {
      row.features = chip.applicationTags;
    }

    rows.push(row);
  }

  return rows;
}

/**
 * parseCandidateChipIds
 * 从 CC 输出文本中解析候选 chipId 列表。
 * 解析策略（优先级从高到低）：
 *   1. 提取 ```json ... ``` fence 内容
 *   2. 提取裸 {...} JSON 对象
 * 取 parsed.candidates 数组中每项的 chipId（字符串），trim 后过滤空，去重。
 * 解析失败返回 []，纯函数，无 IO。
 */
export function parseCandidateChipIds(ccText: string): string[] {
  return parseCandidateChipIdsDetailed(ccText).chipIds;
}

/** Distinguishes a valid empty candidate list from malformed model output. */
export function parseCandidateChipIdsDetailed(ccText: string): CandidateParseResult {
  if (!ccText) return { valid: false, chipIds: [] };

  // 1. 尝试从 ```(json)? fence 提取
  const fenceMatch = ccText.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr: string | undefined;

  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // 2. 尝试裸 {...} 对象
    const bareMatch = ccText.match(/\{[\s\S]*\}/)?.[0];
    if (bareMatch) {
      jsonStr = bareMatch;
    }
  }

  if (!jsonStr) return { valid: false, chipIds: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return { valid: false, chipIds: [] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false, chipIds: [] };

  const candidates = (parsed as Record<string, unknown>)['candidates'];
  if (!Array.isArray(candidates)) return { valid: false, chipIds: [] };

  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const chipId = (item as Record<string, unknown>)['chipId'];
    if (typeof chipId !== 'string') continue;
    const trimmed = chipId.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }

  return { valid: true, chipIds: result };
}

/**
 * reauthorizeCandidates（硬规则二次鉴权）
 * 候选 trim 后若 ∈ allowedChipIds → kept，否则 → dropped。
 * 去重、保持顺序。绝不信任 CC 的输出——后端独立鉴权。
 * 纯函数，无 IO。
 */
export function reauthorizeCandidates(
  candidateChipIds: string[],
  allowedChipIds: string[]
): ReauthorizeResult {
  const allowedSet = new Set(allowedChipIds.map((id) => id.trim()));
  const seen = new Set<string>();
  const kept: string[] = [];
  const dropped: string[] = [];

  for (const candidate of candidateChipIds) {
    const trimmed = candidate.trim();
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);

    if (allowedSet.has(trimmed)) {
      kept.push(trimmed);
    } else {
      dropped.push(trimmed);
    }
  }

  return { kept, dropped };
}
