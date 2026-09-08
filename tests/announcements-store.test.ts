import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AnnouncementStore,
  type AnnouncementContentItem
} from '../src/announcements/index.js';

const NOW = new Date('2026-05-30T08:00:00.000Z');

function content(overrides: Partial<AnnouncementContentItem> = {}): AnnouncementContentItem {
  return {
    id: 'announcement-1',
    type: 'announcement',
    status: 'published',
    title: 'Service notice',
    summary: 'A short summary',
    body: 'Longer announcement body',
    visibility: 'public',
    requiresLogin: false,
    roleAllowList: [],
    requiredGrants: {},
    pinned: false,
    priority: 0,
    modalBehavior: 'once_per_version',
    revision: 1,
    publishedAt: '2026-05-30T07:00:00.000Z',
    createdAt: '2026-05-30T06:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    createdBy: 'admin',
    updatedBy: 'admin',
    ...overrides
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-announcements-store-'));
}

describe('announcement store', () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
  });

  it('persists unified content items and user read/dismiss state by revision', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir, now: () => NOW });
    await store.replaceItems([content({ sourceRef: { kind: 'phase_release_note', phase: 41, note: 'internal only' } })]);

    await store.markDismissed('user-1', content());
    const hidden = await store.getHome({}, 'user-1');
    expect(hidden.modalCandidate).toBeNull();

    await store.upsertItem(content({ revision: 2, updatedAt: '2026-05-30T08:00:00.000Z' }));
    const visibleAgain = await store.getHome({}, 'user-1');
    expect(visibleAgain.modalCandidate).toMatchObject({ id: 'announcement-1', revision: 2 });

    await store.markRead('user-1', content({ revision: 2 }));
    const state = await store.getUserState('user-1');
    expect(state.items['announcement-1']).toMatchObject({
      lastDismissedRevision: 1,
      lastReadRevision: 2,
      lastReadAt: NOW.toISOString()
    });
  });

  it('sorts home candidates by pinned, priority, publishedAt, and updatedAt', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });
    await store.replaceItems([
      content({ id: 'normal', priority: 100, publishedAt: '2026-05-30T07:00:00.000Z' }),
      content({ id: 'pinned-low', pinned: true, priority: 1, publishedAt: '2026-05-29T07:00:00.000Z' }),
      content({ id: 'pinned-high', pinned: true, priority: 5, publishedAt: '2026-05-28T07:00:00.000Z' })
    ]);

    const home = await store.getHome();

    expect(home.modalCandidate?.id).toBe('pinned-high');
    expect(home.feed.map((item) => item.id)).toEqual(['pinned-high', 'pinned-low', 'normal']);
  });

  it('rejects force_until_expiry content without a server-side endsAt contract', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });

    await expect(
      store.replaceItems([content({ modalBehavior: 'force_until_expiry', endsAt: undefined })])
    ).rejects.toThrow(/requires endsAt/);
  });

  it('rejects published force_until_expiry content that exceeds seven days', async () => {
    dataDir = await tempDir();
    const store = new AnnouncementStore({ dataDir });

    await expect(
      store.replaceItems([
        content({
          modalBehavior: 'force_until_expiry',
          publishedAt: '2026-05-30T07:00:00.000Z',
          endsAt: '2026-06-10T07:00:00.000Z'
        })
      ])
    ).rejects.toThrow(/7 days/);
  });
});
