import { mkdir, copyFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isPathInsideOrEqual } from './workspace-cleanup.js';

const ALLOWED = /\.(md|markdown|txt|json|csv|pdf)$/i;
const MAX_FILES = 500;
const CHIP_WORKSPACE_ID = /^chip-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidChipWorkspaceTargetError extends Error {
  constructor(message: string = 'Historical chip workspace target is invalid') {
    super(message);
  }
}

export interface MaterializedChipWorkspace {
  cwd: string;
  fileCount: number;
  files: Array<{ path: string; size?: number }>;
  cleanup: () => Promise<void>;
}

export async function materializeChipWorkspace(
  opts: { chipCwd: string; dataDir: string; maxFiles?: number; targetCwd?: string }
): Promise<MaterializedChipWorkspace> {
  // I-2：resolve chipCwd，避免相对路径依赖进程 CWD
  const chipRoot = path.resolve(opts.chipCwd);
  const root = opts.targetCwd !== undefined
    ? validateHistoricalChipWorkspaceTarget(opts.dataDir, opts.targetCwd)
    : path.join(path.resolve(opts.dataDir), 'scope-workspaces', `chip-${crypto.randomUUID()}`);
  if (opts.targetCwd !== undefined) {
    // Claude Code keys resumable conversations by cwd. Rehydrate the current,
    // authorized datasheet copy at the original path instead of creating a new
    // random directory that cannot resolve the persisted Claude session.
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(root, { recursive: true });
  // I-1：listFiles+copy 若抛错，清理已创建的孤儿目录后再 rethrow
  try {
    const rels = await listFiles(chipRoot, '', opts.maxFiles ?? MAX_FILES);
    const files: MaterializedChipWorkspace['files'] = [];
    for (const rel of rels) {
      const dest = path.join(root, rel);
      if (!isPathInsideOrEqual(dest, root)) {
        throw new Error('chip workspace destination is outside workspace root');
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(chipRoot, rel), dest);
      const copiedStat = await stat(dest).catch(() => undefined);
      files.push({
        path: rel.replace(/\\/g, '/'),
        ...(copiedStat ? { size: copiedStat.size } : {})
      });
    }
    return {
      cwd: root,
      fileCount: rels.length,
      files,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (err) {
    // 失败时清理已创建的临时目录，避免孤儿目录残留
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

export function validateHistoricalChipWorkspaceTarget(dataDir: string, targetCwd: string): string {
  const workspaceRoot = path.join(path.resolve(dataDir), 'scope-workspaces');
  const normalizedRoot = path.resolve(workspaceRoot);
  const normalizedTarget = path.resolve(targetCwd);
  const normalizedParent = path.dirname(normalizedTarget);
  const compare = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

  if (
    !isPathInsideOrEqual(normalizedTarget, normalizedRoot) ||
    compare(normalizedParent) !== compare(normalizedRoot) ||
    !CHIP_WORKSPACE_ID.test(path.basename(normalizedTarget))
  ) {
    throw new InvalidChipWorkspaceTargetError();
  }
  return normalizedTarget;
}

async function listFiles(
  base: string,
  rel: string,
  limit: number,
  out: string[] = []
): Promise<string[]> {
  if (out.length >= limit) return out;
  const entries = await readdir(path.join(base, rel || '.'), { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) break;
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await listFiles(base, childRel, limit, out);
    } else if (entry.isFile() && ALLOWED.test(entry.name)) {
      out.push(childRel);
      // 注意：withFileTypes 模式下，symlink 对 isFile()/isDirectory() 均返回 false，
      // 因此会被静默跳过——这是预期的安全行为，防止链接逃逸出 chip 目录。
    }
  }
  return out;
}
