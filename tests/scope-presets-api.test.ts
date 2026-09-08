/**
 * TDD 测试：GET /api/scope-presets
 * 列出当前用户可见且 approved 的 scope preset（供前端范围选择器用）。
 */
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  startMcpHttpTestServer
} from './mcp-http-test-helpers.js';

// ──────────────────────────────────────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────────────────────────────────────

async function loginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`Login failed for ${username}: ${JSON.stringify(body)}`);
  return body.token;
}

async function readJson(res: Response): Promise<unknown> {
  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────────
// resources 配置：两个 preset
//   A: approved + 用户有 scopePresetId 授权 → 应出现
//   B: pending（未 approved）              → 不应出现
//   C: approved 但用户没有授权             → 不应出现
// ──────────────────────────────────────────────────────────────────────────────

const TEST_RESOURCES = {
  enabled: true,
  catalog: {
    documents: [],
    scopePresets: [
      {
        scopePresetId: 'preset-alpha',
        label: 'Alpha Scope',
        visibility: 'customer',
        status: 'approved',
        brands: ['ELMOS'],
        productLines: ['Lighting'],
        applicationTags: ['Automotive'],
        chipIds: ['E521.39'],
        documentIds: [],
        requiredGrants: {
          scopePresetIds: ['preset-alpha']
        },
        sourceLabels: ['alpha source label']
      },
      {
        scopePresetId: 'preset-beta',
        label: 'Beta Scope',
        visibility: 'customer',
        status: 'pending', // 未 approved → 不应出现
        brands: ['BETA'],
        productLines: ['Beta Line'],
        applicationTags: [],
        chipIds: [],
        documentIds: [],
        requiredGrants: {
          scopePresetIds: ['preset-beta']
        },
        sourceLabels: []
      },
      {
        scopePresetId: 'preset-gamma',
        label: 'Gamma Scope',
        visibility: 'customer',
        status: 'approved', // approved 但用户没有授权 → 不应出现
        brands: ['GAMMA'],
        productLines: [],
        applicationTags: [],
        chipIds: [],
        documentIds: [],
        requiredGrants: {
          scopePresetIds: ['preset-gamma']
        },
        sourceLabels: []
      }
    ]
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// 测试套件
// ──────────────────────────────────────────────────────────────────────────────

describe('GET /api/scope-presets', () => {
  let server: Server | undefined;
  let dataDir: string | undefined;

  afterEach(async () => {
    await closeMcpHttpTestServer(server, dataDir);
    server = undefined;
    dataDir = undefined;
  });

  it('未认证请求返回 401', async () => {
    const started = await startMcpHttpTestServer({ resources: TEST_RESOURCES });
    server = started.server;
    dataDir = started.dataDir;

    const res = await fetch(`${started.baseUrl}/api/scope-presets`);
    expect(res.status).toBe(401);
  });

  it('授权用户只看到 approved 且自己有权限的 preset，返回安全 DTO', async () => {
    const started = await startMcpHttpTestServer({ resources: TEST_RESOURCES });
    server = started.server;
    dataDir = started.dataDir;

    // 给 alice 授权：只有 preset-alpha 的访问权限
    await started.userStore.updateUser(started.alice.id, {
      resourceGrants: {
        scopePresetIds: ['preset-alpha'],
        mcpTools: ['agentx_whoami']
      }
    });

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-presets`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { presets: unknown[] };

    // 只含 preset-alpha
    expect(body.presets).toHaveLength(1);
    const preset = body.presets[0] as Record<string, unknown>;
    expect(preset.scopePresetId).toBe('preset-alpha');
    expect(preset.label).toBe('Alpha Scope');
    expect(preset.brands).toEqual(['ELMOS']);
    expect(preset.productLines).toEqual(['Lighting']);
    expect(preset.applicationTags).toEqual(['Automotive']);

    // 安全 DTO：不暴露内部细节
    expect(preset).not.toHaveProperty('chipIds');
    expect(preset).not.toHaveProperty('documentIds');
    expect(preset).not.toHaveProperty('requiredGrants');
    expect(preset).not.toHaveProperty('sourceLabels');
    expect(preset).not.toHaveProperty('status');
    expect(preset).not.toHaveProperty('visibility');

    // preset-beta（未 approved）和 preset-gamma（无授权）均不出现
    const ids = (body.presets as Array<{ scopePresetId: string }>).map((p) => p.scopePresetId);
    expect(ids).not.toContain('preset-beta');
    expect(ids).not.toContain('preset-gamma');
  });

  it('无 resources 配置时返回空列表', async () => {
    const started = await startMcpHttpTestServer({}); // 不传 resources
    server = started.server;
    dataDir = started.dataDir;

    const token = await loginToken(started.baseUrl, 'alice', 'alice-secret');
    const res = await fetch(`${started.baseUrl}/api/scope-presets`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    expect(res.status).toBe(200);
    const body = (await readJson(res)) as { presets: unknown[] };
    expect(body.presets).toEqual([]);
  });
});
