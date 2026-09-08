/**
 * TDD: Phase 3（V1，与 Phase 2/V14 合并实现）
 *
 * 动态 group/global 范围此前完全不校验文档审批状态（http-server.ts 曾对
 * prepareAuthorizedDynamicScopeSession 传入的资源目录写死为空 { documents: [], scopePresets: [] }），
 * 使得 draft/被拒/受限文档的文件会被一并物化进隔离工作区。
 *
 * 本测试锁定决策台账里的「只剔除未批准文档对应文件，不整体拒绝」（DROP-ONLY）语义：
 * 已授权 chip 下若混有一篇 approved 文档与一篇 draft 文档，物化结果应只含 approved 文档的文件，
 * 且 chip 本身、以及该 chip 下的 approved 文档，行为与「纯已批准场景」完全一致（零回归）。
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeEffectiveAuthorizationSummary, parseResourceVisibilityCatalog } from '../src/security/index.js';
import { prepareDynamicScopeSession } from '../src/scope/query-runner.js';
import type { ChipCatalog } from '../src/chips/index.js';
import type { ScopeDescriptor } from '../src/scope/scope-options.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function countFilesRecursive(dir: string): Promise<number> {
  let count = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFilesRecursive(join(dir, entry.name));
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

async function collectFileNamesRecursive(dir: string): Promise<string[]> {
  const names: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(...(await collectFileNamesRecursive(join(dir, entry.name))));
    } else if (entry.isFile()) {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * 与真实 chips.json 数据形态一致（一颗芯片对应恰好一篇文档，见 config/chips.json）：
 * 两颗同产线芯片，各挂一篇文档 —— E521.31 的文档 approved，E521.39 的文档 draft（未批准）。
 * 文件↔文档的关联粒度在当前架构里就是芯片级（一颗芯片的工作区文件整体归属其唯一文档），
 * 因此「剔除未批准文档对应文件」在此落地为「剔除该文档所在芯片的全部文件」，
 * 组内其余已批准芯片的文件不受影响、组选择本身不被整体拒绝。
 */
async function createMixedApprovalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-visibility-'));
  tempDirs.push(root);

  const dataDir = join(root, 'data');
  const kbRoot = join(root, 'kb');

  await mkdir(join(kbRoot, 'E521.31'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.31', 'overview.md'), '# E521.31 Overview\n已批准内容', 'utf8');

  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.39', 'internal-notes.md'), '# E521.39 Internal\n未批准草稿内容', 'utf8');

  await mkdir(dataDir, { recursive: true });

  const chips: ChipCatalog = {
    knowledgeBaseRoot: kbRoot,
    chips: [
      {
        id: 'E521.31',
        label: 'E521.31 氛围灯',
        brand: 'ELMOS',
        productLines: ['氛围灯'],
        applicationTags: ['Automotive lighting'],
        workspaceDir: 'E521.31'
      },
      {
        id: 'E521.39',
        label: 'E521.39 氛围灯',
        brand: 'ELMOS',
        productLines: ['氛围灯'],
        applicationTags: ['Automotive lighting'],
        workspaceDir: 'E521.39'
      }
    ]
  };

  const resources = parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'doc-approved',
        label: 'E521.31 Overview',
        visibility: 'customer',
        status: 'approved',
        chipIds: ['E521.31']
      },
      {
        documentId: 'doc-draft',
        label: 'E521.39 Internal Notes',
        visibility: 'customer',
        status: 'draft',
        chipIds: ['E521.39']
      }
    ],
    scopePresets: []
  });

  return { root, dataDir, kbRoot, chips, resources };
}

describe('dynamic scope drops unapproved documents (V1 + V14)', () => {
  it('keeps the approved chip document file while dropping the draft sibling document file, without denying the group (V1 drop-only)', async () => {
    const fixture = await createMixedApprovalFixture();
    // documentIds 是独立于 chipIds 的授权维度（与 preset 路径一致）；用通配符持有文档授权，
    // 只让 status 决定是否放行，避免被「未持有任何文档授权」整体挡住。
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          chipIds: ['E521.31', 'E521.39'],
          documentIds: ['*'],
          brands: ['ELMOS'],
          productLines: ['氛围灯']
        }
      }
    });

    const descriptor: ScopeDescriptor = {
      mode: 'group',
      groups: [{ dimension: 'productLine', value: '氛围灯' }]
    };

    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips: fixture.chips,
      resources: fixture.resources,
      dataDir: fixture.dataDir,
      authorizedChipIds: ['E521.31', 'E521.39'],
      descriptor,
      entryPoint: 'web'
    });

    // 组选择本身没有被整体拒绝（DROP-ONLY，不是 deny-all）。
    expect(prepared).toBeDefined();

    const fileNames = await collectFileNamesRecursive(prepared!.cwd);
    // 已批准文档（E521.31/overview.md）的文件被保留。
    expect(fileNames.some((name) => name.includes('doc-approved'))).toBe(true);
    // 未批准（draft，E521.39/internal-notes.md）文档的文件被剔除。
    expect(fileNames.some((name) => name.includes('doc-draft'))).toBe(false);
    expect(fileNames).not.toContain('internal-notes.md');

    // 副本内只有 approved 文档的 1 个源文件 + scope.json 清单 = 2（draft 芯片的文件未被拷入）。
    const totalFiles = await countFilesRecursive(prepared!.cwd);
    expect(totalFiles).toBe(2);

    await prepared!.cleanup();
    await expect(stat(prepared!.cwd)).rejects.toThrow();
  });

  it('leaves a pure-approved selection unchanged (no regression)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-visibility-pure-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const kbRoot = join(root, 'kb');
    await mkdir(join(kbRoot, 'E521.31'), { recursive: true });
    await writeFile(join(kbRoot, 'E521.31', 'overview.md'), '# E521.31 Overview\n已批准内容', 'utf8');
    await mkdir(dataDir, { recursive: true });

    const chips: ChipCatalog = {
      knowledgeBaseRoot: kbRoot,
      chips: [
        {
          id: 'E521.31',
          label: 'E521.31 氛围灯',
          brand: 'ELMOS',
          productLines: ['氛围灯'],
          workspaceDir: 'E521.31'
        }
      ]
    };
    const resources = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-approved-only',
          label: 'E521.31 Overview',
          visibility: 'customer',
          status: 'approved',
          chipIds: ['E521.31']
        }
      ],
      scopePresets: []
    });
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'bob',
        role: 'customer',
        grants: { chipIds: ['E521.31'], documentIds: ['*'], brands: ['ELMOS'], productLines: ['氛围灯'] }
      }
    });

    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips,
      resources,
      dataDir,
      authorizedChipIds: ['E521.31'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] },
      entryPoint: 'web'
    });

    expect(prepared).toBeDefined();
    const fileNames = await collectFileNamesRecursive(prepared!.cwd);
    expect(fileNames.some((name) => name.includes('doc-approved-only'))).toBe(true);
    const totalFiles = await countFilesRecursive(prepared!.cwd);
    expect(totalFiles).toBe(2); // 1 个源文件 + scope.json

    await prepared!.cleanup();
  });

  it('fails closed for a same-chip mixed document catalog and materializes only fully authorized sibling chips', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-same-chip-mixed-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const kbRoot = join(root, 'kb');
    await mkdir(join(kbRoot, 'A'), { recursive: true });
    await writeFile(join(kbRoot, 'A', 'mixed.md'), 'must not be copied', 'utf8');
    await mkdir(join(kbRoot, 'B'), { recursive: true });
    await writeFile(join(kbRoot, 'B', 'approved.md'), 'safe', 'utf8');
    await mkdir(dataDir, { recursive: true });

    const chips: ChipCatalog = {
      knowledgeBaseRoot: kbRoot,
      chips: [
        { id: 'A', label: 'A', productLines: ['line'], workspaceDir: 'A' },
        { id: 'B', label: 'B', productLines: ['line'], workspaceDir: 'B' }
      ]
    };
    const resources = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-a-approved', status: 'approved', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-a-draft', status: 'draft', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-b', status: 'approved', visibility: 'customer', chipIds: ['B'] }
      ]
    });
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'same-chip-mixed',
        role: 'customer',
        grants: { chipIds: ['A', 'B'], documentIds: ['*'], productLines: ['line'] }
      }
    });

    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips,
      resources,
      dataDir,
      authorizedChipIds: ['A', 'B'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: 'line' }] },
      entryPoint: 'web'
    });

    expect(prepared?.allowedChipIds).toEqual(['B']);
    expect(prepared?.allowedDocumentIds).toEqual(['doc-b']);
    const fileNames = await collectFileNamesRecursive(prepared!.cwd);
    expect(fileNames.some((name) => name.includes('doc-b'))).toBe(true);
    expect(fileNames).not.toContain('mixed.md');
    await prepared!.cleanup();
  });

  it('copies each physical file once when every same-chip catalog document is authorized', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-same-chip-approved-'));
    tempDirs.push(root);
    const dataDir = join(root, 'data');
    const kbRoot = join(root, 'kb');
    await mkdir(join(kbRoot, 'A'), { recursive: true });
    await writeFile(join(kbRoot, 'A', 'one.md'), 'one', 'utf8');
    await writeFile(join(kbRoot, 'A', 'two.md'), 'two', 'utf8');
    await mkdir(dataDir, { recursive: true });
    const chips: ChipCatalog = {
      knowledgeBaseRoot: kbRoot,
      chips: [{ id: 'A', label: 'A', productLines: ['line'], workspaceDir: 'A' }]
    };
    const resources = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-a-1', status: 'approved', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-a-2', status: 'approved', visibility: 'customer', chipIds: ['A'] }
      ]
    });
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'same-chip-approved',
        role: 'customer',
        grants: { chipIds: ['A'], documentIds: ['doc-a-1', 'doc-a-2'], productLines: ['line'] }
      }
    });

    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips,
      resources,
      dataDir,
      authorizedChipIds: ['A'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: 'line' }] },
      entryPoint: 'web'
    });

    expect(prepared?.allowedDocumentIds).toEqual(['doc-a-1', 'doc-a-2']);
    expect(await countFilesRecursive(prepared!.cwd)).toBe(3); // two source files + scope.json, no document x file cartesian copy
    await prepared!.cleanup();
  });
});
