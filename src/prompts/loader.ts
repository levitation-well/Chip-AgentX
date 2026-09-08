import { readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import {
  PromptCatalogSchema,
  RoleCatalogSchema,
  PromptFileNotFoundError,
  PromptFileEmptyError
} from './types.js';
import type { PromptCatalog, RoleCatalog } from './types.js';

/**
 * Default paths for prompt configuration files
 */
const PROJECT_ROOT = resolve(process.cwd());
const DEFAULT_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'prompts.json');
const DEFAULT_ROLES_CONFIG_PATH = resolve(PROJECT_ROOT, 'config', 'roles.json');

/**
 * Load prompt catalog from config file.
 * Uses default path if not specified.
 */
export async function loadPromptCatalog(
  configPath: string = DEFAULT_CONFIG_PATH
): Promise<PromptCatalog> {
  const content = await readFile(configPath, 'utf-8');
  const raw = JSON.parse(content);
  return PromptCatalogSchema.parse(raw);
}

/**
 * Load role configuration from config file.
 * Uses default path if not specified.
 */
export async function loadRoleConfig(
  configPath: string = DEFAULT_ROLES_CONFIG_PATH
): Promise<RoleCatalog> {
  const content = await readFile(configPath, 'utf-8');
  const raw = JSON.parse(content);
  return RoleCatalogSchema.parse(raw);
}

/**
 * Load a single prompt file, with validation.
 * Throws PromptFileNotFoundError if file doesn't exist.
 * Throws PromptFileEmptyError if file is empty or whitespace-only.
 */
export async function loadPromptFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    if (!content.trim()) {
      throw new PromptFileEmptyError(filePath);
    }
    return content;
  } catch (error) {
    if (error instanceof PromptFileEmptyError) {
      throw error;
    }
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PromptFileNotFoundError(filePath);
    }
    throw error;
  }
}

/**
 * Resolve a relative path inside the prompts directory, rejecting traversal attacks.
 * This is a security measure to prevent path traversal vulnerabilities.
 */
export function resolvePromptPath(baseDir: string, relativePath: string): string {
  const resolved = resolve(baseDir, relativePath);

  // Security check: ensure resolved path is inside baseDir
  const rel = relative(baseDir, resolved);

  // Check for path traversal attempts
  // On Windows, both \ and / can be used as separators
  const normalizedRel = rel.replace(/\\/g, '/');
  if (normalizedRel.startsWith('..') || normalizedRel.startsWith('/')) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }

  return resolved;
}
