import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScopeSelectionAllowed } from '../src/scope/index.js';
import {
  cleanupScopeWorkspace,
  materializeScopeWorkspace,
  readScopeWorkspaceSafeManifest,
  ScopeTooLargeError,
  toSafeWorkspaceDto
} from '../src/scope/index.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('scope workspace materializer', () => {
  it('falls back to copy mode when link mode is unsupported', async () => {
    const fixture = await createFixture();
    const workspace = await materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: true,
      linkSupport: { supported: false, reason: 'link mode failed read-only validation' }
    });

    expect(workspace).toMatchObject({
      mode: 'copy',
      status: 'fallback',
      safeDto: expect.objectContaining({
        mode: 'copy',
        status: 'fallback',
        fileCount: 2,
        fallbackReason: 'link mode failed read-only validation'
      })
    });
    expect(JSON.stringify(workspace.safeDto)).not.toMatch(/sourceRoot|workspacePath|D:\\|\/tmp|\\\\/i);
  });

  it('copies only resolver-allowed files', async () => {
    const fixture = await createFixture();
    const workspace = await materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: false
    });
    const files = await readdir(workspace.workspacePath);
    const serializedFiles = files.join('\n');

    expect(files).toHaveLength(3);
    expect(serializedFiles).toContain('doc-allowed-a');
    expect(serializedFiles).toContain('doc-allowed-b');
    expect(serializedFiles).toContain('scope.json');
    expect(serializedFiles).not.toContain('doc-denied');
    await expect(readFile(path.join(workspace.workspacePath, 'doc-denied-secret.md'), 'utf8')).rejects.toThrow();
  });

  it('全量复制 200 个授权文件（小档阈值边界，不截断）', async () => {
    const fixture = await createManyFileFixture(200);
    const workspace = await materializeScopeWorkspace(makeManyFileSelection(200), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: false
    });
    const files = await readdir(workspace.workspacePath);

    expect(workspace.safeDto.fileCount).toBe(200);
    expect(files.filter((file) => file !== 'scope.json')).toHaveLength(200);
  });

  it('超出阈值 201 个文件时抛 ScopeTooLargeError（不静默截断）', async () => {
    const fixture = await createManyFileFixture(201);
    await expect(
      materializeScopeWorkspace(makeManyFileSelection(201), fixture.manifest, {
        dataDir: fixture.dataDir,
        preferLinkMode: false
      })
    ).rejects.toThrow(ScopeTooLargeError);
  });

  it('ScopeTooLargeError 包含文件数与阈值信息', async () => {
    const fixture = await createManyFileFixture(201);
    await expect(
      materializeScopeWorkspace(makeManyFileSelection(201), fixture.manifest, {
        dataDir: fixture.dataDir,
        preferLinkMode: false
      })
    ).rejects.toMatchObject({ statusCode: 413, fileCount: 201, threshold: 200 });
  });

  it('rejects path traversal before materializing a workspace', async () => {
    const fixture = await createFixture();
    await expect(
      materializeScopeWorkspace(
        makeSelection(),
        {
          sourceRoot: fixture.sourceRoot,
          files: [{ documentId: 'doc-allowed-a', label: 'Allowed A', relativePath: '../escape.md' }]
        },
        { dataDir: fixture.dataDir }
      )
    ).rejects.toThrow(/path traversal|safe relative/);
  });

  it('rejects manifest entries whose real path escapes the source root', async () => {
    const fixture = await createFixture();
    const outsideDir = await makeTempDir('agentx-scope-outside-');
    const outsideFile = path.join(outsideDir, 'outside.md');
    await writeFile(outsideFile, 'outside', 'utf8');
    const linkPath = path.join(fixture.sourceRoot, 'linked-outside.md');
    try {
      await symlink(outsideFile, linkPath);
    } catch {
      return;
    }

    await expect(
      materializeScopeWorkspace(
        makeSelection(),
        {
          sourceRoot: fixture.sourceRoot,
          files: [{ documentId: 'doc-allowed-a', label: 'Allowed A', relativePath: 'linked-outside.md' }]
        },
        { dataDir: fixture.dataDir }
      )
    ).rejects.toThrow(/outside source root/);
  });

  it('removes a partially created workspace when materialization fails after mkdir', async () => {
    const fixture = await createFixture();
    const failingLinkSupport = {} as { supported: boolean; reason: string };
    Object.defineProperty(failingLinkSupport, 'supported', {
      get() {
        throw new Error('injected post-mkdir materialization failure');
      }
    });

    await expect(materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: true,
      linkSupport: failingLinkSupport
    })).rejects.toThrow('injected post-mkdir materialization failure');

    await expect(readdir(path.join(fixture.dataDir, 'scope-workspaces'))).resolves.toEqual([]);
  });

  it('keeps safe DTO and safe manifest free of filesystem paths', async () => {
    const fixture = await createFixture();
    const workspace = await materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: false
    });
    const safeManifest = await readScopeWorkspaceSafeManifest(workspace);
    const serialized = JSON.stringify({ dto: workspace.safeDto, safeManifest });

    expect(workspace.safeDto).toEqual(
      expect.objectContaining({
        workspaceId: expect.stringMatching(/^scope-/),
        scopeId: expect.stringContaining('scope-preset-elmos-lighting'),
        status: 'ready',
        mode: 'copy',
        fileCount: 2
      })
    );
    expect(serialized).not.toMatch(/workspacePath|internalManifestPath|sourcePath|sourceRoot|agentx-scope|D:\\|\/tmp|\\\\/i);
  });

  it('captures used-source seed records from materialized safe labels only', async () => {
    const fixture = await createFixture();
    const workspace = await materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir,
      preferLinkMode: false
    });
    const serialized = JSON.stringify(workspace.usedSources);

    expect(workspace.usedSources).toEqual([
      expect.objectContaining({
        captureKind: 'system_captured_source_seed',
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-allowed-a',
        displayTitle: 'Allowed A Datasheet',
        filename: 'allowed-a.md'
      }),
      expect.objectContaining({
        captureKind: 'system_captured_source_seed',
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-allowed-b',
        displayTitle: 'Allowed B Datasheet',
        filename: 'allowed-b.md'
      })
    ]);
    expect(serialized).not.toMatch(/doc-denied|sourceRoot|sourcePath|workspacePath|internalManifestPath|D:\\|\/tmp|\\\\/i);
  });

  it('cleans up only inside the configured scope workspace root', async () => {
    const fixture = await createFixture();
    const workspace = await materializeScopeWorkspace(makeSelection(), fixture.manifest, {
      dataDir: fixture.dataDir
    });
    const result = await cleanupScopeWorkspace({ dataDir: fixture.dataDir, workspaceId: workspace.workspaceId });

    expect(result.cleaned).toBe(true);
    await expect(stat(workspace.workspacePath)).rejects.toThrow();
    await expect(
      cleanupScopeWorkspace({ dataDir: fixture.dataDir, workspaceId: '..\\outside' })
    ).rejects.toThrow(/outside workspace root/);
  });

  it('redacts path-like labels in public DTOs', () => {
    expect(
      JSON.stringify(
        toSafeWorkspaceDto({
          workspaceId: 'scope-1',
          scopeId: 'scope-1',
          status: 'ready',
          mode: 'copy',
          fileCount: 1,
          labels: [{ documentId: 'doc-a', label: 'D:\\private\\doc-a.pdf' }]
        })
      )
    ).not.toMatch(/D:\\private|doc-a\.pdf/);
  });
});

async function createFixture() {
  const root = await makeTempDir('agentx-scope-workspace-');
  const sourceRoot = path.join(root, 'source');
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(sourceRoot, 'docs'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(sourceRoot, 'docs', 'allowed-a.md'), 'allowed a', 'utf8');
  await writeFile(path.join(sourceRoot, 'docs', 'allowed-b.md'), 'allowed b', 'utf8');
  await writeFile(path.join(sourceRoot, 'docs', 'secret.md'), 'secret', 'utf8');
  return {
    root,
    sourceRoot,
    dataDir,
    manifest: {
      sourceRoot,
      files: [
        {
          documentId: 'doc-allowed-a',
          label: 'Allowed A',
          chipId: 'E522.94',
          displayTitle: 'Allowed A Datasheet',
          filename: 'allowed-a.md',
          sourceType: 'catalog_document',
          visibility: 'customer',
          relativePath: 'docs/allowed-a.md'
        },
        {
          documentId: 'doc-allowed-b',
          label: 'Allowed B',
          chipId: 'E522.96',
          displayTitle: 'Allowed B Datasheet',
          filename: 'allowed-b.md',
          sourceType: 'catalog_document',
          visibility: 'customer',
          relativePath: 'docs/allowed-b.md'
        },
        { documentId: 'doc-denied', label: 'Secret', chipId: 'E000.00', relativePath: 'docs/secret.md' }
      ]
    }
  };
}

async function createManyFileFixture(count: number) {
  const root = await makeTempDir('agentx-scope-workspace-many-');
  const sourceRoot = path.join(root, 'source');
  const dataDir = path.join(root, 'data');
  await mkdir(path.join(sourceRoot, 'docs'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const documentId = `doc-allowed-${index}`;
    const fileName = `allowed-${index}.md`;
    await writeFile(path.join(sourceRoot, 'docs', fileName), `allowed ${index}`, 'utf8');
    files.push({ documentId, label: `Allowed ${index}`, chipId: 'E522.94', relativePath: `docs/${fileName}` });
  }
  return {
    root,
    sourceRoot,
    dataDir,
    manifest: {
      sourceRoot,
      files
    }
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

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
      documentIds: ['doc-allowed-a', 'doc-allowed-b']
    },
    allowedChipIds: ['E522.94', 'E522.96'],
    allowedDocumentIds: ['doc-allowed-a', 'doc-allowed-b'],
    deniedReasons: [],
    requiredGrants: {
      brands: ['ELMOS'],
      productLines: ['ELMOS Lighting'],
      chipIds: ['E522.94', 'E522.96'],
      documentIds: ['doc-allowed-a', 'doc-allowed-b'],
      scopePresetIds: ['scope-preset-elmos-lighting']
    },
    requiredGrantCounts: {
      brands: 1,
      productLines: 1,
      chipIds: 2,
      documentIds: 2,
      scopePresetIds: 1
    },
    authorizationDecision: {
      allowed: true,
      reasonCode: 'allowed',
      safeMessage: 'Allowed.',
      audit: {
        userId: 'user-1',
        role: 'customer',
        resourceType: 'scopePreset',
        reasonCode: 'allowed'
      },
      matchedGrants: ['scope-preset-elmos-lighting']
    },
    workspaceModeCandidate: 'pendingWorkspace',
    audit: {
      entryPoint: 'test',
      userId: 'user-1',
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

function makeManyFileSelection(count: number): ScopeSelectionAllowed {
  const documentIds = Array.from({ length: count }, (_, index) => `doc-allowed-${index}`);
  return {
    ...makeSelection(),
    filters: {
      ...makeSelection().filters,
      chipIds: ['E522.94'],
      documentIds
    },
    allowedChipIds: ['E522.94'],
    allowedDocumentIds: documentIds,
    requiredGrants: {
      ...makeSelection().requiredGrants,
      chipIds: ['E522.94'],
      documentIds
    },
    requiredGrantCounts: {
      ...makeSelection().requiredGrantCounts,
      chipIds: 1,
      documentIds: count
    },
    audit: {
      ...makeSelection().audit,
      coveredChipCount: 1,
      coveredDocumentCount: count
    }
  };
}
