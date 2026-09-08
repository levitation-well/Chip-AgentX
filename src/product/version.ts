const FALLBACK_VERSION = '2.2.45';
declare const __AGENTX_PACKAGE_VERSION__: string | undefined;

export interface ProductVersionSummary {
  version: string;
  build?: {
    commit?: string;
    date?: string;
  };
}

export function getProductVersion(): string {
  const bundledVersion = safePackageVersion(
    typeof __AGENTX_PACKAGE_VERSION__ === 'string' ? __AGENTX_PACKAGE_VERSION__ : undefined
  );
  return bundledVersion ?? FALLBACK_VERSION;
}

export function getProductVersionSummary(env: NodeJS.ProcessEnv = process.env): ProductVersionSummary {
  const build = pickDefined({
    commit: safeBuildValue(env.AGENTX_BUILD_COMMIT),
    date: safeBuildValue(env.AGENTX_BUILD_DATE)
  });
  return Object.keys(build).length > 0
    ? { version: getProductVersion(), build }
    : { version: getProductVersion() };
}

function safeBuildValue(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:@+-]{1,80}$/.test(value) ? value : undefined;
}

function safePackageVersion(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function pickDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
