import type { ScopeSelectionAllowed } from './resolver.js';
import type { ResourceVisibilityCatalog } from '../security/index.js';

export interface ScopeShard {
  shardId: string;
  chipIds: string[];
  documentIds: string[];
  productLines: string[];
  applications: string[];
}

export function createScopeShards(
  selection: ScopeSelectionAllowed,
  resources?: ResourceVisibilityCatalog
): ScopeShard[] {
  const byChip = new Map<string, ScopeShard>();
  for (const chipId of selection.allowedChipIds) {
    byChip.set(chipId, {
      shardId: `chip:${chipId}`,
      chipIds: [chipId],
      documentIds: [],
      productLines: [...selection.filters.productLines],
      applications: [...selection.filters.applications]
    });
  }
  for (const documentId of selection.allowedDocumentIds) {
    // A document may belong to one or multiple chips. Only the resource
    // catalog is authoritative for that relationship; assigning every
    // document to the first selected chip fabricates per-chip evidence.
    const document = resources?.documents.find((candidate) => candidate.documentId === documentId);
    for (const chipId of document?.chipIds ?? []) {
      const shard = byChip.get(chipId);
      if (shard) {
        shard.documentIds.push(documentId);
      }
    }
  }
  return [...byChip.values()].map((shard) => ({
    ...shard,
    documentIds: [...new Set(shard.documentIds)]
  }));
}
