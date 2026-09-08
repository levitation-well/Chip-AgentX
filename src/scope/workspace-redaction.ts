export type ScopeWorkspaceMode = 'link' | 'copy';
export type ScopeWorkspaceStatus = 'ready' | 'fallback' | 'failed' | 'cleaned';

export interface ScopeWorkspaceSafeFileLabel {
  documentId: string;
  label: string;
  chipId?: string;
  displayTitle?: string;
  sourceLabel?: string;
  filename?: string;
  sourceType?: string;
  visibility?: string;
  size?: number;
}

export interface ScopeWorkspaceSafeDto {
  workspaceId: string;
  scopeId: string;
  status: ScopeWorkspaceStatus;
  mode: ScopeWorkspaceMode;
  fileCount: number;
  labels: ScopeWorkspaceSafeFileLabel[];
  fallbackReason?: string;
}

export function toSafeWorkspaceDto(input: {
  workspaceId: string;
  scopeId: string;
  status: ScopeWorkspaceStatus;
  mode: ScopeWorkspaceMode;
  fileCount: number;
  labels: ScopeWorkspaceSafeFileLabel[];
  fallbackReason?: string;
}): ScopeWorkspaceSafeDto {
  return {
    workspaceId: sanitizeIdentifier(input.workspaceId, 'scope-workspace'),
    scopeId: sanitizeIdentifier(input.scopeId, 'scope'),
    status: input.status,
    mode: input.mode,
    fileCount: input.fileCount,
    labels: input.labels.map((label) => ({
      documentId: sanitizeIdentifier(label.documentId, 'document'),
      label: sanitizeLabel(label.label, label.documentId),
      ...(label.chipId ? { chipId: sanitizeIdentifier(label.chipId, 'chip') } : {}),
      ...(label.displayTitle ? { displayTitle: sanitizeLabel(label.displayTitle, label.documentId) } : {}),
      ...(label.sourceLabel ? { sourceLabel: sanitizeLabel(label.sourceLabel, label.documentId) } : {}),
      ...(label.filename ? { filename: sanitizeFileName(label.filename) } : {}),
      ...(label.sourceType ? { sourceType: sanitizeLabel(label.sourceType, 'document') } : {}),
      ...(label.visibility ? { visibility: sanitizeIdentifier(label.visibility, 'restricted') } : {}),
      ...(typeof label.size === 'number' && Number.isFinite(label.size) && label.size >= 0 ? { size: label.size } : {})
    })),
    ...(input.fallbackReason ? { fallbackReason: sanitizeLabel(input.fallbackReason, 'fallback') } : {})
  };
}

function sanitizeFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || isPathLike(trimmed) || /[/\\]/.test(trimmed)) {
    return '';
  }
  return sanitizeWorkspaceFileName(trimmed, '').slice(0, 120);
}

export function sanitizeWorkspaceFileName(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[/\\:]+/g, '-')
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

function sanitizeIdentifier(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[/\\:]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : fallback;
}

function sanitizeLabel(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed || isPathLike(trimmed)) {
    return sanitizeIdentifier(fallback, 'resource');
  }
  return trimmed.replace(/[\r\n\t]+/g, ' ').slice(0, 160);
}

function isPathLike(value: string): boolean {
  return /^[a-z]:\\/i.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.includes('\\');
}
