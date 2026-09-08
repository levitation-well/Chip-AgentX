import { realpath, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import type { ChipCatalog, ResolvedChipWorkspace } from './types.js';
import { ChipNotFoundError, ChipWorkspaceError, isConfiguredAbsolutePath, isSafeRelativeWorkspaceDir } from './types.js';

/**
 * Check if a path is inside a root directory (with Windows compatibility).
 * Handles case-insensitive comparison on Windows.
 */
export function isPathInside(candidatePath: string, rootPath: string): boolean {
  // Normalize both paths
  const normalizedCandidate = resolve(candidatePath);
  const normalizedRoot = resolve(rootPath);

  // On Windows, normalize to lowercase for case-insensitive comparison
  const platform = process.platform;
  const compareCandidate = platform === 'win32' ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const compareRoot = platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;

  // Use relative path to detect if candidate is truly inside root
  const rel = relative(compareRoot, compareCandidate);

  // rel starts with '..' if candidate is outside root
  return !rel.startsWith('..') && rel !== '';
}

/**
 * Resolve workspace for a chip. Absolute workspaceDir values are trusted admin config;
 * legacy relative workspaceDir values are still constrained under knowledgeBaseRoot.
 */
export async function resolveChipWorkspace(
  catalog: ChipCatalog,
  chipId: string
): Promise<ResolvedChipWorkspace> {
  // Find the chip
  const chip = catalog.chips.find((c) => c.id === chipId);
  if (!chip) {
    throw new ChipNotFoundError(`Chip not found: ${chipId}`, 400);
  }

  const usesAbsoluteWorkspace = isConfiguredAbsolutePath(chip.workspaceDir);
  if (!usesAbsoluteWorkspace && !isSafeRelativeWorkspaceDir(chip.workspaceDir)) {
    throw new ChipWorkspaceError(`Workspace directory must be an absolute path or safe relative path: ${chip.workspaceDir}`, 400);
  }

  let realRoot: string | undefined;
  if (!usesAbsoluteWorkspace) {
    try {
      realRoot = await realpath(catalog.knowledgeBaseRoot);
    } catch {
      throw new ChipWorkspaceError(
        `Knowledge base root does not exist: ${catalog.knowledgeBaseRoot}`,
        400
      );
    }
  }

  const workspaceAbs = usesAbsoluteWorkspace ? chip.workspaceDir : join(catalog.knowledgeBaseRoot, chip.workspaceDir);

  // Check if workspace is a directory (not a file)
  let realWorkspace: string;
  try {
    // Use realpath to resolve symlinks
    realWorkspace = await realpath(workspaceAbs);
  } catch {
    throw new ChipWorkspaceError(`Workspace directory does not exist: ${chip.workspaceDir}`, 400);
  }

  // Validate it's a directory, not a file
  try {
    const stats = await stat(realWorkspace);
    if (!stats.isDirectory()) {
      throw new ChipWorkspaceError(
        `Workspace path is not a directory: ${chip.workspaceDir}`,
        400
      );
    }
  } catch (err) {
    if (err instanceof ChipWorkspaceError) {
      throw err;
    }
    // stat failed (e.g., path doesn't exist after symlink resolution)
    throw new ChipWorkspaceError(`Workspace directory does not exist: ${chip.workspaceDir}`, 400);
  }

  // Validate legacy relative workspaces stay inside knowledgeBaseRoot.
  if (realRoot && !isPathInside(realWorkspace, realRoot)) {
    throw new ChipWorkspaceError(
      `Workspace directory is outside knowledge base root: ${chip.workspaceDir}`,
      400
    );
  }

  return {
    chipId: chip.id,
    label: chip.label,
    cwd: realWorkspace
  };
}
