import type { ChipCatalog } from '../chips/index.js';

export interface GroupGrantInput {
  brands?: readonly string[];
  productLines?: readonly string[];
}

/**
 * Expand brand / product-line grants into the chip ids they authorize.
 * '*' on a dimension matches every chip. Pure (no IO); deduped, catalog order.
 */
export function chipIdsForGroupGrants(grants: GroupGrantInput, catalog: ChipCatalog): string[] {
  const brands = grants.brands ?? [];
  const productLines = grants.productLines ?? [];
  if (brands.length === 0 && productLines.length === 0) {
    return [];
  }
  const brandAll = brands.includes('*');
  const productLineAll = productLines.includes('*');
  const brandSet = new Set(brands);
  const productLineSet = new Set(productLines);
  const matched: string[] = [];
  for (const chip of catalog.chips) {
    const brandHit = brandAll || (chip.brand ? brandSet.has(chip.brand) : false);
    const productLineHit = productLineAll || (chip.productLines ?? []).some((pl) => productLineSet.has(pl));
    if (brandHit || productLineHit) {
      matched.push(chip.id);
    }
  }
  return matched;
}
