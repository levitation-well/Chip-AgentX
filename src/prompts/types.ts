import { z } from 'zod';
import { isModelId, type ModelId } from '../model-catalog.js';

/**
 * Injection policy for system prompt
 */
export const InjectionPolicySchema = z.enum(['first_turn', 'every_turn', 'never']);
export type InjectionPolicy = z.infer<typeof InjectionPolicySchema>;

export const PromptEntrypointSchema = z.enum(['chat', 'mcp', 'cli']);
export type PromptEntrypoint = z.infer<typeof PromptEntrypointSchema>;

const MatchScopeSchema = z.array(z.string().min(1)).default(['*']);
const ModelScopeSchema = z.array(z.union([
  z.literal('*'),
  z.custom<ModelId>((value) => isModelId(value), { message: 'Unknown model id' })
])).default(['*']);

/**
 * Governed prompt fragment used by prompt composition.
 * Scope arrays support "*" as a wildcard and the schema rejects unknown fields.
 */
export const PromptFragmentSchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  enabled: z.boolean().default(true),
  entrypoints: z.array(PromptEntrypointSchema).default(['chat', 'mcp', 'cli']),
  models: ModelScopeSchema,
  languages: MatchScopeSchema,
  roles: MatchScopeSchema,
  userLevels: MatchScopeSchema,
  chipIds: MatchScopeSchema,
  resourceScopes: MatchScopeSchema,
  priority: z.number().int().default(0),
  version: z.union([z.string().min(1), z.number().int().nonnegative()]).default(1),
  injectionPolicy: InjectionPolicySchema.default('first_turn')
}).strict();
export type PromptFragment = z.infer<typeof PromptFragmentSchema>;

/**
 * Role-chip access configuration
 */
export const RoleChipAccessSchema = z.object({
  allowedChips: z.array(z.string()),
  injectionPolicy: InjectionPolicySchema
});
export type RoleChipAccess = z.infer<typeof RoleChipAccessSchema>;

/**
 * Role configuration
 */
export const RoleConfigSchema = z.object({
  description: z.string(),
  access: RoleChipAccessSchema
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

/**
 * Permission metadata for UI rendering
 */
export const PermissionMetaSchema = z.object({
  label: z.string(),
  description: z.string()
});
export type PermissionMeta = z.infer<typeof PermissionMetaSchema>;

/**
 * Role catalog (map of role name to config).
 * Supports extended format with optional `_permissions` UI metadata.
 * All named role entries must have description and access fields.
 */
export const RoleCatalogSchema: z.ZodType<Record<string, unknown>> = z.lazy(() =>
  z.object({
    _permissions: z.record(z.string(), z.object({
      label: z.string(),
      description: z.string()
    })).optional(),
  }).catchall(z.union([
    z.object({
      description: z.string(),
      access: z.object({
        allowedChips: z.array(z.string()),
        injectionPolicy: InjectionPolicySchema
      }),
      permissions: z.array(z.string()).optional()
    }),
    z.object({ label: z.string(), description: z.string() })
  ]))
);

export type RoleCatalog = z.infer<typeof RoleCatalogSchema>;

/**
 * Prompt file path configuration
 */
export const PromptFileSchema = z.object({
  global: z.string(),
  roles: z.string(),
  chips: z.string()
});
export type PromptFile = z.infer<typeof PromptFileSchema>;

/**
 * Prompt catalog (all paths and metadata)
 */
export const PromptCatalogSchema = z.object({
  baseDir: z.string(),
  files: PromptFileSchema,
  defaultRole: z.enum(['admin', 'internal', 'customer']).default('customer')
});
export type PromptCatalog = z.infer<typeof PromptCatalogSchema>;

/**
 * Error thrown when a prompt file is not found.
 */
export class PromptFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Prompt file not found: ${filePath}. Please create it in the Admin UI.`);
    this.name = 'PromptFileNotFoundError';
  }
}

/**
 * Error thrown when a prompt file is empty.
 */
export class PromptFileEmptyError extends Error {
  constructor(filePath: string) {
    super(`Prompt file is empty: ${filePath}`);
    this.name = 'PromptFileEmptyError';
  }
}
