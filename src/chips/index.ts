// Types
export {
  type ChipConfig,
  type ChipCatalog,
  type PublicChip,
  type ResolvedChipWorkspace,
  type ChipConfigSource,
  ChipCatalogSchema,
  ChipConfigSchema,
  ChipConfigSchema as ChipConfigSchemaType
} from './types.js';
export { ChipConfigError, ChipNotFoundError, ChipWorkspaceError } from './types.js';

// Config loader
export {
  loadChipCatalogFromFile,
  parseChipCatalog,
  listPublicChips,
  getDefaultChipConfigPath,
  getDefaultUserChipAccessPath
} from './config.js';

// Workspace resolver
export { resolveChipWorkspace, isPathInside } from './workspace.js';
