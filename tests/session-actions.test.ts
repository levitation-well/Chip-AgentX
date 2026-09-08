import { describe, expect, it, vi } from 'vitest';
import { AgentActionSchemas, createSessionActions } from '../src/server/session-actions.js';

function createFakeManager() {
  const session = {
    id: 'session-12345678',
    agentType: 'claude-code',
    status: 'running',
    startedAt: 123,
    cwd: 'D:/workspace',
    task: 'inspect project',
    sessionMode: 'conversation',
    chatMode: 'standard',
    modelId: 'haiku',
    creditUnits: 50,
    turnState: 'idle',
    turnCount: 1,
    claudeSessionId: '00000000-0000-4000-8000-000000000101',
    pendingStdout: [],
    aggregated: '',
    truncated: false,
    totalOutputChars: 0,
    lastOutputAt: 123
  };
  return {
    spawn: vi.fn().mockImplementation(async (params: any) => ({ ...session, ...params })),
    log: vi.fn().mockReturnValue({
      output: 'hello',
      truncated: false,
      totalChars: 5,
      offset: 0
    }),
    tail: vi.fn().mockReturnValue({
      output: 'lo',
      truncated: false,
      totalChars: 5,
      offset: 3
    }),
    send: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    poll: vi.fn().mockResolvedValue({ hasOutput: true, exited: false }),
    kill: vi.fn().mockResolvedValue(undefined),
    claimTurnStart: vi.fn().mockResolvedValue(() => undefined),
    list: vi.fn().mockReturnValue([session])
  };
}

function createFakePersistence() {
  return {
    sessionStore: {
      readSessionMeta: vi.fn().mockResolvedValue(undefined),
      updateSessionMeta: vi.fn().mockResolvedValue(undefined)
    },
    recordSessionCreated: vi.fn().mockResolvedValue({
      sessionId: 'session-12345678'
    }),
    recordUserTurn: vi.fn().mockResolvedValue(undefined),
    recordSessionEvent: vi.fn().mockResolvedValue(undefined)
  };
}

describe('session actions', () => {
  it('spawns a session and returns transport-safe JSON', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'rpc',
      userSnapshot: {
        userId: 'user-1',
        username: 'alice',
        role: 'customer'
      }
    });

    const result = await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project',
      cwd: 'D:/workspace',
      sessionMode: 'conversation'
    });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      agentType: 'claude-code',
      task: 'inspect project',
      cwd: 'D:/workspace',
      sessionMode: 'conversation',
      modelId: 'haiku',
      creditUnits: 50
    }));
    expect(persistence.recordSessionCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-12345678',
        userId: 'user-1',
        username: 'alice',
        role: 'customer',
        source: 'rpc'
      })
    );
    expect(persistence.recordUserTurn).toHaveBeenCalledWith(
      'session-12345678',
      expect.objectContaining({
        role: 'user',
        text: 'inspect project',
        question: expect.objectContaining({
          userId: 'user-1',
          username: 'alice',
          role: 'customer',
          source: 'rpc'
        })
      })
    );
    expect(persistence.recordSessionEvent).toHaveBeenCalledWith(
      'session-12345678',
      expect.objectContaining({
        event: 'agent_spawn',
        details: expect.objectContaining({
          source: 'rpc',
          userId: 'user-1',
          username: 'alice',
          role: 'customer'
        })
      })
    );
    expect(result).toMatchObject({
      sessionId: 'session-12345678',
      status: 'running',
      agentType: 'claude-code',
      cwd: 'D:/workspace',
      sessionMode: 'conversation',
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000101'
    });
    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('SOURCE CITATION SAFETY')
    }));
  });

  it('accepts valid sessionMode and rejects invalid sessionMode at the schema boundary', () => {
    expect(() =>
      AgentActionSchemas.agent_spawn.parse({
        agentType: 'claude-code',
        task: 'inspect project',
        sessionMode: 'conversation'
      })
    ).not.toThrow();

    expect(() =>
      AgentActionSchemas.agent_spawn.parse({
        agentType: 'claude-code',
        task: 'inspect project',
        sessionMode: 'chatty'
      })
    ).toThrow();
  });

  it('drops client-supplied usedSources unless they are attached to a trusted scope workspace', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project',
      usedSources: [
        {
          captureKind: 'system_captured_source_seed',
          scopeId: 'scope-forged',
          scopePresetId: 'preset-forged',
          documentId: 'doc-forged',
          displayTitle: 'Forged Source'
        }
      ]
    });

    expect(manager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      usedSources: undefined,
      sourceCitationSummary: undefined
    }));
  });

  it('seeds a single-chip session (chipId, no scopeWorkspace) with one citation source', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    const result = await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project',
      chipId: 'E522.96'
      // 不传 scopeWorkspace、不传 usedSources：服务端应自建一条芯片来源种子
    });

    const spawnArgs = manager.spawn.mock.calls[0][0];
    expect(spawnArgs.usedSources).toHaveLength(1);
    expect(spawnArgs.usedSources[0].chipId).toBe('E522.96');
    expect(spawnArgs.usedSources[0].displayTitle).toBe('E522.96');
    expect(spawnArgs.sourceCitationSummary.sourceCount).toBe(1);
    expect(result.usedSources).toHaveLength(1);
    expect(result.usedSources[0].chipId).toBe('E522.96');
    expect(result.sourceCitationSummary.sourceCount).toBe(1);
    // 种子不得泄露任何 path-like 内容
    expect(JSON.stringify(spawnArgs.usedSources)).not.toMatch(
      /[A-Za-z]:[\\/]|\/(?:srv|var|opt|home|tmp)\b/
    );
  });

  it('keeps trusted scope-workspace usedSources untouched by the single-chip seed', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    const trustedSource = {
      captureKind: 'system_captured_source_seed' as const,
      scopeId: 'scope-a',
      scopePresetId: 'preset-a',
      documentId: 'doc-a',
      displayTitle: 'Application Note A'
    };

    await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project',
      chipId: 'E522.96',
      scopeWorkspace: { scopePresetId: 'preset-a' } as any,
      usedSources: [trustedSource]
    });

    const spawnArgs = manager.spawn.mock.calls[0][0];
    expect(spawnArgs.usedSources).toEqual([trustedSource]);
  });

  it('emits no citation seed when neither chipId nor scopeWorkspace is present', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    await actions.agent_spawn({
      agentType: 'claude-code',
      task: 'inspect project'
    });

    const spawnArgs = manager.spawn.mock.calls[0][0];
    expect(spawnArgs.usedSources).toBeUndefined();
    expect(spawnArgs.sourceCitationSummary).toBeUndefined();
  });

  it('rejects internal resume identity fields at the public spawn schema boundary', () => {
    for (const field of ['sessionId', 'claudeSessionId', 'resume']) {
      expect(() =>
        AgentActionSchemas.agent_spawn.parse({
          agentType: 'claude-code',
          task: 'inspect project',
          [field]: field === 'resume' ? true : 'controlled-by-server'
        })
      ).toThrow();
    }
  });

  it('submits data by default for chat-style sends', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'mcp',
      userSnapshot: {
        userId: 'user-1',
        username: 'alice'
      }
    });

    const result = await actions.agent_send({ sessionId: 'session-12345678', data: 'continue' });

    expect(persistence.recordUserTurn).toHaveBeenCalledWith(
      'session-12345678',
      expect.objectContaining({
        text: 'continue',
        chatMode: 'standard',
        modelId: 'haiku',
        creditUnits: 50,
        question: expect.objectContaining({
          userId: 'user-1',
          username: 'alice',
          chatMode: 'standard',
          modelId: 'haiku',
          creditUnits: 50,
          source: 'mcp'
        })
      })
    );
    expect(manager.submit).toHaveBeenCalledWith('session-12345678', 'continue');
    expect(manager.send).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sessionId: 'session-12345678',
      sent: true,
      submitted: true,
      status: 'running',
      turnState: 'idle',
      turnCount: 1,
      claudeSessionId: '00000000-0000-4000-8000-000000000101'
    });
  });

  it('sends raw data when submit is false', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'web'
    });

    await actions.agent_send({
      sessionId: 'session-12345678',
      data: 'raw',
      submit: false
    });

    expect(persistence.recordUserTurn).toHaveBeenCalled();
    expect(manager.send).toHaveBeenCalledWith('session-12345678', 'raw');
    expect(manager.submit).not.toHaveBeenCalled();
  });

  it('rejects a new send while the previous durable credit hold is unsettled', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    persistence.sessionStore.readSessionMeta.mockResolvedValueOnce({
      creditReservation: { reservationId: 'hold-1', requestId: 'turn-1' }
    });
    const actions = createSessionActions(manager as any, { persistence: persistence as any });

    await expect(actions.agent_send({ sessionId: 'session-12345678', data: 'too early' })).rejects.toMatchObject({
      statusCode: 409
    });
    expect(persistence.recordUserTurn).not.toHaveBeenCalled();
    expect(manager.submit).not.toHaveBeenCalled();
  });

  it('rejects post-spawn mode/model changes and image input on locked text sessions', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    expect(() =>
      AgentActionSchemas.agent_send.parse({
        sessionId: 'session-12345678',
        data: 'continue',
        chatMode: 'multimodal'
      })
    ).toThrow();

    await expect(
      actions.agent_send({
        sessionId: 'session-12345678',
        data: 'see /api/chat-uploads/00000000-0000-4000-8000-000000000001/image.png?token=redacted'
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'IMAGE_INPUT_NOT_ALLOWED'
    });
    expect(manager.submit).not.toHaveBeenCalled();
  });

  it('does not call the manager when send persistence fails', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    persistence.recordUserTurn.mockRejectedValueOnce(new Error('persist failed'));
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any
    });

    await expect(actions.agent_send({ sessionId: 'session-12345678', data: 'continue' })).rejects.toThrow(
      'persist failed'
    );
    expect(manager.submit).not.toHaveBeenCalled();
    expect(manager.send).not.toHaveBeenCalled();
  });

  it('throws when spawn persistence fails after manager.spawn succeeds', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    persistence.recordSessionCreated.mockRejectedValueOnce(new Error('persist failed'));
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any
    });

    await expect(
      actions.agent_spawn({
        agentType: 'claude-code',
        task: 'inspect project'
      })
    ).rejects.toThrow('persist failed');
    expect(manager.kill).toHaveBeenCalledWith('session-12345678');
  });

  it('records kill events without changing fire-and-forget kill behavior', async () => {
    const manager = createFakeManager();
    const persistence = createFakePersistence();
    persistence.recordSessionEvent.mockRejectedValueOnce(new Error('event failed'));
    const actions = createSessionActions(manager as any, {
      persistence: persistence as any,
      source: 'web'
    });

    await expect(actions.agent_kill({ sessionId: 'session-12345678' })).resolves.toMatchObject({
      killed: true
    });

    expect(persistence.recordSessionEvent).toHaveBeenCalledWith(
      'session-12345678',
      expect.objectContaining({
        event: 'agent_kill',
        details: expect.objectContaining({ source: 'web' })
      })
    );
    expect(manager.kill).toHaveBeenCalledWith('session-12345678');
  });

  it('uses tail when agent_log receives tail', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    const result = await actions.agent_log({ sessionId: 'session-12345678', tail: 2 });

    expect(manager.tail).toHaveBeenCalledWith('session-12345678', 2);
    expect(manager.log).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      output: 'lo',
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50
    });
  });

  it('projects session usedSources into agent_log output metadata', async () => {
    const manager = createFakeManager();
    const session = manager.list()[0];
    session.usedSources = [
      {
        captureKind: 'system_captured_source_seed',
        scopeId: 'scope-a',
        scopePresetId: 'preset-a',
        documentId: 'doc-a',
        displayTitle: 'Application Note A',
        filename: 'app-note-a.pdf'
      }
    ];
    manager.log.mockReturnValue({
      output: JSON.stringify({ type: 'result', result: 'Answer. Source: Application Note A.' }),
      truncated: false,
      totalChars: 80,
      offset: 0
    });
    const actions = createSessionActions(manager as any);

    const result = await actions.agent_log({ sessionId: 'session-12345678' });

    expect(result.outputMeta.citations).toMatchObject({
      sourceCount: 1,
      sources: [expect.objectContaining({ documentId: 'doc-a', displayTitle: 'Application Note A' })]
    });
    expect(result.outputMeta.citationNotice).toContain('system-captured source seed');
    expect(result.outputMeta.citationWarnings).toEqual([]);
    expect(result).toMatchObject({
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50
    });
  });

  it('returns actual mode metadata from agent_poll even before exit', async () => {
    const manager = createFakeManager();
    const actions = createSessionActions(manager as any);

    const result = await actions.agent_poll({ sessionId: 'session-12345678', timeoutMs: 1 });

    expect(result).toMatchObject({
      hasOutput: true,
      exited: false,
      chatMode: 'standard',
      modelId: 'haiku',
      creditUnits: 50
    });
  });

  it('rejects invalid agent types at the schema boundary', () => {
    expect(() =>
      AgentActionSchemas.agent_spawn.parse({
        agentType: 'not-real',
        task: 'inspect project'
      })
    ).toThrow();
  });
});
