import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { materializeChipWorkspace } from './chip-workspace.js';

// 去 Glob：实证表明 Glob 工具无视 deny，仍能枚举源根外目录的文件名/结构（路径泄露）。
// Read deny 同时挡住 Read 与 Grep 的内容读取，因此 Read+Grep 两件套即可：内容隔离成立、无枚举泄露。
const READONLY_TOOLS = ['Read', 'Grep'] as const;

export interface ChipLaunchHardening {
  /** 隔离副本目录（在 KB 根之外） */
  cwd: string;
  /** = realpath(知识库源根) ∪ chip 源目录（去重） */
  denyReadRoots: string[];
  /** 只读工具列表 */
  allowedTools: string[];
  permissionMode: 'default';
  files: Array<{ path: string; size?: number }>;
  cleanup: () => Promise<void>;
}

/**
 * 安全地获取路径的 realpath，路径不存在时回退到 path.resolve（best-effort 硬墙）。
 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 对路径列表去重。
 * Windows 下大小写不敏感（toLowerCase 作为 key），保留首次出现的原值。
 */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  }
  return result;
}

/**
 * 单 chip 档隔离闸：
 * - copy 源目录内允许文件到隔离副本
 * - 计算 denyReadRoots（KB 根 ∪ chip 源目录，去重）
 * - 只读工具 + 严格权限
 * - 返回 cleanup 供调用方在 session 结束后调用
 *
 * 调用方须已通过 resolveChipWorkspace 拿到 resolved.cwd（realpath 源目录）
 * 与 catalog.knowledgeBaseRoot，此 helper 只负责 copy + 算 deny。
 */
export async function prepareChipLaunch(opts: {
  /** resolved.cwd（chip 源目录，已是 realpath） */
  chipSourceCwd: string;
  /** catalog.knowledgeBaseRoot */
  knowledgeBaseRoot: string;
  dataDir: string;
  /** Original isolated cwd used by a persisted Claude Code conversation. */
  targetCwd?: string;
}): Promise<ChipLaunchHardening> {
  const ws = await materializeChipWorkspace({
    chipCwd: opts.chipSourceCwd,
    dataDir: opts.dataDir,
    ...(opts.targetCwd !== undefined ? { targetCwd: opts.targetCwd } : {})
  });

  const denyReadRoots = dedupePaths([
    await safeRealpath(opts.knowledgeBaseRoot),
    await safeRealpath(opts.chipSourceCwd),
  ]);

  return {
    cwd: ws.cwd,
    denyReadRoots,
    allowedTools: [...READONLY_TOOLS],
    permissionMode: 'default',
    files: ws.files,
    cleanup: ws.cleanup,
  };
}

/**
 * scope 档硬化参数：
 * 副本已由 materializeScopeWorkspace 产出，此 helper 只产出 deny/工具/权限三件套。
 */
export async function scopeLaunchHardening(knowledgeBaseRoot: string): Promise<{
  denyReadRoots: string[];
  allowedTools: string[];
  permissionMode: 'default';
}> {
  return {
    denyReadRoots: dedupePaths([await safeRealpath(knowledgeBaseRoot)]),
    allowedTools: [...READONLY_TOOLS],
    permissionMode: 'default',
  };
}
