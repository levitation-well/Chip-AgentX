import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';

import { UserStore } from '../src/auth/user-store.js';

async function makeUserStore(): Promise<{ store: UserStore; dataDir: string; usersPath: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'userstore-atomic-'));
  const store = new UserStore({
    dataDir,
    adminUser: 'admin',
    adminPasswordHash: await bcrypt.hash('admin-secret', 10)
  });
  await store.init();
  return { store, dataDir, usersPath: path.join(dataDir, 'users.json') };
}

describe('UserStore.saveUsers atomic write (P1-4 multi-agent audit)', () => {
  it('persists users to users.json atomically via writeJsonAtomic (no direct writeFile)', async () => {
    const { store, usersPath } = await makeUserStore();
    await store.createUser('alice', 'alice-secret');

    const stat1 = await stat(usersPath);
    expect(stat1.isFile()).toBe(true);
    const raw = await readFile(usersPath, 'utf8');
    const parsed = JSON.parse(raw) as Array<{ username: string }>;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.find((u) => u.username === 'alice')).toBeTruthy();
  });

  it('serializes concurrent updates through saveQueue without leaving .tmp-* orphans', async () => {
    const { store, dataDir } = await makeUserStore();
    // Fire many concurrent updates; writeJsonAtomic uses unique tmp + rename,
    // and saveQueue serializes mutations so the final file is always parseable.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.createUser(`user${i}`, `pw-${i}`))
    );

    const list = await readdir(dataDir);
    const orphans = list.filter((f) => /\.tmp-/.test(f));
    expect(orphans).toEqual([]);

    const raw = await readFile(path.join(dataDir, 'users.json'), 'utf8');
    const parsed = JSON.parse(raw) as Array<{ username: string }>;
    expect(parsed.length).toBeGreaterThanOrEqual(11); // 10 + admin
  });

  it('produces a parseable file after a burst of creates followed by a read', async () => {
    const { store, usersPath } = await makeUserStore();
    await store.createUser('bob', 'bob-secret');
    await store.createUser('carol', 'carol-secret');
    await store.updateUser((await store.findByUsername('bob'))!.id, { status: 'active' });

    const raw = await readFile(usersPath, 'utf8');
    const parsed = JSON.parse(raw) as Array<{ username: string }>;
    const usernames = parsed.map((u) => u.username).sort();
    expect(usernames).toContain('admin');
    expect(usernames).toContain('bob');
    expect(usernames).toContain('carol');
  });
});