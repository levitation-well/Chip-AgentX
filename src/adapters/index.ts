import type { AgentType, ProcessAdapter, SessionMode } from '../types.js';
import { PtyAdapter } from './pty-adapter.js';
import { ChildAdapter, ClaudeCodeConversationAdapter } from './child-adapter.js';

export interface AdapterFactoryOptions {
  sessionMode?: SessionMode;
  claudeSessionId?: string;
  resume?: boolean;
  initialTurnCount?: number;
}

/**
 * Create the appropriate adapter for the given agent type
 */
export function createAdapter(agentType: AgentType, options: AdapterFactoryOptions = {}): ProcessAdapter {
  switch (agentType) {
    case 'claude-code':
      if (options.sessionMode === 'conversation') {
        return new ClaudeCodeConversationAdapter({
          claudeSessionId: options.claudeSessionId,
          resumeFirstTurn: options.resume,
          initialTurnCount: options.initialTurnCount
        });
      }
      return new ChildAdapter();
    case 'codex':
    case 'opencode':
    case 'pi':
      const adapter = new PtyAdapter();
      adapter.setAgentType(agentType);
      return adapter;
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

export { PtyAdapter } from './pty-adapter.js';
export { ChildAdapter, ClaudeCodeConversationAdapter } from './child-adapter.js';
