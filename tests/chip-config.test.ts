import { mkdtemp, realpath, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  parseChipCatalog,
  listPublicChips,
  resolveChipWorkspace,
  loadChipCatalogFromFile,
  getDefaultChipConfigPath,
  getDefaultUserChipAccessPath,
  ChipConfigError,
  ChipNotFoundError,
  ChipWorkspaceError
} from '../src/chips/index.js';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'chip-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe('chip config loading', () => {
  it('loads catalog from JSON file', async () =>
    withTempDir(async (dir) => {
      const configPath = join(dir, 'chips.json');
      await writeFile(
        configPath,
        JSON.stringify({
          knowledgeBaseRoot: dir,
          chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '.' }]
        }),
        'utf-8'
      );
      const catalog = await loadChipCatalogFromFile(configPath);
      expect(catalog.knowledgeBaseRoot).toBe(dir);
      expect(catalog.chips).toHaveLength(1);
    }));

  it('parses valid catalog with single chip', () => {
    const catalog = parseChipCatalog({
      knowledgeBaseRoot: '/kb',
      chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: 'E521.39' }]
    });
    expect(catalog.knowledgeBaseRoot).toBe('/kb');
    expect(catalog.chips).toHaveLength(1);
    expect(catalog.chips[0].id).toBe('E521.39');
  });

  it('rejects duplicate chip IDs', () => {
    expect(() =>
      parseChipCatalog({
        knowledgeBaseRoot: '/kb',
        chips: [
          { id: 'E521.39', label: 'E521.39', workspaceDir: 'dir1' },
          { id: 'E521.39', label: 'E521.39 again', workspaceDir: 'dir2' }
        ]
      })
    ).toThrow(ChipConfigError);
  });

  it('rejects empty chips array', () => {
    expect(() =>
      parseChipCatalog({
        knowledgeBaseRoot: '/kb',
        chips: []
      })
    ).toThrow(ChipConfigError);
  });

  it('rejects missing knowledgeBaseRoot', () => {
    expect(() =>
      parseChipCatalog({
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '.' }]
      })
    ).toThrow(ChipConfigError);
  });
});

describe('listPublicChips', () => {
  it('returns only id and label, not workspaceDir', () => {
    const catalog = parseChipCatalog({
      knowledgeBaseRoot: '/kb',
      chips: [{ id: 'E521.39', label: 'E521.39 Chip', workspaceDir: 'e521' }]
    });
    const publicChips = listPublicChips(catalog);
    expect(publicChips).toHaveLength(1);
    expect(publicChips[0]).toHaveProperty('id', 'E521.39');
    expect(publicChips[0]).toHaveProperty('label', 'E521.39 Chip');
    expect(publicChips[0]).not.toHaveProperty('workspaceDir');
    expect(publicChips[0]).not.toHaveProperty('cwd');
    expect(publicChips[0]).not.toHaveProperty('knowledgeBaseRoot');
  });

  it('parses optional public metadata and includes it in public chips without paths', () => {
    const catalog = parseChipCatalog({
      knowledgeBaseRoot: '/kb',
      chips: [
        {
          id: 'E521.39',
          label: 'E521.39 Chip',
          description: 'LIN motor driver datasheet and notes',
          queryHint: 'Ask about E521.39 registers and diagnostics',
          workspaceDir: 'e521'
        }
      ]
    });

    expect(catalog.chips[0]).toHaveProperty('description', 'LIN motor driver datasheet and notes');
    expect(catalog.chips[0]).toHaveProperty('queryHint', 'Ask about E521.39 registers and diagnostics');

    const publicChips = listPublicChips(catalog);
    expect(publicChips[0]).toEqual({
      id: 'E521.39',
      label: 'E521.39 Chip',
      description: 'LIN motor driver datasheet and notes',
      queryHint: 'Ask about E521.39 registers and diagnostics'
    });
    expect(publicChips[0]).not.toHaveProperty('workspaceDir');
    expect(publicChips[0]).not.toHaveProperty('cwd');
    expect(publicChips[0]).not.toHaveProperty('knowledgeBaseRoot');
  });

  it('returns all chips with public fields', () => {
    const catalog = parseChipCatalog({
      knowledgeBaseRoot: '/kb',
      chips: [
        { id: 'E521.39', label: 'E521.39', workspaceDir: 'e521' },
        { id: 'RISC-V', label: 'RISC-V Core', workspaceDir: 'riscv' }
      ]
    });
    const publicChips = listPublicChips(catalog);
    expect(publicChips).toHaveLength(2);
    expect(publicChips.map((c) => c.id)).toEqual(['E521.39', 'RISC-V']);
    publicChips.forEach((c) => {
      expect(Object.keys(c)).toEqual(['id', 'label']);
    });
  });

  it('summary 不出现在 listPublicChips 公共投影', () => {
    const catalog = parseChipCatalog({
      knowledgeBaseRoot: '/kb',
      chips: [{ id: 'E522.94', label: 'E522.94', summary: 'LED 开短路诊断', workspaceDir: 'e522' }]
    });
    expect(catalog.chips[0]).toHaveProperty('summary', 'LED 开短路诊断'); // schema 保留
    expect(listPublicChips(catalog)[0]).not.toHaveProperty('summary');   // 但不对外暴露
  });
});

describe('resolveChipWorkspace', () => {
  it('resolves valid chipId to real workspace path', () =>
    withTempDir(async (dir) => {
      const workspaceDir = join(dir, 'e521-workspace');
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: 'e521-workspace' }]
      });
      await mkdir(workspaceDir, { recursive: true });

      const result = await resolveChipWorkspace(catalog, 'E521.39');
      expect(result.chipId).toBe('E521.39');
      expect(result.label).toBe('E521.39');
      expect(result.cwd).toBe(workspaceDir);
    }));

  it('throws ChipNotFoundError for unknown chipId', () =>
    withTempDir(async (dir) => {
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '.' }]
      });
      await expect(resolveChipWorkspace(catalog, 'UNKNOWN-CHIP')).rejects.toThrow(ChipNotFoundError);
    }));

  it('rejects workspaceDir pointing to non-existent directory', () =>
    withTempDir(async (dir) => {
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: 'non-existent-dir' }]
      });
      await expect(resolveChipWorkspace(catalog, 'E521.39')).rejects.toThrow(ChipWorkspaceError);
    }));

  it('rejects workspaceDir using path traversal (..) before runtime resolution', () =>
    withTempDir(async (dir) => {
      expect(() =>
        parseChipCatalog({
          knowledgeBaseRoot: dir,
          chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '../outside' }]
        })
      ).toThrow(ChipConfigError);
    }));

  it('parses explicit absolute workspaceDir values', () =>
    withTempDir(async (dir) => {
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: dir }]
      });
      expect(catalog.chips[0].workspaceDir).toBe(dir);
    }));

  it('resolves absolute workspaceDir outside knowledgeBaseRoot', () =>
    withTempDir(async (dir) => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'chip-absolute-'));
      try {
        const catalog = parseChipCatalog({
          knowledgeBaseRoot: dir,
          chips: [{ id: 'ABS', label: 'Absolute', workspaceDir: outsideDir }]
        });
        const result = await resolveChipWorkspace(catalog, 'ABS');
        expect(result.cwd).toBe(await realpath(outsideDir));
      } finally {
        await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
      }
    }));

  it('rejects unparsed catalog workspaceDir using path traversal (..) at runtime', () =>
    withTempDir(async (dir) => {
      const catalog = {
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '../outside' }]
      };
      await expect(resolveChipWorkspace(catalog, 'E521.39')).rejects.toThrow(ChipWorkspaceError);
    }));

  it('rejects symlink escaping knowledgeBaseRoot', () =>
    withTempDir(async (dir) => {
      const outsideDir = await mkdtemp(join(tmpdir(), 'chip-outside-'));
      try {
        const safeDir = join(dir, 'safe');
        await mkdir(safeDir, { recursive: true });
        const symlinkPath = join(dir, 'escape');
        try {
          await symlink(outsideDir, symlinkPath);
          const catalog = parseChipCatalog({
            knowledgeBaseRoot: dir,
            chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: 'escape' }]
          });
          await expect(resolveChipWorkspace(catalog, 'E521.39')).rejects.toThrow(ChipWorkspaceError);
        } catch {
          // Symlink creation may fail on some platforms (e.g., unprivileged Windows)
          // In that case, test with path traversal using parent directory reference
          const escapeDir = join(dir, '..', 'escape-from-within');
          const catalog2 = {
            knowledgeBaseRoot: dir,
            chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '..' }]
          };
          await expect(resolveChipWorkspace(catalog2, 'E521.39')).rejects.toThrow(ChipWorkspaceError);
        }
      } finally {
        await rm(outsideDir, { recursive: true, force: true }).catch(() => {});
      }
    }));

  it('rejects absolute workspaceDir pointing at a file', () =>
    withTempDir(async (dir) => {
      const filePath = join(dir, 'workspace-file');
      await writeFile(filePath, 'not a directory', 'utf-8');
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: filePath }]
      });
      await expect(resolveChipWorkspace(catalog, 'E521.39')).rejects.toThrow(ChipWorkspaceError);
    }));

  it('throws ChipNotFoundError with statusCode 400', async () =>
    withTempDir(async (dir) => {
      const catalog = parseChipCatalog({
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '.' }]
      });
      try {
        await resolveChipWorkspace(catalog, 'UNKNOWN');
      } catch (e) {
        expect(e).toBeInstanceOf(ChipNotFoundError);
        expect((e as ChipNotFoundError).statusCode).toBe(400);
      }
    }));

  it('throws ChipWorkspaceError with statusCode 400 for traversal', async () =>
    withTempDir(async (dir) => {
      const catalog = {
        knowledgeBaseRoot: dir,
        chips: [{ id: 'E521.39', label: 'E521.39', workspaceDir: '../evil' }]
      };
      try {
        await resolveChipWorkspace(catalog, 'E521.39');
      } catch (e) {
        expect(e).toBeInstanceOf(ChipWorkspaceError);
        expect((e as ChipWorkspaceError).statusCode).toBe(400);
      }
    }));
});

describe('getDefaultChipConfigPath', () => {
  it('returns CHIP_CONFIG_FILE env var when set', () => {
    const orig = process.env.CHIP_CONFIG_FILE;
    process.env.CHIP_CONFIG_FILE = '/custom/path/chips.json';
    try {
      expect(getDefaultChipConfigPath()).toBe('/custom/path/chips.json');
    } finally {
      if (orig === undefined) {
        delete process.env.CHIP_CONFIG_FILE;
      } else {
        process.env.CHIP_CONFIG_FILE = orig;
      }
    }
  });

  it('falls back to config/chips.json when env not set', () => {
    const orig = process.env.CHIP_CONFIG_FILE;
    if (orig !== undefined) {
      delete process.env.CHIP_CONFIG_FILE;
    }
    try {
      expect(getDefaultChipConfigPath()).toBe('config/chips.json');
    } finally {
      if (orig !== undefined) {
        process.env.CHIP_CONFIG_FILE = orig;
      }
    }
  });
});

describe('getDefaultUserChipAccessPath', () => {
  it('prefers CHIP_USER_ACCESS_FILE when set', () => {
    expect(getDefaultUserChipAccessPath('/data/agentx', { CHIP_USER_ACCESS_FILE: '/custom/access.json' })).toBe(
      '/custom/access.json'
    );
  });

  it('uses the configured data dir for mutable grants', () => {
    expect(getDefaultUserChipAccessPath('/data/agentx', {})).toBe(join('/data/agentx', 'config', 'user-chip-access.json'));
  });

  it('falls back to AGENTX_DATA_DIR before repo-local config', () => {
    expect(getDefaultUserChipAccessPath(undefined, { AGENTX_DATA_DIR: '/opt/chip-agentx' })).toBe(
      join('/opt/chip-agentx', 'config', 'user-chip-access.json')
    );
  });

  it('keeps the repo-local development default without env or data dir', () => {
    expect(getDefaultUserChipAccessPath(undefined, {})).toBe('config/user-chip-access.json');
  });
});
