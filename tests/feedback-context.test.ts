import { describe, expect, it } from 'vitest';
import {
  buildFeedbackContextSnapshot,
  normalizeFeedbackContextInput
} from '../src/source-citations/feedback-context.js';
import { createSourceCitationSummary, createUsedSourceRecord } from '../src/source-citations/index.js';
import type { SessionMeta, TranscriptEntry } from '../src/persistence/index.js';

function sessionMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  const source = createUsedSourceRecord({
    scopeId: 'scope-safe',
    scopePresetId: 'preset-safe',
    documentId: 'doc-safe',
    displayTitle: 'E522.49 Datasheet',
    filename: 'e52249.pdf',
    page: 12
  })!;
  return {
    sessionId: 'session-safe',
    userId: 'alice-id',
    username: 'alice',
    role: 'customer',
    agentType: 'claude-code',
    chipId: 'E522.49',
    scopePresetId: 'preset-safe',
    chatMode: 'enhanced',
    modelId: 'sonnet',
    creditUnits: 100,
    usedSources: [source],
    sourceCitationSummary: createSourceCitationSummary([source]),
    cwd: 'D:\\repo\\chip-agentx',
    task: 'question',
    title: 'question',
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
    outputSize: 0,
    source: 'web',
    tags: [],
    aiLabels: [],
    ...overrides
  };
}

const transcript: TranscriptEntry[] = [
  {
    role: 'user',
    turnId: 'turn-safe',
    text: 'question',
    createdAt: '2026-05-30T00:00:00.000Z',
    outputStart: 0
  }
];

describe('feedback context snapshot', () => {
  it('uses server-side session sources and ignores forged client metadata', () => {
    const input = normalizeFeedbackContextInput({
      sessionId: 'session-safe',
      turnId: 'turn-safe',
      feedbackTypes: ['bad-citation', 'safety-risk'],
      note: 'please check token=secret and D:\\private\\draft.md',
      sourceCitationSummary: {
        sources: [{ documentId: 'forged', sourcePath: 'D:\\secret\\internal.md' }]
      }
    });

    const snapshot = buildFeedbackContextSnapshot({
      meta: sessionMeta(),
      transcript,
      output: [
        JSON.stringify({
          type: 'result',
          result: [
            'Final answer: use the E522.49 current limit. Source: E522.49 Datasheet.',
            'authorization: Bearer secret-token',
            '/opt/chip-agentx/internal.md'
          ].join('\n')
        })
      ].join('\n'),
      input,
      entry: 'web',
      now: () => '2026-05-30T01:00:00.000Z'
    });

    expect(snapshot).toMatchObject({
      sessionId: 'session-safe',
      turnId: 'turn-safe',
      entry: 'web',
      reviewSignal: 'high_priority',
      chatMode: 'enhanced',
      modelId: 'sonnet',
      creditUnits: 100,
      chipId: 'E522.49',
      scopePresetId: 'preset-safe'
    });
    expect(snapshot.sourceCitationSummary.sources).toEqual([
      expect.objectContaining({ documentId: 'doc-safe', displayTitle: 'E522.49 Datasheet' })
    ]);
    expect(snapshot.answerTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.answerExcerpt).toBe('Final answer: use the E522.49 current limit. Source: E522.49 Datasheet.');
    expect(JSON.stringify(snapshot)).not.toMatch(/forged|sourcePath|authorization|secret-token|D:\\|\/opt\/agentx/i);
  });

  it('downgrades unsafe persisted source summaries instead of storing them', () => {
    const snapshot = buildFeedbackContextSnapshot({
      meta: sessionMeta({
        usedSources: undefined,
        sourceCitationSummary: {
          captureKind: 'system_captured_source_seed',
          sourceCount: 1,
          sources: [{
            captureKind: 'system_captured_source_seed',
            scopeId: 'scope-safe',
            scopePresetId: 'preset-safe',
            documentId: 'doc-safe',
            displayTitle: 'D:\\private\\source.pdf'
          }]
        }
      }),
      transcript,
      output: JSON.stringify({ type: 'result', result: 'Final answer: safe answer. Source: internal.' }),
      input: normalizeFeedbackContextInput({
        sessionId: 'session-safe',
        turnId: 'turn-safe',
        feedbackTypes: ['missing-context']
      }),
      entry: 'web'
    });

    expect(snapshot.sourceCitationSummary.sourceCount).toBe(0);
    expect(snapshot.outputMeta.citationWarnings).toContain('unsafe-citation-dropped');
    expect(JSON.stringify(snapshot)).not.toMatch(/D:\\|private\\source/i);
  });
});
