import { describe, expect, it } from 'vitest';
import { computeEffectiveAuthorizationSummary } from '../src/security/index.js';
import { parseScopeCatalogFoundation, resolveScopeSelection } from '../src/scope/index.js';

function makeCatalog() {
  return parseScopeCatalogFoundation({
    chips: [
      {
        id: 'E522.94',
        label: 'E522.94',
        brand: 'ELMOS',
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        documentIds: ['doc-e52294-datasheet'],
        sourceLabels: ['E522.94 datasheet'],
        workspaceDir: 'D:\\private\\kb\\E522.94'
      },
      {
        id: 'E522.96',
        label: 'E522.96',
        brand: 'ELMOS',
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        documentIds: ['doc-e52296-datasheet'],
        sourceLabels: ['E522.96 datasheet'],
        workspaceDir: 'D:\\private\\kb\\E522.96'
      },
      {
        id: 'E521.39',
        label: 'E521.39',
        brand: 'ELMOS',
        productLines: ['ELMOS Motor'],
        applicationTags: ['Motor control'],
        documentIds: ['doc-e52139-datasheet'],
        sourceLabels: ['E521.39 datasheet'],
        workspaceDir: 'E521.39'
      }
    ],
    documents: [
      {
        documentId: 'doc-e52294-datasheet',
        label: 'E522.94 Datasheet',
        visibility: 'customer',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94'],
        sourceLabels: ['datasheet']
      },
      {
        documentId: 'doc-e52296-datasheet',
        label: 'E522.96 Datasheet',
        visibility: 'customer',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.96'],
        sourceLabels: ['datasheet']
      },
      {
        documentId: 'doc-internal-note',
        label: 'Internal Lighting Note',
        visibility: 'internal',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94'],
        sourceLabels: ['internal note']
      }
    ],
    scopePresets: [
      {
        scopePresetId: 'scope-preset-elmos-lighting',
        label: 'ELMOS Lighting',
        visibility: 'customer',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94', 'E522.96'],
        documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet'],
        requiredGrants: {
          scopePresetIds: ['scope-preset-elmos-lighting'],
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting']
        },
        workspaceDir: 'D:\\private\\scope-workspace'
      },
      {
        scopePresetId: 'scope-preset-elmos-internal-lighting',
        label: 'ELMOS Internal Lighting',
        visibility: 'internal',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94'],
        documentIds: ['doc-e52294-datasheet', 'doc-internal-note'],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-internal-lighting'] }
      },
      {
        scopePresetId: 'scope-preset-elmos-pending',
        label: 'Pending Lighting',
        visibility: 'customer',
        status: 'pending',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94'],
        documentIds: ['doc-e52294-datasheet'],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-pending'] }
      },
      {
        scopePresetId: 'scope-preset-elmos-disabled',
        label: 'Disabled Lighting',
        visibility: 'customer',
        status: 'disabled',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94'],
        documentIds: ['doc-e52294-datasheet'],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-disabled'] }
      }
    ]
  });
}

describe('scope resolver shared authorization gate', () => {
  it('allows customer, internal, and admin identities only after full preset coverage is authorized', () => {
    const catalog = makeCatalog();
    const customer = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-1',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94', 'E522.96'],
          documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });
    const internal = computeEffectiveAuthorizationSummary({
      user: {
        id: 'internal-1',
        role: 'internal',
        grants: {
          chipIds: ['E522.94'],
          documentIds: ['doc-internal-note'],
          scopePresetIds: ['scope-preset-elmos-internal-lighting']
        }
      }
    });
    const admin = computeEffectiveAuthorizationSummary({ user: { id: 'admin-1', role: 'admin' } });

    expect(
      resolveScopeSelection({ authorization: customer, catalog, scopePresetId: 'scope-preset-elmos-lighting' })
    ).toMatchObject({
      status: 'allowed',
      allowedChipIds: ['E522.94', 'E522.96'],
      allowedDocumentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet'],
      workspaceModeCandidate: 'pendingWorkspace'
    });
    expect(
      resolveScopeSelection({ authorization: internal, catalog, scopePresetId: 'scope-preset-elmos-internal-lighting' })
    ).toMatchObject({
      status: 'allowed',
      allowedDocumentIds: ['doc-e52294-datasheet', 'doc-internal-note']
    });
    expect(
      resolveScopeSelection({ authorization: admin, catalog, scopePresetId: 'scope-preset-elmos-internal-lighting' })
    ).toMatchObject({ status: 'allowed' });
  });

  it('denies partial document grants instead of silently trimming a preset', () => {
    const catalog = makeCatalog();
    const partial = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-2',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94', 'E522.96'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });
    const selection = resolveScopeSelection({
      authorization: partial,
      catalog,
      scopePresetId: 'scope-preset-elmos-lighting'
    });
    const serialized = JSON.stringify(selection);

    expect(selection).toMatchObject({
      status: 'denied',
      allowedChipIds: [],
      allowedDocumentIds: [],
      workspaceModeCandidate: 'none',
      deniedReasons: [expect.objectContaining({ category: 'covered_document_denied', count: 1 })],
      requiredGrantCounts: expect.objectContaining({ documentIds: 2 })
    });
    expect(serialized).not.toContain('doc-e52296-datasheet');
    expect(serialized).not.toContain('E522.96 Datasheet');
  });

  it('honors MCP key grant narrowing before scope selection is allowed', () => {
    const catalog = makeCatalog();
    const narrowed = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-3',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94', 'E522.96'],
          documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      },
      key: {
        id: 'key-1',
        fingerprint: 'fakefingerprint',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    expect(
      resolveScopeSelection({ authorization: narrowed, catalog, scopePresetId: 'scope-preset-elmos-lighting', entryPoint: 'mcp' })
    ).toMatchObject({
      status: 'denied',
      deniedReasons: [expect.objectContaining({ category: 'covered_chip_denied', resourceType: 'chip' })],
      audit: expect.objectContaining({ keyFingerprint: 'fakefingerprint' })
    });
  });

  it('safely rejects unknown, pending, and disabled presets', () => {
    const catalog = makeCatalog();
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-4',
        role: 'customer',
        grants: {
          chipIds: ['E522.94'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-pending', 'scope-preset-elmos-disabled']
        }
      }
    });

    expect(resolveScopeSelection({ authorization: summary, catalog, scopePresetId: 'missing-preset' })).toMatchObject({
      status: 'denied',
      deniedReasons: [expect.objectContaining({ category: 'unknown_preset' })]
    });
    expect(resolveScopeSelection({ authorization: summary, catalog, scopePresetId: 'scope-preset-elmos-pending' })).toMatchObject({
      status: 'denied',
      deniedReasons: [expect.objectContaining({ category: 'preset_not_approved' })]
    });
    expect(resolveScopeSelection({ authorization: summary, catalog, scopePresetId: 'scope-preset-elmos-disabled' })).toMatchObject({
      status: 'denied',
      deniedReasons: [expect.objectContaining({ category: 'preset_not_approved' })]
    });
  });

  it('does not widen preset scope from brand/productLine/application/chip/document filters', () => {
    const catalog = makeCatalog();
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-5',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94', 'E522.96', 'E521.39'],
          documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet', 'doc-e52139-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    expect(
      resolveScopeSelection({
        authorization: summary,
        catalog,
        scopePresetId: 'scope-preset-elmos-lighting',
        productLine: 'ELMOS Motor'
      })
    ).toMatchObject({
      status: 'denied',
      deniedReasons: [expect.objectContaining({ category: 'filter_out_of_preset' })]
    });
  });

  it('keeps resolver DTOs compatible with Wave 1 metadata and free of server/workspace paths', () => {
    const catalog = makeCatalog();
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-6',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94', 'E522.96'],
          documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });
    const selection = resolveScopeSelection({
      authorization: summary,
      catalog,
      scopePresetId: 'scope-preset-elmos-lighting',
      brand: 'ELMOS',
      productLine: 'ELMOS Lighting',
      application: 'Automotive lighting',
      chipId: 'E522.94',
      documentId: 'doc-e52294-datasheet'
    });
    const serialized = JSON.stringify(selection);

    expect(selection).toMatchObject({
      status: 'allowed',
      filters: expect.objectContaining({
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applications: ['Automotive lighting']
      }),
      requiredGrants: expect.objectContaining({
        scopePresetIds: ['scope-preset-elmos-lighting'],
        chipIds: ['E522.94', 'E522.96'],
        documentIds: ['doc-e52294-datasheet', 'doc-e52296-datasheet']
      })
    });
    expect(serialized).not.toMatch(/workspaceDir|knowledgeBaseRoot|serverPath|D:\\private|E:\\Elmos|\/srv|\/opt/i);
  });
});
