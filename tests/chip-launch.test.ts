import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, access } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareChipLaunch, scopeLaunchHardening } from '../src/scope/chip-launch.js';

// 工具函数：创建临时目录并在测试后清理
const dirsToCleanup: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirsToCleanup.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  for (const d of dirsToCleanup.splice(0)) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

describe('prepareChipLaunch', () => {
  it('副本 cwd 不在 KB 根内，且包含源文件', async () => {
    const kbRoot = await makeTempDir('kb-root-');
    const chipDir = path.join(kbRoot, 'chip-a');
    await mkdir(chipDir, { recursive: true });
    await writeFile(path.join(chipDir, 'datasheet.md'), '# chip-a datasheet');
    const dataDir = await makeTempDir('data-dir-');

    const result = await prepareChipLaunch({
      chipSourceCwd: chipDir,
      knowledgeBaseRoot: kbRoot,
      dataDir,
    });

    try {
      // cwd 不在 KB 根内
      const realKbRoot = await realpath(kbRoot);
      expect(result.cwd).not.toContain(realKbRoot);

      // cwd 里有那个 md 文件
      await expect(access(path.join(result.cwd, 'datasheet.md'))).resolves.toBeUndefined();

      // denyReadRoots 含 realpath(KB根) 与 chip 源目录
      const realChipDir = await realpath(chipDir);
      expect(result.denyReadRoots).toContain(realKbRoot);
      expect(result.denyReadRoots).toContain(realChipDir);

      // allowedTools 正确（去 Glob：关闭枚举泄露通路）
      expect(result.allowedTools).toEqual(['Read', 'Grep']);

      // permissionMode
      expect(result.permissionMode).toBe('default');
    } finally {
      await result.cleanup();
    }
  });

  it('cleanup 后 cwd 不存在', async () => {
    const kbRoot = await makeTempDir('kb-root-');
    const chipDir = path.join(kbRoot, 'chip-b');
    await mkdir(chipDir, { recursive: true });
    await writeFile(path.join(chipDir, 'doc.md'), '# doc');
    const dataDir = await makeTempDir('data-dir-');

    const result = await prepareChipLaunch({
      chipSourceCwd: chipDir,
      knowledgeBaseRoot: kbRoot,
      dataDir,
    });

    const cwdAfterCreate = result.cwd;
    await result.cleanup();

    await expect(access(cwdAfterCreate)).rejects.toThrow();
  });

  it('chipSourceCwd === knowledgeBaseRoot 时 denyReadRoots 只有 1 条', async () => {
    const kbRoot = await makeTempDir('kb-root-dedup-');
    await writeFile(path.join(kbRoot, 'readme.md'), '# readme');
    const dataDir = await makeTempDir('data-dir-');

    const result = await prepareChipLaunch({
      chipSourceCwd: kbRoot,
      knowledgeBaseRoot: kbRoot,
      dataDir,
    });

    try {
      expect(result.denyReadRoots).toHaveLength(1);
    } finally {
      await result.cleanup();
    }
  });
});

describe('scopeLaunchHardening', () => {
  it('返回正确的三件套参数', async () => {
    const kbRoot = await makeTempDir('kb-root-scope-');

    const result = await scopeLaunchHardening(kbRoot);

    const realKbRoot = await realpath(kbRoot);
    expect(result.denyReadRoots).toEqual([realKbRoot]);
    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.permissionMode).toBe('default');
  });

  it('knowledgeBaseRoot 路径不存在时回退 resolve', async () => {
    const nonExistentPath = path.join(os.tmpdir(), 'nonexistent-kb-' + Date.now());

    const result = await scopeLaunchHardening(nonExistentPath);

    expect(result.denyReadRoots).toHaveLength(1);
    expect(result.denyReadRoots[0]).toBe(path.resolve(nonExistentPath));
    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.permissionMode).toBe('default');
  });
});
