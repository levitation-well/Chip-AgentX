import { readFile } from 'node:fs/promises';
import { writeJsonAtomic } from '../persistence/json-file.js';
import {
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  normalizeDocumentVisibilityContract,
  normalizeScopePresetContract,
  toSafeDocumentSummary,
  toSafeScopePresetSummary,
  type DocumentVisibilityContract,
  type ResourceReviewAudit,
  type SafeResourceVisibilitySummary,
  type ScopePresetContract
} from './document-visibility.js';
import type { EffectiveAuthorizationSummary } from './types.js';

export interface ResourceVisibilityCatalog {
  documents: DocumentVisibilityContract[];
  scopePresets: ScopePresetContract[];
}

export interface ResourceVisibilityCatalogInput {
  documents?: unknown[];
  scopePresets?: unknown[];
}

export function parseResourceVisibilityCatalog(input: unknown): ResourceVisibilityCatalog {
  const record = isRecord(input) ? input : {};
  const documents = Array.isArray(record.documents) ? record.documents.map(normalizeDocumentVisibilityContract) : [];
  const scopePresets = Array.isArray(record.scopePresets) ? record.scopePresets.map(normalizeScopePresetContract) : [];
  return {
    documents: dedupeBy(documents, (document) => document.documentId),
    scopePresets: dedupeBy(scopePresets, (scopePreset) => scopePreset.scopePresetId)
  };
}

export async function loadResourceVisibilityCatalogFromFile(configFile: string): Promise<ResourceVisibilityCatalog> {
  return parseResourceVisibilityCatalog(JSON.parse(await readFile(configFile, 'utf8')) as unknown);
}

/**
 * Produce the on-disk JSON shape for a catalog (documents + scopePresets incl. audit fields).
 * Round-trips with parseResourceVisibilityCatalog: parse(serialize(x)) deep-equals x.
 * Optional audit fields are emitted only when present so the on-disk shape stays stable.
 */
export function serializeResourceVisibilityCatalog(catalog: ResourceVisibilityCatalog): {
  documents: Array<Record<string, unknown>>;
  scopePresets: Array<Record<string, unknown>>;
} {
  return {
    documents: catalog.documents.map((document) => ({
      documentId: document.documentId,
      label: document.label,
      visibility: document.visibility,
      status: document.status,
      brands: [...document.brands],
      productLines: [...document.productLines],
      applicationTags: [...document.applicationTags],
      chipIds: [...document.chipIds],
      requiredGrants: serializeRequiredGrants(document.requiredGrants),
      sourceLabels: [...document.sourceLabels],
      ...serializeReviewAudit(document)
    })),
    scopePresets: catalog.scopePresets.map((scopePreset) => ({
      scopePresetId: scopePreset.scopePresetId,
      label: scopePreset.label,
      visibility: scopePreset.visibility,
      status: scopePreset.status,
      brands: [...scopePreset.brands],
      productLines: [...scopePreset.productLines],
      applicationTags: [...scopePreset.applicationTags],
      chipIds: [...scopePreset.chipIds],
      documentIds: [...scopePreset.documentIds],
      requiredGrants: serializeRequiredGrants(scopePreset.requiredGrants),
      sourceLabels: [...scopePreset.sourceLabels],
      ...serializeReviewAudit(scopePreset)
    }))
  };
}

/**
 * Persist a catalog to disk via the shared atomic write helper. Always pair with an
 * in-memory catalog update at the call site; only invoke this when a configFile is configured.
 */
export async function writeResourceVisibilityCatalogToFile(
  configFile: string,
  catalog: ResourceVisibilityCatalog
): Promise<void> {
  await writeJsonAtomic(configFile, serializeResourceVisibilityCatalog(catalog));
}

function serializeReviewAudit(audit: ResourceReviewAudit): Record<string, string> {
  const serialized: Record<string, string> = {};
  if (audit.requestedBy !== undefined) {
    serialized.requestedBy = audit.requestedBy;
  }
  if (audit.requestedAt !== undefined) {
    serialized.requestedAt = audit.requestedAt;
  }
  if (audit.approvedBy !== undefined) {
    serialized.approvedBy = audit.approvedBy;
  }
  if (audit.approvedAt !== undefined) {
    serialized.approvedAt = audit.approvedAt;
  }
  if (audit.approvalNotes !== undefined) {
    serialized.approvalNotes = audit.approvalNotes;
  }
  return serialized;
}

function serializeRequiredGrants(grants: DocumentVisibilityContract['requiredGrants']): Record<string, unknown> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(grants)) {
    if (Array.isArray(value) && value.length > 0) {
      serialized[key] = [...value];
    }
  }
  return serialized;
}

export function findDocumentContract(
  catalog: ResourceVisibilityCatalog | null | undefined,
  documentId: string
): DocumentVisibilityContract | undefined {
  return catalog?.documents.find((document) => document.documentId === documentId);
}

export function findScopePresetContract(
  catalog: ResourceVisibilityCatalog | null | undefined,
  scopePresetId: string
): ScopePresetContract | undefined {
  return catalog?.scopePresets.find((scopePreset) => scopePreset.scopePresetId === scopePresetId);
}

/**
 * V3 芯片删除级联清理：从目录里每篇 document/scopePreset 的 chipIds 引用中剔除已删除的 chip id
 * （其它字段，含 documentIds/requiredGrants，不受影响）。返回被剔除引用的条目数（用于并入调用方
 * 的聚合计数）与是否发生变化，供调用方判断是否需要落盘。纯函数，不做 I/O。
 */
export function removeChipIdsFromResourceCatalog(
  catalog: ResourceVisibilityCatalog,
  deletedChipIds: readonly string[]
): { catalog: ResourceVisibilityCatalog; affectedEntries: number } {
  if (deletedChipIds.length === 0) {
    return { catalog, affectedEntries: 0 };
  }
  const deleted = new Set(deletedChipIds);
  let affectedEntries = 0;

  const documents = catalog.documents.map((document) => {
    if (!document.chipIds.some((chipId) => deleted.has(chipId))) {
      return document;
    }
    affectedEntries += 1;
    return { ...document, chipIds: document.chipIds.filter((chipId) => !deleted.has(chipId)) };
  });

  const scopePresets = catalog.scopePresets.map((scopePreset) => {
    if (!scopePreset.chipIds.some((chipId) => deleted.has(chipId))) {
      return scopePreset;
    }
    affectedEntries += 1;
    return { ...scopePreset, chipIds: scopePreset.chipIds.filter((chipId) => !deleted.has(chipId)) };
  });

  return { catalog: { documents, scopePresets }, affectedEntries };
}

export function listVisibleResourceSummaries(
  catalog: ResourceVisibilityCatalog | null | undefined,
  summary: EffectiveAuthorizationSummary
): SafeResourceVisibilitySummary[] {
  if (!catalog || !summary.usable) {
    return [];
  }
  const documents = catalog.documents
    .filter((document) => evaluateDocumentVisibility(summary, document).allowed)
    .map(toSafeDocumentSummary);
  const scopePresets = catalog.scopePresets
    .filter((scopePreset) => evaluateScopePresetVisibility(summary, scopePreset).allowed)
    .map(toSafeScopePresetSummary);
  return [...documents, ...scopePresets];
}

function dedupeBy<T>(items: T[], getId: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(item);
  }
  return deduped;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
