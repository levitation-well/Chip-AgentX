import { describe, expect, it } from 'vitest';
import { projectAssistantOutput } from '../src/server/assistant-output-protocol.js';
import { createSourceCitationSummary, createUsedSourceRecord } from '../src/source-citations/index.js';

describe('source citation output projection', () => {
  it('projects only server-captured source seeds into user-visible metadata', () => {
    const source = createUsedSourceRecord({
      scopeId: 'scope-e522',
      scopePresetId: 'preset-lighting',
      documentId: 'doc-e522-datasheet',
      displayTitle: 'E522 Datasheet',
      filename: 'e522-datasheet.pdf',
      section: 'Electrical characteristics',
      page: 8,
      sourceLabel: 'datasheet'
    })!;

    const projected = projectAssistantOutput('Answer text. Source: E522 Datasheet, page 8.', {
      allowAssistantFallback: true,
      usedSources: [source]
    });

    expect(projected.metadata.citations).toMatchObject({
      captureKind: 'system_captured_source_seed',
      sourceCount: 1,
      sources: [
        expect.objectContaining({
          captureKind: 'system_captured_source_seed',
          documentId: 'doc-e522-datasheet',
          displayTitle: 'E522 Datasheet',
          filename: 'e522-datasheet.pdf',
          section: 'Electrical characteristics',
          page: '8'
        })
      ]
    });
    expect(projected.metadata.citationNotice).toContain('not model-generated sentence-level citation evidence');
    expect(JSON.stringify(projected)).not.toMatch(/sourcePath|workspacePath|storagePath|D:\\|\/opt\/|token|cookie|password/i);
  });

  it('drops unsafe citation summaries and flags forged model source claims', () => {
    const projected = projectAssistantOutput([
      'Answer text.',
      'Source: /opt/chip-agentx/private.md',
      'References: Unapproved Internal Upload'
    ].join('\n'), {
      allowAssistantFallback: true,
      sourceCitationSummary: createSourceCitationSummary([
        {
          captureKind: 'system_captured_source_seed',
          scopeId: 'scope-e522',
          scopePresetId: 'preset-lighting',
          documentId: 'doc-e522-datasheet',
          displayTitle: 'D:\\private\\e522.pdf'
        } as any
      ])
    });

    expect(projected.text).toBe(['Answer text.', 'References: Unapproved Internal Upload'].join('\n'));
    expect(projected.metadata.citations.sourceCount).toBe(0);
    expect(projected.metadata.citationWarnings).toEqual(expect.arrayContaining([
      'unsafe-citation-dropped',
      'unsafe-model-source-redacted',
      'unmatched-model-source'
    ]));
    expect(JSON.stringify(projected)).not.toMatch(/D:\\|\/opt\/agentx|private\.md|sourcePath|workspacePath/i);
  });
});
