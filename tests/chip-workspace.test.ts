import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InvalidChipWorkspaceTargetError, materializeChipWorkspace } from '../src/scope/chip-workspace.js';

describe('materializeChipWorkspace', () => {
  it('将 chip 文件复制到源根之外的临时工作区并在 cleanup 后删除', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.31');
    mkdirSync(chipDir, { recursive: true });
    writeFileSync(path.join(chipDir, 'merge.md'), '# E521.31\nhello', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));

    const ws = await materializeChipWorkspace({ chipCwd: chipDir, dataDir });

    expect(ws.cwd).not.toContain(kb);
    expect(existsSync(path.join(ws.cwd, 'merge.md'))).toBe(true);
    expect(readdirSync(ws.cwd).length).toBeGreaterThan(0);
    await ws.cleanup();
    expect(existsSync(ws.cwd)).toBe(false);
  });

  it('只复制允许后缀的文件，fileCount 正确', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.32');
    mkdirSync(chipDir, { recursive: true });
    // 允许的文件
    writeFileSync(path.join(chipDir, 'spec.md'), '# spec', 'utf8');
    writeFileSync(path.join(chipDir, 'data.json'), '{}', 'utf8');
    writeFileSync(path.join(chipDir, 'notes.txt'), 'notes', 'utf8');
    writeFileSync(path.join(chipDir, 'table.csv'), 'a,b', 'utf8');
    // 不允许的文件
    writeFileSync(path.join(chipDir, 'note.exe'), 'binary', 'utf8');
    writeFileSync(path.join(chipDir, 'a.bin'), 'binary', 'utf8');
    writeFileSync(path.join(chipDir, 'image.png'), 'png', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));

    const ws = await materializeChipWorkspace({ chipCwd: chipDir, dataDir });

    expect(ws.fileCount).toBe(4);
    expect(existsSync(path.join(ws.cwd, 'spec.md'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'data.json'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'notes.txt'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'table.csv'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'note.exe'))).toBe(false);
    expect(existsSync(path.join(ws.cwd, 'a.bin'))).toBe(false);
    expect(existsSync(path.join(ws.cwd, 'image.png'))).toBe(false);
    await ws.cleanup();
  });

  it('保持嵌套子目录结构', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.33');
    const subDir = path.join(chipDir, 'sub', 'nested');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(chipDir, 'root.md'), '# root', 'utf8');
    writeFileSync(path.join(subDir, 'deep.md'), '# deep', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));

    const ws = await materializeChipWorkspace({ chipCwd: chipDir, dataDir });

    expect(ws.fileCount).toBe(2);
    expect(existsSync(path.join(ws.cwd, 'root.md'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'sub', 'nested', 'deep.md'))).toBe(true);
    await ws.cleanup();
  });

  it('maxFiles 上限生效，超出部分不复制', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.34');
    mkdirSync(chipDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(chipDir, `file${i}.md`), `# ${i}`, 'utf8');
    }
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));

    const ws = await materializeChipWorkspace({ chipCwd: chipDir, dataDir, maxFiles: 3 });

    expect(ws.fileCount).toBe(3);
    await ws.cleanup();
  });

  it('chipCwd 不存在时应 reject，且不留下孤儿 chip-* 目录', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));
    const nonExistent = path.join(dataDir, 'does-not-exist');

    await expect(
      materializeChipWorkspace({ chipCwd: nonExistent, dataDir })
    ).rejects.toThrow();

    // 验证 scope-workspaces 下没有残留的 chip-* 目录
    const scopeWorkspacesDir = path.join(dataDir, 'scope-workspaces');
    const orphans = existsSync(scopeWorkspacesDir)
      ? readdirSync(scopeWorkspacesDir).filter((n) => n.startsWith('chip-'))
      : [];
    expect(orphans).toHaveLength(0);
  });

  it('rebuilds a historical workspace at the exact validated cwd', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.35');
    mkdirSync(chipDir, { recursive: true });
    writeFileSync(path.join(chipDir, 'datasheet.md'), '# current datasheet', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));
    const targetCwd = path.join(
      dataDir,
      'scope-workspaces',
      'chip-00000000-0000-4000-8000-000000000351'
    );
    mkdirSync(targetCwd, { recursive: true });
    writeFileSync(path.join(targetCwd, 'stale.md'), '# stale', 'utf8');

    const ws = await materializeChipWorkspace({ chipCwd: chipDir, dataDir, targetCwd });

    expect(ws.cwd).toBe(path.resolve(targetCwd));
    expect(existsSync(path.join(ws.cwd, 'datasheet.md'))).toBe(true);
    expect(existsSync(path.join(ws.cwd, 'stale.md'))).toBe(false);
    await ws.cleanup();
  });

  it('rejects historical targets outside the direct chip workspace namespace', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.36');
    mkdirSync(chipDir, { recursive: true });
    writeFileSync(path.join(chipDir, 'datasheet.md'), '# datasheet', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));
    const nestedTarget = path.join(
      dataDir,
      'scope-workspaces',
      'nested',
      'chip-00000000-0000-4000-8000-000000000361'
    );

    await expect(materializeChipWorkspace({
      chipCwd: chipDir,
      dataDir,
      targetCwd: path.join(dataDir, 'legacy-workspace')
    })).rejects.toBeInstanceOf(InvalidChipWorkspaceTargetError);
    await expect(materializeChipWorkspace({
      chipCwd: chipDir,
      dataDir,
      targetCwd: nestedTarget
    })).rejects.toBeInstanceOf(InvalidChipWorkspaceTargetError);
  });

  it('preserves the cwd key after the original isolated directory was cleaned', async () => {
    const kb = mkdtempSync(path.join(tmpdir(), 'kb-'));
    const chipDir = path.join(kb, 'E521.37');
    mkdirSync(chipDir, { recursive: true });
    writeFileSync(path.join(chipDir, 'datasheet.md'), '# datasheet', 'utf8');
    const dataDir = mkdtempSync(path.join(tmpdir(), 'data-'));
    const first = await materializeChipWorkspace({ chipCwd: chipDir, dataDir });
    const claudeSessionId = '00000000-0000-4000-8000-000000000371';
    const cwdKeyedSessions = new Set([`${path.resolve(first.cwd)}::${claudeSessionId}`]);

    await first.cleanup();
    expect(existsSync(first.cwd)).toBe(false);
    const resumed = await materializeChipWorkspace({
      chipCwd: chipDir,
      dataDir,
      targetCwd: first.cwd
    });

    expect(resumed.cwd).toBe(first.cwd);
    expect(cwdKeyedSessions.has(`${path.resolve(resumed.cwd)}::${claudeSessionId}`)).toBe(true);
    expect(existsSync(path.join(resumed.cwd, 'datasheet.md'))).toBe(true);
    await resumed.cleanup();
  });
});
