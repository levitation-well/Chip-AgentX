/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises';
import { outputError, outputJSON } from '../shared.js';
import { verifyFingerprint } from '../../fingerprint/index.js';

interface FingerprintVerifyOptions {
  text?: string;
  file?: string;
}

export function registerFingerprint(cli: any) {
  cli.command('fingerprint <action>', 'Verify AgentX lightweight fingerprint markers')
    .option('--text <text>', 'Text, HTML, or marker payload to verify')
    .option('--file <path>', 'Read text, HTML, or marker payload from an explicit file path')
    .action(async (action: string, options: FingerprintVerifyOptions = {}) => {
      try {
        if (action !== 'verify') {
          outputError(`Unknown fingerprint action: ${action}`);
        }
        const input = await readFingerprintInput(options);
        if (!input.trim()) {
          outputError('No fingerprint input provided');
        }
        outputJSON(verifyFingerprint(input, { secret: process.env.AGENTX_FINGERPRINT_SECRET }));
        process.exit(0);
      } catch (error) {
        outputError(error instanceof Error ? error.message : String(error));
      }
    });
}

async function readFingerprintInput(options: FingerprintVerifyOptions): Promise<string> {
  if (typeof options.text === 'string') {
    return options.text;
  }
  if (typeof options.file === 'string' && options.file.trim()) {
    try {
      return await readFile(options.file, 'utf8');
    } catch {
      throw new Error(`Unable to read fingerprint file: ${options.file}`);
    }
  }
  return readStdin();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
