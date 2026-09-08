export type CliStableErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_CREDITS'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'SERVER_ERROR'
  | 'UNSUPPORTED_OPERATION';

export type CliConfigValueSource = 'flag' | 'env' | 'stdin' | 'default' | 'none';

export type CliAuthMode = 'none' | 'bearer-token' | 'mcp-key' | 'password';

export interface CliCommonOptions {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  username?: string;
  passwordStdin?: boolean;
  mcpKey?: string;
  timeout?: string | number;
  json?: boolean;
}

export interface ResolvedCliValue<T> {
  value: T;
  source: CliConfigValueSource;
}

export interface ResolvedCliAuth {
  mode: CliAuthMode;
  source: CliConfigValueSource;
  token?: string;
  mcpKey?: string;
  username?: string;
  password?: string;
}

export interface ResolvedCliConfig {
  baseUrl: string;
  timeoutMs: number;
  json: boolean;
  auth: ResolvedCliAuth;
}

export interface CliErrorPayload {
  code: CliStableErrorCode;
  message: string;
  exitCode: number;
  statusCode?: number;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface CliJsonSuccess<T = unknown> {
  ok: true;
  data: T;
}

export interface CliJsonError {
  ok: false;
  error: CliErrorPayload;
}

export interface HttpClientRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpClientMultipartField {
  name: string;
  value: string | Uint8Array | Blob;
  filename?: string;
  contentType?: string;
}

export interface HttpClientMultipartRequestOptions {
  method?: 'POST' | 'PUT' | 'PATCH';
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  fields: HttpClientMultipartField[];
}

export interface HttpClientDownloadOptions {
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
}

export interface HttpClientResponse<T> {
  statusCode: number;
  requestId?: string;
  headers: Record<string, string>;
  data: T;
}

export interface HttpClientDownloadResponse {
  statusCode: number;
  requestId?: string;
  headers: Record<string, string>;
  body: Uint8Array;
}
