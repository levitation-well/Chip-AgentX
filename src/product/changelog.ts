import { readFile } from 'node:fs/promises';
import path from 'node:path';

const INITIAL_CWD = process.cwd();
declare const __AGENTX_CHANGELOG_MARKDOWN__: string | undefined;

export interface ChangelogEntry {
  version: string;
  date?: string;
  items: string[];
}

export interface ChangelogResult {
  available: boolean;
  entries: ChangelogEntry[];
  error?: 'missing' | 'empty' | 'unparseable';
}

export interface ReadChangelogOptions {
  filePath?: string;
  cwd?: string;
  limit?: number;
}

export async function readChangelog(options: ReadChangelogOptions = {}): Promise<ChangelogResult> {
  if (!options.filePath && !options.cwd) {
    const bundledMarkdown = typeof __AGENTX_CHANGELOG_MARKDOWN__ === 'string' ? __AGENTX_CHANGELOG_MARKDOWN__ : undefined;
    if (bundledMarkdown !== undefined) {
      return parseChangelog(bundledMarkdown, options.limit ?? 3);
    }
  }

  const filePath = options.filePath ?? path.join(options.cwd ?? INITIAL_CWD, 'CHANGELOG.md');
  try {
    const markdown = await readFile(filePath, 'utf8');
    return parseChangelog(markdown, options.limit ?? 3);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { available: false, entries: [], error: 'missing' };
    }
    return { available: false, entries: [], error: 'unparseable' };
  }
}

export function parseChangelog(markdown: string, limit = 3): ChangelogResult {
  if (!markdown.trim()) {
    return { available: false, entries: [], error: 'empty' };
  }

  const lines = markdown.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | undefined;

  for (const line of lines) {
    const heading = /^##\s+\[?([^\]\n]+?)\]?(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line.trim());
    if (heading) {
      if (current) {
        entries.push(current);
      }
      current = {
        version: heading[1]?.trim() ?? 'Unreleased',
        date: heading[2],
        items: []
      };
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (current && bullet?.[1]) {
      current.items.push(bullet[1]);
    }
  }

  if (current) {
    entries.push(current);
  }

  const filtered = entries
    .filter((entry) => entry.items.length > 0 && entry.version.toLowerCase() !== 'unreleased')
    .slice(0, limit);
  return filtered.length > 0
    ? { available: true, entries: filtered }
    : { available: false, entries: [], error: 'unparseable' };
}
