import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readPublicFile(file: string): string {
  return readFileSync(path.join(root, 'public', file), 'utf8');
}

describe('source citations UI wiring', () => {
  it('renders chat citations from server DTO metadata without parsing assistant text', () => {
    const script = readPublicFile('chat.js');

    expect(script).toContain('renderCitationBlock');
    expect(script).toContain('outputMeta?.citations');
    expect(script).toContain('sourceCitationSummary');
    expect(script).toContain("i18n('chat.sources.none')");
    expect(script).toContain("i18n('chat.sources.title')");
    expect(script).toContain('outputMeta?.citationNotice');
    expect(script).toContain("captureKind !== 'system_captured_source_seed'");
    expect(script).toContain('/api/feedback/messages');
    expect(script).toContain('message-feedback-popover');
    expect(script).toContain('feedback-chip');
    expect(script).toContain('feedbackTypes: selected');
    expect(script).toContain('payload.turnId = message.turnId');
    expect(script).toContain('message-feedback-note');
    expect(script).not.toContain('sourcePath');
    expect(script).not.toContain('innerHTML');
  });

  it('exposes admin feedback filters and detail fields for citation feedback triage', () => {
    const html = readPublicFile('admin.html');
    const script = readPublicFile('admin.js');

    for (const id of [
      'ticket-admin-filter-feedback-type',
      'ticket-admin-filter-chip',
      'ticket-admin-filter-document',
      'ticket-admin-filter-scope',
      'ticket-admin-filter-model',
      'ticket-admin-filter-review-signal'
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(script).toContain('formatFeedbackSnapshotSummary');
    expect(script).toContain('formatFeedbackSources');
    expect(script).toContain("params.set('feedbackType'");
    expect(script).toContain("params.set('reviewSignal', 'high_priority')");
    expect(script).toContain('answerTextHash');
    expect(script).toContain('sourceCitationSummary');
    expect(script).not.toContain('innerHTML');
  });

  it('defines citation styles without unsafe path-specific presentation hooks', () => {
    const css = readPublicFile('styles.css');

    expect(css).toContain('.message-citations');
    expect(css).toContain('.message-feedback-compact');
    expect(css).not.toContain('sourcePath');
    expect(css).not.toContain('workspacePath');
  });
});
