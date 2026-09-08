import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function readWebuiFile(name: string) {
  return readFileSync(new URL(`../webui/src/${name}`, import.meta.url), 'utf8');
}

function publicHtmlPages() {
  const publicDir = new URL('../public/', import.meta.url);
  return readdirSync(publicDir)
    .filter((name) => name.endsWith('.html'))
    .sort();
}

const expectedSharedAssetVersions = new Map<string, string>([
  ['/styles.css', '2.2.45'],
  ['/assets/agentx-webui.css', '2.2.43'],
  ['/assets/agentx-webui.js', '2.2.43'],
  ['/ui-kit.js', '2.2.43'],
  ['/product-shell.js', '2.2.42'],
  ['/announcements.js', '2.2.42'],
  ['/i18n.js', '2.2.44'],
  ['/assets/i18n-portal.js', '2.2.44'],
  ['/assets/i18n-mcp-tickets.js', '2.2.45'],
  ['/assets/i18n-chat.js', '2.2.45'],
  ['/assets/i18n-admin.js', '2.2.44'],
  ['/tickets.js', '2.2.43']
]);

const expectedPageAssetVersions = new Map<string, string>([
  ['account.html:/account.js', '2.2.44'],
  ['admin.html:/admin.js', '2.2.44'],
  ['mcp-access.html:/mcp-access.js', '2.2.45'],
  ['updates.html:/updates.js', '2.2.43'],
  ['chat.html:/chat.js', '2.2.44'],
  ['index.html:/assets/agentx-home-bgfx.js', '2.1.1']
]);

const expectedPreservedVersions = new Map<string, string>([
  ['/auth.js', '2.2.42'],
]);

function staticRefs(html: string) {
  return [...html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value.startsWith('/') && /\.(?:css|js)\?v=/.test(value));
}

function splitVersionedRef(ref: string) {
  const [path, query = ''] = ref.split('?', 2);
  const version = new URLSearchParams(query).get('v');
  return { path, version };
}

describe('public static asset versions', () => {
  it('keeps stale shared assets aligned to the current product version', () => {
    for (const [assetPath, expectedVersion] of expectedSharedAssetVersions) {
      const pagesReferencingAsset: string[] = [];

      for (const page of publicHtmlPages()) {
        const refs = staticRefs(readPublicFile(page))
          .map(splitVersionedRef)
          .filter((ref) => ref.path === assetPath);

        if (refs.length > 0) {
          expect(refs, `${page} should reference ${assetPath} once`).toHaveLength(1);
          const expectedForPage = expectedPageAssetVersions.get(`${page}:${assetPath}`) ?? expectedVersion;
          expect(refs[0].version, `${page} -> ${assetPath}`).toBe(expectedForPage);
          pagesReferencingAsset.push(page);
        }
      }

      expect(pagesReferencingAsset.length, `${assetPath} should be used by public pages`).toBeGreaterThan(0);
    }
  });

  it('classifies every versioned public CSS and JS reference', () => {
    for (const page of publicHtmlPages()) {
      const refs = staticRefs(readPublicFile(page)).map(splitVersionedRef);

      for (const ref of refs) {
        const expectedVersion =
          expectedPageAssetVersions.get(`${page}:${ref.path}`) ??
          expectedSharedAssetVersions.get(ref.path) ??
          expectedPreservedVersions.get(ref.path);

        expect(expectedVersion, `${page} -> ${ref.path} should have an asset version contract`).toBeDefined();
        expect(ref.version, `${page} -> ${ref.path}`).toBe(expectedVersion);
      }
    }
  });

  it('keeps the skin selector mounted on every non-admin portal page', () => {
    const portalPages = publicHtmlPages().filter((page) => readPublicFile(page).includes('data-portal-auth'));
    const skinnedPortalPages = portalPages.filter((page) => page !== 'admin.html');

    expect(skinnedPortalPages).toHaveLength(12);
    for (const page of skinnedPortalPages) {
      const html = readPublicFile(page);
      expect(html, page).toContain('data-agentx-skin-root');
      expect(html, page).toContain("let skin='cal'");
      expect(html, page).toContain("const saved=localStorage.getItem('agentx.webui.skin')");
      expect(html, page).toContain("saved==='cal'||saved==='voltagent'");
      expect(html, page).toContain('catch{}');
      expect(html, page).toContain('/assets/agentx-webui.css?v=2.2.43');
      expect(html, page).toContain('/assets/agentx-webui.js?v=2.2.43');
    }

    const admin = readPublicFile('admin.html');
    expect(admin).not.toContain('data-agentx-skin-root');
    expect(admin).not.toContain('/assets/agentx-webui.js');
  });

  it('loads auth before the product shell on every portal auth page', () => {
    const portalPages = publicHtmlPages().filter(
      (page) => readPublicFile(page).includes('data-portal-auth')
    );

    for (const page of portalPages) {
      const html = readPublicFile(page);
      const authIndex = html.indexOf('/auth.js?v=2.2.42');
      const productShellIndex = html.indexOf('/product-shell.js?v=2.2.42');

      expect(authIndex, `${page} should load auth.js`).toBeGreaterThan(-1);
      expect(productShellIndex, `${page} should load product-shell.js`).toBeGreaterThan(-1);
      expect(authIndex, `${page} should load auth.js before product-shell.js`).toBeLessThan(productShellIndex);
    }
  });

  it('loads the bfcache protection shell on every public HTML page', () => {
    for (const page of publicHtmlPages()) {
      expect(readPublicFile(page), page).toContain('/product-shell.js?v=2.2.42');
    }
  });

  it('declares a no-network favicon on every public HTML page', () => {
    for (const page of publicHtmlPages()) {
      expect(readPublicFile(page), page).toContain('<link rel="icon" href="data:,">');
    }
  });

  it('rechecks empty skin mounts on initial load and page restoration', () => {
    const source = readWebuiFile('main.tsx');
    expect(source).toContain("target.querySelector('.agentx-skin-button')");
    expect(source).toContain('function mountAndVerify()');
    expect(source).toContain("window.addEventListener('pageshow', mountAndVerify)");
    expect(source).toContain("window.addEventListener('storage', handleStorage)");
    expect(source).toContain("window.addEventListener('agentx-skin-change', handleSkinChange)");
    expect(source).toContain('readSkinPreference(getBrowserStorage()');
  });
});

describe('mcp-access admin entry dedup', () => {
  it('no longer ships a bespoke admin link because product-shell centralizes it', () => {
    const html = readPublicFile('mcp-access.html');
    const js = readPublicFile('mcp-access.js');

    expect(html).not.toContain('mcp-access-admin-link');
    expect(js).not.toContain('mcp-access-admin-link');
  });
});
