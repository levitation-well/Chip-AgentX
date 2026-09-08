import { describe, expect, it, vi } from 'vitest';
import { createSessionActions } from '../src/server/session-actions.js';

function createFakeManager() {
  const sessions: any[] = [];
  return {
    sessions,
    spawn: vi.fn().mockImplementation(async (params: any) => {
      const session = {
        id: 'session-model',
        userId: params.userId,
        agentType: params.agentType,
        status: 'running',
        startedAt: 123,
        cwd: params.cwd ?? 'D:/workspace',
        task: params.task,
        displayTask: params.displayTask,
        scopeDescriptor: params.scopeDescriptor,
        sessionMode: params.sessionMode,
        chatMode: params.chatMode,
        modelId: params.modelId,
        creditUnits: params.creditUnits,
        turnState: 'idle',
        turnCount: 1,
        pendingStdout: [],
        aggregated: '',
        truncated: false,
        totalOutputChars: 0,
        lastOutputAt: 123
      };
      sessions.push(session);
      return session;
    }),
    list: vi.fn().mockImplementation(() => sessions),
    listWithPid: vi.fn().mockImplementation(() => sessions),
    log: vi.fn().mockReturnValue({ output: '', truncated: false, totalChars: 0, offset: 0 }),
    kill: vi.fn().mockResolvedValue(undefined)
  };
}

function createPersistence() {
  return {
    sessionStore: {
      updateSessionMeta: vi.fn().mockResolvedValue({})
    },
    recordSessionCreated: vi.fn().mockResolvedValue({ sessionId: 'session-model' }),
    recordUserTurn: vi.fn().mockResolvedValue(undefined),
    recordSessionEvent: vi.fn().mockResolvedValue(undefined)
  };
}

function createActions(options: Record<string, unknown> = {}) {
  const manager = createFakeManager();
  const persistence = createPersistence();
  const actions = createSessionActions(manager as any, {
    persistence: persistence as any,
    source: 'web',
    userSnapshot: {
      userId: 'user-1',
      username: 'alice',
      role: 'internal',
      authorizedModels: ['haiku', 'sonnet', 'opus'],
      credits: { balanceUnits: 999900 },
      ...options
    }
  });
  return { actions, manager, persistence };
}

describe('session actions model routing', () => {
  it.each([
    ['standard', 'haiku', 50],
    ['enhanced', 'sonnet', 100],
    ['multimodal', 'opus', 150]
  ] as const)('uses %s default model', async (chatMode, modelId, creditUnits) => {
    const { actions, manager, persistence } = createActions();

    const result = await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'hello',
      chatMode
    });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({ modelId, creditUnits }));
    expect(result).toMatchObject({ modelId, creditUnits });
    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(expect.objectContaining({ modelId, creditUnits }));
    expect(persistence.recordUserTurn).toHaveBeenCalledWith(
      'session-model',
      expect.objectContaining({
        chatMode,
        modelId,
        creditUnits,
        question: expect.objectContaining({ chatMode, modelId, creditUnits })
      })
    );
    expect(persistence.recordSessionEvent).toHaveBeenCalledWith(
      'session-model',
      expect.objectContaining({
        details: expect.objectContaining({ chatMode, modelId, creditUnits })
      })
    );
  });

  it('rejects mode/model mismatch before spawn', async () => {
    const { actions, manager } = createActions();

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'hello',
        chatMode: 'standard',
        model: 'opus'
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'MODE_MODEL_MISMATCH'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('rejects unknown model before spawn', async () => {
    const { actions, manager } = createActions();

    await expect(
      actions.agent_spawn({ agentType: 'claude-code', task: 'hello', model: 'not-a-model' })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN_MODEL'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('rejects unauthorized model before spawn', async () => {
    const { actions, manager } = createActions({
      role: 'customer',
      authorizedModels: ['haiku']
    });

    await expect(
      actions.agent_spawn({ agentType: 'claude-code', task: 'hello', model: 'sonnet' })
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'MODEL_NOT_AUTHORIZED'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('rejects insufficient credits before spawn', async () => {
    const { actions, manager } = createActions({
      credits: { balanceUnits: 49 }
    });
    const scopeWorkspaceCleanup = vi.fn(async () => undefined);

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'hello',
        model: 'haiku',
        scopeWorkspaceCleanup
      })
    ).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_CREDITS',
      details: expect.objectContaining({ modelId: 'haiku', creditUnits: 50, balanceUnits: 49 })
    });
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(scopeWorkspaceCleanup).toHaveBeenCalledOnce();
  });

  it('cleans a materialized scope workspace when the durable credit reservation rejects', async () => {
    const manager = createFakeManager();
    const persistence = createPersistence();
    const scopeWorkspaceCleanup = vi.fn(async () => undefined);
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'web',
      userSnapshot: {
        userId: 'user-1',
        username: 'alice',
        role: 'customer',
        authorizedModels: ['haiku'],
        credits: { balanceUnits: 50 }
      },
      creditReservations: {
        reserve: vi.fn(async () => {
          throw new Error('Insufficient credits');
        }),
        release: vi.fn(async () => undefined)
      }
    });

    await expect(actions.agent_spawn({
      agentType: 'claude-code',
      task: 'hello',
      chatMode: 'standard',
      scopeWorkspaceCleanup
    })).rejects.toMatchObject({
      statusCode: 402,
      code: 'INSUFFICIENT_CREDITS'
    });

    expect(manager.spawn).not.toHaveBeenCalled();
    expect(scopeWorkspaceCleanup).toHaveBeenCalledOnce();
  });

  it('reserves credits before spawn so concurrent starts cannot both pass the balance check', async () => {
    const manager = createFakeManager();
    const persistence = createPersistence();
    let balance = 50;
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'web',
      userSnapshot: {
        userId: 'user-1',
        username: 'alice',
        role: 'customer',
        authorizedModels: ['haiku'],
        credits: { balanceUnits: 50 }
      },
      creditReservations: {
        reserve: vi.fn(async (_userId: string, units: number) => {
          if (balance < units) {
            const error = new Error('Insufficient credits');
            (error as any).statusCode = 402;
            throw error;
          }
          const before = balance;
          balance -= units;
          return {
            reservationId: 'reservation-1',
            balanceBeforeUnits: before,
            balanceAfterUnits: balance
          };
        }),
        release: vi.fn(async (_reservationId: string) => undefined)
      }
    });

    const starts = await Promise.allSettled([
      actions.agent_spawn({ agentType: 'claude-code', task: 'first', chatMode: 'standard' }),
      actions.agent_spawn({ agentType: 'claude-code', task: 'second', chatMode: 'standard' })
    ]);

    expect(starts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(starts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(manager.spawn).toHaveBeenCalledTimes(1);
    expect(balance).toBe(0);
    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'haiku',
        creditUnits: 50,
        creditReservation: expect.objectContaining({
          reservationId: 'reservation-1',
          balanceBeforeUnits: 50,
          balanceAfterUnits: 0
        })
      })
    );
  });

  it('clears persisted reservation before refunding when spawn persistence partially fails', async () => {
    const manager = createFakeManager();
    const persistence = createPersistence();
    persistence.recordUserTurn.mockRejectedValueOnce(new Error('turn write failed'));
    const creditReservations = {
      reserve: vi.fn(async () => ({
        reservationId: 'reservation-partial',
        balanceBeforeUnits: 50,
        balanceAfterUnits: 0
      })),
      release: vi.fn(async () => undefined)
    };
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'web',
      userSnapshot: {
        userId: 'user-1',
        username: 'alice',
        role: 'customer',
        authorizedModels: ['haiku'],
        credits: { balanceUnits: 50 }
      },
      creditReservations
    });

    await expect(
      actions.agent_spawn({ agentType: 'claude-code', task: 'hello', chatMode: 'standard' })
    ).rejects.toThrow('turn write failed');

    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(expect.objectContaining({
      creditReservation: expect.objectContaining({ reservationId: 'reservation-partial' })
    }));
    expect(persistence.sessionStore.updateSessionMeta).toHaveBeenCalledWith('session-model', {
      creditReservation: undefined
    });
    expect(creditReservations.release).toHaveBeenCalledWith('reservation-partial');
    expect(manager.kill).toHaveBeenCalledWith('session-model');
    expect(persistence.sessionStore.updateSessionMeta.mock.invocationCallOrder[0]).toBeLessThan(
      creditReservations.release.mock.invocationCallOrder[0]
    );
    expect(creditReservations.release.mock.invocationCallOrder[0]).toBeLessThan(
      manager.kill.mock.invocationCallOrder[0]
    );
  });

  it('rejects chat image references outside multimodal mode', async () => {
    const { actions, manager } = createActions();

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'inspect /api/chat-uploads/00000000-0000-4000-8000-000000000001/image.png?token=redacted',
        chatMode: 'standard'
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'IMAGE_INPUT_NOT_ALLOWED'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
  });

  it('uses the original display task for image gating and history after workspace rewriting', async () => {
    const { actions, manager, persistence } = createActions();
    const displayTask = 'inspect /api/chat-uploads/00000000-0000-4000-8000-000000000001/image.png?token=redacted';

    await expect(actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect ./chat-images/image.png',
      displayTask,
      chatMode: 'standard'
    })).rejects.toMatchObject({ code: 'IMAGE_INPUT_NOT_ALLOWED' });

    await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect ./chat-images/image.png',
      displayTask,
      chatMode: 'multimodal',
      scope: {
        mode: 'group',
        groups: [{ dimension: 'productLine', value: 'Ambient' }]
      }
    });

    expect(manager.spawn).toHaveBeenLastCalledWith(expect.objectContaining({
      task: 'inspect ./chat-images/image.png',
      displayTask,
      scopeDescriptor: {
        mode: 'group',
        groups: [{ dimension: 'productLine', value: 'Ambient' }]
      }
    }));
    expect(persistence.recordSessionCreated).toHaveBeenLastCalledWith(expect.objectContaining({
      task: displayTask,
      scopeDescriptor: expect.objectContaining({ mode: 'group' })
    }));
    expect(persistence.recordUserTurn).toHaveBeenLastCalledWith(
      'session-model',
      expect.objectContaining({ text: displayTask })
    );
  });

  it('rejects customer context budget overage before spawn or persistence', async () => {
    const { actions, manager, persistence } = createActions({
      role: 'customer',
      authorizedModels: ['haiku']
    });

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'x'.repeat(24001),
        model: 'haiku'
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      code: 'CONTEXT_BUDGET_EXCEEDED'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(persistence.recordSessionCreated).not.toHaveBeenCalled();
  });

  it('rejects admin context budget overage before spawn until truncation is implemented', async () => {
    const { actions, manager, persistence } = createActions({
      role: 'admin',
      authorizedModels: ['haiku']
    });

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'x'.repeat(240001),
        model: 'haiku'
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      code: 'CONTEXT_BUDGET_EXCEEDED'
    });
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(persistence.recordSessionCreated).not.toHaveBeenCalled();
  });
});
