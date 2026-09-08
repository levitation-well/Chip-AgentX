import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeMcpHttpTestServer,
  startMcpHttpTestServer,
  type TestMcpKey
} from './mcp-http-test-helpers.js';

async function loginToken(baseUrl: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  return ((await response.json()) as { token: string }).token;
}

async function readJson(response: Response) {
  return (await response.json()) as any;
}

describe('MCP access center API', () => {
  it('returns public access metadata for unauthenticated users without account data', async () => {
    const started = await startMcpHttpTestServer();
    try {
      const response = await fetch(`${started.baseUrl}/api/mcp/access-center`);
      const body = await readJson(response);
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.auth).toMatchObject({
        enabled: true,
        mode: 'bearer-mcp-key',
        authenticated: false,
        requiredForUserData: true
      });
      expect(body.server.remoteHttpUrl).toBe(`${started.baseUrl}/mcp`);
      expect(body.server.transports).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'remote-http', authMode: 'bearer-mcp-key', recommended: true }),
          expect.objectContaining({ id: 'stdio', recommended: false })
        ])
      );
      expect(body.templates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'opencode', downloadUrl: `${started.baseUrl}/mcp-templates/opencode.json` }),
          expect.objectContaining({ id: 'codex', downloadUrl: `${started.baseUrl}/mcp-templates/codex.md` })
        ])
      );
      expect(body.downloads).toEqual([]);
      expect(body.user).toBeNull();
      expect(body.keySummaries).toEqual([]);
      expect(body.availableKeys).toEqual([]);
      expect(serialized).not.toContain(started.aliceKey.key);
      expect(serialized).not.toContain(started.bobKey.key);
      expect(serialized).not.toMatch(/passwordHash|bearer\s+[a-z0-9._-]+|cookie/i);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('rejects an invalid login token clearly instead of falling back to public data', async () => {
    const started = await startMcpHttpTestServer();
    try {
      const response = await fetch(`${started.baseUrl}/api/mcp/access-center`, {
        headers: { Authorization: 'Bearer invalid-token' }
      });
      const body = await readJson(response);

      expect(response.status).toBe(401);
      expect(body.error).toBe('Unauthorized');
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('returns only the authenticated user access contract with masked usable keys, models, and resources', async () => {
    const userAccessFile = join(tmpdir(), `agentx-access-center-${randomUUID()}.json`);
    const started = await startMcpHttpTestServer({
      chips: {
        enabled: true,
        userAccessFile,
        catalog: {
          knowledgeBaseRoot: 'D:\\private\\kb',
          chips: [
            {
              id: 'E521.39',
              label: 'E521.39 LIN RGB',
              description: 'LIN RGB driver',
              queryHint: 'E521.39',
              workspaceDir: 'D:\\private\\kb\\E521.39'
            },
            {
              id: 'E522.94',
              label: 'E522.94 Rear lighting',
              workspaceDir: 'D:\\private\\kb\\E522.94'
            }
          ]
        }
      },
      prompts: { enabled: false }
    });
    try {
      await started.userStore.updateUser(started.alice.id, {
        modelGrants: ['haiku', 'sonnet'],
        resourceGrants: {
          chipIds: ['E521.39', 'E522.94'],
          documentIds: ['doc-alice'],
          scopePresetIds: ['lighting'],
          mcpTools: ['agentx_whoami', 'agent_spawn']
        },
        selfService: {
          allowMcpKeySelfCreate: true,
          maxMcpKeys: 3,
          defaultMcpKeyTtlDays: 14,
          allowMcpKeyRegenerate: true
        }
      });
      await started.userStore.updateMcpKey(started.alice.id, started.aliceKey.id, {
        modelGrants: ['sonnet'],
        resourceGrants: { chipIds: ['E521.39'], mcpTools: ['agentx_whoami'] }
      });
      const expiredKey = await started.userStore.addMcpKey(started.alice.id, 'expired laptop', {
        expiresAt: '2020-01-01T00:00:00.000Z',
        modelGrants: ['haiku']
      });
      await started.userStore.addMcpKey(started.bob.id, 'bob hidden key');
      const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

      const response = await fetch(`${started.baseUrl}/api/mcp/access-center?userId=${started.bob.id}`, {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      const body = await readJson(response);
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.auth.authenticated).toBe(true);
      expect(body.user).toMatchObject({ id: started.alice.id, username: 'alice', role: 'customer' });
      expect(body.permissions.mcpKeyPolicy).toMatchObject({
        allowMcpKeySelfCreate: true,
        maxMcpKeys: 3,
        defaultMcpKeyTtlDays: 14,
        allowMcpKeyRegenerate: true
      });
      expect(body.permissions.allowedModels.map((model: { id: string }) => model.id)).toEqual([
        'haiku',
        'sonnet'
      ]);
      expect(body.permissions.resources).toEqual([
        expect.objectContaining({ type: 'chip', id: 'E521.39', label: 'E521.39 LIN RGB' }),
        expect.objectContaining({ type: 'chip', id: 'E522.94', label: 'E522.94 Rear lighting' })
      ]);
      expect(body.permissions.authorizationSummary.grants).toMatchObject({
        chipIds: ['E521.39', 'E522.94'],
        documentIds: ['doc-alice'],
        scopePresetIds: ['lighting'],
        mcpTools: ['agentx_whoami', 'agent_spawn']
      });
      expect(body.keySummaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            keyId: started.aliceKey.id,
            name: 'alice remote',
            maskedKey: expect.any(String),
            fingerprint: expect.any(String),
            usable: true,
            status: 'usable',
            allowedModels: [expect.objectContaining({ id: 'sonnet' })],
            resources: [expect.objectContaining({ id: 'E521.39' })],
            authorizedTools: ['agentx_whoami']
          }),
          expect.objectContaining({
            keyId: expiredKey.id,
            name: 'expired laptop',
            usable: false,
            status: 'unavailable',
            unavailableReason: 'mcp_key_expired'
          })
        ])
      );
      expect(body.availableKeys.map((key: { keyId: string }) => key.keyId)).toEqual([started.aliceKey.id]);
      expect(serialized).not.toContain(started.aliceKey.key);
      expect(serialized).not.toContain(expiredKey.key);
      expect(serialized).not.toContain(started.bob.id);
      expect(serialized).not.toContain(started.bobKey.key);
      expect(serialized).not.toContain('workspaceDir');
      expect(serialized).not.toContain('knowledgeBaseRoot');
      expect(serialized).not.toContain('D:\\private');
      expect(serialized).not.toMatch(/passwordHash|bearer\s+[a-z0-9._-]+|cookie/i);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
      await rm(userAccessFile, { force: true });
    }
  });

  it('stays consistent with /api/account and excludes revoked keys from available keys', async () => {
    const started = await startMcpHttpTestServer();
    try {
      await started.userStore.updateUser(started.alice.id, {
        modelGrants: ['haiku'],
        resourceGrants: { chipIds: ['*'], mcpTools: ['agentx_whoami'] },
        selfService: {
          allowMcpKeySelfCreate: true,
          maxMcpKeys: 2,
          defaultMcpKeyTtlDays: 7,
          allowMcpKeyRegenerate: true
        }
      });
      const revokedKey: TestMcpKey = await started.userStore.addMcpKey(started.alice.id, 'temporary key');
      await started.userStore.removeMcpKey(started.alice.id, revokedKey.id);
      const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

      const [accountResponse, accessResponse] = await Promise.all([
        fetch(`${started.baseUrl}/api/account`, { headers: { Authorization: `Bearer ${aliceToken}` } }),
        fetch(`${started.baseUrl}/api/mcp/access-center`, { headers: { Authorization: `Bearer ${aliceToken}` } })
      ]);
      const account = await readJson(accountResponse);
      const access = await readJson(accessResponse);
      const accessSerialized = JSON.stringify(access);

      expect(accountResponse.status).toBe(200);
      expect(accessResponse.status).toBe(200);
      expect(access.permissions.allowedModels.map((model: { id: string }) => model.id)).toEqual(
        account.permissions.availableModels.map((model: { id: string }) => model.id)
      );
      expect(access.permissions.resources).toEqual(account.permissions.resources);
      expect(access.permissions.mcpKeyPolicy).toEqual(account.permissions.mcpKeyPolicy);
      expect(access.keySummaries.map((key: { keyId: string }) => key.keyId)).toEqual(
        account.mcpKeys.map((key: { id: string }) => key.id)
      );
      expect(access.availableKeys.map((key: { keyId: string }) => key.keyId)).toEqual([started.aliceKey.id]);
      expect(accessSerialized).not.toContain(revokedKey.key);
      expect(accessSerialized).not.toContain(revokedKey.id);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('returns safe document and scope preset summaries without leaking paths', async () => {
    const started = await startMcpHttpTestServer({
      resources: {
        enabled: true,
        catalog: {
          documents: [
            {
              documentId: 'doc-alice',
              label: 'Alice application note',
              visibility: 'customer',
              status: 'approved',
              sourceLabels: ['application note', 'D:\\private\\kb\\doc-alice.pdf']
            },
            {
              documentId: 'doc-pending',
              label: 'Pending private note',
              visibility: 'customer',
              status: 'pending'
            }
          ],
          scopePresets: [
            {
              scopePresetId: 'lighting',
              label: 'Lighting scope',
              visibility: 'customer',
              status: 'approved',
              sourceLabels: ['lighting scope']
            }
          ]
        }
      }
    });
    try {
      await started.userStore.updateUser(started.alice.id, {
        resourceGrants: {
          documentIds: ['doc-alice'],
          scopePresetIds: ['lighting'],
          mcpTools: ['agentx_whoami']
        }
      });
      const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

      const response = await fetch(`${started.baseUrl}/api/mcp/access-center`, {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      const body = await readJson(response);
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.permissions.resources).toEqual([
        expect.objectContaining({ type: 'document', id: 'doc-alice', label: 'Alice application note' }),
        expect.objectContaining({ type: 'scopePreset', id: 'lighting', label: 'Lighting scope' })
      ]);
      expect(body.permissions.resources.map((resource: { id: string }) => resource.id)).not.toContain('doc-pending');
      expect(serialized).not.toContain('Pending private note');
      expect(serialized).not.toMatch(/workspaceDir|serverPath|knowledgeBaseRoot|D:\\private|doc-alice\.pdf/i);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('reflects admin grant edits in account and access center summaries without leaking secrets', async () => {
    const started = await startMcpHttpTestServer({
      chips: {
        enabled: true,
        catalog: {
          knowledgeBaseRoot: 'D:\\private\\kb',
          chips: [
            { id: 'E521.39', label: 'E521.39 LIN RGB', workspaceDir: 'D:\\private\\kb\\E521.39' },
            { id: 'E522.94', label: 'E522.94 Rear lighting', workspaceDir: 'D:\\private\\kb\\E522.94' }
          ]
        }
      },
      prompts: { enabled: false }
    });
    try {
      const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');
      const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');

      const update = await fetch(`${started.baseUrl}/admin/users/${started.alice.id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelGrants: ['haiku'],
          resourceGrants: {
            chipIds: ['E522.94'],
            documentIds: ['doc-updated'],
            scopePresetIds: ['lighting'],
            mcpTools: ['agentx_whoami']
          }
        })
      });
      expect(update.status).toBe(200);

      const [accountResponse, accessResponse] = await Promise.all([
        fetch(`${started.baseUrl}/api/account`, { headers: { Authorization: `Bearer ${aliceToken}` } }),
        fetch(`${started.baseUrl}/api/mcp/access-center`, { headers: { Authorization: `Bearer ${aliceToken}` } })
      ]);
      const account = await readJson(accountResponse);
      const access = await readJson(accessResponse);
      const serialized = JSON.stringify({ account, access });

      expect(account.permissions.authorizationSummary.grants).toMatchObject({
        chipIds: ['E522.94'],
        documentIds: ['doc-updated'],
        scopePresetIds: ['lighting'],
        modelIds: ['haiku'],
        mcpTools: ['agentx_whoami']
      });
      expect(access.permissions.authorizationSummary.grants).toEqual(account.permissions.authorizationSummary.grants);
      expect(access.permissions.resources).toEqual([expect.objectContaining({ id: 'E522.94' })]);
      expect(serialized).not.toContain(started.aliceKey.key);
      expect(serialized).not.toMatch(/passwordHash|bearer\s+[a-z0-9._-]+|cookie/i);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('uses runtime model routing in access center search mode summaries', async () => {
    const started = await startMcpHttpTestServer({
      modelRouting: {
        config: {
          modeRoleMapping: { standard: 'fable', enhanced: 'sonnet', multimodal: 'opus' }
        }
      }
    });
    try {
      const aliceToken = await loginToken(started.baseUrl, 'alice', 'alice-secret');
      const response = await fetch(`${started.baseUrl}/api/mcp/access-center`, {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      const body = await readJson(response);

      expect(response.status).toBe(200);
      expect(body.permissions.searchModes.find((mode: { id: string }) => mode.id === 'standard')).toMatchObject({
        defaultModelId: 'fable'
      });
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });

  it('keeps admin access center scoped to the admin account without exposing other user secrets', async () => {
    const started = await startMcpHttpTestServer();
    try {
      const admin = await started.userStore.findByUsername('admin');
      expect(admin).not.toBeNull();
      const adminKey = await started.userStore.addMcpKey(admin!.id, 'admin workstation');
      const aliceExtraKey = await started.userStore.addMcpKey(started.alice.id, 'alice extra hidden');
      const adminToken = await loginToken(started.baseUrl, 'admin', 'admin-secret');

      const response = await fetch(`${started.baseUrl}/api/mcp/access-center?userId=${started.alice.id}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      const body = await readJson(response);
      const serialized = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.user).toMatchObject({ id: admin!.id, username: 'admin', role: 'admin' });
      expect(body.availableKeys.map((key: { keyId: string }) => key.keyId)).toEqual([adminKey.id]);
      expect(serialized).not.toContain(adminKey.key);
      expect(serialized).not.toContain(started.aliceKey.key);
      expect(serialized).not.toContain(aliceExtraKey.key);
      expect(serialized).not.toContain(started.alice.id);
    } finally {
      await closeMcpHttpTestServer(started.server, started.dataDir);
    }
  });
});
