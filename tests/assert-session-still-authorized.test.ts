/**
 * P2-1 (multi-agent audit): assertSessionStillAuthorizedForUser is the public
 * counterpart of the private revocation check used by agent_log / agent_send /
 * agent_poll / agent_kill. The SSE stream handler in http-server.ts now calls
 * it on every event to close the stream when grants are revoked mid-session.
 * We exercise the predicate end-to-end against a real
 * EffectiveAuthorizationSummary and a fake session manager.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { assertSessionStillAuthorizedForUser } from '../src/server/session-actions.js';
import { computeEffectiveAuthorizationSummary } from '../src/security/index.js';

interface FakeSession {
  id: string;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  allowedChipIds?: string[];
  modelId?: string;
}

class FakeManager extends EventEmitter {
  sessions: FakeSession[] = [];
  list() {
    return this.sessions;
  }
  getSession(id: string) {
    return this.sessions.find((s) => s.id === id) ?? null;
  }
}

function makeUser(overrides: {
  id?: string;
  role?: string;
  grants?: Record<string, string[] | '*' | undefined>;
}) {
  return {
    id: overrides.id ?? 'u1',
    username: overrides.id ?? 'u1',
    role: overrides.role ?? 'customer',
    grants: overrides.grants ?? {}
  };
}

describe('assertSessionStillAuthorizedForUser (P2-1 multi-agent audit)', () => {
  it('returns true when the user retains all grants', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', chipId: 'E521.39' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { chipIds: ['E521.39'] } })
    });
    expect(summary.usable).toBe(true);
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(true);
  });

  it('returns false once the chip grant is revoked', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', chipId: 'E521.39' }];

    const before = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { chipIds: ['E521.39'] } })
    });
    expect(assertSessionStillAuthorizedForUser(manager, 's1', before, null)).toBe(true);

    const after = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { chipIds: [] } })
    });
    expect(assertSessionStillAuthorizedForUser(manager, 's1', after, null)).toBe(false);
  });

  it('fails closed when the user authorization summary is unusable', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'u1',
        username: 'u1',
        role: 'customer',
        status: 'disabled'
      }
    });

    expect(summary.usable).toBe(false);
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(false);
  });

  it('returns false once a document grant is revoked', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', documentId: 'doc-1' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { documentIds: [] } })
    });
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(false);
  });

  it('returns false once a model grant is revoked', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', modelId: 'example-model' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { modelIds: [] } })
    });
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(false);
  });

  it('fails closed when the session disappears before the authorization recheck', () => {
    const manager = new FakeManager();
    const summary = computeEffectiveAuthorizationSummary({ user: makeUser({ id: 'u1' }) });
    expect(assertSessionStillAuthorizedForUser(manager, 'missing', summary, null)).toBe(false);
  });

  it('falls back to adminOnly decision when catalog is null and user is not admin', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', scopePresetId: 'preset-A' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { scopePresetIds: ['preset-A'] } })
    });
    // Customer without adminOnly visibility must NOT be allowed when catalog is null.
    // This matches the existing assertSessionStillAuthorized semantics: missing
    // catalog entry is treated as "unknown / potentially adminOnly" so the safer
    // answer is deny for non-admin users.
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(false);
  });

  it('returns false when scopePresetId was granted but later revoked', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', scopePresetId: 'preset-A' }];
    const summary = computeEffectiveAuthorizationSummary({
      user: makeUser({ id: 'u1', grants: { scopePresetIds: [] } })
    });
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(false);
  });

  it('returns true for admin even when session chipId is not in user grants (wildcard)', () => {
    const manager = new FakeManager();
    manager.sessions = [{ id: 's1', chipId: 'E521.39' }];
    const summary = computeEffectiveAuthorizationSummary({ user: { id: 'root', role: 'admin' } });
    expect(summary.usable).toBe(true);
    expect(assertSessionStillAuthorizedForUser(manager, 's1', summary, null)).toBe(true);
  });
});
