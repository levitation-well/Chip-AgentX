import {
  assertNoUnsafeSourceCitationFields,
  createSourceCitationSummary,
  type SourceCitationSummary,
  type UsedSourceRecord
} from '../source-citations/index.js';

export type AssistantOutputSource = 'result' | 'assistant' | 'plain' | 'empty';
export type CitationWarning =
  | 'unmatched-model-source'
  | 'unsafe-citation-dropped'
  | 'unsafe-model-source-redacted';

export interface AssistantOutputProjection {
  text: string;
  source: AssistantOutputSource;
  metadata: {
    hasOutput: boolean;
    rawOutputExposed: false;
    source: AssistantOutputSource;
    redacted: string[];
    citations: SourceCitationSummary;
    citationNotice: string;
    citationWarnings: CitationWarning[];
  };
}

export interface AssistantOutputProjectionOptions {
  allowAssistantFallback?: boolean;
  usedSources?: UsedSourceRecord[];
  sourceCitationSummary?: SourceCitationSummary;
}

const SOURCE_SEED_NOTICE =
  'usedSources is a system-captured source seed from authorized scope material, not model-generated sentence-level citation evidence.';
const NO_CITABLE_SOURCE_NOTICE = 'This turn did not use citable source material.';

const TOOL_MARKUP_PATTERNS = [
  /<tool_call>[\s\S]*?<\/tool_call>/gi,
  /<tool_use>[\s\S]*?<\/tool_use>/gi,
  /<锝滐綔DSML锝滐綔tool_calls>[\s\S]*?<\/锝滐綔DSML锝滐綔tool_calls>/g
];

const SENSITIVE_LINE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:tool_call|tool_use_id|parent_tool_use_id|server_path|system_prompt)\b/i, 'tool-trace'],
  [/\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\b\s*[:=]\s*\S+/i, 'secret'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9_]*token[A-Za-z0-9_]*\s*[:=]\s*[A-Za-z0-9._~+/=-]{16,})\b/i, 'token'],
  [/(?:^|\s)(?:[A-Za-z]:[\\/][^\s"'<>]*)/i, 'workspace-path'],
  [/(?:^|\s)(?:\\\\[^\s"'<>]+)/i, 'workspace-path'],
  [/(?:^|\s)\/(?:srv|home|workspace|tmp|var|opt|etc|root)\/[^\s"'<>]*/i, 'server-path'],
  [/^\s*(?:cwd|workspace|configured workspace directory|server path)\s*[:=]\s*.+/i, 'workspace-path'],
  [/^\s*===\s*(?:AGENTX WORKSPACE|SYSTEM|SYSTEM PROMPT)[\s\S]*$/i, 'system-prompt']
];

export function projectAssistantOutput(
  rawData: string,
  options: AssistantOutputProjectionOptions = {}
): AssistantOutputProjection {
  const text = rawData.trim();
  if (!text) {
    return createProjection('', 'empty', [], options);
  }

  const plainOutput: string[] = [];
  const assistantOutput: string[] = [];
  const resultOutput: string[] = [];
  const redacted = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate.startsWith('{')) {
      const displayText = sanitizeAssistantText(line, redacted).trim();
      if (displayText) {
        plainOutput.push(displayText);
      }
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      const parsedText = extractAssistantEventText(parsed);
      const displayText = sanitizeAssistantText(parsedText, redacted).trim();
      if (displayText) {
        if (isResultEvent(parsed)) {
          resultOutput.push(displayText);
        } else {
          assistantOutput.push(displayText);
        }
      }
    } catch {
      const displayText = sanitizeAssistantText(line, redacted).trim();
      if (displayText) {
        plainOutput.push(displayText);
      }
    }
  }

  if (resultOutput.length > 0) {
    return createProjection(joinClean(resultOutput, redacted), 'result', [...redacted], options);
  }

  if (options.allowAssistantFallback) {
    const assistantFallback = findFinalAssistantFallback(assistantOutput, redacted);
    if (assistantFallback) {
      return createProjection(assistantFallback, 'assistant', [...redacted], options);
    }
    if (plainOutput.length > 0) {
      return createProjection(joinClean(plainOutput, redacted), 'plain', [...redacted], options);
    }
  }

  return createProjection('', 'empty', [...redacted], options);
}

export function normalizeAssistantOutput(
  rawData: string,
  options: AssistantOutputProjectionOptions = {}
): string {
  return projectAssistantOutput(rawData, options).text;
}

export function sanitizePersistedAssistantText(text: string): string {
  const hadToolDump = looksLikePersistedToolDump(text);
  const redacted = new Set<string>();
  const value = sanitizeAssistantText(text, redacted).trim();
  if (!hadToolDump && !looksLikePersistedToolDump(value)) {
    return value;
  }

  const answerStart = findAnswerStart(value);
  return answerStart > 0 ? value.slice(answerStart).trim() : value;
}

function createProjection(
  text: string,
  source: AssistantOutputSource,
  redacted: string[],
  options: AssistantOutputProjectionOptions = {}
): AssistantOutputProjection {
  const redactedSet = new Set(redacted);
  const citationWarnings = new Set<CitationWarning>();
  const citations = createSafeCitationSummary(options, redactedSet, citationWarnings);
  collectCitationWarnings(text, citations, redactedSet, citationWarnings);

  return {
    text,
    source,
    metadata: {
      hasOutput: text.trim() !== '',
      rawOutputExposed: false,
      source,
      redacted: [...redactedSet].sort(),
      citations,
      citationNotice: citations.sourceCount > 0 ? SOURCE_SEED_NOTICE : NO_CITABLE_SOURCE_NOTICE,
      citationWarnings: [...citationWarnings].sort()
    }
  };
}

function createSafeCitationSummary(
  options: AssistantOutputProjectionOptions,
  redacted: Set<string>,
  warnings: Set<CitationWarning>
): SourceCitationSummary {
  const summary = options.usedSources
    ? createSourceCitationSummary(options.usedSources)
    : options.sourceCitationSummary ?? createSourceCitationSummary([]);

  try {
    assertNoUnsafeSourceCitationFields(summary);
    return cloneCitationSummary(summary);
  } catch {
    redacted.add('unsafe-citation');
    warnings.add('unsafe-citation-dropped');
    return createSourceCitationSummary([]);
  }
}

function cloneCitationSummary(summary: SourceCitationSummary): SourceCitationSummary {
  return {
    captureKind: summary.captureKind,
    sourceCount: summary.sourceCount,
    sources: summary.sources.map((source) => ({ ...source }))
  };
}

function collectCitationWarnings(
  text: string,
  citations: SourceCitationSummary,
  redacted: Set<string>,
  warnings: Set<CitationWarning>
): void {
  if (redacted.has('server-path') || redacted.has('workspace-path') || redacted.has('secret') || redacted.has('token')) {
    warnings.add('unsafe-model-source-redacted');
  }

  const sourceClaimLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(?:source|sources|reference|references)\s*[:：]/i.test(line) || /(?:来源|引用|参考资料)\s*[:：]/.test(line));
  if (sourceClaimLines.length === 0) {
    return;
  }

  if (citations.sourceCount === 0) {
    warnings.add('unmatched-model-source');
    return;
  }

  if (sourceClaimLines.some((line) => !matchesKnownSource(line, citations))) {
    warnings.add('unmatched-model-source');
  }
}

function matchesKnownSource(line: string, citations: SourceCitationSummary): boolean {
  const normalizedLine = normalizeCitationMatchText(line);
  return citations.sources.some((source) =>
    [source.displayTitle, source.filename, source.sourceLabel, source.documentId]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .some((value) => normalizedLine.includes(normalizeCitationMatchText(value)))
  );
}

function normalizeCitationMatchText(value: string): string {
  return value.toLowerCase().replace(/\.[a-z0-9]{2,8}\b/g, '').replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
}

function extractAssistantEventText(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }

  if (value.type === 'assistant' && isRecord(value.message) && Array.isArray(value.message.content)) {
    return value.message.content
      .filter((part): part is { type: string; text?: unknown } => isRecord(part) && part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  if (value.type === 'result' && value.result !== undefined) {
    return String(value.result).trim();
  }

  return '';
}

function isResultEvent(value: unknown): boolean {
  return isRecord(value) && value.type === 'result' && value.result !== undefined;
}

function sanitizeAssistantText(text: string, redacted: Set<string>): string {
  let value = text;
  for (const pattern of TOOL_MARKUP_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) {
      redacted.add('tool-markup');
      pattern.lastIndex = 0;
      value = value.replace(pattern, '');
    }
  }

  const processed = value
    .split(/\r?\n/)
    .map((line) => redactSensitiveLine(line, redacted))
    .map((line) => line.trimEnd());
  // 保留段落分隔：去首尾空行 + 连续多空行折叠成 1（脱敏已先发生，敏感内容已变空行）
  const out: string[] = [];
  for (const line of processed) {
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line.trim() === '' ? '' : line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

function redactSensitiveLine(line: string, redacted: Set<string>): string {
  for (const [pattern, reason] of SENSITIVE_LINE_PATTERNS) {
    if (pattern.test(line)) {
      redacted.add(reason);
      return '';
    }
  }
  return line;
}

function joinClean(values: string[], redacted: Set<string>): string {
  return sanitizeAssistantText(values.filter((value) => value.trim() !== '').join('\n'), redacted).trim();
}

function findFinalAssistantFallback(output: string[], redacted: Set<string>): string {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const value = sanitizePersistedAssistantText(output[index] ?? '').trim();
    if (looksLikeFinalAssistantAnswer(value)) {
      return sanitizeAssistantText(value, redacted).trim();
    }
  }
  return '';
}

function looksLikeFinalAssistantAnswer(text: string): boolean {
  if (!text) {
    return false;
  }
  if (/^let me\s+(?:search|check|inspect|read|look)|^i(?:'ll| will)\s+(?:search|check|inspect|read|look)/i.test(text)) {
    return false;
  }
  if (looksLikePersistedToolDump(text)) {
    return false;
  }
  return /[\u4e00-\u9fff]/.test(text) || /^#{1,4}\s+\S/m.test(text) || /^final answer\b/i.test(text) || text.length >= 80;
}

function looksLikePersistedToolDump(text: string): boolean {
  return /\/srv\/agentx-datasheets|(?:^|\n)[^ \n]+\.md[-:]\d+[:>-]/.test(text);
}

function findAnswerStart(text: string): number {
  const patterns = [
    /^#{1,4}\s*[\u4e00-\u9fff]+[、.．-]/m,
    /^#{1,4}\s*(?:结论|总结|答案|概述|说明|分析)/m,
    /^以下是/m,
    /^根据/m
  ];
  return patterns
    .map((pattern) => text.search(pattern))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0] ?? -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
