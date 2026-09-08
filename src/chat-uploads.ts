import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';

export const CHAT_IMAGE_UPLOAD_LIMITS = {
  maxFiles: 3,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  retentionDays: 7
} as const;

const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

export interface ChatImageUpload {
  id: string;
  originalName: string;
  storedName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  retentionUntil: string;
  url: string;
}

export interface ChatImageDownload {
  stream: ReturnType<typeof createReadStream>;
  contentType: string;
  sizeBytes: number;
}

export class ChatUploadError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

interface StoredChatImageMeta extends Omit<ChatImageUpload, 'url'> {
  userId: string;
  readToken: string;
}

export async function parseAndStoreChatImages(
  request: IncomingMessage,
  options: { dataDir: string; userId: string; now?: Date; requiredChatMode?: 'multimodal' }
): Promise<{ images: ChatImageUpload[] }> {
  const boundary = parseMultipartBoundary(request.headers['content-type']);
  if (!boundary) {
    throw new ChatUploadError(400, 'Expected multipart chat image upload');
  }
  const body = await readRequestBuffer(request, CHAT_IMAGE_UPLOAD_LIMITS.maxTotalBytes + 1024 * 1024);
  const parts = parseMultipartBody(body, boundary);
  if (options.requiredChatMode && readMultipartTextField(parts, 'chatMode') !== options.requiredChatMode) {
    throw new ChatUploadError(400, 'Image upload requires multimodal mode');
  }
  const now = options.now ?? new Date();
  const uploadedAt = now.toISOString();
  const retentionUntil = new Date(now.getTime() + CHAT_IMAGE_UPLOAD_LIMITS.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const root = getChatUploadRoot(options.dataDir);
  const images: ChatImageUpload[] = [];
  const writtenDirs: string[] = [];
  let totalBytes = 0;

  try {
    for (const part of parts) {
      if (!isImageFieldName(part.name) || !part.filename) {
        continue;
      }
      if (images.length >= CHAT_IMAGE_UPLOAD_LIMITS.maxFiles) {
        throw new ChatUploadError(400, 'Too many chat images');
      }
      const originalName = sanitizeOriginalName(part.filename);
      const ext = path.extname(originalName).toLowerCase();
      if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
        throw new ChatUploadError(400, 'Chat image type is not allowed');
      }
      if (!matchesImageMagic(ext, part.content)) {
        throw new ChatUploadError(400, 'Chat image content does not match its extension');
      }
      totalBytes += part.content.length;
      if (part.content.length > CHAT_IMAGE_UPLOAD_LIMITS.maxFileBytes || totalBytes > CHAT_IMAGE_UPLOAD_LIMITS.maxTotalBytes) {
        throw new ChatUploadError(413, 'Chat image is too large');
      }

      const id = crypto.randomUUID();
      const readToken = crypto.randomBytes(24).toString('base64url');
      const storedName = `${id}${ext}`;
      const dir = path.join(root, safePathSegment(options.userId), id);
      await mkdir(dir, { recursive: true });
      writtenDirs.push(dir);
      await writeFile(path.join(dir, storedName), part.content, { flag: 'wx' });
      const meta: StoredChatImageMeta = {
        id,
        userId: options.userId,
        readToken,
        originalName,
        storedName,
        sizeBytes: part.content.length,
        mimeType: IMAGE_CONTENT_TYPES[ext],
        uploadedAt,
        retentionUntil
      };
      await writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), { flag: 'wx' });
      images.push({
        id,
        originalName,
        storedName,
        sizeBytes: part.content.length,
        mimeType: IMAGE_CONTENT_TYPES[ext],
        uploadedAt,
        retentionUntil,
        url: `/api/chat-uploads/${encodeURIComponent(id)}/${encodeURIComponent(storedName)}?token=${encodeURIComponent(readToken)}`
      });
    }
  } catch (error) {
    await Promise.all(writtenDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    throw error;
  }

  if (images.length === 0) {
    throw new ChatUploadError(400, 'No chat images uploaded');
  }

  return { images };
}

export async function resolveChatImageDownload(
  options: { dataDir: string; imageId: string; storedName: string; token?: string; now?: Date }
): Promise<ChatImageDownload> {
  if (!isSafeId(options.imageId) || path.basename(options.storedName) !== options.storedName) {
    throw new ChatUploadError(404, 'Chat image not found');
  }
  const root = getChatUploadRoot(options.dataDir);
  const users = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const dir = path.join(root, user.name, options.imageId);
    const meta = await readChatImageMeta(dir).catch(() => undefined);
    if (!meta || meta.storedName !== options.storedName) continue;
    if (!isValidReadToken(options.token, meta.readToken)) {
      throw new ChatUploadError(404, 'Chat image not found');
    }
    if (Date.parse(meta.retentionUntil) <= (options.now ?? new Date()).getTime()) {
      throw new ChatUploadError(410, 'Chat image has expired');
    }
    const filePath = path.join(dir, meta.storedName);
    const fileStat = await stat(filePath).catch(() => undefined);
    if (!fileStat?.isFile()) {
      throw new ChatUploadError(404, 'Chat image not found');
    }
    return {
      stream: createReadStream(filePath),
      contentType: meta.mimeType,
      sizeBytes: fileStat.size
    };
  }
  throw new ChatUploadError(404, 'Chat image not found');
}

export async function cleanupExpiredChatImages(
  options: { dataDir: string; now?: Date }
): Promise<{ removed: number }> {
  const root = getChatUploadRoot(options.dataDir);
  const nowMs = (options.now ?? new Date()).getTime();
  let removed = 0;
  const users = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const user of users) {
    if (!user.isDirectory()) continue;
    const userDir = path.join(root, user.name);
    const entries = await readdir(userDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(userDir, entry.name);
      const meta = await readChatImageMeta(dir).catch(() => undefined);
      if (meta && Date.parse(meta.retentionUntil) <= nowMs) {
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
  }
  return { removed };
}

export function getChatUploadRoot(dataDir: string): string {
  return path.join(path.resolve(dataDir), 'chat-uploads');
}

async function readRequestBuffer(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += next.length;
    if (total > maxBytes) {
      throw new ChatUploadError(413, 'Chat image upload is too large');
    }
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function parseMultipartBody(body: Buffer, boundary: string): Array<{ name?: string; filename?: string; content: Buffer }> {
  const raw = body.toString('binary');
  const delimiter = `--${boundary}`;
  return raw.split(delimiter).slice(1, -1).map((part) => {
    const trimmed = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const [rawHeaders, ...bodyParts] = trimmed.split('\r\n\r\n');
    const headers = parsePartHeaders(rawHeaders);
    const disposition = parseContentDisposition(headers.get('content-disposition'));
    return {
      name: disposition.name,
      filename: disposition.filename,
      content: Buffer.from(bodyParts.join('\r\n\r\n'), 'binary')
    };
  });
}

function readMultipartTextField(
  parts: Array<{ name?: string; filename?: string; content: Buffer }>,
  name: string
): string | undefined {
  const part = parts.find((candidate) => candidate.name === name && !candidate.filename);
  return part?.content.toString('utf8').trim();
}

function parseMultipartBoundary(contentType: string | string[] | undefined): string | undefined {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  const match = /multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(value ?? '');
  return match?.[1] ?? match?.[2];
}

function parsePartHeaders(rawHeaders: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of rawHeaders.split('\r\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return headers;
}

function parseContentDisposition(value: string | undefined): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const part of (value ?? '').split(';').map((item) => item.trim())) {
    const [key, raw] = part.split('=');
    if (key === 'name') result.name = unquote(raw);
    if (key === 'filename') result.filename = unquote(raw);
  }
  return result;
}

function unquote(value: string | undefined): string | undefined {
  return value?.replace(/^"|"$/g, '');
}

function isImageFieldName(name: string | undefined): boolean {
  return name === 'image' || name === 'images' || name === 'images[]';
}

function sanitizeOriginalName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-]+/g, '_').slice(0, 120);
  return base || 'image.png';
}

export function safePathSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'user';
}

function isSafeId(value: string): boolean {
  return /^[a-f0-9-]{36}$/i.test(value);
}

function matchesImageMagic(ext: string, content: Buffer): boolean {
  if (ext === '.png') return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg' || ext === '.jpeg') return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (ext === '.gif') return content.subarray(0, 6).toString('ascii') === 'GIF87a' || content.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (ext === '.webp') return content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

async function readChatImageMeta(dir: string): Promise<StoredChatImageMeta> {
  return JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8')) as StoredChatImageMeta;
}

export function isValidReadToken(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
