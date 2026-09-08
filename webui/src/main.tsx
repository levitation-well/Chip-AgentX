import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, Palette, Sparkles } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster, toast } from 'sonner';
import { normalizeSkinId, readSkinPreference, writeSkinPreference } from './skin-runtime.js';
import './styles.css';

const STORAGE_KEY = 'agentx.webui.skin';
const DEFAULT_SKIN = 'cal';
const SKINS_MANIFEST_URL = '/assets/skins.json';

interface SkinDefinition {
  id: string;
  name: string;
  mood: string;
  accent: string;
  tokens: Record<string, string>;
}

interface AgentXI18nApi {
  t?: (key: string, params?: Record<string, unknown>) => string;
  getLocale?: () => string;
}

interface AgentXUIApi {
  toast?: (options: { kind?: string; title?: string; detail?: string }) => unknown;
}

declare global {
  interface Window {
    AgentXI18n?: AgentXI18nApi;
    AgentXUI?: AgentXUIApi;
  }
}

// Built-in fallback palette: only used when the skins.json manifest cannot be
// fetched. The single source of truth is public/assets/skins.json; the
// contract test in tests/web-ui-skin-tokens.test.ts keeps this copy, the
// manifest and the public/styles.css skin blocks in sync.
const BUILTIN_SKINS: SkinDefinition[] = [
  skin('cal', 'Cal.com', 'Neutral scheduling OS', '#111827', {
    bg: '#f5f5f4', surface: '#ffffff', panel: 'rgba(255,255,255,.78)', text: '#111827', muted: '#737373', border: '#e5e5e5', accentText: '#ffffff', subtle: '#ededed', shadow: '0 26px 76px rgba(17,24,39,.12)', gradient: 'linear-gradient(135deg, #fafafa, #ffffff 58%, #f2f2f2)', radius: '18px', display: 'Inter, Segoe UI, Microsoft YaHei, sans-serif'
  }),
  skin('voltagent', 'VoltAgent', 'Void green terminal', '#00d47e', {
    bg: '#06110a', surface: '#0a1a10', panel: 'rgba(10,26,16,.82)', text: '#ecfff4', muted: '#89f0b8', border: '#0d6b3c', accentText: '#031008', subtle: '#0d2a19', shadow: '0 24px 80px rgba(0,212,126,.13)', gradient: 'radial-gradient(circle at 15% 0%, rgba(0,212,126,.18), transparent 32%), #06110a', radius: '14px', display: 'JetBrains Mono, Cascadia Code, monospace'
  })
];

function skin(id: string, name: string, mood: string, accent: string, tokens: Record<string, string>): SkinDefinition {
  return { id, name, mood, accent, tokens };
}

const REQUIRED_TOKENS = ['bg', 'surface', 'panel', 'text', 'muted', 'border', 'accentText', 'subtle', 'shadow', 'gradient', 'radius', 'display'] as const;

let activeSkins: SkinDefinition[] = BUILTIN_SKINS;
const skinListeners = new Set<(skins: SkinDefinition[]) => void>();

function getSkins(): SkinDefinition[] {
  return activeSkins;
}

function subscribeSkins(listener: (skins: SkinDefinition[]) => void): () => void {
  skinListeners.add(listener);
  return () => skinListeners.delete(listener);
}

function isValidSkin(candidate: unknown): candidate is SkinDefinition {
  if (!candidate || typeof candidate !== 'object') return false;
  const value = candidate as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.name !== 'string') return false;
  if (typeof value.mood !== 'string' || typeof value.accent !== 'string') return false;
  const tokens = value.tokens as Record<string, unknown> | undefined;
  if (!tokens || typeof tokens !== 'object') return false;
  return REQUIRED_TOKENS.every((key) => typeof tokens[key] === 'string' && (tokens[key] as string).length > 0);
}

async function loadSkinManifest(): Promise<void> {
  try {
    const response = await fetch(SKINS_MANIFEST_URL, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const manifest = (await response.json()) as { skins?: unknown };
    const list = Array.isArray(manifest?.skins) ? manifest.skins : null;
    if (!list || list.length === 0 || !list.every(isValidSkin)) {
      throw new Error('invalid skins manifest');
    }
    activeSkins = list;
    for (const listener of skinListeners) {
      listener(activeSkins);
    }
    applySkin(getInitialSkin());
  } catch (error) {
    console.warn('[agentx-webui] Unable to load /assets/skins.json; falling back to built-in skin defaults.', error);
  }
}

function translate(key: string, fallback: string, params?: Record<string, unknown>): string {
  try {
    const value = window.AgentXI18n?.t?.(key, params);
    return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback;
  } catch {
    return fallback;
  }
}

function showSkinToast(title: string): void {
  const sharedToast = window.AgentXUI?.toast;
  if (typeof sharedToast === 'function') {
    sharedToast({ kind: 'success', title });
    return;
  }
  toast.success(title);
}

function getBrowserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function getInitialSkin(): string {
  return readSkinPreference(getBrowserStorage(), STORAGE_KEY, getSkins().map((candidate) => candidate.id), DEFAULT_SKIN);
}

function applySkin(id: string): void {
  const available = getSkins();
  const normalized = normalizeSkinId(id, available.map((candidate) => candidate.id), DEFAULT_SKIN);
  const selected = available.find((candidate) => candidate.id === normalized) ?? available[0]!;
  const root = document.documentElement;
  root.dataset.agentxSkin = selected.id;
  root.style.setProperty('--agentx-skin-name', `"${selected.name}"`);
  root.style.setProperty('--bg', selected.tokens.bg);
  root.style.setProperty('--surface', selected.tokens.surface);
  root.style.setProperty('--surface-alt', selected.tokens.panel);
  root.style.setProperty('--surface-elevated', selected.tokens.panel);
  root.style.setProperty('--text', selected.tokens.text);
  root.style.setProperty('--muted', selected.tokens.muted);
  root.style.setProperty('--border', selected.tokens.border);
  root.style.setProperty('--accent', selected.accent);
  root.style.setProperty('--accent-text', selected.tokens.accentText);
  root.style.setProperty('--accent-subtle', selected.tokens.subtle);
  root.style.setProperty('--primary', selected.accent);
  root.style.setProperty('--primary-subtle', selected.tokens.subtle);
  root.style.setProperty('--border-color', selected.tokens.border);
  root.style.setProperty('--text-primary', selected.tokens.text);
  root.style.setProperty('--text-secondary', selected.tokens.muted);
  root.style.setProperty('--skin-shadow-panel', selected.tokens.shadow);
  root.style.setProperty('--skin-gradient', selected.tokens.gradient);
  root.style.setProperty('--skin-radius', selected.tokens.radius);
  root.style.setProperty('--skin-font-display', selected.tokens.display);
}

function SkinApp() {
  const [skinList, setSkinList] = useState<SkinDefinition[]>(getSkins);
  const [active, setActive] = useState(getInitialSkin);
  const [, setLocaleVersion] = useState(0);
  const selected = skinList.find((candidate) => candidate.id === active) ?? skinList[0]!;

  useEffect(() => subscribeSkins(setSkinList), []);

  useEffect(() => {
    const handleLocaleChange = () => setLocaleVersion((version) => version + 1);
    window.addEventListener('localechange', handleLocaleChange);
    return () => window.removeEventListener('localechange', handleLocaleChange);
  }, []);

  useEffect(() => {
    applySkin(active);
    writeSkinPreference(getBrowserStorage(), STORAGE_KEY, active);
    window.dispatchEvent(new CustomEvent('agentx-skin-change', { detail: { skin: active } }));
  }, [active]);

  useEffect(() => {
    const sync = (value: unknown) => {
      const next = normalizeSkinId(value, getSkins().map((candidate) => candidate.id), DEFAULT_SKIN);
      setActive((current) => current === next ? current : next);
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) {
        sync(event.key === STORAGE_KEY ? event.newValue : getInitialSkin());
      }
    };
    const handleSkinChange = (event: Event) => {
      sync((event as CustomEvent<{ skin?: string }>).detail?.skin);
    };
    const handlePageShow = () => sync(getInitialSkin());
    window.addEventListener('storage', handleStorage);
    window.addEventListener('agentx-skin-change', handleSkinChange);
    window.addEventListener('pageshow', handlePageShow);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('agentx-skin-change', handleSkinChange);
      window.removeEventListener('pageshow', handlePageShow);
    };
  }, []);

  const choose = (id: string) => {
    setActive(id);
    const chosen = skinList.find((item) => item.id === id);
    const name = chosen?.name ?? id;
    showSkinToast(translate('agentx.skins.enabled', `${name} skin enabled`, { name }));
  };

  return (
    <>
      <div className="agentx-skin-control" aria-label={translate('agentx.skins.selectorLabel', 'AgentX skin selector')}>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="agentx-skin-button">
            <Palette size={16} />
            <span>{selected.name}</span>
            <ChevronDown size={14} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="agentx-skin-menu" align="end" sideOffset={10}>
              <DropdownMenu.Label className="agentx-skin-menu-label">
                <Sparkles size={14} /> {translate('agentx.skins.menuLabel', 'AgentX WebUI Skins')}
              </DropdownMenu.Label>
              {skinList.map((item) => (
                <DropdownMenu.Item
                  key={item.id}
                  className="agentx-skin-item"
                  onSelect={() => choose(item.id)}
                >
                  <span className="agentx-skin-swatch" style={{ background: item.accent }} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{translate(`agentx.skins.${item.id}.mood`, item.mood)}</small>
                  </span>
                  {item.id === active ? <Check size={14} /> : null}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <Toaster richColors position="bottom-right" />
    </>
  );
}

const mountedRoots = new WeakMap<HTMLElement, Root>();

function mountTarget(target: HTMLElement): void {
  if (target.querySelector('.agentx-skin-button')) {
    target.dataset.agentxMounted = 'true';
    return;
  }
  try {
    const root = mountedRoots.get(target) ?? createRoot(target);
    mountedRoots.set(target, root);
    root.render(<SkinApp />);
    target.dataset.agentxMounted = 'true';
  } catch {
    mountedRoots.delete(target);
    delete target.dataset.agentxMounted;
  }
}

function mount(): void {
  applySkin(getInitialSkin());
  document.querySelectorAll<HTMLElement>('[data-agentx-skin-root]').forEach((target) => {
    if (target.dataset.agentxMounted === 'true' && target.querySelector('.agentx-skin-button')) {
      return;
    }
    mountTarget(target);
  });
}

function mountAndVerify(): void {
  mount();
  window.requestAnimationFrame(() => {
    document.querySelectorAll<HTMLElement>('[data-agentx-skin-root]').forEach((target) => {
      if (!target.querySelector('.agentx-skin-button')) {
        delete target.dataset.agentxMounted;
        mountTarget(target);
      }
    });
  });
}

void loadSkinManifest();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountAndVerify, { once: true });
} else {
  mountAndVerify();
}
window.addEventListener('pageshow', mountAndVerify);
