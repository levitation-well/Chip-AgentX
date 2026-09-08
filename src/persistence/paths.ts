import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface PersistencePaths {
  dataDir: string;
  sessionsDir: string;
  sessionIndexFile: string;
  questionsDir: string;
  questionsFile: string;
  logsDir: string;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  const configured = env.AGENTX_DATA_DIR?.trim() || env.DATA_DIR?.trim() || './data';
  return path.resolve(cwd, configured);
}

export function createPersistencePaths(dataDir: string): PersistencePaths {
  const root = path.resolve(dataDir);
  const sessionsDir = path.join(root, 'sessions');
  const questionsDir = path.join(root, 'questions');
  const logsDir = path.join(root, 'logs');

  return {
    dataDir: root,
    sessionsDir,
    sessionIndexFile: path.join(sessionsDir, 'index.json'),
    questionsDir,
    questionsFile: path.join(questionsDir, 'questions.jsonl'),
    logsDir
  };
}

export function assertSafeSessionId(sessionId: string): string {
  if (
    sessionId.length === 0 ||
    sessionId.includes('..') ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId)
  ) {
    throw new Error(`Unsafe session id: ${sessionId}`);
  }

  return sessionId;
}

export function getSessionDir(paths: PersistencePaths, sessionId: string): string {
  return path.join(paths.sessionsDir, assertSafeSessionId(sessionId));
}

export function getSessionFile(paths: PersistencePaths, sessionId: string, fileName: string): string {
  return path.join(getSessionDir(paths, sessionId), fileName);
}

export async function initializeDataLayout(paths: PersistencePaths): Promise<void> {
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.questionsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await writeFileIfMissing(paths.sessionIndexFile, '[]\n');
}

async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
