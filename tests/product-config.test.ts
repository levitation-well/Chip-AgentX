import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProductConfig, toProductPublicSummary } from '../src/product/index.js';

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), 'agentx-product-'));
}

describe('product config', () => {
  it('uses safe internal defaults when config file is missing', async () => {
    const cwd = await tempDir();
    const config = await loadProductConfig({ cwd, env: {} });

    expect(config).toMatchObject({
      edition: 'internal',
      landingMode: 'disabled',
      branding: {
        enabled: false,
        productName: 'AgentX',
        signature: 'Powered by AgentX',
        tooltip: 'AgentX'
      },
      fingerprint: { enabled: false, level: 'off' },
      donation: { enabled: false }
    });
  });

  it('merges public config onto public defaults', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'product.json');
    await writeFile(
      configFile,
      JSON.stringify({
        edition: 'public',
        branding: {
          githubUrl: 'https://example.com/repo',
          docsUrl: '/docs'
        },
        donation: {
          alipayQrUrl: '/assets/donation/alipay.example.png',
          wechatQrUrl: 'https://pay.example.com/wechat.png',
          alipayLink: 'http://pay.example.com/alipay',
          wechatLink: '/donation/wechat'
        }
      }),
      'utf8'
    );

    const config = await loadProductConfig({ configFile, env: {} });

    expect(config.edition).toBe('public');
    expect(config.landingMode).toBe('always');
    expect(config.branding.enabled).toBe(true);
    expect(config.branding.homepageUrl).toBe('/home');
    expect(config.branding.githubUrl).toBe('https://example.com/repo');
    expect(config.branding.docsUrl).toBe('/docs');
    expect(config.fingerprint).toMatchObject({
      enabled: true,
      level: 'light',
      owner: 'AgentX',
      deploymentId: 'agentx-public',
      channel: 'web',
      publicKeyId: 'agentx-local'
    });
    expect(config.donation).toEqual({
      enabled: true,
      alipayQrUrl: '/assets/donation/alipay.example.png',
      wechatQrUrl: 'https://pay.example.com/wechat.png',
      alipayLink: 'http://pay.example.com/alipay',
      wechatLink: '/donation/wechat'
    });
  });

  it('accepts UTF-8 BOM product config files', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'product.json');
    await writeFile(configFile, `\uFEFF${JSON.stringify({ edition: 'public' })}`, 'utf8');

    const config = await loadProductConfig({ configFile, env: {} });

    expect(config.edition).toBe('public');
    expect(config.fingerprint.enabled).toBe(true);
  });

  it('fails fast when an explicit product config path is missing', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'missing-product.json');

    await expect(loadProductConfig({ configFile, env: {} })).rejects.toThrow('Failed to load product config');
  });

  it('fails fast when an explicit product config is malformed', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'product.json');
    await writeFile(configFile, '{ "edition": "public",', 'utf8');

    await expect(loadProductConfig({ configFile, env: {} })).rejects.toThrow('Failed to load product config');
  });

  it('accepts only safe non-sensitive fingerprint summary fields', async () => {
    const config = await loadProductConfig({
      env: {
        AGENTX_EDITION: 'public',
        AGENTX_FINGERPRINT_SECRET: 'secret_should_not_leak'
      },
      config: {
        fingerprint: {
          owner: 'AgentX Public',
          deploymentId: 'deployment-01',
          channel: 'web',
          publicKeyId: 'key-01'
        }
      }
    });

    const summaryText = JSON.stringify(toProductPublicSummary(config));

    expect(config.fingerprint.owner).toBe('AgentX Public');
    expect(config.fingerprint.deploymentId).toBe('deployment-01');
    expect(config.fingerprint.channel).toBe('web');
    expect(config.fingerprint.publicKeyId).toBe('key-01');
    expect(summaryText).toContain('AgentX Public');
    expect(summaryText).not.toContain('secret_should_not_leak');
  });

  it('drops unsafe fingerprint fields', async () => {
    const config = await loadProductConfig({
      env: { AGENTX_EDITION: 'public' },
      config: {
        fingerprint: {
          owner: 'sk-secret-token',
          deploymentId: 'D:/private/path',
          channel: 'web?token=hidden',
          publicKeyId: 'abcdefghijklmnopqrstuvwxyz1234567890'
        }
      }
    });

    expect(config.fingerprint.owner).toBe('AgentX');
    expect(config.fingerprint.deploymentId).toBe('agentx-public');
    expect(config.fingerprint.channel).toBe('web');
    expect(config.fingerprint.publicKeyId).toBe('agentx-local');
  });

  it('drops unsafe donation URLs while keeping the edition default', async () => {
    const config = await loadProductConfig({
      config: {
        edition: 'public',
        donation: {
          enabled: true,
          alipayQrUrl: 'file:///C:/private/alipay.png',
          wechatQrUrl: '//evil.example/qr.png',
          alipayLink: 'javascript:alert(1)',
          wechatLink: '/donation/wechat\nsecret'
        }
      }
    });

    expect(config.donation).toEqual({ enabled: true });
  });

  it.each([
    ['file URL', 'file:///C:/private/alipay.png'],
    ['javascript URL', 'javascript:alert(1)'],
    ['data URL', 'data:text/plain,secret'],
    ['protocol-relative URL', '//evil.example/qr.png'],
    ['Windows drive path', 'C:\\private\\alipay.png'],
    ['empty string', ''],
    ['URL with newline', 'https://pay.example.com/\nsecret']
  ])('drops unsafe donation URL variant: %s', async (_label, unsafeUrl) => {
    const config = await loadProductConfig({
      config: {
        edition: 'public',
        donation: {
          enabled: true,
          alipayQrUrl: unsafeUrl
        }
      }
    });

    expect(config.donation).toEqual({ enabled: true });
  });

  it('keeps internal donation disabled and allows explicit public safe links', async () => {
    const internal = await loadProductConfig({ env: {}, config: { edition: 'internal' } });
    const publicConfig = await loadProductConfig({
      env: {},
      config: {
        edition: 'public',
        donation: {
          alipayQrUrl: '/assets/donation/alipay.example.png',
          wechatLink: 'https://pay.example.com/wechat'
        }
      }
    });

    expect(internal.donation).toEqual({ enabled: false });
    expect(publicConfig.donation).toEqual({
      enabled: true,
      alipayQrUrl: '/assets/donation/alipay.example.png',
      wechatLink: 'https://pay.example.com/wechat'
    });
  });

  it('returns only allowlisted public summary fields', async () => {
    const cwd = await tempDir();
    const configFile = path.join(cwd, 'product.json');
    await writeFile(configFile, JSON.stringify({ edition: 'public' }), 'utf8');
    const config = await loadProductConfig({
      env: {
        AGENTX_EDITION: 'public',
        SECRET_TOKEN: 'hidden',
        AGENTX_PRODUCT_CONFIG_FILE: configFile
      }
    });

    const summary = toProductPublicSummary(config);
    const text = JSON.stringify(summary);

    expect(summary.edition).toBe('public');
    expect(summary.landingMode).toBe('always');
    expect(summary.branding.homepageUrl).toBe('/home');
    expect(summary.fingerprint.enabled).toBe(true);
    expect(summary.donation).toEqual({ enabled: true });
    expect(text).not.toContain('SECRET_TOKEN');
    expect(text).not.toContain(configFile);
  });
});
