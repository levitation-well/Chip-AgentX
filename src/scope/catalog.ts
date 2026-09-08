import { ChipConfigSchema } from '../chips/index.js';
import { parseResourceVisibilityCatalog } from '../security/index.js';
import type {
  ApplicationMetadata,
  BrandMetadata,
  CatalogMetadataFoundation,
  CatalogMetadataStatus,
  ProductLineMetadata,
  ScopeCatalogFoundation
} from './types.js';

const DEFAULT_STATUS: CatalogMetadataStatus = 'partial';

export function parseScopeCatalogFoundation(input: unknown): ScopeCatalogFoundation {
  const record = isRecord(input) ? input : {};
  const chips = dedupeBy(Array.isArray(record.chips) ? record.chips.map((chip) => ChipConfigSchema.parse(chip)) : [], (chip) => chip.id);
  const metadata: CatalogMetadataFoundation = {
    brands: dedupeBy(
      [
        ...normalizeMetadataEntries(record.brands, normalizeBrandMetadata),
        ...deriveBrandsFromChips(chips)
      ],
      (brand) => brand.id
    ),
    productLines: dedupeBy(
      [
        ...normalizeMetadataEntries(record.productLines, normalizeProductLineMetadata),
        ...deriveProductLinesFromChips(chips)
      ],
      (productLine) => productLine.id
    ),
    applications: dedupeBy(
      [
        ...normalizeMetadataEntries(record.applications, normalizeApplicationMetadata),
        ...deriveApplicationsFromChips(chips)
      ],
      (application) => application.id
    ),
    chips
  };

  return {
    metadata,
    resources: parseResourceVisibilityCatalog({
      documents: Array.isArray(record.documents) ? record.documents : [],
      scopePresets: Array.isArray(record.scopePresets) ? record.scopePresets : []
    })
  };
}

export function createDefaultElmosScopeSeed(): ScopeCatalogFoundation {
  return parseScopeCatalogFoundation({
    brands: [
      {
        id: 'ELMOS',
        label: 'ELMOS',
        aliases: ['ELMOS Semiconductor'],
        productLines: ['ELMOS Lighting', 'ELMOS Motor'],
        applications: ['Automotive lighting', 'Motor control'],
        status: 'seed'
      }
    ],
    productLines: [
      { id: 'ELMOS Lighting', label: 'ELMOS Lighting', brand: 'ELMOS', applications: ['Automotive lighting'], status: 'seed' },
      { id: 'ELMOS Motor', label: 'ELMOS Motor', brand: 'ELMOS', applications: ['Motor control'], status: 'seed' }
    ],
    applications: [
      { id: 'Automotive lighting', label: 'Automotive lighting', brands: ['ELMOS'], productLines: ['ELMOS Lighting'], status: 'seed' },
      { id: 'Motor control', label: 'Motor control', brands: ['ELMOS'], productLines: ['ELMOS Motor'], status: 'seed' }
    ],
    scopePresets: [
      {
        scopePresetId: 'scope-preset-elmos-all',
        label: 'ELMOS all products',
        visibility: 'restricted',
        status: 'pending',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting', 'ELMOS Motor'],
        applicationTags: ['Automotive lighting', 'Motor control'],
        chipIds: [],
        documentIds: [],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-all'] },
        sourceLabels: ['ELMOS seed scope; coverage pending']
      },
      {
        scopePresetId: 'scope-preset-elmos-lighting',
        label: 'ELMOS Lighting',
        visibility: 'restricted',
        status: 'pending',
        brands: ['ELMOS'],
        productLines: ['ELMOS Lighting'],
        applicationTags: ['Automotive lighting'],
        chipIds: [],
        documentIds: [],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-lighting'] },
        sourceLabels: ['ELMOS Lighting seed scope; coverage pending']
      },
      {
        scopePresetId: 'scope-preset-elmos-motor',
        label: 'ELMOS Motor',
        visibility: 'restricted',
        status: 'pending',
        brands: ['ELMOS'],
        productLines: ['ELMOS Motor'],
        applicationTags: ['Motor control'],
        chipIds: [],
        documentIds: [],
        requiredGrants: { scopePresetIds: ['scope-preset-elmos-motor'] },
        sourceLabels: ['ELMOS Motor seed scope; coverage pending']
      }
    ]
  });
}

function normalizeBrandMetadata(input: unknown): BrandMetadata {
  const record = requireRecord(input, 'brand metadata entry must be an object');
  const id = normalizeId(record.id ?? record.brand ?? record.label, 'brand id is required');
  return {
    id,
    label: normalizeLabel(record.label ?? record.name, id),
    aliases: normalizeStringList(record.aliases ?? record.brandAliases),
    productLines: normalizeStringList(record.productLines ?? record.productLine),
    applications: normalizeStringList(record.applications ?? record.applicationTags ?? record.application),
    chipIds: normalizeStringList(record.chipIds ?? record.chipId),
    documentIds: normalizeStringList(record.documentIds ?? record.documentId),
    scopePresetIds: normalizeStringList(record.scopePresetIds ?? record.scopePresetId),
    status: normalizeStatus(record.status)
  };
}

function normalizeProductLineMetadata(input: unknown): ProductLineMetadata {
  const record = requireRecord(input, 'product line metadata entry must be an object');
  const id = normalizeId(record.id ?? record.productLine ?? record.label, 'product line id is required');
  return {
    id,
    label: normalizeLabel(record.label ?? record.name, id),
    brand: normalizeId(record.brand, 'product line brand is required'),
    applications: normalizeStringList(record.applications ?? record.applicationTags ?? record.application),
    chipIds: normalizeStringList(record.chipIds ?? record.chipId),
    documentIds: normalizeStringList(record.documentIds ?? record.documentId),
    scopePresetIds: normalizeStringList(record.scopePresetIds ?? record.scopePresetId),
    status: normalizeStatus(record.status)
  };
}

function normalizeApplicationMetadata(input: unknown): ApplicationMetadata {
  const record = requireRecord(input, 'application metadata entry must be an object');
  const id = normalizeId(record.id ?? record.application ?? record.label, 'application id is required');
  return {
    id,
    label: normalizeLabel(record.label ?? record.name, id),
    brands: normalizeStringList(record.brands ?? record.brand),
    productLines: normalizeStringList(record.productLines ?? record.productLine),
    chipIds: normalizeStringList(record.chipIds ?? record.chipId),
    documentIds: normalizeStringList(record.documentIds ?? record.documentId),
    scopePresetIds: normalizeStringList(record.scopePresetIds ?? record.scopePresetId),
    status: normalizeStatus(record.status)
  };
}

function deriveBrandsFromChips(chips: Array<{ brand?: string; productLines?: string[]; applicationTags?: string[]; id: string; documentIds?: string[] }>): BrandMetadata[] {
  const brands = new Map<string, BrandMetadata>();
  for (const chip of chips) {
    if (!chip.brand) {
      continue;
    }
    const current =
      brands.get(chip.brand) ??
      {
        id: chip.brand,
        label: chip.brand,
        aliases: [],
        productLines: [],
        applications: [],
        chipIds: [],
        documentIds: [],
        scopePresetIds: [],
        status: DEFAULT_STATUS
      };
    mergeInto(current.productLines, chip.productLines ?? []);
    mergeInto(current.applications, chip.applicationTags ?? []);
    mergeInto(current.chipIds, [chip.id]);
    mergeInto(current.documentIds, chip.documentIds ?? []);
    brands.set(chip.brand, current);
  }
  return [...brands.values()];
}

function deriveProductLinesFromChips(chips: Array<{ brand?: string; productLines?: string[]; applicationTags?: string[]; id: string; documentIds?: string[] }>): ProductLineMetadata[] {
  const productLines = new Map<string, ProductLineMetadata>();
  for (const chip of chips) {
    for (const productLine of chip.productLines ?? []) {
      const current =
        productLines.get(productLine) ??
        {
          id: productLine,
          label: productLine,
          brand: chip.brand ?? '',
          applications: [],
          chipIds: [],
          documentIds: [],
          scopePresetIds: [],
          status: DEFAULT_STATUS
        };
      mergeInto(current.applications, chip.applicationTags ?? []);
      mergeInto(current.chipIds, [chip.id]);
      mergeInto(current.documentIds, chip.documentIds ?? []);
      productLines.set(productLine, current);
    }
  }
  return [...productLines.values()];
}

function deriveApplicationsFromChips(chips: Array<{ brand?: string; productLines?: string[]; applicationTags?: string[]; id: string; documentIds?: string[] }>): ApplicationMetadata[] {
  const applications = new Map<string, ApplicationMetadata>();
  for (const chip of chips) {
    for (const application of chip.applicationTags ?? []) {
      const current =
        applications.get(application) ??
        {
          id: application,
          label: application,
          brands: [],
          productLines: [],
          chipIds: [],
          documentIds: [],
          scopePresetIds: [],
          status: DEFAULT_STATUS
        };
      mergeInto(current.brands, chip.brand ? [chip.brand] : []);
      mergeInto(current.productLines, chip.productLines ?? []);
      mergeInto(current.chipIds, [chip.id]);
      mergeInto(current.documentIds, chip.documentIds ?? []);
      applications.set(application, current);
    }
  }
  return [...applications.values()];
}

function normalizeMetadataEntries<T>(value: unknown, normalize: (input: unknown) => T): T[] {
  return Array.isArray(value) ? value.map(normalize) : [];
}

function mergeInto(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function dedupeBy<T>(items: T[], getId: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const id = getId(item);
    if (!seen.has(id)) {
      seen.add(id);
      deduped.push(item);
    }
  }
  return deduped;
}

function normalizeStatus(value: unknown): CatalogMetadataStatus {
  return value === 'seed' || value === 'partial' || value === 'approved' || value === 'archived' ? value : DEFAULT_STATUS;
}

function normalizeId(value: unknown, message: string): string {
  if (typeof value !== 'string') {
    throw new Error(message);
  }
  const normalized = normalizeSafeString(value);
  if (!normalized) {
    throw new Error(message);
  }
  return normalized;
}

function normalizeLabel(value: unknown, fallback: string): string {
  return typeof value === 'string' ? normalizeSafeString(value) || fallback : fallback;
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const normalized: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string') {
      continue;
    }
    const safe = normalizeSafeString(item);
    if (safe && !normalized.includes(safe)) {
      normalized.push(safe);
    }
  }
  return normalized;
}

function normalizeSafeString(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || isPathLike(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isPathLike(value: string): boolean {
  return /^[a-z]:\\/i.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.includes('\\');
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(message);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
