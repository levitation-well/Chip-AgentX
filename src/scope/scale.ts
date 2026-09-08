export interface ScopeScaleDecision {
  tier: 'small' | 'large';
  fileCount: number;
  threshold: number;
}

export class ScopeTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(
    readonly fileCount: number,
    readonly threshold: number
  ) {
    super(
      `Scope too large: ${fileCount} files exceeds small-tier threshold ${threshold} (index mode arrives in a later version)`
    );
  }
}

export const DEFAULT_SCOPE_SMALL_THRESHOLD = 200;

export function decideScopeScale(fileCount: number, opts?: { threshold?: number }): ScopeScaleDecision {
  const threshold = opts?.threshold ?? DEFAULT_SCOPE_SMALL_THRESHOLD;
  return { tier: fileCount <= threshold ? 'small' : 'large', fileCount, threshold };
}

export class ScopeSessionDeniedError extends Error {
  readonly statusCode = 403;
}
