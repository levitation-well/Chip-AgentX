import dotenv from 'dotenv';
import { resolveDataDir } from '../persistence/paths.js';
import type { AuthConfig } from './types.js';

let cachedConfig: AuthConfig | undefined;

export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = readRequired(env, 'JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  const adminUser = readRequired(env, 'ADMIN_USER');
  const adminPasswordHash = readRequired(env, 'ADMIN_PASSWORD_HASH');
  if (!isBcryptHash(adminPasswordHash)) {
    throw new Error('ADMIN_PASSWORD_HASH must be a bcrypt hash');
  }

  return {
    jwtSecret,
    jwtExpiresIn: readOptional(env, 'JWT_EXPIRES_IN', '24h'),
    adminUser,
    adminPasswordHash,
    dataDir: resolveDataDir(env)
  };
}

export function getAuthConfig(): AuthConfig {
  if (!cachedConfig) {
    dotenv.config();
    cachedConfig = loadAuthConfig(process.env);
  }

  return cachedConfig;
}

export function resetAuthConfigForTests(): void {
  cachedConfig = undefined;
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }

  return value;
}

function readOptional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? value : fallback;
}

function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(value);
}
