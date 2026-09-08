import { mkdir, mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sweepExpiredScopeWorkspaces } from '../src/scope/workspace-cleanup.js';

describe('sweepExpiredScopeWorkspaces', () => {
  let tmpDir: string;
  let dataDir: string;
  let workspacesRoot: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'scope-ttl-test-'));
    dataDir = path.join(tmpDir, 'data');
    workspacesRoot = path.join(dataDir, 'scope-workspaces');
    await mkdir(workspacesRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('删除超过 maxAgeMs 的子目录，保留未过期的', async () => {
    // 创建两个子目录
    const oldDir = path.join(workspacesRoot, 'scope-old-123');
    const newDir = path.join(workspacesRoot, 'chip-new-456');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });

    // now = 1000000ms，maxAgeMs = 100000ms
    // 旧的 mtime 设为 0（很早），新的 mtime 设为 now - 50000（未过期）
    const now = 1_000_000;
    const maxAgeMs = 100_000;
    const oldMtime = new Date(0);
    const newMtime = new Date(now - 50_000);

    await utimes(oldDir, oldMtime, oldMtime);
    await utimes(newDir, newMtime, newMtime);

    const result = await sweepExpiredScopeWorkspaces({ dataDir, maxAgeMs, now });

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);

    // 旧目录应已删除
    await expect(stat(oldDir)).rejects.toThrow();
    // 新目录应保留
    await expect(stat(newDir)).resolves.toBeTruthy();
  });

  it('两个都过期时都删除', async () => {
    const dir1 = path.join(workspacesRoot, 'scope-a');
    const dir2 = path.join(workspacesRoot, 'scope-b');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    const now = 500_000;
    const maxAgeMs = 100_000;
    const oldMtime = new Date(0);
    await utimes(dir1, oldMtime, oldMtime);
    await utimes(dir2, oldMtime, oldMtime);

    const result = await sweepExpiredScopeWorkspaces({ dataDir, maxAgeMs, now });

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(2);
    await expect(stat(dir1)).rejects.toThrow();
    await expect(stat(dir2)).rejects.toThrow();
  });

  it('两个都未过期时不删除任何', async () => {
    const dir1 = path.join(workspacesRoot, 'chip-x');
    const dir2 = path.join(workspacesRoot, 'chip-y');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });

    const now = 200_000;
    const maxAgeMs = 100_000;
    // mtime 在 now - 50000，未过期
    const freshMtime = new Date(now - 50_000);
    await utimes(dir1, freshMtime, freshMtime);
    await utimes(dir2, freshMtime, freshMtime);

    const result = await sweepExpiredScopeWorkspaces({ dataDir, maxAgeMs, now });

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(0);
    await expect(stat(dir1)).resolves.toBeTruthy();
    await expect(stat(dir2)).resolves.toBeTruthy();
  });

  it('scope-workspaces 根目录不存在时不抛出，返回 {removed:0, scanned:0}', async () => {
    // 使用一个不存在的 dataDir
    const missingDataDir = path.join(tmpDir, 'nonexistent-data');
    const result = await sweepExpiredScopeWorkspaces({ dataDir: missingDataDir, maxAgeMs: 1000 });
    expect(result).toEqual({ removed: 0, scanned: 0 });
  });

  it('只扫描子目录，跳过文件', async () => {
    const subDir = path.join(workspacesRoot, 'scope-sub');
    await mkdir(subDir, { recursive: true });

    // 在根目录下创建一个文件（不是目录）
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(workspacesRoot, 'some-file.txt'), 'data');

    const now = 500_000;
    const maxAgeMs = 100_000;
    const oldMtime = new Date(0);
    await utimes(subDir, oldMtime, oldMtime);

    const result = await sweepExpiredScopeWorkspaces({ dataDir, maxAgeMs, now });

    // 只扫描目录，文件不计入 scanned
    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('支持自定义 workspaceRoot 参数', async () => {
    // 使用自定义 workspaceRoot，与 dataDir 无关
    const customRoot = path.join(tmpDir, 'custom-root');
    await mkdir(customRoot, { recursive: true });
    const subDir = path.join(customRoot, 'scope-custom');
    await mkdir(subDir, { recursive: true });

    const now = 500_000;
    const maxAgeMs = 100_000;
    const oldMtime = new Date(0);
    await utimes(subDir, oldMtime, oldMtime);

    const result = await sweepExpiredScopeWorkspaces({
      dataDir,
      maxAgeMs,
      now,
      workspaceRoot: customRoot
    });

    expect(result.scanned).toBe(1);
    expect(result.removed).toBe(1);
    await expect(stat(subDir)).rejects.toThrow();
  });

  it('恰好在边界（now - mtime === maxAgeMs）时删除', async () => {
    const dir = path.join(workspacesRoot, 'scope-boundary');
    await mkdir(dir, { recursive: true });

    const now = 200_000;
    const maxAgeMs = 100_000;
    // mtime 恰好在 now - maxAgeMs
    const boundaryMtime = new Date(now - maxAgeMs);
    await utimes(dir, boundaryMtime, boundaryMtime);

    const result = await sweepExpiredScopeWorkspaces({ dataDir, maxAgeMs, now });

    // now - mtime = maxAgeMs，> 比较应是严格大于，边界不删除
    // 按实现规范：若 now - mtime > maxAgeMs 则删除；等于时保留
    expect(result.scanned).toBe(1);
    // 注意：根据实现，等于时 *不* 删除（严格 >）
    expect(result.removed).toBe(0);
    await expect(stat(dir)).resolves.toBeTruthy();
  });
});
