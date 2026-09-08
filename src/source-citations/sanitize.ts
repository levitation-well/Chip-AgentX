import type {
  PublicSourceCitationDto,
  SourceCitationMetadataInput,
  SourceCitationSummary,
  UsedSourceRecord
} from './types.js';

const CAPTURE_KIND = 'system_captured_source_seed' as const;
const MAX_TEXT_LENGTH = 160;
const MAX_ID_LENGTH = 128;

export function createUsedSourceRecord(input: SourceCitationMetadataInput): UsedSourceRecord | undefined {
  const scopeId = sanitizeIdentifier(input.scopeId);
  const scopePresetId = sanitizeIdentifier(input.scopePresetId);
  const documentId = sanitizeIdentifier(input.documentId);
  if (!scopeId || !scopePresetId || !documentId) {
    return undefined;
  }

  const displayTitle = sanitizeText(input.displayTitle, documentId) ?? documentId;
  const filename = sanitizeFilename(input.filename);
  const section = sanitizeText(input.section);
  const page = sanitizePage(input.page);
  const snippetLabel = sanitizeText(input.snippetLabel);
  const sourceLabel = sanitizeText(input.sourceLabel);
  const chipId = sanitizeIdentifier(input.chipId);
  const sourceType = sanitizeText(input.sourceType);

  return {
    captureKind: CAPTURE_KIND,
    scopeId,
    scopePresetId,
    documentId,
    displayTitle,
    ...(chipId ? { chipId } : {}),
    ...(sourceType ? { sourceType } : {}),
    ...(input.visibility ? { visibility: input.visibility } : {}),
    ...(filename ? { filename } : {}),
    ...(section ? { section } : {}),
    ...(page ? { page } : {}),
    ...(snippetLabel ? { snippetLabel } : {}),
    ...(sourceLabel ? { sourceLabel } : {})
  };
}

export function toPublicSourceCitationDto(record: UsedSourceRecord): PublicSourceCitationDto {
  return {
    captureKind: CAPTURE_KIND,
    scopeId: record.scopeId,
    scopePresetId: record.scopePresetId,
    documentId: record.documentId,
    displayTitle: record.displayTitle,
    ...(record.chipId ? { chipId: record.chipId } : {}),
    ...(record.sourceType ? { sourceType: record.sourceType } : {}),
    ...(record.visibility ? { visibility: record.visibility } : {}),
    ...(record.filename ? { filename: record.filename } : {}),
    ...(record.section ? { section: record.section } : {}),
    ...(record.page ? { page: record.page } : {}),
    ...(record.snippetLabel ? { snippetLabel: record.snippetLabel } : {}),
    ...(record.sourceLabel ? { sourceLabel: record.sourceLabel } : {})
  };
}

export function createSourceCitationSummary(records: readonly UsedSourceRecord[]): SourceCitationSummary {
  const sources = dedupeSources(records).map(toPublicSourceCitationDto);
  return {
    captureKind: CAPTURE_KIND,
    sourceCount: sources.length,
    sources
  };
}

export function assertNoUnsafeSourceCitationFields(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return;
  }
  if (
    /(?:sourceRoot|sourcePath|workspacePath|storagePath|internalManifestPath|knowledgeBaseRoot|serverPath)/i.test(serialized) ||
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?:tmp|srv|opt|home|var|workspace)\b)/i.test(serialized)
  ) {
    throw new Error('source citation metadata contains unsafe path-like fields');
  }
}

function dedupeSources(records: readonly UsedSourceRecord[]): UsedSourceRecord[] {
  const seen = new Set<string>();
  const result: UsedSourceRecord[] = [];
  for (const record of records) {
    const key = [record.scopeId, record.scopePresetId, record.documentId, record.chipId ?? '', record.displayTitle].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(record);
  }
  return result;
}

function sanitizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || isPathLike(trimmed) || looksSecretLike(trimmed)) {
    return undefined;
  }
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH);
  return sanitized && sanitized !== '.' && sanitized !== '..' ? sanitized : undefined;
}

function sanitizeText(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return fallback;
  }
  const trimmed = String(value).trim();
  if (!trimmed || isPathLike(trimmed) || looksSecretLike(trimmed)) {
    return fallback;
  }
  const sanitized = trimmed.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, MAX_TEXT_LENGTH);
  return sanitized || fallback;
}

function sanitizeFilename(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || isPathLike(trimmed) || looksSecretLike(trimmed)) {
    return undefined;
  }
  if (/[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    return undefined;
  }
  return trimmed.replace(/[^A-Za-z0-9._ -]+/g, '-').slice(0, 120) || undefined;
}

function sanitizePage(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const text = String(value).trim();
  if (!text || isPathLike(text) || looksSecretLike(text)) {
    return undefined;
  }
  return text.replace(/[^A-Za-z0-9 ._-]+/g, '').slice(0, 32) || undefined;
}

function isPathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\\\') ||
    /^\/(?:tmp|srv|opt|home|var|workspace|etc|root)\b/i.test(value) ||
    value.includes('\\') ||
    /\.\.[\\/]/.test(value) ||
    /[\\/][^\\/]+\.(?:pdf|md|txt|json|csv|docx?|xlsx?)$/i.test(value);
}

function looksSecretLike(value: string): boolean {
  return /\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|jwt|cookie)\b\s*[:=]/i.test(value) ||
    /\bsk-[A-Za-z0-9_-]{16,}\b/.test(value);
}
