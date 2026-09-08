/* eslint-disable @typescript-eslint/no-explicit-any */
import { basename, dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hashPromptContent } from '../../prompt-governance-store.js';
import { resolveCliConfig } from '../config.js';
import { createCliError } from '../errors.js';
import { createCliHttpClient } from '../http-client.js';
import { outputCliError, outputCommandGroupHelp, outputStructuredJson } from '../output.js';
import { addSharedHttpOptions } from './user.js';
import type { CliCommonOptions, ResolvedCliConfig } from '../types.js';

const ADMIN_COMMANDS = [
  ['users', 'Manage users, roles, passwords, and admin-issued MCP keys'],
  ['credits', 'Inspect and adjust user credits'],
  ['model-auth', 'Inspect and update model and resource grants'],
  ['mcp-templates', 'Inspect MCP templates and package metadata'],
  ['prompts', 'Inspect prompt metadata, history, update, and rollback'],
  ['uploads-review', 'Review datasheet upload tickets'],
  ['metadata', 'Inspect or update datasheet metadata candidates'],
  ['catalog', 'Inspect or update chips, chip access, and roles'],
  ['announcements', 'Inspect or update announcements/news/changelogs']
] as const;

const USERS_COMMANDS = ['list', 'get', 'create', 'update', 'delete', 'set-role', 'password', 'mcp-key'] as const;
const CREDITS_COMMANDS = ['get', 'adjust'] as const;
const MODEL_AUTH_COMMANDS = ['get', 'set-user', 'set-key', 'clear-user', 'clear-key'] as const;
const TEMPLATE_COMMANDS = ['list', 'show', 'download', 'package-check'] as const;
const PROMPT_COMMANDS = ['list', 'show', 'history', 'update', 'rollback'] as const;
const UPLOAD_REVIEW_COMMANDS = ['list', 'get', 'accept', 'reject', 'needs-more-info', 'link'] as const;
const METADATA_COMMANDS = ['get-candidate', 'set-candidate', 'clear-candidate'] as const;
const CATALOG_GROUPS = ['chips', 'chip-access', 'roles'] as const;
const ROLE_COMMANDS = ['list', 'get', 'create', 'update', 'delete', 'reload'] as const;
const ANNOUNCEMENT_COMMANDS = ['list', 'get', 'create', 'update', 'publish', 'offline', 'archive', 'duplicate'] as const;

interface AdminCliOptions extends CliCommonOptions {
  limit?: string | number;
  offset?: string | number;
  status?: string;
  type?: string;
  visibility?: string;
  active?: boolean;
  keyword?: string;
  q?: string;
  role?: string;
  name?: string;
  expiresAt?: string;
  output?: string;
  file?: string;
  stdin?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  deltaUnits?: string | number;
  balanceUnits?: string | number;
  reason?: string;
  note?: string;
  newPassword?: string;
  newPasswordStdin?: boolean;
  statusFilter?: string;
  models?: string;
  publicNote?: string;
  internalNote?: string;
  result?: string;
  title?: string;
  summary?: string;
  body?: string;
  content?: string;
  id?: string;
  pinned?: boolean;
  requiresLogin?: boolean;
  vendor?: string;
  partNumber?: string;
  brand?: string;
  productLine?: string;
  application?: string;
  chipId?: string;
  documentId?: string;
  scopePresetId?: string;
  applicationTags?: string;
}

interface AdminUsersResponse {
  users: Array<Record<string, unknown>>;
}

interface AdminUserResponse {
  user: Record<string, unknown>;
}

interface AdminKeyResponse {
  key: Record<string, unknown>;
}

interface AdminCreditsResponse {
  userId: string;
  username?: string;
  balanceUnits: number;
  ledger: {
    items: Array<Record<string, unknown>>;
    total: number;
    offset: number;
    limit: number;
  };
}

interface AdminPromptListResponse {
  files: Array<Record<string, unknown>>;
}

interface AdminPromptReadResponse {
  content: string;
  missing?: boolean;
}

interface AdminPromptHistoryResponse {
  entries: Array<Record<string, unknown>>;
}

interface AccessCenterResponse {
  templates: Array<{
    id: string;
    label: string;
    clientType?: string;
    contentType?: string;
    downloadUrl: string;
  }>;
  downloads: Array<{
    id: string;
    label: string;
    contentType?: string;
    downloadUrl: string;
  }>;
  capabilities?: Record<string, unknown>;
  limits?: Record<string, unknown>;
}

interface TicketListResponse {
  items: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
}

interface AdminTicketResponse {
  ticket: Record<string, unknown>;
}

interface AnnouncementListResponse {
  items: Array<Record<string, unknown>>;
  total: number;
}

interface AnnouncementDetailResponse {
  item: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

export function registerAdmin(cli: any) {
  const command = cli.command('admin [...args]', 'Admin HTTP CLI');
  addSharedHttpOptions(command);
  command
    .option('--limit <n>', 'List limit')
    .option('--offset <n>', 'List offset')
    .option('--status <status>', 'Status filter')
    .option('--type <type>', 'Type filter')
    .option('--visibility <visibility>', 'Visibility filter')
    .option('--active', 'Filter active items')
    .option('--keyword <text>', 'Keyword filter')
    .option('--q <text>', 'Keyword filter alias')
    .option('--role <role>', 'Role name')
    .option('--name <name>', 'Friendly name')
    .option('--expires-at <iso>', 'Expiry time in ISO-8601')
    .option('--output <file>', 'Write downloaded output to a file')
    .option('--file <path>', 'Read request content/body from a file')
    .option('--stdin', 'Read request content/body from stdin')
    .option('--yes', 'Confirm a high-risk mutation')
    .option('--dry-run', 'Show the intended mutation without applying it')
    .option('--delta-units <n>', 'Credit delta in balance units')
    .option('--balance-units <n>', 'Absolute credit balance in units')
    .option('--reason <text>', 'Audit reason')
    .option('--note <text>', 'Audit note')
    .option('--new-password <password>', 'New password for the target user')
    .option('--new-password-stdin', 'Read the target password from stdin')
    .option('--models <csv>', 'Comma-separated model grant ids')
    .option('--public-note <text>', 'Public note')
    .option('--internal-note <text>', 'Internal note')
    .option('--result <text>', 'Result text')
    .option('--title <text>', 'Title')
    .option('--summary <text>', 'Summary')
    .option('--body <text>', 'Body text')
    .option('--content <text>', 'Inline content text')
    .option('--id <id>', 'Explicit content id')
    .option('--pinned', 'Pinned flag')
    .option('--requires-login', 'Requires login flag')
    .option('--vendor <text>', 'Metadata candidate vendor')
    .option('--part-number <text>', 'Metadata candidate part number')
    .option('--brand <text>', 'Metadata candidate brand')
    .option('--product-line <text>', 'Metadata candidate product line')
    .option('--application <text>', 'Metadata candidate application')
    .option('--chip-id <text>', 'Metadata candidate chip id')
    .option('--document-id <text>', 'Metadata candidate document id')
    .option('--scope-preset-id <text>', 'Metadata candidate scope preset id')
    .option('--application-tags <csv>', 'Metadata candidate application tags')
    .action(async (args: string[] = [], options: AdminCliOptions = {}) => {
      const jsonErrors = preferJsonOutput(options);
      try {
        const subcommand = args[0];
        if (!subcommand) {
          outputAdminHelp();
          return;
        }

        const known = new Set<string>(ADMIN_COMMANDS.map(([name]) => name));
        if (!known.has(subcommand)) {
          throw createCliError('VALIDATION_ERROR', `Unknown admin subcommand: ${subcommand}`);
        }

        const config = await resolveCliConfig(options);
        const client = createCliHttpClient(config);
        await dispatchAdminCommand(client, config, subcommand, args.slice(1), options);
      } catch (error) {
        outputCliError(error, jsonErrors);
      }
    });
}

async function dispatchAdminCommand(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  subcommand: string,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  if (subcommand === 'users') {
    await runUsers(client, config, args, options);
    return;
  }
  if (subcommand === 'credits') {
    await runCredits(client, config, args, options);
    return;
  }
  if (subcommand === 'model-auth') {
    await runModelAuth(client, config, args, options);
    return;
  }
  if (subcommand === 'mcp-templates') {
    await runMcpTemplates(client, config, args, options);
    return;
  }
  if (subcommand === 'prompts') {
    await runPrompts(client, config, args, options);
    return;
  }
  if (subcommand === 'uploads-review') {
    await runUploadsReview(client, config, args, options);
    return;
  }
  if (subcommand === 'metadata') {
    await runMetadata(client, config, args, options);
    return;
  }
  if (subcommand === 'catalog') {
    await runCatalog(client, config, args, options);
    return;
  }
  if (subcommand === 'announcements') {
    await runAnnouncements(client, config, args, options);
    return;
  }
  throw createCliError('VALIDATION_ERROR', `Unknown admin subcommand: ${subcommand}`);
}

async function runUsers(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputUsersHelp();
    return;
  }
  if (!USERS_COMMANDS.includes(action as (typeof USERS_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown users action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<AdminUsersResponse>({ path: '/admin/users' });
    const users = response.data.users
      .filter((user) => !options.role || String(user.role ?? '') === options.role)
      .filter((user) => !options.status || String(user.status ?? 'active') === options.status)
      .filter((user) => {
        const keyword = nonEmpty(options.keyword ?? options.q);
        if (!keyword) {
          return true;
        }
        const haystack = JSON.stringify(sanitizeUserRecord(user)).toLowerCase();
        return haystack.includes(keyword.toLowerCase());
      });
    emitResult(
      config,
      { users: users.map(sanitizeUserRecord), total: users.length },
      users.length === 0 ? ['No users found.'] : users.map(renderUserLine)
    );
    return;
  }

  if (action === 'get') {
    const userId = requirePositional(args[1], 'userId');
    const response = await client.requestJson<AdminUserResponse>({
      path: `/admin/users/${encodeURIComponent(userId)}`
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, renderUserDetails(user));
    return;
  }

  if (action === 'create') {
    const username = requirePositional(args[1], 'username');
    const password = await requireTargetPassword(options);
    const body = (await readOptionalJsonInput(options)) ?? buildUserCreateBodyFromOptions(username, password, options);
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'users.create', body: sanitizeUserMutationPreview(body) }, ['Dry run: user create']);
      return;
    }
    requireConfirmation('admin users create', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'POST',
      path: '/admin/users',
      body
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, renderUserDetails(user));
    return;
  }

  if (action === 'update') {
    const userId = requirePositional(args[1], 'userId');
    const body = (await readOptionalJsonInput(options)) ?? buildUserUpdateBodyFromOptions(options);
    if (Object.keys(body).length === 0) {
      throw createCliError('VALIDATION_ERROR', 'Provide update fields via flags or --file/--stdin.');
    }
    if (options.dryRun) {
      emitResult(
        config,
        { dryRun: true, action: 'users.update', userId, body: sanitizeUserMutationPreview(body) },
        ['Dry run: user update']
      );
      return;
    }
    requireConfirmation('admin users update', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}`,
      body
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, renderUserDetails(user));
    return;
  }

  if (action === 'delete') {
    const userId = requirePositional(args[1], 'userId');
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'users.delete', userId }, [`Dry run: delete ${userId}`]);
      return;
    }
    requireConfirmation('admin users delete', options);
    await client.requestJson({
      method: 'DELETE',
      path: `/admin/users/${encodeURIComponent(userId)}`
    });
    emitResult(config, { deleted: true, userId }, [`Deleted ${userId}`]);
    return;
  }

  if (action === 'set-role') {
    const userId = requirePositional(args[1], 'userId');
    const role = requirePositional(args[2] ?? options.role, 'role');
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'users.set-role', userId, role }, [`Dry run: set role ${role} for ${userId}`]);
      return;
    }
    requireConfirmation('admin users set-role', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}/role`,
      body: { role }
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, renderUserDetails(user));
    return;
  }

  if (action === 'password') {
    const subaction = requirePositional(args[1], 'password action');
    if (subaction !== 'set') {
      throw createCliError('VALIDATION_ERROR', `Unknown users password action: ${subaction}`);
    }
    const userId = requirePositional(args[2], 'userId');
    const password = await requireTargetPassword(options);
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'users.password.set', userId }, [`Dry run: set password for ${userId}`]);
      return;
    }
    requireConfirmation('admin users password set', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}/password`,
      body: { password }
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, [`Password updated for ${String(user.username ?? userId)}`]);
    return;
  }

  if (action === 'mcp-key') {
    const subaction = requirePositional(args[1], 'mcp-key action');
    if (subaction === 'add') {
      const userId = requirePositional(args[2], 'userId');
      const name = requireTextOption(options.name, 'name');
      const body: JsonObject = {
        name,
        ...(nonEmpty(options.expiresAt) ? { expiresAt: options.expiresAt!.trim() } : {}),
        ...(normalizeCsvList(options.models).length > 0 ? { modelGrants: normalizeCsvList(options.models) } : {})
      };
      if (options.dryRun) {
        emitResult(config, { dryRun: true, action: 'users.mcp-key.add', userId, body }, ['Dry run: add admin MCP key']);
        return;
      }
      requireConfirmation('admin users mcp-key add', options);
      const response = await client.requestJson<AdminKeyResponse>({
        method: 'POST',
        path: `/admin/users/${encodeURIComponent(userId)}/keys`,
        body
      });
      const key = sanitizeAdminKeyRecord(response.data.key);
      emitResult(config, { key }, [renderKeyLine(key, 'Added')]);
      return;
    }

    if (subaction === 'update') {
      const userId = requirePositional(args[2], 'userId');
      const keyId = requirePositional(args[3], 'keyId');
      const body = buildAdminKeyPatch(options);
      if (options.dryRun) {
        emitResult(config, { dryRun: true, action: 'users.mcp-key.update', userId, keyId, body }, ['Dry run: update admin MCP key']);
        return;
      }
      requireConfirmation('admin users mcp-key update', options);
      const response = await client.requestJson<AdminKeyResponse>({
        method: 'PUT',
        path: `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
        body
      });
      const key = sanitizeAdminKeyRecord(response.data.key);
      emitResult(config, { key }, [renderKeyLine(key, 'Updated')]);
      return;
    }

    if (subaction === 'revoke') {
      const userId = requirePositional(args[2], 'userId');
      const keyId = requirePositional(args[3], 'keyId');
      if (options.dryRun) {
        emitResult(config, { dryRun: true, action: 'users.mcp-key.revoke', userId, keyId }, ['Dry run: revoke admin MCP key']);
        return;
      }
      requireConfirmation('admin users mcp-key revoke', options);
      await client.requestJson({
        method: 'DELETE',
        path: `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`
      });
      emitResult(config, { revoked: true, userId, keyId }, [`Revoked ${keyId}`]);
      return;
    }

    throw createCliError('VALIDATION_ERROR', `Unknown users mcp-key action: ${subaction}`);
  }
}

async function runCredits(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputCreditsHelp();
    return;
  }
  if (!CREDITS_COMMANDS.includes(action as (typeof CREDITS_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown credits action: ${action}`);
  }

  if (action === 'get') {
    const userId = requirePositional(args[1], 'userId');
    const limit = parseOptionalPositiveIntOption(options.limit, 'limit');
    const response = await client.requestJson<AdminCreditsResponse>({
      path: '/admin/credits',
      query: {
        userId,
        ...(limit !== undefined ? { limit } : {})
      }
    });
    emitResult(
      config,
      response.data,
      [
        `User: ${response.data.username ?? response.data.userId}`,
        `Balance: ${response.data.balanceUnits}`,
        `Entries: ${response.data.ledger.total}`,
        ...renderLedgerItems(response.data.ledger.items)
      ]
    );
    return;
  }

  const userId = requirePositional(args[1], 'userId');
  const reason = requireTextOption(options.reason, 'reason');
  const note = nonEmpty(options.note);
  const deltaUnits = parseOptionalIntegerOption(options.deltaUnits, 'delta-units');
  const balanceUnits = parseOptionalNonNegativeIntOption(options.balanceUnits, 'balance-units');
  if (deltaUnits === undefined && balanceUnits === undefined) {
    throw createCliError('VALIDATION_ERROR', 'Provide --delta-units or --balance-units.');
  }
  const body: JsonObject = {
    userId,
    reason,
    ...(note ? { note } : {}),
    ...(deltaUnits !== undefined ? { deltaUnits } : {}),
    ...(balanceUnits !== undefined ? { balanceUnits } : {})
  };
  if (options.dryRun) {
    const current = await client.requestJson<AdminCreditsResponse>({
      path: '/admin/credits',
      query: { userId, limit: Math.min(parseOptionalPositiveIntOption(options.limit, 'limit') ?? 5, 20) }
    });
    emitResult(
      config,
      {
        dryRun: true,
        action: 'credits.adjust',
        body,
        current: current.data
      },
      [
        `Dry run: credits adjust for ${current.data.username ?? userId}`,
        `Current balance: ${current.data.balanceUnits}`,
        `Requested delta: ${deltaUnits ?? 'n/a'}`,
        `Requested balance: ${balanceUnits ?? 'n/a'}`
      ]
    );
    return;
  }
  requireConfirmation('admin credits adjust', options);
  const response = await client.requestJson<{
    userId: string;
    username?: string;
    balanceBeforeUnits: number;
    balanceAfterUnits: number;
    deltaUnits: number;
    reason: string;
    note?: string;
    ledgerRecord: Record<string, unknown>;
  }>({
    method: 'POST',
    path: '/admin/credits/adjust',
    body
  });
  emitResult(
    config,
    response.data,
    [
      `User: ${response.data.username ?? response.data.userId}`,
      `Balance: ${response.data.balanceBeforeUnits} -> ${response.data.balanceAfterUnits}`,
      `Delta: ${response.data.deltaUnits}`,
      `Reason: ${response.data.reason}`
    ]
  );
}

async function runModelAuth(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputModelAuthHelp();
    return;
  }
  if (!MODEL_AUTH_COMMANDS.includes(action as (typeof MODEL_AUTH_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown model-auth action: ${action}`);
  }

  if (action === 'get') {
    const userId = requirePositional(args[1], 'userId');
    const response = await client.requestJson<AdminUserResponse>({
      path: `/admin/users/${encodeURIComponent(userId)}`
    });
    const user = sanitizeUserRecord(response.data.user);
    const keyId = nonEmpty(args[2]);
    if (!keyId) {
      emitResult(
        config,
        {
          userId,
          username: user.username,
          role: user.role,
          modelGrants: user.modelGrants ?? [],
          mcpKeys: ensureArray<Record<string, unknown>>(user.mcpKeys).map(sanitizeAdminKeyRecord)
        },
        [
          `User: ${String(user.username ?? userId)} (${String(user.role ?? 'unknown')})`,
          `User model grants: ${renderCsv(ensureArray<string>(user.modelGrants))}`,
          ...ensureArray<Record<string, unknown>>(user.mcpKeys).map((key) => renderKeyGrantLine(key))
        ]
      );
      return;
    }
    const key = ensureArray<Record<string, unknown>>(user.mcpKeys).find((candidate) => String(candidate.id ?? '') === keyId);
    if (!key) {
      throw createCliError('NOT_FOUND', `MCP key not found: ${keyId}`);
    }
    emitResult(
      config,
      { userId, username: user.username, key: sanitizeAdminKeyRecord(key) },
      [renderKeyGrantLine(key)]
    );
    return;
  }

  if (action === 'set-user') {
    const userId = requirePositional(args[1], 'userId');
    const modelGrants = normalizeCsvList(options.models);
    if (modelGrants.length === 0) {
      throw createCliError('VALIDATION_ERROR', '--models is required.');
    }
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'model-auth.set-user', userId, modelGrants }, ['Dry run: update user model grants']);
      return;
    }
    requireConfirmation('admin model-auth set-user', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}`,
      body: { modelGrants }
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, [`User model grants: ${renderCsv(ensureArray<string>(user.modelGrants))}`]);
    return;
  }

  if (action === 'clear-user') {
    const userId = requirePositional(args[1], 'userId');
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'model-auth.clear-user', userId }, ['Dry run: clear user model grants']);
      return;
    }
    requireConfirmation('admin model-auth clear-user', options);
    const response = await client.requestJson<AdminUserResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}`,
      body: { modelGrants: null }
    });
    const user = sanitizeUserRecord(response.data.user);
    emitResult(config, { user }, [`User model grants: ${renderCsv(ensureArray<string>(user.modelGrants))}`]);
    return;
  }

  const userId = requirePositional(args[1], 'userId');
  const keyId = requirePositional(args[2], 'keyId');
  if (action === 'clear-key') {
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'model-auth.clear-key', userId, keyId }, ['Dry run: clear key grants']);
      return;
    }
    requireConfirmation('admin model-auth clear-key', options);
    const response = await client.requestJson<AdminKeyResponse>({
      method: 'PUT',
      path: `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
      body: { modelGrants: null, resourceGrants: null }
    });
    const key = sanitizeAdminKeyRecord(response.data.key);
    emitResult(config, { key }, [renderKeyGrantLine(key)]);
    return;
  }

  const patch = (await readOptionalJsonInput(options)) ?? buildModelAuthKeyPatch(options);
  if (Object.keys(patch).length === 0) {
    throw createCliError('VALIDATION_ERROR', 'Provide --models and/or resource grants JSON via --file/--stdin.');
  }
  if (options.dryRun) {
    emitResult(config, { dryRun: true, action: 'model-auth.set-key', userId, keyId, patch }, ['Dry run: update key grants']);
    return;
  }
  requireConfirmation('admin model-auth set-key', options);
  const response = await client.requestJson<AdminKeyResponse>({
    method: 'PUT',
    path: `/admin/users/${encodeURIComponent(userId)}/keys/${encodeURIComponent(keyId)}`,
    body: patch
  });
  const key = sanitizeAdminKeyRecord(response.data.key);
  emitResult(config, { key }, [renderKeyGrantLine(key)]);
}

async function runMcpTemplates(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputMcpTemplatesHelp();
    return;
  }
  if (!TEMPLATE_COMMANDS.includes(action as (typeof TEMPLATE_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown mcp-templates action: ${action}`);
  }

  const access = await client.requestJson<AccessCenterResponse>({ path: '/api/mcp/access-center' });
  if (action === 'list') {
    emitResult(
      config,
      { templates: access.data.templates, downloads: access.data.downloads },
      access.data.templates.map((template) => `${template.id} | ${template.clientType ?? 'unknown'} | ${template.label}`)
    );
    return;
  }

  if (action === 'package-check') {
    const templateContents = await Promise.all(
      access.data.templates.map(async (template) => {
        const download = await client.download({ path: template.downloadUrl });
        const content = redactRuntimeSecretsFromText(decodeUtf8(download.body), config);
        return {
          id: template.id,
          fileName: basename(template.downloadUrl),
          hasKeyPlaceholder: /AGENTX_MCP_KEY|ALI_AGENTX_MCP_KEY|paste-key-here/i.test(content),
          leakedRuntimeSecret: content.includes('[REDACTED]') ? false : mayContainConfiguredSecret(content, config)
        };
      })
    );
    emitResult(
      config,
      {
        templates: templateContents,
        downloads: access.data.downloads,
        placeholderSafe: templateContents.every((item) => item.hasKeyPlaceholder && item.leakedRuntimeSecret === false)
      },
      templateContents.map((item) => `${item.id} | placeholder=${boolText(item.hasKeyPlaceholder)} | leakedSecret=${boolText(item.leakedRuntimeSecret)}`)
    );
    return;
  }

  const templateId = requirePositional(args[1], 'templateId');
  const template = access.data.templates.find((entry) => entry.id === templateId);
  if (!template) {
    throw createCliError('NOT_FOUND', `Template not found: ${templateId}`);
  }
  const download = await client.download({ path: template.downloadUrl });
  const content = redactRuntimeSecretsFromText(decodeUtf8(download.body), config);
  const payload = {
    templateId: template.id,
    label: template.label,
    fileName: basename(template.downloadUrl),
    contentType: template.contentType,
    content
  };
  if (action === 'show') {
    emitContentResult(config, payload, content);
    return;
  }
  if (options.output) {
    await writeOutputFile(options.output, encodeUtf8(content));
    emitResult(config, { ...payload, saved: true }, [`Saved ${template.id} to ${basename(options.output)}`]);
    return;
  }
  emitContentResult(config, payload, content);
}

async function runPrompts(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputPromptsHelp();
    return;
  }
  if (!PROMPT_COMMANDS.includes(action as (typeof PROMPT_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown prompts action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<AdminPromptListResponse>({ path: '/admin/prompts' });
    emitResult(
      config,
      response.data,
      response.data.files.length === 0
        ? ['No prompt files found.']
        : response.data.files.map((file) => `${String(file.path ?? '')} | ${String(file.type ?? '')} | exists=${boolText(file.exists === true)}`)
    );
    return;
  }

  const promptPath = requirePositional(args[1], 'promptPath');
  if (action === 'show') {
    const response = await client.requestJson<AdminPromptReadResponse>({
      path: `/admin/prompts/${encodeURIComponent(promptPath)}`
    });
    const metadata = toPromptMetadata(promptPath, response.data.content, response.data.missing === true);
    emitResult(
      config,
      metadata,
      [
        `Path: ${metadata.path}`,
        `Hash: ${metadata.hash}`,
        `Bytes: ${metadata.bytes}`,
        `Lines: ${metadata.lineCount}`,
        `Missing: ${boolText(metadata.missing)}`
      ]
    );
    return;
  }

  if (action === 'history') {
    const response = await client.requestJson<AdminPromptHistoryResponse>({
      path: `/admin/prompts/${encodeURIComponent(promptPath)}/history`
    });
    const entries = response.data.entries.map((entry) => sanitizePromptHistoryEntry(entry));
    emitResult(
      config,
      { path: promptPath, entries },
      entries.length === 0
        ? ['No prompt history found.']
        : entries.map((entry) => `${String(entry.createdAt ?? '')} | ${String(entry.hash ?? '')} | ${String(entry.username ?? entry.userId ?? '')}`)
    );
    return;
  }

  if (action === 'update') {
    const content = await readRequiredCommandText(options, 'prompt content');
    const nextMeta = toPromptMetadata(promptPath, content, false);
    if (options.dryRun) {
      emitResult(
        config,
        { dryRun: true, action: 'prompts.update', ...nextMeta },
        [`Dry run: prompt update ${promptPath}`, `Hash: ${nextMeta.hash}`, `Bytes: ${nextMeta.bytes}`]
      );
      return;
    }
    requireConfirmation('admin prompts update', options);
    await client.requestJson({
      method: 'PUT',
      path: `/admin/prompts/${encodeURIComponent(promptPath)}`,
      body: { content }
    });
    emitResult(config, { saved: true, ...nextMeta }, [`Saved ${promptPath}`, `Hash: ${nextMeta.hash}`]);
    return;
  }

  const history = await client.requestJson<AdminPromptHistoryResponse>({
    path: `/admin/prompts/${encodeURIComponent(promptPath)}/history`
  });
  const latest = history.data.entries[0];
  if (!latest) {
    throw createCliError('CONFLICT', 'No prompt history available.');
  }
  const rollbackPreview = sanitizePromptHistoryEntry(latest);
  if (options.dryRun) {
    emitResult(
      config,
      { dryRun: true, action: 'prompts.rollback', path: promptPath, target: rollbackPreview },
      [`Dry run: rollback ${promptPath}`, `Target hash: ${String(rollbackPreview.hash ?? '')}`]
    );
    return;
  }
  requireConfirmation('admin prompts rollback', options);
  const response = await client.requestJson<{ rolledBack: boolean; restoredHash?: string }>({
    method: 'POST',
    path: `/admin/prompts/${encodeURIComponent(promptPath)}/rollback`,
    body: {}
  });
  emitResult(
    config,
    { rolledBack: response.data.rolledBack, path: promptPath, restoredHash: response.data.restoredHash ?? rollbackPreview.hash },
    [`Rolled back ${promptPath}`, `Restored hash: ${String(response.data.restoredHash ?? rollbackPreview.hash ?? '')}`]
  );
}

async function runUploadsReview(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputUploadsReviewHelp();
    return;
  }
  if (!UPLOAD_REVIEW_COMMANDS.includes(action as (typeof UPLOAD_REVIEW_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown uploads-review action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<TicketListResponse>({
      path: '/admin/tickets',
      query: {
        type: 'datasheet_submission',
        ...(options.status ? { status: options.status } : {}),
        ...(options.keyword ?? options.q ? { keyword: (options.keyword ?? options.q)! } : {}),
        ...(parseOptionalPositiveIntOption(options.limit, 'limit') !== undefined ? { limit: parseOptionalPositiveIntOption(options.limit, 'limit') } : {}),
        ...(parseOptionalNonNegativeIntOption(options.offset, 'offset') !== undefined ? { offset: parseOptionalNonNegativeIntOption(options.offset, 'offset') } : {})
      }
    });
    emitResult(
      config,
      response.data,
      response.data.items.length === 0
        ? ['No datasheet uploads found.']
        : response.data.items.map(renderTicketSummaryLine)
    );
    return;
  }

  const ticketNo = requirePositional(args[1], 'ticketNo');
  if (action === 'get') {
    const response = await client.requestJson<AdminTicketResponse>({
      path: `/admin/tickets/${encodeURIComponent(ticketNo)}`
    });
    emitResult(config, response.data, renderTicketDetails(response.data.ticket));
    return;
  }

  const statusMap: Record<string, string> = {
    accept: 'accepted',
    reject: 'rejected',
    'needs-more-info': 'needs_more_info',
    link: 'linked'
  };
  const body: JsonObject = {
    status: statusMap[action],
    ...(nonEmpty(options.publicNote) ? { publicNote: options.publicNote!.trim() } : {}),
    ...(nonEmpty(options.internalNote) ? { internalNote: options.internalNote!.trim() } : {}),
    ...(nonEmpty(options.result) ? { result: options.result!.trim() } : {}),
    ...(action === 'needs-more-info' ? { needsMoreInfo: true } : {}),
    ...(nonEmpty(options.note) ? { bindingNote: options.note!.trim() } : {}),
    ...buildMetadataCandidateBody(options)
  };
  if (options.dryRun) {
    const current = await client.requestJson<AdminTicketResponse>({
      path: `/admin/tickets/${encodeURIComponent(ticketNo)}`
    });
    emitResult(
      config,
      { dryRun: true, action: `uploads-review.${action}`, ticketNo, body, current: current.data.ticket },
      [`Dry run: ${action} ${ticketNo}`]
    );
    return;
  }
  requireConfirmation(`admin uploads-review ${action}`, options);
  const response = await client.requestJson<AdminTicketResponse>({
    method: 'PUT',
    path: `/admin/tickets/${encodeURIComponent(ticketNo)}/datasheet-review`,
    body
  });
  emitResult(config, response.data, renderTicketDetails(response.data.ticket));
}

async function runMetadata(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputMetadataHelp();
    return;
  }
  if (!METADATA_COMMANDS.includes(action as (typeof METADATA_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown metadata action: ${action}`);
  }

  const ticketNo = requirePositional(args[1], 'ticketNo');
  if (action === 'get-candidate') {
    const response = await client.requestJson<AdminTicketResponse>({
      path: `/admin/tickets/${encodeURIComponent(ticketNo)}`
    });
    const payload = extractMetadataPayload(response.data.ticket);
    emitResult(
      config,
      payload,
      [
        `Ticket: ${ticketNo}`,
        `State: ${String(payload.uploadReviewState ?? '')}`,
        `Binding intent: ${String((payload.bindingIntent as Record<string, unknown> | null)?.intent ?? 'none')}`,
        `Candidate keys: ${Object.keys((payload.metadataCandidate as Record<string, unknown>) ?? {}).filter((key) => key !== 'resolution').join(', ') || 'none'}`
      ]
    );
    return;
  }

  const metadataCandidate =
    action === 'clear-candidate'
      ? {}
      : (await readOptionalJsonInput(options)) ?? buildMetadataCandidateOnly(options);
  if (action !== 'clear-candidate' && Object.keys(metadataCandidate).length === 0) {
    throw createCliError('VALIDATION_ERROR', 'Provide metadata candidate fields via flags or --file/--stdin.');
  }
  if (options.dryRun) {
    emitResult(config, { dryRun: true, action: `metadata.${action}`, ticketNo, metadataCandidate }, [`Dry run: ${action} ${ticketNo}`]);
    return;
  }
  const response = await client.requestJson<AdminTicketResponse>({
    method: 'PUT',
    path: `/admin/tickets/${encodeURIComponent(ticketNo)}/datasheet-review`,
    body: { metadataCandidate }
  });
  const payload = extractMetadataPayload(response.data.ticket);
  emitResult(config, payload, [`Updated metadata candidate for ${ticketNo}`]);
}

async function runCatalog(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const group = args[0];
  if (!group) {
    outputCatalogHelp();
    return;
  }
  if (!CATALOG_GROUPS.includes(group as (typeof CATALOG_GROUPS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown catalog group: ${group}`);
  }

  if (group === 'chips') {
    const action = args[1] ?? 'get';
    if (action !== 'get' && action !== 'set') {
      throw createCliError('VALIDATION_ERROR', `Unknown catalog chips action: ${action}`);
    }
    if (action === 'get') {
      const response = await client.requestJson<Record<string, unknown>>({ path: '/admin/chips' });
      const sanitized = sanitizeChipCatalog(response.data);
      emitResult(
        config,
        sanitized,
        ensureArray<Record<string, unknown>>(sanitized.chips).map((chip) => `${String(chip.id ?? '')} | ${String(chip.label ?? '')}`)
      );
      return;
    }
    const body = await readRequiredJsonInput(options);
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'catalog.chips.set', body: sanitizeChipCatalog(body) }, ['Dry run: catalog chips set']);
      return;
    }
    requireConfirmation('admin catalog chips set', options);
    const response = await client.requestJson<Record<string, unknown>>({
      method: 'PUT',
      path: '/admin/chips',
      body
    });
    emitResult(config, sanitizeChipCatalog(response.data), ['Chip catalog updated.']);
    return;
  }

  if (group === 'chip-access') {
    throw createCliError(
      'VALIDATION_ERROR',
      'admin catalog chip-access has been retired; manage chip grants through admin users resourceGrants.chipIds.'
    );
  }

  const action = args[1];
  if (!action) {
    outputRolesHelp();
    return;
  }
  if (!ROLE_COMMANDS.includes(action as (typeof ROLE_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown catalog roles action: ${action}`);
  }
  if (action === 'list') {
    const response = await client.requestJson<Record<string, unknown>>({ path: '/admin/roles' });
    const roles = isRecord(response.data.roles) ? response.data.roles : {};
    emitResult(
      config,
      response.data,
      Object.keys(roles).length === 0 ? ['No roles found.'] : Object.keys(roles).map((name) => `${name}`)
    );
    return;
  }
  if (action === 'get') {
    const roleName = requirePositional(args[2], 'roleName');
    const response = await client.requestJson<Record<string, unknown>>({
      path: `/admin/roles/${encodeURIComponent(roleName)}`
    });
    emitResult(config, response.data, [`Role: ${roleName}`]);
    return;
  }
  if (action === 'reload') {
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'catalog.roles.reload' }, ['Dry run: roles reload']);
      return;
    }
    await client.requestJson({
      method: 'POST',
      path: '/admin/roles/reload',
      body: {}
    });
    emitResult(config, { reloaded: true }, ['Roles reloaded.']);
    return;
  }
  const roleName = action === 'create' ? undefined : requirePositional(args[2], 'roleName');
  if (action === 'delete') {
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'catalog.roles.delete', roleName }, [`Dry run: delete role ${roleName}`]);
      return;
    }
    requireConfirmation('admin catalog roles delete', options);
    await client.requestJson({
      method: 'DELETE',
      path: `/admin/roles/${encodeURIComponent(roleName!)}`
    });
    emitResult(config, { deleted: true, roleName }, [`Deleted role ${roleName}`]);
    return;
  }
  const body = await readRequiredJsonInput(options);
  if (options.dryRun) {
    emitResult(
      config,
      { dryRun: true, action: `catalog.roles.${action}`, roleName, body },
      [`Dry run: roles ${action}${roleName ? ` ${roleName}` : ''}`]
    );
    return;
  }
  requireConfirmation(`admin catalog roles ${action}`, options);
  const response = await client.requestJson<Record<string, unknown>>({
    method: action === 'create' ? 'POST' : 'PUT',
    path: action === 'create' ? '/admin/roles' : `/admin/roles/${encodeURIComponent(roleName!)}`,
    body
  });
  emitResult(config, response.data, [`Role ${action} completed.`]);
}

async function runAnnouncements(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: AdminCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputAnnouncementsHelp();
    return;
  }
  if (!ANNOUNCEMENT_COMMANDS.includes(action as (typeof ANNOUNCEMENT_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown announcements action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<AnnouncementListResponse>({
      path: '/admin/announcements',
      query: {
        ...(nonEmpty(options.type) ? { type: options.type!.trim() } : {}),
        ...(nonEmpty(options.status) ? { status: options.status!.trim() } : {}),
        ...(nonEmpty(options.visibility) ? { visibility: options.visibility!.trim() } : {}),
        ...(options.active === true ? { active: true } : {}),
        ...(nonEmpty(options.keyword ?? options.q) ? { q: (options.keyword ?? options.q)!.trim() } : {})
      }
    });
    emitResult(
      config,
      response.data,
      response.data.items.length === 0
        ? ['No announcements found.']
        : response.data.items.map((item) => renderAnnouncementLine(item))
    );
    return;
  }

  if (action === 'create') {
    const body = (await readOptionalJsonInput(options)) ?? buildAnnouncementBodyFromFlags(options);
    if (Object.keys(body).length === 0) {
      throw createCliError('VALIDATION_ERROR', 'Provide announcement content via flags or --file/--stdin.');
    }
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'announcements.create', body }, ['Dry run: announcement create']);
      return;
    }
    requireConfirmation('admin announcements create', options);
    const response = await client.requestJson<AnnouncementDetailResponse>({
      method: 'POST',
      path: '/admin/announcements',
      body
    });
    emitResult(config, response.data, [renderAnnouncementLine(response.data.item)]);
    return;
  }

  const announcementId = requirePositional(args[1], 'announcementId');
  if (action === 'get') {
    const response = await client.requestJson<AnnouncementDetailResponse>({
      path: `/admin/announcements/${encodeURIComponent(announcementId)}`
    });
    emitResult(config, response.data, renderAnnouncementDetails(response.data.item));
    return;
  }

  if (action === 'update') {
    const body = (await readOptionalJsonInput(options)) ?? buildAnnouncementBodyFromFlags(options);
    if (Object.keys(body).length === 0) {
      throw createCliError('VALIDATION_ERROR', 'Provide announcement fields via flags or --file/--stdin.');
    }
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'announcements.update', announcementId, body }, ['Dry run: announcement update']);
      return;
    }
    requireConfirmation('admin announcements update', options);
    const response = await client.requestJson<AnnouncementDetailResponse>({
      method: 'PATCH',
      path: `/admin/announcements/${encodeURIComponent(announcementId)}`,
      body
    });
    emitResult(config, response.data, renderAnnouncementDetails(response.data.item));
    return;
  }

  if (action === 'duplicate') {
    if (options.dryRun) {
      emitResult(config, { dryRun: true, action: 'announcements.duplicate', announcementId }, ['Dry run: announcement duplicate']);
      return;
    }
    const response = await client.requestJson<AnnouncementDetailResponse>({
      method: 'POST',
      path: `/admin/announcements/${encodeURIComponent(announcementId)}/duplicate`,
      body: {}
    });
    emitResult(config, response.data, renderAnnouncementDetails(response.data.item));
    return;
  }

  if (options.dryRun) {
    emitResult(config, { dryRun: true, action: `announcements.${action}`, announcementId }, [`Dry run: announcement ${action}`]);
    return;
  }
  requireConfirmation(`admin announcements ${action}`, options);
  const response = await client.requestJson<AnnouncementDetailResponse>({
    method: 'POST',
    path: `/admin/announcements/${encodeURIComponent(announcementId)}/${action}`,
    body: {}
  });
  emitResult(config, response.data, renderAnnouncementDetails(response.data.item));
}

function preferJsonOutput(options: AdminCliOptions): boolean {
  if (typeof options.json === 'boolean') {
    return options.json;
  }
  const envValue = process.env.AGENTX_JSON;
  return typeof envValue === 'string' && ['1', 'true', 'yes', 'on'].includes(envValue.trim().toLowerCase());
}

function emitResult(config: ResolvedCliConfig, data: unknown, lines: string[]): void {
  if (config.json) {
    outputStructuredJson(data);
    return;
  }
  console.log(lines.filter(Boolean).join('\n'));
}

function emitContentResult(config: ResolvedCliConfig, payload: Record<string, unknown>, content: string): void {
  if (config.json) {
    outputStructuredJson(payload);
    return;
  }
  console.log(content);
}

function requirePositional(value: string | undefined, fieldName: string): string {
  const text = value?.trim();
  if (!text) {
    throw createCliError('VALIDATION_ERROR', `${fieldName} is required.`);
  }
  return text;
}

function requireTextOption(value: string | undefined, fieldName: string): string {
  const text = value?.trim();
  if (!text) {
    throw createCliError('VALIDATION_ERROR', `--${fieldName.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required.`);
  }
  return text;
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function parseOptionalPositiveIntOption(value: string | number | undefined, fieldName: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw createCliError('VALIDATION_ERROR', `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalNonNegativeIntOption(value: string | number | undefined, fieldName: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createCliError('VALIDATION_ERROR', `${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}

function parseOptionalIntegerOption(value: string | number | undefined, fieldName: string): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw createCliError('VALIDATION_ERROR', `${fieldName} must be an integer.`);
  }
  return parsed;
}

function normalizeCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireConfirmation(label: string, options: AdminCliOptions): void {
  if (options.yes === true) {
    return;
  }
  throw createCliError('VALIDATION_ERROR', `${label} requires --yes.`);
}

async function requireTargetPassword(options: AdminCliOptions): Promise<string> {
  if (nonEmpty(options.newPassword)) {
    return options.newPassword!.trim();
  }
  if (options.newPasswordStdin === true) {
    const content = await readTextFromStdin();
    if (content.trim()) {
      return content.trim();
    }
  }
  throw createCliError('VALIDATION_ERROR', '--new-password or --new-password-stdin is required.');
}

async function readOptionalJsonInput(options: AdminCliOptions): Promise<JsonObject | undefined> {
  if (!options.file && options.stdin !== true) {
    return undefined;
  }
  return await readRequiredJsonInput(options);
}

async function readRequiredJsonInput(options: AdminCliOptions): Promise<JsonObject> {
  const text = await readRequiredCommandText(options, 'JSON input');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('Expected a JSON object');
    }
    return parsed;
  } catch (error) {
    throw createCliError('VALIDATION_ERROR', `Invalid JSON input: ${error instanceof Error ? error.message : 'parse error'}`);
  }
}

async function readRequiredCommandText(options: AdminCliOptions, label: string): Promise<string> {
  if (nonEmpty(options.content)) {
    return options.content!;
  }
  if (nonEmpty(options.file)) {
    try {
      return await readFile(options.file!.trim(), 'utf8');
    } catch {
      throw createCliError('VALIDATION_ERROR', `Unable to read ${label} file: ${basename(options.file!.trim())}`);
    }
  }
  if (options.stdin === true) {
    const text = await readTextFromStdin();
    if (text.trim()) {
      return text;
    }
  }
  throw createCliError('VALIDATION_ERROR', `Provide ${label} via --content, --file, or --stdin.`);
}

let stdinTextPromise: Promise<string> | null = null;

async function readTextFromStdin(): Promise<string> {
  if (!stdinTextPromise) {
    stdinTextPromise = new Promise((resolve, reject) => {
      if (process.stdin.isTTY) {
        resolve('');
        return;
      }
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
  }
  return stdinTextPromise;
}

function buildUserCreateBodyFromOptions(username: string, password: string, options: AdminCliOptions): JsonObject {
  const body: JsonObject = {
    username,
    password,
    role: nonEmpty(options.role) ?? 'customer'
  };
  if (nonEmpty(options.status)) {
    body.status = options.status!.trim();
  }
  if (nonEmpty(options.expiresAt)) {
    body.expiresAt = options.expiresAt!.trim();
  }
  const modelGrants = normalizeCsvList(options.models);
  if (modelGrants.length > 0) {
    body.modelGrants = modelGrants;
  }
  return body;
}

function buildUserUpdateBodyFromOptions(options: AdminCliOptions): JsonObject {
  const body: JsonObject = {};
  if (nonEmpty(options.role)) {
    body.role = options.role!.trim();
  }
  if (nonEmpty(options.status)) {
    body.status = options.status!.trim();
  }
  if (nonEmpty(options.expiresAt)) {
    body.expiresAt = options.expiresAt!.trim();
  }
  const modelGrants = normalizeCsvList(options.models);
  if (modelGrants.length > 0) {
    body.modelGrants = modelGrants;
  }
  return body;
}

function buildAdminKeyPatch(options: AdminCliOptions): JsonObject {
  const patch: JsonObject = {};
  if (nonEmpty(options.name)) {
    patch.name = options.name!.trim();
  }
  if (nonEmpty(options.expiresAt)) {
    patch.expiresAt = options.expiresAt!.trim();
  }
  const modelGrants = normalizeCsvList(options.models);
  if (modelGrants.length > 0) {
    patch.modelGrants = modelGrants;
  }
  if (Object.keys(patch).length === 0) {
    throw createCliError('VALIDATION_ERROR', 'Provide --name, --expires-at, and/or --models.');
  }
  return patch;
}

function buildModelAuthKeyPatch(options: AdminCliOptions): JsonObject {
  const patch: JsonObject = {};
  const modelGrants = normalizeCsvList(options.models);
  if (modelGrants.length > 0) {
    patch.modelGrants = modelGrants;
  }
  const metadata = buildOptionalJsonGrants();
  if (metadata) {
    Object.assign(patch, metadata);
  }
  return patch;
}

function buildOptionalJsonGrants(): JsonObject | undefined {
  return undefined;
}

function buildMetadataCandidateBody(options: AdminCliOptions): JsonObject {
  const metadataCandidate = buildMetadataCandidateOnly(options);
  return Object.keys(metadataCandidate).length > 0 ? { metadataCandidate } : {};
}

function buildMetadataCandidateOnly(options: AdminCliOptions): JsonObject {
  const candidate: JsonObject = {};
  if (nonEmpty(options.vendor)) candidate.vendor = options.vendor!.trim();
  if (nonEmpty(options.partNumber)) candidate.partNumber = options.partNumber!.trim();
  if (nonEmpty(options.brand)) candidate.brand = options.brand!.trim();
  if (nonEmpty(options.productLine)) candidate.productLine = options.productLine!.trim();
  if (nonEmpty(options.application)) candidate.application = options.application!.trim();
  if (nonEmpty(options.chipId)) candidate.chipId = options.chipId!.trim();
  if (nonEmpty(options.documentId)) candidate.documentId = options.documentId!.trim();
  if (nonEmpty(options.scopePresetId)) candidate.scopePresetId = options.scopePresetId!.trim();
  const applicationTags = normalizeCsvList(options.applicationTags);
  if (applicationTags.length > 0) {
    candidate.applicationTags = applicationTags;
  }
  return candidate;
}

function sanitizeUserRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...value };
  if (Array.isArray(sanitized.mcpKeys)) {
    sanitized.mcpKeys = sanitized.mcpKeys.map((entry) => (isRecord(entry) ? sanitizeAdminKeyRecord(entry) : entry));
  }
  delete sanitized.passwordHash;
  return sanitized;
}

function sanitizeUserMutationPreview(value: Record<string, unknown>): Record<string, unknown> {
  const preview = { ...value };
  if (Object.prototype.hasOwnProperty.call(preview, 'password')) {
    preview.password = '[REDACTED]';
  }
  return preview;
}

function sanitizeAdminKeyRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...value };
  delete sanitized.key;
  return sanitized;
}

function renderUserLine(user: Record<string, unknown>): string {
  return `${String(user.id ?? '')} | ${String(user.username ?? '')} | ${String(user.role ?? '')} | ${String(user.status ?? 'active')}`;
}

function renderUserDetails(user: Record<string, unknown>): string[] {
  return [
    `User: ${String(user.username ?? '')}`,
    `Id: ${String(user.id ?? '')}`,
    `Role: ${String(user.role ?? '')}`,
    `Status: ${String(user.status ?? 'active')}`,
    `Models: ${renderCsv(ensureArray<string>(user.modelGrants ?? user.authorizedModels))}`,
    `Keys: ${String(ensureArray<Record<string, unknown>>(user.mcpKeys).length)}`
  ];
}

function renderKeyLine(key: Record<string, unknown>, prefix = 'Key'): string {
  return `${prefix} ${String(key.id ?? '')} | ${String(key.name ?? '')} | ${String(key.maskedKey ?? '')} | ${String(key.fingerprint ?? '')}`;
}

function renderKeyGrantLine(key: Record<string, unknown>): string {
  return `${String(key.id ?? '')} | ${String(key.name ?? '')} | models=${renderCsv(ensureArray<string>(key.modelGrants))}`;
}

function renderCsv(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function renderLedgerItems(items: Array<Record<string, unknown>>): string[] {
  if (items.length === 0) {
    return ['No credit ledger entries.'];
  }
  return items.map((entry) => {
    const metadata = isRecord(entry.metadata) ? entry.metadata : {};
    const delta = metadata.adjustmentDeltaUnits;
    const deltaText = typeof delta === 'number' ? ` | delta=${delta}` : '';
    return `- ${String(entry.createdAt ?? '')} | ${String(entry.reason ?? '')} | ${String(entry.status ?? '')} | ${String(entry.balanceAfterUnits ?? '')}${deltaText}`;
  });
}

function redactRuntimeSecretsFromText(content: string, config: ResolvedCliConfig): string {
  const secrets = [
    config.auth.mode === 'bearer-token' ? config.auth.token : undefined,
    config.auth.mode === 'mcp-key' ? config.auth.mcpKey : undefined,
    config.auth.mode === 'password' ? config.auth.password : undefined
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  let sanitized = content;
  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  return sanitized;
}

function mayContainConfiguredSecret(content: string, config: ResolvedCliConfig): boolean {
  const secrets = [
    config.auth.mode === 'bearer-token' ? config.auth.token : undefined,
    config.auth.mode === 'mcp-key' ? config.auth.mcpKey : undefined,
    config.auth.mode === 'password' ? config.auth.password : undefined
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return secrets.some((secret) => content.includes(secret));
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8').decode(value);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function writeOutputFile(targetPath: string, body: Uint8Array): Promise<void> {
  try {
    const normalized = targetPath.trim();
    await mkdir(dirname(normalized), { recursive: true });
    await writeFile(normalized, body);
  } catch {
    throw createCliError('SERVER_ERROR', `Unable to write output file: ${basename(targetPath)}`);
  }
}

function toPromptMetadata(promptPath: string, content: string, missing: boolean): Record<string, unknown> {
  return {
    path: promptPath,
    hash: hashPromptContent(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    lineCount: content === '' ? 0 : content.split(/\r?\n/).length,
    missing
  };
}

function sanitizePromptHistoryEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const content = typeof entry.content === 'string' ? entry.content : '';
  return {
    relativePath: entry.relativePath,
    createdAt: entry.createdAt,
    hash: typeof entry.hash === 'string' && entry.hash ? entry.hash : hashPromptContent(content),
    userId: entry.userId,
    username: entry.username,
    role: entry.role
  };
}

function renderTicketSummaryLine(item: Record<string, unknown>): string {
  const review = isRecord(item.uploadReview) ? item.uploadReview : {};
  return `${String(item.ticketNo ?? '')} | ${String(item.status ?? '')} | ${String(review.state ?? '')} | ${String(review.securityScanStatus ?? '')}`;
}

function renderTicketDetails(ticket: Record<string, unknown>): string[] {
  const payload = isRecord(ticket.payload) ? ticket.payload : {};
  const uploadReview = isRecord(payload.uploadReview) ? payload.uploadReview : {};
  const metadataCandidate = isRecord(uploadReview.metadataCandidate) ? uploadReview.metadataCandidate : {};
  return [
    `Ticket: ${String(ticket.ticketNo ?? '')}`,
    `Status: ${String(ticket.status ?? '')}`,
    `Needs more info: ${boolText(ticket.needsMoreInfo === true)}`,
    `Review state: ${String(uploadReview.state ?? '')}`,
    `Security scan: ${String(isRecord(uploadReview.securityScan) ? uploadReview.securityScan.status ?? '' : '')}`,
    `Metadata candidate keys: ${Object.keys(metadataCandidate).filter((key) => key !== 'resolution').join(', ') || 'none'}`
  ];
}

function extractMetadataPayload(ticket: Record<string, unknown>): Record<string, unknown> {
  const payload = isRecord(ticket.payload) ? ticket.payload : {};
  const uploadReview = isRecord(payload.uploadReview) ? payload.uploadReview : {};
  return {
    ticketNo: ticket.ticketNo,
    uploadReviewState: uploadReview.state,
    metadataCandidate: isRecord(uploadReview.metadataCandidate) ? uploadReview.metadataCandidate : {},
    bindingIntent: isRecord(uploadReview.bindingIntent) ? uploadReview.bindingIntent : null
  };
}

function sanitizeChipCatalog(value: Record<string, unknown>): Record<string, unknown> {
  const chips = ensureArray<Record<string, unknown>>(value.chips).map((chip) => {
    const sanitized = { ...chip };
    delete sanitized.workspaceDir;
    return sanitized;
  });
  return {
    ...value,
    knowledgeBaseRoot: '[REDACTED_PATH]',
    chips
  };
}

function buildAnnouncementBodyFromFlags(options: AdminCliOptions): JsonObject {
  const body: JsonObject = {};
  if (nonEmpty(options.id)) body.id = options.id!.trim();
  if (nonEmpty(options.type)) body.type = options.type!.trim();
  if (nonEmpty(options.title)) body.title = options.title!.trim();
  if (nonEmpty(options.summary)) body.summary = options.summary!.trim();
  if (nonEmpty(options.body)) body.body = options.body!.trim();
  if (nonEmpty(options.visibility)) body.visibility = options.visibility!.trim();
  if (options.requiresLogin === true) body.requiresLogin = true;
  if (options.pinned === true) body.pinned = true;
  return body;
}

function renderAnnouncementLine(item: Record<string, unknown>): string {
  return `${String(item.id ?? '')} | ${String(item.type ?? '')} | ${String(item.status ?? '')} | ${String(item.title ?? '')}`;
}

function renderAnnouncementDetails(item: Record<string, unknown>): string[] {
  return [
    `Id: ${String(item.id ?? '')}`,
    `Type: ${String(item.type ?? '')}`,
    `Status: ${String(item.status ?? '')}`,
    `Title: ${String(item.title ?? '')}`,
    `Revision: ${String(item.revision ?? '')}`
  ];
}

function boolText(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

function outputAdminHelp(): void {
  outputCommandGroupHelp('agentx admin <subcommand>', [
    'Available subcommands:',
    ...ADMIN_COMMANDS.map(([subcommand, text]) => `  ${subcommand.padEnd(15)} ${text}`),
    '',
    'Shared safety gates:',
    '  --yes                        Required for high-risk mutations',
    '  --dry-run                    Preview a mutation without applying it'
  ]);
}

function outputUsersHelp(): void {
  outputCommandGroupHelp('agentx admin users <action>', [
    'Actions:',
    '  list                         List users',
    '  get <userId>                 Show one user',
    '  create <username>            Create a user (--new-password/--new-password-stdin)',
    '  update <userId>              Update a user via flags or --file/--stdin JSON',
    '  delete <userId>              Delete a user (--yes)',
    '  set-role <userId> <role>     Update a user role (--yes)',
    '  password set <userId>        Rotate a user password (--yes)',
    '  mcp-key add <userId>         Create an admin-issued MCP key (--yes)',
    '  mcp-key update <userId> <keyId>',
    '  mcp-key revoke <userId> <keyId> (--yes)'
  ]);
}

function outputCreditsHelp(): void {
  outputCommandGroupHelp('agentx admin credits <action>', [
    'Actions:',
    '  get <userId>                 Show balance and recent ledger',
    '  adjust <userId>              Adjust credits via --delta-units or --balance-units (--reason, --yes)'
  ]);
}

function outputModelAuthHelp(): void {
  outputCommandGroupHelp('agentx admin model-auth <action>', [
    'Actions:',
    '  get <userId> [keyId]         Show user/key grants',
    '  set-user <userId> --models <csv> (--yes)',
    '  clear-user <userId>          Clear user model grants (--yes)',
    '  set-key <userId> <keyId>     Update key grants (--models and/or JSON input, --yes)',
    '  clear-key <userId> <keyId>   Clear key model/resource grants (--yes)'
  ]);
}

function outputMcpTemplatesHelp(): void {
  outputCommandGroupHelp('agentx admin mcp-templates <action>', [
    'Actions:',
    '  list                         List visible templates and packages',
    '  show <templateId>            Print a placeholder-safe template',
    '  download <templateId>        Print or save a placeholder-safe template',
    '  package-check                Verify template placeholders and package metadata'
  ]);
}

function outputPromptsHelp(): void {
  outputCommandGroupHelp('agentx admin prompts <action>', [
    'Actions:',
    '  list                         List prompt files',
    '  show <promptPath>            Show prompt metadata/hash only',
    '  history <promptPath>         Show prompt history metadata only',
    '  update <promptPath>          Update prompt from --content/--file/--stdin (--yes)',
    '  rollback <promptPath>        Restore latest saved prompt history entry (--yes)'
  ]);
}

function outputUploadsReviewHelp(): void {
  outputCommandGroupHelp('agentx admin uploads-review <action>', [
    'Actions:',
    '  list                         List datasheet submission tickets',
    '  get <ticketNo>               Show one datasheet review ticket',
    '  accept <ticketNo>            Mark accepted (--yes)',
    '  reject <ticketNo>            Mark rejected (--yes)',
    '  needs-more-info <ticketNo>   Mark needs_more_info (--yes)',
    '  link <ticketNo>              Mark linked (--yes)'
  ]);
}

function outputMetadataHelp(): void {
  outputCommandGroupHelp('agentx admin metadata <action>', [
    'Actions:',
    '  get-candidate <ticketNo>     Show metadataCandidate/bindingIntent',
    '  set-candidate <ticketNo>     Update metadata candidate via flags or JSON input',
    '  clear-candidate <ticketNo>   Clear metadata candidate fields'
  ]);
}

function outputCatalogHelp(): void {
  outputCommandGroupHelp('agentx admin catalog <group> <action>', [
    'Groups:',
    '  chips get|set                Inspect or replace chip catalog (--yes for set)',
    '  chip-access                  Retired; use user resourceGrants.chipIds',
    '  roles list|get|create|update|delete|reload'
  ]);
}

function outputRolesHelp(): void {
  outputCommandGroupHelp('agentx admin catalog roles <action>', [
    'Actions:',
    '  list                         List roles',
    '  get <roleName>               Show one role',
    '  create                       Create from --file/--stdin JSON (--yes)',
    '  update <roleName>            Update from --file/--stdin JSON (--yes)',
    '  delete <roleName>            Delete a role (--yes)',
    '  reload                       Reload roles from disk'
  ]);
}

function outputAnnouncementsHelp(): void {
  outputCommandGroupHelp('agentx admin announcements <action>', [
    'Actions:',
    '  list                         List admin announcement items',
    '  get <announcementId>         Show one announcement',
    '  create                       Create from flags or JSON input (--yes)',
    '  update <announcementId>      Update from flags or JSON input (--yes)',
    '  publish <announcementId>     Publish an item (--yes)',
    '  offline <announcementId>     Offline an item (--yes)',
    '  archive <announcementId>     Archive an item (--yes)',
    '  duplicate <announcementId>   Duplicate into a new draft'
  ]);
}
