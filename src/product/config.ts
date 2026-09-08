import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type ProductEdition = 'internal' | 'public';
export type LandingMode = 'always' | 'login-first' | 'disabled';
export type FingerprintLevel = 'off' | 'light';

export interface DonationConfig {
  enabled: boolean;
  alipayQrUrl?: string;
  wechatQrUrl?: string;
  alipayLink?: string;
  wechatLink?: string;
}

export interface ProductConfig {
  edition: ProductEdition;
  landingMode: LandingMode;
  branding: {
    enabled: boolean;
    productName: string;
    signature: string;
    author?: string;
    tooltip?: string;
    homepageUrl?: string;
    githubUrl?: string;
    docsUrl?: string;
  };
  fingerprint: {
    enabled: boolean;
    level: FingerprintLevel;
    owner?: string;
    deploymentId?: string;
    channel?: string;
    publicKeyId?: string;
  };
  donation: DonationConfig;
}

export interface ProductPublicSummary {
  edition: ProductEdition;
  landingMode: LandingMode;
  branding: ProductConfig['branding'];
  fingerprint: ProductConfig['fingerprint'];
  donation: DonationConfig;
}

export interface LoadProductConfigOptions {
  configFile?: string;
  config?: PartialProductConfig;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

type PartialProductConfig = Partial<{
  edition: ProductEdition;
  landingMode: LandingMode;
  branding: Partial<ProductConfig['branding']>;
  fingerprint: Partial<ProductConfig['fingerprint']>;
  donation: Partial<DonationConfig>;
}>;

const PRODUCT_EDITIONS = new Set<ProductEdition>(['internal', 'public']);
const LANDING_MODES = new Set<LandingMode>(['always', 'login-first', 'disabled']);
const FINGERPRINT_LEVELS = new Set<FingerprintLevel>(['off', 'light']);

export const INTERNAL_PRODUCT_DEFAULTS: ProductConfig = {
  edition: 'internal',
  landingMode: 'disabled',
  branding: {
    enabled: false,
    productName: 'AgentX',
    signature: 'Powered by AgentX',
    tooltip: 'AgentX',
    homepageUrl: '/home'
  },
  fingerprint: {
    enabled: false,
    level: 'off'
  },
  donation: {
    enabled: false
  }
};

export const PUBLIC_PRODUCT_DEFAULTS: ProductConfig = {
  edition: 'public',
  landingMode: 'always',
  branding: {
    enabled: true,
    productName: 'AgentX',
    signature: 'Powered by AgentX',
    tooltip: 'AgentX',
    homepageUrl: '/home'
  },
  fingerprint: {
    enabled: true,
    level: 'light',
    owner: 'AgentX',
    deploymentId: 'agentx-public',
    channel: 'web',
    publicKeyId: 'agentx-local'
  },
  donation: {
    enabled: true
  }
};

export async function loadProductConfig(options: LoadProductConfigOptions = {}): Promise<ProductConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicitConfigFile = options.configFile ?? env.AGENTX_PRODUCT_CONFIG_FILE;
  const configFile = explicitConfigFile ?? path.join(cwd, 'config', 'product.json');
  const fileConfig = await readProductConfigFile(configFile, { optionalMissing: explicitConfigFile === undefined });
  const inlineConfig = normalizePartialProductConfig(options.config ?? {});
  const envConfig = productConfigFromEnv(env);
  const requestedEdition = lastValidEdition(fileConfig?.edition, inlineConfig.edition, envConfig.edition);
  const base = requestedEdition === 'public' ? PUBLIC_PRODUCT_DEFAULTS : INTERNAL_PRODUCT_DEFAULTS;

  return mergeProductConfig(base, fileConfig, inlineConfig, envConfig);
}

export function toProductPublicSummary(config: ProductConfig): ProductPublicSummary {
  return {
    edition: config.edition,
    landingMode: config.landingMode,
    branding: { ...config.branding },
    fingerprint: { ...config.fingerprint },
    donation: { ...config.donation }
  };
}

function lastValidEdition(...values: Array<unknown>): ProductEdition {
  let edition: ProductEdition = 'internal';
  for (const value of values) {
    if (typeof value === 'string' && PRODUCT_EDITIONS.has(value as ProductEdition)) {
      edition = value as ProductEdition;
    }
  }
  return edition;
}

async function readProductConfigFile(
  filePath: string,
  options: { optionalMissing: boolean }
): Promise<PartialProductConfig | undefined> {
  try {
    const text = await readFile(filePath, 'utf8');
    return normalizePartialProductConfig(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      if (options.optionalMissing) {
        return undefined;
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load product config from ${filePath}: ${detail}`);
  }
}

function productConfigFromEnv(env: NodeJS.ProcessEnv): PartialProductConfig {
  const config: PartialProductConfig = {};
  if (env.AGENTX_EDITION && PRODUCT_EDITIONS.has(env.AGENTX_EDITION as ProductEdition)) {
    config.edition = env.AGENTX_EDITION as ProductEdition;
  }
  if (env.AGENTX_LANDING_MODE && LANDING_MODES.has(env.AGENTX_LANDING_MODE as LandingMode)) {
    config.landingMode = env.AGENTX_LANDING_MODE as LandingMode;
  }
  if (env.AGENTX_BRANDING_ENABLED !== undefined) {
    config.branding = { enabled: parseBoolean(env.AGENTX_BRANDING_ENABLED) };
  }
  return config;
}

function normalizePartialProductConfig(value: unknown): PartialProductConfig {
  if (!isRecord(value)) {
    return {};
  }

  const config: PartialProductConfig = {};
  if (typeof value.edition === 'string' && PRODUCT_EDITIONS.has(value.edition as ProductEdition)) {
    config.edition = value.edition as ProductEdition;
  }
  if (typeof value.landingMode === 'string' && LANDING_MODES.has(value.landingMode as LandingMode)) {
    config.landingMode = value.landingMode as LandingMode;
  }
  if (isRecord(value.branding)) {
    config.branding = normalizeBranding(value.branding);
  }
  if (isRecord(value.fingerprint)) {
    config.fingerprint = normalizeFingerprint(value.fingerprint);
  }
  if (isRecord(value.donation)) {
    config.donation = normalizeDonation(value.donation);
  }
  return config;
}

function normalizeBranding(value: Record<string, unknown>): Partial<ProductConfig['branding']> {
  return pickDefined({
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    productName: nonEmptyString(value.productName),
    signature: nonEmptyString(value.signature),
    author: nonEmptyString(value.author),
    tooltip: nonEmptyString(value.tooltip),
    homepageUrl: safeUrl(value.homepageUrl),
    githubUrl: safeUrl(value.githubUrl),
    docsUrl: safeUrl(value.docsUrl)
  });
}

function normalizeFingerprint(value: Record<string, unknown>): Partial<ProductConfig['fingerprint']> {
  return pickDefined({
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    level:
      typeof value.level === 'string' && FINGERPRINT_LEVELS.has(value.level as FingerprintLevel)
        ? (value.level as FingerprintLevel)
        : undefined,
    owner: safeFingerprintText(value.owner),
    deploymentId: safeFingerprintText(value.deploymentId),
    channel: safeFingerprintText(value.channel),
    publicKeyId: safeFingerprintText(value.publicKeyId)
  });
}

function normalizeDonation(value: Record<string, unknown>): Partial<DonationConfig> {
  return pickDefined({
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    alipayQrUrl: safeUrl(value.alipayQrUrl),
    wechatQrUrl: safeUrl(value.wechatQrUrl),
    alipayLink: safeUrl(value.alipayLink),
    wechatLink: safeUrl(value.wechatLink)
  });
}

function mergeProductConfig(base: ProductConfig, ...overrides: Array<PartialProductConfig | undefined>): ProductConfig {
  let merged: ProductConfig = {
    edition: base.edition,
    landingMode: base.landingMode,
    branding: { ...base.branding },
    fingerprint: { ...base.fingerprint },
    donation: { ...base.donation }
  };

  for (const override of overrides) {
    if (!override) {
      continue;
    }
    merged = {
      edition: override.edition ?? merged.edition,
      landingMode: override.landingMode ?? merged.landingMode,
      branding: { ...merged.branding, ...override.branding },
      fingerprint: { ...merged.fingerprint, ...override.fingerprint },
      donation: { ...merged.donation, ...override.donation }
    };
  }

  return merged;
}

function safeUrl(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (!text) {
    return undefined;
  }
  if (/[\r\n]/.test(text)) {
    return undefined;
  }
  if (text.startsWith('/') && !text.startsWith('//')) {
    return text;
  }
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

function safeFingerprintText(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  if (!text || text.length > 80 || /[\r\n\\/?#&=]/.test(text)) {
    return undefined;
  }
  if (/(secret|token|password|bearer|ghp_|sk-|-----BEGIN)/i.test(text)) {
    return undefined;
  }
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(text)) {
    return undefined;
  }
  return text;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseBoolean(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function pickDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
