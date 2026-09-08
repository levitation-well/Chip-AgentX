import { describe, expect, it } from 'vitest';
import { createScopeShards } from '../src/scope/index.js';
import type { ScopeSelectionAllowed } from '../src/scope/index.js';

describe('scope sharding contract', () => {
  it('creates safe shard metadata without workspace paths', () => {
    const shards = createScopeShards(makeSelection(), {
      documents: [
        { documentId: 'doc-a', label: 'A', status: 'approved', visibility: 'authenticated', chipIds: ['E522.94'] },
        { documentId: 'doc-b', label: 'B', status: 'approved', visibility: 'authenticated', chipIds: ['E522.96'] }
      ],
      scopePresets: []
    });
    const serialized = JSON.stringify(shards);

    expect(shards).toEqual([
      expect.objectContaining({
        shardId: 'chip:E522.94',
        chipIds: ['E522.94'],
        documentIds: ['doc-a'],
        productLines: ['ELMOS Lighting'],
        applications: ['Automotive lighting']
      }),
      expect.objectContaining({
        shardId: 'chip:E522.96',
        chipIds: ['E522.96'],
        documentIds: ['doc-b']
      })
    ]);
    expect(serialized).not.toMatch(/workspacePath|sourcePath|internalManifestPath|knowledgeBaseRoot|D:\\|\/srv|\/tmp/i);
  });

  it('does not invent document-to-chip assignments without the authoritative catalog', () => {
    expect(createScopeShards(makeSelection()).map((shard) => shard.documentIds)).toEqual([[], []]);
  });
});

function makeSelection(): ScopeSelectionAllowed {
  return {
    status: 'allowed',
    scopeId: 'scope-preset-elmos-lighting:elmos-lighting',
    scopePresetId: 'scope-preset-elmos-lighting',
    filters: {
      brands: ['ELMOS'],
      productLines: ['ELMOS Lighting'],
      applications: ['Automotive lighting'],
      chipIds: ['E522.94', 'E522.96'],
      documentIds: ['doc-a', 'doc-b']
    },
    allowedChipIds: ['E522.94', 'E522.96'],
    allowedDocumentIds: ['doc-a', 'doc-b'],
    deniedReasons: [],
    requiredGrants: {},
    requiredGrantCounts: { brands: 1, productLines: 1, chipIds: 2, documentIds: 2, scopePresetIds: 1 },
    authorizationDecision: {
      allowed: true,
      reasonCode: 'allowed',
      safeMessage: 'Allowed.',
      audit: { userId: 'u1', role: 'customer', resourceType: 'scopePreset', reasonCode: 'allowed' },
      matchedGrants: ['scope-preset-elmos-lighting']
    },
    workspaceModeCandidate: 'pendingWorkspace',
    audit: {
      entryPoint: 'test',
      userId: 'u1',
      role: 'customer',
      scopePresetId: 'scope-preset-elmos-lighting',
      reasonCode: 'allowed',
      requestedFilters: {},
      coveredChipCount: 2,
      coveredDocumentCount: 2,
      deniedCount: 0
    }
  };
}
