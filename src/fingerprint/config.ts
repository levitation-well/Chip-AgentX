import type { ProductConfig, ProductVersionSummary } from '../product/index.js';

export interface FingerprintRuntimeConfig {
  enabled: boolean;
  level: 'off' | 'light';
  owner?: string;
  deploymentId?: string;
  channel?: string;
  version: string;
  keyId?: string;
  secret?: string;
}

export interface FingerprintPublicSummary {
  enabled: boolean;
  level: 'off' | 'light';
  owner?: string;
  deploymentId?: string;
  channel?: string;
  version?: string;
  keyId?: string;
  signed: boolean;
  marker?: string;
}

export function createFingerprintRuntimeConfig(
  product: ProductConfig,
  version: ProductVersionSummary,
  env: NodeJS.ProcessEnv = process.env
): FingerprintRuntimeConfig {
  return {
    enabled: product.fingerprint.enabled && product.fingerprint.level !== 'off',
    level: product.fingerprint.level,
    owner: product.fingerprint.owner,
    deploymentId: product.fingerprint.deploymentId,
    channel: product.fingerprint.channel,
    version: version.version,
    keyId: product.fingerprint.publicKeyId,
    secret: safeSecret(env.AGENTX_FINGERPRINT_SECRET)
  };
}

export function toFingerprintPublicSummary(
  runtime: FingerprintRuntimeConfig,
  marker?: string
): FingerprintPublicSummary {
  return {
    enabled: runtime.enabled,
    level: runtime.level,
    owner: runtime.owner,
    deploymentId: runtime.deploymentId,
    channel: runtime.channel,
    version: runtime.version,
    keyId: runtime.keyId,
    signed: Boolean(marker),
    marker
  };
}

function safeSecret(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 12 ? value : undefined;
}
