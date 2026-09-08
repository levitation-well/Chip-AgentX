import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  type ChipCatalog,
  type PublicChip,
  ChipCatalogSchema,
  ChipConfigError
} from './types.js';

/**
 * Validate duplicate chip IDs in the catalog.
 */
function validateNoDuplicateIds(catalog: ChipCatalog): void {
  const ids = catalog.chips.map((c) => c.id);
  const uniqueIds = new Set(ids);
  if (ids.length !== uniqueIds.size) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    throw new ChipConfigError(
      `Invalid chip config: duplicate chip IDs are not allowed: ${[...new Set(duplicates)].join(', ')}`,
      500
    );
  }
}

/**
 * Load a chip catalog from a JSON file.
 */
export async function loadChipCatalogFromFile(filePath: string): Promise<ChipCatalog> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, 'utf-8'));
  } catch (err) {
    throw new ChipConfigError(`Failed to read chip config file: ${filePath}`, 500);
  }
  return parseChipCatalog(raw, filePath);
}

/**
 * Parse and validate a raw value as ChipCatalog.
 * Throws ChipConfigError on validation failure.
 */
export function parseChipCatalog(value: unknown, sourceLabel = 'input'): ChipCatalog {
  try {
    const catalog = ChipCatalogSchema.parse(value);
    validateNoDuplicateIds(catalog);
    return catalog;
  } catch (err) {
    if (err instanceof ChipConfigError) {
      throw err;
    }
    if (err instanceof z.ZodError) {
      const messages = err.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new ChipConfigError(`Invalid chip config (${sourceLabel}): ${messages}`, 500);
    }
    throw err;
  }
}

/**
 * Return public chip list — safe resource metadata only, no filesystem paths.
 */
export function listPublicChips(catalog: ChipCatalog): PublicChip[] {
  return catalog.chips.map((c) => ({
    id: c.id,
    label: c.label,
    ...(c.description !== undefined ? { description: c.description } : {}),
    ...(c.queryHint !== undefined ? { queryHint: c.queryHint } : {}),
    ...(c.brand !== undefined ? { brand: c.brand } : {}),
    ...(c.brandAliases !== undefined ? { brandAliases: [...c.brandAliases] } : {}),
    ...(c.productLines !== undefined ? { productLines: [...c.productLines] } : {}),
    ...(c.applicationTags !== undefined ? { applicationTags: [...c.applicationTags] } : {}),
    ...(c.documentIds !== undefined ? { documentIds: [...c.documentIds] } : {}),
    ...(c.permissionTags !== undefined ? { permissionTags: [...c.permissionTags] } : {}),
    ...(c.sourceLabels !== undefined ? { sourceLabels: [...c.sourceLabels] } : {})
  }));
}

/**
 * Get the default chip config file path.
 * Respects CHIP_CONFIG_FILE env var; falls back to config/chips.json.
 */
export function getDefaultChipConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHIP_CONFIG_FILE && env.CHIP_CONFIG_FILE.trim() !== '') {
    return env.CHIP_CONFIG_FILE;
  }
  return 'config/chips.json';
}

/**
 * Get the default per-user chip access file path.
 * Respects CHIP_USER_ACCESS_FILE; otherwise production data dirs keep mutable
 * grants outside read-only deployment checkouts.
 */
export function getDefaultUserChipAccessPath(dataDir?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CHIP_USER_ACCESS_FILE && env.CHIP_USER_ACCESS_FILE.trim() !== '') {
    return env.CHIP_USER_ACCESS_FILE;
  }

  const configuredDataDir = dataDir?.trim() || env.AGENTX_DATA_DIR?.trim() || env.DATA_DIR?.trim();
  if (configuredDataDir) {
    return path.join(configuredDataDir, 'config', 'user-chip-access.json');
  }

  return 'config/user-chip-access.json';
}
