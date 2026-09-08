import type { SessionSource } from './persistence/session-history-store.js';

export type ContextBudgetEntry = SessionSource | 'chat' | 'unknown';
export type ContextBudgetExceedMode = 'reject' | 'truncate';

export interface ContextBudgetPolicy {
  maxInputTokens: number;
  maxHistoryTurns: number;
  maxTaskChars: number;
  maxSystemPromptChars: number;
  maxToolResultChars: number;
  maxSourceFragments: number;
  maxImages: number;
  onExceed: ContextBudgetExceedMode;
}

export interface ContextBudgetRequest {
  entry?: ContextBudgetEntry;
  role?: string;
  userId?: string;
  modelId?: string;
  mcpKeyFingerprint?: string;
  task?: string;
  systemPrompt?: string;
  historyTurns?: number;
  toolResultChars?: number;
  sourceFragments?: number;
  images?: number;
}

export interface ContextBudgetDecision {
  ok: boolean;
  estimated: true;
  estimatedInputTokens: number;
  policy: ContextBudgetPolicy;
  exceeded: string[];
  action: ContextBudgetExceedMode;
  reason?: string;
}

export class ContextBudgetExceededError extends Error {
  readonly statusCode = 413;
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';

  constructor(readonly decision: ContextBudgetDecision) {
    super(decision.reason ?? 'Context budget exceeded');
  }
}

const CUSTOMER_POLICY: ContextBudgetPolicy = {
  maxInputTokens: 12000,
  maxHistoryTurns: 12,
  maxTaskChars: 24000,
  maxSystemPromptChars: 16000,
  maxToolResultChars: 24000,
  maxSourceFragments: 12,
  maxImages: 4,
  onExceed: 'reject'
};

const INTERNAL_POLICY: ContextBudgetPolicy = {
  maxInputTokens: 64000,
  maxHistoryTurns: 48,
  maxTaskChars: 120000,
  maxSystemPromptChars: 64000,
  maxToolResultChars: 160000,
  maxSourceFragments: 80,
  maxImages: 12,
  onExceed: 'truncate'
};

const ADMIN_POLICY: ContextBudgetPolicy = {
  maxInputTokens: 128000,
  maxHistoryTurns: 96,
  maxTaskChars: 240000,
  maxSystemPromptChars: 128000,
  maxToolResultChars: 320000,
  maxSourceFragments: 160,
  maxImages: 24,
  onExceed: 'truncate'
};

const MCP_CUSTOMER_POLICY: ContextBudgetPolicy = {
  ...CUSTOMER_POLICY,
  maxInputTokens: 20000,
  maxTaskChars: 40000,
  maxToolResultChars: 40000,
  maxSourceFragments: 24
};

export function resolveContextBudgetPolicy(request: ContextBudgetRequest = {}): ContextBudgetPolicy {
  const role = request.role?.toLowerCase();
  const entry = request.entry;

  if (role === 'admin') {
    return { ...ADMIN_POLICY };
  }
  if (role === 'internal') {
    return { ...INTERNAL_POLICY };
  }
  if (entry === 'mcp') {
    return { ...MCP_CUSTOMER_POLICY };
  }
  return { ...CUSTOMER_POLICY };
}

export function evaluateContextBudget(request: ContextBudgetRequest): ContextBudgetDecision {
  const policy = resolveContextBudgetPolicy(request);
  const taskChars = request.task?.length ?? 0;
  const systemPromptChars = request.systemPrompt?.length ?? 0;
  const toolResultChars = request.toolResultChars ?? 0;
  const historyTurns = request.historyTurns ?? 0;
  const sourceFragments = request.sourceFragments ?? 0;
  const images = request.images ?? 0;
  const estimatedInputTokens = estimateTokensFromChars(taskChars + systemPromptChars + toolResultChars);
  const exceeded: string[] = [];

  if (estimatedInputTokens > policy.maxInputTokens) exceeded.push('maxInputTokens');
  if (historyTurns > policy.maxHistoryTurns) exceeded.push('maxHistoryTurns');
  if (taskChars > policy.maxTaskChars) exceeded.push('maxTaskChars');
  if (systemPromptChars > policy.maxSystemPromptChars) exceeded.push('maxSystemPromptChars');
  if (toolResultChars > policy.maxToolResultChars) exceeded.push('maxToolResultChars');
  if (sourceFragments > policy.maxSourceFragments) exceeded.push('maxSourceFragments');
  if (images > policy.maxImages) exceeded.push('maxImages');

  return {
    ok: exceeded.length === 0 || policy.onExceed === 'truncate',
    estimated: true,
    estimatedInputTokens,
    policy,
    exceeded,
    action: policy.onExceed,
    ...(exceeded.length > 0
      ? { reason: `Context budget exceeded: ${exceeded.join(', ')}` }
      : {})
  };
}

export function assertContextBudget(request: ContextBudgetRequest): ContextBudgetDecision {
  const decision = evaluateContextBudget(request);
  if (!decision.ok) {
    throw new ContextBudgetExceededError(decision);
  }
  return decision;
}

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}
