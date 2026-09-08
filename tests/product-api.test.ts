import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpServer } from '../src/http-server.js';

async function startServer(options: Parameters<typeof createHttpServer>[0] = {}) {
  const server = createHttpServer({ auth: { enabled: false }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-product-api-'));
}

describe('product API', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    server = undefined;
  });

  it('returns a safe product version summary', async () => {
    const started = await startServer({
      product: {
        config: {
          edition: 'public',
          landingMode: 'always',
          branding: { enabled: true, productName: 'AgentX', signature: 'Powered by AgentX' }
        }
      }
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/api/version`);
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      version: '2.2.45',
      edition: 'public',
      landingMode: 'always',
      branding: { enabled: true, productName: 'AgentX' }
    });
    expect(body.branding.homepageUrl).toBe('/home');
    expect(body.donation).toEqual({ enabled: true });
    expect(text).not.toContain('jwtSecret');
    expect(text).not.toContain('process.env');
    expect(text).not.toContain('dataDir');
  });

  it('keeps API version anchored to AgentX when launched from a host project cwd', async () => {
    const originalCwd = process.cwd();
    const hostProject = await tempDir();
    await writeFile(path.join(hostProject, 'package.json'), JSON.stringify({ version: '9.9.9-host' }), 'utf8');

    try {
      process.chdir(hostProject);
      const started = await startServer({
        product: {
          config: {
            edition: 'public',
            landingMode: 'always'
          }
        }
      });
      server = started.server;

      const response = await fetch(`${started.baseUrl}/api/version`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.version).toBe('2.2.45');
      expect(body.version).not.toBe('9.9.9-host');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('keeps API changelog anchored to AgentX when launched from a host project cwd', async () => {
    const originalCwd = process.cwd();
    const hostProject = await tempDir();
    await writeFile(path.join(hostProject, 'CHANGELOG.md'), [
      '# Host Changelog',
      '',
      '## 9.9.9-host - 2026-05-15',
      '',
      '- Host project entry'
    ].join('\n'), 'utf8');

    try {
      process.chdir(hostProject);
      const started = await startServer();
      server = started.server;

      const response = await fetch(`${started.baseUrl}/api/changelog`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.available).toBe(true);
      expect(body.entries[0].version).toBe('2.2.45');
      expect(body.entries[0].version).not.toBe('9.9.9-host');
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('returns signed public fingerprint summary without leaking the secret', async () => {
    process.env.AGENTX_FINGERPRINT_SECRET = 'public-api-test-secret';
    const started = await startServer({
      product: { config: { edition: 'public', landingMode: 'always' } }
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/api/version`);
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.fingerprint).toMatchObject({
      enabled: true,
      level: 'light',
      owner: 'AgentX',
      deploymentId: 'agentx-public',
      channel: 'web',
      signed: true
    });
    expect(body.fingerprint.marker).toContain('agentx-fp:v1.');
    expect(text).not.toContain('public-api-test-secret');
    delete process.env.AGENTX_FINGERPRINT_SECRET;
  });

  it('soft-fails fingerprint signing when the secret is missing', async () => {
    delete process.env.AGENTX_FINGERPRINT_SECRET;
    const started = await startServer({
      product: { config: { edition: 'public', landingMode: 'always' } }
    });
    server = started.server;

    const body = await (await fetch(`${started.baseUrl}/api/version`)).json();

    expect(body.fingerprint).toMatchObject({ enabled: true, signed: false });
    expect(body.fingerprint.marker).toBeUndefined();
  });

  it('does not return a fingerprint marker for internal mode', async () => {
    process.env.AGENTX_FINGERPRINT_SECRET = 'internal-api-test-secret';
    const started = await startServer({
      product: { config: { edition: 'internal', landingMode: 'disabled' } }
    });
    server = started.server;

    const body = await (await fetch(`${started.baseUrl}/api/version`)).json();

    expect(body.fingerprint).toMatchObject({ enabled: false, level: 'off', signed: false });
    expect(body.fingerprint.marker).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('internal-api-test-secret');
    delete process.env.AGENTX_FINGERPRINT_SECRET;
  });

  it('keeps web conversation messages free of visible fingerprint markers', async () => {
    process.env.AGENTX_FINGERPRINT_SECRET = 'chat-api-test-secret';
    const assistantText =
      '这是一段面向用户的自然语言回答，内容足够长，用来解释当前会话已经完成的诊断、修改和验证步骤。它不会包含命令、路径、代码块或 JSON，因此可以安全附加轻量来源标记，供后续验证工具确认内容来自当前 AgentX 部署。';
    const manager = new EventEmitter() as EventEmitter & Record<string, any>;
    manager.list = () => [{ id: 'session-chat', task: '请总结当前进展', status: 'exited' }];
    manager.log = () => ({
      output: assistantText,
      truncated: false,
      totalChars: assistantText.length,
      offset: 0,
      limit: assistantText.length
    });
    manager.tail = manager.log;

    const started = await startServer({
      manager: manager as any,
      product: { config: { edition: 'public', landingMode: 'always' } }
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/sessions/session-chat/log`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].text).toBe(assistantText);
    expect(JSON.stringify(body.messages)).not.toContain('agentx-fp:v1.');
    expect(manager.log().output).not.toContain('agentx-fp:v1.');
    delete process.env.AGENTX_FINGERPRINT_SECRET;
  });

  it('returns changelog payload and soft-failure payloads', async () => {
    const started = await startServer();
    server = started.server;

    const response = await fetch(`${started.baseUrl}/api/changelog`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.entries[0].version).toBe('2.2.45');
  });

  it('serves a public landing page for public mode and redirects disabled landing to login', async () => {
    const publicStarted = await startServer({
      product: { config: { edition: 'public', landingMode: 'always' } }
    });
    server = publicStarted.server;

    const publicResponse = await fetch(`${publicStarted.baseUrl}/`, { redirect: 'manual' });
    const publicHomeResponse = await fetch(`${publicStarted.baseUrl}/home`);
    const publicHomeHtmlResponse = await fetch(`${publicStarted.baseUrl}/home.html`);
    expect(publicResponse.status).toBe(302);
    expect(publicResponse.headers.get('location')).toBe('/home');
    expect(publicHomeResponse.status).toBe(200);
    expect(await publicHomeResponse.text()).toContain('data-agentx-skin-root');
    expect(publicHomeHtmlResponse.status).toBe(200);

    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    server = undefined;

    const disabledStarted = await startServer({
      product: { config: { edition: 'internal', landingMode: 'disabled' } }
    });
    server = disabledStarted.server;

    const disabledResponse = await fetch(`${disabledStarted.baseUrl}/`, { redirect: 'manual' });
    const disabledHomeResponse = await fetch(`${disabledStarted.baseUrl}/home`, { redirect: 'manual' });
    expect(disabledResponse.status).toBe(302);
    expect(disabledResponse.headers.get('location')).toBe('/home');
    expect(disabledHomeResponse.status).toBe(302);
    expect(disabledHomeResponse.headers.get('location')).toBe('/login');
  });

  it('accepts product config files without leaking the file path', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'product.json');
    await writeFile(configFile, JSON.stringify({ edition: 'public' }), 'utf8');
    const started = await startServer({ product: { configFile } });
    server = started.server;

    const body = await (await fetch(`${started.baseUrl}/api/version`)).json();

    expect(body.edition).toBe('public');
    expect(JSON.stringify(body)).not.toContain(configFile);
  });

  it('returns only safe donation summary fields from /api/version', async () => {
    const started = await startServer({
      product: {
        config: {
          edition: 'public',
          donation: {
            alipayQrUrl: '/assets/donation/alipay.example.png',
            wechatQrUrl: 'https://pay.example.com/wechat.png',
            alipayLink: 'file:///C:/secret/alipay.png',
            wechatLink: 'data:text/plain,secret'
          }
        }
      }
    });
    server = started.server;

    const response = await fetch(`${started.baseUrl}/api/version`);
    const body = await response.json();
    const text = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.donation).toEqual({
      enabled: true,
      alipayQrUrl: '/assets/donation/alipay.example.png',
      wechatQrUrl: 'https://pay.example.com/wechat.png'
    });
    expect(text).not.toContain('file:///');
    expect(text).not.toContain('C:/secret');
    expect(text).not.toContain('data:text');
    expect(text).not.toContain('AGENTX_PRODUCT_CONFIG_FILE');
  });
});
