import type { AgentType } from '../types.js';
import { outputHelpText, outputLegacyError, outputLegacyJson } from './output.js';

/**
 * Valid agent types for CLI validation
 */
export const VALID_AGENT_TYPES: AgentType[] = ['codex', 'opencode', 'pi', 'claude-code'];

/**
 * CLI output helper for structured JSON output
 */
export function outputJSON(data: unknown): void {
  outputLegacyJson(data);
}

/**
 * CLI error helper for error output
 */
export function outputError(message: string, code: number = 1): never {
  outputLegacyError(message, code);
}

/**
 * CLI help output helper - uses console.log instead of console.info so
 * stdout can be captured in tests and pipes on all platforms (Windows PowerShell
 * has encoding issues with console.info when redirected).
 */
export function outputHelp(text: string): void {
  outputHelpText(text);
}

/**
 * Validate agent type from CLI
 */
export function validateAgentType(agent: string): AgentType {
  const normalized = agent.toLowerCase() as AgentType;
  if (!VALID_AGENT_TYPES.includes(normalized)) {
    outputError(`Invalid agent type: ${agent}. Valid types: ${VALID_AGENT_TYPES.join(', ')}`);
  }
  return normalized;
}

/**
 * Resolve working directory with fallback
 */
export function resolveCwd(cwd?: string): string {
  if (cwd) {
    return cwd;
  }
  return process.cwd();
}
