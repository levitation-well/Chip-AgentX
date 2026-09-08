import { describe, expect, it } from 'vitest';
import { listPublicChips, parseChipCatalog } from '../src/chips/index.js';
import { createDefaultElmosScopeSeed, parseScopeCatalogFoundation } from '../src/scope/index.js';

describe('scope catalog metadata foundation', () => {
  it('parses brand, product-line, application, chip, document, and scope preset metadata safely', () => {
    const catalog = parseScopeCatalogFoundation({
      brands: [
        {
          id: 'ELMOS',
          label: 'ELMOS',
          aliases: ['ELMOS Semiconductor', 'D:\\private\\brand-alias'],
          productLines: ['ELMOS Lighting', 'ELMOS Lighting'],
          applications: ['Automotive lighting'],
          secret: 'ignored'
        },
        { id: 'ELMOS', label: 'duplicate ignored' }
      ],
      chips: [
        {
          id: 'E522.94',
          label: 'E522.94',
          brand: 'ELMOS',
          productLines: ['ELMOS Lighting', 'D:\\private\\line'],
          applicationTags: ['Automotive lighting', '\\\\server\\app'],
          documentIds: ['doc-e52294-datasheet'],
          workspaceDir: 'E522.94',
          serverPath: 'D:\\private\\kb\\E522.94'
        }
      ],
      documents: [
        {
          documentId: 'doc-e52294-datasheet',
          label: 'E522.94 Datasheet',
          visibility: 'customer',
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          applicationTags: ['Automotive lighting'],
          chipIds: ['E522.94'],
          sourceLabels: ['datasheet', 'D:\\private\\datasheet.pdf']
        }
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
          documentIds: ['doc-e52294-datasheet'],
          requiredGrants: {
            scopePresetIds: ['scope-preset-elmos-lighting'],
            chipIds: ['E522.94'],
            documentIds: ['doc-e52294-datasheet']
          },
          workspaceDir: 'D:\\private\\workspace'
        }
      ]
    });
    const serialized = JSON.stringify(catalog);

    expect(catalog.metadata.brands).toEqual([
      expect.objectContaining({
        id: 'ELMOS',
        aliases: ['ELMOS Semiconductor'],
        productLines: ['ELMOS Lighting'],
        applications: ['Automotive lighting']
      })
    ]);
    expect(catalog.metadata.chips[0]).toMatchObject({
      id: 'E522.94',
      brand: 'ELMOS',
      productLines: ['ELMOS Lighting'],
      applicationTags: ['Automotive lighting']
    });
    expect(catalog.resources.documents[0]).toMatchObject({
      documentId: 'doc-e52294-datasheet',
      applicationTags: ['Automotive lighting']
    });
    expect(catalog.resources.scopePresets[0]).toMatchObject({
      scopePresetId: 'scope-preset-elmos-lighting',
      applicationTags: ['Automotive lighting'],
      requiredGrants: expect.objectContaining({
        scopePresetIds: ['scope-preset-elmos-lighting'],
        chipIds: ['E522.94'],
        documentIds: ['doc-e52294-datasheet']
      })
    });
    expect(serialized).not.toMatch(/serverPath|D:\\private|\\\\server|datasheet\.pdf|secret/);
  });

  it('derives metadata from chip entries and ignores duplicate ids', () => {
    const catalog = parseScopeCatalogFoundation({
      chips: [
        {
          id: 'E521.39',
          label: 'E521.39',
          brand: 'ELMOS',
          productLines: ['ELMOS Motor'],
          applicationTags: ['Motor control'],
          documentIds: ['doc-e52139-datasheet'],
          workspaceDir: 'E521.39'
        },
        {
          id: 'E521.39',
          label: 'duplicate ignored',
          brand: 'Other',
          productLines: ['Other line'],
          workspaceDir: 'duplicate'
        }
      ]
    });

    expect(catalog.metadata.chips).toHaveLength(1);
    expect(catalog.metadata.brands).toEqual([
      expect.objectContaining({
        id: 'ELMOS',
        productLines: ['ELMOS Motor'],
        applications: ['Motor control'],
        chipIds: ['E521.39'],
        documentIds: ['doc-e52139-datasheet']
      })
    ]);
    expect(catalog.metadata.productLines).toEqual([
      expect.objectContaining({ id: 'ELMOS Motor', brand: 'ELMOS', chipIds: ['E521.39'] })
    ]);
    expect(catalog.metadata.applications).toEqual([
      expect.objectContaining({ id: 'Motor control', brands: ['ELMOS'], chipIds: ['E521.39'] })
    ]);
  });

  it('keeps chip public DTO metadata safe and compatible with Phase 37 resource contracts', () => {
    const chipCatalog = parseChipCatalog({
      knowledgeBaseRoot: './knowledge-bases',
      chips: [
        {
          id: 'E522.94',
          label: 'E522.94',
          brand: 'ELMOS',
          brandAliases: ['ELMOS Semiconductor', 'D:\\private\\alias'],
          productLines: ['ELMOS Lighting'],
          applicationTags: ['Automotive lighting'],
          documentIds: ['doc-e52294-datasheet'],
          sourceLabels: ['datasheet', '/srv/private/source'],
          workspaceDir: 'E522.94'
        }
      ]
    });
    const publicChip = listPublicChips(chipCatalog)[0];
    const serialized = JSON.stringify(publicChip);

    expect(publicChip).toEqual({
      id: 'E522.94',
      label: 'E522.94',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['ELMOS Lighting'],
      applicationTags: ['Automotive lighting'],
      documentIds: ['doc-e52294-datasheet'],
      sourceLabels: ['datasheet']
    });
    expect(serialized).not.toMatch(/workspaceDir|knowledgeBaseRoot|D:\\private|\/srv/);
  });

  it('rejects chip labels that look like paths before they can enter public DTOs', () => {
    expect(() =>
      parseChipCatalog({
        knowledgeBaseRoot: './knowledge-bases',
        chips: [{ id: 'bad-chip', label: 'D:\\private\\bad-chip', workspaceDir: 'bad-chip' }]
      })
    ).toThrow(/chip label must not be a path/);
  });

  it('provides an ELMOS seed with pending coverage rather than claiming full coverage', () => {
    const seed = createDefaultElmosScopeSeed();
    const ids = seed.resources.scopePresets.map((preset) => preset.scopePresetId);

    expect(ids).toEqual([
      'scope-preset-elmos-all',
      'scope-preset-elmos-lighting',
      'scope-preset-elmos-motor'
    ]);
    expect(seed.resources.scopePresets.every((preset) => preset.status === 'pending')).toBe(true);
    expect(seed.resources.scopePresets.every((preset) => preset.chipIds.length === 0 && preset.documentIds.length === 0)).toBe(true);
    expect(JSON.stringify(seed)).not.toMatch(/workspaceDir|knowledgeBaseRoot|api[_-]?key|token|D:\\|\/opt|\/srv/i);
  });
});
