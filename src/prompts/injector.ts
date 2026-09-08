import type { AuthenticatedRequest } from '../auth/types.js';
import type { PromptCatalog, InjectionPolicy, PromptFragment } from './types.js';
import { loadPromptFile } from './loader.js';
import { composeSystemPrompt } from './composer.js';

export interface InjectionContext {
  userId: string;
  role: string;
  chipId: string;
}

export interface InjectorState {
  firstTurnComplete: boolean;
}

/**
 * Build the system prompt for a session based on role and chip.
 * Loads prompt files and composes three-layer prompt.
 */
export async function buildSessionSystemPrompt(
  catalog: PromptCatalog,
  role: string,
  chipId: string
): Promise<string> {
  let globalContent: string | undefined;
  try {
    const globalPath = `${catalog.baseDir}/${catalog.files.global}`;
    globalContent = await loadPromptFile(globalPath);
  } catch {
    console.warn(`Global prompt not found: ${catalog.files.global}`);
  }

  let roleContent: string | undefined;
  try {
    const rolePath = `${catalog.baseDir}/${catalog.files.roles}/${role}.md`;
    roleContent = await loadPromptFile(rolePath);
  } catch {
    console.warn(`Role prompt not found: ${role}`);
  }

  let chipContent: string | undefined;
  if (chipId) {
    try {
      const chipPath = `${catalog.baseDir}/${catalog.files.chips}/${chipId}.md`;
      chipContent = await loadPromptFile(chipPath);
    } catch {
      // Chip prompts are optional; admins can create missing files from the UI.
    }
  }

  return composeSystemPrompt({
    global: globalContent,
    role: roleContent,
    chip: chipContent,
    roleName: role,
    chipName: chipId
  });
}

/**
 * Create an injection state tracker for a session.
 */
export function createInjectorState(): InjectorState {
  return { firstTurnComplete: false };
}

/**
 * Inject system prompt based on policy.
 * Returns the system prompt if injection should happen, null otherwise.
 *
 * Policy behavior:
 * - first_turn: Inject only on first call (for new sessions)
 * - every_turn: Inject on every call (for every user message)
 * - never: Do not inject and do not mutate turn state
 */
export function injectSystemPrompt(
  state: InjectorState,
  policy: InjectionPolicy,
  systemPrompt: string
): string | null {
  switch (policy) {
    case 'first_turn':
      if (!state.firstTurnComplete) {
        state.firstTurnComplete = true;
        return systemPrompt;
      }
      return null;

    case 'every_turn':
      return systemPrompt;

    case 'never':
      return null;

    default:
      return injectSystemPrompt(state, 'first_turn', systemPrompt);
  }
}

/**
 * Returns whether a governed prompt fragment is eligible for injection.
 */
export function shouldInjectPromptFragment(fragment: Pick<PromptFragment, 'enabled' | 'injectionPolicy'>): boolean {
  return fragment.enabled && fragment.injectionPolicy !== 'never';
}

/**
 * Get injection context from request and catalogs.
 */
export function getInjectionContext(
  request: AuthenticatedRequest,
  chipId: string
): InjectionContext {
  const user = request.user;
  return {
    userId: user?.userId ?? 'anonymous',
    role: user?.role ?? 'customer',
    chipId
  };
}
