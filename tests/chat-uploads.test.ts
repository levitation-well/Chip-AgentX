import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  ChatUploadError,
  cleanupExpiredChatImages,
  getChatUploadRoot,
  parseAndStoreChatImages,
  resolveChatImageDownload
} from '../src/chat-uploads.js';

async function tempDataDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-chat-uploads-'));
}

function multipartRequest(parts: Array<{ name: string; filename?: string; content: Buffer | string; type?: string }>): IncomingMessage {
  const boundary = `----agentx-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n`));
    if (part.type) chunks.push(Buffer.from(`Content-Type: ${part.type}\r\n`));
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const stream = Readable.from(Buffer.concat(chunks)) as IncomingMessage;
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return stream;
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function tokenFromUrl(url: string): string {
  return new URL(url, 'http://agentx.local').searchParams.get('token') ?? '';
}

describe('chat image uploads', () => {
  it('stores chat images with a seven day retention URL', async () => {
    const dataDir = await tempDataDir();
    const result = await parseAndStoreChatImages(
      multipartRequest([{ name: 'images', filename: 'scope.png', content: png, type: 'image/png' }]),
      { dataDir, userId: 'user-1', now: new Date('2026-05-29T00:00:00.000Z') }
    );

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({
      originalName: 'scope.png',
      mimeType: 'image/png',
      retentionUntil: '2026-06-05T00:00:00.000Z'
    });
    expect(result.images[0].url).toMatch(/^\/api\/chat-uploads\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.png\?token=[A-Za-z0-9_-]+$/);

    const download = await resolveChatImageDownload({
      dataDir,
      imageId: result.images[0].id,
      storedName: result.images[0].storedName,
      token: tokenFromUrl(result.images[0].url),
      now: new Date('2026-05-30T00:00:00.000Z')
    });
    expect(download.contentType).toBe('image/png');

    await expect(resolveChatImageDownload({
      dataDir,
      imageId: result.images[0].id,
      storedName: result.images[0].storedName,
      token: 'wrong-token',
      now: new Date('2026-05-30T00:00:00.000Z')
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects non-image extensions and spoofed image content without leaking paths', async () => {
    const dataDir = await tempDataDir();
    await expect(parseAndStoreChatImages(
      multipartRequest([{ name: 'images', filename: 'notes.txt', content: 'hello' }]),
      { dataDir, userId: 'user-1' }
    )).rejects.toMatchObject({ statusCode: 400, message: 'Chat image type is not allowed' });

    await expect(parseAndStoreChatImages(
      multipartRequest([{ name: 'images', filename: 'fake.png', content: 'not a png' }]),
      { dataDir, userId: 'user-1' }
    )).rejects.toBeInstanceOf(ChatUploadError);
  });

  it('cleans expired images without removing fresh uploads', async () => {
    const dataDir = await tempDataDir();
    const oldUpload = await parseAndStoreChatImages(
      multipartRequest([{ name: 'images', filename: 'old.png', content: png }]),
      { dataDir, userId: 'user-1', now: new Date('2026-05-01T00:00:00.000Z') }
    );
    const freshUpload = await parseAndStoreChatImages(
      multipartRequest([{ name: 'images', filename: 'fresh.png', content: png }]),
      { dataDir, userId: 'user-1', now: new Date('2026-05-28T00:00:00.000Z') }
    );

    const cleanup = await cleanupExpiredChatImages({ dataDir, now: new Date('2026-05-29T00:00:00.000Z') });

    expect(cleanup.removed).toBe(1);
    await expect(readFile(path.join(getChatUploadRoot(dataDir), 'user-1', oldUpload.images[0].id, 'meta.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(getChatUploadRoot(dataDir), 'user-1', freshUpload.images[0].id, freshUpload.images[0].storedName))).resolves.toBeTruthy();
  });

  it('rolls back images written earlier in a failed multipart upload', async () => {
    const dataDir = await tempDataDir();

    await expect(parseAndStoreChatImages(
      multipartRequest([
        { name: 'images', filename: 'ok.png', content: png },
        { name: 'images', filename: 'bad.png', content: 'not a png' }
      ]),
      { dataDir, userId: 'user-1' }
    )).rejects.toBeInstanceOf(ChatUploadError);

    await expect(readdir(path.join(getChatUploadRoot(dataDir), 'user-1'))).resolves.toHaveLength(0);
  });

  it('requires the upload request to declare multimodal mode before writing images', async () => {
    const dataDir = await tempDataDir();

    await expect(parseAndStoreChatImages(
      multipartRequest([
        { name: 'chatMode', content: 'standard' },
        { name: 'images', filename: 'scope.png', content: png }
      ]),
      { dataDir, userId: 'user-1', requiredChatMode: 'multimodal' }
    )).rejects.toMatchObject({
      statusCode: 400,
      message: 'Image upload requires multimodal mode'
    });
    await expect(readdir(path.join(getChatUploadRoot(dataDir), 'user-1'))).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(parseAndStoreChatImages(
      multipartRequest([
        { name: 'chatMode', content: 'multimodal' },
        { name: 'images', filename: 'scope.png', content: png }
      ]),
      { dataDir, userId: 'user-1', requiredChatMode: 'multimodal' }
    )).resolves.toMatchObject({ images: [expect.objectContaining({ originalName: 'scope.png' })] });
  });
});
