import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface ScopeWorkspaceCleanupResult {
  workspaceId: string;
  cleaned: boolean;
}

export async function cleanupScopeWorkspace(input: {
  dataDir: string;
  workspaceId: string;
  workspaceRoot?: string;
}): Promise<ScopeWorkspaceCleanupResult> {
  const root = path.resolve(input.workspaceRoot ?? path.join(input.dataDir, 'scope-workspaces'));
  const target = path.resolve(root, input.workspaceId);
  if (!isPathInsideOrEqual(target, root)) {
    throw new Error('scope workspace cleanup target is outside workspace root');
  }
  await rm(target, { recursive: true, force: true });
  return { workspaceId: input.workspaceId, cleaned: true };
}

export interface SweepExpiredScopeWorkspacesResult {
  removed: number;
  scanned: number;
}

/**
 * 扫描 scope-workspaces 根目录下的所有子目录，删除 mtime 超过 maxAgeMs 的过期隔离副本。
 * 若根目录不存在，静默返回 {removed:0, scanned:0}，不抛出异常。
 * now 参数可注入（测试用），缺省为 Date.now()（生产用）。
 */
export async function sweepExpiredScopeWorkspaces(input: {
  dataDir: string;
  maxAgeMs: number;
  workspaceRoot?: string;
  now?: number;
}): Promise<SweepExpiredScopeWorkspacesResult> {
  const root = path.resolve(input.workspaceRoot ?? path.join(input.dataDir, 'scope-workspaces'));
  const nowMs = input.now ?? Date.now();

  // 根目录不存在时静默返回
  const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return { removed: 0, scanned: 0 };
  }

  let scanned = 0;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.resolve(root, entry.name);

    // 越界防护
    if (!isPathInsideOrEqual(dir, root)) continue;

    scanned += 1;

    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat) continue;

    const mtimeMs = dirStat.mtimeMs;
    if (nowMs - mtimeMs > input.maxAgeMs) {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
  }

  return { removed, scanned };
}

export function isPathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
  const normalizedCandidate = path.resolve(candidatePath);
  const normalizedRoot = path.resolve(rootPath);
  const compareCandidate = process.platform === 'win32' ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const compareRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
  const relative = path.relative(compareRoot, compareCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
