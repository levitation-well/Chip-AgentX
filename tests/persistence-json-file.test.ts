import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendJsonLine,
  appendText,
  readJsonFile,
  readJsonLines,
  readTextTail,
  writeJsonAtomic
} from '../src/persistence/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `agentx-json-file-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('writeJsonAtomic and readJsonFile', () => {
  it('writes pretty JSON atomically', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'nested', 'value.json');

    await writeJsonAtomic(filePath, { name: 'agentx', enabled: true });

    await expect(readFile(filePath, 'utf8')).resolves.toBe('{\n  "name": "agentx",\n  "enabled": true\n}\n');
    await expect(readJsonFile(filePath)).resolves.toEqual({ name: 'agentx', enabled: true });
  });

  it('syncs the temporary file before rename and the parent directory after rename', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'value.json');
    const calls: string[] = [];
    let openCount = 0;
    const operations = {
      mkdir: async () => { calls.push('mkdir'); },
      open: async () => {
        openCount += 1;
        const kind = openCount === 1 ? 'file' : 'directory';
        calls.push(`open:${kind}`);
        return {
          writeFile: async () => { calls.push(`write:${kind}`); },
          sync: async () => { calls.push(`sync:${kind}`); },
          close: async () => { calls.push(`close:${kind}`); }
        };
      },
      rename: async () => { calls.push('rename'); },
      rm: async () => { calls.push('rm'); }
    };

    await (writeJsonAtomic as unknown as (
      target: string,
      value: unknown,
      ops: typeof operations
    ) => Promise<void>)(filePath, { ok: true }, operations);

    expect(calls).toEqual([
      'mkdir',
      'open:file',
      'write:file',
      'sync:file',
      'close:file',
      'rename',
      'open:directory',
      'sync:directory',
      'close:directory'
    ]);
  });

  it('returns fallback for missing JSON files', async () => {
    const root = await tempDir();

    await expect(readJsonFile(path.join(root, 'missing.json'), { ok: true })).resolves.toEqual({ ok: true });
  });
});

describe('JSONL helpers', () => {
  it('appends one JSON object per line', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'events.jsonl');

    await appendJsonLine(filePath, { event: 'one' });
    await appendJsonLine(filePath, { event: 'two' });

    await expect(readFile(filePath, 'utf8')).resolves.toBe('{"event":"one"}\n{"event":"two"}\n');
    await expect(readJsonLines(filePath)).resolves.toEqual([{ event: 'one' }, { event: 'two' }]);
  });

  it('supports offset and limit while reading JSONL', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'events.jsonl');
    await appendJsonLine(filePath, { n: 1 });
    await appendJsonLine(filePath, { n: 2 });
    await appendJsonLine(filePath, { n: 3 });

    await expect(readJsonLines(filePath, { offset: 1, limit: 1 })).resolves.toEqual([{ n: 2 }]);
  });

  it('reports invalid JSONL with line number', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'bad.jsonl');
    await writeFile(filePath, '{"ok":true}\nnot-json\n', 'utf8');

    await expect(readJsonLines(filePath)).rejects.toThrow(/bad\.jsonl at line 2/);
  });

  it('returns an empty array for missing JSONL files', async () => {
    const root = await tempDir();

    await expect(readJsonLines(path.join(root, 'missing.jsonl'))).resolves.toEqual([]);
  });
});

describe('text helpers', () => {
  it('appends text and reads tails by character limit', async () => {
    const root = await tempDir();
    const filePath = path.join(root, 'output.log');

    await appendText(filePath, 'hello ');
    await appendText(filePath, 'world');

    await expect(readTextTail(filePath, 5)).resolves.toBe('world');
    await expect(readTextTail(filePath, 100)).resolves.toBe('hello world');
  });

  it('returns an empty string for missing tails', async () => {
    const root = await tempDir();

    await expect(readTextTail(path.join(root, 'missing.log'), 10)).resolves.toBe('');
  });
});
