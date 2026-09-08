// Types
export {
  type InjectionPolicy,
  type PromptEntrypoint,
  type PromptFragment,
  type RoleChipAccess,
  type RoleConfig,
  type RoleCatalog,
  type PromptFile,
  type PromptCatalog,
  InjectionPolicySchema,
  PromptEntrypointSchema,
  PromptFragmentSchema,
  RoleChipAccessSchema,
  RoleConfigSchema,
  RoleCatalogSchema,
  PromptFileSchema,
  PromptCatalogSchema,
  PromptFileNotFoundError,
  PromptFileEmptyError
} from './types.js';

// Composer
export {
  type ComposeSystemPromptParams,
  type SelectPromptFragmentsParams,
  type ComposeGovernedPromptParams,
  composeSystemPrompt,
  selectPromptFragments,
  composeGovernedPrompt,
  appendSourceCitationPromptGuardrails,
  SOURCE_CITATION_PROMPT_GUARDRAILS,
  getPromptFilePath
} from './composer.js';

// Loaders
export { loadPromptCatalog, loadRoleConfig, loadPromptFile, resolvePromptPath } from './loader.js';

// Access control
export { validateChipAccess, getRoleConfig, getInjectionPolicy, canAccessAdmin, getAllowedChips } from './access.js';

// Injector
export {
  type InjectorState,
  type InjectionContext,
  buildSessionSystemPrompt,
  createInjectorState,
  injectSystemPrompt,
  shouldInjectPromptFragment,
  getInjectionContext
} from './injector.js';
