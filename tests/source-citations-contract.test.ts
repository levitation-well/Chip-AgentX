import { describe, expect, it } from 'vitest';
import {
  assertNoUnsafeSourceCitationFields,
  createSourceCitationSummary,
  createUsedSourceRecord
} from '../src/source-citations/index.js';

describe('source citation contract sanitizer', () => {
  it('keeps only safe source citation fields and strips path-like metadata', () => {
    const record = createUsedSourceRecord({
      scopeId: 'scope-preset-elmos-lighting:E522.94',
      scopePresetId: 'scope-preset-elmos-lighting',
      documentId: 'doc-e52294-datasheet',
      displayTitle: 'D:\\private\\kb\\E522.94.pdf',
      chipId: 'E522.94',
      sourceType: 'catalog_document',
      visibility: 'customer',
      filename: 'D:\\private\\kb\\E522.94.pdf',
      section: 'Electrical characteristics',
      page: '12',
      snippetLabel: '/opt/agentx/private/snippet.md',
      sourceLabel: 'E522.94 datasheet'
    });

    expect(record).toEqual(
      expect.objectContaining({
        captureKind: 'system_captured_source_seed',
        scopeId: 'scope-preset-elmos-lighting:E522.94',
        scopePresetId: 'scope-preset-elmos-lighting',
        documentId: 'doc-e52294-datasheet',
        displayTitle: 'doc-e52294-datasheet',
        chipId: 'E522.94',
        sourceType: 'catalog_document',
        visibility: 'customer',
        section: 'Electrical characteristics',
        page: '12',
        sourceLabel: 'E522.94 datasheet'
      })
    );
    expect(record).not.toHaveProperty('filename');
    expect(record).not.toHaveProperty('snippetLabel');
    expect(JSON.stringify(record)).not.toMatch(/D:\\|\/opt|private|sourcePath|workspacePath|internalManifestPath/i);
  });

  it('creates stable public summaries without internal paths or duplicate source rows', () => {
    const first = createUsedSourceRecord({
      scopeId: 'scope-a',
      scopePresetId: 'preset-a',
      documentId: 'doc-a',
      displayTitle: 'Application Note A',
      filename: 'app-note-a.pdf',
      page: 3
    });
    const duplicate = createUsedSourceRecord({
      scopeId: 'scope-a',
      scopePresetId: 'preset-a',
      documentId: 'doc-a',
      displayTitle: 'Application Note A',
      filename: 'app-note-a.pdf',
      page: 3
    });
    const summary = createSourceCitationSummary([first!, duplicate!]);

    expect(summary).toEqual({
      captureKind: 'system_captured_source_seed',
      sourceCount: 1,
      sources: [
        expect.objectContaining({
          documentId: 'doc-a',
          displayTitle: 'Application Note A',
          filename: 'app-note-a.pdf',
          page: '3'
        })
      ]
    });
    expect(() => assertNoUnsafeSourceCitationFields(summary)).not.toThrow();
  });

  it('rejects unsafe serialized citation payloads during defensive checks', () => {
    expect(() =>
      assertNoUnsafeSourceCitationFields({
        sources: [{ documentId: 'doc-a', sourcePath: 'D:\\private\\doc-a.pdf' }]
      })
    ).toThrow(/unsafe path-like/);
  });
});
