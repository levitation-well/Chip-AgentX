export interface SkinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function normalizeSkinId(value: unknown, allowedIds: readonly string[], fallback: string): string {
  return typeof value === 'string' && allowedIds.includes(value) ? value : fallback;
}

export function readSkinPreference(
  storage: SkinStorage | undefined,
  key: string,
  allowedIds: readonly string[],
  fallback: string
): string {
  try {
    return normalizeSkinId(storage?.getItem(key), allowedIds, fallback);
  } catch {
    return fallback;
  }
}

export function writeSkinPreference(storage: SkinStorage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
