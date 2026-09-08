import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChipCatalog, ChipConfig } from '../chips/index.js';
import {
  evaluateDocumentVisibility,
  parseResourceVisibilityCatalog,
  type AuthorizationDecision,
  type EffectiveAuthorizationSummary,
  type ResourceGrantInput,
  type ResourceVisibilityCatalog
} from '../security/index.js';
import { documentsForChip } from './document-chip-map.js';
import type { ScopeRequiredGrantCounts, ScopeResolverEntryPoint, ScopeSelectionAllowed } from './resolver.js';
import { ScopeSessionDeniedError } from './scale.js';

/** 未传 resources 目录时的降级空目录，保持既有「无目录仍可用」的调用方不破坏。 */
const EMPTY_RESOURCE_CATALOG: ResourceVisibilityCatalog = parseResourceVisibilityCatalog({
  documents: [],
  scopePresets: []
});

const DEFAULT_SCOPE_OPTIONS_THRESHOLD = 200;

/**
 * Caller-supplied intent for a dynamic (preset-less) scope selection.
 * - single: one chip (chipId required).
 * - group: union of chips matched by one or more product-line / brand groups.
 * - global: the whole catalog (still intersected with authorized chips).
 */
export interface ScopeDescriptor {
  mode: 'single' | 'group' | 'global';
  chipId?: string;
  groups?: Array<{ dimension: 'productLine' | 'brand' | 'application'; value: string }>;
}

/**
 * 动态 scope（preset-less）合成 scopePresetId 的前缀标记。
 *
 * resolveDynamicScopeSelection 会把 `dynamic-${descriptor.mode}` 写进
 * ScopeSelectionAllowed.scopePresetId（single/group/global 三种），这不是资源目录里的
 * 真实 scopePreset——它只是"这条会话没有绑定单一 chip/document/预设，而是绑定了一组
 * 动态解析出来的 chip 列表"的合成标记。任何要按 scopePresetId 去查资源目录（按目录
 * 契约判定可见性/审批状态）的代码，遇到这个前缀必须绕过目录查找，转而对
 * session 上实际持有的 chip 列表逐个复核（见 isDynamicScopePresetId 的调用方）。
 */
export const DYNAMIC_SCOPE_PRESET_PREFIX = 'dynamic-';

/**
 * 判断一个 scopePresetId 是否是 resolveDynamicScopeSelection 合成的动态标记
 * （`dynamic-single` / `dynamic-group` / `dynamic-global`），而非资源目录里的真实
 * scopePreset。单一事实源——两条复验路径（session-actions.ts 的
 * assertSessionStillAuthorized、http-server.ts 的 assertCurrentMcpToolAndSession）
 * 都应引用这个判定，不要各自硬编码字符串字面量。
 */
export function isDynamicScopePresetId(scopePresetId: string | undefined): boolean {
  return typeof scopePresetId === 'string' && scopePresetId.startsWith(DYNAMIC_SCOPE_PRESET_PREFIX);
}

export interface ScopeGroupOption {
  dimension: 'productLine' | 'brand' | 'application';
  value: string;
  label: string;
  chipIds: string[];
  fileCount: number;
  tooLarge: boolean;
}

export interface ScopeChipOption {
  chipId: string;
  label: string;
  brand?: string;
  productLines: string[];
  fileCount: number;
}

export interface ScopeOptionsResponse {
  single: { chips: ScopeChipOption[] };
  group: { productLines: ScopeGroupOption[]; brands: ScopeGroupOption[]; applications: ScopeGroupOption[] };
  global: { chipIds: string[]; fileCount: number; tooLarge: boolean };
}

const ALLOWED_SCOPE_FILE = /\.(md|markdown|txt|json|csv|pdf)$/i;

/**
 * Recursively count datasheet-style files under a chip workspace.
 * Never throws: an unreadable / missing directory contributes 0.
 */
export async function countChipScopeFiles(cwd: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(cwd, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const childPath = path.join(cwd, entry.name);
    if (entry.isDirectory()) {
      total += await countChipScopeFiles(childPath);
    } else if (entry.isFile() && ALLOWED_SCOPE_FILE.test(entry.name)) {
      total += 1;
    }
  }
  return total;
}

/**
 * List catalog chip ids that pass the authorization predicate, preserving catalog order.
 */
export function listAuthorizedChipIds(catalog: ChipCatalog, isChipAuthorized: (chipId: string) => boolean): string[] {
  const authorized: string[] = [];
  for (const chip of catalog.chips) {
    if (isChipAuthorized(chip.id)) {
      authorized.push(chip.id);
    }
  }
  return authorized;
}

interface GroupAccumulator {
  dimension: 'productLine' | 'brand' | 'application';
  value: string;
  chipIds: string[];
}

/**
 * Build the option tree (single chips, product-line/brand groups, global) for the
 * range picker. Groups are derived ONLY from authorized chips, so a group surfaces
 * only when it contains at least one authorized chip.
 */
export function buildScopeOptions(args: {
  catalog: ChipCatalog;
  authorizedChipIds: string[];
  fileCountByChipId: Map<string, number>;
  threshold?: number;
}): ScopeOptionsResponse {
  const threshold = args.threshold ?? DEFAULT_SCOPE_OPTIONS_THRESHOLD;
  const authorizedSet = new Set(args.authorizedChipIds);
  const fileCountOf = (chipId: string): number => args.fileCountByChipId.get(chipId) ?? 0;

  // Only consider chips that are both in the catalog and authorized, keeping the
  // authorizedChipIds order as the canonical ordering.
  const chipById = new Map(args.catalog.chips.map((chip) => [chip.id, chip]));
  const authorizedChips: ChipConfig[] = [];
  for (const chipId of args.authorizedChipIds) {
    const chip = chipById.get(chipId);
    if (chip) {
      authorizedChips.push(chip);
    }
  }

  const single: ScopeChipOption[] = authorizedChips.map((chip) => ({
    chipId: chip.id,
    label: chip.label,
    ...(chip.brand ? { brand: chip.brand } : {}),
    productLines: chip.productLines ?? [],
    fileCount: fileCountOf(chip.id)
  }));

  const productLineGroups = new Map<string, GroupAccumulator>();
  const brandGroups = new Map<string, GroupAccumulator>();
  const applicationGroups = new Map<string, GroupAccumulator>();

  for (const chip of authorizedChips) {
    for (const productLine of chip.productLines ?? []) {
      const acc =
        productLineGroups.get(productLine) ??
        ({ dimension: 'productLine', value: productLine, chipIds: [] } satisfies GroupAccumulator);
      pushUnique(acc.chipIds, chip.id);
      productLineGroups.set(productLine, acc);
    }
    if (chip.brand) {
      const acc =
        brandGroups.get(chip.brand) ?? ({ dimension: 'brand', value: chip.brand, chipIds: [] } satisfies GroupAccumulator);
      pushUnique(acc.chipIds, chip.id);
      brandGroups.set(chip.brand, acc);
    }
    for (const tag of chip.applicationTags ?? []) {
      const acc =
        applicationGroups.get(tag) ??
        ({ dimension: 'application', value: tag, chipIds: [] } satisfies GroupAccumulator);
      pushUnique(acc.chipIds, chip.id);
      applicationGroups.set(tag, acc);
    }
  }

  const toGroupOption = (acc: GroupAccumulator): ScopeGroupOption => {
    const fileCount = acc.chipIds.reduce((sum, chipId) => sum + fileCountOf(chipId), 0);
    return {
      dimension: acc.dimension,
      value: acc.value,
      label: acc.value,
      chipIds: acc.chipIds,
      fileCount,
      tooLarge: fileCount > threshold
    };
  };

  const globalChipIds = args.authorizedChipIds.filter((chipId) => authorizedSet.has(chipId) && chipById.has(chipId));
  const globalFileCount = globalChipIds.reduce((sum, chipId) => sum + fileCountOf(chipId), 0);

  return {
    single: { chips: single },
    group: {
      productLines: [...productLineGroups.values()].map(toGroupOption),
      brands: [...brandGroups.values()].map(toGroupOption),
      applications: [...applicationGroups.values()].map(toGroupOption)
    },
    global: {
      chipIds: globalChipIds,
      fileCount: globalFileCount,
      tooLarge: globalFileCount > threshold
    }
  };
}

/**
 * Resolve a dynamic scope descriptor into a fully-formed ScopeSelectionAllowed.
 *
 * Zero-overreach invariant: the resolved chip set is always intersected with
 * authorizedChipIds, so `allowedChipIds ⊆ authorizedChipIds` holds unconditionally.
 * An empty intersection (or a single descriptor without chipId) is denied.
 */
export function resolveDynamicScopeSelection(args: {
  authorization: EffectiveAuthorizationSummary;
  catalog: ChipCatalog;
  /**
   * 资源目录（V14 单一事实源）：documents[].chipIds 是 chipId -> document 的权威来源。
   * 省略时降级为空目录——对没有目录文档挂载的芯片，query-runner 侧仍会回退到
   * chip.documentIds / 合成 chip-workspace id（兼容既有「无目录元数据」场景，见 query-runner.ts）。
   */
  resources?: ResourceVisibilityCatalog;
  authorizedChipIds: string[];
  descriptor: ScopeDescriptor;
  entryPoint?: ScopeResolverEntryPoint;
}): ScopeSelectionAllowed {
  const { authorization, catalog, descriptor } = args;
  const resources = args.resources ?? EMPTY_RESOURCE_CATALOG;
  const entryPoint = args.entryPoint ?? 'web';
  const authorizedSet = new Set(args.authorizedChipIds);

  // 1) Resolve the requested target chip set from the descriptor.
  const requestedChipIds = resolveRequestedChipIds(descriptor, catalog);

  // 2) Intersect with authorized chips, preserving authorizedChipIds order.
  const requestedSet = new Set(requestedChipIds);
  const allowedChipIds = args.authorizedChipIds.filter((chipId) => requestedSet.has(chipId) && authorizedSet.has(chipId));

  if (allowedChipIds.length === 0) {
    throw new ScopeSessionDeniedError('The requested scope is not available to this identity.');
  }

  // 3) 聚合文档 id（去重）：权威来源是 resources.documents[].chipIds（V14），
  // 不再直接读 chip.documentIds。对每篇候选文档跑 evaluateDocumentVisibility（V1），
  // 只保留已批准且对该用户可见的文档——未批准/不可见文档的文件由此被剔除，
  // 但不影响 chip 本身留在 allowedChipIds 内（只丢文档，不整体拒绝该 chip）。
  const allowedDocumentIds: string[] = [];
  for (const chipId of allowedChipIds) {
    for (const document of documentsForChip(resources, chipId)) {
      if (evaluateDocumentVisibility(authorization, document).allowed) {
        pushUnique(allowedDocumentIds, document.documentId);
      }
    }
  }

  const groups = descriptor.mode === 'group' ? descriptor.groups ?? [] : [];
  const groupBrands = uniqueStrings(
    groups.filter((group) => group.dimension === 'brand').map((group) => group.value)
  );
  const groupProductLines = uniqueStrings(
    groups.filter((group) => group.dimension === 'productLine').map((group) => group.value)
  );
  const groupApplications = uniqueStrings(
    groups.filter((group) => group.dimension === 'application').map((group) => group.value)
  );

  const filters: ScopeSelectionAllowed['filters'] = {
    brands: groupBrands,
    productLines: groupProductLines,
    applications: groupApplications,
    chipIds: allowedChipIds,
    documentIds: allowedDocumentIds
  };

  // application 仅是范围选择维度（在已授权芯片内再筛），不是授权维度：故不进 requiredGrants，
  // 零越权由上面 allowedChipIds ⊆ authorizedChipIds 的交集保证。
  const requiredGrants: ResourceGrantInput = {
    brands: groupBrands,
    productLines: groupProductLines,
    chipIds: allowedChipIds,
    documentIds: allowedDocumentIds,
    scopePresetIds: []
  };

  const requiredGrantCounts: ScopeRequiredGrantCounts = {
    brands: groupBrands.length,
    productLines: groupProductLines.length,
    chipIds: allowedChipIds.length,
    documentIds: allowedDocumentIds.length,
    scopePresetIds: 0
  };

  const scopePresetId = `dynamic-${descriptor.mode}`;
  const scopeId = createDynamicScopeId(descriptor, allowedChipIds, groupBrands, groupProductLines, groupApplications);

  return {
    status: 'allowed',
    scopeId,
    scopePresetId,
    filters,
    allowedChipIds,
    allowedDocumentIds,
    deniedReasons: [],
    requiredGrants,
    requiredGrantCounts,
    authorizationDecision: createAllowedAuthorizationDecision(authorization),
    workspaceModeCandidate: 'pendingWorkspace',
    audit: {
      entryPoint,
      userId: authorization.audit.userId,
      role: authorization.audit.role,
      ...(authorization.audit.keyFingerprint ? { keyFingerprint: authorization.audit.keyFingerprint } : {}),
      scopePresetId,
      reasonCode: 'allowed',
      requestedFilters: {
        ...(groupBrands.length === 1 ? { brand: groupBrands[0] } : {}),
        ...(groupProductLines.length === 1 ? { productLine: groupProductLines[0] } : {}),
        ...(groupApplications.length === 1 ? { application: groupApplications[0] } : {}),
        ...(descriptor.mode === 'single' && descriptor.chipId ? { chipId: descriptor.chipId } : {})
      },
      coveredChipCount: allowedChipIds.length,
      coveredDocumentCount: allowedDocumentIds.length,
      deniedCount: 0
    }
  };
}

function resolveRequestedChipIds(descriptor: ScopeDescriptor, catalog: ChipCatalog): string[] {
  switch (descriptor.mode) {
    case 'global':
      return catalog.chips.map((chip) => chip.id);
    case 'single':
      if (!descriptor.chipId) {
        throw new ScopeSessionDeniedError('A single-chip scope requires a chip id.');
      }
      return [descriptor.chipId];
    case 'group': {
      const matched: string[] = [];
      for (const chip of catalog.chips) {
        if (chipMatchesAnyGroup(chip, descriptor.groups ?? [])) {
          pushUnique(matched, chip.id);
        }
      }
      return matched;
    }
    default:
      return [];
  }
}

function chipMatchesAnyGroup(chip: ChipConfig, groups: NonNullable<ScopeDescriptor['groups']>): boolean {
  return groups.some((group) => {
    if (group.dimension === 'brand') return chip.brand === group.value;
    if (group.dimension === 'application') return (chip.applicationTags ?? []).includes(group.value);
    return (chip.productLines ?? []).includes(group.value);
  });
}

function createAllowedAuthorizationDecision(summary: EffectiveAuthorizationSummary): AuthorizationDecision {
  return {
    allowed: true,
    reasonCode: 'allowed',
    safeMessage: 'Scope is available to this identity.',
    audit: {
      ...summary.audit,
      resourceType: 'scopePreset',
      reasonCode: 'allowed'
    },
    matchedGrants: []
  };
}

function createDynamicScopeId(
  descriptor: ScopeDescriptor,
  allowedChipIds: string[],
  groupBrands: string[],
  groupProductLines: string[],
  groupApplications: string[]
): string {
  const tokens = descriptor.mode === 'group' ? [...groupBrands, ...groupProductLines, ...groupApplications].sort() : [...allowedChipIds].sort();
  const suffix = tokens
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return suffix ? `dynamic-${descriptor.mode}-${suffix}` : `dynamic-${descriptor.mode}`;
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  const unique: string[] = [];
  for (const value of values) {
    if (!unique.includes(value)) {
      unique.push(value);
    }
  }
  return unique;
}
