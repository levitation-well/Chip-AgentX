import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

function readWebuiFile(name: string) {
  return readFileSync(new URL(`../webui/src/${name}`, import.meta.url), 'utf8');
}

interface SkinManifestEntry {
  id: string;
  name: string;
  mood: string;
  accent: string;
  tokens: Record<string, string>;
}

interface SkinManifest {
  version: number;
  default: string;
  skins: SkinManifestEntry[];
}

const TOKEN_TO_CSS_VARS: Record<string, string[]> = {
  bg: ['--bg'],
  surface: ['--surface'],
  panel: ['--surface-alt', '--surface-elevated'],
  text: ['--text'],
  muted: ['--muted'],
  border: ['--border'],
  accentText: ['--accent-text'],
  subtle: ['--accent-subtle'],
  shadow: ['--skin-shadow-panel'],
  gradient: ['--skin-gradient'],
  radius: ['--skin-radius'],
  display: ['--skin-font-display']
};

const REQUIRED_MANIFEST_TOKENS = Object.keys(TOKEN_TO_CSS_VARS);

function loadManifest(): SkinManifest {
  return JSON.parse(readPublicFile('assets/skins.json')) as SkinManifest;
}

function normalizeCssValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\b0\.(\d)/g, '.$1')
    .replace(/\s+/g, '');
}

function extractCssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) {
    throw new Error(`selector not found in styles.css: ${selector}`);
  }
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return css.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unterminated block for selector: ${selector}`);
}

function parseDeclarations(block: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const statement of block.split(';')) {
    const separator = statement.indexOf(':');
    if (separator === -1) continue;
    const name = statement.slice(0, separator).trim();
    const value = statement.slice(separator + 1).trim();
    if (name.startsWith('--') && value) {
      declarations.set(name, value);
    }
  }
  return declarations;
}

function expectSkinMatchesBlock(skin: SkinManifestEntry, declarations: Map<string, string>, blockLabel: string) {
  for (const [token, cssVars] of Object.entries(TOKEN_TO_CSS_VARS)) {
    const expected = normalizeCssValue(skin.tokens[token] ?? '');
    expect(expected, `${skin.id} manifest token "${token}" must not be empty`).not.toBe('');
    for (const cssVar of cssVars) {
      const actual = declarations.get(cssVar);
      expect(actual, `${blockLabel} must define ${cssVar}`).toBeDefined();
      expect(
        normalizeCssValue(actual!),
        `${blockLabel} ${cssVar} must match skins.json ${skin.id}.tokens.${token}`
      ).toBe(expected);
    }
  }
  const accent = declarations.get('--accent');
  expect(accent, `${blockLabel} must define --accent`).toBeDefined();
  expect(
    normalizeCssValue(accent!),
    `${blockLabel} --accent must match skins.json ${skin.id}.accent`
  ).toBe(normalizeCssValue(skin.accent));
}

describe('skin token single-source contract', () => {
  it('ships a valid skins.json manifest with a default skin', () => {
    const manifest = loadManifest();
    expect(manifest.skins.length).toBeGreaterThan(0);
    const ids = manifest.skins.map((skin) => skin.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(manifest.default);
    for (const skin of manifest.skins) {
      for (const token of REQUIRED_MANIFEST_TOKENS) {
        expect(typeof skin.tokens[token], `${skin.id} missing token ${token}`).toBe('string');
      }
      expect(skin.name.length).toBeGreaterThan(0);
      expect(skin.mood.length).toBeGreaterThan(0);
      expect(skin.accent.length).toBeGreaterThan(0);
    }
  });

  it('keeps every skin manifest entry in sync with its styles.css first-paint block', () => {
    const manifest = loadManifest();
    const css = readPublicFile('styles.css');
    for (const skin of manifest.skins) {
      const block = parseDeclarations(extractCssBlock(css, `html[data-agentx-skin="${skin.id}"]`));
      expectSkinMatchesBlock(skin, block, `first-paint block [data-agentx-skin="${skin.id}"]`);
    }
  });

  it('keeps the default skin manifest entry in sync with the styles.css :root block', () => {
    const manifest = loadManifest();
    const css = readPublicFile('styles.css');
    const fallbackSkin = manifest.skins.find((skin) => skin.id === manifest.default);
    expect(fallbackSkin, 'default skin must exist in the manifest').toBeDefined();
    const rootBlock = parseDeclarations(extractCssBlock(css, ':root {'));
    expectSkinMatchesBlock(fallbackSkin!, rootBlock, ':root block');
  });

  it('keeps the webui built-in fallback palette in sync with skins.json', () => {
    const manifest = loadManifest();
    const mainSource = readWebuiFile('main.tsx');
    for (const skin of manifest.skins) {
      for (const [token, value] of Object.entries(skin.tokens)) {
        expect(
          mainSource,
          `main.tsx fallback palette must contain ${skin.id} token ${token} (${value})`
        ).toContain(`${token}: '${value}'`);
      }
      expect(mainSource).toContain(`skin('${skin.id}', '${skin.name}', '${skin.mood}', '${skin.accent}'`);
    }
  });

  it('loads the manifest at runtime instead of relying only on the built-in palette', () => {
    const mainSource = readWebuiFile('main.tsx');
    expect(mainSource).toContain("'/assets/skins.json'");
    expect(mainSource).toContain('loadSkinManifest');
    expect(mainSource).toContain('console.warn');
  });

  it('routes user-visible skin selector copy through the shared i18n runtime', () => {
    const mainSource = readWebuiFile('main.tsx');
    expect(mainSource).toContain('agentx.skins.enabled');
    expect(mainSource).toContain('agentx.skins.menuLabel');
    expect(mainSource).toContain('agentx.skins.selectorLabel');
    expect(mainSource).toContain('window.AgentXUI?.toast');
    expect(mainSource).not.toContain('皮肤已启用`');
  });

  it('registers the agentx.skins.* key group in both core locales', () => {
    const i18nSource = readPublicFile('i18n.js');
    const keys = [
      'agentx.skins.menuLabel',
      'agentx.skins.selectorLabel',
      'agentx.skins.enabled',
      'agentx.skins.cal.mood',
      'agentx.skins.voltagent.mood'
    ];
    for (const key of keys) {
      const occurrences = i18nSource.split(`'${key}':`).length - 1;
      expect(occurrences, `i18n.js must define ${key} in zh-CN and en-US`).toBe(2);
    }
  });

  it('keeps webui shadows and overlay on host tokens with literal fallbacks', () => {
    const webuiCss = readWebuiFile('styles.css');
    const hardcodedLines = webuiCss
      .split('\n')
      .filter((line) => line.includes('rgb(15 23 42'));
    expect(hardcodedLines.length).toBeGreaterThan(0);
    for (const line of hardcodedLines) {
      expect(line.trim(), `hardcoded slate shadow must be a var() fallback: ${line.trim()}`).toMatch(/^.*var\(--[a-z-]+,.*rgb\(15 23 42.*\).*;$/);
    }
    expect(webuiCss).toContain('var(--shadow-md,');
    expect(webuiCss).toContain('var(--shadow-lg,');
    expect(webuiCss).toContain('var(--shadow-sm,');
    expect(webuiCss).toContain('var(--overlay-scrim,');
  });
});
