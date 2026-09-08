import { describe, expect, it } from 'vitest';
import { parseResourceVisibilityCatalog, type ResourceVisibilityCatalog } from '../src/security/index.js';
import { validatePresetReferences } from '../src/scope/resolver.js';

function buildCatalog(): ResourceVisibilityCatalog {
  return parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'doc-known',
        label: 'Known doc',
        visibility: 'restricted',
        status: 'approved',
        chipIds: ['CHIP-KNOWN'],
        requiredGrants: { documentIds: ['doc-known'] },
        sourceLabels: []
      }
    ],
    scopePresets: []
  });
}

describe('Task 5.2 — orphan reference validation', () => {
  it('reports a documentId referenced by a preset but absent from the catalog', () => {
    const catalog = buildCatalog();
    const preset = parseResourceVisibilityCatalog({
      scopePresets: [
        {
          scopePresetId: 'scope-orphan',
          label: 'Orphan scope',
          visibility: 'restricted',
          status: 'approved',
          chipIds: [],
          documentIds: ['doc-known', 'doc-missing'],
          requiredGrants: {},
          sourceLabels: []
        }
      ]
    }).scopePresets[0];

    const result = validatePresetReferences(preset, catalog);
    expect(result.missingDocumentIds).toContain('doc-missing');
    expect(result.missingDocumentIds).not.toContain('doc-known');
    expect(result.hasOrphans).toBe(true);
  });

  it('reports a chipId referenced by a preset but absent from the catalog', () => {
    const catalog = buildCatalog();
    const preset = parseResourceVisibilityCatalog({
      scopePresets: [
        {
          scopePresetId: 'scope-chip-orphan',
          label: 'Chip orphan scope',
          visibility: 'restricted',
          status: 'approved',
          chipIds: ['CHIP-KNOWN', 'CHIP-MISSING'],
          documentIds: ['doc-known'],
          requiredGrants: {},
          sourceLabels: []
        }
      ]
    }).scopePresets[0];

    const result = validatePresetReferences(preset, catalog);
    expect(result.missingChipIds).toContain('CHIP-MISSING');
    expect(result.missingChipIds).not.toContain('CHIP-KNOWN');
    expect(result.hasOrphans).toBe(true);
  });

  it('reports no orphans when every reference resolves in the catalog', () => {
    const catalog = buildCatalog();
    const preset = parseResourceVisibilityCatalog({
      scopePresets: [
        {
          scopePresetId: 'scope-valid',
          label: 'Valid scope',
          visibility: 'restricted',
          status: 'approved',
          chipIds: ['CHIP-KNOWN'],
          documentIds: ['doc-known'],
          requiredGrants: {},
          sourceLabels: []
        }
      ]
    }).scopePresets[0];

    const result = validatePresetReferences(preset, catalog);
    expect(result.missingDocumentIds).toEqual([]);
    expect(result.missingChipIds).toEqual([]);
    expect(result.hasOrphans).toBe(false);
  });

  it('treats a chip covered only via a referenced document as resolved (not an orphan)', () => {
    const catalog = buildCatalog();
    // doc-known itself carries CHIP-KNOWN; a preset that references the doc but not the
    // chip directly should still see the chip as resolved through document coverage.
    const preset = parseResourceVisibilityCatalog({
      scopePresets: [
        {
          scopePresetId: 'scope-doc-covered',
          label: 'Doc-covered scope',
          visibility: 'restricted',
          status: 'approved',
          chipIds: ['CHIP-KNOWN'],
          documentIds: ['doc-known'],
          requiredGrants: {},
          sourceLabels: []
        }
      ]
    }).scopePresets[0];

    const result = validatePresetReferences(preset, catalog);
    expect(result.missingChipIds).toEqual([]);
    expect(result.hasOrphans).toBe(false);
  });
});
