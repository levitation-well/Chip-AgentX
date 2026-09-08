import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInjectorState, injectSystemPrompt, shouldInjectPromptFragment } from '../../src/prompts/injector.js';

describe('createInjectorState', () => {
  it('creates state with firstTurnComplete false', () => {
    const state = createInjectorState();
    expect(state.firstTurnComplete).toBe(false);
  });
});

describe('injectSystemPrompt', () => {
  let state: ReturnType<typeof createInjectorState>;

  beforeEach(() => {
    state = createInjectorState();
  });

  it('returns prompt on first call for first_turn policy', () => {
    const result = injectSystemPrompt(state, 'first_turn', 'system prompt content');
    expect(result).toBe('system prompt content');
  });

  it('returns null after first call for first_turn policy', () => {
    injectSystemPrompt(state, 'first_turn', 'system prompt content');
    const result = injectSystemPrompt(state, 'first_turn', 'system prompt content');
    expect(result).toBeNull();
  });

  it('returns prompt on every call for every_turn policy', () => {
    const result1 = injectSystemPrompt(state, 'every_turn', 'system prompt content');
    const result2 = injectSystemPrompt(state, 'every_turn', 'system prompt content');
    const result3 = injectSystemPrompt(state, 'every_turn', 'system prompt content');
    expect(result1).toBe('system prompt content');
    expect(result2).toBe('system prompt content');
    expect(result3).toBe('system prompt content');
  });

  it('mutates state after first_turn injection', () => {
    expect(state.firstTurnComplete).toBe(false);
    injectSystemPrompt(state, 'first_turn', 'prompt');
    expect(state.firstTurnComplete).toBe(true);
  });

  it('does not mutate state for every_turn policy', () => {
    injectSystemPrompt(state, 'every_turn', 'prompt');
    expect(state.firstTurnComplete).toBe(false);
  });

  it('returns null and does not mutate state for never policy', () => {
    const result = injectSystemPrompt(state, 'never', 'prompt');
    expect(result).toBeNull();
    expect(state.firstTurnComplete).toBe(false);
  });

  it('defaults to first_turn for unknown policy', () => {
    const result1 = injectSystemPrompt(state, 'first_turn', 'prompt');
    const result2 = injectSystemPrompt(state, 'first_turn', 'prompt');
    expect(result1).toBe('prompt');
    expect(result2).toBeNull();
  });
});

describe('shouldInjectPromptFragment', () => {
  it('returns true only for enabled fragments that are not never', () => {
    expect(shouldInjectPromptFragment({ enabled: true, injectionPolicy: 'first_turn' })).toBe(true);
    expect(shouldInjectPromptFragment({ enabled: true, injectionPolicy: 'every_turn' })).toBe(true);
    expect(shouldInjectPromptFragment({ enabled: true, injectionPolicy: 'never' })).toBe(false);
    expect(shouldInjectPromptFragment({ enabled: false, injectionPolicy: 'first_turn' })).toBe(false);
  });
});
