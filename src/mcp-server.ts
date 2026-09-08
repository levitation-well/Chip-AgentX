import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import { SessionManager } from './session-manager.js';
import { AgentActionSchemas, createSessionActions } from './server/session-actions.js';
import { buildMcpWhoamiResponse, type McpWhoamiResponse } from './server/mcp-whoami.js';
import { fingerprintMcpKey } from './server/mcp-http-security.js';
import { UserStore, getAuthConfig, type AuthConfig } from './auth/index.js';
import type { McpKey, User } from './auth/index.js';
import { getProductVersion } from './product/index.js';
import { getEffectiveModelGrants, listEnabledModels } from './model-catalog.js';
import { getUserCreditBalanceUnits } from './auth/user-store.js';
import { authorizeResourceAccess, computeEffectiveAuthorizationSummary, type EffectiveAuthorizationSummary } from './security/index.js';
import { resolveSearchModeAvailability } from './search-modes.js';

const DEFAULT_MCP_NAME = 'agentx-session-manager';
const DEFAULT_MCP_MAX_OUTPUT_CHARS = 2_000_000;
const REMOTE_CUSTOMER_CHIP_ID_DESCRIPTION =
  'Required for public Remote MCP. Call agentx_whoami first and use permissions.resources[].id as this chipId.';
const REMOTE_CUSTOMER_SCOPE_PRESET_DESCRIPTION =
  'Optional scoped search preset for public Remote MCP. Call agentx_whoami first and use a returned scopePreset resource id.';
const REMOTE_CUSTOMER_SCOPE_DESCRIPTION =
  'Optional dynamic scope descriptor for public Remote MCP (group/global search across authorized chips). ' +
  'Alternative to chipId/scopePresetId; mode "single" is ignored (falls back to chipId).';

export const AGENTX_MCP_TOOL_NAMES = [
  'agentx_whoami',
  'agent_spawn',
  'agent_log',
  'agent_send',
  'agent_poll',
  'agent_kill',
  'agent_list'
] as const;

type ToolResult = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
};

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type McpToolProfile = 'default' | 'remote-customer';

const RemoteCustomerAgentSpawnSchema = AgentActionSchemas.agent_spawn
  .pick({ agentType: true, task: true, sessionMode: true, chatMode: true, model: true, documentId: true, scope: true })
  .extend({
    chipId: z.string().min(1).optional().describe(REMOTE_CUSTOMER_CHIP_ID_DESCRIPTION),
    scopePresetId: z.string().min(1).optional().describe(REMOTE_CUSTOMER_SCOPE_PRESET_DESCRIPTION),
    scope: AgentActionSchemas.agent_spawn.shape.scope.describe(REMOTE_CUSTOMER_SCOPE_DESCRIPTION)
  })
  .strict();

/**
 * Sends a progress notification to the MCP client if the request includes a progressToken.
 */
async function sendProgress(
  extra: McpExtra | undefined,
  progress: number,
  total: number,
  message: string
): Promise<void> {
  if (!extra) return;
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        total,
        message
      }
    });
  }
}

export interface McpServerOptions {
  manager?: SessionManager;
  name?: string;
  version?: string;
  toolProfile?: McpToolProfile;
  resolveActions?: () => Promise<McpActionResolution>;
  resolveWhoami?: () => Promise<McpWhoamiResolution>;
  auth?: {
    enabled?: boolean;
    apiKey?: string;
    userStore?: UserStore;
    config?: AuthConfig;
  };
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const manager = options.manager ?? new SessionManager({
    exitOnLastSession: false,
    maxOutputChars: DEFAULT_MCP_MAX_OUTPUT_CHARS
  });
  const resolveActions = options.resolveActions ?? createMcpActionResolver(manager, options.auth);
  const resolveWhoami = options.resolveWhoami ?? createMcpWhoamiResolver(options.auth);
  const server = new McpServer({
    name: options.name ?? DEFAULT_MCP_NAME,
    version: options.version ?? getProductVersion()
  });

  registerProtocolResources(server);
  registerAgentTools(server, resolveActions, resolveWhoami, options.toolProfile ?? 'default');
  return server;
}

function registerProtocolResources(server: McpServer): void {
  server.registerResource(
    'agentx-capabilities',
    'agentx://capabilities',
    {
      title: 'AgentX MCP Capabilities',
      description: 'Read-only AgentX MCP capability summary. Use agentx_whoami for authenticated resources.',
      mimeType: 'application/json'
    },
    (uri) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify({
            name: DEFAULT_MCP_NAME,
            tools: AGENTX_MCP_TOOL_NAMES,
            notes: [
              'Call agentx_whoami to inspect authenticated chip resources.',
              'Public Remote MCP resolves workspaces server-side from chipId; direct cwd is not exposed.'
            ]
          })
        }
      ]
    })
  );
}

function registerAgentTools(
  server: McpServer,
  resolveActions: () => Promise<McpActionResolution>,
  resolveWhoami: () => Promise<McpWhoamiResolution>,
  toolProfile: McpToolProfile
): void {
  server.registerTool(
    'agentx_whoami',
    {
      description: 'Inspect the current MCP key, user, allowed actions, resources, and server limits without exposing secrets or cwd.',
      inputSchema: {}
    },
    async () => {
      const resolved = await resolveWhoami();
      if ('error' in resolved) {
        return resolved.error;
      }
      return toJsonContent(resolved.whoami);
    }
  );

  server.registerTool(
    'agent_spawn',
    {
      description:
        toolProfile === 'remote-customer'
          ? 'Create a public Remote MCP coding agent session. First call agentx_whoami, then pass permissions.resources[].id as chipId or scopePresetId. Do not pass cwd, env, or systemPrompt; the server resolves workspace and prompt context.'
          : 'Create a coding agent session for project investigation. Prefer chipId from agentx_whoami resources when available; direct cwd is only for local or unmanaged compatibility modes.',
      inputSchema: toolProfile === 'remote-customer' ? RemoteCustomerAgentSpawnSchema : AgentActionSchemas.agent_spawn
    },
    async (input: unknown, extra: McpExtra | undefined) => {
      const params = toolProfile === 'remote-customer'
        ? RemoteCustomerAgentSpawnSchema.parse(input)
        : AgentActionSchemas.agent_spawn.parse(input);
      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      const session = await resolved.actions.agent_spawn(params);

      await sendProgress(
        extra,
        1,
        1,
        `Session ${session.sessionId} created for agent ${session.agentType}`
      );

      return toJsonContent(session);
    }
  );

  server.registerTool(
    'agent_log',
    {
      description: 'Retrieve session output with optional offset, limit, or tail. For Claude Code stream-json output, read the final type="result" record when present; use tail for large or noisy logs.',
      inputSchema: AgentActionSchemas.agent_log
    },
    async (input) => {
      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      return toJsonContent(await resolved.actions.agent_log(AgentActionSchemas.agent_log.parse(input)));
    }
  );

  server.registerTool(
    'agent_send',
    {
      description: 'Send text to a running session.',
      inputSchema: AgentActionSchemas.agent_send
    },
    async (input) => {
      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      return toJsonContent(await resolved.actions.agent_send(AgentActionSchemas.agent_send.parse(input)));
    }
  );

  server.registerTool(
    'agent_poll',
    {
      description: 'Wait for new session output or process exit. Loop this call until exited=true before treating a task as complete; hasOutput=true only means more log data arrived.',
      inputSchema: AgentActionSchemas.agent_poll
    },
    async (input, extra) => {
      const params = AgentActionSchemas.agent_poll.parse(input);
      const total = params.timeoutMs ?? 5000;

      await sendProgress(
        extra,
        0,
        total,
        `Polling session ${params.sessionId}...`
      );

      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      const result = await resolved.actions.agent_poll(params);

      await sendProgress(
        extra,
        result.exited ? total : Math.floor(total / 2),
        total,
        `Poll complete: exited=${result.exited}, hasOutput=${result.hasOutput}`
      );

      return toJsonContent(result);
    }
  );

  server.registerTool(
    'agent_kill',
    {
      description: 'Terminate a running session.',
      inputSchema: AgentActionSchemas.agent_kill
    },
    async (input) => {
      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      return toJsonContent(await resolved.actions.agent_kill(AgentActionSchemas.agent_kill.parse(input)));
    }
  );

  server.registerTool(
    'agent_list',
    {
      description: 'List running and finished sessions.',
      inputSchema: AgentActionSchemas.agent_list
    },
    async (input) => {
      const resolved = await resolveActions();
      if ('error' in resolved) {
        return resolved.error;
      }
      return toJsonContent(await resolved.actions.agent_list(AgentActionSchemas.agent_list.parse(input)));
    }
  );
}

export type McpActions = ReturnType<typeof createSessionActions>;

export type McpActionResolution =
  | { actions: McpActions }
  | { error: ToolResult };

export type McpWhoamiResolution =
  | { whoami: McpWhoamiResponse }
  | { error: ToolResult };

interface McpIdentity {
  user: User;
  key: McpKey;
}

export function createMcpActionResolver(
  manager: SessionManager,
  authOptions: McpServerOptions['auth']
): () => Promise<McpActionResolution> {
  const baseActions = createSessionActions(manager);

  return async () => {
    if (authOptions?.enabled === false) {
      return { actions: baseActions };
    }

    const identity = await resolveMcpIdentity(authOptions, true);
    if (!identity) {
      return { error: toJsonContent({ error: 'Unauthorized: valid MCP_API_KEY required' }) };
    }
    const authorizationSummary = buildMcpAuthorizationSummary(identity.user, identity.key, authOptions?.apiKey ?? process.env.MCP_API_KEY);
    if (!authorizationSummary.usable) {
      return { error: toJsonContent({ error: authorizationSummary.safeMessage }) };
    }

    return {
      actions: enforceMcpToolGrants(createSessionActions(manager, {
        scopeUserId: identity.user.id,
        source: 'mcp',
        mcpKeyFingerprint: fingerprintMcpKey(authOptions?.apiKey ?? process.env.MCP_API_KEY),
        userSnapshot: {
          userId: identity.user.id,
          username: identity.user.username,
          role: identity.user.role,
          authorizedModels: getAuthorizedModelIdsFromSummary(authorizationSummary),
          credits: { balanceUnits: getUserCreditBalanceUnits(identity.user) }
        }
      }), authorizationSummary)
    };
  };
}

export function createMcpWhoamiResolver(
  authOptions: McpServerOptions['auth']
): () => Promise<McpWhoamiResolution> {
  return async () => {
    if (authOptions?.enabled === false) {
      return {
        whoami: buildMcpWhoamiResponse({
          transport: 'stdio',
          authEnabled: false,
          allowedActions: AGENTX_MCP_TOOL_NAMES,
          allowedModes: listMcpSearchModes({
            role: 'admin',
            creditBalanceUnits: undefined,
            transport: 'stdio'
          }),
          capabilityNotes: ['Local stdio MCP authentication is disabled for this process.']
        })
      };
    }

    const identity = await resolveMcpIdentity(authOptions, false);
    if (!identity) {
      return { error: toJsonContent({ error: 'Unauthorized: valid MCP_API_KEY required' }) };
    }

    const apiKey = authOptions?.apiKey ?? process.env.MCP_API_KEY;
    const authorizationSummary = buildMcpAuthorizationSummary(identity.user, identity.key, apiKey);
    return {
      whoami: buildMcpWhoamiResponse({
        transport: 'stdio',
        authEnabled: true,
        user: identity.user,
        key: identity.key,
        keyFingerprint: fingerprintMcpKey(apiKey),
        allowedActions: filterAllowedMcpActions(authorizationSummary),
        allowedModels: getAllowedModelSummaries(identity.user, identity.key, authorizationSummary),
        allowedModes: listMcpSearchModes({
          role: identity.user.role,
          authorizedModelIds: getAuthorizedModelIdsFromSummary(authorizationSummary),
          creditBalanceUnits: getUserCreditBalanceUnits(identity.user),
          transport: 'stdio'
        }),
        credits: { balanceUnits: getUserCreditBalanceUnits(identity.user) },
        capabilityNotes: ['stdio MCP uses the local MCP_API_KEY process context.']
      })
    };
  };
}

async function resolveMcpIdentity(authOptions: McpServerOptions['auth'], touchKey: boolean): Promise<McpIdentity | null> {
  const apiKey = authOptions?.apiKey ?? process.env.MCP_API_KEY;
  if (!apiKey) {
    return null;
  }

  const config = authOptions?.config ?? (authOptions?.userStore ? undefined : getAuthConfig());
  const userStore = authOptions?.userStore ?? new UserStore(config!);
  await userStore.init();

  const identity = await userStore.lookupUsableMcpKey(apiKey);
  if (identity && touchKey) {
    await userStore.touchMcpKey(identity.user.id, identity.key.id);
  }
  return identity;
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function toJsonContent(result: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result)
      }
    ]
  };
}

function buildMcpAuthorizationSummary(user: User, key: McpKey, apiKey: string | undefined): EffectiveAuthorizationSummary {
  const legacyDefaultToolGrants =
    user.resourceGrants === undefined && key.resourceGrants === undefined
      ? { mcpTools: [...AGENTX_MCP_TOOL_NAMES] }
      : undefined;
  return computeEffectiveAuthorizationSummary({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      status: user.status,
      expiresAt: user.expiresAt,
      grants: user.resourceGrants,
      modelGrants: user.modelGrants
    },
    key: {
      id: key.id,
      fingerprint: fingerprintMcpKey(apiKey ?? ''),
      expiresAt: key.expiresAt,
      grants: key.resourceGrants,
      modelGrants: key.modelGrants
    },
    roleGrants: legacyDefaultToolGrants
  });
}

function enforceMcpToolGrants(actions: McpActions, summary: EffectiveAuthorizationSummary): McpActions {
  const assertTool = (toolName: string) => {
    const decision = authorizeResourceAccess(summary, { type: 'mcpTool', id: toolName });
    if (!decision.allowed) {
      throw new Error(decision.safeMessage);
    }
  };
  return {
    ...actions,
    async agent_spawn(input) {
      assertTool('agent_spawn');
      return actions.agent_spawn(input);
    },
    async agent_log(input) {
      assertTool('agent_log');
      return actions.agent_log(input);
    },
    async agent_send(input) {
      assertTool('agent_send');
      return actions.agent_send(input);
    },
    async agent_poll(input) {
      assertTool('agent_poll');
      return actions.agent_poll(input);
    },
    async agent_kill(input) {
      assertTool('agent_kill');
      return actions.agent_kill(input);
    },
    async agent_list(input) {
      assertTool('agent_list');
      return actions.agent_list(input);
    }
  };
}

function filterAllowedMcpActions(summary: EffectiveAuthorizationSummary): string[] {
  if (!summary.usable) {
    return [];
  }
  if (summary.grants.mcpTools.includes('*')) {
    return [...AGENTX_MCP_TOOL_NAMES];
  }
  const allowed = new Set(summary.grants.mcpTools);
  return AGENTX_MCP_TOOL_NAMES.filter((toolName) => allowed.has(toolName));
}

function getAuthorizedModelIdsFromSummary(summary: EffectiveAuthorizationSummary) {
  if (!summary.usable) {
    return [];
  }
  if (summary.grants.modelIds.includes('*')) {
    return listEnabledModels().map((model) => model.id);
  }
  return listEnabledModels().filter((model) => summary.grants.modelIds.includes(model.id)).map((model) => model.id);
}

function getAllowedModelSummaries(user: User, key: McpKey, summary?: EffectiveAuthorizationSummary) {
  const allowedIds = new Set(summary ? getAuthorizedModelIdsFromSummary(summary) : getEffectiveModelGrants({
    role: user.role,
    userModelGrants: user.modelGrants,
    mcpKeyModelGrants: key.modelGrants
  }));
  return listEnabledModels()
    .filter((model) => allowedIds.has(model.id))
    .map((model) => ({
      id: model.id,
      label: model.label,
      capabilities: model.capabilities,
      creditUnits: model.creditUnits
    }));
}

function listMcpSearchModes(options: {
  role?: string;
  authorizedModelIds?: ReturnType<typeof getAuthorizedModelIdsFromSummary>;
  creditBalanceUnits?: number;
  transport: 'stdio' | 'remote';
}) {
  return resolveSearchModeAvailability({
    entryPoint: options.transport === 'remote' ? 'remote-mcp' : 'stdio-mcp',
    role: options.role,
    authorizedModelIds: options.authorizedModelIds,
    creditBalanceUnits: options.creditBalanceUnits
  });
}
