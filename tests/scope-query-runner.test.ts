import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeEffectiveAuthorizationSummary, parseResourceVisibilityCatalog } from '../src/security/index.js';
import { prepareDynamicScopeSession, prepareScopeSession } from '../src/scope/index.js';
import type { ChipCatalog } from '../src/chips/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scope query runner session preparation', () => {
  it('materializes authorized scope sessions in copy mode with safe metadata only', async () => {
    const fixture = await createScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    const prepared = await prepareScopeSession({
      authorization,
      chips: fixture.chips,
      resources: fixture.resources,
      dataDir: fixture.dataDir,
      scopePresetId: 'scope-preset-elmos-lighting',
      documentId: 'doc-e52294-datasheet',
      entryPoint: 'web'
    });

    expect(prepared).toBeDefined();
    expect(prepared?.safeSummary).toMatchObject({
      scopePresetId: 'scope-preset-elmos-lighting',
      mode: 'copy',
      fileCount: 1,
      allowedChipCount: 1,
      allowedDocumentCount: 1
    });
    expect(prepared?.safeSummary.sourceCitationSummary).toMatchObject({
      captureKind: 'system_captured_source_seed',
      sourceCount: 1,
      sources: [
        expect.objectContaining({
          documentId: 'doc-e52294-datasheet',
          displayTitle: 'E522.94 Datasheet',
          filename: 'datasheet.md',
          sourceType: 'catalog_document',
          visibility: 'customer'
        })
      ]
    });
    expect(JSON.stringify(prepared?.safeSummary)).not.toMatch(/workspaceDir|sourceRoot|sourcePath|internalManifestPath|knowledgeBaseRoot|secret-token|D:\\|\/tmp|\\\\/i);
    await expect(readdir(prepared!.cwd)).resolves.toEqual(expect.arrayContaining([expect.stringContaining('doc-e52294-datasheet')]));
  });

  it('materializes dynamic chip-group scopes when chip config has no documentIds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-query-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const kbRoot = join(root, 'kb');
    await mkdir(join(kbRoot, 'E521.31'), { recursive: true });
    await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(kbRoot, 'E521.31', 'datasheet.md'), 'ambient 31 material', 'utf8');
    await writeFile(join(kbRoot, 'E521.39', 'datasheet.md'), 'ambient 39 material', 'utf8');

    const chips: ChipCatalog = {
      knowledgeBaseRoot: kbRoot,
      chips: [
        { id: 'E521.31', label: 'E521.31', brand: 'ELMOS', productLines: ['氛围灯'], workspaceDir: 'E521.31' },
        { id: 'E521.39', label: 'E521.39', brand: 'ELMOS', productLines: ['氛围灯'], workspaceDir: 'E521.39' }
      ]
    };
    const resources = parseResourceVisibilityCatalog({ documents: [], scopePresets: [] });
    const authorization = computeEffectiveAuthorizationSummary({
      user: { id: 'alice', role: 'customer', grants: { chipIds: ['E521.31', 'E521.39'], documentIds: [] } }
    });

    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips,
      resources,
      dataDir,
      authorizedChipIds: ['E521.31', 'E521.39'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] },
      entryPoint: 'web'
    });

    expect(prepared).toBeDefined();
    expect(prepared?.safeSummary).toMatchObject({
      scopePresetId: 'dynamic-group',
      fileCount: 2,
      allowedChipCount: 2,
      allowedDocumentCount: 0
    });
    await expect(readdir(prepared!.cwd)).resolves.toEqual(
      expect.arrayContaining([expect.stringContaining('chip-E521.31-workspace'), expect.stringContaining('chip-E521.39-workspace')])
    );
  });

  it('denies unauthorized scope without creating a workspace', async () => {
    const fixture = await createScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'mallory',
        role: 'customer',
        grants: {
          chipIds: ['E522.94'],
          documentIds: [],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    await expect(
      prepareScopeSession({
        authorization,
        chips: fixture.chips,
        resources: fixture.resources,
        dataDir: fixture.dataDir,
        scopePresetId: 'scope-preset-elmos-lighting',
        entryPoint: 'web'
      })
    ).rejects.toThrow(/not available|resource/i);
    await expect(stat(join(fixture.dataDir, 'scope-workspaces'))).rejects.toThrow();
  });

  it('rejects pending uploaded or unapproved documents before they can become used sources', async () => {
    const fixture = await createScopeFixture({ documentStatus: 'pending' });
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    await expect(
      prepareScopeSession({
        authorization,
        chips: fixture.chips,
        resources: fixture.resources,
        dataDir: fixture.dataDir,
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-e52294-datasheet',
        entryPoint: 'web'
      })
    ).rejects.toThrow(/not available|resource/i);
    await expect(stat(join(fixture.dataDir, 'scope-workspaces'))).rejects.toThrow();
  });

  it('fails closed when a preset selects only part of a same-chip document catalog', async () => {
    const fixture = await createScopeFixture({ extraSiblingDocument: true });
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting'],
          chipIds: ['E522.94'],
          documentIds: ['doc-e52294-datasheet'],
          scopePresetIds: ['scope-preset-elmos-lighting']
        }
      }
    });

    await expect(
      prepareScopeSession({
        authorization,
        chips: fixture.chips,
        resources: fixture.resources,
        dataDir: fixture.dataDir,
        scopePresetId: 'scope-preset-elmos-lighting',
        entryPoint: 'web'
      })
    ).rejects.toThrow(/not available|resource/i);
    await expect(stat(join(fixture.dataDir, 'scope-workspaces'))).rejects.toThrow();
  });

  it('cleans up the copy workspace through the returned best-effort cleanup hook', async () => {
    const fixture = await createScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: { id: 'admin', role: 'admin' }
    });
    const prepared = await prepareScopeSession({
      authorization,
      chips: fixture.chips,
      resources: fixture.resources,
      dataDir: fixture.dataDir,
      scopePresetId: 'scope-preset-elmos-lighting',
      entryPoint: 'test'
    });

    await expect(stat(prepared!.cwd)).resolves.toBeTruthy();
    await prepared!.cleanup();
    await expect(stat(prepared!.cwd)).rejects.toThrow();
  });
});

async function createScopeFixture(options: { documentStatus?: string; extraSiblingDocument?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentx-scope-query-'));
  tempDirs.push(root);
  const dataDir = join(root, 'data');
  const kbRoot = join(root, 'kb');
  await mkdir(join(kbRoot, 'E522.94'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(kbRoot, 'E522.94', 'datasheet.md'), 'authorized material', 'utf8');
  const chips: ChipCatalog = {
    knowledgeBaseRoot: kbRoot,
    chips: [
      {
        id: 'E522.94',
        label: 'E522.94',
        brand: 'ELMOS',
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        documentIds: ['doc-e52294-datasheet'],
        workspaceDir: 'E522.94'
      }
    ]
  };
  const resources = parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'doc-e52294-datasheet',
        label: 'E522.94 Datasheet',
        visibility: 'customer',
        status: options.documentStatus ?? 'approved',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: ['E522.94']
      },
      ...(options.extraSiblingDocument
        ? [{
            documentId: 'doc-e52294-sibling',
            label: 'E522.94 Sibling',
            visibility: 'customer' as const,
            status: 'approved',
            chipIds: ['E522.94']
          }]
        : [])
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
        chipIds: ['E522.94'],
        documentIds: ['doc-e52294-datasheet'],
        requiredGrants: {
          scopePresetIds: ['scope-preset-elmos-lighting'],
          brands: ['ELMOS'],
          productLines: ['ELMOS Lighting']
        }
      }
    ]
  });
  return { root, dataDir, kbRoot, chips, resources };
}
