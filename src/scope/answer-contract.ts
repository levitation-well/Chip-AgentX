import type { ScopeSelectionAllowed } from './resolver.js';
import type { ScopeWorkspaceSafeDto } from './workspace-redaction.js';
import { createScopeShards, type ScopeShard } from './sharding.js';
import { createSourceCitationSummary, type SourceCitationSummary, type UsedSourceRecord } from '../source-citations/index.js';
import type { ResourceVisibilityCatalog } from '../security/index.js';

export interface SafeScopeSessionSummary {
  scopeId: string;
  scopePresetId: string;
  mode: 'copy' | 'link';
  fileCount: number;
  allowedChipCount: number;
  allowedDocumentCount: number;
  deniedCount: number;
  labels: ScopeWorkspaceSafeDto['labels'];
  usedSources: UsedSourceRecord[];
  sourceCitationSummary: SourceCitationSummary;
  shards: ScopeShard[];
}

/**
 * 返回给 Claude Code 后端模型的 scope 输出契约指令（英文要点）。
 * 当用户提问涉及多芯片范围时，规范模型的作答结构与诚实性约束。
 */
export function scopeOutputContractInstructions(): string {
  return [
    '=== SCOPE OUTPUT CONTRACT ===',
    'When the user asks which chips support / satisfy a feature or condition (a cross-chip query):',
    '1. Group your answer per-chip: for each chip in scope, state the chip id and provide concrete evidence',
    '   (datasheet section number, table name, register name, or exact page reference) that supports the finding.',
    '2. For every chip in scope that you checked but found no relevant support, explicitly state "no relevant support found".',
    '   Do not silently omit chips that were examined but returned no match.',
    '3. Do not fabricate or invent information that is not present in the provided datasheet content.',
    '   If a chip is not covered in the workspace, say so rather than guessing.',
    '4. Do not disclose filesystem paths, cwd values, internal manifest paths, or source directory structure',
    '   in your answer. Reference only chip ids, document titles, and section identifiers.'
  ].join('\n');
}

export function buildSafeScopeSessionSummary(input: {
  selection: ScopeSelectionAllowed;
  workspace: ScopeWorkspaceSafeDto;
  usedSources?: UsedSourceRecord[];
  resources?: ResourceVisibilityCatalog;
}): SafeScopeSessionSummary {
  const usedSources = input.usedSources ?? [];
  return {
    scopeId: input.selection.scopeId,
    scopePresetId: input.selection.scopePresetId,
    mode: input.workspace.mode,
    fileCount: input.workspace.fileCount,
    allowedChipCount: input.selection.allowedChipIds.length,
    allowedDocumentCount: input.selection.allowedDocumentIds.length,
    deniedCount: input.selection.audit.deniedCount,
    labels: input.workspace.labels.map((label) => ({ ...label })),
    usedSources: usedSources.map((source) => ({ ...source })),
    sourceCitationSummary: createSourceCitationSummary(usedSources),
    shards: createScopeShards(input.selection, input.resources)
  };
}
