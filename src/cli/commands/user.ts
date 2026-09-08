/* eslint-disable @typescript-eslint/no-explicit-any */
import { basename, dirname } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolveCliConfig } from '../config.js';
import { createCliError } from '../errors.js';
import { createCliHttpClient } from '../http-client.js';
import { outputCliError, outputCommandGroupHelp, outputStructuredJson } from '../output.js';
import type { CliCommonOptions, HttpClientResponse, ResolvedCliConfig } from '../types.js';

const USER_COMMANDS = [
  ['whoami', 'Show the current account identity summary'],
  ['permissions', 'Show service-authorized models, tools, and resources'],
  ['credits', 'Show balance and recent credit ledger'],
  ['models', 'Show available models and search modes'],
  ['mcp-key', 'List or manage self-service MCP keys'],
  ['template', 'List or fetch MCP access templates'],
  ['tickets', 'List or inspect my tickets'],
  ['uploads', 'Submit or inspect datasheet uploads']
] as const;

const TEMPLATE_COMMANDS = ['list', 'show', 'download', 'package-info'] as const;
const MCP_KEY_COMMANDS = ['list', 'create', 'update', 'revoke', 'regenerate'] as const;
const TICKET_COMMANDS = ['list', 'get'] as const;
const UPLOAD_COMMANDS = ['submit', 'status'] as const;
const TICKET_TYPES = new Set(['feedback', 'datasheet_submission', 'account_application']);

interface UserCliOptions extends CliCommonOptions {
  limit?: string | number;
  offset?: string | number;
  status?: string;
  type?: string;
  needsMoreInfo?: boolean;
  name?: string;
  expiresAt?: string;
  output?: string;
  file?: string | string[];
  title?: string;
  vendor?: string;
  partNumber?: string;
  partNumberOrKeywords?: string;
  keywords?: string;
  sourceNote?: string;
  sourceDeclaration?: string;
  contact?: string;
  note?: string;
  disclaimerAccepted?: boolean;
}

interface AccountUserSummary {
  id?: string;
  username?: string;
  role?: string;
  status?: string;
  localePreference?: string;
  preferredLanguage?: string;
  expiresAt?: string;
}

interface AccountPermissionsSummary {
  role?: string;
  authorizedModels?: string[];
  availableModels?: Array<Record<string, unknown>>;
  searchModes?: Array<Record<string, unknown>>;
  authorizedTools?: string[];
  resources?: Array<Record<string, unknown>>;
  scopeCatalog?: Array<Record<string, unknown>>;
  selfService?: {
    mcpKeys?: boolean;
    mcpKeyRegenerate?: boolean;
  };
  mcpKeyPolicy?: Record<string, unknown>;
  authorizationSummary?: Record<string, unknown>;
}

interface AccountOverviewResponse {
  user: AccountUserSummary;
  permissions: AccountPermissionsSummary;
  credits: Record<string, unknown>;
  mcpKeys: Array<Record<string, unknown>>;
}

interface SearchModesResponse {
  modes: Array<Record<string, unknown>>;
}

interface CreditsResponse {
  balanceUnits: number;
  ledger: Record<string, unknown>;
}

interface TicketListItem {
  ticketNo: string;
  type: string;
  status: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  needsMoreInfo: boolean;
  uploadReview?: {
    state?: string;
    securityScanStatus?: string;
    securityScanSummary?: string;
  };
}

interface TicketListResponse {
  items: TicketListItem[];
  total: number;
  offset: number;
  limit: number;
}

interface PublicTicketResponse {
  ticket: {
    ticketNo: string;
    type: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    publicNote?: string;
    needsMoreInfo: boolean;
    result?: string;
  };
}

interface McpKeyMutationResponse {
  key: Record<string, unknown>;
  secret?: string;
}

interface McpKeyListResponse {
  keys: Array<Record<string, unknown>>;
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

interface UploadSubmitResponse {
  ticket: Record<string, unknown>;
  uploadReview?: Record<string, unknown>;
}

export function registerUser(cli: any) {
  const command = cli.command('user [...args]', 'User self-service HTTP CLI');
  addSharedHttpOptions(command);
  command
    .option('--limit <n>', 'List limit')
    .option('--offset <n>', 'List offset')
    .option('--status <status>', 'Ticket or upload status filter')
    .option('--type <type>', 'Ticket type filter')
    .option('--needs-more-info', 'Filter tickets that need more info')
    .option('--name <name>', 'MCP key name')
    .option('--expires-at <iso>', 'MCP key expiry in ISO-8601')
    .option('--output <file>', 'Write template content to a file')
    .option('--file <path>', 'Attachment file path, repeatable')
    .option('--title <text>', 'Datasheet upload title')
    .option('--vendor <text>', 'Datasheet vendor')
    .option('--part-number <text>', 'Datasheet part number or keywords')
    .option('--part-number-or-keywords <text>', 'Datasheet part number or keywords')
    .option('--keywords <text>', 'Datasheet keywords')
    .option('--source-note <text>', 'Datasheet source note')
    .option('--source-declaration <text>', 'Datasheet source declaration')
    .option('--contact <text>', 'Datasheet submitter contact')
    .option('--note <text>', 'Datasheet note for review')
    .option('--disclaimer-accepted', 'Confirm the datasheet submission declaration')
    .action(async (args: string[] = [], options: UserCliOptions = {}) => {
      const jsonErrors = preferJsonOutput(options);
      try {
        const subcommand = args[0];
        if (!subcommand) {
          outputUserHelp();
          return;
        }

        const known = new Set<string>(USER_COMMANDS.map(([name]) => name));
        if (!known.has(subcommand)) {
          throw createCliError('VALIDATION_ERROR', `Unknown user subcommand: ${subcommand}`);
        }

        const config = await resolveCliConfig(options);
        const client = createCliHttpClient(config);
        await dispatchUserCommand(client, config, subcommand, args.slice(1), options);
      } catch (error) {
        outputCliError(error, jsonErrors);
      }
    });
}

export function addSharedHttpOptions(command: any): void {
  command
    .option('--base-url <url>', 'AgentX HTTP base URL')
    .option('--token <token>', 'Bearer token')
    .option('--token-file <file>', 'Read bearer token from file')
    .option('--username <name>', 'Username for /auth/login')
    .option('--password-stdin', 'Read password from stdin')
    .option('--mcp-key <key>', 'MCP key, sent as bearer Authorization')
    .option('--timeout <ms>', 'HTTP timeout in milliseconds')
    .option('--json', 'Emit machine-readable JSON output');
}

async function dispatchUserCommand(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  subcommand: string,
  args: string[],
  options: UserCliOptions
): Promise<void> {
  if (subcommand === 'whoami') {
    await runWhoami(client, config);
    return;
  }
  if (subcommand === 'permissions') {
    await runPermissions(client, config);
    return;
  }
  if (subcommand === 'credits') {
    await runCredits(client, config, options);
    return;
  }
  if (subcommand === 'models') {
    await runModels(client, config);
    return;
  }
  if (subcommand === 'mcp-key') {
    await runMcpKey(client, config, args, options);
    return;
  }
  if (subcommand === 'template') {
    await runTemplate(client, config, args, options);
    return;
  }
  if (subcommand === 'tickets') {
    await runTickets(client, config, args, options);
    return;
  }
  if (subcommand === 'uploads') {
    await runUploads(client, config, args, options);
    return;
  }
  throw createCliError('VALIDATION_ERROR', `Unknown user subcommand: ${subcommand}`);
}

async function runWhoami(client: ReturnType<typeof createCliHttpClient>, config: ResolvedCliConfig): Promise<void> {
  const account = await fetchAccountOverview(client);
  const payload = {
    user: account.user,
    credits: account.credits,
    mcpKeyPolicy: account.permissions.mcpKeyPolicy,
    selfService: account.permissions.selfService,
    authorizationSummary: account.permissions.authorizationSummary
  };
  emitResult(
    config,
    payload,
    [
      formatHeadline('Identity', account.user.username, account.user.role),
      formatKeyValue('Status', account.user.status ?? 'active'),
      formatKeyValue('Locale', account.user.localePreference ?? account.user.preferredLanguage ?? 'unknown'),
      formatKeyValue('Credits', String(account.credits.balanceUnits ?? 0)),
      formatKeyValue('Expires', account.user.expiresAt ?? 'never'),
      formatKeyValue('Self-service keys', boolText(account.permissions.selfService?.mcpKeys)),
      formatKeyValue('Key regeneration', boolText(account.permissions.selfService?.mcpKeyRegenerate))
    ]
  );
}

async function runPermissions(client: ReturnType<typeof createCliHttpClient>, config: ResolvedCliConfig): Promise<void> {
  const account = await fetchAccountOverview(client);
  const permissions = account.permissions;
  const resources = ensureArray<Record<string, unknown>>(permissions.resources);
  const scopeCatalog = ensureArray<Record<string, unknown>>(permissions.scopeCatalog);
  emitResult(
    config,
    permissions,
    [
      formatHeadline('Permissions', account.user.username, permissions.role),
      formatListLine('Models', ensureArray<string>(permissions.authorizedModels)),
      formatListLine('Tools', ensureArray<string>(permissions.authorizedTools)),
      formatKeyValue('Resources', String(resources.length)),
      ...resources.map((resource) => `- ${String(resource.type ?? 'resource')}:${String(resource.id ?? '')} ${String(resource.label ?? '')}`.trim()),
      formatKeyValue('Scope presets', String(scopeCatalog.length)),
      ...scopeCatalog.map((item) => `- ${String(item.id ?? '')} ${String(item.label ?? '')}`.trim())
    ]
  );
}

async function runCredits(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  options: UserCliOptions
): Promise<void> {
  const limit = parseOptionalPositiveIntOption(options.limit, 'limit');
  const response = await client.requestJson<CreditsResponse>({
    path: '/api/account/credits',
    query: limit ? { limit } : undefined
  });
  emitResult(
    config,
    response.data,
    [
      formatKeyValue('Balance', String(response.data.balanceUnits)),
      formatKeyValue('Entries', String(Number((response.data.ledger as Record<string, unknown>)?.total ?? 0))),
      ...renderLedgerItems((response.data.ledger as Record<string, unknown>)?.items)
    ]
  );
}

async function runModels(client: ReturnType<typeof createCliHttpClient>, config: ResolvedCliConfig): Promise<void> {
  const [accountResponse, searchResponse] = await Promise.all([
    client.requestJson<AccountOverviewResponse>({ path: '/api/account' }),
    client.requestJson<SearchModesResponse>({ path: '/api/search-modes' })
  ]);
  const payload = {
    models: accountResponse.data.permissions.availableModels ?? [],
    authorizedModels: accountResponse.data.permissions.authorizedModels ?? [],
    searchModes: searchResponse.data.modes ?? []
  };
  emitResult(
    config,
    payload,
    [
      formatListLine('Authorized models', ensureArray<string>(payload.authorizedModels)),
      'Available models:',
      ...ensureArray<Record<string, unknown>>(payload.models).map((model) =>
        `- ${String(model.id ?? '')} | ${String(model.label ?? '')} | ${String(model.mode ?? '')} | ${String(model.creditUnits ?? '')} units`
      ),
      'Search modes:',
      ...ensureArray<Record<string, unknown>>(payload.searchModes).map((mode) => {
        const reasons = ensureArray<Record<string, unknown>>(mode.disabledReasons).map((reason) => String(reason.code ?? '')).filter(Boolean);
        const availability = mode.available === false ? `disabled${reasons.length ? ` (${reasons.join(', ')})` : ''}` : 'available';
        return `- ${String(mode.id ?? '')} | ${String(mode.modelLabel ?? '')} | ${availability}`;
      })
    ]
  );
}

async function runMcpKey(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: UserCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputMcpKeyHelp();
    return;
  }
  if (!MCP_KEY_COMMANDS.includes(action as (typeof MCP_KEY_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown mcp-key action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<McpKeyListResponse>({ path: '/api/account/mcp-keys' });
    emitResult(
      config,
      response.data,
      ensureArray<Record<string, unknown>>(response.data.keys).length === 0
        ? ['No MCP keys found.']
        : ensureArray<Record<string, unknown>>(response.data.keys).map((key) => renderMcpKeyLine(key))
    );
    return;
  }

  if (action === 'create') {
    const name = requireTextOption(options.name, 'name');
    const response = await client.requestJson<McpKeyMutationResponse>({
      method: 'POST',
      path: '/api/account/mcp-keys',
      body: buildMcpKeyMutationBody(name, options.expiresAt)
    });
    const sanitized = sanitizeCreateOrRegenerateKey(response);
    emitResult(config, sanitized, [renderSanitizedKeyLine('Created', sanitized)]);
    return;
  }

  const keyId = requirePositional(args[1], 'keyId');
  if (action === 'update') {
    const patch = buildMcpKeyPatch(options);
    const response = await client.requestJson<{ key: Record<string, unknown> }>({
      method: 'PUT',
      path: `/api/account/mcp-keys/${encodeURIComponent(keyId)}`,
      body: patch
    });
    emitResult(config, response.data, [renderMcpKeyLine(response.data.key, 'Updated')]);
    return;
  }

  if (action === 'revoke') {
    await client.requestJson({
      method: 'DELETE',
      path: `/api/account/mcp-keys/${encodeURIComponent(keyId)}`
    });
    emitResult(config, { keyId, revoked: true }, [`Revoked ${keyId}`]);
    return;
  }

  if (action === 'regenerate') {
    const response = await client.requestJson<McpKeyMutationResponse>({
      method: 'POST',
      path: `/api/account/mcp-keys/${encodeURIComponent(keyId)}/regenerate`
    });
    const sanitized = sanitizeCreateOrRegenerateKey(response);
    emitResult(config, sanitized, [renderSanitizedKeyLine('Regenerated', sanitized)]);
    return;
  }
}

async function runTemplate(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: UserCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputTemplateHelp();
    return;
  }
  if (!TEMPLATE_COMMANDS.includes(action as (typeof TEMPLATE_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown template action: ${action}`);
  }

  const access = await client.requestJson<AccessCenterResponse>({ path: '/api/mcp/access-center' });
  if (action === 'list') {
    emitResult(
      config,
      { templates: access.data.templates },
      access.data.templates.map((template) => `${template.id} | ${template.clientType ?? 'unknown'} | ${template.label}`)
    );
    return;
  }

  if (action === 'package-info') {
    emitResult(
      config,
      { downloads: access.data.downloads, capabilities: access.data.capabilities, limits: access.data.limits },
      access.data.downloads.length === 0
        ? ['No packages available.']
        : access.data.downloads.map((item) => `${item.id} | ${item.label} | ${basename(item.downloadUrl)}`)
    );
    return;
  }

  const templateId = requirePositional(args[1], 'templateId');
  const template = access.data.templates.find((entry) => entry.id === templateId);
  if (!template) {
    throw createCliError('NOT_FOUND', `Template not found: ${templateId}`);
  }

  const downloaded = await client.download({ path: template.downloadUrl });
  const fileName = basename(template.downloadUrl);
  const content = redactRuntimeSecretsFromTemplate(decodeUtf8(downloaded.body), config);
  const payload = {
    templateId: template.id,
    label: template.label,
    clientType: template.clientType,
    contentType: template.contentType,
    fileName,
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

async function runTickets(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: UserCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputTicketsHelp();
    return;
  }
  if (!TICKET_COMMANDS.includes(action as (typeof TICKET_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown tickets action: ${action}`);
  }

  if (action === 'list') {
    const response = await client.requestJson<TicketListResponse>({
      path: '/api/my/tickets',
      query: buildTicketListQuery(options)
    });
    emitResult(config, response.data, renderTicketList(response.data.items));
    return;
  }

  const ticketNo = requirePositional(args[1], 'ticketNo');
  const detail = await getOwnedTicketDetail(client, ticketNo);
  emitResult(
    config,
    detail,
    [
      renderTicketLine(detail.summary),
      formatKeyValue('Needs more info', boolText(detail.publicTicket.needsMoreInfo)),
      ...(detail.publicTicket.publicNote ? [formatKeyValue('Public note', detail.publicTicket.publicNote)] : []),
      ...(detail.publicTicket.result ? [formatKeyValue('Result', detail.publicTicket.result)] : [])
    ]
  );
}

async function runUploads(
  client: ReturnType<typeof createCliHttpClient>,
  config: ResolvedCliConfig,
  args: string[],
  options: UserCliOptions
): Promise<void> {
  const action = args[0];
  if (!action) {
    outputUploadsHelp();
    return;
  }
  if (!UPLOAD_COMMANDS.includes(action as (typeof UPLOAD_COMMANDS)[number])) {
    throw createCliError('VALIDATION_ERROR', `Unknown uploads action: ${action}`);
  }

  if (action === 'submit') {
    const title = requireTextOption(options.title, 'title');
    const attachmentPaths = normalizeStringArray(options.file);
    if (attachmentPaths.length === 0) {
      throw createCliError('VALIDATION_ERROR', 'At least one --file is required.');
    }
    if (options.disclaimerAccepted !== true) {
      throw createCliError('VALIDATION_ERROR', '--disclaimer-accepted is required.');
    }

    const fields = [
      { name: 'title', value: title },
      ...optionalField('vendor', options.vendor),
      ...optionalField('partNumberOrKeywords', firstNonEmpty(options.partNumberOrKeywords, options.partNumber, options.keywords)),
      ...optionalField('sourceNote', options.sourceNote),
      ...optionalField('sourceDeclaration', options.sourceDeclaration),
      ...optionalField('contact', options.contact),
      ...optionalField('note', options.note),
      { name: 'disclaimerAccepted', value: 'true' }
    ];
    const attachments = await Promise.all(
      attachmentPaths.map(async (filePath) => {
        try {
          return {
            name: 'attachments',
            value: new Uint8Array(await readFile(filePath)),
            filename: basename(filePath)
          };
        } catch {
          throw createCliError('VALIDATION_ERROR', `Unable to read upload file: ${basename(filePath)}`);
        }
      })
    );
    const response = await client.requestMultipart<UploadSubmitResponse>({
      path: '/api/tickets/datasheet',
      fields: [...fields, ...attachments]
    });
    emitResult(
      config,
      response.data,
      [
        formatKeyValue('Ticket', String(response.data.ticket.ticketNo ?? '')),
        formatKeyValue('Status', String(response.data.ticket.status ?? '')),
        formatKeyValue('Review state', String(response.data.uploadReview?.state ?? '')),
        formatKeyValue('Security scan', String(response.data.uploadReview?.securityScanStatus ?? ''))
      ]
    );
    return;
  }

  const ticketNo = args[1];
  if (ticketNo) {
    const detail = await getOwnedTicketDetail(client, ticketNo, 'datasheet_submission');
    emitResult(
      config,
      detail,
      [
        renderTicketLine(detail.summary),
        ...(detail.summary.uploadReview?.state ? [formatKeyValue('Review state', detail.summary.uploadReview.state)] : []),
        ...(detail.summary.uploadReview?.securityScanStatus
          ? [formatKeyValue('Security scan', detail.summary.uploadReview.securityScanStatus)]
          : [])
      ]
    );
    return;
  }

  const response = await client.requestJson<TicketListResponse>({
    path: '/api/my/tickets',
    query: {
      type: 'datasheet_submission',
      ...(buildTicketListQuery(options) ?? {})
    }
  });
  emitResult(config, response.data, renderTicketList(response.data.items));
}

async function fetchAccountOverview(client: ReturnType<typeof createCliHttpClient>): Promise<AccountOverviewResponse> {
  const response = await client.requestJson<AccountOverviewResponse>({ path: '/api/account' });
  return response.data;
}

async function getOwnedTicketDetail(
  client: ReturnType<typeof createCliHttpClient>,
  ticketNo: string,
  type?: string
): Promise<{ summary: TicketListItem; publicTicket: PublicTicketResponse['ticket'] }> {
  const summary = await findOwnedTicket(client, ticketNo, type);
  if (!summary) {
    throw createCliError('NOT_FOUND', type === 'datasheet_submission' ? 'Datasheet upload not found.' : 'Ticket not found.');
  }
  const publicTicket = await client.requestJson<PublicTicketResponse>({
    path: `/api/tickets/${encodeURIComponent(ticketNo)}/public`
  });
  return {
    summary,
    publicTicket: publicTicket.data.ticket
  };
}

async function findOwnedTicket(
  client: ReturnType<typeof createCliHttpClient>,
  ticketNo: string,
  type?: string
): Promise<TicketListItem | undefined> {
  let offset = 0;
  const limit = 100;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const response = await client.requestJson<TicketListResponse>({
      path: '/api/my/tickets',
      query: {
        limit,
        offset,
        ...(type ? { type } : {})
      }
    });
    const body = response.data;
    const matched = body.items.find((item) => item.ticketNo === ticketNo);
    if (matched) {
      return matched;
    }
    total = body.total;
    offset += body.limit;
    if (body.items.length === 0) {
      break;
    }
  }
  return undefined;
}

function buildTicketListQuery(options: UserCliOptions): Record<string, string | number | boolean | undefined> | undefined {
  const limit = parseOptionalPositiveIntOption(options.limit, 'limit');
  const offset = parseOptionalNonNegativeIntOption(options.offset, 'offset');
  const type = options.type?.trim();
  if (type && !TICKET_TYPES.has(type)) {
    throw createCliError('VALIDATION_ERROR', `Unsupported ticket type: ${type}`);
  }
  const query = {
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(type ? { type } : {}),
    ...(options.status ? { status: options.status.trim() } : {}),
    ...(options.needsMoreInfo === true ? { needsMoreInfo: true } : {})
  };
  return Object.keys(query).length > 0 ? query : undefined;
}

function buildMcpKeyMutationBody(name: string, expiresAt?: string): Record<string, string> {
  return {
    name,
    ...(expiresAt ? { expiresAt: expiresAt.trim() } : {})
  };
}

function buildMcpKeyPatch(options: UserCliOptions): Record<string, string> {
  const patch: Record<string, string> = {};
  if (options.name?.trim()) {
    patch.name = options.name.trim();
  }
  if (options.expiresAt?.trim()) {
    patch.expiresAt = options.expiresAt.trim();
  }
  if (Object.keys(patch).length === 0) {
    throw createCliError('VALIDATION_ERROR', 'Provide --name and/or --expires-at.');
  }
  return patch;
}

function sanitizeCreateOrRegenerateKey(response: HttpClientResponse<McpKeyMutationResponse>): Record<string, unknown> {
  const key = response.data.key ?? {};
  return {
    keyId: key.id,
    name: key.name,
    maskedKey: key.maskedKey,
    fingerprint: key.fingerprint,
    expiresAt: key.expiresAt ?? null
  };
}

function renderMcpKeyLine(key: Record<string, unknown>, prefix?: string): string {
  const parts = [
    prefix ?? 'Key',
    String(key.id ?? key.keyId ?? ''),
    String(key.name ?? ''),
    String(key.maskedKey ?? ''),
    String(key.fingerprint ?? '')
  ].filter(Boolean);
  const expiresAt = key.expiresAt ? `expires=${String(key.expiresAt)}` : 'expires=default';
  return `${parts.join(' | ')} | ${expiresAt}`;
}

function renderSanitizedKeyLine(prefix: string, key: Record<string, unknown>): string {
  return `${prefix} ${String(key.keyId ?? '')} | ${String(key.name ?? '')} | ${String(key.maskedKey ?? '')} | ${String(key.fingerprint ?? '')} | expires=${String(key.expiresAt ?? 'default')}`;
}

function renderLedgerItems(items: unknown): string[] {
  const entries = ensureArray<Record<string, unknown>>(items);
  if (entries.length === 0) {
    return ['No credit ledger entries.'];
  }
  return entries.map((entry) =>
    `- ${String(entry.createdAt ?? '')} | ${String(entry.entry ?? '')} | ${String(entry.modelId ?? '-') } | ${String(entry.status ?? '')} | ${String(entry.units ?? 0)} units`
  );
}

function renderTicketList(items: TicketListItem[]): string[] {
  if (items.length === 0) {
    return ['No tickets found.'];
  }
  return items.map(renderTicketLine);
}

function renderTicketLine(item: TicketListItem): string {
  const uploadSuffix = item.uploadReview?.state
    ? ` | upload=${item.uploadReview.state}${item.uploadReview.securityScanStatus ? `/${item.uploadReview.securityScanStatus}` : ''}`
    : '';
  return `${item.ticketNo} | ${item.type} | ${item.status} | ${item.updatedAt}${item.title ? ` | ${item.title}` : ''}${uploadSuffix}`;
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

function preferJsonOutput(options: UserCliOptions): boolean {
  if (typeof options.json === 'boolean') {
    return options.json;
  }
  const envValue = process.env.AGENTX_JSON;
  return typeof envValue === 'string' && ['1', 'true', 'yes', 'on'].includes(envValue.trim().toLowerCase());
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

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const text = value?.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function optionalField(name: string, value: string | undefined): Array<{ name: string; value: string }> {
  return value ? [{ name, value }] : [];
}

function normalizeStringArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.trim()).filter(Boolean);
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function formatHeadline(title: string, username: unknown, role: unknown): string {
  return `${title}: ${String(username ?? 'unknown')} (${String(role ?? 'unknown')})`;
}

function formatKeyValue(label: string, value: string): string {
  return `${label}: ${value}`;
}

function formatListLine(label: string, values: string[]): string {
  return `${label}: ${values.length > 0 ? values.join(', ') : 'none'}`;
}

function boolText(value: unknown): string {
  return value === true ? 'yes' : 'no';
}

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder('utf-8').decode(value);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function redactRuntimeSecretsFromTemplate(content: string, config: ResolvedCliConfig): string {
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

async function writeOutputFile(targetPath: string, body: Uint8Array): Promise<void> {
  try {
    const normalized = targetPath.trim();
    await mkdir(dirname(normalized), { recursive: true });
    await writeFile(normalized, body);
  } catch {
    throw createCliError('SERVER_ERROR', `Unable to write output file: ${basename(targetPath)}`);
  }
}

function outputUserHelp(): void {
  outputCommandGroupHelp('agentx user <subcommand>', [
    'Available subcommands:',
    ...USER_COMMANDS.map(([subcommand, text]) => `  ${subcommand.padEnd(12)} ${text}`),
    '',
    'Shared options:',
    '  --base-url <url>             AgentX HTTP base URL',
    '  --token <token>              Bearer token',
    '  --token-file <file>          Read bearer token from file',
    '  --username <name>            Login username',
    '  --password-stdin             Read login password from stdin',
    '  --mcp-key <key>              Use an MCP key as bearer auth',
    '  --timeout <ms>               HTTP timeout in milliseconds',
    '  --json                       Emit machine-readable JSON output'
  ]);
}

function outputMcpKeyHelp(): void {
  outputCommandGroupHelp('agentx user mcp-key <action>', [
    'Actions:',
    '  list                         List current self-service MCP keys',
    '  create --name <name>         Create a new self-service MCP key',
    '  update <keyId> [options]     Update name and/or expiry',
    '  revoke <keyId>               Revoke an MCP key',
    '  regenerate <keyId>           Rotate an MCP key without printing the secret'
  ]);
}

function outputTemplateHelp(): void {
  outputCommandGroupHelp('agentx user template <action>', [
    'Actions:',
    '  list                         List MCP access templates',
    '  show <templateId>            Print template content',
    '  download <templateId>        Print or save template content',
    '  package-info                 Show packaged client download metadata'
  ]);
}

function outputTicketsHelp(): void {
  outputCommandGroupHelp('agentx user tickets <action>', [
    'Actions:',
    '  list                         List my tickets',
    '  get <ticketNo>               Show one of my tickets without probing other users'
  ]);
}

function outputUploadsHelp(): void {
  outputCommandGroupHelp('agentx user uploads <action>', [
    'Actions:',
    '  submit --title <text> --file <path> --disclaimer-accepted',
    '                               Submit a datasheet upload into the review workflow',
    '  status [ticketNo]            List my datasheet uploads or inspect one upload'
  ]);
}
