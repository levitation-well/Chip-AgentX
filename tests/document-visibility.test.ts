import { describe, expect, it } from 'vitest';
import {
  authorizeResourceAccess,
  computeEffectiveAuthorizationSummary,
  evaluateDocumentVisibility,
  evaluateScopePresetVisibility,
  listVisibleResourceSummaries,
  normalizeDocumentVisibilityContract,
  normalizeScopePresetContract,
  parseResourceVisibilityCatalog,
  toSafeDocumentSummary
} from '../src/security/index.js';

describe('document visibility and scope preset contract', () => {
  it('defaults documents to restricted visibility and exposes only safe summary fields', () => {
    const document = normalizeDocumentVisibilityContract({
      documentId: 'doc-e52295',
      title: 'E522.95 Datasheet',
      sourceLabels: ['datasheet', 'D:\\private\\kb\\E522.95.pdf'],
      serverPath: 'D:\\private\\kb\\E522.95.pdf',
      workspaceDir: 'D:\\private\\workspace'
    });

    expect(document.visibility).toBe('restricted');
    expect(document.requiredGrants).toMatchObject({ documentIds: ['doc-e52295'] });
    const safe = toSafeDocumentSummary(document);
    const serialized = JSON.stringify(safe);

    expect(safe).toEqual({
      type: 'document',
      id: 'doc-e52295',
      label: 'E522.95 Datasheet',
      visibility: 'restricted',
      brands: [],
      productLines: [],
      applicationTags: [],
      chipIds: [],
      sourceLabels: ['datasheet']
    });
    expect(serialized).not.toMatch(/serverPath|workspaceDir|D:\\private|E522\.95\.pdf/);
  });

  it('enforces visibility ceilings separately from explicit document grants', () => {
    const restrictedDoc = normalizeDocumentVisibilityContract({
      documentId: 'doc-restricted',
      visibility: 'restricted'
    });
    const internalDoc = normalizeDocumentVisibilityContract({
      documentId: 'doc-internal',
      visibility: 'internal'
    });
    const customer = computeEffectiveAuthorizationSummary({
      user: { id: 'customer-1', role: 'customer', grants: { documentIds: ['doc-restricted', 'doc-internal'] } }
    });
    const internal = computeEffectiveAuthorizationSummary({
      user: { id: 'internal-1', role: 'internal', grants: { documentIds: ['doc-internal'] } }
    });

    expect(evaluateDocumentVisibility(customer, restrictedDoc)).toMatchObject({
      allowed: false,
      reasonCode: 'visibility_denied'
    });
    expect(evaluateDocumentVisibility(customer, internalDoc)).toMatchObject({
      allowed: false,
      reasonCode: 'visibility_denied'
    });
    expect(evaluateDocumentVisibility(internal, internalDoc)).toMatchObject({ allowed: true });
  });

  it('requires explicit document and scope preset grants, with unknown ids safely denied', () => {
    const document = normalizeDocumentVisibilityContract({ documentId: 'doc-allowed', visibility: 'customer' });
    const scopePreset = normalizeScopePresetContract({ scopePresetId: 'lighting', visibility: 'customer' });
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-1',
        role: 'customer',
        grants: { documentIds: ['doc-allowed'], scopePresetIds: ['lighting'] }
      }
    });
    const denied = computeEffectiveAuthorizationSummary({
      user: { id: 'customer-2', role: 'customer', grants: { documentIds: ['other-doc'], scopePresetIds: ['other-scope'] } }
    });

    expect(evaluateDocumentVisibility(summary, document)).toMatchObject({ allowed: true });
    expect(evaluateScopePresetVisibility(summary, scopePreset)).toMatchObject({ allowed: true });
    expect(evaluateDocumentVisibility(denied, document)).toMatchObject({
      allowed: false,
      reasonCode: 'resource_not_granted'
    });
    expect(authorizeResourceAccess(denied, { type: 'document', id: 'unknown-doc', visibility: 'adminOnly' })).toMatchObject({
      allowed: false,
      reasonCode: 'visibility_denied',
      safeMessage: 'The requested resource is not available to this identity.'
    });
  });

  it('filters Account/Access Center summaries to approved visible resources only', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'public-doc', label: 'Public brief', visibility: 'public', status: 'approved' },
        { documentId: 'pending-doc', label: 'Pending restricted doc', visibility: 'customer', status: 'pending' },
        { documentId: 'customer-doc', label: 'Customer doc', visibility: 'customer', status: 'approved' }
      ],
      scopePresets: [
        { scopePresetId: 'lighting', label: 'Lighting', visibility: 'customer', status: 'approved' },
        { scopePresetId: 'draft-scope', label: 'Draft Scope', visibility: 'customer', status: 'draft' }
      ]
    });
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-1',
        role: 'customer',
        grants: { documentIds: ['customer-doc'], scopePresetIds: ['lighting'] }
      }
    });

    expect(listVisibleResourceSummaries(catalog, summary)).toEqual([
      expect.objectContaining({ type: 'document', id: 'public-doc' }),
      expect.objectContaining({ type: 'document', id: 'customer-doc' }),
      expect.objectContaining({ type: 'scopePreset', id: 'lighting' })
    ]);
    expect(JSON.stringify(listVisibleResourceSummaries(catalog, summary))).not.toContain('Pending restricted doc');
    expect(JSON.stringify(listVisibleResourceSummaries(catalog, summary))).not.toContain('Draft Scope');
  });

  it('normalizes application metadata, deduplicates ids, and filters path-like values from safe DTOs', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-elmos-lighting',
          label: 'ELMOS Lighting note',
          visibility: 'customer',
          brands: ['ELMOS', 'ELMOS', 'D:\\private\\brand'],
          productLines: ['ELMOS Lighting', '\\\\server\\line'],
          applicationTags: ['Automotive lighting', 'Automotive lighting', '/srv/private/app'],
          chipIds: ['E522.94', 'D:\\private\\chip'],
          sourceLabels: ['safe label', 'D:\\private\\source.pdf']
        },
        { documentId: 'doc-elmos-lighting', label: 'duplicate ignored', visibility: 'customer' }
      ],
      scopePresets: [
        {
          scopePresetId: 'scope-preset-elmos-lighting',
          label: 'ELMOS Lighting',
          visibility: 'customer',
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          applicationTags: ['Automotive lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-elmos-lighting'],
          requiredGrants: {
            scopePresetIds: ['scope-preset-elmos-lighting'],
            chipIds: ['E522.94'],
            documentIds: ['doc-elmos-lighting']
          }
        },
        { scopePresetId: 'scope-preset-elmos-lighting', label: 'duplicate ignored', visibility: 'customer' }
      ],
      workspaceDir: 'D:\\private\\workspace'
    });
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-1',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-elmos-lighting'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });
    const visible = listVisibleResourceSummaries(catalog, summary);
    const serialized = JSON.stringify(visible);

    expect(catalog.documents).toHaveLength(1);
    expect(catalog.scopePresets).toHaveLength(1);
    expect(visible).toEqual([
      expect.objectContaining({
        type: 'document',
        id: 'doc-elmos-lighting',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94']
      }),
      expect.objectContaining({
        type: 'scopePreset',
        id: 'scope-preset-elmos-lighting',
        applicationTags: ['Automotive lighting'],
        documentIds: ['doc-elmos-lighting']
      })
    ]);
    expect(serialized).not.toMatch(/workspaceDir|D:\\private|\\\\server|\/srv|source\.pdf/);
  });

  it('falls back to safe ids when document or scope labels look like paths', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [{ documentId: 'doc-safe-id', label: 'D:\\private\\doc.pdf', visibility: 'public' }],
      scopePresets: [{ scopePresetId: 'scope-safe-id', label: '/srv/private/scope', visibility: 'public' }]
    });
    const summary = computeEffectiveAuthorizationSummary({
      user: { id: 'public-user', role: 'public', grants: { documentIds: ['doc-safe-id'], scopePresetIds: ['scope-safe-id'] } }
    });

    expect(listVisibleResourceSummaries(catalog, summary)).toEqual([
      expect.objectContaining({ id: 'doc-safe-id', label: 'doc-safe-id' }),
      expect.objectContaining({ id: 'scope-safe-id', label: 'scope-safe-id' })
    ]);
  });
});
