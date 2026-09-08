import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CreditLedger,
  CreditService,
  DEFAULT_CREDIT_UNITS,
  MODEL_CREDIT_UNITS,
  getModelCreditUnits
} from '../src/credits.js';
import { UserStore, getUserCreditBalanceUnits } from '../src/auth/user-store.js';
import { createPersistenceRuntime } from '../src/persistence/index.js';
import { reconcilePersistedCreditReservations } from '../src/http-server.js';

const tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-credits-'));
  tempDirs.push(dir);
  return dir;
}

async function createStore(dataDir: string): Promise<UserStore> {
  const store = new UserStore({
    dataDir,
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10)
  });
  await store.init();
  return store;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('credits defaults and costs', () => {
  it('uses integer default balance and model costs', () => {
    expect(DEFAULT_CREDIT_UNITS).toBe(999900);
    expect(MODEL_CREDIT_UNITS).toEqual({
      haiku: 50,
      sonnet: 100,
      opus: 150,
      fable: 50,
      'deepseek-v4-flash': 50,
      'deepseek-v4-pro': 100,
      'mimo-v2.5': 150
    });
    expect(getModelCreditUnits('haiku')).toBe(50);
    expect(getModelCreditUnits('sonnet')).toBe(100);
    expect(getModelCreditUnits('opus')).toBe(150);
    expect(getModelCreditUnits('deepseek-v4-pro')).toBe(100);
  });

  it('gives new and legacy users the default balance', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret');

    expect(user.credits?.balanceUnits).toBe(DEFAULT_CREDIT_UNITS);
    expect(store.toPublicUser(user).credits).toEqual({ balanceUnits: DEFAULT_CREDIT_UNITS });

    const legacy = {
      id: 'legacy-user',
      username: 'legacy',
      passwordHash: 'hash',
      mcpKeys: [],
      createdAt: '2026-05-01T00:00:00.000Z',
      role: 'customer'
    };
    expect(getUserCreditBalanceUnits(legacy)).toBe(DEFAULT_CREDIT_UNITS);
  });
});

describe('CreditService ledger behavior', () => {
  it('deducts only charged entries and records charged ledger rows', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret');
    const ledger = new CreditLedger({ dataDir, now: () => '2026-05-29T01:00:00.000Z' });
    const service = new CreditService(store, ledger);

    const record = await service.charge({
      userId: user.id,
      username: user.username,
      entry: 'chat',
      modelId: 'sonnet',
      reason: 'completed',
      sessionId: 'session-1',
      requestId: 'request-1'
    });

    expect(record).toMatchObject({
      userId: user.id,
      username: 'alice',
      entry: 'chat',
      modelId: 'sonnet',
      status: 'charged',
      units: 100,
      reason: 'completed',
      balanceBeforeUnits: DEFAULT_CREDIT_UNITS,
      balanceAfterUnits: DEFAULT_CREDIT_UNITS - 100
    });
    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(DEFAULT_CREDIT_UNITS - 100);
  });

  it('does not deduct free or failure entries', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret');
    const ledger = new CreditLedger({ dataDir });
    const service = new CreditService(store, ledger);

    await service.recordFree({
      userId: user.id,
      entry: 'mcp',
      modelId: 'haiku',
      reason: 'admin_preview'
    });
    await service.recordFailure({
      userId: user.id,
      entry: 'mcp',
      modelId: 'opus',
      reason: 'provider_timeout'
    });

    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(DEFAULT_CREDIT_UNITS);
    const result = await ledger.query({ userId: user.id, limit: 10 });
    expect(result.items.map((item) => item.status).sort()).toEqual(['failure', 'free']);
    expect(result.items.every((item) => item.units === 0)).toBe(true);
  });

  it('records insufficient balance as failure without charging', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret', 'customer', { credits: { balanceUnits: 49 } });
    const ledger = new CreditLedger({ dataDir });
    const service = new CreditService(store, ledger);

    const record = await service.charge({
      userId: user.id,
      entry: 'chat',
      modelId: 'haiku',
      reason: 'insufficient_credits'
    });

    expect(record).toMatchObject({
      status: 'failure',
      units: 0,
      reason: 'insufficient_credits',
      balanceBeforeUnits: 49,
      balanceAfterUnits: 49
    });
    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(49);
  });

  it('records unknown model cost as failure without throwing or charging', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret', 'customer', { credits: { balanceUnits: 99 } });
    const ledger = new CreditLedger({ dataDir });
    const service = new CreditService(store, ledger);

    const record = await service.charge({
      userId: user.id,
      entry: 'chat',
      modelId: 'unknown-model'
    });

    expect(record).toMatchObject({
      modelId: 'unknown-model',
      status: 'failure',
      units: 0,
      reason: 'unknown_credit_model',
      balanceBeforeUnits: 99,
      balanceAfterUnits: 99
    });
    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(99);
  });

  it('keeps paged queries capped while allowing internal full-range reads', async () => {
    const dataDir = await tempDataDir();
    const ledger = new CreditLedger({ dataDir });
    for (let index = 0; index < 505; index += 1) {
      await ledger.append({
        userId: 'alice',
        entry: 'chat',
        modelId: 'haiku',
        units: 1,
        status: 'charged',
        reason: 'session_turn',
        createdAt: `2026-07-04T00:${String(index % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
      });
    }

    const paged = await ledger.query({ limit: 1000, from: '2026-07-04T00:00:00.000Z', to: '2026-07-04T00:59:59.999Z' });
    const fullRange = await ledger.queryAll({ from: '2026-07-04T00:00:00.000Z', to: '2026-07-04T00:59:59.999Z' });

    expect(paged.items).toHaveLength(500);
    expect(paged.total).toBe(505);
    expect(fullRange).toHaveLength(505);
  });

  it('persists concurrent debits in order so reload sees the final balance', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret', 'customer', { credits: { balanceUnits: 100 } });

    await Promise.all([
      store.debitCreditBalanceUnits(user.id, 50),
      store.debitCreditBalanceUnits(user.id, 50)
    ]);
    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(0);

    const reloaded = await createStore(dataDir);
    await expect(reloaded.getCreditBalanceUnits(user.id)).resolves.toBe(0);
  });

  it('persists credit reservations so release is restart-safe and idempotent', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret', 'customer', { credits: { balanceUnits: 100 } });

    const reserved = await store.reserveCreditBalanceUnits(user.id, 'reservation-1', 50);
    expect(reserved).toMatchObject({ balanceBeforeUnits: 100, balanceAfterUnits: 50 });
    await expect(store.getCreditBalanceUnits(user.id)).resolves.toBe(50);

    const reloaded = await createStore(dataDir);
    await expect(reloaded.releaseCreditReservation('reservation-1')).resolves.toBe(true);
    await expect(reloaded.releaseCreditReservation('reservation-1')).resolves.toBe(false);
    await expect(reloaded.getCreditBalanceUnits(user.id)).resolves.toBe(100);
  });

  it('persists committed reservations without refunding and keeps them private', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret', 'customer', { credits: { balanceUnits: 100 } });

    await store.reserveCreditBalanceUnits(user.id, 'reservation-1', 50);
    const reloaded = await createStore(dataDir);
    await expect(reloaded.commitCreditReservation('reservation-1')).resolves.toBe(true);
    await expect(reloaded.commitCreditReservation('reservation-1')).resolves.toBe(false);
    await expect(reloaded.getCreditBalanceUnits(user.id)).resolves.toBe(50);

    const persistedUser = await reloaded.findById(user.id);
    expect(reloaded.toPublicUser(persistedUser!).credits).toEqual({ balanceUnits: 50 });
    expect(JSON.stringify(reloaded.toPublicUser(persistedUser!))).not.toContain('reservation-1');
  });

  it('reconciles persisted holds exactly once after restart', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const interruptedUser = await store.createUser('interrupted', 'secret', 'customer', { credits: { balanceUnits: 100 } });
    const completedUser = await store.createUser('completed', 'secret', 'customer', { credits: { balanceUnits: 100 } });
    await store.reserveCreditBalanceUnits(interruptedUser.id, 'reservation-interrupted', 50);
    await store.reserveCreditBalanceUnits(completedUser.id, 'reservation-completed', 50);

    const persistence = createPersistenceRuntime({ dataDir });
    await persistence.init();
    await persistence.recordSessionCreated({
      sessionId: 'session-interrupted',
      userId: interruptedUser.id,
      username: interruptedUser.username,
      agentType: 'claude-code',
      cwd: 'D:/workspace',
      task: 'interrupted',
      modelId: 'haiku',
      creditUnits: 50,
      creditReservation: {
        reservationId: 'reservation-interrupted',
        balanceBeforeUnits: 100,
        balanceAfterUnits: 50,
        requestId: 'request-interrupted'
      },
      turnState: 'idle',
      lastTurnResult: {
        status: 'interrupted',
        finishedAt: '2026-07-14T00:00:00.000Z',
        exitCode: null,
        signal: 'RESTART',
        totalOutputChars: 0
      },
      source: 'web'
    });
    await persistence.recordSessionCreated({
      sessionId: 'session-completed',
      userId: completedUser.id,
      username: completedUser.username,
      agentType: 'claude-code',
      cwd: 'D:/workspace',
      task: 'completed',
      modelId: 'haiku',
      creditUnits: 50,
      creditReservation: {
        reservationId: 'reservation-completed',
        balanceBeforeUnits: 100,
        balanceAfterUnits: 50,
        requestId: 'request-completed'
      },
      turnState: 'idle',
      lastTurnResult: {
        status: 'done',
        finishedAt: '2026-07-14T00:00:00.000Z',
        exitCode: 0,
        signal: null,
        totalOutputChars: 10
      },
      source: 'web'
    });
    const ledger = new CreditLedger({ dataDir });

    await expect(reconcilePersistedCreditReservations({
      persistence,
      userStore: store,
      creditLedger: ledger
    })).resolves.toEqual({
      committed: ['session-completed'],
      released: ['session-interrupted'],
      missing: []
    });
    await expect(store.getCreditBalanceUnits(interruptedUser.id)).resolves.toBe(100);
    await expect(store.getCreditBalanceUnits(completedUser.id)).resolves.toBe(50);
    expect((await ledger.queryAll()).map((record) => ({
      requestId: record.requestId,
      status: record.status,
      reason: record.reason
    }))).toEqual(expect.arrayContaining([
      { requestId: 'request-interrupted', status: 'failure', reason: 'recovered_interrupted_turn' },
      { requestId: 'request-completed', status: 'charged', reason: 'recovered_completed_turn' }
    ]));

    await expect(reconcilePersistedCreditReservations({
      persistence,
      userStore: store,
      creditLedger: ledger
    })).resolves.toEqual({ committed: [], released: [], missing: [] });
    expect(await ledger.queryAll()).toHaveLength(2);
  });

  it('does not persist secret metadata fields in ledger records', async () => {
    const dataDir = await tempDataDir();
    const store = await createStore(dataDir);
    const user = await store.createUser('alice', 'secret');
    const ledger = new CreditLedger({ dataDir });
    const service = new CreditService(store, ledger);

    await service.recordFailure({
      userId: user.id,
      entry: 'mcp',
      modelId: 'haiku',
      reason: 'authorization_failed',
      metadata: {
        provider: 'deepseek',
        apiKey: 'sk-do-not-store',
        token: 'bearer-do-not-store',
        nested: {
          mcpKey: 'secret-key-value',
          safe: 'kept'
        }
      }
    });

    const rawLedger = await readFile(path.join(dataDir, 'credits', 'ledger.jsonl'), 'utf8');
    expect(rawLedger).toContain('"provider":"deepseek"');
    expect(rawLedger).toContain('"safe":"kept"');
    expect(rawLedger).not.toContain('sk-do-not-store');
    expect(rawLedger).not.toContain('bearer-do-not-store');
    expect(rawLedger).not.toContain('secret-key-value');
    expect(rawLedger).not.toContain('apiKey');
    expect(rawLedger).not.toContain('token');
    expect(rawLedger).not.toContain('mcpKey');
  });
});
