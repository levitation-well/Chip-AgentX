import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('portal capability card + logout (2.1.16)', () => {
  it('renames capability 02 to 资料提交 linking to the submit page', () => {
    const html = readPublicFile('index.html');
    expect(html).toContain('资料提交');
    expect(html).not.toContain('安全设计');
    expect(html).toContain('href="/datasheet-submit"');
  });

  it('centers all user-dropdown items on every page', () => {
    const css = readPublicFile('styles.css');
    const seg = css.slice(
      css.indexOf('.portal-user-dropdown a,'),
      css.indexOf('.portal-user-dropdown a:hover')
    );
    expect(seg).toContain('justify-content: center');
    expect(seg).toContain('text-align: center');
  });
});

describe('portal background continuity + section kicker (2.1.16)', () => {
  it('lets the section kicker sit on a single line', () => {
    const css = readPublicFile('styles.css');
    const seg = css.slice(css.indexOf('.portal-section-kicker'), css.indexOf('.portal-section-kicker') + 220);
    expect(seg).toContain('white-space: nowrap');
    expect(seg).not.toContain('max-width: 62px');
  });

  it('anchors the portal page background to the viewport to remove scroll seams', () => {
    const css = readPublicFile('styles.css');
    const idx = css.indexOf('background-attachment: fixed');
    expect(idx).toBeGreaterThan(-1);
    const ctx = css.slice(Math.max(0, idx - 200), idx);
    expect(ctx).toContain('body.portal-page');
  });
});
