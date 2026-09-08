import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('admin sidebar unification — styles (2.1.16)', () => {
  it('admin nav adopts the account card look and drops the data-short collapse', () => {
    const css = readPublicFile('styles.css');
    expect(css).toContain('.admin-nav-icon');
    expect(css).toContain('.admin-nav-text');
    expect(css).not.toContain('content: attr(data-short)');
    expect(css).not.toContain('.admin-grid.sidebar-collapsed .admin-section-nav a {\n  width: 42px');
  });

  it('keeps the generic round collapse button rule intact', () => {
    const css = readPublicFile('styles.css');
    expect(css).toContain('width: 28px');
    expect(css).toContain('height: 28px');
    expect(css).toContain('.admin-section-nav > .sidebar-collapse-button');
  });
});

describe('admin sidebar unification — markup (2.1.16)', () => {
  it('renders icon + text slots and a labelled collapse row, no data-short', () => {
    const html = readPublicFile('admin.html');
    expect(html).toContain('class="admin-nav-icon"');
    expect(html).toContain('class="admin-nav-text"');
    expect(html).toContain('class="admin-nav-group"');
    expect(html).toContain('class="admin-nav-group-toggle"');
    expect(html).not.toContain('data-short=');
    const toggle = html.slice(html.indexOf('id="admin-sidebar-toggle"'), html.indexOf('id="section-users"'));
    expect(toggle).toContain('折叠侧栏');
    expect((html.match(/class="admin-nav-icon"/g) || []).length).toBeGreaterThanOrEqual(9);
    expect((html.match(/data-nav-group="/g) || []).length).toBe(5);
    expect(html).not.toContain('id="section-questions"');
    expect(html).toContain('id="history-tab-questions"');
  });

  it('admin.js no longer overwrites the toggle textContent with chevrons', () => {
    const js = readPublicFile('admin.js');
    expect(js).not.toContain("textContent = collapsed ? '›'");
  });
});
