import type { CliErrorPayload, CliStableErrorCode } from './types.js';

const SECRET_KEY_PATTERN = /(authorization|api[_-]?key|token|jwt|cookie|password|mcp[_-]?key|secret)/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|token|jwt|cookie|password|mcp[_-]?key|secret)\b\s*[:=]\s*([^\s,;]+)/gi;

export const CLI_EXIT_CODES: Record<CliStableErrorCode, number> = {
  VALIDATION_ERROR: 2,
  AUTH_REQUIRED: 3,
  FORBIDDEN: 4,
  NOT_FOUND: 5,
  CONFLICT: 6,
  INSUFFICIENT_CREDITS: 7,
  RATE_LIMITED: 8,
  NETWORK_ERROR: 9,
  SERVER_ERROR: 10,
  UNSUPPORTED_OPERATION: 11
};

export class CliError extends Error {
  readonly exitCode: number;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    readonly code: CliStableErrorCode,
    message: string,
    options: {
      exitCode?: number;
      statusCode?: number;
      requestId?: string;
      details?: Record<string, unknown>;
    } = {}
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? CLI_EXIT_CODES[code];
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export function createCliError(
  code: CliStableErrorCode,
  message: string,
  options?: {
    statusCode?: number;
    requestId?: string;
    details?: Record<string, unknown>;
  }
): CliError {
  return new CliError(code, message, options);
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return createCliError('SERVER_ERROR', error.message);
  }
  return createCliError('SERVER_ERROR', String(error));
}

export function mapHttpStatusToCliErrorCode(statusCode: number, upstreamCode?: string): CliStableErrorCode {
  if (upstreamCode === 'INSUFFICIENT_CREDITS' || statusCode === 402) {
    return 'INSUFFICIENT_CREDITS';
  }
  if (statusCode === 400) return 'VALIDATION_ERROR';
  if (statusCode === 401) return 'AUTH_REQUIRED';
  if (statusCode === 403) return 'FORBIDDEN';
  if (statusCode === 404) return 'NOT_FOUND';
  if (statusCode === 405 || statusCode === 501) return 'UNSUPPORTED_OPERATION';
  if (statusCode === 409) return 'CONFLICT';
  if (statusCode === 429) return 'RATE_LIMITED';
  if (statusCode >= 400 && statusCode < 500) return 'VALIDATION_ERROR';
  return 'SERVER_ERROR';
}

export function toCliErrorPayload(error: CliError): CliErrorPayload {
  return {
    code: error.code,
    message: sanitizeSecretLikeString(error.message),
    exitCode: error.exitCode,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.details ? { details: sanitizeSecretLikeValue(error.details) as Record<string, unknown> } : {})
  };
}

export function sanitizeSecretLikeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return sanitizeSecretLikeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretLikeValue(item));
  }
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeSecretLikeValue(nestedValue);
    }
    return sanitized;
  }
  return value;
}

export function sanitizeSecretLikeString(value: string): string {
  return value
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, key) => `${key}=[REDACTED]`);
}
