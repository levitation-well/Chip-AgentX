import { randomUUID } from 'node:crypto';
import { getProductVersion } from '../product/index.js';
import { createCliError, isCliError, mapHttpStatusToCliErrorCode, sanitizeSecretLikeValue } from './errors.js';
import type {
  HttpClientDownloadOptions,
  HttpClientDownloadResponse,
  HttpClientMultipartRequestOptions,
  HttpClientRequestOptions,
  HttpClientResponse,
  ResolvedCliConfig
} from './types.js';

type FetchLike = typeof fetch;

export class CliHttpClient {
  private cachedBearerToken: string | null = null;

  constructor(
    private readonly config: ResolvedCliConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async requestJson<T>(options: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
    const response = await this.performRequest(options);
    return {
      statusCode: response.statusCode,
      requestId: response.requestId,
      headers: response.headers,
      data: response.data as T
    };
  }

  async requestMultipart<T>(options: HttpClientMultipartRequestOptions): Promise<HttpClientResponse<T>> {
    const form = new FormData();
    for (const field of options.fields) {
      if (typeof field.value === 'string') {
        form.append(field.name, field.value);
        continue;
      }
      const blob = field.value instanceof Blob
        ? field.value
        : new Blob([field.value], { type: field.contentType ?? 'application/octet-stream' });
      form.append(field.name, blob, field.filename ?? 'upload.bin');
    }
    const response = await this.performRequest({
      method: options.method ?? 'POST',
      path: options.path,
      query: options.query,
      headers: options.headers,
      body: form
    });
    return {
      statusCode: response.statusCode,
      requestId: response.requestId,
      headers: response.headers,
      data: response.data as T
    };
  }

  async download(options: HttpClientDownloadOptions): Promise<HttpClientDownloadResponse> {
    const response = await this.performRequest({
      method: 'GET',
      path: options.path,
      query: options.query,
      headers: options.headers,
      bodyType: 'binary'
    });
    return {
      statusCode: response.statusCode,
      requestId: response.requestId,
      headers: response.headers,
      body: response.data as Uint8Array
    };
  }

  private async performRequest(
    options: (HttpClientRequestOptions | HttpClientDownloadOptions) & { bodyType?: 'binary' }
  ): Promise<{ statusCode: number; requestId?: string; headers: Record<string, string>; data: unknown }> {
    const requestId = randomUUID();
    const signal = createTimeoutSignal(this.config.timeoutMs);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `agentx-cli/${getProductVersion()}`,
      'X-Request-Id': requestId,
      ...(await this.resolveAuthHeaders()),
      ...(options.headers ?? {})
    };

    let body: RequestInit['body'];
    if ('body' in options && options.body !== undefined) {
      if (options.body instanceof FormData) {
        body = options.body;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.body);
      }
    }

    try {
      const response = await this.fetchImpl(buildUrl(this.config.baseUrl, options.path, options.query), {
        method: ('method' in options ? options.method : undefined) ?? 'GET',
        headers,
        body,
        signal
      });
      return await parseResponse(response, options.bodyType === 'binary' ? 'binary' : 'json', requestId);
    } catch (error) {
      if (isCliError(error)) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw createCliError('NETWORK_ERROR', `Request timed out after ${this.config.timeoutMs}ms`, {
          requestId
        });
      }
      if (error instanceof Error) {
        throw createCliError('NETWORK_ERROR', error.message, { requestId });
      }
      throw createCliError('NETWORK_ERROR', 'Network request failed', { requestId });
    }
  }

  private async resolveAuthHeaders(): Promise<Record<string, string>> {
    if (this.config.auth.mode === 'bearer-token' && this.config.auth.token) {
      return { Authorization: `Bearer ${this.config.auth.token}` };
    }
    if (this.config.auth.mode === 'mcp-key' && this.config.auth.mcpKey) {
      return { Authorization: `Bearer ${this.config.auth.mcpKey}` };
    }
    if (this.config.auth.mode === 'password') {
      const token = await this.authenticateWithPassword();
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  }

  private async authenticateWithPassword(): Promise<string> {
    if (this.cachedBearerToken) {
      return this.cachedBearerToken;
    }
    const auth = this.config.auth;
    if (auth.mode !== 'password' || !auth.username || !auth.password) {
      throw createCliError('AUTH_REQUIRED', 'Password login is not configured.');
    }

    const requestId = randomUUID();
    const signal = createTimeoutSignal(this.config.timeoutMs);
    try {
      const response = await this.fetchImpl(buildUrl(this.config.baseUrl, '/auth/login'), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `agentx-cli/${getProductVersion()}`,
          'X-Request-Id': requestId
        },
        body: JSON.stringify({
          username: auth.username,
          password: auth.password
        }),
        signal
      });
      const parsed = await parseResponse(response, 'json', requestId);
      const token = parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>).token : undefined;
      if (typeof token !== 'string' || token.trim() === '') {
        throw createCliError('SERVER_ERROR', 'Login response did not include a bearer token.', {
          requestId: parsed.requestId
        });
      }
      this.cachedBearerToken = token;
      return token;
    } catch (error) {
      if (isCliError(error)) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw createCliError('NETWORK_ERROR', `Authentication timed out after ${this.config.timeoutMs}ms`, {
          requestId
        });
      }
      throw error;
    }
  }
}

export function createCliHttpClient(config: ResolvedCliConfig, fetchImpl?: FetchLike): CliHttpClient {
  return new CliHttpClient(config, fetchImpl);
}

async function parseResponse(
  response: Response,
  mode: 'json' | 'binary',
  fallbackRequestId: string
): Promise<{ statusCode: number; requestId?: string; headers: Record<string, string>; data: unknown }> {
  const headers = Object.fromEntries(response.headers.entries());
  const requestId = headers['x-request-id'] ?? fallbackRequestId;
  const contentType = response.headers.get('content-type') ?? '';

  let data: unknown = undefined;
  if (mode === 'binary') {
    data = new Uint8Array(await response.arrayBuffer());
  } else if (response.status !== 204) {
    if (contentType.includes('application/json')) {
      data = await response.json().catch(() => undefined);
    } else {
      const text = await response.text();
      data = text ? { error: text } : undefined;
    }
  }

  if (!response.ok) {
    const payload = isRecord(data) ? data : {};
    const message = typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
    const upstreamCode = typeof payload.code === 'string' ? payload.code : undefined;
    const details = sanitizeSecretLikeValue(isRecord(payload.details) ? payload.details : payload) as Record<string, unknown>;
    throw createCliError(mapHttpStatusToCliErrorCode(response.status, upstreamCode), message, {
      statusCode: response.status,
      requestId,
      details: Object.keys(details).length > 0 ? details : undefined
    });
  }

  return {
    statusCode: response.status,
    requestId,
    headers,
    data
  };
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined | null>
): string {
  const url = new URL(path, `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) {
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function createTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return controller.signal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
