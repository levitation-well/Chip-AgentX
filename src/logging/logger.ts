import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  requestId?: string;
  sessionId?: string;
  userId?: string;
  metadata?: unknown;
}

export interface LoggerOptions {
  dataDir?: string;
  fileLogging?: boolean;
  writeStdout?: (line: string) => void;
  now?: () => Date;
}

export interface LogContext {
  requestId?: string;
  sessionId?: string;
  userId?: string;
  metadata?: unknown;
}

export interface Logger {
  debug(event: string, message: string, context?: LogContext): LogRecord;
  info(event: string, message: string, context?: LogContext): LogRecord;
  warn(event: string, message: string, context?: LogContext): LogRecord;
  error(event: string, message: string, context?: LogContext): LogRecord;
  log(level: LogLevel, event: string, message: string, context?: LogContext): LogRecord;
}

export interface AuditLogger {
  log(event: string, message: string, context?: LogContext): LogRecord;
}

export interface CleanupOldLogFilesOptions {
  dataDir: string;
  retentionDays?: number;
  now?: Date;
}

export const LOG_EVENTS = {
  serverStarted: 'server_started',
  configLoaded: 'config_loaded',
  dataDirInitialized: 'data_dir_initialized',
  httpRequest: 'http_request',
  sessionSpawn: 'session_spawn',
  sessionSend: 'session_send',
  sessionOutputSummary: 'session_output_summary',
  sessionExit: 'session_exit',
  sessionKill: 'session_kill',
  sessionTimeout: 'session_timeout',
  persistError: 'persist_error',
  loginSuccess: 'login_success',
  loginFailure: 'login_failure',
  mcpKeyVerify: 'mcp_key_verify',
  adminUserUpdate: 'admin_user_update',
  adminRoleUpdate: 'admin_role_update',
  adminChipUpdate: 'admin_chip_update',
  adminPromptUpdate: 'admin_prompt_update',
  adminCrossUserRead: 'admin_cross_user_read',
  adminQuestionLedgerRead: 'admin_question_ledger_read',
  adminAnalysisRead: 'admin_analysis_read',
  mcpTransportOpen: 'mcp_transport_open',
  mcpTransportClose: 'mcp_transport_close',
  mcpRequestError: 'mcp_request_error',
  mcpToolCall: 'mcp_tool_call',
  mcpAuthFailure: 'mcp_auth_failure',
  mcpRateLimited: 'mcp_rate_limited',
  mcpTransportExpired: 'mcp_transport_expired',
  mcpVerify: 'mcp_verify',
  accountProfileUpdate: 'account_profile_update',
  accountPasswordChange: 'account_password_change',
  accountMcpKeyCreate: 'account_mcp_key_create',
  accountMcpKeyUpdate: 'account_mcp_key_update',
  accountMcpKeyRevoke: 'account_mcp_key_revoke',
  accountMcpKeyRegenerate: 'account_mcp_key_regenerate',
  accountLocaleUpdate: 'account_locale_update',
  accountOnboardingUpdate: 'account_onboarding_update',
  adminSelfServicePolicyUpdate: 'admin_self_service_policy_update',
  adminAuthorizationPolicyUpdate: 'admin_authorization_policy_update',
  authorizationDenied: 'authorization_denied'
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

const SENSITIVE_KEY_MARKERS = [
  'authorization',
  'cookie',
  'key',
  'password',
  'jwt',
  'token',
  'mcpkey',
  'apikey',
  'secret',
  'set-cookie'
];

const LOG_FILE_PATTERN = /^(?:app|audit)-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger('app', options);
}

export function createAuditLogger(options: LoggerOptions = {}): AuditLogger {
  const logger = new StructuredLogger('audit', options);
  return {
    log(event: string, message: string, context?: LogContext) {
      return logger.info(event, message, context);
    }
  };
}

export function cleanupOldLogFiles({
  dataDir,
  retentionDays = 30,
  now = new Date()
}: CleanupOldLogFilesOptions): void {
  const logsDir = path.join(path.resolve(dataDir), 'logs');
  if (!existsSync(logsDir)) {
    return;
  }

  const cutoffTime = startOfUtcDate(now).getTime() - retentionDays * 24 * 60 * 60 * 1000;

  for (const fileName of readdirSync(logsDir)) {
    const match = LOG_FILE_PATTERN.exec(fileName);
    if (!match) {
      continue;
    }

    const [, year, month, day] = match;
    const fileTime = Date.UTC(Number(year), Number(month) - 1, Number(day));
    if (fileTime < cutoffTime) {
      rmSync(path.join(logsDir, fileName), { force: true });
    }
  }
}

class StructuredLogger implements Logger {
  private readonly dataDir: string;
  private readonly fileLogging: boolean;
  private readonly writeStdout: (line: string) => void;
  private readonly now: () => Date;

  constructor(
    private readonly filePrefix: 'app' | 'audit',
    options: LoggerOptions
  ) {
    this.dataDir = options.dataDir ?? 'data';
    this.fileLogging = options.fileLogging ?? false;
    this.writeStdout = options.writeStdout ?? ((line: string) => process.stdout.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
  }

  debug(event: string, message: string, context?: LogContext): LogRecord {
    return this.log('debug', event, message, context);
  }

  info(event: string, message: string, context?: LogContext): LogRecord {
    return this.log('info', event, message, context);
  }

  warn(event: string, message: string, context?: LogContext): LogRecord {
    return this.log('warn', event, message, context);
  }

  error(event: string, message: string, context?: LogContext): LogRecord {
    return this.log('error', event, message, context);
  }

  log(level: LogLevel, event: string, message: string, context: LogContext = {}): LogRecord {
    const record: LogRecord = {
      timestamp: this.now().toISOString(),
      level,
      event,
      message
    };

    if (context.requestId !== undefined) {
      record.requestId = context.requestId;
    }
    if (context.sessionId !== undefined) {
      record.sessionId = context.sessionId;
    }
    if (context.userId !== undefined) {
      record.userId = context.userId;
    }
    if (context.metadata !== undefined) {
      record.metadata = redactMetadata(context.metadata);
    }

    const line = JSON.stringify(record);
    this.writeStdout(line);
    this.writeFile(line, record.timestamp);
    return record;
  }

  private writeFile(line: string, timestamp: string): void {
    if (!this.fileLogging) {
      return;
    }

    const logsDir = path.join(path.resolve(this.dataDir), 'logs');
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(path.join(logsDir, `${this.filePrefix}-${timestamp.slice(0, 10)}.jsonl`), `${line}\n`, 'utf8');
  }
}

function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactMetadata(item));
  }

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const redacted: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      redacted[key] = isSensitiveKey(key) ? '[REDACTED]' : redactMetadata(nestedValue);
    }
    return redacted;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeSensitiveKey(key);
  if (SAFE_METADATA_KEYS.has(normalized)) {
    return false;
  }
  return SENSITIVE_KEY_MARKERS.some((marker) => normalized.includes(normalizeSensitiveKey(marker)));
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const SAFE_METADATA_KEYS = new Set([
  'hasauthorization',
  'allowmcpkeyselfcreate',
  'allowmcpkeyregenerate',
  'maxmcpkeys',
  'defaultmcpkeyttldays',
  'keyfingerprint'
]);

function startOfUtcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
