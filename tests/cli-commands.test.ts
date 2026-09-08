import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Define mock functions at module scope — they must be resolvable before any import
const mockSpawn = vi.fn();
const mockPoll = vi.fn();
const mockLog = vi.fn();
const mockTail = vi.fn();
const mockKill = vi.fn();
const mockList = vi.fn();
const mockListWithPid = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();
const mockDestroy = vi.fn();

class MockSessionManager {
  spawn = mockSpawn;
  poll = mockPoll;
  log = mockLog;
  tail = mockTail;
  kill = mockKill;
  list = mockList;
  listWithPid = mockListWithPid;
  on = mockOn;
  off = mockOff;
  destroy = mockDestroy;
}

vi.mock('../src/index.js', () => ({
  SessionManager: MockSessionManager
}));

beforeEach(() => {
  vi.resetModules();
  // Reset all mocks
  mockSpawn.mockClear();
  mockPoll.mockClear();
  mockLog.mockClear();
  mockTail.mockClear();
  mockKill.mockClear();
  mockList.mockClear();
  mockListWithPid.mockClear();
  mockOn.mockClear();
  mockOff.mockClear();
  mockDestroy.mockClear();
  // Default resolved values
  mockSpawn.mockResolvedValue({
    id: 'test-session-001',
    agentType: 'claude-code',
    status: 'running',
    startedAt: 1700000000000,
    cwd: '/test',
    task: 'test task',
    pendingStdout: [],
    aggregated: '',
    truncated: false,
    totalOutputChars: 0,
    lastOutputAt: 1700000000000
  });
  mockPoll.mockResolvedValue({ hasOutput: true, exited: false, exitCode: null });
  mockLog.mockResolvedValue({
    output: 'test output content',
    truncated: false,
    totalChars: 18,
    offset: 0,
    limit: undefined
  });
  mockTail.mockResolvedValue({
    output: 'last 50 chars',
    truncated: false,
    totalChars: 50,
    offset: 0
  });
  mockKill.mockResolvedValue(undefined);
  mockListWithPid.mockReturnValue([
    {
      id: 'test-session-001',
      agentType: 'claude-code',
      status: 'running',
      cwd: '/test',
      task: 'test task',
      startedAt: 1700000000000,
      finishedAt: null,
      exitCode: null,
      totalOutputChars: 100,
      pid: 12345
    },
    {
      id: 'test-session-002',
      agentType: 'codex',
      status: 'finished',
      cwd: '/test2',
      task: 'finished task',
      startedAt: 1699999000000,
      finishedAt: 1700000000000,
      exitCode: 0,
      totalOutputChars: 200,
      pid: 12346
    }
  ]);
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENTX_FINGERPRINT_SECRET;
});

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

function getStdoutJson() {
  const calls = consoleLogSpy.mock.calls;
  const last = calls[calls.length - 1]?.[0] as string;
  try { return JSON.parse(last); }
  catch { return null; }
}

function getStderrJson() {
  const calls = consoleErrorSpy.mock.calls;
  const last = calls[calls.length - 1]?.[0] as string;
  try { return JSON.parse(last); }
  catch { return null; }
}

async function runAction(fn: (...args: unknown[]) => unknown, args: unknown[]) {
  try {
    const result = fn(...args);
    if (result instanceof Promise) await result;
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith('process.exit('))) throw e;
  }
}

function createMockCac() {
  const actions: Array<(...args: unknown[]) => unknown> = [];
  const cli = {
    command: vi.fn().mockReturnThis(),
    option: vi.fn().mockReturnThis(),
    action: vi.fn().mockImplementation(function(this: Record<string, unknown>, fn: (...args: unknown[]) => unknown) {
      actions.push(fn);
      return cli;
    }),
    version: vi.fn().mockReturnThis(),
    help: vi.fn().mockReturnThis(),
    parse: vi.fn(),
    _actions: actions
  };
  return cli;
}

function setupSpies() {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitFn: (code?: number) => never = ((code: number) => { throw new Error(`process.exit(${code})`); }) as unknown as (code?: number) => never;
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation(exitFn);
}

function restoreSpies() {
  consoleLogSpy?.mockRestore();
  consoleErrorSpy?.mockRestore();
  processExitSpy?.mockRestore();
}

describe('CLI exec command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register the exec command with correct signature', async () => {
    const { registerExec } = await import('../src/cli/commands/exec.js');
    const cli = createMockCac();
    registerExec(cli);
    expect(cli.command).toHaveBeenCalledWith('exec <agent> <task>');
  });

  it('should exit with error when task is missing', async () => {
    const { registerExec } = await import('../src/cli/commands/exec.js');
    const cli = createMockCac();
    registerExec(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['claude-code', undefined, { cwd: undefined, cols: 200, rows: 80 }]);
    const err = getStderrJson();
    expect(err).toMatchObject({ error: '<task> is required' });
  });

  it('should exit with error for invalid agent type', async () => {
    const { registerExec } = await import('../src/cli/commands/exec.js');
    const cli = createMockCac();
    registerExec(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['bad-agent', 'hello', { cwd: undefined, cols: 200, rows: 80 }]);
    const err = getStderrJson();
    expect(err).toMatchObject({ error: expect.stringContaining('Invalid agent type') });
  });

  it('should spawn session and output spawn/exit indicators', async () => {
    mockPoll.mockResolvedValue({ hasOutput: false, exited: true, exitCode: 0 });
    const { registerExec } = await import('../src/cli/commands/exec.js');
    const cli = createMockCac();
    registerExec(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['claude-code', 'hello', { cwd: '/test', cols: 200, rows: 80 }]);
    expect(mockSpawn).toHaveBeenCalled();
    const outputs = consoleLogSpy.mock.calls.map(c => String(c[0]));
    expect(outputs.some(o => o.includes('Spawned session'))).toBe(true);
    expect(outputs.some(o => o.includes('exited'))).toBe(true);
  });
});

describe('CLI spawn command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register the spawn command with correct signature', async () => {
    const { registerSpawn } = await import('../src/cli/commands/spawn.js');
    const cli = createMockCac();
    registerSpawn(cli);
    expect(cli.command).toHaveBeenCalledWith('spawn <agent> <task>');
  });

  it('should output JSON with sessionId on successful spawn', async () => {
    const { registerSpawn } = await import('../src/cli/commands/spawn.js');
    const cli = createMockCac();
    registerSpawn(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['claude-code', 'do something', { cwd: '/test', background: true }]);
    expect(mockSpawn).toHaveBeenCalled();
    const json = getStdoutJson();
    expect(json).toMatchObject({
      sessionId: 'test-session-001',
      agentType: 'claude-code',
      status: 'running'
    });
  });
});

describe('CLI log command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register log command with all option flags', async () => {
    const { registerLog } = await import('../src/cli/commands/log.js');
    const cli = createMockCac();
    registerLog(cli);
    expect(cli.command).toHaveBeenCalledWith('log <session-id>');
    expect(cli.option).toHaveBeenCalledWith('--tail <n>', expect.any(String));
    expect(cli.option).toHaveBeenCalledWith('--offset <offset>', expect.any(String));
    expect(cli.option).toHaveBeenCalledWith('--limit <limit>', expect.any(String));
  });

  it('should call manager.log with session-id and output JSON', async () => {
    const { registerLog } = await import('../src/cli/commands/log.js');
    const cli = createMockCac();
    registerLog(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['session-123', { tail: undefined, offset: 10, limit: 50 }]);
    // manager.log was called with correct arguments
    expect(mockLog).toHaveBeenCalledWith('session-123', 10, 50);
    const json = getStdoutJson();
    expect(json).toMatchObject({ sessionId: 'session-123' });
  });

  it('should call manager.tail when --tail is provided', async () => {
    const { registerLog } = await import('../src/cli/commands/log.js');
    const cli = createMockCac();
    registerLog(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['session-456', { tail: 50, offset: undefined, limit: undefined }]);
    expect(mockTail).toHaveBeenCalledWith('session-456', 50);
    expect(mockLog).not.toHaveBeenCalled();
  });
});

describe('CLI poll command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register poll command with --timeout option (default 5000ms)', async () => {
    const { registerPoll } = await import('../src/cli/commands/poll.js');
    const cli = createMockCac();
    registerPoll(cli);
    expect(cli.command).toHaveBeenCalledWith('poll <session-id>');
    expect(cli.option).toHaveBeenCalledWith('--timeout <ms>', expect.any(String), expect.objectContaining({ default: 5000 }));
  });

  it('should poll session with default timeout (5000ms)', async () => {
    const { registerPoll } = await import('../src/cli/commands/poll.js');
    const cli = createMockCac();
    registerPoll(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['session-789', { timeout: undefined }]);
    expect(mockPoll).toHaveBeenCalledWith('session-789', 5000);
    const json = getStdoutJson();
    expect(json).toMatchObject({ sessionId: 'session-789', exited: false });
  });

  it('should poll session with custom timeout', async () => {
    const { registerPoll } = await import('../src/cli/commands/poll.js');
    const cli = createMockCac();
    registerPoll(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['session-abc', { timeout: 10000 }]);
    expect(mockPoll).toHaveBeenCalledWith('session-abc', 10000);
  });

  it('should return exited=true for unknown session', async () => {
    mockPoll.mockResolvedValue({ hasOutput: false, exited: true, exitCode: null });
    const { registerPoll } = await import('../src/cli/commands/poll.js');
    const cli = createMockCac();
    registerPoll(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['unknown-session', { timeout: 5000 }]);
    const json = getStdoutJson();
    expect(json.exited).toBe(true);
    expect(json.sessionId).toBe('unknown-session');
  });
});

describe('CLI kill command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register the kill command', async () => {
    const { registerKill } = await import('../src/cli/commands/kill.js');
    const cli = createMockCac();
    registerKill(cli);
    expect(cli.command).toHaveBeenCalledWith('kill <session-id>');
  });

  it('should kill a session and output killed:true', async () => {
    const { registerKill } = await import('../src/cli/commands/kill.js');
    const cli = createMockCac();
    registerKill(cli);
    const action = cli._actions[0]!;
    await runAction(action, ['session-to-kill', { noColor: false }]);
    expect(mockKill).toHaveBeenCalledWith('session-to-kill');
    const json = getStdoutJson();
    expect(json).toMatchObject({ sessionId: 'session-to-kill', killed: true });
  });
});

describe('CLI list command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('should register the list command', async () => {
    const { registerList } = await import('../src/cli/commands/list.js');
    const cli = createMockCac();
    registerList(cli);
    expect(cli.command).toHaveBeenCalledWith('list');
  });

  it('should list sessions with correct total/running/finished counts', async () => {
    const { registerList } = await import('../src/cli/commands/list.js');
    const cli = createMockCac();
    registerList(cli);
    const action = cli._actions[0]!;
    await runAction(action, [{ noColor: false }]);
    expect(mockListWithPid).toHaveBeenCalled();
    const json = getStdoutJson();
    expect(json.total).toBe(2);
    expect(json.running).toBe(1);
    expect(json.finished).toBe(1);
    expect(json.sessions).toHaveLength(2);
  });

  it('should map session fields correctly in output', async () => {
    const { registerList } = await import('../src/cli/commands/list.js');
    const cli = createMockCac();
    registerList(cli);
    const action = cli._actions[0]!;
    await runAction(action, [{ noColor: false }]);
    const json = getStdoutJson();
    const first = json.sessions[0];
    expect(first).toMatchObject({
      id: 'test-session-001',
      agentType: 'claude-code',
      status: 'running',
      cwd: '/test',
      task: 'test task'
    });
    expect(first.startedAt).toBe(1700000000000);
    expect(first.totalOutputChars).toBe(100);
  });

  it('should return empty counts when no sessions exist', async () => {
    mockListWithPid.mockReturnValue([]);
    const { registerList } = await import('../src/cli/commands/list.js');
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitFn3: (code?: number) => never = ((code: number) => { throw new Error(`process.exit(${code})`); }) as unknown as (code?: number) => never;
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(exitFn3);

    const cli = createMockCac();
    registerList(cli);
    const action = cli._actions[0]!;
    await runAction(action, [{ noColor: false }]);
    const json = getStdoutJson();
    expect(json.total).toBe(0);
    expect(json.running).toBe(0);
    expect(json.finished).toBe(0);
    expect(json.sessions).toHaveLength(0);
    mockListWithPid.mockReturnValue([
      {
        id: 'test-session-001',
        agentType: 'claude-code',
        status: 'running',
        cwd: '/test',
        task: 'test task',
        startedAt: 1700000000000,
        finishedAt: null,
        exitCode: null,
        totalOutputChars: 100,
        pid: 12345
      },
      {
        id: 'test-session-002',
        agentType: 'codex',
        status: 'finished',
        cwd: '/test2',
        task: 'finished task',
        startedAt: 1699999000000,
        finishedAt: 1700000000000,
        exitCode: 0,
        totalOutputChars: 200,
        pid: 12346
      }
    ]);
  });
});

describe('CLI server command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  it('registers data dir and file logging options', async () => {
    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();

    registerServer(cli);

    expect(cli.command).toHaveBeenCalledWith('server', 'Start the AgentX HTTP/Web server');
    expect(cli.option).toHaveBeenCalledWith('--data-dir <dir>', expect.stringContaining('persistence data'));
    expect(cli.option).toHaveBeenCalledWith('--product-config <file>', expect.stringContaining('Product shell'));
    expect(cli.option).toHaveBeenCalledWith('--file-logs', expect.stringContaining('structured'));
    expect(cli.option).toHaveBeenCalledWith('--log-retention-days <days>', expect.stringContaining('retain'));
  });

  it('passes data dir and logging configuration to startHttpServer', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
      dataDir: 'D:/legacy-data'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [
      {
        host: '127.0.0.1',
        port: 0,
        publicDir: 'public',
        dataDir: 'D:/agentx-data',
        productConfig: 'D:/agentx-product.json',
        fileLogs: true,
        logRetentionDays: 14,
        // This is the real shape cac produces for `--no-auth`: a negated boolean option keeps
        // its base name (`auth`), so cac sets `options.auth = false` — not `options.noAuth`.
        auth: false
      }
    ]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        persistence: {
          dataDir: 'D:/agentx-data',
          fileLogging: true,
          retentionDays: 14
        },
        product: {
          configFile: 'D:/agentx-product.json'
        }
      })
    );
    expect(mockGetAuthConfig).not.toHaveBeenCalled();

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('uses the CLI data dir for auth and persistence when auth is enabled', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve',
      dataDir: 'D:/legacy-data'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [
      {
        host: '127.0.0.1',
        port: 0,
        publicDir: 'public',
        dataDir: 'D:/agentx-data',
        fileLogs: true,
        logRetentionDays: 14
      }
    ]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          enabled: true,
          config: expect.objectContaining({ dataDir: 'D:/agentx-data' })
        }),
        persistence: expect.objectContaining({ dataDir: 'D:/agentx-data' })
      })
    );

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('stores mutable chip grants under the CLI data dir by default', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [{ dataDir: 'D:/agentx-data', port: 0 }]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        chips: expect.objectContaining({
          userAccessFile: path.join('D:/agentx-data', 'config', 'user-chip-access.json')
        })
      })
    );

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('lets CHIP_USER_ACCESS_FILE override the CLI chip grants path', async () => {
    const previous = process.env.CHIP_USER_ACCESS_FILE;
    process.env.CHIP_USER_ACCESS_FILE = 'D:/agentx-custom/user-chip-access.json';
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({
      getAuthConfig: vi.fn().mockReturnValue({
        jwtSecret: '0123456789abcdef0123456789abcdef',
        jwtExpiresIn: '24h',
        adminUser: 'admin',
        adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
      })
    }));

    try {
      const { registerServer } = await import('../src/cli/commands/server.js');
      const cli = createMockCac();
      registerServer(cli);
      const action = cli._actions[0]!;

      await runAction(action, [{ dataDir: 'D:/agentx-data', port: 0 }]);

      expect(mockStartHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          chips: expect.objectContaining({
            userAccessFile: 'D:/agentx-custom/user-chip-access.json'
          })
        })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.CHIP_USER_ACCESS_FILE;
      } else {
        process.env.CHIP_USER_ACCESS_FILE = previous;
      }
      vi.doUnmock('../src/http-server.js');
      vi.doUnmock('../src/auth/index.js');
    }
  });

  it('enables the resource catalog runtime with the default config path by default', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [{ port: 0 }]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: expect.objectContaining({ enabled: true, configFile: undefined })
      })
    );

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('lets --resource-config point the resource catalog runtime at a custom file', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [{ port: 0, resourceConfig: 'D:/agentx-custom/resource-visibility.json' }]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: expect.objectContaining({
          enabled: true,
          configFile: 'D:/agentx-custom/resource-visibility.json'
        })
      })
    );

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('lets AGENTX_RESOURCE_CONFIG_FILE override the resource catalog path', async () => {
    const previous = process.env.AGENTX_RESOURCE_CONFIG_FILE;
    process.env.AGENTX_RESOURCE_CONFIG_FILE = 'D:/agentx-env/resource-visibility.json';
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({
      getAuthConfig: vi.fn().mockReturnValue({
        jwtSecret: '0123456789abcdef0123456789abcdef',
        jwtExpiresIn: '24h',
        adminUser: 'admin',
        adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
      })
    }));

    try {
      const { registerServer } = await import('../src/cli/commands/server.js');
      const cli = createMockCac();
      registerServer(cli);
      const action = cli._actions[0]!;

      await runAction(action, [{ port: 0 }]);

      expect(mockStartHttpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          resources: expect.objectContaining({
            enabled: true,
            configFile: 'D:/agentx-env/resource-visibility.json'
          })
        })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.AGENTX_RESOURCE_CONFIG_FILE;
      } else {
        process.env.AGENTX_RESOURCE_CONFIG_FILE = previous;
      }
      vi.doUnmock('../src/http-server.js');
      vi.doUnmock('../src/auth/index.js');
    }
  });

  it('disables auth only when cac reports the negated --no-auth flag (options.auth === false)', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    // This is the actual shape cac produces for `--no-auth`: a negated boolean option keeps its
    // base name (`auth`), so cac sets `options.auth = false` — there is no `noAuth` field.
    await runAction(action, [{ port: 0, auth: false }]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({ auth: { enabled: false } })
    );
    expect(mockGetAuthConfig).not.toHaveBeenCalled();

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('keeps auth enabled when --no-auth is not passed (options.auth left undefined by cac)', async () => {
    const mockStartHttpServer = vi.fn().mockResolvedValue(undefined);
    const mockGetAuthConfig = vi.fn().mockReturnValue({
      jwtSecret: '0123456789abcdef0123456789abcdef',
      jwtExpiresIn: '24h',
      adminUser: 'admin',
      adminPasswordHash: '$2a$10$abcdefghijklmnopqrstuu8sQO2VmuT7Sx9rmtFVrPdG7oVpF6Bve'
    });

    vi.resetModules();
    vi.doMock('../src/http-server.js', () => ({ startHttpServer: mockStartHttpServer }));
    vi.doMock('../src/auth/index.js', () => ({ getAuthConfig: mockGetAuthConfig }));

    const { registerServer } = await import('../src/cli/commands/server.js');
    const cli = createMockCac();
    registerServer(cli);
    const action = cli._actions[0]!;

    await runAction(action, [{ port: 0 }]);

    expect(mockStartHttpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ enabled: true })
      })
    );
    expect(mockGetAuthConfig).toHaveBeenCalled();

    vi.doUnmock('../src/http-server.js');
    vi.doUnmock('../src/auth/index.js');
  });

  it('registers CLI version from the product version helper', async () => {
    vi.resetModules();
    const mockCac = vi.fn(() => createMockCac());
    vi.doMock('cac', () => ({ default: mockCac }));

    await import('../src/cli/index.js');

    const cli = mockCac.mock.results[0]?.value;
    expect(cli.version).toHaveBeenCalledWith('2.2.45');

    vi.doUnmock('cac');
  });

  it('keeps CLI version anchored to AgentX when launched from a host project cwd', async () => {
    const originalCwd = process.cwd();
    const hostProject = await mkdtemp(path.join(tmpdir(), 'agentx-host-cli-'));
    await writeFile(path.join(hostProject, 'package.json'), JSON.stringify({ version: '9.9.9-host' }), 'utf8');

    vi.resetModules();
    const mockCac = vi.fn(() => createMockCac());
    vi.doMock('cac', () => ({ default: mockCac }));

    try {
      process.chdir(hostProject);
      await import('../src/cli/index.js');

      const cli = mockCac.mock.results[0]?.value;
      expect(cli.version).toHaveBeenCalledWith('2.2.45');
      expect(cli.version).not.toHaveBeenCalledWith('9.9.9-host');
    } finally {
      process.chdir(originalCwd);
      vi.doUnmock('cac');
    }
  });
});

describe('CLI fingerprint command', () => {
  beforeEach(() => setupSpies());
  afterEach(() => restoreSpies());

  async function signedMarker() {
    const { createFingerprintMarker } = await import('../src/fingerprint/index.js');
    return createFingerprintMarker(
      {
        enabled: true,
        level: 'light',
        owner: 'AgentX',
        deploymentId: 'deployment',
        channel: 'cli',
        version: '2.2.10',
        keyId: 'key',
        secret: 'cli-test-secret'
      },
      { issuedAt: '2026-05-14T00:00:00.000Z', nonce: 'nonce' }
    )!;
  }

  it('registers fingerprint verify command', async () => {
    const { registerFingerprint } = await import('../src/cli/commands/fingerprint.js');
    const cli = createMockCac();
    registerFingerprint(cli);

    expect(cli.command).toHaveBeenCalledWith('fingerprint <action>', 'Verify AgentX lightweight fingerprint markers');
    expect(cli.option).toHaveBeenCalledWith('--text <text>', expect.any(String));
    expect(cli.option).toHaveBeenCalledWith('--file <path>', expect.any(String));
  });

  it('verifies valid, invalid, and missing markers as JSON', async () => {
    const { registerFingerprint } = await import('../src/cli/commands/fingerprint.js');
    const cli = createMockCac();
    registerFingerprint(cli);
    const action = cli._actions[0]!;
    const marker = await signedMarker();

    process.env.AGENTX_FINGERPRINT_SECRET = 'cli-test-secret';
    await runAction(action, ['verify', { text: marker }]);
    expect(getStdoutJson()).toMatchObject({ status: 'verified', summary: { deploymentId: 'deployment' } });

    await runAction(action, ['verify', { text: `${marker}tampered` }]);
    expect(getStdoutJson()).toMatchObject({ status: 'present-but-invalid' });

    await runAction(action, ['verify', { text: 'plain text' }]);
    expect(getStdoutJson()).toMatchObject({ status: 'not-found' });

    const stdout = consoleLogSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(stdout).not.toContain('cli-test-secret');
  });

  it('is callable through the real cac parser as agentx fingerprint verify', async () => {
    const { default: cac } = await import('cac');
    const { registerFingerprint } = await import('../src/cli/commands/fingerprint.js');
    const cli = cac('agentx');
    registerFingerprint(cli);
    processExitSpy.mockImplementation((() => undefined) as never);

    cli.parse(['node', 'agentx', 'fingerprint', 'verify', '--text', 'plain text']);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getStdoutJson()).toMatchObject({ status: 'not-found' });
  });

  it('returns a safe error for missing files', async () => {
    const { registerFingerprint } = await import('../src/cli/commands/fingerprint.js');
    const cli = createMockCac();
    registerFingerprint(cli);
    const action = cli._actions[0]!;

    await runAction(action, ['verify', { file: 'D:/does-not-exist/fingerprint.txt' }]);

    expect(getStderrJson()).toMatchObject({ error: expect.stringContaining('Unable to read fingerprint file') });
    expect(getStderrJson().error).not.toContain('AGENTX_FINGERPRINT_SECRET');
  });
});
