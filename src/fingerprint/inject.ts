import { extractFingerprintMarkers } from './payload.js';

export interface MaybeInjectFingerprintOptions {
  marker?: string;
  minLength?: number;
}

export function maybeInjectFingerprint(text: string, options: MaybeInjectFingerprintOptions = {}): string {
  try {
    const marker = options.marker;
    if (!marker || extractFingerprintMarkers(text).includes(marker)) {
      return text;
    }
    if (!looksLikeNaturalLanguage(text, options.minLength ?? 80)) {
      return text;
    }
    return `${text.trimEnd()}\n\n[${marker}]`;
  } catch {
    return text;
  }
}

export function looksLikeNaturalLanguage(text: string, minLength = 80): boolean {
  const value = String(text || '').trim();
  if (value.length < minLength) {
    return false;
  }
  if (value.includes('```') || value.includes('<tool_call>') || value.includes('<｜｜DSML｜｜tool_calls>')) {
    return false;
  }
  if (isJsonLike(value) || isMostlyMachineLines(value) || hasPathOrCommand(value) || hasLongIdentifier(value)) {
    return false;
  }
  return /[。！？.!?]\s|[。！？.!?]$/.test(value) || /[\u4e00-\u9fff]/.test(value);
}

function isJsonLike(value: string): boolean {
  if (!/^[\[{]/.test(value)) {
    return false;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isMostlyMachineLines(value: string): boolean {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return true;
  }
  const machineLines = lines.filter((line) => {
    return (
      /^[A-Z0-9_][A-Z0-9_.-]{1,40}=/.test(line) ||
      /^[\w.-]+:\s*\S/.test(line) ||
      /^\|.*\|$/.test(line) ||
      /^\[[^\]]+\]\s/.test(line) ||
      /^(INFO|WARN|ERROR|DEBUG|TRACE)\b/.test(line)
    );
  });
  return machineLines.length / lines.length >= 0.6;
}

function hasPathOrCommand(value: string): boolean {
  return (
    /(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|var|etc|tmp|opt|usr|mnt)\/)/.test(value) ||
    /(?:^|\n)\s*(?:git|npm|pnpm|node|python|pip|docker|kubectl|curl|cmd|powershell|\.\\|\/bin\/)\b/.test(value)
  );
}

function hasLongIdentifier(value: string): boolean {
  return (
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(value) ||
    /\b[A-Za-z0-9_-]{48,}\b/.test(value)
  );
}
