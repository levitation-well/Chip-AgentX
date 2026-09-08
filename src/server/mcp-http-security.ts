import crypto from 'node:crypto';

export type CorsOrigins = '*' | string[];

export interface McpHttpSecurityConfig {
  corsOrigins: CorsOrigins;
  maxBodyBytes: number;
  maxOutputChars: number;
  maxPollTimeoutMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  verifyRateLimitMax: number;
  maxTransports: number;
  maxTransportsPerUser: number;
  transportIdleTtlMs: number;
  transportAbsoluteTtlMs: number;
  keyTouchMinIntervalMs: number;
}

export type McpHttpSecurityOptions = Partial<McpHttpSecurityConfig>;

export const DEFAULT_MCP_HTTP_SECURITY_CONFIG: McpHttpSecurityConfig = {
  corsOrigins: [],
  maxBodyBytes: 1_048_576,
  maxOutputChars: 200_000,
  maxPollTimeoutMs: 30_000,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 120,
  verifyRateLimitMax: 20,
  maxTransports: 100,
  maxTransportsPerUser: 10,
  transportIdleTtlMs: 30 * 60_000,
  transportAbsoluteTtlMs: 12 * 60 * 60_000,
  keyTouchMinIntervalMs: 60_000
};

export function resolveMcpHttpSecurityConfig(
  options: McpHttpSecurityOptions = {},
  env: NodeJS.ProcessEnv = process.env
): McpHttpSecurityConfig {
  return {
    corsOrigins: options.corsOrigins ?? parseCorsOrigins(env.AGENTX_CORS_ORIGINS),
    maxBodyBytes: resolvePositiveInteger(options.maxBodyBytes, env.AGENTX_MCP_MAX_BODY_BYTES, DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxBodyBytes),
    maxOutputChars: resolvePositiveInteger(options.maxOutputChars, env.AGENTX_MCP_MAX_OUTPUT_CHARS, DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxOutputChars),
    maxPollTimeoutMs: resolvePositiveInteger(options.maxPollTimeoutMs, env.AGENTX_MCP_MAX_POLL_TIMEOUT_MS, DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxPollTimeoutMs),
    rateLimitWindowMs: resolvePositiveInteger(options.rateLimitWindowMs, env.AGENTX_MCP_RATE_LIMIT_WINDOW_MS, DEFAULT_MCP_HTTP_SECURITY_CONFIG.rateLimitWindowMs),
    rateLimitMax: resolvePositiveInteger(options.rateLimitMax, env.AGENTX_MCP_RATE_LIMIT_MAX, DEFAULT_MCP_HTTP_SECURITY_CONFIG.rateLimitMax),
    verifyRateLimitMax: resolvePositiveInteger(options.verifyRateLimitMax, env.AGENTX_MCP_VERIFY_RATE_LIMIT_MAX, DEFAULT_MCP_HTTP_SECURITY_CONFIG.verifyRateLimitMax),
    maxTransports: resolvePositiveInteger(options.maxTransports, env.AGENTX_MCP_MAX_TRANSPORTS, DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxTransports),
    maxTransportsPerUser: resolvePositiveInteger(
      options.maxTransportsPerUser,
      env.AGENTX_MCP_MAX_TRANSPORTS_PER_USER,
      DEFAULT_MCP_HTTP_SECURITY_CONFIG.maxTransportsPerUser
    ),
    transportIdleTtlMs: resolvePositiveInteger(
      options.transportIdleTtlMs,
      env.AGENTX_MCP_TRANSPORT_IDLE_TTL_MS,
      DEFAULT_MCP_HTTP_SECURITY_CONFIG.transportIdleTtlMs
    ),
    transportAbsoluteTtlMs: resolvePositiveInteger(
      options.transportAbsoluteTtlMs,
      env.AGENTX_MCP_TRANSPORT_ABSOLUTE_TTL_MS,
      DEFAULT_MCP_HTTP_SECURITY_CONFIG.transportAbsoluteTtlMs
    ),
    keyTouchMinIntervalMs: resolveNonNegativeInteger(
      options.keyTouchMinIntervalMs,
      env.AGENTX_MCP_KEY_TOUCH_MIN_INTERVAL_MS,
      DEFAULT_MCP_HTTP_SECURITY_CONFIG.keyTouchMinIntervalMs
    )
  };
}

export function getAllowedCorsOrigin(origin: string | undefined, config: McpHttpSecurityConfig): string | undefined {
  if (!origin) {
    return undefined;
  }
  if (config.corsOrigins === '*') {
    return '*';
  }
  return config.corsOrigins.includes(origin) ? origin : undefined;
}

export function isCorsOriginAllowed(origin: string | undefined, config: McpHttpSecurityConfig): boolean {
  return !origin || getAllowedCorsOrigin(origin, config) !== undefined;
}

export function fingerprintMcpKey(keyValue: string | null | undefined): string {
  if (!keyValue) {
    return 'missing';
  }
  return crypto.createHash('sha256').update(keyValue).digest('hex').slice(0, 12);
}

function parseCorsOrigins(value: string | undefined): CorsOrigins {
  if (!value || !value.trim()) {
    return DEFAULT_MCP_HTTP_SECURITY_CONFIG.corsOrigins;
  }
  const origins = value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return origins.includes('*') ? '*' : origins;
}

function resolvePositiveInteger(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  return resolveInteger(optionValue, envValue, fallback, 1);
}

function resolveNonNegativeInteger(optionValue: number | undefined, envValue: string | undefined, fallback: number): number {
  return resolveInteger(optionValue, envValue, fallback, 0);
}

function resolveInteger(optionValue: number | undefined, envValue: string | undefined, fallback: number, min: number): number {
  const value = optionValue ?? parseEnvInteger(envValue);
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback;
}

function parseEnvInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}
