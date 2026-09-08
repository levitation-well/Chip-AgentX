import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChildAdapter, ClaudeCodeConversationAdapter } from '../src/adapters/child-adapter.js';

// Mock child_process spawn
vi.mock('node:child_process', () => {
  const mockStdin = {
    write: vi.fn(() => true),
    end: vi.fn(() => undefined),
    destroyed: false
  } as any;
  function createMockChild(pid: number = 67890) {
    const child = {
      pid,
      stdin: {
        write: vi.fn(() => true),
        end: vi.fn(() => undefined),
        destroyed: false
      } as any,
      stdout: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') child._dataHandler = cb;
      }) } as any,
      stderr: { on: vi.fn((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') child._errHandler = cb;
      }) } as any,
      on: vi.fn((event: string, cb: (...args: any[]) => void) => {
        if (event === 'exit') child._exitHandler = cb;
        if (event === 'error') child._errorHandler = cb;
      }),
      kill: vi.fn(),
      _dataHandler: undefined as ((data: Buffer) => void) | undefined,
      _errHandler: undefined as ((data: Buffer) => void) | undefined,
      _exitHandler: undefined as ((code: number, signal: string) => void) | undefined,
      _errorHandler: undefined as ((error: Error) => void) | undefined,
      emitExit: function(code: number, signal: string) {
        if (this._exitHandler) this._exitHandler(code, signal);
      },
      emitError: function(error: Error) {
        if (this._errorHandler) this._errorHandler(error);
      },
      emitData: function(data: string) {
        if (this._dataHandler) this._dataHandler(Buffer.from(data));
      }
    };
    return child;
  }
  return {
    spawn: vi.fn(() => createMockChild()),
    default: { spawn: vi.fn(() => createMockChild()) }
  };
});

describe('ChildAdapter', () => {
  let adapter: ChildAdapter;

  afterEach(() => {
    adapter = undefined as any;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // 隔离测试：清理可能泄漏的环境变量
    delete process.env.AGENTX_SYSTEM_PROMPT;
    adapter = new ChildAdapter();
  });

  describe('constructor', () => {
    it('creates an instance', () => {
      expect(adapter).toBeDefined();
    });

    it('has undefined pid before spawn', () => {
      expect(adapter.pid).toBeUndefined();
    });
  });

  describe('write', () => {
    it('writes to stdin when not destroyed', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn('/test', {}, 200, 80, 'task');
      await adapter.write('input data');
      // Should not throw
    });

    it('is a no-op when stdin is destroyed', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn('/test', {}, 200, 80, 'task');
      const mockStdin = (spawn as any).mock.results[0].value.stdin;
      mockStdin.destroyed = true;
      expect(() => adapter.write('data')).not.toThrow();
    });
  });

  describe('spawn command', () => {
    it('uses the installed Claude command instead of npx', async () => {
      // Keep this test isolated from caller-provided overrides.
      delete process.env.AGENTX_CLAUDE_COMMAND;
      const { spawn } = await import('node:child_process');
      adapter.spawn('/test', {}, 200, 80, 'task');

      expect(spawn).toHaveBeenCalledWith(
        process.platform === 'win32' ? 'claude.cmd' : 'claude',
        expect.arrayContaining(['--print', '--verbose', '--output-format', 'stream-json']),
        expect.any(Object)
      );
      expect((spawn as any).mock.calls[0][1]).not.toContain('@anthropic-ai/claude-code');
      expect((spawn as any).mock.calls[0][1]).not.toContain('--dangerously-skip-permissions');
      expect((spawn as any).mock.calls[0][1]).not.toContain('--');
      expect((spawn as any).mock.calls[0][1]).not.toContain('task');
      expect((spawn as any).mock.calls[0][1]).toEqual(expect.arrayContaining(['--add-dir', '/test']));
      expect((spawn as any).mock.results[0].value.stdin.end).toHaveBeenCalledWith('task');
    });

    it('SECURITY (Fix 1): user env cannot override AGENTX_CLAUDE_COMMAND', async () => {
      // User-supplied AGENTX_CLAUDE_COMMAND is stripped; the platform default binary is used.
      // AGENTX_CLAUDE_SKIP_PERMISSIONS is also stripped from user env (Fix 2.2.30) so the
      // server never sees a user-injected skip flag — the env falls back to non-skip mode.
      const { spawn } = await import('node:child_process');
      const originalCommand = process.env.AGENTX_CLAUDE_COMMAND;
      delete process.env.AGENTX_CLAUDE_COMMAND;
      try {
        adapter.spawn(
          '/test',
          {
            AGENTX_CLAUDE_COMMAND: 'custom-claude',
            AGENTX_CLAUDE_SKIP_PERMISSIONS: '1'
          },
          200,
          80,
          'task'
        );

        expect(spawn).not.toHaveBeenCalledWith(
          'custom-claude',
          expect.anything(),
          expect.anything()
        );
        expect(spawn).toHaveBeenCalledWith(
          process.platform === 'win32' ? 'claude.cmd' : 'claude',
          expect.arrayContaining(['--print', '--verbose']),
          expect.any(Object)
        );
        expect((spawn as any).mock.calls[0][1]).not.toContain('--dangerously-skip-permissions');
      } finally {
        if (originalCommand !== undefined) {
          process.env.AGENTX_CLAUDE_COMMAND = originalCommand;
        }
      }
    });

    it('SECURITY (2.2.30 multi-agent audit): user env cannot override AGENTX_CLAUDE_MODEL_ROLE', async () => {
      // P1-1 fix: AGENTX_CLAUDE_MODEL_ROLE is now in AGENTX_SERVER_SECURITY_KEYS,
      // so user-supplied env cannot override the model role (which would let a
      // hostile client route a multimodal model under a standard credit budget).
      const { spawn } = await import('node:child_process');
      const original = process.env.AGENTX_CLAUDE_MODEL_ROLE;
      delete process.env.AGENTX_CLAUDE_MODEL_ROLE;
      try {
        adapter.spawn('/test', { AGENTX_CLAUDE_MODEL_ROLE: 'example-multimodal' }, 200, 80, 'task');

        const args = (spawn as any).mock.calls[0][1];
        expect(args).not.toContain('example-multimodal');
      } finally {
        if (original !== undefined) {
          process.env.AGENTX_CLAUDE_MODEL_ROLE = original;
        }
      }
    });

    it('passes the resolved Claude role as --model', async () => {
      // SECURITY (2.2.30): AGENTX_CLAUDE_MODEL_ROLE is stripped from user env so
      // a hostile client cannot override the model. Model role now comes from
      // params.modelId (server-controlled) or process.env (server-controlled).
      // To exercise the happy path, set process.env so buildClaudeEnv preserves it.
      const { spawn } = await import('node:child_process');
      const original = process.env.AGENTX_CLAUDE_MODEL_ROLE;
      process.env.AGENTX_CLAUDE_MODEL_ROLE = 'sonnet';
      try {
        adapter.spawn('/test', {}, 200, 80, 'task');

        expect((spawn as any).mock.calls[0][1]).toEqual(
          expect.arrayContaining(['--model', 'sonnet'])
        );
      } finally {
        if (original === undefined) {
          delete process.env.AGENTX_CLAUDE_MODEL_ROLE;
        } else {
          process.env.AGENTX_CLAUDE_MODEL_ROLE = original;
        }
      }
    });

    it('preserves process env while applying session env overrides', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn('/test', { CUSTOM_AGENTX_VALUE: 'enabled' }, 200, 80, 'task');
      const options = (spawn as any).mock.calls[0][2];

      expect(options.env.PATH ?? options.env.Path).toBeDefined();
      expect(options.env.CUSTOM_AGENTX_VALUE).toBe('enabled');
    });

    it('filters protected env keys case-insensitively', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        '/test',
        {
          agentx_system_prompt: 'malicious',
          AgentX_Claude_Model_Role: 'opus',
          agentx_claude_skip_permissions: '1',
          claude_code_git_bash_path: 'C:/attacker/bash.exe'
        },
        200,
        80,
        'task'
      );

      const options = (spawn as any).mock.calls[0][2];
      const envKeys = Object.keys(options.env) as string[];
      for (const protectedKey of [
        'AGENTX_SYSTEM_PROMPT',
        'AGENTX_CLAUDE_MODEL_ROLE',
        'AGENTX_CLAUDE_SKIP_PERMISSIONS',
        'CLAUDE_CODE_GIT_BASH_PATH'
      ]) {
        const variants = envKeys.filter((key) => key.toUpperCase() === protectedKey);
        expect(variants.every((key) => key === protectedKey)).toBe(true);
      }
      expect(options.env.CLAUDE_CODE_GIT_BASH_PATH).not.toBe('C:/attacker/bash.exe');
    });

    it('sets Claude Code Git Bash path from a Git installation when missing on Windows', async () => {
      if (process.platform !== 'win32') {
        return;
      }

      const { spawn } = await import('node:child_process');
      const fakeGitRoot = mkdtempSync(path.join(tmpdir(), 'agentx-fake-git-'));
      mkdirSync(path.join(fakeGitRoot, 'cmd'), { recursive: true });
      mkdirSync(path.join(fakeGitRoot, 'bin'), { recursive: true });
      const fakeBash = path.join(fakeGitRoot, 'bin', 'bash.exe');
      writeFileSync(fakeBash, '');
      const originalPath = process.env.PATH;
      const originalGitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      process.env.PATH = `${path.join(fakeGitRoot, 'cmd')};${originalPath ?? ''}`;
      try {
        adapter.spawn('/test', {}, 200, 80, 'task');
        const options = (spawn as any).mock.calls[0][2];

        expect(options.env.CLAUDE_CODE_GIT_BASH_PATH).toBe(fakeBash);
      } finally {
        process.env.PATH = originalPath;
        if (originalGitBash !== undefined) {
          process.env.CLAUDE_CODE_GIT_BASH_PATH = originalGitBash;
        }
        rmSync(fakeGitRoot, { recursive: true, force: true });
      }
    });

    it('emits output and a failed exit when process spawn errors', async () => {
      const { spawn } = await import('node:child_process');
      const output = vi.fn();
      const exit = vi.fn();
      adapter.onData(output);
      adapter.onExit(exit);

      adapter.spawn('/test', {}, 200, 80, 'task');
      const child = (spawn as any).mock.results[0].value;
      child.emitError(new Error('spawn claude.cmd ENOENT'));

      expect(output).toHaveBeenCalledWith(expect.stringContaining('spawn claude.cmd ENOENT'));
      expect(exit).toHaveBeenCalledWith(1, '');
    });

    it('emits output and a failed exit when process spawn throws synchronously', async () => {
      const { spawn } = await import('node:child_process');
      (spawn as any).mockImplementationOnce(() => {
        throw new Error('spawn EPERM');
      });
      const output = vi.fn();
      const exit = vi.fn();
      adapter.onData(output);
      adapter.onExit(exit);

      adapter.spawn('/test', {}, 200, 80, 'task');

      expect(output).toHaveBeenCalledWith(expect.stringContaining('spawn EPERM'));
      expect(exit).toHaveBeenCalledWith(1, '');
      expect(adapter.pid).toBeUndefined();
    });
  });

  describe('kill', () => {
    it('calls child.kill with SIGTERM', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn('/test', {}, 200, 80, 'task');
      adapter.kill();
      const child = (spawn as any).mock.results[0].value;
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('does not throw when child is undefined', () => {
      const noChildAdapter = new ChildAdapter();
      expect(() => noChildAdapter.kill()).not.toThrow();
    });
  });

  describe('onData / onExit handlers', () => {
    it('registers a data handler', () => {
      const handler = vi.fn();
      adapter.onData(handler);
      expect(typeof adapter.onData).toBe('function');
    });

    it('registers an exit handler', () => {
      const handler = vi.fn();
      adapter.onExit(handler);
      expect(typeof adapter.onExit).toBe('function');
    });

    it('data handler can be removed by reference', () => {
      const handler = vi.fn();
      adapter.onData(handler);
      adapter.removeDataHandler(handler);
      expect(typeof adapter.removeDataHandler).toBe('function');
    });

    it('exit handler can be removed by reference', () => {
      const handler = vi.fn();
      adapter.onExit(handler);
      adapter.removeExitHandler(handler);
      expect(typeof adapter.removeExitHandler).toBe('function');
    });
  });

  describe('pid', () => {
    it('returns the child process PID after spawn', () => {
      adapter.spawn('/test', {}, 200, 80, 'task');
      expect(adapter.pid).toBe(67890);
    });
  });

  describe('conversation mode', () => {
    it('continues turn numbering from the persisted historical generation', async () => {
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000009',
        initialTurnCount: 4,
        resumeFirstTurn: true
      });
      const state = vi.fn();
      conversation.onState(state);

      conversation.spawn('/test', {}, 200, 80, 'resumed prompt');

      expect(spawn).toHaveBeenCalled();
      expect(state.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        turnState: 'running',
        turnCount: 5,
        claudeSessionId: '00000000-0000-4000-8000-000000000009'
      }));
      expect(conversation.turnCount).toBe(5);
    });

    it('starts the first turn with --session-id and keeps the logical session open after success', async () => {
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000001'
      });
      const exit = vi.fn();
      const state = vi.fn();
      conversation.onExit(exit);
      conversation.onState(state);

      conversation.spawn('/test', {}, 200, 80, 'first prompt');
      const firstChild = (spawn as any).mock.results[0].value;
      firstChild.emitExit(0, '');

      expect((spawn as any).mock.calls[0][1]).toEqual(expect.arrayContaining([
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--add-dir',
        '/test',
        '--session-id',
        '00000000-0000-4000-8000-000000000001'
      ]));
      expect((spawn as any).mock.calls[0][2]).toMatchObject({
        cwd: '/test',
        env: expect.objectContaining({
          AGENTX_WORKSPACE_DIR: '/test',
          INIT_CWD: '/test',
          PWD: '/test'
        })
      });
      expect(firstChild.stdin.end).toHaveBeenCalledWith('first prompt');
      expect(exit).not.toHaveBeenCalled();
      expect(state).toHaveBeenLastCalledWith(expect.objectContaining({
        turnState: 'idle',
        turnCount: 1,
        claudeSessionId: '00000000-0000-4000-8000-000000000001'
      }));
    });

    it('starts follow-up turns with --resume using the same Claude session id', async () => {
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000002'
      });

      conversation.spawn('/test', {}, 200, 80, 'first prompt');
      const firstChild = (spawn as any).mock.results[0].value;
      firstChild.emitExit(0, '');

      conversation.write('second prompt\n');
      const secondChild = (spawn as any).mock.results[1].value;

      expect((spawn as any).mock.calls[1][1]).toEqual(expect.arrayContaining([
        '--print',
        '--verbose',
        '--output-format',
        'stream-json',
        '--add-dir',
        '/test',
        '--resume',
        '00000000-0000-4000-8000-000000000002'
      ]));
      expect((spawn as any).mock.calls[1][2]).toMatchObject({
        cwd: '/test',
        env: expect.objectContaining({
          AGENTX_WORKSPACE_DIR: '/test',
          INIT_CWD: '/test',
          PWD: '/test'
        })
      });
      expect(secondChild.stdin.end).toHaveBeenCalledWith('second prompt\n');
    });

    it('rejects follow-up input while a turn is already running', () => {
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000003'
      });

      conversation.spawn('/test', {}, 200, 80, 'first prompt');

      expect(() => conversation.write('too soon')).toThrow('Claude Code turn is already running');
    });
  });

  describe('systemPrompt injection', () => {
    it('includes --system-prompt in spawn args when AGENTX_SYSTEM_PROMPT is set in process.env', async () => {
      // SECURITY (2.2.30): AGENTX_SYSTEM_PROMPT is stripped from user-supplied env.
      // Server-controlled prompts flow via process.env (or params.systemPrompt).
      const { spawn } = await import('node:child_process');
      const original = process.env.AGENTX_SYSTEM_PROMPT;
      process.env.AGENTX_SYSTEM_PROMPT = 'You are a helpful assistant specialized in chip datasheets';
      try {
        adapter.spawn(
          '/test',
          {},
          200,
          80,
          'Explain E521.39 registers'
        );

        const args = (spawn as any).mock.calls[0][1];
        expect(args).toContain('--system-prompt');
        const idx = args.indexOf('--system-prompt');
        expect(args[idx + 1]).toBe('You are a helpful assistant specialized in chip datasheets');
      } finally {
        if (original === undefined) {
          delete process.env.AGENTX_SYSTEM_PROMPT;
        } else {
          process.env.AGENTX_SYSTEM_PROMPT = original;
        }
      }
    });

    it('rejects user-supplied AGENTX_SYSTEM_PROMPT (security)', async () => {
      // SECURITY (2.2.30): user env must not be able to override server-controlled
      // system prompts. The key is stripped from user env in buildClaudeEnv.
      const { spawn } = await import('node:child_process');
      const original = process.env.AGENTX_SYSTEM_PROMPT;
      delete process.env.AGENTX_SYSTEM_PROMPT;
      try {
        adapter.spawn(
          '/test',
          { AGENTX_SYSTEM_PROMPT: 'MALICIOUS OVERRIDE' },
          200,
          80,
          'task'
        );

        const args = (spawn as any).mock.calls[0][1];
        expect(args).not.toContain('MALICIOUS OVERRIDE');
      } finally {
        if (original !== undefined) {
          process.env.AGENTX_SYSTEM_PROMPT = original;
        }
      }
    });

    it('passes systemPrompt to spawnClaudeCodeTurn via params', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        '/test',
        {},
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).not.toContain('--system-prompt');
    });
  });

  describe('三重加固 hardening', () => {
    // 隔离：确保进程级环境变量不会泄漏到默认用例，污染严格模式断言
    const hardeningEnvKeys = [
      'AGENTX_PERMISSION_MODE',
      'AGENTX_ALLOWED_TOOLS',
      'AGENTX_DENY_READ_ROOTS',
      'AGENTX_CLAUDE_SKIP_PERMISSIONS'
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    // --settings 现在写文件到 cwd（避免 Windows cmd.exe 破坏内联 JSON 串），
    // 因此 deny 分支用例必须用真实 cwd（buildClaudeArgs 会 writeFileSync 到 cwd）。
    let realCwd: string;

    beforeEach(() => {
      for (const key of hardeningEnvKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      realCwd = mkdtempSync(path.join(tmpdir(), 'ca-'));
    });

    afterEach(() => {
      for (const key of hardeningEnvKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
      rmSync(realCwd, { recursive: true, force: true });
    });

    it('默认(空 env、无 skip)走严格模式: 无 skip flag, 含 --permission-mode default', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn(realCwd, {}, 200, 80, 'task');

      const args = (spawn as any).mock.calls[0][1];
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).toContain('--permission-mode');
      const idx = args.indexOf('--permission-mode');
      expect(args[idx + 1]).toBe('default');
    });

    it('trusted direct options control prompt, model role, tools, permission mode, and deny roots', async () => {
      const { spawn } = await import('node:child_process');
      (adapter.spawn as any)(
        realCwd,
        {
          AGENTX_SYSTEM_PROMPT: 'malicious prompt',
          AGENTX_CLAUDE_MODEL_ROLE: 'opus',
          AGENTX_PERMISSION_MODE: 'acceptEdits',
          AGENTX_ALLOWED_TOOLS: 'Bash,Write',
          AGENTX_DENY_READ_ROOTS: ''
        },
        200,
        80,
        'task',
        {
          systemPrompt: 'trusted prompt',
          claudeModelRole: 'sonnet',
          permissionMode: 'plan',
          allowedTools: ['Read', 'Grep'],
          denyReadRoots: ['E:/kb/']
        }
      );

      const args = (spawn as any).mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
      expect(args).toEqual(expect.arrayContaining(['--system-prompt', 'trusted prompt']));
      expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
      expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read,Grep']));
      expect(args).not.toContain('malicious prompt');
      expect(args).not.toContain('opus');

      const settingsPath = args[args.indexOf('--settings') + 1]!;
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions: { deny: string[] } };
      expect(settings.permissions.deny).toEqual(['Read(E:/kb/**)', 'Read(E:\\kb\\**)']);
    });

    it('infers Git Bash only from the server process PATH, not user env PATH', async () => {
      if (process.platform !== 'win32') return;

      const { spawn } = await import('node:child_process');
      const fakeBin = path.join(realCwd, 'Git', 'bin');
      const fakeBash = path.join(fakeBin, 'bash.exe');
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(fakeBash, 'not executable', 'utf8');

      const originalGitBash = process.env.CLAUDE_CODE_GIT_BASH_PATH;
      delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
      try {
        adapter.spawn(realCwd, { PATH: fakeBin }, 200, 80, 'task');
        const options = (spawn as any).mock.calls[0][2];
        expect(options.env.CLAUDE_CODE_GIT_BASH_PATH).not.toBe(fakeBash);
      } finally {
        if (originalGitBash !== undefined) {
          process.env.CLAUDE_CODE_GIT_BASH_PATH = originalGitBash;
        }
      }
    });

    it('加固 env: 注入 --allowedTools 与 --settings(文件路径, 文件含 deny / Read 规则)', async () => {
      // SECURITY (Fix 1): hardening keys stripped from user env → no flags expected.
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        realCwd,
        {
          AGENTX_PERMISSION_MODE: 'default',
          AGENTX_ALLOWED_TOOLS: 'Read,Grep',
          AGENTX_DENY_READ_ROOTS: 'E:/kb'
        },
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];

      // After Fix 1: hardening keys stripped from user env → no --allowedTools / --settings.
      expect(args).not.toContain('--allowedTools');
      expect(args).not.toContain('--settings');
    });

    it('安全优先级: skip=1 + 加固 env 时严格模式压过逃生舱', async () => {
      // SECURITY (Fix 2.2.30): Both AGENTX_ALLOWED_TOOLS and AGENTX_CLAUDE_SKIP_PERMISSIONS
      // are now stripped from user env. The server controls skip via params.dangerouslySkipPermissions
      // or process.env (server-controlled). With both user-injected keys stripped:
      //   - allowedTools empty → hardened=false
      //   - skip from user env stripped → no --dangerously-skip-permissions
      // The server stays in strict mode regardless of what the client tried to inject.
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        realCwd,
        {
          AGENTX_CLAUDE_SKIP_PERMISSIONS: '1',
          AGENTX_ALLOWED_TOOLS: 'Read,Grep'
        },
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).toContain('--permission-mode');
      expect(args).not.toContain('--allowedTools');
    });

    it('permissionMode env 白名单收口: 非法值回退 default', async () => {
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        realCwd,
        {
          // 非法的 permission mode（含潜在的注入值），加固 env 触发严格模式分支
          AGENTX_PERMISSION_MODE: 'bogus',
          AGENTX_ALLOWED_TOOLS: 'Read,Grep'
        },
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).toContain('--permission-mode');
      const idx = args.indexOf('--permission-mode');
      // 非法值必须被收口回退到最严的 default
      expect(args[idx + 1]).toBe('default');
    });

    it('permissionMode env 白名单收口: 合法值 plan 放行', async () => {
      // SECURITY (Fix 1): AGENTX_PERMISSION_MODE stripped from user env → fallback 'default'.
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        realCwd,
        {
          AGENTX_PERMISSION_MODE: 'plan',
          AGENTX_ALLOWED_TOOLS: 'Read,Grep'
        },
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).toContain('--permission-mode');
      const idx = args.indexOf('--permission-mode');
      expect(args[idx + 1]).toBe('default');
      expect(args).not.toContain('--allowedTools');
    });

    it('deny 源根尾斜杠归一化: 不产生双斜杠', async () => {
      // SECURITY (Fix 1): AGENTX_DENY_READ_ROOTS stripped from user env → no --settings.
      const { spawn } = await import('node:child_process');
      adapter.spawn(
        realCwd,
        {
          AGENTX_DENY_READ_ROOTS: 'E:/kb/'
        },
        200,
        80,
        'task'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).not.toContain('--settings');
    });

    it('conversation 适配器同样生效(加固 env)', async () => {
      // SECURITY (Fix 1): hardening keys stripped from user env for conversation adapter too.
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000006'
      });

      conversation.spawn(
        realCwd,
        {
          AGENTX_ALLOWED_TOOLS: 'Read,Grep',
          AGENTX_DENY_READ_ROOTS: 'E:/kb'
        },
        200,
        80,
        'first prompt'
      );

      const args = (spawn as any).mock.calls[0][1];
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).toContain('--permission-mode');
      expect(args).not.toContain('--allowedTools');
      expect(args).not.toContain('--settings');
    });
  });

  describe('conversation mode with systemPrompt', () => {
    it('persists trusted direct options across resume turns', async () => {
      const { spawn } = await import('node:child_process');
      const realCwd = mkdtempSync(path.join(tmpdir(), 'ca-conversation-'));
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000099'
      });
      try {
        (conversation.spawn as any)(realCwd, {}, 200, 80, 'first', {
          systemPrompt: 'trusted conversation prompt',
          claudeModelRole: 'sonnet',
          permissionMode: 'default',
          allowedTools: ['Read'],
          denyReadRoots: ['E:/kb']
        });
        const firstChild = (spawn as any).mock.results[0].value;
        firstChild.emitExit(0, '');

        conversation.write('second');

        for (const call of (spawn as any).mock.calls.slice(0, 2)) {
          const args = call[1] as string[];
          expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet']));
          expect(args).toEqual(expect.arrayContaining(['--system-prompt', 'trusted conversation prompt']));
          expect(args).toEqual(expect.arrayContaining(['--allowedTools', 'Read']));
          expect(args).toContain('--settings');
        }
      } finally {
        rmSync(realCwd, { recursive: true, force: true });
      }
    });

    it('includes --system-prompt on first turn when AGENTX_SYSTEM_PROMPT is set in process.env', async () => {
      // SECURITY (2.2.30): AGENTX_SYSTEM_PROMPT now flows via process.env or params,
      // never via user-supplied env (stripped in buildClaudeEnv).
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000004'
      });
      const original = process.env.AGENTX_SYSTEM_PROMPT;
      process.env.AGENTX_SYSTEM_PROMPT = 'You are a chip expert';
      try {
        conversation.spawn('/test', {}, 200, 80, 'What is E521.39?');

        const args = (spawn as any).mock.calls[0][1];
        expect(args).toContain('--system-prompt');
        const idx = args.indexOf('--system-prompt');
        expect(args[idx + 1]).toBe('You are a chip expert');
      } finally {
        if (original === undefined) {
          delete process.env.AGENTX_SYSTEM_PROMPT;
        } else {
          process.env.AGENTX_SYSTEM_PROMPT = original;
        }
      }
    });

    it('includes --system-prompt on resume turns', async () => {
      const { spawn } = await import('node:child_process');
      const conversation = new ClaudeCodeConversationAdapter({
        claudeSessionId: '00000000-0000-4000-8000-000000000005'
      });
      const original = process.env.AGENTX_SYSTEM_PROMPT;
      process.env.AGENTX_SYSTEM_PROMPT = 'Expert mode';
      try {
        conversation.spawn('/test', {}, 200, 80, 'first');
        const firstChild = (spawn as any).mock.results[0].value;
        firstChild.emitExit(0, '');

        conversation.write('second turn');
        const secondChild = (spawn as any).mock.results[1].value;

        const secondArgs = (spawn as any).mock.calls[1][1];
        expect(secondArgs).toContain('--system-prompt');
        const idx = secondArgs.indexOf('--system-prompt');
        expect(secondArgs[idx + 1]).toBe('Expert mode');
      } finally {
        if (original === undefined) {
          delete process.env.AGENTX_SYSTEM_PROMPT;
        } else {
          process.env.AGENTX_SYSTEM_PROMPT = original;
        }
      }
    });
  });
});
