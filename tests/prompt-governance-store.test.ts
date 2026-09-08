import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptGovernanceStore, hashPromptContent } from '../src/prompt-governance-store.js';

describe('prompt governance history store', () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it('persists prompt history entries under dataDir and lists newest first', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'agentx-prompt-history-'));
    const store = new PromptGovernanceStore({ dataDir });

    await store.append(
      'roles/admin.md',
      'first version',
      { userId: 'user-1', username: 'admin', role: 'admin' },
      new Date('2026-05-29T01:00:00.000Z')
    );
    await store.append(
      'roles/admin.md',
      'second version',
      { userId: 'user-2', username: 'root', role: 'admin' },
      new Date('2026-05-29T02:00:00.000Z')
    );

    const reopened = new PromptGovernanceStore({ dataDir });
    const entries = await reopened.list('roles/admin.md');

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      relativePath: 'roles/admin.md',
      hash: hashPromptContent('second version'),
      createdAt: '2026-05-29T02:00:00.000Z',
      userId: 'user-2',
      username: 'root',
      role: 'admin',
      content: 'second version'
    });
    expect(entries[1]?.content).toBe('first version');
  });
});
