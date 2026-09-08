import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupOldLogFiles, createAuditLogger, createLogger, LOG_EVENTS } from '../src/logging/index.js';

const tempDirs: string[] = [];
const fixedNow = new Date('2026-05-08T12:34:56.789Z');

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-logger-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('application logger', () => {
  it('writes a single stdout JSONL record', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    const record = logger.info(LOG_EVENTS.serverStarted, 'AgentX server listening', {
      metadata: { host: '127.0.0.1', port: 3000 }
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp: '2026-05-08T12:34:56.789Z',
      level: 'info',
      event: 'server_started',
      message: 'AgentX server listening',
      metadata: { host: '127.0.0.1', port: 3000 }
    });
    expect(record.event).toBe('server_started');
  });

  it('includes correlation fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    logger.warn(LOG_EVENTS.sessionTimeout, 'Session timed out', {
      requestId: 'req-1',
      sessionId: 'session-1',
      userId: 'user-1'
    });

    expect(JSON.parse(lines[0])).toMatchObject({
      requestId: 'req-1',
      sessionId: 'session-1',
      userId: 'user-1'
    });
  });

  it('recursively redacts sensitive metadata keys', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    logger.error(LOG_EVENTS.persistError, 'Persist failed', {
      metadata: {
        Authorization: 'Bearer abc',
        nested: {
          password: 'pw',
          jwtClaim: 'jwt-value',
          mcpKey: 'mcp-value',
          apiKey: 'api-value',
          sharedSecret: 'secret-value',
          headers: [{ Cookie: 'cookie-value' }, { 'set-cookie': 'set-cookie-value' }]
        }
      }
    });

    expect(JSON.parse(lines[0]).metadata).toEqual({
      Authorization: '[REDACTED]',
      nested: {
        password: '[REDACTED]',
        jwtClaim: '[REDACTED]',
        mcpKey: '[REDACTED]',
        apiKey: '[REDACTED]',
        sharedSecret: '[REDACTED]',
        headers: [{ Cookie: '[REDACTED]' }, { 'set-cookie': '[REDACTED]' }]
      }
    });
  });

  it('redacts sensitive key separator variants', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    logger.error(LOG_EVENTS.mcpKeyVerify, 'MCP key verify failed', {
      metadata: {
        api_key: 'api-underscore-value',
        'api-key': 'api-kebab-value',
        'api.key': 'api-dot-value',
        mcp_key: 'mcp-underscore-value',
        'mcp-key': 'mcp-kebab-value',
        mcp$key: 'mcp-symbol-value',
        ordinary: 'api-key appears in ordinary text'
      }
    });

    expect(JSON.parse(lines[0]).metadata).toEqual({
      api_key: '[REDACTED]',
      'api-key': '[REDACTED]',
      'api.key': '[REDACTED]',
      mcp_key: '[REDACTED]',
      'mcp-key': '[REDACTED]',
      mcp$key: '[REDACTED]',
      ordinary: 'api-key appears in ordinary text'
    });
  });

  it('defines remote MCP transport events and redacts MCP key metadata', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    expect(LOG_EVENTS.mcpTransportOpen).toBe('mcp_transport_open');
    expect(LOG_EVENTS.mcpTransportClose).toBe('mcp_transport_close');
    expect(LOG_EVENTS.mcpRequestError).toBe('mcp_request_error');
    expect(LOG_EVENTS.mcpToolCall).toBe('mcp_tool_call');
    expect(LOG_EVENTS.mcpAuthFailure).toBe('mcp_auth_failure');
    expect(LOG_EVENTS.mcpRateLimited).toBe('mcp_rate_limited');
    expect(LOG_EVENTS.mcpTransportExpired).toBe('mcp_transport_expired');

    logger.warn(LOG_EVENTS.mcpRequestError, 'Remote MCP auth failed', {
      metadata: {
        path: '/mcp',
        mcpKey: 'secret-mcp-key',
        Authorization: 'Bearer secret-mcp-key',
        hasAuthorization: true
      }
    });

    expect(JSON.parse(lines[0]).metadata).toEqual({
      path: '/mcp',
      mcpKey: '[REDACTED]',
      Authorization: '[REDACTED]',
      hasAuthorization: true
    });
  });

  it('defines account self-service audit events and redacts sensitive policy metadata', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    expect(LOG_EVENTS.accountProfileUpdate).toBe('account_profile_update');
    expect(LOG_EVENTS.accountPasswordChange).toBe('account_password_change');
    expect(LOG_EVENTS.accountMcpKeyCreate).toBe('account_mcp_key_create');
    expect(LOG_EVENTS.accountMcpKeyUpdate).toBe('account_mcp_key_update');
    expect(LOG_EVENTS.accountMcpKeyRevoke).toBe('account_mcp_key_revoke');
    expect(LOG_EVENTS.accountMcpKeyRegenerate).toBe('account_mcp_key_regenerate');
    expect(LOG_EVENTS.accountLocaleUpdate).toBe('account_locale_update');
    expect(LOG_EVENTS.accountOnboardingUpdate).toBe('account_onboarding_update');
    expect(LOG_EVENTS.adminSelfServicePolicyUpdate).toBe('admin_self_service_policy_update');

    logger.info(LOG_EVENTS.adminSelfServicePolicyUpdate, 'Admin self-service policy updated', {
      metadata: {
        actorUserId: 'admin-user',
        targetUserId: 'customer-user',
        policy: { allowMcpKeySelfCreate: true, maxMcpKeys: 2 },
        key: 'fake-full-mcp-key',
        password: 'fake-password',
        token: 'fake-token'
      }
    });

    expect(JSON.parse(lines[0]).metadata).toEqual({
      actorUserId: 'admin-user',
      targetUserId: 'customer-user',
      policy: { allowMcpKeySelfCreate: true, maxMcpKeys: 2 },
      key: '[REDACTED]',
      password: '[REDACTED]',
      token: '[REDACTED]'
    });
  });

  it('does not mutate metadata objects while redacting', () => {
    const lines: string[] = [];
    const metadata = {
      token: 'token-value',
      nested: {
        apiKey: 'api-key-value'
      }
    };
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    logger.info(LOG_EVENTS.configLoaded, 'Config loaded', { metadata });

    expect(metadata).toEqual({
      token: 'token-value',
      nested: {
        apiKey: 'api-key-value'
      }
    });
    expect(JSON.parse(lines[0]).metadata).toEqual({
      token: '[REDACTED]',
      nested: {
        apiKey: '[REDACTED]'
      }
    });
  });

  it('does not content-redact ordinary text fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    logger.info(LOG_EVENTS.sessionSend, 'Question contains token and password words', {
      metadata: {
        text: 'my token is visible in ordinary text',
        message: 'password appears here as a word',
        task: 'audit authorization behavior',
        question: 'is jwt mentioned?'
      }
    });

    expect(JSON.parse(lines[0]).metadata).toEqual({
      text: 'my token is visible in ordinary text',
      message: 'password appears here as a word',
      task: 'audit authorization behavior',
      question: 'is jwt mentioned?'
    });
  });

  it('writes app and audit file sinks while still writing stdout', async () => {
    const dataDir = await tempDataDir();
    const stdoutLines: string[] = [];
    const options = {
      dataDir,
      fileLogging: true,
      now: () => fixedNow,
      writeStdout: (line: string) => stdoutLines.push(line)
    };

    createLogger(options).info(LOG_EVENTS.dataDirInitialized, 'Data dir ready');
    createAuditLogger(options).log(LOG_EVENTS.loginSuccess, 'User logged in', { userId: 'admin' });

    expect(stdoutLines).toHaveLength(2);
    await expect(readFile(path.join(dataDir, 'logs', 'app-2026-05-08.jsonl'), 'utf8')).resolves.toBe(
      `${stdoutLines[0]}\n`
    );
    await expect(readFile(path.join(dataDir, 'logs', 'audit-2026-05-08.jsonl'), 'utf8')).resolves.toBe(
      `${stdoutLines[1]}\n`
    );
  });

  it('does not clean non-log persistence directories while pruning dated app and audit files under data/logs', async () => {
    const dataDir = await tempDataDir();
    const logsDir = path.join(dataDir, 'logs');
    const sessionsDir = path.join(dataDir, 'sessions');
    const questionsDir = path.join(dataDir, 'questions');
    await mkdir(logsDir, { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(questionsDir, { recursive: true });
    await writeFile(path.join(logsDir, 'app-2026-03-01.jsonl'), 'old app\n', 'utf8');
    await writeFile(path.join(logsDir, 'audit-2026-03-01.jsonl'), 'old audit\n', 'utf8');
    await writeFile(path.join(logsDir, 'other-2026-03-01.jsonl'), 'keep\n', 'utf8');
    await writeFile(path.join(logsDir, 'app-latest.jsonl'), 'keep\n', 'utf8');
    await writeFile(path.join(sessionsDir, 'app-2026-03-01.jsonl'), 'keep\n', 'utf8');
    await writeFile(path.join(questionsDir, 'audit-2026-03-01.jsonl'), 'keep\n', 'utf8');

    cleanupOldLogFiles({ dataDir, now: new Date('2026-05-08T00:00:00.000Z') });

    expect(existsSync(path.join(logsDir, 'app-2026-03-01.jsonl'))).toBe(false);
    expect(existsSync(path.join(logsDir, 'audit-2026-03-01.jsonl'))).toBe(false);
    expect(existsSync(path.join(logsDir, 'other-2026-03-01.jsonl'))).toBe(true);
    expect(existsSync(path.join(logsDir, 'app-latest.jsonl'))).toBe(true);
    expect(existsSync(path.join(sessionsDir, 'app-2026-03-01.jsonl'))).toBe(true);
    expect(existsSync(path.join(questionsDir, 'audit-2026-03-01.jsonl'))).toBe(true);
  });
});

describe('audit logger', () => {
  it('writes audit events as info records', () => {
    const lines: string[] = [];
    const auditLogger = createAuditLogger({ now: () => fixedNow, writeStdout: (line) => lines.push(line) });

    const record = auditLogger.log(LOG_EVENTS.adminUserUpdate, 'Admin user updated', {
      requestId: 'req-2',
      userId: 'admin',
      metadata: { targetUserId: 'user-2' }
    });

    expect(record).toMatchObject({ level: 'info', event: 'admin_user_update' });
    expect(JSON.parse(lines[0])).toMatchObject({
      level: 'info',
      event: 'admin_user_update',
      message: 'Admin user updated',
      requestId: 'req-2',
      userId: 'admin',
      metadata: { targetUserId: 'user-2' }
    });
  });
});
