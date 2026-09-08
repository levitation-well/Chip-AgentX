import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getChatUploadRoot, isValidReadToken, safePathSegment } from './chat-uploads.js';

// B2 fix: also capture optional ?token= query from the URL so materialization
// can validate the read token (same gate as direct download).
const CHAT_UPLOAD_URL_RE = /\/api\/chat-uploads\/([a-f0-9-]{36})\/([^\s?)"']+)(?:\?token=([^\s)"']+))?/gi;

const CHAT_IMAGES_DIR = 'chat-images';

interface StoredChatImageMeta {
  readToken: string;
}

async function readChatImageMeta(filePath: string): Promise<StoredChatImageMeta> {
  const metaPath = path.join(path.dirname(filePath), 'meta.json');
  const raw = await readFile(metaPath, 'utf8');
  return JSON.parse(raw) as StoredChatImageMeta;
}

interface MaterializeChatImagesOptions {
  task: string;
  cwd: string;
  dataDir: string;
  userId?: string;
}

interface MaterializeChatImagesResult {
  task: string;
  copied: number;
  files: Array<{ path: string; size?: number }>;
}

/**
 * 把 task 文本里引用的 chat-uploads 图片真正 copy 进隔离工作区 `cwd/chat-images/`，
 * 并把对应的 markdown URL 重写成本地相对路径 `./chat-images/{storedName}`，
 * 让支持多模态的模型用 Read 工具读图（M4，spec §6.8）。
 *
 * 容错：定位不到真实文件（已过期/被清理/不存在）时跳过该图片，URL 原样保留。
 * 不破坏隔离：图片只写入 cwd（在 KB deny 根之外），模型读本地副本放行。
 */
export async function materializeChatImagesIntoWorkspace(
  opts: MaterializeChatImagesOptions
): Promise<MaterializeChatImagesResult> {
  const matches = [...opts.task.matchAll(CHAT_UPLOAD_URL_RE)];
  if (matches.length === 0) {
    return { task: opts.task, copied: 0, files: [] };
  }

  const root = getChatUploadRoot(opts.dataDir);
  let copied = 0;
  // 记录成功 copy 的 storedName，用于回放阶段决定哪些 URL 重写。
  const rewritten = new Set<string>();
  // 去重：同一图片在 task 出现多次只 copy 一次。
  const resolvedCache = new Map<string, boolean>();
  const files: MaterializeChatImagesResult['files'] = [];

  for (const match of matches) {
    const id = match[1];
    const storedName = match[2];
    const token = match[3];
    // 防御：storedName 必须是单段文件名，杜绝路径穿越。
    if (path.basename(storedName) !== storedName) {
      continue;
    }
    const cacheKey = `${id}/${storedName}`;
    if (resolvedCache.has(cacheKey)) {
      if (resolvedCache.get(cacheKey)) rewritten.add(cacheKey);
      continue;
    }

    const source = await locateUploadFile(root, id, storedName, token, opts.userId);
    if (!source) {
      resolvedCache.set(cacheKey, false);
      continue;
    }

    const destDir = path.join(opts.cwd, CHAT_IMAGES_DIR);
    const dest = path.join(destDir, storedName);
    try {
      await mkdir(destDir, { recursive: true });
      await copyFile(source, dest);
    } catch {
      resolvedCache.set(cacheKey, false);
      continue;
    }
    const copiedStat = await stat(dest).catch(() => undefined);
    resolvedCache.set(cacheKey, true);
    rewritten.add(cacheKey);
    copied += 1;
    files.push({
      path: path.join(CHAT_IMAGES_DIR, storedName).replace(/\\/g, '/'),
      ...(copiedStat ? { size: copiedStat.size } : {})
    });
  }

  if (rewritten.size === 0) {
    return { task: opts.task, copied: 0, files: [] };
  }

  // 回放：只重写成功 copy 的 URL（含可选 `?token=...` query 一并剥除）。
  const task = opts.task.replace(
    /\/api\/chat-uploads\/([a-f0-9-]{36})\/([^\s?)"']+)(?:\?token=[^\s)"']+)?/gi,
    (full, id: string, storedName: string) => {
      if (path.basename(storedName) !== storedName) return full;
      return rewritten.has(`${id}/${storedName}`)
        ? `./${CHAT_IMAGES_DIR}/${storedName}`
        : full;
    }
  );

  return { task, copied, files };
}

/**
 * B2 fix: validate read token before exposing the file.
 */
async function hasValidToken(filePath: string, token: string | undefined): Promise<boolean> {
  const meta = await readChatImageMeta(filePath).catch(() => undefined);
  if (!meta) return false;
  return isValidReadToken(token, meta.readToken);
}

/**
 * 按 chat-uploads 存储布局定位真实文件。
 * B2 fix: cross-user directory scanning disabled. Authenticated sessions only
 * see their own dir; unauthenticated callers cannot materialize at all.
 */
async function locateUploadFile(
  root: string,
  id: string,
  storedName: string,
  token: string | undefined,
  userId?: string
): Promise<string | undefined> {
  if (!userId) {
    // Without a userId we cannot safely scope the lookup to any single user.
    return undefined;
  }
  const candidate = path.join(root, safePathSegment(userId), id, storedName);
  if (!(await isFile(candidate))) return undefined;
  if (!(await hasValidToken(candidate, token))) return undefined;
  return candidate;
}

async function isFile(filePath: string): Promise<boolean> {
  const fileStat = await stat(filePath).catch(() => undefined);
  return Boolean(fileStat?.isFile());
}
