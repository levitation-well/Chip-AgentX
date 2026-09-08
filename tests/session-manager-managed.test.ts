import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session-manager.js';

describe('SessionManager.createManagedSession', () => {
  it('注册 running 会话、append 输出可读、complete 落 completed 并带 citations', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const h = mgr.createManagedSession({ task: '哪些芯片支持 LIN', chatMode: 'enhanced' });
    const running = mgr.getSession(h.sessionId);
    expect(running?.status).toBe('running');

    h.appendOutput('正在检索…\n');
    h.appendOutput('答案正文');
    h.complete({
      sourceCitationSummary: { captureKind: 'system_captured_source_seed', sourceCount: 2, sources: [] },
      usedSources: [
        {
          captureKind: 'system_captured_source_seed',
          scopeId: 'dynamic-group',
          scopePresetId: 'dynamic-group',
          documentId: 'E521.31',
          displayTitle: 'E521.31',
          chipId: 'E521.31'
        }
      ]
    });

    const done = mgr.getSession(h.sessionId);
    expect(done?.status).toBe('completed');
    expect(done?.aggregated).toContain('答案正文');
    expect(done?.sourceCitationSummary?.sourceCount).toBe(2);
    expect(done?.usedSources?.length).toBe(1);
    expect(done?.usedSources?.[0]?.chipId).toBe('E521.31');
    mgr.destroy();
  });

  it('fail 落 failed 并把消息写进输出', () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const h = mgr.createManagedSession({ task: 'q' });
    h.fail('检索未能完成');
    const done = mgr.getSession(h.sessionId);
    expect(done?.status).toBe('failed');
    expect(done?.aggregated).toContain('检索未能完成');
    mgr.destroy();
  });

  it('计入并发上限', () => {
    const mgr = new SessionManager({ exitOnLastSession: false, maxConcurrentSessions: 1 });
    mgr.createManagedSession({ task: 'a' });
    expect(() => mgr.createManagedSession({ task: 'b' })).toThrow(/Max concurrent/);
    mgr.destroy();
  });

  it('kill 会中止 managed 会话并向后台任务发出 abort', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const h = mgr.createManagedSession({ task: 'long-running query' });
    let aborted = false;
    h.signal.addEventListener('abort', () => { aborted = true; });

    await mgr.kill(h.sessionId);

    expect(aborted).toBe(true);
    expect(h.signal.aborted).toBe(true);
    expect(mgr.getSession(h.sessionId)?.status).toBe('killed');
    mgr.destroy();
  });

  it('拒绝向没有 adapter 的 managed 会话静默发送数据', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const h = mgr.createManagedSession({ task: 'one-shot query' });

    await expect(mgr.submit(h.sessionId, 'follow-up')).rejects.toThrow(/not interactive/i);
    expect(mgr.getSession(h.sessionId)?.status).toBe('running');
    mgr.destroy();
  });

  it('blocks the next turn until the previous idle-turn settlement completes', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const sessionId = 'settlement-barrier-session';
    const registry = (mgr as unknown as { registry: { register(session: unknown): void; updateState(id: string, state: unknown): void } }).registry;
    registry.register({
      id: sessionId,
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: 'D:/isolated',
      task: 'first turn',
      sessionMode: 'conversation',
      chatMode: 'standard',
      turnState: 'idle',
      turnCount: 1,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: Date.now()
    });
    mgr.enableTurnSettlementBarrier();
    registry.updateState(sessionId, { turnState: 'idle', turnCount: 1 });

    let claimed = false;
    const claim = mgr.claimTurnStart(sessionId).then((release) => {
      claimed = true;
      return release;
    });
    await Promise.resolve();
    expect(claimed).toBe(false);

    mgr.completeTurnSettlement(sessionId, 1);
    const release = await claim;
    expect(claimed).toBe(true);
    release();
    mgr.destroy();
  });

  it('fails closed after a turn settlement write fails', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const sessionId = 'failed-settlement-session';
    const registry = (mgr as unknown as { registry: { register(session: unknown): void; updateState(id: string, state: unknown): void } }).registry;
    registry.register({
      id: sessionId,
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: 'D:/isolated',
      task: 'first turn',
      sessionMode: 'conversation',
      chatMode: 'standard',
      turnState: 'idle',
      turnCount: 2,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: Date.now()
    });
    mgr.enableTurnSettlementBarrier();
    registry.updateState(sessionId, { turnState: 'idle', turnCount: 2 });
    const claim = mgr.claimTurnStart(sessionId);
    mgr.failTurnSettlement(sessionId, 2);

    await expect(claim).rejects.toThrow(/settlement is incomplete/i);
    await expect(mgr.claimTurnStart(sessionId)).rejects.toThrow(/settlement is incomplete/i);
    mgr.destroy();
  });

  it('serializes historical resume and rejects a concurrent claimant', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const handle = mgr.createManagedSession({ task: 'completed turn' });
    handle.complete();

    const release = await mgr.claimHistoricalResume(handle.sessionId);
    expect(mgr.getSession(handle.sessionId)).toBeUndefined();
    await expect(mgr.claimHistoricalResume(handle.sessionId)).rejects.toThrow(/resume is already in progress/i);

    release();
    const releaseAgain = await mgr.claimHistoricalResume(handle.sessionId);
    releaseAgain();
    mgr.destroy();
  });

  it('waits for the previous workspace cleanup before releasing a historical resume claim', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const handle = mgr.createManagedSession({ task: 'completed turn' });
    handle.complete();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const internals = mgr as unknown as {
      scopeWorkspaceCleanups: Map<string, () => Promise<void>>;
    };
    internals.scopeWorkspaceCleanups.set(handle.sessionId, () => cleanup);
    mgr.clear(handle.sessionId);
    expect(mgr.getSession(handle.sessionId)).toBeUndefined();

    let claimed = false;
    const claim = mgr.claimHistoricalResume(handle.sessionId).then((release) => {
      claimed = true;
      return release;
    });
    await Promise.resolve();
    expect(claimed).toBe(false);

    finishCleanup();
    const release = await claim;
    expect(claimed).toBe(true);
    release();
    mgr.destroy();
  });

  it('waits for the old settlement generation and clears its failed state before reuse', async () => {
    const mgr = new SessionManager({ exitOnLastSession: false });
    const sessionId = 'historical-settlement-generation';
    const registry = (mgr as unknown as {
      registry: { register(session: unknown): void; updateState(id: string, state: unknown): void; finish(id: string, status: string): void };
    }).registry;
    const registerConversation = () => registry.register({
      id: sessionId,
      agentType: 'claude-code',
      status: 'running',
      startedAt: Date.now(),
      cwd: 'D:/isolated',
      task: 'turn',
      sessionMode: 'conversation',
      chatMode: 'standard',
      turnState: 'idle',
      turnCount: 3,
      pendingStdout: [],
      aggregated: '',
      truncated: false,
      totalOutputChars: 0,
      lastOutputAt: Date.now()
    });
    registerConversation();
    mgr.enableTurnSettlementBarrier();
    registry.updateState(sessionId, { turnState: 'idle', turnCount: 3 });
    registry.finish(sessionId, 'failed');

    let prepared = false;
    const preparing = mgr.claimHistoricalResume(sessionId).then((release) => {
      prepared = true;
      return release;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);

    mgr.failTurnSettlement(sessionId, 3);
    const releaseResume = await preparing;
    expect(prepared).toBe(true);
    registerConversation();
    releaseResume();

    const releaseTurn = await mgr.claimTurnStart(sessionId);
    releaseTurn();
    mgr.destroy();
  });
});
