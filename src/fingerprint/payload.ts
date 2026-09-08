import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FingerprintRuntimeConfig } from './config.js';

export const FINGERPRINT_PREFIX = 'agentx-fp:v1.';

export interface FingerprintPayload {
  owner: string;
  deploymentId: string;
  version: string;
  channel: string;
  issuedAt: string;
  nonce: string;
  keyId?: string;
}

export interface CreateFingerprintMarkerOptions {
  issuedAt?: string;
  nonce?: string;
}

export interface ParsedFingerprintMarker {
  marker: string;
  payload: FingerprintPayload;
  signature: string;
  canonicalPayload: string;
}

export function createFingerprintMarker(
  runtime: FingerprintRuntimeConfig,
  options: CreateFingerprintMarkerOptions = {}
): string | undefined {
  if (!runtime.enabled || runtime.level === 'off' || !runtime.secret) {
    return undefined;
  }
  const payload: FingerprintPayload = {
    owner: runtime.owner ?? 'AgentX',
    deploymentId: runtime.deploymentId ?? 'agentx',
    version: runtime.version,
    channel: runtime.channel ?? 'web',
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    nonce: options.nonce ?? randomBytes(8).toString('base64url'),
    keyId: runtime.keyId
  };
  const canonicalPayload = canonicalizePayload(payload);
  return `${FINGERPRINT_PREFIX}${encodeBase64Url(canonicalPayload)}.${signPayload(canonicalPayload, runtime.secret)}`;
}

export function extractFingerprintMarkers(input: string): string[] {
  const pattern = new RegExp(`${escapeRegExp(FINGERPRINT_PREFIX)}[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+`, 'g');
  return input.match(pattern) ?? [];
}

export function parseFingerprintMarker(marker: string): ParsedFingerprintMarker | undefined {
  if (!marker.startsWith(FINGERPRINT_PREFIX)) {
    return undefined;
  }
  const [encodedPayload, signature] = marker.slice(FINGERPRINT_PREFIX.length).split('.');
  if (!encodedPayload || !signature) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<FingerprintPayload>;
    if (!isValidPayload(parsed)) {
      return undefined;
    }
    const payload: FingerprintPayload = {
      owner: parsed.owner,
      deploymentId: parsed.deploymentId,
      version: parsed.version,
      channel: parsed.channel,
      issuedAt: parsed.issuedAt,
      nonce: parsed.nonce,
      keyId: parsed.keyId
    };
    return {
      marker,
      payload,
      signature,
      canonicalPayload: canonicalizePayload(payload)
    };
  } catch {
    return undefined;
  }
}

export function verifyFingerprintSignature(parsed: ParsedFingerprintMarker, secret: string): boolean {
  const expected = signPayload(parsed.canonicalPayload, secret);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parsed.signature);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function canonicalizePayload(payload: FingerprintPayload): string {
  return JSON.stringify({
    owner: payload.owner,
    deploymentId: payload.deploymentId,
    version: payload.version,
    channel: payload.channel,
    issuedAt: payload.issuedAt,
    nonce: payload.nonce,
    keyId: payload.keyId
  });
}

function signPayload(canonicalPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(canonicalPayload).digest('base64url');
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function isValidPayload(value: Partial<FingerprintPayload>): value is FingerprintPayload {
  return (
    typeof value.owner === 'string' &&
    typeof value.deploymentId === 'string' &&
    typeof value.version === 'string' &&
    typeof value.channel === 'string' &&
    typeof value.issuedAt === 'string' &&
    typeof value.nonce === 'string' &&
    (value.keyId === undefined || typeof value.keyId === 'string')
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
