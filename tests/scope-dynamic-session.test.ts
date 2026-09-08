/**
 * 集成测试：prepareDynamicScopeSession（B2）
 *
 * 真实物化管线 — 要求源文件真实存在于磁盘。
 * TDD: 先写此测试，再实现 prepareDynamicScopeSession。
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

/**
 * 创建共享测试夹具：2 颗芯片，同属 productLine='氛围灯'
 * 每颗芯片各有 2~3 个真实 .md 文件。
 */
async function createDynamicScopeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentx-dynamic-scope-'));
  tempDirs.push(root);

  const dataDir = join(root, 'data');
  const kbRoot = join(root, 'kb');

  // 芯片 A：2 个 md 文件
  await mkdir(join(kbRoot, 'E521.31'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.31', 'overview.md'), '# E521.31 Overview\n内容 A1', 'utf8');
  await writeFile(join(kbRoot, 'E521.31', 'pinout.md'), '# E521.31 Pinout\n内容 A2', 'utf8');

  // 芯片 B：3 个 md 文件
  await mkdir(join(kbRoot, 'E521.39'), { recursive: true });
  await writeFile(join(kbRoot, 'E521.39', 'overview.md'), '# E521.39 Overview\n内容 B1', 'utf8');
  await writeFile(join(kbRoot, 'E521.39', 'timing.md'), '# E521.39 Timing\n内容 B2', 'utf8');
  await writeFile(join(kbRoot, 'E521.39', 'register.md'), '# E521.39 Register\n内容 B3', 'utf8');

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
        documentIds: ['doc-e52131'],
        workspaceDir: 'E521.31'
      },
      {
        id: 'E521.39',
        label: 'E521.39 氛围灯',
        brand: 'ELMOS',
        productLines: ['氛围灯'],
        applicationTags: ['Automotive lighting'],
        documentIds: ['doc-e52139'],
        workspaceDir: 'E521.39'
      }
    ]
  };

  // 最小 ResourceVisibilityCatalog，documents 为空数组
  // 验证动态范围不依赖 document contract
  const resources = parseResourceVisibilityCatalog({
    documents: [],
    scopePresets: []
  });

  return { root, dataDir, kbRoot, chips, resources };
}

describe('prepareDynamicScopeSession', () => {
  /**
   * 用例 A: group 模式，两颗芯片都授权
   * - 非 undefined
   * - cwd 指向物化副本
   * - 副本内文件数 = 两芯片 md 数之和（2 + 3 = 5）
   * - safeSummary JSON 不含源目录绝对路径片段
   * - cleanup() 后副本目录被删
   */
  it('A: group 模式物化两颗芯片，文件数之和正确，路径不泄露', async () => {
    const fixture = await createDynamicScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          chipIds: ['E521.31', 'E521.39'],
          documentIds: ['doc-e52131', 'doc-e52139'],
          brands: ['ELMOS'],
          productLines: ['氛围灯'],
          scopePresetIds: []
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

    // 非 undefined
    expect(prepared).toBeDefined();

    // cwd 指向物化副本（真实目录）
    await expect(stat(prepared!.cwd)).resolves.toBeTruthy();

    // 副本内文件数 = 两芯片 md 数之和（5 个）+ scope.json 内部清单（1 个）= 6
    // 物化后文件散布在子目录里，需要递归统计
    const totalFiles = await countFilesRecursive(prepared!.cwd);
    expect(totalFiles).toBe(6);

    // safeSummary JSON 不含源目录绝对路径片段
    const safeSummaryJson = JSON.stringify(prepared!.safeSummary);
    // kbRoot 含有系统 tmp 路径 — 不能出现在 safeSummary
    expect(safeSummaryJson).not.toContain(fixture.kbRoot);
    // 不含 dataDir 原始路径（工作区路径本身可含 dataDir，但 safeSummary 应不含源路径）
    expect(safeSummaryJson).not.toContain(fixture.kbRoot.replace(/\\/g, '\\\\'));
    // 路径分隔符不应泄露（现有测试的检查模式）
    expect(safeSummaryJson).not.toMatch(/workspaceDir|sourceRoot|sourcePath|internalManifestPath|knowledgeBaseRoot/i);

    // cleanup() 后副本目录被删
    await prepared!.cleanup();
    await expect(stat(prepared!.cwd)).rejects.toThrow();
  });

  /**
   * 用例 B: single 模式 → 返回 undefined（不接管单芯片）
   */
  it('B: single 模式返回 undefined，不接管单芯片路径', async () => {
    const fixture = await createDynamicScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'alice',
        role: 'customer',
        grants: {
          chipIds: ['E521.31'],
          documentIds: [],
          scopePresetIds: []
        }
      }
    });

    const descriptor: ScopeDescriptor = {
      mode: 'single',
      chipId: 'E521.31'
    };

    const result = await prepareDynamicScopeSession({
      authorization,
      chips: fixture.chips,
      resources: fixture.resources,
      dataDir: fixture.dataDir,
      authorizedChipIds: ['E521.31'],
      descriptor
    });

    expect(result).toBeUndefined();
  });

  /**
   * 用例 C: 零越权端到端
   * authorizedChipIds 只含 E521.31（1 颗），descriptor group 氛围灯（catalog 含 2 颗）
   * → 物化副本只含被授权那颗的文件数（2 个）
   */
  it('C: authorizedChipIds 只含 1 颗时，物化副本只含该芯片文件，零越权', async () => {
    const fixture = await createDynamicScopeFixture();
    const authorization = computeEffectiveAuthorizationSummary({
      user: {
        id: 'bob',
        role: 'customer',
        grants: {
          chipIds: ['E521.31'], // 只授权 E521.31
          documentIds: ['doc-e52131'],
          brands: ['ELMOS'],
          productLines: ['氛围灯'],
          scopePresetIds: []
        }
      }
    });

    const descriptor: ScopeDescriptor = {
      mode: 'group',
      groups: [{ dimension: 'productLine', value: '氛围灯' }]
    };

    // authorizedChipIds 只有 E521.31，descriptor group 氛围灯覆盖 2 颗
    // resolveDynamicScopeSelection 会取交集 → 只含 E521.31
    const prepared = await prepareDynamicScopeSession({
      authorization,
      chips: fixture.chips,
      resources: fixture.resources,
      dataDir: fixture.dataDir,
      authorizedChipIds: ['E521.31'], // 只有 1 颗
      descriptor,
      entryPoint: 'web'
    });

    expect(prepared).toBeDefined();

    // 副本内文件数只等于 E521.31 的文件数（2 个）+ scope.json 清单（1 个）= 3
    const totalFiles = await countFilesRecursive(prepared!.cwd);
    expect(totalFiles).toBe(3);

    // 确保 E521.39 的文件没有被拷入
    const allFileNames = await collectFileNamesRecursive(prepared!.cwd);
    expect(allFileNames).not.toContain('timing.md');
    expect(allFileNames).not.toContain('register.md');

    // safeSummary 路径不泄露
    const safeSummaryJson = JSON.stringify(prepared!.safeSummary);
    expect(safeSummaryJson).not.toContain(fixture.kbRoot);
    expect(safeSummaryJson).not.toMatch(/workspaceDir|sourceRoot|sourcePath|internalManifestPath|knowledgeBaseRoot/i);

    await prepared!.cleanup();
    await expect(stat(prepared!.cwd)).rejects.toThrow();
  });
});

// ---- 辅助函数 ----

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
