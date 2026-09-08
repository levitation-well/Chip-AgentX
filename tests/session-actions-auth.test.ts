import { describe, expect, it, vi } from 'vitest';
import { createSessionActions } from '../src/server/session-actions.js';
import { computeEffectiveAuthorizationSummary, parseResourceVisibilityCatalog, type EffectiveAuthorizationSummary, type ResourceVisibilityCatalog } from '../src/security/index.js';

function createScopedManager() {
  const sessions: any[] = [
    {
      id: 'session-a',
      userId: 'user-a',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 1,
      cwd: 'D:/a',
      task: 'a',
      totalOutputChars: 0
    },
    {
      id: 'session-b',
      userId: 'user-b',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 2,
      cwd: 'D:/b',
      task: 'b',
      totalOutputChars: 0
    }
  ];

  return {
    sessions,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: 'session-new',
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: 3,
        cwd: params.cwd ?? process.cwd(),
        task: params.task,
        totalOutputChars: 0
      };
      sessions.push(session);
      return session;
    }),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    log: vi.fn().mockReturnValue({ output: 'owned log', truncated: false, totalChars: 9, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'log', truncated: false, totalChars: 9, offset: 6 }),
    submit: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn(() => () => undefined),
    send: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined)
  };
}

function createFakePersistence() {
  return {
    recordSessionCreated: vi.fn().mockResolvedValue({ sessionId: 'session-new' }),
    recordUserTurn: vi.fn().mockResolvedValue(undefined),
    recordSessionEvent: vi.fn().mockResolvedValue(undefined)
  };
}

// V2: grant-scoped session used by revocation re-verification tests. Carries chipId +
// documentId + scopePresetId + modelId so every re-verified dimension is exercised.
function createGrantScopedManager() {
  const sessions: any[] = [
    {
      id: 'session-granted',
      userId: 'user-a',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 1,
      cwd: 'D:/a',
      task: 'a',
      totalOutputChars: 0,
      chipId: 'chip-1',
      documentId: 'doc-1',
      scopePresetId: 'preset-1',
      modelId: 'haiku'
    }
  ];

  return {
    sessions,
    spawn: vi.fn(),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    log: vi.fn().mockReturnValue({ output: 'granted log', truncated: false, totalChars: 12, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'log', truncated: false, totalChars: 12, offset: 6 }),
    submit: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn(() => () => undefined),
    send: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined)
  };
}

// Note: modelIds are NOT taken from `grants.modelIds` — computeEffectiveAuthorizationSummary
// always recomputes them from `user.modelGrants` via getEffectiveModelGrants (authorization.ts).
function grantedSummary(): EffectiveAuthorizationSummary {
  return computeEffectiveAuthorizationSummary({
    user: {
      id: 'user-a',
      username: 'alice',
      role: 'customer',
      modelGrants: ['haiku'],
      grants: {
        chipIds: ['chip-1'],
        documentIds: ['doc-1'],
        scopePresetIds: ['preset-1']
      }
    }
  });
}

function approvedResourceCatalog(): ResourceVisibilityCatalog {
  return parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'doc-1',
        label: 'Doc 1',
        visibility: 'customer',
        status: 'approved',
        chipIds: ['chip-1']
      }
    ],
    scopePresets: [
      {
        scopePresetId: 'preset-1',
        label: 'Preset 1',
        visibility: 'customer',
        status: 'approved',
        chipIds: ['chip-1'],
        documentIds: ['doc-1']
      }
    ]
  });
}

describe('session actions auth scope', () => {
  it('injects scope userId into spawned sessions', async () => {
    const manager = createScopedManager();
    const persistence = createFakePersistence();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      persistence: persistence as any,
      source: 'mcp',
      userSnapshot: {
        userId: 'ignored-user',
        username: 'alice',
        role: 'internal'
      }
    });

    await actions.agent_spawn({ agentType: 'claude-code', task: 'hello' });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-a' }));
    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-new',
        userId: 'user-a',
        username: 'alice',
        role: 'internal',
        source: 'mcp'
      })
    );
    expect(persistence.recordUserTurn).toHaveBeenCalledWith(
      'session-new',
      expect.objectContaining({
        text: 'hello',
        question: expect.objectContaining({
          userId: 'user-a',
          username: 'alice',
          role: 'internal',
          source: 'mcp'
        })
      })
    );
  });

  it('lists only sessions belonging to the scoped user', async () => {
    const manager = createScopedManager();
    const actions = createSessionActions(manager as any, { scopeUserId: 'user-a' });

    const result = await actions.agent_list({});

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('session-a');
  });

  it('rejects log, send, poll, and kill for sessions owned by another user', async () => {
    const manager = createScopedManager();
    const actions = createSessionActions(manager as any, { scopeUserId: 'user-a' });

    await expect(actions.agent_log({ sessionId: 'session-b' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(actions.agent_send({ sessionId: 'session-b', data: 'nope' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(actions.agent_poll({ sessionId: 'session-b' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(actions.agent_kill({ sessionId: 'session-b' })).rejects.toMatchObject({ statusCode: 404 });
    expect(manager.log).not.toHaveBeenCalled();
    expect(manager.submit).not.toHaveBeenCalled();
    expect(manager.poll).not.toHaveBeenCalled();
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('keeps v1.0 behavior when no scope is configured', async () => {
    const manager = createScopedManager();
    const actions = createSessionActions(manager as any);

    const result = await actions.agent_list({});
    await expect(actions.agent_send({ sessionId: 'session-b', data: 'ok' })).resolves.toMatchObject({ sent: true });

    expect(result.sessions).toHaveLength(2);
    expect(manager.submit).toHaveBeenCalledWith('session-b', 'ok');
  });
});

describe('session actions grant re-verification (V2)', () => {
  it('allows log/poll/send/kill while the grant snapshot still authorizes the session', async () => {
    const manager = createGrantScopedManager();
    let summary = grantedSummary();
    const catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    await expect(actions.agent_log({ sessionId: 'session-granted' })).resolves.toBeDefined();
    await expect(actions.agent_poll({ sessionId: 'session-granted' })).resolves.toBeDefined();
    await expect(actions.agent_send({ sessionId: 'session-granted', data: 'hi' })).resolves.toMatchObject({ sent: true });
    await expect(actions.agent_kill({ sessionId: 'session-granted' })).resolves.toMatchObject({ killed: true });
  });

  it('denies log/poll/send/kill (read and write) once the chip grant is revoked, without killing the process', async () => {
    const manager = createGrantScopedManager();
    let summary = grantedSummary();
    const catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    // Revoke chip grant only.
    summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        modelGrants: ['haiku'],
        grants: { chipIds: [], documentIds: ['doc-1'], scopePresetIds: ['preset-1'] }
      }
    });

    await expect(actions.agent_log({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_poll({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_send({ sessionId: 'session-granted', data: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_kill({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.log).not.toHaveBeenCalled();
    expect(manager.submit).not.toHaveBeenCalled();
    expect(manager.poll).not.toHaveBeenCalled();
    // Deny must not hard-kill the running process; the no-output timeout reclaims it instead.
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('denies once the document grant is revoked', async () => {
    const manager = createGrantScopedManager();
    let summary = grantedSummary();
    const catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        modelGrants: ['haiku'],
        grants: { chipIds: ['chip-1'], documentIds: [], scopePresetIds: ['preset-1'] }
      }
    });

    await expect(actions.agent_log({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_send({ sessionId: 'session-granted', data: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('denies once the scopePreset grant is revoked', async () => {
    const manager = createGrantScopedManager();
    let summary = grantedSummary();
    const catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        modelGrants: ['haiku'],
        grants: { chipIds: ['chip-1'], documentIds: ['doc-1'], scopePresetIds: [] }
      }
    });

    await expect(actions.agent_poll({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('denies once the model grant is revoked', async () => {
    const manager = createGrantScopedManager();
    let summary = grantedSummary();
    const catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        modelGrants: [],
        grants: { chipIds: ['chip-1'], documentIds: ['doc-1'], scopePresetIds: ['preset-1'] }
      }
    });

    await expect(actions.agent_log({ sessionId: 'session-granted' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('preserves cross-user ownership 404 ahead of grant re-verification', async () => {
    const manager = createScopedManager();
    const summary = grantedSummary();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => approvedResourceCatalog()
    });

    await expect(actions.agent_log({ sessionId: 'session-b' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not re-verify when no authorization-summary provider is configured (backward compatible)', async () => {
    const manager = createGrantScopedManager();
    const actions = createSessionActions(manager as any, { scopeUserId: 'user-a' });

    await expect(actions.agent_log({ sessionId: 'session-granted' })).resolves.toBeDefined();
  });
});

// 动态 scope（group/global 检索解析出一组 chip，没有真实目录预设）会话
// 把 scopePresetId 存成 dynamic-group / dynamic-global 这样的合成标记，没有 chipId/documentId。
// 之前的复验代码不认识这个标记，会去查目录（查不到）再落到 adminOnly 通用拒绝，导致所有
// 非 admin 用户的动态范围会话每次 log/poll/send/kill 都被误判 403。这里用一个 mock session
// 直接复现该场景（不走真实 scope 物化，只关心复验分支本身）。
function createDynamicScopeGrantedManager(
  scopePresetId: 'dynamic-group' | 'dynamic-global',
  allowedChipIds: string[],
  allowedDocumentIds: string[] = []
) {
  const sessions: any[] = [
    {
      id: 'session-dynamic',
      userId: 'user-a',
      agentType: 'claude-code',
      status: 'running',
      startedAt: 1,
      cwd: 'D:/dynamic',
      task: 'dynamic scope task',
      totalOutputChars: 0,
      // 动态 scope 会话没有 chipId/documentId——唯一线索是 scopePresetId 合成标记 + allowedChipIds。
      scopePresetId,
      allowedChipIds,
      allowedDocumentIds
    }
  ];

  return {
    sessions,
    spawn: vi.fn(),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions.map((session) => ({ ...session, pid: 12345 }))),
    log: vi.fn().mockReturnValue({ output: 'dynamic scope log', truncated: false, totalChars: 18, offset: 0 }),
    tail: vi.fn().mockReturnValue({ output: 'log', truncated: false, totalChars: 18, offset: 6 }),
    submit: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn(() => () => undefined),
    send: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: false, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined)
  };
}

function dynamicGroupSummary(chipIds: string[]): EffectiveAuthorizationSummary {
  return computeEffectiveAuthorizationSummary({
    user: {
      id: 'user-a',
      username: 'alice',
      role: 'customer',
      modelGrants: ['haiku'],
      grants: {
        chipIds,
        // Physical scope workspaces are copied at chip granularity, so current
        // document visibility is part of every dynamic-session recheck.
        documentIds: ['*'],
        scopePresetIds: []
      }
    }
  });
}

describe('session actions grant re-verification for dynamic scope sessions (V2 x V11 fix)', () => {
  it('allows log/poll/send/kill on a dynamic-group session while every resolved chip remains authorized', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-group', ['chip-1', 'chip-2'], ['doc-1']);
    const summary = dynamicGroupSummary(['chip-1', 'chip-2']);
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => approvedResourceCatalog()
    });

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).resolves.toBeDefined();
    await expect(actions.agent_poll({ sessionId: 'session-dynamic' })).resolves.toBeDefined();
    await expect(actions.agent_send({ sessionId: 'session-dynamic', data: 'hi' })).resolves.toMatchObject({ sent: true });
    await expect(actions.agent_kill({ sessionId: 'session-dynamic' })).resolves.toMatchObject({ killed: true });
  });

  it('allows log/poll/send/kill on a dynamic-global session while every resolved chip remains authorized', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-global', ['chip-1', 'chip-2', 'chip-3'], ['doc-1']);
    const summary = dynamicGroupSummary(['chip-1', 'chip-2', 'chip-3']);
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => approvedResourceCatalog()
    });

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).resolves.toBeDefined();
    await expect(actions.agent_poll({ sessionId: 'session-dynamic' })).resolves.toBeDefined();
    await expect(actions.agent_send({ sessionId: 'session-dynamic', data: 'hi' })).resolves.toMatchObject({ sent: true });
    await expect(actions.agent_kill({ sessionId: 'session-dynamic' })).resolves.toMatchObject({ killed: true });
  });

  it('denies log/poll/send/kill once ANY resolved chip in the dynamic-group session is revoked (fail closed)', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-group', ['chip-1', 'chip-2']);
    let summary = dynamicGroupSummary(['chip-1', 'chip-2']);
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => approvedResourceCatalog()
    });

    // Revoke just one of the two chips the group session resolved to.
    summary = dynamicGroupSummary(['chip-1']);

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_poll({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_send({ sessionId: 'session-dynamic', data: 'hi' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(actions.agent_kill({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.log).not.toHaveBeenCalled();
    expect(manager.submit).not.toHaveBeenCalled();
    expect(manager.poll).not.toHaveBeenCalled();
    // Deny must not hard-kill the running process; the no-output timeout reclaims it instead.
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('denies once ALL chips in the dynamic-group session are revoked', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-group', ['chip-1', 'chip-2']);
    let summary = dynamicGroupSummary(['chip-1', 'chip-2']);
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => approvedResourceCatalog()
    });

    summary = dynamicGroupSummary([]);

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.kill).not.toHaveBeenCalled();
  });

  it('denies a dynamic scope session when a persisted document becomes draft', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-group', ['chip-1'], ['doc-1']);
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        grants: { chipIds: ['chip-1'], documentIds: ['doc-1'] }
      }
    });
    let catalog = approvedResourceCatalog();
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    catalog = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-1',
          label: 'Doc 1',
          visibility: 'customer',
          status: 'draft',
          chipIds: ['chip-1']
        }
      ]
    });

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.log).not.toHaveBeenCalled();
  });

  it('denies a dynamic scope session when a newly cataloged sibling document is not in its persisted snapshot', async () => {
    const manager = createDynamicScopeGrantedManager('dynamic-group', ['chip-1'], ['doc-1']);
    const summary = computeEffectiveAuthorizationSummary({
      user: {
        id: 'user-a',
        username: 'alice',
        role: 'customer',
        grants: { chipIds: ['chip-1'], documentIds: ['doc-1', 'doc-2'] }
      }
    });
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-1', label: 'Doc 1', visibility: 'customer', status: 'approved', chipIds: ['chip-1'] },
        { documentId: 'doc-2', label: 'Doc 2', visibility: 'customer', status: 'approved', chipIds: ['chip-1'] }
      ]
    });
    const actions = createSessionActions(manager as any, {
      scopeUserId: 'user-a',
      getAuthorizationSummary: async () => summary,
      resourceCatalog: () => catalog
    });

    await expect(actions.agent_log({ sessionId: 'session-dynamic' })).rejects.toMatchObject({ statusCode: 403 });
    expect(manager.log).not.toHaveBeenCalled();
  });
});
