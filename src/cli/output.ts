import { toCliError, toCliErrorPayload } from './errors.js';
import type { CliJsonError, CliJsonSuccess } from './types.js';

function writeJson(payload: CliJsonSuccess | CliJsonError, stderr = false): void {
  const text = JSON.stringify(payload, null, 2);
  if (stderr) {
    console.error(text);
    return;
  }
  console.log(text);
}

export function outputStructuredJson(data: unknown): void {
  writeJson({ ok: true, data });
}

export function outputLegacyJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function outputLegacyError(message: string, code = 1): never {
  console.error(JSON.stringify({ error: message }, null, 2));
  process.exit(code);
}

export function outputHelpText(text: string): void {
  console.log(text);
}

export function outputCliError(error: unknown, json = false): never {
  const cliError = toCliError(error);
  if (json) {
    const payload: CliJsonError = { ok: false, error: toCliErrorPayload(cliError) };
    writeJson(payload, true);
  } else {
    const payload = toCliErrorPayload(cliError);
    const lines = [`[${payload.code}] ${payload.message}`];
    if (payload.requestId) {
      lines.push(`requestId: ${payload.requestId}`);
    }
    console.error(lines.join('\n'));
  }
  process.exit(cliError.exitCode);
}

export function outputCommandGroupHelp(title: string, lines: string[]): void {
  const body = [title, '', ...lines].join('\n');
  outputHelpText(body);
}
