import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

function readPublicFile(name: string) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('ui-kit styles (2.1.15)', () => {
  it('defines the --success token in :root', () => {
    const css = readPublicFile('styles.css');
    const rootBlock = css.slice(0, css.indexOf('}'));
    expect(rootBlock).toContain('--success:');
  });

  it('ships toast / modal / chip component rules driven by tokens', () => {
    const css = readPublicFile('styles.css');
    for (const cls of [
      '.agentx-toast-host',
      '.agentx-toast',
      '.agentx-modal-backdrop',
      '.agentx-modal',
      '.agentx-chip-field',
      '.agentx-chip',
      '.agentx-chip-suggest'
    ]) {
      expect(css).toContain(cls);
    }
    const uiKitSection = css.slice(css.indexOf('.agentx-toast-host'));
    expect(uiKitSection).toContain('var(--success)');
    expect(uiKitSection).toContain('var(--danger)');
    expect(uiKitSection).toContain('var(--surface)');
  });

  it('ships account + admin layout rules', () => {
    const css = readPublicFile('styles.css');
    for (const cls of [
      '.account-pagehead',
      '.account-form-group-title',
      '.account-ledger-table',
      '.ledger-status',
      '.user-toolbar',
      '.user-filter-bar',
      '.user-table',
      '.admin-user-tabs',
      '.admin-user-tabpanel'
    ]) {
      expect(css).toContain(cls);
    }
  });
});

function loadUiKitDom() {
  const source = readPublicFile('ui-kit.js');
  const dom = new JSDOM('<!doctype html><html><body><input id="grants" value="a, b"></body></html>', {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/'
  });
  dom.window.eval(source);
  return dom;
}

describe('ui-kit behaviour (2.1.15)', () => {
  it('toast appends a card with kind class into an aria-live host', () => {
    const dom = loadUiKitDom();
    const { window } = dom;
    window.AgentXUI.toast({ kind: 'success', title: '已保存', detail: 'Profile 已更新' });
    const host = window.document.querySelector('.agentx-toast-host');
    expect(host).not.toBeNull();
    expect(host!.getAttribute('aria-live')).toBe('polite');
    const card = window.document.querySelector('.agentx-toast.agentx-toast-success');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('已保存');
  });

  it('confirm resolves true on confirm click and false on Escape', async () => {
    const dom = loadUiKitDom();
    const { window } = dom;
    const p1 = window.AgentXUI.confirm({ title: '删除', body: '确认？', danger: true });
    const confirmBtn = window.document.querySelector('.agentx-modal-actions .danger-button') as HTMLButtonElement;
    expect(confirmBtn).not.toBeNull();
    confirmBtn.click();
    await expect(p1).resolves.toBe(true);
    expect(window.document.querySelector('.agentx-modal-backdrop')).toBeNull();

    const p2 = window.AgentXUI.confirm({ title: '再次', body: '确认？' });
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(p2).resolves.toBe(false);
  });

  it('prompt resolves the entered value, or null on cancel', async () => {
    const dom = loadUiKitDom();
    const { window } = dom;
    const p = window.AgentXUI.prompt({ title: '重命名', label: '名称', value: 'old' });
    const input = window.document.querySelector('.agentx-modal input') as HTMLInputElement;
    input.value = 'new-name';
    (window.document.querySelector('.agentx-modal-actions .primary-button') as HTMLButtonElement).click();
    await expect(p).resolves.toBe('new-name');

    const p2 = window.AgentXUI.prompt({ title: '重命名', label: '名称' });
    (window.document.querySelector('.agentx-modal-actions .secondary-button') as HTMLButtonElement).click();
    await expect(p2).resolves.toBeNull();
  });

  it('chipInput renders existing values, adds and removes chips, keeps hidden input in sync', () => {
    const dom = loadUiKitDom();
    const { window } = dom;
    const input = window.document.getElementById('grants') as HTMLInputElement;
    const instance = window.AgentXUI.chipInput(input, { suggestions: () => ['alpha', 'beta'] });
    expect(input.type).toBe('hidden');
    let chips = Array.from(window.document.querySelectorAll('.agentx-chip')).map((c) => c.textContent?.replace('×', '').trim());
    expect(chips).toEqual(['a', 'b']);

    const editor = window.document.querySelector('.agentx-chip-field input[type="text"]') as HTMLInputElement;
    editor.value = 'c';
    editor.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(input.value).toBe('a, b, c');

    (window.document.querySelector('.agentx-chip button') as HTMLButtonElement).click();
    expect(input.value).toBe('b, c');

    input.value = 'x, y';
    instance.sync();
    chips = Array.from(window.document.querySelectorAll('.agentx-chip')).map((c) => c.textContent?.replace('×', '').trim());
    expect(chips).toEqual(['x', 'y']);
  });
});

describe('chip restyle (2.1.16)', () => {
  it('uses the rounded-rect token-driven chip with red hover ×', () => {
    const css = readPublicFile('styles.css');
    const chip = css.slice(css.indexOf('.agentx-chip {'));
    expect(chip).toContain('border-radius: var(--radius-sm)');
    expect(chip).toContain('color-mix(in srgb, var(--accent)');
    const btn = css.slice(css.indexOf('.agentx-chip button:hover'));
    expect(btn).toContain('var(--danger)');
  });

  it('gives the chip remove button a keyboard focus indicator', () => {
    const css = readPublicFile('styles.css');
    expect(css).toContain('.agentx-chip button:focus-visible');
    const focus = css.slice(css.indexOf('.agentx-chip button:focus-visible'));
    expect(focus.slice(0, 140)).toContain('var(--accent)');
  });
});
