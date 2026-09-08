import type { ChipConfig } from '../chips/index.js';
import type {
  DocumentVisibilityContract,
  ResourceVisibilityCatalog,
  ScopePresetContract
} from '../security/index.js';

export type CatalogMetadataStatus = 'seed' | 'partial' | 'approved' | 'archived';

export interface BrandMetadata {
  id: string;
  label: string;
  aliases: string[];
  productLines: string[];
  applications: string[];
  chipIds: string[];
  documentIds: string[];
  scopePresetIds: string[];
  status: CatalogMetadataStatus;
}

export interface ProductLineMetadata {
  id: string;
  label: string;
  brand: string;
  applications: string[];
  chipIds: string[];
  documentIds: string[];
  scopePresetIds: string[];
  status: CatalogMetadataStatus;
}

export interface ApplicationMetadata {
  id: string;
  label: string;
  brands: string[];
  productLines: string[];
  chipIds: string[];
  documentIds: string[];
  scopePresetIds: string[];
  status: CatalogMetadataStatus;
}

export interface CatalogMetadataFoundation {
  brands: BrandMetadata[];
  productLines: ProductLineMetadata[];
  applications: ApplicationMetadata[];
  chips: ChipConfig[];
}

export interface ScopeCatalogFoundation {
  metadata: CatalogMetadataFoundation;
  resources: ResourceVisibilityCatalog;
}

export interface ScopeCatalogInput {
  brands?: unknown[];
  productLines?: unknown[];
  applications?: unknown[];
  chips?: unknown[];
  documents?: unknown[];
  scopePresets?: unknown[];
}

export type ScopeCatalogDocument = DocumentVisibilityContract;
export type ScopeCatalogPreset = ScopePresetContract;
