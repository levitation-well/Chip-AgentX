import { describe, expect, it } from 'vitest';
import { projectAssistantOutput } from '../src/server/assistant-output-protocol.js';
import { createUsedSourceRecord } from '../src/source-citations/index.js';

describe('assistant output protocol projection', () => {
  it('prioritizes stream-json result text and keeps source metadata', () => {
    const projected = projectAssistantOutput([
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'I will inspect the workspace.' }] }
      }),
      JSON.stringify({
        type: 'result',
        result: 'E522.59 uses TIMER_COUNTER. Source: public datasheet section 6.'
      })
    ].join('\n'));

    expect(projected).toMatchObject({
      text: 'E522.59 uses TIMER_COUNTER. Source: public datasheet section 6.',
      source: 'result',
      metadata: {
        hasOutput: true,
        rawOutputExposed: false,
        source: 'result'
      }
    });
  });

  it('redacts tool ids, server paths, workspace paths, prompts, and token-like lines', () => {
    const projected = projectAssistantOutput([
      JSON.stringify({
        type: 'result',
        result: [
          'Final answer: E521.39 register PWM_CTRL remains valid.',
          'tool_use_id: call_abc123',
          'parent_tool_use_id: call_parent',
          '/opt/chip-agentx/datasheets/E521.39/raw.md',
          'D:\\repo\\chip-agentx\\secret.md',
          'Authorization: Bearer sk-testtokenvalue1234567890',
          '=== AGENTX WORKSPACE ==='
        ].join('\n')
      })
    ].join('\n'));

    expect(projected.text).toContain('E521.39 register PWM_CTRL remains valid.');
    expect(projected.text).not.toContain('tool_use_id');
    expect(projected.text).not.toContain('/opt/chip-agentx/datasheets');
    expect(projected.text).not.toContain('D:\\repo\\chip-agentx');
    expect(projected.text).not.toContain('Authorization');
    expect(projected.text).not.toContain('AGENTX WORKSPACE');
    expect(projected.metadata.redacted).toEqual(expect.arrayContaining([
      'secret',
      'server-path',
      'system-prompt',
      'tool-trace',
      'workspace-path'
    ]));
  });

  it('does not over-redact chip ids, register names, or public source labels', () => {
    const projected = projectAssistantOutput('E522.49: register LIN_CTRL is documented in Source: public app note.', {
      allowAssistantFallback: true
    });

    expect(projected.text).toBe('E522.49: register LIN_CTRL is documented in Source: public app note.');
    expect(projected.source).toBe('plain');
  });

  it('projects safe system-captured citation seeds into output metadata', () => {
    const usedSource = createUsedSourceRecord({
      scopeId: 'scope-elmos-lighting',
      scopePresetId: 'scope-preset-elmos-lighting',
      documentId: 'doc-e52294-datasheet',
      displayTitle: 'E522.94 Datasheet',
      filename: 'e52294-datasheet.pdf',
      section: 'Electrical characteristics',
      page: 12,
      sourceLabel: 'E522.94 datasheet'
    })!;
    const projected = projectAssistantOutput('Final answer: LIN timing is in Source: E522.94 Datasheet.', {
      allowAssistantFallback: true,
      usedSources: [usedSource]
    });

    expect(projected.metadata.citations).toMatchObject({
      captureKind: 'system_captured_source_seed',
      sourceCount: 1,
      sources: [
        expect.objectContaining({
          documentId: 'doc-e52294-datasheet',
          displayTitle: 'E522.94 Datasheet',
          filename: 'e52294-datasheet.pdf',
          section: 'Electrical characteristics',
          page: '12'
        })
      ]
    });
    expect(projected.metadata.citationNotice).toContain('system-captured source seed');
    expect(projected.metadata.citationWarnings).toEqual([]);
    expect(JSON.stringify(projected.metadata.citations)).not.toMatch(/D:\\|\/opt|sourcePath|workspacePath|token|cookie/i);
  });

  it('keeps unsafe or unmatched model source claims out of the citation block', () => {
    const projected = projectAssistantOutput([
      'Final answer: safe text.',
      'Source: D:\\private\\kb\\secret.pdf',
      'Source: Fabricated Internal Memo'
    ].join('\n'), {
      allowAssistantFallback: true,
      usedSources: [
        {
          captureKind: 'system_captured_source_seed',
          scopeId: 'scope-a',
          scopePresetId: 'preset-a',
          documentId: 'doc-a',
          displayTitle: 'D:\\private\\kb\\secret.pdf'
        } as any
      ]
    });

    expect(projected.text).toBe(['Final answer: safe text.', 'Source: Fabricated Internal Memo'].join('\n'));
    expect(projected.metadata.citations.sourceCount).toBe(0);
    expect(projected.metadata.citationWarnings).toEqual(expect.arrayContaining([
      'unmatched-model-source',
      'unsafe-citation-dropped',
      'unsafe-model-source-redacted'
    ]));
    expect(JSON.stringify(projected)).not.toMatch(/D:\\|secret\.pdf|sourcePath|workspacePath/i);
  });
});
