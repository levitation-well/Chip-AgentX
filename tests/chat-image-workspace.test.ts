import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';

import { materializeChatImagesIntoWorkspace } from '../src/chat-image-workspace.js';

// 最小合法 PNG 字节（魔数 + 占位）。只需文件存在且能被 copy。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

const USER_ID = 'user@example.com';
// safePathSegment 把非 \w.- 字符替换成 _，与 chat-uploads.ts 一致
const SAFE_USER = 'user_example.com';

async function seedUpload(
  dataDir: string,
  opts: { id: string; storedName: string; user?: string; readToken?: string }
): Promise<void> {
  const dir = path.join(dataDir, 'chat-uploads', opts.user ?? SAFE_USER, opts.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, opts.storedName), PNG_BYTES);
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      id: opts.id,
      userId: USER_ID,
      readToken: opts.readToken ?? 'tok',
      originalName: opts.storedName,
      storedName: opts.storedName,
      sizeBytes: PNG_BYTES.length,
      mimeType: 'image/png',
      uploadedAt: new Date().toISOString(),
      retentionUntil: new Date(Date.now() + 86400000).toISOString()
    })
  );
}

async function makeDirs(): Promise<{ dataDir: string; cwd: string }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'chatimg-data-'));
  const cwd = await mkdtemp(path.join(tmpdir(), 'chatimg-cwd-'));
  return { dataDir, cwd };
}

describe('materializeChatImagesIntoWorkspace', () => {
  it('copies uploaded image into cwd/chat-images and rewrites URL to local path', async () => {
    const { dataDir, cwd } = await makeDirs();
    const id = crypto.randomUUID();
    const storedName = `${id}.png`;
    await seedUpload(dataDir, { id, storedName, readToken: 'abc' });

    const task = `看这张图 ![fig](/api/chat-uploads/${id}/${storedName}?token=abc)`;
    const result = await materializeChatImagesIntoWorkspace({ task, cwd, dataDir, userId: USER_ID });

    expect(result.copied).toBe(1);
    // 文件已 copy 进隔离工作区
    const copied = path.join(cwd, 'chat-images', storedName);
    const fileStat = await stat(copied);
    expect(fileStat.isFile()).toBe(true);
    expect(await readFile(copied)).toEqual(PNG_BYTES);
    // task 中 URL 被替换成本地相对路径，保留 markdown name
    expect(result.task).toBe(`看这张图 ![fig](./chat-images/${storedName})`);
    expect(result.task).not.toContain('/api/chat-uploads/');
  });

  it('is tolerant when the upload file is missing (copied=0, URL preserved)', async () => {
    const { dataDir, cwd } = await makeDirs();
    const id = crypto.randomUUID();
    const storedName = `${id}.png`;
    // 不 seed 任何文件
    const originalUrl = `/api/chat-uploads/${id}/${storedName}?token=abc`;
    const task = `看这张图 ![fig](${originalUrl})`;

    const result = await materializeChatImagesIntoWorkspace({ task, cwd, dataDir, userId: USER_ID });

    expect(result.copied).toBe(0);
    // 容错：URL 原样保留
    expect(result.task).toBe(task);
  });

  it('refuses to copy when no userId is provided (B2 fix: no cross-user scanning)', async () => {
    const { dataDir, cwd } = await makeDirs();
    const id = crypto.randomUUID();
    const storedName = `${id}.png`;
    await seedUpload(dataDir, { id, storedName, user: 'someone_else.com' });

    const task = `![fig](/api/chat-uploads/${id}/${storedName})`;
    const result = await materializeChatImagesIntoWorkspace({ task, cwd, dataDir });

    // Without userId we cannot scope the lookup; refuse to copy.
    expect(result.copied).toBe(0);
    expect(result.task).toBe(task);
  });

  it('handles multiple images and strips query strings', async () => {
    const { dataDir, cwd } = await makeDirs();
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();
    const name1 = `${id1}.png`;
    const name2 = `${id2}.png`;
    await seedUpload(dataDir, { id: id1, storedName: name1, readToken: 't1' });
    await seedUpload(dataDir, { id: id2, storedName: name2, readToken: 't2' });

    const task =
      `图一 ![a](/api/chat-uploads/${id1}/${name1}?token=t1) 图二 ![b](/api/chat-uploads/${id2}/${name2}?token=t2)`;
    const result = await materializeChatImagesIntoWorkspace({ task, cwd, dataDir, userId: USER_ID });

    expect(result.copied).toBe(2);
    expect(result.task).toBe(`图一 ![a](./chat-images/${name1}) 图二 ![b](./chat-images/${name2})`);
  });

  it('returns task unchanged when there are no chat-upload URLs', async () => {
    const { dataDir, cwd } = await makeDirs();
    const task = '普通文本，无图片';
    const result = await materializeChatImagesIntoWorkspace({ task, cwd, dataDir, userId: USER_ID });
    expect(result.copied).toBe(0);
    expect(result.task).toBe(task);
  });
});
