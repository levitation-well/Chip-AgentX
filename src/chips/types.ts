import path from 'node:path';
import { z } from 'zod';

export function isSafeRelativeWorkspaceDir(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[\\/]{2}/.test(trimmed)) {
    return false;
  }
  return !trimmed.split(/[\\/]+/).some((segment) => segment === '..');
}

export function isConfiguredAbsolutePath(value: string): boolean {
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || /^[\\/]{2}/.test(trimmed);
}

export function isSafeWorkspaceDir(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (isConfiguredAbsolutePath(trimmed)) {
    return true;
  }
  return isSafeRelativeWorkspaceDir(trimmed);
}

function isPathLikeMetadataValue(value: string): boolean {
  return /^[a-z]:\\/i.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.includes('\\');
}

function normalizeMetadataList(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((value) => value.trim())
    .filter((value, index, all) => value !== '' && !isPathLikeMetadataValue(value) && all.indexOf(value) === index);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeMetadataValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && !isPathLikeMetadataValue(trimmed) ? trimmed : undefined;
}

/**
 * Single chip configuration entry
 */
export const ChipConfigSchema = z.object({
  id: z.string().min(1, 'chip id is required'),
  label: z.string().min(1, 'chip label is required').refine((value) => !isPathLikeMetadataValue(value), 'chip label must not be a path'),
  description: z.string().optional(),
  queryHint: z.string().optional(),
  summary: z.string().optional(),
  brand: z.string().optional().transform(normalizeMetadataValue),
  brandAliases: z.array(z.string()).optional().transform(normalizeMetadataList),
  productLines: z.array(z.string()).optional().transform(normalizeMetadataList),
  applicationTags: z.array(z.string()).optional().transform(normalizeMetadataList),
  documentIds: z.array(z.string()).optional().transform(normalizeMetadataList),
  permissionTags: z.array(z.string()).optional().transform(normalizeMetadataList),
  sourceLabels: z.array(z.string()).optional().transform(normalizeMetadataList),
  workspaceDir: z
    .string()
    .min(1, 'workspace directory is required')
    .refine(isSafeWorkspaceDir, 'workspaceDir must be an absolute path or safe legacy relative path')
});

export type ChipConfig = z.infer<typeof ChipConfigSchema>;

/**
 * Top-level chip catalog
 */
export const ChipCatalogSchema = z.object({
  knowledgeBaseRoot: z.string().min(1, 'knowledgeBaseRoot is required'),
  chips: z.array(ChipConfigSchema).min(1, 'at least one chip must be defined')
});

export type ChipCatalog = z.infer<typeof ChipCatalogSchema>;

/**
 * Public chip info exposed to web clients — no filesystem paths.
 */
export interface PublicChip {
  id: string;
  label: string;
  description?: string;
  queryHint?: string;
  brand?: string;
  brandAliases?: string[];
  productLines?: string[];
  applicationTags?: string[];
  documentIds?: string[];
  permissionTags?: string[];
  sourceLabels?: string[];
}

/**
 * Resolved workspace for a chip, ready for spawning a session.
 */
export interface ResolvedChipWorkspace {
  chipId: string;
  label: string;
  cwd: string;
}

/**
 * Source of chip catalog configuration.
 */
export type ChipConfigSource = ChipCatalog;

/**
 * Error thrown when chip configuration is invalid or cannot be loaded.
 */
export class ChipConfigError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'ChipConfigError';
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when a requested chip is not found in the catalog.
 */
export class ChipNotFoundError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ChipNotFoundError';
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when workspace directory validation fails.
 * Covers: directory doesn't exist, path traversal, symlink escape, outside root.
 */
export class ChipWorkspaceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ChipWorkspaceError';
    this.statusCode = statusCode;
  }
}
