import type { FingerprintRuntimeConfig } from './config.js';
import { extractFingerprintMarkers, parseFingerprintMarker, verifyFingerprintSignature } from './payload.js';

export type FingerprintVerificationStatus = 'verified' | 'present-but-invalid' | 'not-found';

export interface FingerprintVerificationResult {
  status: FingerprintVerificationStatus;
  summary?: {
    owner: string;
    deploymentId: string;
    channel: string;
    version: string;
    keyId?: string;
  };
}

export function verifyFingerprint(
  input: string,
  runtime: Pick<FingerprintRuntimeConfig, 'secret'> | { secret?: string } = {}
): FingerprintVerificationResult {
  const markers = extractFingerprintMarkers(input);
  if (markers.length === 0) {
    return { status: 'not-found' };
  }

  let invalidResult: FingerprintVerificationResult | undefined;

  for (const marker of markers) {
    const parsed = parseFingerprintMarker(marker);
    if (!parsed) {
      continue;
    }
    if (runtime.secret && verifyFingerprintSignature(parsed, runtime.secret)) {
      return {
        status: 'verified',
        summary: {
          owner: parsed.payload.owner,
          deploymentId: parsed.payload.deploymentId,
          channel: parsed.payload.channel,
          version: parsed.payload.version,
          keyId: parsed.payload.keyId
        }
      };
    }
    invalidResult ??= {
      status: 'present-but-invalid',
      summary: {
        owner: parsed.payload.owner,
        deploymentId: parsed.payload.deploymentId,
        channel: parsed.payload.channel,
        version: parsed.payload.version,
        keyId: parsed.payload.keyId
      }
    };
  }

  return invalidResult ?? { status: 'present-but-invalid' };
}
