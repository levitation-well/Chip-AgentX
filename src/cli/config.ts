import { readFile } from 'node:fs/promises';
import { createCliError } from './errors.js';
import type {
  CliCommonOptions,
  CliConfigValueSource,
  CliAuthMode,
  ResolvedCliAuth,
  ResolvedCliConfig,
  ResolvedCliValue
} from './types.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const DEFAULT_TIMEOUT_MS = 30000;
const SOURCE_PRIORITY: Record<CliConfigValueSource, number> = {
  flag: 4,
  env: 3,
  stdin: 2,
  default: 1,
  none: 0
};

let stdinSecretPromise: Promise<string | undefined> | null = null;

export interface ResolveCliConfigDeps {
  env?: NodeJS.ProcessEnv;
  readTextFile?: (filePath: string) => Promise<string>;
  readSecretFromStdin?: () => Promise<string | undefined>;
}

export async function resolveCliConfig(
  options: CliCommonOptions = {},
  deps: ResolveCliConfigDeps = {}
): Promise<ResolvedCliConfig> {
  const env = deps.env ?? process.env;
  const readTextFile = deps.readTextFile ?? defaultReadTextFile;
  const readSecretFromStdin = deps.readSecretFromStdin ?? readSecretFromStdinOnce;

  const baseUrl = resolveBaseUrl(options, env);
  const timeoutMs = resolveTimeoutMs(options.timeout, env.AGENTX_TIMEOUT ?? env.AGENTX_TIMEOUT_MS);
  const json = resolveBooleanOption(options.json, env.AGENTX_JSON);

  const token = await resolveToken(options, env, readTextFile);
  const mcpKey = resolveFlagEnvValue(options.mcpKey, env.AGENTX_MCP_KEY);
  const username = resolveFlagEnvValue(options.username, env.AGENTX_USERNAME);
  const password = await resolvePassword(options.passwordStdin ?? false, env, readSecretFromStdin);
  const auth = selectAuthMode({
    token,
    mcpKey,
    username,
    password
  });

  return {
    baseUrl,
    timeoutMs,
    json,
    auth
  };
}

async function resolveToken(
  options: CliCommonOptions,
  env: NodeJS.ProcessEnv,
  readTextFile: (filePath: string) => Promise<string>
): Promise<ResolvedCliValue<string | undefined>> {
  const direct = resolveFlagEnvValue(options.token, env.AGENTX_TOKEN);
  if (direct.value) {
    return direct;
  }

  const tokenFile = resolveFlagEnvValue(options.tokenFile, env.AGENTX_TOKEN_FILE);
  if (!tokenFile.value) {
    return { value: undefined, source: 'none' };
  }

  try {
    const fileText = await readTextFile(tokenFile.value);
    return {
      value: fileText.trim(),
      source: tokenFile.source
    };
  } catch (error) {
    throw createCliError('VALIDATION_ERROR', `Unable to read token file: ${tokenFile.value}`);
  }
}

async function resolvePassword(
  passwordStdin: boolean,
  env: NodeJS.ProcessEnv,
  readSecretFromStdin: () => Promise<string | undefined>
): Promise<ResolvedCliValue<string | undefined>> {
  if (typeof env.AGENTX_PASSWORD === 'string' && env.AGENTX_PASSWORD.trim() !== '') {
    return { value: env.AGENTX_PASSWORD, source: 'env' };
  }
  if (!passwordStdin) {
    return { value: undefined, source: 'none' };
  }
  const secret = await readSecretFromStdin();
  return { value: secret, source: secret ? 'stdin' : 'none' };
}

function resolveBaseUrl(options: CliCommonOptions, env: NodeJS.ProcessEnv): string {
  const resolved = resolveFlagEnvValue(options.baseUrl, env.AGENTX_BASE_URL);
  const value = resolved.value ?? DEFAULT_BASE_URL;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('unsupported protocol');
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    throw createCliError('VALIDATION_ERROR', `Invalid base URL: ${value}`);
  }
}

function resolveTimeoutMs(optionValue: string | number | undefined, envValue?: string): number {
  const raw = optionValue ?? envValue ?? DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) {
    throw createCliError('VALIDATION_ERROR', `Invalid timeout: ${String(raw)}`);
  }
  return Math.floor(value);
}

function resolveBooleanOption(optionValue: boolean | undefined, envValue?: string): boolean {
  if (typeof optionValue === 'boolean') {
    return optionValue;
  }
  if (typeof envValue === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(envValue.trim().toLowerCase());
  }
  return false;
}

function resolveFlagEnvValue(flagValue?: string, envValue?: string): ResolvedCliValue<string | undefined> {
  if (typeof flagValue === 'string' && flagValue.trim() !== '') {
    return { value: flagValue.trim(), source: 'flag' };
  }
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    return { value: envValue.trim(), source: 'env' };
  }
  return { value: undefined, source: 'none' };
}

function selectAuthMode(values: {
  token: ResolvedCliValue<string | undefined>;
  mcpKey: ResolvedCliValue<string | undefined>;
  username: ResolvedCliValue<string | undefined>;
  password: ResolvedCliValue<string | undefined>;
}): ResolvedCliAuth {
  const candidates: Array<ResolvedCliAuth> = [];

  if (values.token.value) {
    candidates.push({
      mode: 'bearer-token',
      source: values.token.source,
      token: values.token.value
    });
  }
  if (values.mcpKey.value) {
    candidates.push({
      mode: 'mcp-key',
      source: values.mcpKey.source,
      mcpKey: values.mcpKey.value
    });
  }
  if (values.username.value || values.password.value) {
    if (!values.username.value || !values.password.value) {
      throw createCliError('VALIDATION_ERROR', 'Username/password auth requires both username and password.');
    }
    candidates.push({
      mode: 'password',
      source: higherPrioritySource(values.username.source, values.password.source),
      username: values.username.value,
      password: values.password.value
    });
  }

  if (candidates.length === 0) {
    return { mode: 'none', source: 'none' };
  }

  candidates.sort((left, right) => {
    const priorityDiff = SOURCE_PRIORITY[right.source] - SOURCE_PRIORITY[left.source];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return authModePriority(right.mode) - authModePriority(left.mode);
  });

  return candidates[0] ?? { mode: 'none', source: 'none' };
}

function authModePriority(mode: CliAuthMode): number {
  if (mode === 'bearer-token') return 3;
  if (mode === 'mcp-key') return 2;
  if (mode === 'password') return 1;
  return 0;
}

function higherPrioritySource(left: CliConfigValueSource, right: CliConfigValueSource): CliConfigValueSource {
  return SOURCE_PRIORITY[left] >= SOURCE_PRIORITY[right] ? left : right;
}

async function defaultReadTextFile(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

async function readSecretFromStdinOnce(): Promise<string | undefined> {
  if (!stdinSecretPromise) {
    stdinSecretPromise = new Promise((resolve, reject) => {
      if (process.stdin.isTTY) {
        resolve(undefined);
        return;
      }

      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      process.stdin.on('end', () => {
        const secret = Buffer.concat(chunks).toString('utf8').trim();
        resolve(secret || undefined);
      });
      process.stdin.on('error', reject);
    });
  }
  return stdinSecretPromise;
}
