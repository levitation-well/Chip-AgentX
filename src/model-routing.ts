import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile, writeJsonAtomic } from './persistence/json-file.js';
import type { ChatMode } from './types.js';

export const ALLOWED_CLAUDE_MODEL_ROLES = ['opus', 'sonnet', 'haiku', 'fable'] as const;

export type ClaudeModelRole = typeof ALLOWED_CLAUDE_MODEL_ROLES[number];
export type ModeRoleMapping = Record<ChatMode, ClaudeModelRole>;

export interface ModelRoutingConfig {
  allowedRoles: ClaudeModelRole[];
  modeRoleMapping: ModeRoleMapping;
}

export const DEFAULT_MODE_ROLE_MAPPING: ModeRoleMapping = {
  standard: 'haiku',
  enhanced: 'sonnet',
  multimodal: 'opus'
};

export const DEFAULT_MODEL_ROUTING_CONFIG: ModelRoutingConfig = {
  allowedRoles: [...ALLOWED_CLAUDE_MODEL_ROLES],
  modeRoleMapping: { ...DEFAULT_MODE_ROLE_MAPPING }
};

const LEGACY_MODEL_TO_ROLE: Record<string, ClaudeModelRole> = {
  'deepseek-v4-flash': 'haiku',
  'deepseek-v4-pro': 'sonnet',
  'mimo-v2.5': 'opus'
};

export function isClaudeModelRole(value: unknown): value is ClaudeModelRole {
  return typeof value === 'string' && (ALLOWED_CLAUDE_MODEL_ROLES as readonly string[]).includes(value);
}

export function normalizeClaudeModelRole(value: unknown): ClaudeModelRole | undefined {
  if (isClaudeModelRole(value)) {
    return value;
  }
  return typeof value === 'string' ? LEGACY_MODEL_TO_ROLE[value] : undefined;
}

export function normalizeModeRoleMapping(input: Partial<Record<ChatMode, unknown>> | undefined): ModeRoleMapping {
  const normalized: ModeRoleMapping = { ...DEFAULT_MODE_ROLE_MAPPING };
  if (!input) {
    return normalized;
  }

  for (const mode of Object.keys(DEFAULT_MODE_ROLE_MAPPING) as ChatMode[]) {
    if (input[mode] === undefined) {
      continue;
    }
    const role = normalizeClaudeModelRole(input[mode]);
    if (!role) {
      throw new Error(`Unsupported Claude model role for ${mode}: ${String(input[mode])}`);
    }
    normalized[mode] = role;
  }
  return normalized;
}

export function normalizeModelRoutingConfig(input: unknown): ModelRoutingConfig {
  const record = isRecord(input) ? input : {};
  const allowedRolesInput = Array.isArray(record.allowedRoles) ? record.allowedRoles : ALLOWED_CLAUDE_MODEL_ROLES;
  const allowedRoles = [...new Set(allowedRolesInput.map(normalizeClaudeModelRole).filter(isClaudeModelRole))];
  if (allowedRoles.length === 0) {
    throw new Error('At least one Claude model role must be allowed');
  }
  const modeRoleMapping = normalizeModeRoleMapping(
    isRecord(record.modeRoleMapping) ? record.modeRoleMapping as Partial<Record<ChatMode, unknown>> : undefined
  );
  for (const [mode, role] of Object.entries(modeRoleMapping)) {
    if (!allowedRoles.includes(role)) {
      throw new Error(`Claude model role ${role} for ${mode} is not in allowedRoles`);
    }
  }
  return { allowedRoles, modeRoleMapping };
}

export function resolveModelRoutingConfigFile(configFile?: string, cwd = process.cwd()): string {
  return path.isAbsolute(configFile ?? '')
    ? configFile!
    : path.resolve(cwd, configFile ?? 'config/model-routing.json');
}

export function loadModelRoutingConfigSync(options: { configFile?: string; cwd?: string } = {}): ModelRoutingConfig {
  const configFile = resolveModelRoutingConfigFile(options.configFile, options.cwd);
  try {
    const raw = JSON.parse(readFileSync(configFile, 'utf8')) as unknown;
    return normalizeModelRoutingConfig(raw);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT') {
      return normalizeModelRoutingConfig(DEFAULT_MODEL_ROUTING_CONFIG);
    }
    throw error;
  }
}

export async function loadModelRoutingConfig(options: { configFile?: string; cwd?: string } = {}): Promise<ModelRoutingConfig> {
  const configFile = resolveModelRoutingConfigFile(options.configFile, options.cwd);
  const raw = await readJsonFile<unknown>(configFile, DEFAULT_MODEL_ROUTING_CONFIG);
  return normalizeModelRoutingConfig(raw);
}

export async function saveModelRoutingConfig(
  config: unknown,
  options: { configFile?: string; cwd?: string } = {}
): Promise<ModelRoutingConfig> {
  const normalized = normalizeModelRoutingConfig(config);
  const configFile = resolveModelRoutingConfigFile(options.configFile, options.cwd);
  await writeJsonAtomic(configFile, normalized);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
