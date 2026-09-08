import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCliConfig } from '../src/cli/config.js';
import { registerUser } from '../src/cli/commands/user.js';

type Action = (...args: unknown[]) => unknown;

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let processExitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  processExitSpy = vi.spyOn(process, 'exit').mockImplementation((((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as unknown) as (code?: string | number | null | undefined) => never);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  processExitSpy.mockRestore();
});

describe('CLI user foundation', () => {
  it('registers the user command tree and root help', () => {
    const cli = createMockCac();
    registerUser(cli);

    expect(cli.commandNames).toEqual(expect.arrayContaining(['user [...args]']));

    const rootAction = cli.actions.get('user [...args]');
    expect(rootAction).toBeTypeOf('function');
    rootAction?.([], {});

    expect(consoleLogSpy).toHaveBeenCalled();
    expect(String(consoleLogSpy.mock.calls.at(-1)?.[0])).toContain('agentx user <subcommand>');
    expect(String(consoleLogSpy.mock.calls.at(-1)?.[0])).toContain('whoami');
  });

  it('uses flag values over env values and supports env-backed defaults', async () => {
    const config = await resolveCliConfig(
      {
        baseUrl: 'http://127.0.0.1:3900',
        token: 'flag-token',
        timeout: 1500
      },
      {
        env: {
          AGENTX_BASE_URL: 'http://127.0.0.1:9999',
          AGENTX_TOKEN: 'env-token',
          AGENTX_JSON: 'true',
          AGENTX_TIMEOUT: '7000'
        }
      }
    );

    expect(config.baseUrl).toBe('http://127.0.0.1:3900');
    expect(config.timeoutMs).toBe(1500);
    expect(config.json).toBe(true);
    expect(config.auth).toMatchObject({
      mode: 'bearer-token',
      source: 'flag',
      token: 'flag-token'
    });
  });

  it('returns stable json error for unknown subcommands without leaking secrets', async () => {
    const cli = createMockCac();
    registerUser(cli);

    const action = cli.actions.get('user [...args]');
    await expect(
      runAction(action, [['unknown'], { json: true, token: 'flag-secret-token', baseUrl: 'http://127.0.0.1:3000' }])
    ).rejects.toThrow('process.exit(2)');

    const stderr = String(consoleErrorSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(stderr);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        exitCode: 2
      }
    });
    expect(stderr).not.toContain('flag-secret-token');
  });
});

function createMockCac() {
  const commandNames: string[] = [];
  const actions = new Map<string, Action>();
  let currentCommand = '';
  const cli = {
    command: vi.fn().mockImplementation((name: string) => {
      currentCommand = name;
      commandNames.push(name);
      return cli;
    }),
    option: vi.fn().mockReturnThis(),
    action: vi.fn().mockImplementation((fn: Action) => {
      actions.set(currentCommand, fn);
      return cli;
    }),
    commandNames,
    actions
  };
  return cli;
}

async function runAction(action: Action | undefined, args: unknown[]): Promise<void> {
  if (!action) {
    throw new Error('Missing action');
  }
  const result = action(...args);
  if (result instanceof Promise) {
    await result;
  }
}
