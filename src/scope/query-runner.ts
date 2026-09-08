import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ChipCatalog } from '../chips/index.js';
import { resolveChipWorkspace } from '../chips/index.js';
import type { EffectiveAuthorizationSummary, ResourceVisibilityCatalog } from '../security/index.js';
import { parseScopeCatalogFoundation } from './catalog.js';
import { documentsForChip, filterWholeWorkspaceAuthorizedChipIds } from './document-chip-map.js';
import { resolveScopeSelection, type ScopeResolverEntryPoint, type ScopeSelectionAllowed } from './resolver.js';
import { cleanupScopeWorkspace } from './workspace-cleanup.js';
import { materializeScopeWorkspace, type ScopeSourceFileManifest, type ScopeWorkspaceMaterialization } from './workspace.js';
import { buildSafeScopeSessionSummary, type SafeScopeSessionSummary } from './answer-contract.js';
import { resolveDynamicScopeSelection, type ScopeDescriptor } from './scope-options.js';
import { ScopeSessionDeniedError } from './scale.js';

export interface PrepareScopeSessionInput {
  authorization: EffectiveAuthorizationSummary;
  chips: ChipCatalog;
  resources: ResourceVisibilityCatalog;
  dataDir: string;
  scopePresetId?: string;
  documentId?: string;
  entryPoint: 'web' | 'rpc' | 'mcp' | 'admin' | 'test';
}

export interface PreparedScopeSession {
  cwd: string;
  scopePresetId: string;
  documentId?: string;
  workspace: ScopeWorkspaceMaterialization;
  safeSummary: SafeScopeSessionSummary;
  cleanup: () => Promise<void>;
  /**
   * 这条会话在 spawn 时实际被授权访问的 chip 集合（resolveScopeSelection /
   * resolveDynamicScopeSelection 解析出的 allowedChipIds ⊆ authorizedChipIds）。
   *
   * 对预设/单档路径（scopePresetId 是目录里的真实预设，或缺省单芯片），这个字段
   * 主要是审计/复验的补充信息。对动态 scope（scopePresetId 形如 dynamic-group /
   * dynamic-global，见 isDynamicScopePresetId）而言，这是唯一记录"这条会话到底
   * 覆盖了哪些 chip"的地方——目录里查不到 dynamic-* 这种合成 id，所以撤权复验
   * 必须逐个 chip 核对这里的列表，而不是去查目录契约。
   */
  allowedChipIds: string[];
  /** Documents whose physical files were authorized when this workspace was materialized. */
  allowedDocumentIds: string[];
}

export async function prepareScopeSession(input: PrepareScopeSessionInput): Promise<PreparedScopeSession | undefined> {
  if (!input.scopePresetId) {
    return undefined;
  }
  const catalog = parseScopeCatalogFoundation({
    chips: input.chips.chips,
    documents: input.resources.documents,
    scopePresets: input.resources.scopePresets
  });
  const selection = resolveScopeSelection({
    authorization: input.authorization,
    catalog,
    scopePresetId: input.scopePresetId,
    documentId: input.documentId,
    entryPoint: input.entryPoint === 'rpc' ? 'web' : input.entryPoint
  });
  if (selection.status === 'denied') {
    throw new ScopeSessionDeniedError(selection.deniedReasons[0]?.safeMessage ?? 'The requested resource is not available to this identity.');
  }

  return materializeScopeSelection(selection, input.chips, input.resources, input.dataDir, input.documentId);
}

export interface PrepareDynamicScopeSessionInput {
  authorization: EffectiveAuthorizationSummary;
  chips: ChipCatalog;
  resources: ResourceVisibilityCatalog;
  dataDir: string;
  authorizedChipIds: string[];
  descriptor: ScopeDescriptor;
  entryPoint?: ScopeResolverEntryPoint;
}

/**
 * 动态范围（preset-less）物化入口。
 *
 * - descriptor.mode 为 'single' 或缺省 → 返回 undefined（单芯片走原 chip 路径，不在此接管）。
 * - mode 为 'group' | 'global' → 调用 resolveDynamicScopeSelection 解析授权交集，
 *   再复用 materializeScopeSelection 物化到隔离副本。
 * - 越权 / 空交集会由 resolveDynamicScopeSelection throw ScopeSessionDeniedError（不吞），
 *   让上层转 403。
 */
export async function prepareDynamicScopeSession(
  input: PrepareDynamicScopeSessionInput
): Promise<PreparedScopeSession | undefined> {
  if (input.descriptor.mode !== 'group' && input.descriptor.mode !== 'global') {
    return undefined;
  }

  const selection = resolveDynamicScopeSelection({
    authorization: input.authorization,
    catalog: input.chips,
    resources: input.resources,
    authorizedChipIds: input.authorizedChipIds,
    descriptor: input.descriptor,
    entryPoint: input.entryPoint
  });

  return materializeScopeSelection(selection, input.chips, input.resources, input.dataDir);
}

/**
 * 私有物化核心：buildScopeSourceManifest → materializeScopeWorkspace
 * → buildSafeScopeSessionSummary → PreparedScopeSession。
 *
 * prepareScopeSession 和 prepareDynamicScopeSession 共用此段逻辑。
 */
async function materializeScopeSelection(
  selection: ScopeSelectionAllowed,
  chips: ChipCatalog,
  resources: ResourceVisibilityCatalog,
  dataDir: string,
  documentId?: string
): Promise<PreparedScopeSession> {
  const allowedChipIds = filterWholeWorkspaceAuthorizedChipIds(
    resources,
    selection.allowedChipIds,
    selection.allowedDocumentIds
  );
  if (allowedChipIds.length === 0) {
    throw new ScopeSessionDeniedError('The requested resource is not available to this identity.');
  }
  const allowedChipSet = new Set(allowedChipIds);
  const allowedDocumentIds = selection.allowedDocumentIds.filter((documentId) =>
    resources.documents.some(
      (document) => document.documentId === documentId && document.chipIds.some((chipId) => allowedChipSet.has(chipId))
    )
  );
  const materializedSelection: ScopeSelectionAllowed = {
    ...selection,
    allowedChipIds,
    allowedDocumentIds
  };
  const manifest = await buildScopeSourceManifest(chips, resources, materializedSelection);
  // The physical catalog has no document-to-file mapping. Multi-document and
  // uncataloged chips therefore use an honest chip-workspace source id. The
  // authorization decision above remains based on the real document ids.
  const copySelection: ScopeSelectionAllowed = {
    ...materializedSelection,
    allowedDocumentIds: [...new Set(manifest.files.map((file) => file.documentId))]
  };
  const workspace = await materializeScopeWorkspace(copySelection, manifest, {
    dataDir,
    preferLinkMode: false
  });
  const safeSummary = buildSafeScopeSessionSummary({
    selection: materializedSelection,
    workspace: workspace.safeDto,
    usedSources: workspace.usedSources,
    resources
  });
  return {
    cwd: workspace.workspacePath,
    scopePresetId: selection.scopePresetId,
    ...(documentId ? { documentId } : {}),
    workspace,
    safeSummary,
    cleanup: () => cleanupScopeWorkspace({ dataDir, workspaceId: workspace.workspaceId }).then(() => undefined),
    allowedChipIds: [...allowedChipIds],
    allowedDocumentIds: [...allowedDocumentIds]
  };
}

export { ScopeSessionDeniedError };

async function buildScopeSourceManifest(
  chips: ChipCatalog,
  resources: ResourceVisibilityCatalog,
  selection: ScopeSelectionAllowed
): Promise<ScopeSourceFileManifest> {
  const roots = await Promise.all(selection.allowedChipIds.map((chipId) => resolveChipWorkspace(chips, chipId)));
  const commonRoot = getCommonRoot(roots.map((root) => root.cwd));
  const files: ScopeSourceFileManifest['files'] = [];
  for (const root of roots) {
    const documents = documentsForChip(resources, root.chipId);
    const singleDocument = documents.length === 1 ? documents[0] : undefined;
    const sourceId = singleDocument?.documentId ?? `chip-${root.chipId}-workspace`;
    const relativeFiles = await listScopeFiles(root.cwd);
    for (const relativeFile of relativeFiles) {
      const filename = path.basename(relativeFile);
      files.push({
        documentId: sourceId,
        label: `${singleDocument?.label ?? root.chipId} ${filename}`,
        chipId: root.chipId,
        displayTitle: singleDocument?.label ?? `${root.chipId} workspace`,
        sourceLabel: singleDocument?.sourceLabels[0],
        sourceType: singleDocument ? 'catalog_document' : 'chip_workspace',
        visibility: singleDocument?.visibility,
        filename,
        relativePath: path.join(path.relative(commonRoot, root.cwd), relativeFile)
      });
    }
  }
  return { sourceRoot: commonRoot, files };
}

const MAX_LIST_SCOPE_FILES = 200;

async function listScopeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  await walk(root, '', found);
  return found.slice(0, MAX_LIST_SCOPE_FILES);
}

async function walk(root: string, relativeDir: string, found: string[]): Promise<void> {
  if (found.length >= MAX_LIST_SCOPE_FILES) {
    return;
  }
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, relativePath, found);
    } else if (entry.isFile() && isAllowedScopeFile(entry.name)) {
      found.push(relativePath);
    }
  }
}

function isAllowedScopeFile(fileName: string): boolean {
  return /\.(md|markdown|txt|json|csv|pdf)$/i.test(fileName);
}

function getCommonRoot(paths: string[]): string {
  if (paths.length === 0) {
    throw new Error('scope selection did not resolve any source workspaces');
  }
  const [first, ...rest] = paths.map((value) => path.resolve(value));
  let common = first;
  for (const candidate of rest) {
    while (common && !isInsideOrEqual(candidate, common)) {
      const parent = path.dirname(common);
      if (parent === common) {
        return parent;
      }
      common = parent;
    }
  }
  return common;
}

function isInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
