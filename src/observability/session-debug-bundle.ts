import { readJsonFile, writeJsonAtomic } from '../persistence/json-file.js';
import { assertSafeSessionId, getSessionFile, type PersistencePaths } from '../persistence/paths.js';
import { redactDebugText, redactDebugValue, redactSystemPromptForDebugBundle } from './redaction.js';
import type { AuditLogger, Logger } from '../logging/index.js';

export type SessionDebugBundleType = '单芯片' | '跨档两步' | '全局';

export interface SessionDebugFileEntry {
  path: string;
  size?: number;
  error?: string;
}

export interface SessionDebugStage {
  stage: string;
  status: 'ok' | 'error' | 'skipped';
  ts: string;
  /** 本阶段真实耗时（毫秒）。由调用方在阶段边界采集起止差传入；缺省时前端回退显示 ts 时刻（V16）。 */
  durationMs?: number;
  detail?: Record<string, unknown>;
  artifact?: unknown;
}

export interface SessionDebugBundle {
  sessionId: string;
  type: SessionDebugBundleType;
  createdAt: string;
  systemPrompt?: {
    text: string;
    truncated: boolean;
    chars: number;
    redacted: string[];
  };
  stages: SessionDebugStage[];
  failure?: {
    stage: string;
    error: string;
    partialWorkspaceTree?: SessionDebugFileEntry[];
  };
}

export interface SessionDebugBundlePatch {
  type?: SessionDebugBundleType;
  systemPrompt?: string | {
    text: string;
    truncated?: boolean;
  };
  stages?: Array<{
    stage: string;
    status?: 'ok' | 'error' | 'skipped';
    durationMs?: number;
    detail?: Record<string, unknown>;
    artifact?: unknown;
  }>;
  failure?: {
    stage: string;
    error: string;
    partialWorkspaceTree?: SessionDebugFileEntry[];
  };
}

export interface SessionDebugBundleStoreOptions {
  paths: PersistencePaths;
  logger?: Logger;
  auditLogger?: AuditLogger;
  now?: () => Date;
  softLimitBytes?: number;
  textFieldLimitChars?: number;
}

const DEBUG_FILE_NAME = 'debug.json';
const DEFAULT_TYPE: SessionDebugBundleType = '全局';
const MAX_TEXT_CHARS = 16 * 1024;
const SOFT_BUNDLE_BYTES = 128 * 1024;
const MAX_DEBUG_ARRAY_ITEMS = 40;

export class SessionDebugBundleStore {
  private readonly paths: PersistencePaths;
  private readonly logger?: Logger;
  private readonly auditLogger?: AuditLogger;
  private readonly now: () => Date;
  private readonly softLimitBytes: number;
  private readonly textFieldLimitChars: number;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: SessionDebugBundleStoreOptions) {
    this.paths = options.paths;
    this.logger = options.logger;
    this.auditLogger = options.auditLogger;
    this.now = options.now ?? (() => new Date());
    this.softLimitBytes = options.softLimitBytes ?? SOFT_BUNDLE_BYTES;
    this.textFieldLimitChars = options.textFieldLimitChars ?? MAX_TEXT_CHARS;
  }

  async get(sessionId: string): Promise<SessionDebugBundle | undefined> {
    const safeSessionId = assertSafeSessionId(sessionId);
    await this.writeChains.get(safeSessionId)?.catch(() => {});
    return readJsonFile<SessionDebugBundle | undefined>(this.filePath(safeSessionId), undefined);
  }

  write(sessionId: string, patch: SessionDebugBundlePatch): Promise<void> {
    const safeSessionId = assertSafeSessionId(sessionId);
    const previous = this.writeChains.get(safeSessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => {
        // A prior failed write should not block later diagnostic snapshots.
      })
      .then(() => this.writeUnlocked(safeSessionId, patch))
      .catch((error) => {
        const message = redactDebugText(error instanceof Error ? error.message : String(error)).text;
        try {
          this.logger?.warn?.('session_debug_bundle_write_failed', 'Failed to write session debug bundle', {
            sessionId: safeSessionId,
            metadata: { error: message }
          });
        } catch {
          // Diagnostic logging must never make fire-and-forget debug writes observable to callers.
        }
        try {
          this.auditLogger?.log('session_debug_bundle_write_failed', 'Failed to write session debug bundle', {
            sessionId: safeSessionId,
            metadata: { error: message }
          });
        } catch {
          // Same isolation guarantee for audit sinks.
        }
      });
    const tracked = next.finally(() => {
      if (this.writeChains.get(safeSessionId) === tracked) {
        this.writeChains.delete(safeSessionId);
      }
    });
    this.writeChains.set(safeSessionId, tracked);
    return next;
  }

  private async writeUnlocked(sessionId: string, patch: SessionDebugBundlePatch): Promise<void> {
    const existing = await readJsonFile<SessionDebugBundle | undefined>(this.filePath(sessionId), undefined);
    const now = this.now().toISOString();
    const bundle: SessionDebugBundle = existing ?? {
      sessionId,
      type: patch.type ?? DEFAULT_TYPE,
      createdAt: now,
      stages: []
    };

    if (patch.type) {
      bundle.type = patch.type;
    }
    if (patch.systemPrompt) {
      const promptText = typeof patch.systemPrompt === 'string' ? patch.systemPrompt : patch.systemPrompt.text;
      bundle.systemPrompt = redactDiagnosticText(promptText, this.textFieldLimitChars);
    }
    if (patch.stages) {
      for (const stage of patch.stages) {
        const entry: SessionDebugStage = {
          stage: stage.stage,
          status: stage.status ?? 'ok',
          ts: now,
          ...(stage.durationMs !== undefined ? { durationMs: stage.durationMs } : {}),
          ...(stage.detail ? { detail: normalizeDebugPayload(stage.detail, this.textFieldLimitChars) as Record<string, unknown> } : {}),
          ...(stage.artifact !== undefined ? { artifact: normalizeDebugPayload(stage.artifact, this.textFieldLimitChars) } : {})
        };
        const index = bundle.stages.findIndex((item) => item.stage === entry.stage);
        if (index >= 0) {
          bundle.stages[index] = { ...bundle.stages[index], ...entry };
        } else {
          bundle.stages.push(entry);
        }
      }
    }
    if (patch.failure) {
      const failure = redactDebugValue({
        stage: patch.failure.stage,
        error: patch.failure.error,
        ...(patch.failure.partialWorkspaceTree ? { partialWorkspaceTree: patch.failure.partialWorkspaceTree } : {})
      });
      if (Array.isArray(failure.partialWorkspaceTree)) {
        failure.partialWorkspaceTree = capArray(failure.partialWorkspaceTree) as SessionDebugFileEntry[];
      }
      bundle.failure = failure;
    }

    await writeJsonAtomic(this.filePath(sessionId), enforceBundleSoftLimit(bundle, this.softLimitBytes));
  }

  private filePath(sessionId: string): string {
    return getSessionFile(this.paths, sessionId, DEBUG_FILE_NAME);
  }
}

function normalizeDebugPayload(value: unknown, textLimit: number): unknown {
  return truncateLargeStrings(value, textLimit);
}

function truncateLargeStrings(value: unknown, textLimit: number, key = ''): unknown {
  if (typeof value === 'string') {
    if (isRawDiagnosticTextKey(key)) {
      return redactDiagnosticText(value, textLimit);
    }
    return truncateTextField(redactDebugText(value).text, textLimit).text;
  }
  if (Array.isArray(value)) {
    return capArray(value).map((item) => truncateLargeStrings(item, textLimit));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveDebugKey(key) ? '[REDACTED_SECRET]' : truncateLargeStrings(nested, textLimit, key);
      if (typeof nested === 'string' && nested.length > textLimit) {
        output[`${key}Truncated`] = true;
      }
    }
    return output;
  }
  return value;
}

function capArray(value: unknown[]): unknown[] {
  if (value.length <= MAX_DEBUG_ARRAY_ITEMS) {
    return value;
  }
  return [
    ...value.slice(0, MAX_DEBUG_ARRAY_ITEMS),
    {
      truncated: true,
      omittedCount: value.length - MAX_DEBUG_ARRAY_ITEMS
    }
  ];
}

function isRawDiagnosticTextKey(key: string): boolean {
  return /(?:^|_)(systemPrompt|prompt|response|answer|output|rawText|rawOutput|finalOutput|intermediateOutput|final|intermediate)(?:$|_)/i.test(key);
}

function isSensitiveDebugKey(key: string): boolean {
  return /(authorization|cookie|password|jwt|token|secret|api[_-]?key|mcp[_-]?key)/i.test(key);
}

function redactDiagnosticText(
  text: string,
  limit = MAX_TEXT_CHARS
): { text: string; truncated: boolean; chars: number; redacted: string[] } {
  const redacted = redactSystemPromptForDebugBundle(text);
  const truncated = truncateTextField(redacted.text, limit);
  return {
    text: truncated.text,
    truncated: truncated.truncated,
    chars: text.length,
    redacted: redacted.redacted
  };
}

function truncateTextField(text: string, limit = MAX_TEXT_CHARS, alreadyTruncated = false): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: alreadyTruncated };
  }
  return { text: text.slice(0, limit), truncated: true };
}

function enforceBundleSoftLimit(bundle: SessionDebugBundle, softLimitBytes = SOFT_BUNDLE_BYTES): SessionDebugBundle {
  let serialized = JSON.stringify(bundle);
  if (Buffer.byteLength(serialized, 'utf8') <= softLimitBytes) {
    return bundle;
  }

  const copy: SessionDebugBundle = JSON.parse(serialized) as SessionDebugBundle;
  const stageTextFields: Array<{ stageIndex: number; path: Array<string | number>; length: number }> = [];
  copy.stages.forEach((stage, stageIndex) => {
    collectStageTextFields(stage.artifact, stageIndex, ['artifact'], stageTextFields);
    collectStageTextFields(stage.detail, stageIndex, ['detail'], stageTextFields);
  });

  stageTextFields.sort((left, right) => right.length - left.length);
  for (const field of stageTextFields) {
    while (Buffer.byteLength(serialized, 'utf8') > softLimitBytes) {
      const stage = copy.stages[field.stageIndex];
      if (!stage) break;
      const current = getNestedValue(stage, field.path);
      if (typeof current !== 'string' || current.length <= 1) break;
      const excess = Buffer.byteLength(serialized, 'utf8') - softLimitBytes;
      const nextLength = Math.max(1, current.length - Math.max(excess, Math.ceil(current.length / 2)));
      setNestedValue(stage, field.path, current.slice(0, nextLength));
      setTruncatedFlag(stage, field.path);
      if (nextLength >= current.length) break;
      serialized = JSON.stringify(copy);
    }
    serialized = JSON.stringify(copy);
    if (Buffer.byteLength(serialized, 'utf8') <= softLimitBytes) {
      return copy;
    }
  }

  for (const stage of copy.stages) {
    if (Buffer.byteLength(serialized, 'utf8') <= softLimitBytes) {
      return copy;
    }
    if (stage.artifact !== undefined) {
      stage.artifact = {
        truncated: true,
        reason: 'debug bundle soft limit exceeded'
      };
      serialized = JSON.stringify(copy);
    }
  }

  for (const stage of copy.stages) {
    if (Buffer.byteLength(serialized, 'utf8') <= softLimitBytes) {
      return copy;
    }
    if (stage.detail !== undefined) {
      stage.detail = {
        truncated: true,
        reason: 'debug bundle soft limit exceeded'
      };
      serialized = JSON.stringify(copy);
    }
  }

  if (copy.failure?.partialWorkspaceTree && Buffer.byteLength(serialized, 'utf8') > softLimitBytes) {
    const omittedCount = copy.failure.partialWorkspaceTree.length;
    copy.failure.partialWorkspaceTree = [{
      path: '.',
      error: `debug bundle soft limit exceeded; omitted ${omittedCount} workspace entries`
    }];
    serialized = JSON.stringify(copy);
  }

  if (Buffer.byteLength(serialized, 'utf8') > softLimitBytes) {
    return enforceStageCountLimit(copy, softLimitBytes);
  }

  return copy;
}

function collectStageTextFields(
  value: unknown,
  stageIndex: number,
  path: Array<string | number>,
  fields: Array<{ stageIndex: number; path: Array<string | number>; length: number }>
): void {
  if (typeof value === 'string') {
    fields.push({ stageIndex, path, length: value.length });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStageTextFields(item, stageIndex, [...path, index], fields));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      collectStageTextFields(nested, stageIndex, [...path, key], fields);
    }
  }
}

function getNestedValue(root: unknown, path: Array<string | number>): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown> | unknown[])[segment as never];
  }
  return current;
}

function setNestedValue(root: unknown, path: Array<string | number>, value: unknown): void {
  const parentPath = path.slice(0, -1);
  const last = path.at(-1);
  const parent = getNestedValue(root, parentPath);
  if (parent && typeof parent === 'object' && last !== undefined) {
    (parent as Record<string, unknown> | unknown[])[last as never] = value as never;
  }
}

function setTruncatedFlag(root: unknown, path: Array<string | number>): void {
  const parentPath = path.slice(0, -1);
  const last = path.at(-1);
  const parent = getNestedValue(root, parentPath);
  if (!parent || typeof parent !== 'object' || typeof last !== 'string') {
    return;
  }
  (parent as Record<string, unknown>)[`${last}Truncated`] = true;
}

function enforceStageCountLimit(bundle: SessionDebugBundle, softLimitBytes: number): SessionDebugBundle {
  const totalStages = bundle.stages.length;
  let kept = bundle.stages.slice();
  while (kept.length > 0) {
    const omittedStageCount = totalStages - kept.length;
    const candidate: SessionDebugBundle = {
      ...bundle,
      stages: [
        ...kept,
        {
          stage: 'debug.truncated',
          status: 'skipped',
          ts: bundle.createdAt,
          detail: {
            reason: 'debug bundle soft limit exceeded',
            omittedStageCount
          }
        }
      ]
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= softLimitBytes) {
      return candidate;
    }
    kept = kept.slice(0, Math.max(0, kept.length - Math.max(1, Math.ceil(kept.length / 2))));
  }

  return {
    sessionId: bundle.sessionId,
    type: bundle.type,
    createdAt: bundle.createdAt,
    stages: [{
      stage: 'debug.truncated',
      status: 'skipped',
      ts: bundle.createdAt,
      detail: {
        reason: 'debug bundle soft limit exceeded',
        omittedStageCount: totalStages
      }
    }]
  };
}
