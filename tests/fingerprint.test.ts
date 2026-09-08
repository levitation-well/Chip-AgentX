import { describe, expect, it } from 'vitest';
import {
  createFingerprintMarker,
  createFingerprintRuntimeConfig,
  extractFingerprintMarkers,
  toFingerprintPublicSummary,
  verifyFingerprint
} from '../src/fingerprint/index.js';
import { loadProductConfig } from '../src/product/index.js';

const version = { version: '1.2.3' };
const secret = 'test-fingerprint-secret';

describe('fingerprint core', () => {
  it('generates stable signed markers for the same input', async () => {
    const config = await loadProductConfig({ env: { AGENTX_EDITION: 'public' } });
    const runtime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: secret });
    const options = { issuedAt: '2026-05-14T00:00:00.000Z', nonce: 'nonce-01' };

    const first = createFingerprintMarker(runtime, options);
    const second = createFingerprintMarker(runtime, options);

    expect(first).toBeTruthy();
    expect(first).toBe(second);
    expect(first).not.toContain(secret);
    expect(extractFingerprintMarkers(`hello ${first}`).at(0)).toBe(first);
  });

  it('changes signature when secret changes and verifies only with matching secret', async () => {
    const config = await loadProductConfig({ env: { AGENTX_EDITION: 'public' } });
    const runtime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: secret });
    const otherRuntime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: 'different-secret' });
    const options = { issuedAt: '2026-05-14T00:00:00.000Z', nonce: 'nonce-01' };

    const marker = createFingerprintMarker(runtime, options);
    const otherMarker = createFingerprintMarker(otherRuntime, options);

    expect(marker).toBeTruthy();
    expect(otherMarker).toBeTruthy();
    expect(marker).not.toBe(otherMarker);
    expect(verifyFingerprint(marker ?? '', runtime).status).toBe('verified');
    expect(verifyFingerprint(marker ?? '', otherRuntime).status).toBe('present-but-invalid');
  });

  it('soft-fails without a secret and never pretends to verify', async () => {
    const config = await loadProductConfig({ env: { AGENTX_EDITION: 'public' } });
    const runtime = createFingerprintRuntimeConfig(config, version, {});

    expect(createFingerprintMarker(runtime)).toBeUndefined();
    expect(toFingerprintPublicSummary(runtime)).toMatchObject({ enabled: true, signed: false });
  });

  it('distinguishes verified, invalid, and not-found', async () => {
    const config = await loadProductConfig({ env: { AGENTX_EDITION: 'public' } });
    const runtime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: secret });
    const marker = createFingerprintMarker(runtime, {
      issuedAt: '2026-05-14T00:00:00.000Z',
      nonce: 'nonce-01'
    });

    expect(verifyFingerprint(marker ?? '', runtime)).toMatchObject({
      status: 'verified',
      summary: {
        owner: 'AgentX',
        deploymentId: 'agentx-public',
        channel: 'web',
        version: '1.2.3',
        keyId: 'agentx-local'
      }
    });
    expect(verifyFingerprint(`${marker}tampered`, runtime).status).toBe('present-but-invalid');
    expect(verifyFingerprint('plain text', runtime).status).toBe('not-found');
    expect(JSON.stringify(verifyFingerprint(marker ?? '', runtime))).not.toContain(secret);
  });

  it('prefers a later verified marker over an earlier invalid marker', async () => {
    const config = await loadProductConfig({ env: { AGENTX_EDITION: 'public' } });
    const runtime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: secret });
    const otherRuntime = createFingerprintRuntimeConfig(config, version, { AGENTX_FINGERPRINT_SECRET: 'old-secret' });
    const invalidMarker = createFingerprintMarker(otherRuntime, {
      issuedAt: '2026-05-14T00:00:00.000Z',
      nonce: 'old-marker'
    });
    const validMarker = createFingerprintMarker(runtime, {
      issuedAt: '2026-05-14T00:00:00.000Z',
      nonce: 'current-marker'
    });

    const result = verifyFingerprint(`archived ${invalidMarker} refreshed ${validMarker}`, runtime);

    expect(result).toMatchObject({
      status: 'verified',
      summary: {
        owner: 'AgentX',
        deploymentId: 'agentx-public'
      }
    });
  });
});
