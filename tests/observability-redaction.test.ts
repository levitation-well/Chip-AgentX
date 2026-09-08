import { describe, expect, it } from 'vitest';
import {
  redactDebugText,
  redactDebugValue,
  redactSystemPromptForDebugBundle
} from '../src/observability/redaction.js';

describe('observability debug redaction', () => {
  it('redacts secrets, JWTs and local/server paths while preserving useful text', () => {
    const result = redactDebugText([
      'answer: E522.49 supports sleep mode',
      'authorization: Bearer abc.def.ghijklmnopqrstuvwxyz',
      'cwd=D:\\repo\\chip-agentx\\internal.md',
      'server=/opt/chip-agentx/config',
      'system prompt: hidden rules'
    ].join('\n'));

    expect(result.text).toContain('E522.49 supports sleep mode');
    expect(result.text).toContain('[REDACTED_SECRET]');
    expect(result.text).toContain('[REDACTED_PATH]');
    expect(result.text).toContain('[REDACTED_SYSTEM_PROMPT]');
    expect(result.text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(result.text).not.toContain('D:\\repo\\chip-agentx');
    expect(result.redacted).toEqual(expect.arrayContaining(['secret', 'path', 'system-prompt']));
  });

  it('redacts sensitive object keys recursively', () => {
    expect(redactDebugValue({ nested: { apiKey: 'secret-value' }, text: 'ok' })).toEqual({
      nested: { apiKey: '[REDACTED_SECRET]' },
      text: 'ok'
    });
  });

  it('redacts common standalone provider keys, cookies, URL secrets, private keys and Unix paths', () => {
    const result = redactDebugText([
      'openai=sk-abcdefghijklmnopqrstuvwxyz123456',
      'aws=AKIAABCDEFGHIJKLMNOP',
      'Set-Cookie: session=secret; HttpOnly',
      'callback=https://example.test/cb?token=secret-token&ok=1',
      'key=-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----',
      'unc=\\\\server\\share\\secret.txt',
      'unix=/home/user/project/.env',
      'data=/opt/chip-agentx/data/users.json'
    ].join('\n'));

    expect(result.text).toContain('[REDACTED_SECRET]');
    expect(result.text).toContain('token=[REDACTED_SECRET]');
    expect(result.text).toContain('[REDACTED_PATH]');
    expect(result.text).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(result.text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(result.text).not.toContain('session=secret');
    expect(result.text).not.toContain('\\\\server\\share');
    expect(result.text).not.toContain('/home/user/project');
    expect(result.text).not.toContain('/opt/chip-agentx');
  });

  it('keeps system prompt content in the debug-bundle prompt variant while redacting secrets and paths', () => {
    const result = redactSystemPromptForDebugBundle([
      'system prompt: keep the instruction body for admin diagnostics',
      'developer message: preserve this text too',
      'api_key=sk-test-secret',
      'abc.def.ghijklmnopqrstuvwxyz',
      'workspace=D:\\repo\\chip-agentx\\private',
      'server=/opt/chip-agentx/config'
    ].join('\n'));

    expect(result.text).toContain('keep the instruction body');
    expect(result.text).toContain('preserve this text too');
    expect(result.text).not.toContain('[REDACTED_SYSTEM_PROMPT]');
    expect(result.text).toContain('[REDACTED_SECRET]');
    expect(result.text).toContain('[REDACTED_JWT]');
    expect(result.text).toContain('[REDACTED_PATH]');
    expect(result.text).not.toContain('D:\\repo\\chip-agentx');
    expect(result.redacted).toEqual(expect.arrayContaining(['jwt', 'path', 'secret']));
    expect(result.redacted).not.toContain('system-prompt');
  });
});
