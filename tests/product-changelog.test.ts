import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChangelog, readChangelog } from '../src/product/index.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-changelog-'));
}

describe('product changelog', () => {
  it('parses recent versions from markdown', () => {
    const result = parseChangelog([
      '# Changelog',
      '',
      '## 0.2.0 - 2026-05-14',
      '',
      '- Add product shell',
      '- Add landing page',
      '',
      '## 0.1.0 - 2026-05-01',
      '',
      '- Initial release'
    ].join('\n'));

    expect(result).toEqual({
      available: true,
      entries: [
        { version: '0.2.0', date: '2026-05-14', items: ['Add product shell', 'Add landing page'] },
        { version: '0.1.0', date: '2026-05-01', items: ['Initial release'] }
      ]
    });
  });

  it('soft-fails when changelog is missing', async () => {
    const cwd = await tempDir();

    await expect(readChangelog({ cwd })).resolves.toEqual({
      available: false,
      entries: [],
      error: 'missing'
    });
  });

  it('soft-fails when changelog is empty or unparseable', async () => {
    const cwd = await tempDir();
    const filePath = path.join(cwd, 'CHANGELOG.md');

    await writeFile(filePath, '', 'utf8');
    await expect(readChangelog({ filePath })).resolves.toEqual({
      available: false,
      entries: [],
      error: 'empty'
    });

    await writeFile(filePath, '# Changelog\n\nNo structured entries', 'utf8');
    await expect(readChangelog({ filePath })).resolves.toEqual({
      available: false,
      entries: [],
      error: 'unparseable'
    });
  });
});
