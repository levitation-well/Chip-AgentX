import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AdapterState, ProcessAdapter, TrustedClaudeSpawnOptions, TurnState } from '../types.js';
import { DEFAULT_LANG } from '../utils.js';
import { isClaudeModelRole } from '../model-routing.js';

type ClaudeDataHandler = (data: string) => void;
type ClaudeExitHandler = (code: number, signal: string) => void;
type ClaudeStateHandler = (state: AdapterState) => void;

interface ClaudeCodeConversationAdapterOptions {
  claudeSessionId?: string;
  resumeFirstTurn?: boolean;
  initialTurnCount?: number;
}

interface ClaudeTurnParams extends TrustedClaudeSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  task: string;
  claudeSessionId?: string;
  resume?: boolean;
  dangerouslySkipPermissions?: boolean; // server-controlled flag, replaces user env injection
}

type WritableChildStdin = NodeJS.WritableStream & {
  write(chunk: string): boolean;
  end(chunk?: string): void;
  destroyed: boolean;
};

/**
 * Child Adapter for Claude Code --print mode
 * Uses child_process spawn instead of PTY since --print mode is non-interactive
 */
export class ChildAdapter implements ProcessAdapter {
  private child?: ChildProcess;
  private readonly dataHandlers: ClaudeDataHandler[] = [];
  private readonly exitHandlers: ClaudeExitHandler[] = [];
  private stdinWritable?: WritableChildStdin;
  private exited = false;

  /**
   * Spawn Claude Code with --print mode
   */
  spawn(
    cwd: string,
    env: Record<string, string>,
    _cols: number,
    _rows: number,
    task: string,
    trustedClaudeOptions: TrustedClaudeSpawnOptions = {}
  ): void {
    this.exited = false;

    try {
      this.child = spawnClaudeCodeTurn({ cwd, env, task, ...trustedClaudeOptions });
    } catch (error) {
      this.handleSpawnError(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    this.stdinWritable = this.child.stdin as WritableChildStdin;

    if (task) {
      this.stdinWritable.end(task);
    }

    this.child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      this.dataHandlers.forEach((handler) => handler(data));
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      // Log non-warning stderr for debugging
      if (!data.includes('Warning:')) {
        console.error('[claude-code stderr]', data);
      }
      this.dataHandlers.forEach((handler) => handler(data));
    });

    this.child.on('exit', (code: number | null, signal: string | null) => {
      this.emitExit(code ?? 0, signal ?? '');
    });

    this.child.on('error', (err: Error) => {
      this.handleSpawnError(err);
    });
  }

  /**
   * Write data to stdin (no newline appended)
   */
  write(data: string): void {
    if (this.stdinWritable && !this.stdinWritable.destroyed) {
      this.stdinWritable.write(data);
    }
  }

  /**
   * Kill the child process with SIGTERM
   */
  kill(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
    }
  }

  /**
   * Register a data handler
   */
  onData(handler: (data: string) => void): void {
    this.dataHandlers.push(handler);
  }

  /**
   * Register an exit handler
   */
  onExit(handler: (code: number, signal: string) => void): void {
    this.exitHandlers.push(handler);
  }

  /**
   * Remove a data handler
   */
  removeDataHandler(handler: (data: string) => void): void {
    const index = this.dataHandlers.indexOf(handler);
    if (index > -1) {
      this.dataHandlers.splice(index, 1);
    }
  }

  /**
   * Remove an exit handler
   */
  removeExitHandler(handler: (code: number, signal: string) => void): void {
    const index = this.exitHandlers.indexOf(handler);
    if (index > -1) {
      this.exitHandlers.splice(index, 1);
    }
  }

  /**
   * Get the process PID
   */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private emitExit(code: number, signal: string): void {
    if (this.exited) {
      return;
    }

    this.exited = true;
    this.exitHandlers.forEach((handler) => handler(code, signal));
  }

  private handleSpawnError(error: Error): void {
    const message = `[claude-code error] ${error.message}\n`;
    console.error(message.trim());
    this.dataHandlers.forEach((handler) => handler(message));
    this.emitExit(1, '');
  }
}

/**
 * Logical multi-turn Claude Code adapter.
 * Each turn is a short `claude --print` child process, while the AgentX
 * session remains running between successful turns.
 */
export class ClaudeCodeConversationAdapter implements ProcessAdapter {
  private child?: ChildProcess;
  private cwd?: string;
  private env: Record<string, string> = {};
  private trustedClaudeOptions: TrustedClaudeSpawnOptions = {};
  private readonly dataHandlers: ClaudeDataHandler[] = [];
  private readonly exitHandlers: ClaudeExitHandler[] = [];
  private readonly stateHandlers: ClaudeStateHandler[] = [];
  private logicalExited = false;
  private currentTurnState: TurnState = 'idle';
  private currentTurnCount = 0;
  readonly claudeSessionId: string;
  private readonly resumeFirstTurn: boolean;

  constructor(options: ClaudeCodeConversationAdapterOptions = {}) {
    this.claudeSessionId = options.claudeSessionId ?? crypto.randomUUID();
    this.resumeFirstTurn = options.resumeFirstTurn ?? false;
    const initialTurnCount = options.initialTurnCount;
    this.currentTurnCount = Number.isInteger(initialTurnCount) && initialTurnCount !== undefined && initialTurnCount >= 0
      ? initialTurnCount
      : 0;
  }

  spawn(
    cwd: string,
    env: Record<string, string>,
    _cols: number,
    _rows: number,
    task: string,
    trustedClaudeOptions: TrustedClaudeSpawnOptions = {}
  ): void {
    this.cwd = cwd;
    this.env = env;
    this.trustedClaudeOptions = trustedClaudeOptions;
    this.logicalExited = false;
    this.startTurn(task, this.resumeFirstTurn);
  }

  write(data: string): void {
    if (this.currentTurnState === 'running') {
      throw new Error('Claude Code turn is already running');
    }
    if (!this.cwd) {
      throw new Error('Claude Code conversation has not been started');
    }

    this.startTurn(data, true);
  }

  kill(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
    }
  }

  onData(handler: ClaudeDataHandler): void {
    this.dataHandlers.push(handler);
  }

  onExit(handler: ClaudeExitHandler): void {
    this.exitHandlers.push(handler);
  }

  onState(handler: ClaudeStateHandler): void {
    this.stateHandlers.push(handler);
  }

  removeDataHandler(handler: ClaudeDataHandler): void {
    const index = this.dataHandlers.indexOf(handler);
    if (index > -1) {
      this.dataHandlers.splice(index, 1);
    }
  }

  removeExitHandler(handler: ClaudeExitHandler): void {
    const index = this.exitHandlers.indexOf(handler);
    if (index > -1) {
      this.exitHandlers.splice(index, 1);
    }
  }

  removeStateHandler(handler: ClaudeStateHandler): void {
    const index = this.stateHandlers.indexOf(handler);
    if (index > -1) {
      this.stateHandlers.splice(index, 1);
    }
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get turnState(): TurnState {
    return this.currentTurnState;
  }

  get turnCount(): number {
    return this.currentTurnCount;
  }

  private startTurn(task: string, resume: boolean): void {
    if (!this.cwd) {
      throw new Error('Claude Code conversation has no working directory');
    }

    this.currentTurnCount += 1;
    this.currentTurnState = 'running';
    this.emitState();

    let turnSettled = false;
    try {
      this.child = spawnClaudeCodeTurn({
        cwd: this.cwd,
        env: this.env,
        task,
        claudeSessionId: this.claudeSessionId,
        resume,
        ...this.trustedClaudeOptions
      });
    } catch (error) {
      this.handleTurnFailure(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const stdinWritable = this.child.stdin as WritableChildStdin;
    stdinWritable.end(task);

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.emitData(chunk.toString());
    });

    this.child.stderr?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      if (!data.includes('Warning:')) {
        console.error('[claude-code stderr]', data);
      }
      this.emitData(data);
    });

    this.child.on('exit', (code: number | null, signal: string | null) => {
      if (turnSettled) {
        return;
      }
      turnSettled = true;
      this.child = undefined;

      const normalizedCode = code ?? 0;
      if (normalizedCode === 0) {
        this.currentTurnState = 'idle';
        this.emitState();
        return;
      }

      this.handleTurnExit(normalizedCode, signal ?? '');
    });

    this.child.on('error', (error: Error) => {
      if (turnSettled) {
        return;
      }
      turnSettled = true;
      this.child = undefined;
      this.handleTurnFailure(error);
    });
  }

  private emitData(data: string): void {
    this.dataHandlers.forEach((handler) => handler(data));
  }

  private emitState(): void {
    const state = {
      turnState: this.currentTurnState,
      turnCount: this.currentTurnCount,
      claudeSessionId: this.claudeSessionId
    };
    this.stateHandlers.forEach((handler) => handler(state));
  }

  private handleTurnFailure(error: Error): void {
    const message = `[claude-code error] ${error.message}\n`;
    console.error(message.trim());
    this.emitData(message);
    this.handleTurnExit(1, '');
  }

  private handleTurnExit(code: number, signal: string): void {
    if (this.logicalExited) {
      return;
    }

    this.logicalExited = true;
    this.currentTurnState = 'idle';
    this.emitState();
    this.exitHandlers.forEach((handler) => handler(code, signal));
  }
}

function spawnClaudeCodeTurn(params: ClaudeTurnParams): ChildProcess {
  const mergedEnv = buildClaudeEnv(params.env, params.cwd);
  const claudeCommand = mergedEnv.AGENTX_CLAUDE_COMMAND || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
  const spawnArgs = buildClaudeArgs(mergedEnv, params);

  const spawnOptions: Record<string, unknown> = {
    cwd: params.cwd,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'] as unknown as ['pipe', 'pipe', 'pipe']
  };
  if (process.platform === 'win32' && commandRequiresShell(claudeCommand)) {
    spawnOptions.shell = true;
  }

  return spawn(claudeCommand, spawnArgs, spawnOptions);
}

/**
 * Security-critical keys that must NEVER be overridable by user-supplied env.
 * These are set by the server-side session manager to enforce isolation;
 * a hostile client must not be able to bypass them by passing them in the
 * user-facing `env` field of `agent_spawn`.
 *
 * - AGENTX_CLAUDE_COMMAND: controls which binary/script is executed; must never
 *   be user-controlled (Windows .cmd/.bat enables shell:true → code injection).
 * - AGENTX_PERMISSION_MODE / AGENTX_ALLOWED_TOOLS / AGENTX_DENY_READ_ROOTS:
 *   set by the server as part of the isolation闸; user-provided values are
 *   stripped and the server's values (via params → buildClaudeArgs) take over.
 * - AGENTX_CLAUDE_MODEL_ROLE: controls `--model`; user override would let a
 *   client route a multimodal/enhanced model under a standard credit budget,
 *   bypassing credit attribution.
 * - AGENTX_SYSTEM_PROMPT: controls `--system-prompt`; user override would
 *   break prompt-injection defenses for the chip workspace.
 * - AGENTX_CLAUDE_SKIP_PERMISSIONS: when set to "1" enables
 *   --dangerously-skip-permissions; user-controlled env injection here would
 *   silently bypass the isolation gate.
 * - CLAUDE_CODE_GIT_BASH_PATH: Windows-only — controls the bash interpreter
 *   path used for tool execution; user injection could redirect execution.
 */
const AGENTX_SERVER_SECURITY_KEYS = new Set([
  'AGENTX_CLAUDE_COMMAND',
  'AGENTX_PERMISSION_MODE',
  'AGENTX_ALLOWED_TOOLS',
  'AGENTX_DENY_READ_ROOTS',
  'AGENTX_CLAUDE_MODEL_ROLE',
  'AGENTX_SYSTEM_PROMPT',
  'AGENTX_CLAUDE_SKIP_PERMISSIONS',
  'CLAUDE_CODE_GIT_BASH_PATH'
]);

function buildClaudeEnv(env: Record<string, string>, cwd: string): NodeJS.ProcessEnv {
  // SECURITY: strip the server-hardened keys listed in AGENTX_SERVER_SECURITY_KEYS
  // so user-supplied env (e.g. from agent_spawn.env) cannot override them. All other
  // AGENTX_*-prefixed keys are allowed through. Server values for the stripped keys
  // are injected by the upstream session manager via ClaudeTurnParams
  // (params.permissionMode / params.allowedTools / params.denyReadRoots take priority
  // inside buildClaudeArgs), so the absence in env is safe and intentional.
  const filteredEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !AGENTX_SERVER_SECURITY_KEYS.has(key.toUpperCase()))
  );
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: DEFAULT_LANG,
    PWD: cwd,
    INIT_CWD: cwd,
    AGENTX_WORKSPACE_DIR: cwd,
    ...filteredEnv
  };

  if (process.platform === 'win32' && !mergedEnv.CLAUDE_CODE_GIT_BASH_PATH) {
    // Infer only from the server process environment. The caller may override
    // its child PATH, but must not steer which bash executable Claude uses.
    const gitBashPath = inferGitBashPath(process.env);
    if (gitBashPath) {
      mergedEnv.CLAUDE_CODE_GIT_BASH_PATH = gitBashPath;
    }
  }

  return mergedEnv;
}

function commandRequiresShell(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat');
}

/** 拆分服务端进程级兼容 env：按分隔符切分、trim、过滤空串。 */
export function splitNonEmpty(value: string | undefined, sep: string): string[] {
  if (!value) return [];
  return value
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildClaudeArgs(env: NodeJS.ProcessEnv, params: ClaudeTurnParams): string[] {
  const spawnArgs = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json'
  ];

  // Model role: prefer server params, fall back to process env
  // (env comes from buildClaudeEnv which filters out user-supplied
  // AGENTX_CLAUDE_MODEL_ROLE; process.env value is server-controlled).
  const envModelRole = env.AGENTX_CLAUDE_MODEL_ROLE;
  const modelRole =
    params.claudeModelRole && isClaudeModelRole(params.claudeModelRole)
      ? params.claudeModelRole
      : isClaudeModelRole(envModelRole)
        ? envModelRole
        : undefined;
  if (modelRole) {
    spawnArgs.push('--model', modelRole);
  }

  // 三重加固通道：优先 params 直传，回退 env(与 systemPrompt 同构)。
  // 安全收口：permission-mode 必须落在白名单内；env 注入的任意字符串(如 acceptEdits)
  // 若不在白名单一律回退到最严的 default，杜绝经 env 击穿权限隔离。
  const ALLOWED_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);
  const requestedMode = params.permissionMode ?? env.AGENTX_PERMISSION_MODE;
  const permissionMode = ALLOWED_PERMISSION_MODES.has(requestedMode ?? '') ? requestedMode! : 'default';
  const allowedTools = params.allowedTools ?? splitNonEmpty(env.AGENTX_ALLOWED_TOOLS, ',');
  const denyReadRoots = params.denyReadRoots ?? splitNonEmpty(env.AGENTX_DENY_READ_ROOTS, '\n');
  // 是否请求了加固：deny 源根或只读工具集任一非空即视为加固请求。
  const hardened = denyReadRoots.length > 0 || allowedTools.length > 0;

  // 安全规则：加固存在时，严格模式必须压过 skip 逃生舱——
  // 防止云端进程全局设了 AGENTX_CLAUDE_SKIP_PERMISSIONS 而悄悄击穿隔离。
  // 注意：AGENTX_CLAUDE_SKIP_PERMISSIONS 已被 buildClaudeEnv 从 user env 中剥离，
  // 这里读到的是 process.env 的值（服务端受控）。params.dangerouslySkipPermissions 优先级更高。
  if ((params.dangerouslySkipPermissions || env.AGENTX_CLAUDE_SKIP_PERMISSIONS === '1') && !hardened) {
    spawnArgs.splice(2, 0, '--dangerously-skip-permissions');
  } else {
    spawnArgs.push('--permission-mode', permissionMode ?? 'default');
  }

  // 只读工具集：堵 Bash/Write/联网。
  if (allowedTools.length > 0) {
    spawnArgs.push('--allowedTools', allowedTools.join(','));
  }

  // deny 源根硬墙：兼容 Windows 正反斜杠，每个源根生成两条 Read() 规则。
  // 实证：Windows 上 spawn('claude.cmd', args, {shell:true}) 经 cmd.exe 传递内联 JSON 串时
  // 双引号被吞，claude 报 `Invalid JSON provided to --settings` 并 EXIT 1（加固失效）。
  // 改用 `--settings <文件路径>`：路径无 shell 特殊字符，cmd.exe 不破坏；文件写在 cwd（隔离副本）
  // 内，随副本 cleanup 一起删除，无需额外清理。
  if (denyReadRoots.length > 0 && params.cwd) {
    const deny = denyReadRoots.flatMap((root) => {
      // 先剥掉尾部分隔符，避免 `E:/kb/` 生成 `Read(E:/kb//**)` 双斜杠导致 glob 行为不确定。
      const trimmed = root.replace(/[\\/]+$/, '');
      const fwd = trimmed.replace(/\\/g, '/');
      const back = trimmed.replace(/\//g, '\\');
      return [`Read(${fwd}/**)`, `Read(${back}\\**)`];
    });
    const settingsPath = path.join(params.cwd, '.agentx-claude-settings.json');
    writeFileSync(settingsPath, JSON.stringify({ permissions: { deny } }), 'utf8');
    spawnArgs.push('--settings', settingsPath);
  }

  if (params.cwd) {
    spawnArgs.push('--add-dir', params.cwd);
  }

  if (params.claudeSessionId) {
    spawnArgs.push(params.resume ? '--resume' : '--session-id', params.claudeSessionId);
  }

  // System prompt: prefer params.systemPrompt (direct), fallback to env var
  // (env value is server-controlled: AGENTX_SYSTEM_PROMPT is stripped from
  // user-supplied env in buildClaudeEnv, only process.env survives).
  const systemPrompt = params.systemPrompt ?? env.AGENTX_SYSTEM_PROMPT;
  if (systemPrompt) {
    spawnArgs.push('--system-prompt', systemPrompt);
  }

  return spawnArgs;
}

function inferGitBashPath(env: NodeJS.ProcessEnv): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
  const candidates: string[] = [];

  for (const entry of pathEntries) {
    const normalized = entry.replace(/\//g, '\\');
    const lower = normalized.toLowerCase();
    if (lower.endsWith('\\git\\cmd') || lower.endsWith('\\cmd')) {
      candidates.push(path.resolve(entry, '..', 'bin', 'bash.exe'));
    }
    if (lower.endsWith('\\git\\bin') || lower.endsWith('\\bin')) {
      candidates.push(path.resolve(entry, 'bash.exe'));
    }
  }

  candidates.push(
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  );

  return candidates.find((candidate) => existsSync(candidate));
}
