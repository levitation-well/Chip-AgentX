import { appendFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export interface ReadJsonLinesOptions {
  offset?: number;
  limit?: number;
}

interface AtomicWriteHandle {
  writeFile(data: string, encoding: BufferEncoding): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicWriteOperations {
  mkdir(directory: string): Promise<unknown>;
  open(target: string, flags: string): Promise<AtomicWriteHandle>;
  rename(from: string, to: string): Promise<void>;
  rm(target: string): Promise<void>;
}

const defaultAtomicWriteOperations: AtomicWriteOperations = {
  mkdir: async (directory) => mkdir(directory, { recursive: true }),
  open: async (target, flags) => open(target, flags),
  rename: async (from, to) => rename(from, to),
  rm: async (target) => rm(target, { force: true })
};

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicWriteOperations = defaultAtomicWriteOperations
): Promise<void> {
  const directory = path.dirname(filePath);
  await operations.mkdir(directory);
  const tempPath = path.join(
    directory,
    `${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );

  try {
    const handle = await operations.open(tempPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tempPath, filePath, operations);
    await syncDirectory(directory, operations);
  } catch (error) {
    await operations.rm(tempPath);
    throw error;
  }
}

async function renameWithRetry(from: string, to: string, operations: AtomicWriteOperations): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await operations.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableRenameError(error)) {
        throw error;
      }
      await delay(20 * attempt);
    }
  }
}

async function syncDirectory(directory: string, operations: AtomicWriteOperations): Promise<void> {
  let handle: AtomicWriteHandle | undefined;
  try {
    handle = await operations.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySyncError(error)) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  return isNodeError(error) && ['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error.code ?? '');
}

function isRetryableRenameError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EPERM' || error.code === 'EBUSY');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readJsonFile<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && arguments.length >= 2) {
      return fallback as T;
    }
    throw error;
  }
}

export async function appendJsonLine(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJsonLines<T>(filePath: string, options: ReadJsonLinesOptions = {}): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit === undefined ? undefined : Math.max(0, options.limit);
  const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit);

  return selected.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid JSONL in ${filePath} at line ${offset + index + 1}: ${errorMessage(error)}`);
    }
  });
}

export async function appendText(filePath: string, chunk: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, chunk, 'utf8');
}

/**
 * 读取 JSONL 文件末尾最多 `maxLines` 行并逐行 parse，不整文件读入内存。
 *
 * 实现：以递增窗口（起始 64KB，不够则倍增）从文件尾部读字节，直到窗口内的换行数
 * 达到 `maxLines + 1`（多留一行防止窗口切在行中间）或已覆盖整个文件为止，再按行切分、
 * 丢弃可能被截断的首行、只保留最后 `maxLines` 行解析。用于 V10：discovery-trace `list()`
 * 有界读取，避免大文件被整体读入+全量 parse。
 */
export async function readJsonLinesTail<T>(filePath: string, maxLines: number): Promise<T[]> {
  if (maxLines <= 0) {
    return [];
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  if (fileStat.size === 0) {
    return [];
  }

  const targetLines = maxLines + 1; // 多留一行，容错窗口切在行中间导致的首行截断
  let windowSize = Math.min(fileStat.size, 64 * 1024);
  let raw = '';

  // 从小窗口开始倍增，直到读到足够的完整行或已覆盖整个文件。
  for (;;) {
    const buffer = Buffer.alloc(windowSize);
    const handle = await open(filePath, 'r');
    try {
      await handle.read(buffer, 0, windowSize, fileStat.size - windowSize);
    } finally {
      await handle.close();
    }
    raw = buffer.toString('utf8');

    const newlineCount = (raw.match(/\n/g) ?? []).length;
    if (newlineCount >= targetLines || windowSize >= fileStat.size) {
      break;
    }
    windowSize = Math.min(fileStat.size, windowSize * 2);
  }

  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  // 窗口起点可能落在某一行中间，导致第一行是被截断的半行；当窗口未覆盖整个文件时丢弃它。
  const coveredWholeFile = windowSize >= fileStat.size;
  const usableLines = coveredWholeFile ? lines : lines.slice(1);
  const tail = usableLines.slice(-maxLines);

  return tail.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`Invalid JSONL tail in ${filePath} near line ${index + 1}: ${errorMessage(error)}`);
    }
  });
}

export async function readTextTail(filePath: string, limitChars: number): Promise<string> {
  if (limitChars <= 0) {
    return '';
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }

  const bytesToRead = Math.min(fileStat.size, limitChars * 4);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await open(filePath, 'r');
  try {
    await handle.read(buffer, 0, bytesToRead, fileStat.size - bytesToRead);
  } finally {
    await handle.close();
  }

  return buffer.toString('utf8').slice(-limitChars);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
