import type { DocumentVisibility } from '../security/index.js';

export type UsedSourceCaptureKind = 'system_captured_source_seed';

export interface UsedSourceRecord {
  captureKind: UsedSourceCaptureKind;
  scopeId: string;
  scopePresetId: string;
  documentId: string;
  displayTitle: string;
  chipId?: string;
  sourceType?: string;
  visibility?: DocumentVisibility;
  filename?: string;
  section?: string;
  page?: string;
  snippetLabel?: string;
  sourceLabel?: string;
}

export interface PublicSourceCitationDto {
  captureKind: UsedSourceCaptureKind;
  scopeId: string;
  scopePresetId: string;
  documentId: string;
  displayTitle: string;
  chipId?: string;
  sourceType?: string;
  visibility?: DocumentVisibility;
  filename?: string;
  section?: string;
  page?: string;
  snippetLabel?: string;
  sourceLabel?: string;
}

export interface SourceCitationSummary {
  captureKind: UsedSourceCaptureKind;
  sourceCount: number;
  sources: PublicSourceCitationDto[];
}

export interface SourceCitationMetadataInput {
  scopeId: string;
  scopePresetId: string;
  documentId: string;
  displayTitle?: string;
  chipId?: string;
  sourceType?: string;
  visibility?: DocumentVisibility;
  filename?: string;
  section?: string;
  page?: string | number;
  snippetLabel?: string;
  sourceLabel?: string;
}
