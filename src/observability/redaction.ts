export interface RedactionResult {
  text: string;
  redacted: string[];
}

type RedactionRule = [RegExp, string, string];

const BASIC_DEBUG_REDACTION_RULES: RedactionRule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_SECRET]', 'secret'],
  [/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED_SECRET]', 'token'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]', 'secret'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_SECRET]', 'secret'],
  [/\b(?:Set-Cookie|Cookie)\s*:\s*[^\r\n]+/gi, 'Cookie: [REDACTED_SECRET]', 'secret'],
  [/([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|jwt|key)=)[^&#\s"']+/gi, '$1[REDACTED_SECRET]', 'secret'],
  [/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|jwt|cookie)\b\s*[:=]\s*["']?[^"'\s,;]+/gi, '[REDACTED_SECRET]', 'secret'],
  [/\b[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_JWT]', 'jwt'],
  [/\\\\[^\\/:\s"'<>]+\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)?/g, '[REDACTED_PATH]', 'path'],
  [/\b[A-Za-z]:[\\/][^\s"'<>]*/g, '[REDACTED_PATH]', 'path'],
  [/\B\/(?:opt|srv|home|Users|root|var\/www|var\/lib|workspace|tmp|mnt|data|app|etc|private)\/[^\s"'<>]*/g, '[REDACTED_PATH]', 'path']
];

const SYSTEM_PROMPT_REDACTION_RULES: RedactionRule[] = [
  [/===\s*(?:AGENTX WORKSPACE|SYSTEM|SYSTEM PROMPT)[\s\S]*?(?=\n\S|\n?$)/gi, '[REDACTED_SYSTEM_PROMPT]', 'system-prompt'],
  [/\b(system prompt|developer message|workspace system context)\b\s*[:=][\s\S]*?(?=\n\S|\n?$)/gi, '[REDACTED_SYSTEM_PROMPT]', 'system-prompt']
];

const REDACTION_RULES: RedactionRule[] = [...BASIC_DEBUG_REDACTION_RULES, ...SYSTEM_PROMPT_REDACTION_RULES];

export function redactDebugText(input: string | undefined): RedactionResult {
  return applyRedactionRules(input, REDACTION_RULES);
}

export function redactSystemPromptForDebugBundle(input: string | undefined): RedactionResult {
  return applyRedactionRules(input, BASIC_DEBUG_REDACTION_RULES);
}

function applyRedactionRules(input: string | undefined, rules: RedactionRule[]): RedactionResult {
  let text = input ?? '';
  const redacted = new Set<string>();

  for (const [pattern, replacement, reason] of rules) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      redacted.add(reason);
      pattern.lastIndex = 0;
      text = text.replace(pattern, replacement);
    }
  }

  return { text, redacted: [...redacted].sort() };
}

export function redactDebugValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactDebugText(value).text as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDebugValue(item)) as T;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      output[key] = isSensitiveKey(key) ? '[REDACTED_SECRET]' : redactDebugValue(nested);
    }
    return output as T;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(authorization|cookie|password|jwt|token|secret|api[_-]?key|mcp[_-]?key)/i.test(key);
}
