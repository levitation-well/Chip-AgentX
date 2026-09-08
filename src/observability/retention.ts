import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../logging/index.js';
import type { PersistencePaths } from '../persistence/paths.js';

export interface RetentionPolicy {
  rawDebugDays: number;
  auditDays: number;
  metricsDays: number;
}

export interface RetentionCleanupResult {
  deleted: string[];
  skipped: string[];
  errors: Array<{ file: string; error: string }>;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  rawDebugDays: 30,
  auditDays: 180,
  metricsDays: 365
};

export function resolveRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    rawDebugDays: readPositiveInt(env.AGENTX_RETENTION_RAW_DEBUG_DAYS, DEFAULT_RETENTION_POLICY.rawDebugDays),
    auditDays: readPositiveInt(env.AGENTX_RETENTION_AUDIT_DAYS, DEFAULT_RETENTION_POLICY.auditDays),
    metricsDays: readPositiveInt(env.AGENTX_RETENTION_METRICS_DAYS, DEFAULT_RETENTION_POLICY.metricsDays)
  };
}

export async function cleanupRetention(
  paths: PersistencePaths,
  options: { policy?: RetentionPolicy; now?: Date; logger?: Logger } = {}
): Promise<RetentionCleanupResult> {
  const policy = options.policy ?? DEFAULT_RETENTION_POLICY;
  const now = options.now ?? new Date();
  const result: RetentionCleanupResult = { deleted: [], skipped: [], errors: [] };
  const root = path.resolve(paths.dataDir);

  await cleanupTree(paths.sessionsDir, ['output.log', 'debug.json'], policy.rawDebugDays, now, root, result);
  await cleanupTree(paths.logsDir, ['audit-'], policy.auditDays, now, root, result);
  await cleanupTree(path.join(root, 'observability'), ['metrics-'], policy.metricsDays, now, root, result);

  if (result.errors.length > 0) {
    options.logger?.warn('retention_cleanup_partial_failure', 'Retention cleanup completed with errors', {
      metadata: { errorCount: result.errors.length }
    });
  }
  return result;
}

async function cleanupTree(
  directory: string,
  fileMarkers: string[],
  retentionDays: number,
  now: Date,
  root: string,
  result: RetentionCleanupResult
): Promise<void> {
  const resolvedDirectory = path.resolve(directory);
  if (!resolvedDirectory.startsWith(`${root}${path.sep}`) && resolvedDirectory !== root) {
    result.skipped.push(directory);
    return;
  }
  if (!existsSync(directory)) return;
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(`${root}${path.sep}`) && resolved !== root) {
      result.skipped.push(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      await cleanupTree(fullPath, fileMarkers, retentionDays, now, root, result);
      continue;
    }
    if (!fileMarkers.some((marker) => entry.name === marker || entry.name.startsWith(marker))) {
      continue;
    }
    try {
      const info = await stat(fullPath);
      if (info.mtime.getTime() < cutoff) {
        await rm(fullPath, { force: true });
        result.deleted.push(fullPath);
      }
    } catch (error) {
      result.errors.push({ file: fullPath, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
