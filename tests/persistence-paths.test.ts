import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeSessionId,
  createPersistencePaths,
  getSessionDir,
  initializeDataLayout,
  resolveDataDir
} from '../src/persistence/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = path.join(tmpdir(), `agentx-persistence-paths-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveDataDir', () => {
  it('prefers AGENTX_DATA_DIR over DATA_DIR', () => {
    const cwd = path.resolve('workspace');
    const dataDir = resolveDataDir(
      {
        AGENTX_DATA_DIR: 'agentx-data',
        DATA_DIR: 'legacy-data'
      },
      cwd
    );

    expect(dataDir).toBe(path.join(cwd, 'agentx-data'));
  });

  it('falls back to DATA_DIR and then absolute ./data', () => {
    const cwd = path.resolve('workspace');

    expect(resolveDataDir({ DATA_DIR: 'legacy-data' }, cwd)).toBe(path.join(cwd, 'legacy-data'));
    expect(resolveDataDir({}, cwd)).toBe(path.join(cwd, 'data'));
  });
});

describe('session path helpers', () => {
  it('rejects unsafe session ids', () => {
    for (const value of ['', '../escape', 'a/b', 'a\\b', 'two..dots', 'space value', '中文']) {
      expect(() => assertSafeSessionId(value)).toThrow(/Unsafe session id/);
    }

    expect(assertSafeSessionId('session_01-abc.def')).toBe('session_01-abc.def');
  });

  it('builds session paths under the configured sessions directory', () => {
    const paths = createPersistencePaths(path.resolve('data-root'));

    expect(getSessionDir(paths, 'session-1')).toBe(path.join(paths.sessionsDir, 'session-1'));
  });
});

describe('initializeDataLayout', () => {
  it('creates sessions questions logs and sessions/index.json', async () => {
    const root = await tempDir();
    const paths = createPersistencePaths(root);

    await initializeDataLayout(paths);

    await expect(readFile(paths.sessionIndexFile, 'utf8')).resolves.toBe('[]\n');
    await expect(readFile(path.join(paths.questionsDir, 'missing.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('does not overwrite an existing sessions/index.json', async () => {
    const root = await tempDir();
    const paths = createPersistencePaths(root);
    await initializeDataLayout(paths);
    await writeFile(paths.sessionIndexFile, '[{"id":"1"}]\n', 'utf8');

    await initializeDataLayout(paths);

    await expect(readFile(paths.sessionIndexFile, 'utf8')).resolves.toBe('[{"id":"1"}]\n');
  });
});
