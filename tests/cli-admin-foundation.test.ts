import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCliConfig } from '../src/cli/config.js';
import { registerAdmin } from '../src/cli/commands/admin.js';

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

describe('CLI admin foundation', () => {
  it('registers the admin command tree and root help', () => {
    const cli = createMockCac();
    registerAdmin(cli);

    expect(cli.commandNames).toEqual(expect.arrayContaining(['admin [...args]']));

    const rootAction = cli.actions.get('admin [...args]');
    rootAction?.([], {});
    expect(String(consoleLogSpy.mock.calls.at(-1)?.[0])).toContain('agentx admin <subcommand>');
    expect(String(consoleLogSpy.mock.calls.at(-1)?.[0])).toContain('model-auth');
  });

  it('reports validation errors through the stable json contract', async () => {
    const cli = createMockCac();
    registerAdmin(cli);

    const action = cli.actions.get('admin [...args]');
    await expect(runAction(action, [['users'], { json: true, baseUrl: 'not-a-url' }])).rejects.toThrow('process.exit(2)');

    const stderr = String(consoleErrorSpy.mock.calls.at(-1)?.[0] ?? '');
    const payload = JSON.parse(stderr);
    expect(payload).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        exitCode: 2
      }
    });
  });

  it('prefers flag auth over env auth for admin CLI config resolution', async () => {
    const config = await resolveCliConfig(
      {
        token: 'flag-admin-token',
        baseUrl: 'http://127.0.0.1:3901',
        timeout: 900
      },
      {
        env: {
          AGENTX_TOKEN: 'env-admin-token',
          AGENTX_BASE_URL: 'http://127.0.0.1:3999',
          AGENTX_JSON: 'true',
          AGENTX_TIMEOUT: '5000'
        }
      }
    );

    expect(config.baseUrl).toBe('http://127.0.0.1:3901');
    expect(config.timeoutMs).toBe(900);
    expect(config.json).toBe(true);
    expect(config.auth).toMatchObject({
      mode: 'bearer-token',
      source: 'flag',
      token: 'flag-admin-token'
    });
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
