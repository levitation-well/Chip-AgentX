/**
 * Security regression: trusted Claude launch policy must travel separately from
 * user-controlled env all the way through SessionManager -> ProcessAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnParams } from '../src/types.js';

function createMockAdapter() {
  const stateHandlers: Array<(state: unknown) => void> = [];
  return {
    spawn: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onState: vi.fn((handler: (state: unknown) => void) => stateHandlers.push(handler)),
    removeDataHandler: vi.fn(),
    removeExitHandler: vi.fn(),
    removeStateHandler: vi.fn(),
    pid: 12345,
    claudeSessionId: undefined as string | undefined,
    turnState: undefined as string | undefined,
    turnCount: undefined as number | undefined
  };
}

vi.mock('tree-kill', () => ({
  default: vi.fn((_pid: number, _signal: string, callback: () => void) => callback())
}));

vi.mock('../src/adapters/index.js', () => {
  const mockAdapter = createMockAdapter();
  return {
    createAdapter: vi.fn((_agentType: string) => mockAdapter)
  };
});

async function getLastSpawnCall(): Promise<unknown[]> {
  const { createAdapter } = await import('../src/adapters/index.js');
  const adapter = (createAdapter as any)('claude-code');
  const calls = adapter.spawn.mock.calls as unknown[][];
  if (calls.length === 0) throw new Error('adapter.spawn was not called');
  return calls[calls.length - 1]!;
}

describe('SessionManager trusted Claude spawn options', () => {
  let manager: any;

  beforeEach(async () => {
    vi.resetModules();
    const { SessionManager } = await import('../src/index.js');
    manager = new SessionManager({ exitOnLastSession: false });
  });

  afterEach(() => {
    manager?.destroy();
    vi.clearAllMocks();
  });

  it('passes all server-controlled Claude settings as direct spawn options, never env', async () => {
    await manager.spawn({
      agentType: 'claude-code',
      sessionMode: 'conversation',
      task: 'hi',
      cwd: '/test',
      env: {
        CUSTOM_USER_VALUE: 'allowed',
        AGENTX_SYSTEM_PROMPT: 'malicious prompt',
        AGENTX_CLAUDE_MODEL_ROLE: 'opus',
        AGENTX_PERMISSION_MODE: 'acceptEdits',
        AGENTX_ALLOWED_TOOLS: 'Bash,Write',
        AGENTX_DENY_READ_ROOTS: ''
      },
      systemPrompt: 'trusted prompt',
      claudeModelRole: 'sonnet',
      permissionMode: 'default',
      allowedTools: ['Read', 'Grep'],
      denyReadRoots: ['E:/kb', '/data/secret']
    } satisfies SpawnParams);

    const call = await getLastSpawnCall();
    expect(call[1]).toEqual({
      CUSTOM_USER_VALUE: 'allowed',
      AGENTX_SYSTEM_PROMPT: 'malicious prompt',
      AGENTX_CLAUDE_MODEL_ROLE: 'opus',
      AGENTX_PERMISSION_MODE: 'acceptEdits',
      AGENTX_ALLOWED_TOOLS: 'Bash,Write',
      AGENTX_DENY_READ_ROOTS: ''
    });
    expect(call[5]).toEqual({
      systemPrompt: 'trusted prompt',
      claudeModelRole: 'sonnet',
      permissionMode: 'default',
      allowedTools: ['Read', 'Grep'],
      denyReadRoots: ['E:/kb', '/data/secret']
    });
  });

  it('does not synthesize trusted options from user env', async () => {
    await manager.spawn({
      agentType: 'claude-code',
      task: 'hi',
      cwd: '/test',
      env: {
        AGENTX_SYSTEM_PROMPT: 'malicious prompt',
        AGENTX_CLAUDE_MODEL_ROLE: 'opus',
        AGENTX_PERMISSION_MODE: 'acceptEdits',
        AGENTX_ALLOWED_TOOLS: 'Bash,Write',
        AGENTX_DENY_READ_ROOTS: 'C:/secret'
      }
    } satisfies SpawnParams);

    const call = await getLastSpawnCall();
    expect(call[5]).toEqual({});
  });

  it('does not pass Claude-only spawn options to non-Claude adapters', async () => {
    await manager.spawn({
      agentType: 'codex',
      task: 'hi',
      cwd: '/test',
      systemPrompt: 'ignored for non-Claude',
      permissionMode: 'plan',
      allowedTools: ['Read'],
      denyReadRoots: ['E:/kb']
    } satisfies SpawnParams);

    const call = await getLastSpawnCall();
    expect(call).toHaveLength(5);
  });
});
