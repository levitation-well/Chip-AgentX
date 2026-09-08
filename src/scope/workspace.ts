import { copyFile, link, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocumentVisibility } from '../security/index.js';
import { createUsedSourceRecord, type UsedSourceRecord } from '../source-citations/index.js';
import type { ScopeSelectionAllowed } from './resolver.js';
import { decideScopeScale, ScopeTooLargeError } from './scale.js';
import { isPathInsideOrEqual } from './workspace-cleanup.js';
import {
  sanitizeWorkspaceFileName,
  toSafeWorkspaceDto,
  type ScopeWorkspaceMode,
  type ScopeWorkspaceSafeDto,
  type ScopeWorkspaceSafeFileLabel
} from './workspace-redaction.js';

export interface ScopeSourceFileManifestEntry {
  documentId: string;
  label: string;
  relativePath: string;
  chipId?: string;
  displayTitle?: string;
  sourceLabel?: string;
  sourceType?: string;
  visibility?: DocumentVisibility;
  filename?: string;
}

export interface ScopeSourceFileManifest {
  sourceRoot: string;
  files: ScopeSourceFileManifestEntry[];
}

export interface ScopeWorkspaceMaterializerOptions {
  dataDir: string;
  workspaceRoot?: string;
  preferLinkMode?: boolean;
  linkSupport?: ScopeLinkSupportDecision;
}

export interface ScopeLinkSupportDecision {
  supported: boolean;
  reason: string;
}

export interface ScopeWorkspaceMaterialization {
  workspaceId: string;
  scopeId: string;
  mode: ScopeWorkspaceMode;
  status: 'ready' | 'fallback';
  workspacePath: string;
  safeDto: ScopeWorkspaceSafeDto;
  internalManifestPath: string;
  usedSources: UsedSourceRecord[];
}

interface ValidatedSourceFile {
  documentId: string;
  label: string;
  chipId?: string;
  sourcePath: string;
  displayTitle?: string;
  sourceLabel?: string;
  sourceType?: string;
  visibility?: DocumentVisibility;
  filename?: string;
  size: number;
}

const MAX_SCOPE_WORKSPACE_FILES = 200;

export async function probeReadOnlyLinkSupport(): Promise<ScopeLinkSupportDecision> {
  if (process.platform === 'win32') {
    return {
      supported: false,
      reason: 'windows link modes cannot guarantee portable read-only isolation for scoped workspaces'
    };
  }
  return {
    supported: false,
    reason: 'link mode requires platform-specific validation before it can be enabled'
  };
}

export async function materializeScopeWorkspace(
  selection: ScopeSelectionAllowed,
  manifest: ScopeSourceFileManifest,
  options: ScopeWorkspaceMaterializerOptions
): Promise<ScopeWorkspaceMaterialization> {
  const validated = await validateManifest(manifest);
  const allowedFiles = selectAllowedFiles(selection, validated);
  const scaleDecision = decideScopeScale(allowedFiles.length, { threshold: MAX_SCOPE_WORKSPACE_FILES });
  if (scaleDecision.tier === 'large') {
    throw new ScopeTooLargeError(scaleDecision.fileCount, scaleDecision.threshold);
  }
  const workspaceRoot = path.resolve(options.workspaceRoot ?? path.join(options.dataDir, 'scope-workspaces'));
  const workspaceId = createWorkspaceId(selection.scopeId);
  const workspacePath = path.resolve(workspaceRoot, workspaceId);
  if (!isPathInsideOrEqual(workspacePath, workspaceRoot)) {
    throw new Error('scope workspace path is outside workspace root');
  }

  await mkdir(workspacePath, { recursive: true });
  try {
    const labels = allowedFiles.map(toSafeLabel);
    const usedSources = allowedFiles
      .map((file) =>
        createUsedSourceRecord({
          scopeId: selection.scopeId,
          scopePresetId: selection.scopePresetId,
          documentId: file.documentId,
          displayTitle: file.displayTitle ?? file.label,
          chipId: file.chipId,
          sourceType: file.sourceType,
          visibility: file.visibility,
          filename: file.filename,
          sourceLabel: file.sourceLabel
        })
      )
      .filter((record): record is UsedSourceRecord => record !== undefined);
    const linkSupport = options.linkSupport ?? (await probeReadOnlyLinkSupport());
    const mode: ScopeWorkspaceMode = options.preferLinkMode && linkSupport.supported ? 'link' : 'copy';
    const fallbackReason = mode === 'copy' && options.preferLinkMode ? linkSupport.reason : undefined;
    const materializedNames = new Set<string>();

    for (const file of allowedFiles) {
      const destination = path.resolve(workspacePath, getDestinationName(file, materializedNames));
      if (!isPathInsideOrEqual(destination, workspacePath)) {
        throw new Error('scope workspace destination is outside workspace root');
      }
      if (mode === 'link') {
        await link(file.sourcePath, destination);
      } else {
        await copyFile(file.sourcePath, destination);
      }
    }

    const internalManifestPath = path.resolve(workspacePath, 'scope.json');
    const safeManifest = {
      scopeId: selection.scopeId,
      scopePresetId: selection.scopePresetId,
      mode,
      fileCount: allowedFiles.length,
      labels,
      usedSources
    };
    await writeFile(internalManifestPath, `${JSON.stringify(safeManifest, null, 2)}\n`, 'utf8');

    return {
      workspaceId,
      scopeId: selection.scopeId,
      mode,
      status: fallbackReason ? 'fallback' : 'ready',
      workspacePath,
      internalManifestPath,
      usedSources,
      safeDto: toSafeWorkspaceDto({
        workspaceId,
        scopeId: selection.scopeId,
        status: fallbackReason ? 'fallback' : 'ready',
        mode,
        fileCount: allowedFiles.length,
        labels,
        ...(fallbackReason ? { fallbackReason } : {})
      })
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {
      // Preserve the materialization error; startup cleanup remains a fallback.
    });
    throw error;
  }
}

async function validateManifest(manifest: ScopeSourceFileManifest): Promise<ValidatedSourceFile[]> {
  const root = await resolveExistingDirectory(manifest.sourceRoot);
  const validated: ValidatedSourceFile[] = [];
  for (const file of manifest.files) {
    const relativePath = normalizeSafeRelativePath(file.relativePath);
    const sourcePath = path.resolve(root, relativePath);
    if (!isPathInsideOrEqual(sourcePath, root)) {
      throw new Error('manifest path is outside source root');
    }
    const realSource = await realpath(sourcePath);
    if (!isPathInsideOrEqual(realSource, root)) {
      throw new Error('manifest real path is outside source root');
    }
    const stats = await stat(realSource);
    if (!stats.isFile()) {
      throw new Error('manifest source entry must be a file');
    }
    validated.push({
      documentId: requireSafeId(file.documentId, 'documentId'),
      label: file.label,
      ...(file.chipId ? { chipId: requireSafeId(file.chipId, 'chipId') } : {}),
      ...(file.displayTitle ? { displayTitle: file.displayTitle } : {}),
      ...(file.sourceLabel ? { sourceLabel: file.sourceLabel } : {}),
      ...(file.sourceType ? { sourceType: file.sourceType } : {}),
      ...(file.visibility ? { visibility: file.visibility } : {}),
      ...(file.filename ? { filename: file.filename } : {}),
      size: stats.size,
      sourcePath: realSource
    });
  }
  return validated;
}

function selectAllowedFiles(selection: ScopeSelectionAllowed, files: ValidatedSourceFile[]): ValidatedSourceFile[] {
  const allowedDocumentIds = new Set(selection.allowedDocumentIds);
  if (allowedDocumentIds.size > 0) {
    return files.filter((file) => allowedDocumentIds.has(file.documentId));
  }
  const allowedChipIds = new Set(selection.allowedChipIds);
  return files.filter((file) => file.chipId !== undefined && allowedChipIds.has(file.chipId));
}

async function resolveExistingDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory);
  const real = await realpath(resolved);
  const stats = await stat(real);
  if (!stats.isDirectory()) {
    throw new Error('manifest source root must be a directory');
  }
  return real;
}

function normalizeSafeRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[\\/]{2}/.test(trimmed)) {
    throw new Error('manifest relativePath must be a safe relative file path');
  }
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) {
    throw new Error('manifest relativePath must not contain path traversal');
  }
  return path.join(...segments);
}

// P2-4 (multi-agent audit) hardening:
// - Reject null bytes (\0): Node.js fs treats them as string terminators, silently
//   truncating paths and bypassing the path-separator check below.
// - Reject control characters (CR/LF/TAB and friends): break shell expansion and
//   log parsing.
// - Reject Windows reserved device names (CON/PRN/AUX/NUL/COM1-9/LPT1-9):
//   path.join(cwd, 'CON') resolves to a Windows device handle.
// - Cap identifier length to 128: defense against ENAMETOOLONG and runaway IDs.
const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export function requireSafeId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${field} must be a safe identifier`);
  }
  // Reject control characters and null bytes up-front. \0 in particular is invisible
  // in logs but causes fs operations to silently truncate everything after it.
  if (/[\u0000\u0001-\u001f\u007f]/.test(trimmed)) {
    throw new Error(`${field} must not contain control characters or null bytes`);
  }
  if (!SAFE_ID_PATTERN.test(trimmed)) {
    throw new Error(`${field} must match ${SAFE_ID_PATTERN} (only ASCII alphanumerics, '.', '_', '-')`);
  }
  if (WINDOWS_RESERVED_NAMES.test(trimmed)) {
    throw new Error(`${field} is a Windows reserved device name`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`${field} must not be '.' or '..'`);
  }
  return trimmed;
}

function getDestinationName(file: ValidatedSourceFile, usedNames: Set<string>): string {
  const extension = path.extname(file.sourcePath).slice(0, 16);
  const base = sanitizeWorkspaceFileName(`${file.documentId}-${file.label}`, file.documentId);
  let candidate = extension && !base.endsWith(extension) ? `${base}${extension}` : base;
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `-${index}`;
    const stem = candidate.endsWith(extension) ? candidate.slice(0, -extension.length) : candidate;
    candidate = `${stem.slice(0, Math.max(1, 96 - suffix.length - extension.length))}${suffix}${extension}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function createWorkspaceId(scopeId: string): string {
  const sanitized = sanitizeWorkspaceFileName(scopeId, 'scope-workspace').replace(/\s+/g, '-').slice(0, 80);
  return `scope-${sanitized}`;
}

function toSafeLabel(file: ValidatedSourceFile): ScopeWorkspaceSafeFileLabel {
  return {
    documentId: file.documentId,
    label: file.label,
    ...(file.chipId ? { chipId: file.chipId } : {}),
    ...(file.displayTitle ? { displayTitle: file.displayTitle } : {}),
    ...(file.sourceLabel ? { sourceLabel: file.sourceLabel } : {}),
    ...(file.filename ? { filename: file.filename } : {}),
    ...(file.sourceType ? { sourceType: file.sourceType } : {}),
    ...(file.visibility ? { visibility: file.visibility } : {}),
    size: file.size
  };
}

export async function readScopeWorkspaceSafeManifest(workspace: ScopeWorkspaceMaterialization): Promise<unknown> {
  return JSON.parse(await readFile(workspace.internalManifestPath, 'utf8')) as unknown;
}
