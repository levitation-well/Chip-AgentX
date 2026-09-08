import bcrypt from 'bcryptjs';
import { TicketValidationError, sanitizeTicketText } from './sanitize.js';
import type {
  AccountApplicationFields,
  TicketAccountBinding,
  TicketRecord
} from './types.js';
import type { TicketStore } from './store.js';

const USERNAME_PATTERN = /^[A-Za-z0-9_.\-@]{3,64}$/;
const DRAFT_RETENTION_DAYS = 30;

export interface AccountApplicationRequestFields {
  username?: unknown;
  password?: unknown;
  company?: unknown;
  reason?: unknown;
  heardFrom?: unknown;
  occupation?: unknown;
  favoriteFeature?: unknown;
  expectedFeature?: unknown;
  contact?: unknown;
}

export async function parseAccountApplicationRequest(
  body: unknown
): Promise<AccountApplicationFields & { password: string }> {
  if (!isRecord(body)) {
    throw new TicketValidationError('Expected account application object');
  }

  const username = trimText(body.username, 64);
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new TicketValidationError('username must be 3-64 characters using letters, numbers, _, ., -, or @');
  }

  const password = trimPassword(body.password);
  if (!password || password.length < 8 || password.length > 256) {
    throw new TicketValidationError('password must be 8-256 characters');
  }

  return stripUndefined({
    username,
    password,
    company: sanitizeTicketText(body.company, 160),
    reason: sanitizeTicketText(body.reason, 1000),
    heardFrom: sanitizeTicketText(body.heardFrom, 240),
    occupation: sanitizeTicketText(body.occupation, 160),
    favoriteFeature: sanitizeTicketText(body.favoriteFeature, 500),
    expectedFeature: sanitizeTicketText(body.expectedFeature, 500),
    contact: sanitizeTicketText(body.contact, 500)
  }) as unknown as AccountApplicationFields & { password: string };
}

export async function createAccountApplicationTicket(options: {
  ticketStore: TicketStore;
  fields: AccountApplicationFields & { password: string };
  accountBinding?: TicketAccountBinding;
  now?: Date;
}): Promise<TicketRecord> {
  const now = options.now ?? new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const passwordHash = await bcrypt.hash(options.fields.password, 10);
  const { password: _password, ...application } = options.fields;

  return options.ticketStore.createTicket({
    type: 'account_application',
    title: application.username,
    status: 'submitted',
    source: 'public-account-application-form',
    contact: application.contact
      ? { raw: application.contact, company: application.company }
      : application.company
        ? { company: application.company }
        : undefined,
    accountBinding: options.accountBinding,
    payload: {
      application,
      credentialDraft: {
        passwordHash,
        createdAt,
        expiresAt,
        status: 'pending'
      }
    }
  });
}

function trimText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value.trim();
  return text ? text.slice(0, limit) : undefined;
}

function trimPassword(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value.trim();
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
