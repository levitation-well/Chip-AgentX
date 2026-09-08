import crypto from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PromptHistoryActor {
  userId: string;
  username: string;
  role: string;
}

export interface PromptHistoryEntry extends PromptHistoryActor {
  relativePath: string;
  hash: string;
  createdAt: string;
  content: string;
}

interface PromptHistoryFile {
  entries: PromptHistoryEntry[];
}

export class PromptGovernanceStore {
  private readonly filePath: string;
  /**
   * B6 fix: serialize in-process appends to prevent lost updates when two
   * admins concurrently save the same prompt (each request creates a fresh
   * store, so an instance-level chain is required).
   */
  private appendTail: Promise<unknown> = Promise.resolve();

  constructor(options: { dataDir: string; filePath?: string }) {
    this.filePath = options.filePath ?? path.join(options.dataDir, 'prompt-history', 'history.json');
  }

  private async withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.appendTail;
    let release!: () => void;
    this.appendTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      return await fn();
    } finally {
      release();
    }
  }

  async append(relativePath: string, content: string, actor: PromptHistoryActor, createdAt = new Date()): Promise<PromptHistoryEntry> {
    return this.withAppendLock(async () => {
      const history = await this.readHistoryFile();
      const entry: PromptHistoryEntry = {
        relativePath,
        hash: hashPromptContent(content),
        createdAt: createdAt.toISOString(),
        userId: actor.userId,
        username: actor.username,
        role: actor.role,
        content
      };
      history.entries.push(entry);
      await this.writeHistoryFile(history);
      return entry;
    });
  }

  async list(relativePath: string): Promise<PromptHistoryEntry[]> {
    const history = await this.readHistoryFile();
    return history.entries
      .filter((entry) => entry.relativePath === relativePath)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async latest(relativePath: string): Promise<PromptHistoryEntry | null> {
    return (await this.list(relativePath))[0] ?? null;
  }

  private async readHistoryFile(): Promise<PromptHistoryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf-8')) as Partial<PromptHistoryFile>;
      return { entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isPromptHistoryEntry) : [] };
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { entries: [] };
      }
      throw error;
    }
  }

  private async writeHistoryFile(history: PromptHistoryFile): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = path.join(path.dirname(this.filePath), `${path.basename(this.filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`);
    try {
      await writeFile(tempPath, `${JSON.stringify(history, null, 2)}\n`, 'utf-8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }
}

export function hashPromptContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

function isPromptHistoryEntry(value: unknown): value is PromptHistoryEntry {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PromptHistoryEntry).relativePath === 'string' &&
      typeof (value as PromptHistoryEntry).hash === 'string' &&
      typeof (value as PromptHistoryEntry).createdAt === 'string' &&
      typeof (value as PromptHistoryEntry).userId === 'string' &&
      typeof (value as PromptHistoryEntry).username === 'string' &&
      typeof (value as PromptHistoryEntry).role === 'string' &&
      typeof (value as PromptHistoryEntry).content === 'string'
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
