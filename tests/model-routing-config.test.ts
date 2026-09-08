import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_CLAUDE_MODEL_ROLES,
  DEFAULT_MODE_ROLE_MAPPING,
  normalizeModeRoleMapping
} from '../src/model-routing.js';

describe('mode to Claude role routing config', () => {
  it('uses a thin default mapping without provider model names', () => {
    expect(ALLOWED_CLAUDE_MODEL_ROLES).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    expect(DEFAULT_MODE_ROLE_MAPPING).toEqual({
      standard: 'haiku',
      enhanced: 'sonnet',
      multimodal: 'opus'
    });
  });

  it('fills missing modes from defaults and rejects unknown Claude roles', () => {
    expect(normalizeModeRoleMapping({ standard: 'fable' })).toEqual({
      standard: 'fable',
      enhanced: 'sonnet',
      multimodal: 'opus'
    });

    expect(() => normalizeModeRoleMapping({ enhanced: 'real-provider-model' })).toThrow(
      /Unsupported Claude model role/
    );
  });

  it('does not expose legacy provider model names in public Remote MCP templates', async () => {
    const templates = await Promise.all([
      readFile(join(process.cwd(), 'public', 'mcp-templates', 'claude-code.md'), 'utf8'),
      readFile(join(process.cwd(), 'public', 'mcp-templates', 'codex.md'), 'utf8'),
      readFile(join(process.cwd(), 'public', 'mcp-templates', 'opencode.json'), 'utf8')
    ]);
    const serialized = templates.join('\n');

    expect(serialized).not.toMatch(/deepseek-v4|mimo-v2\.5/);
    expect(serialized).toContain('chatMode=multimodal');
  });
});
