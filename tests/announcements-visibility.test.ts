import { describe, expect, it } from 'vitest';
import {
  computeEffectiveAuthorizationSummary
} from '../src/security/index.js';
import {
  evaluateAnnouncementVisibility,
  toPublicAnnouncementDto,
  type AnnouncementContentItem
} from '../src/announcements/index.js';

function content(overrides: Partial<AnnouncementContentItem> = {}): AnnouncementContentItem {
  return {
    id: 'announcement-1',
    type: 'announcement',
    status: 'published',
    title: 'Visible announcement',
    summary: 'Summary',
    body: 'Body',
    visibility: 'public',
    requiresLogin: false,
    roleAllowList: [],
    requiredGrants: {},
    pinned: false,
    priority: 0,
    modalBehavior: 'once_per_version',
    revision: 1,
    publishedAt: '2026-05-30T07:00:00.000Z',
    createdAt: '2026-05-30T06:00:00.000Z',
    updatedAt: '2026-05-30T07:00:00.000Z',
    createdBy: 'admin-user-id',
    updatedBy: 'admin-user-id',
    ...overrides
  };
}

describe('announcement visibility resolver', () => {
  it('allows anonymous users only for published public content that does not require login', () => {
    expect(evaluateAnnouncementVisibility(content()).allowed).toBe(true);
    expect(evaluateAnnouncementVisibility(content({ requiresLogin: true }))).toMatchObject({
      allowed: false,
      reasonCode: 'authentication_required'
    });
    expect(evaluateAnnouncementVisibility(content({ visibility: 'customer' }))).toMatchObject({
      allowed: false,
      reasonCode: 'authentication_required'
    });
    expect(evaluateAnnouncementVisibility(content({ status: 'draft' }))).toMatchObject({
      allowed: false,
      reasonCode: 'not_published',
      safeMessage: 'The requested content is not available to this identity.'
    });
  });

  it('combines visibility ceiling, role allow list, and required grants for logged-in users', () => {
    const customer = computeEffectiveAuthorizationSummary({
      user: {
        id: 'customer-1',
        role: 'customer',
        grants: { brands: ['ELMOS'], documentIds: ['release-note'] }
      }
    });
    const partner = computeEffectiveAuthorizationSummary({
      user: {
        id: 'partner-1',
        role: 'partner',
        grants: { brands: ['ELMOS'], documentIds: ['release-note'] }
      }
    });

    expect(
      evaluateAnnouncementVisibility(
        content({
          visibility: 'customer',
          requiresLogin: true,
          roleAllowList: ['customer'],
          requiredGrants: { brands: ['ELMOS'] }
        }),
        { authorization: customer }
      )
    ).toMatchObject({ allowed: true });

    expect(
      evaluateAnnouncementVisibility(content({ visibility: 'internal', requiredGrants: { brands: ['ELMOS'] } }), {
        authorization: customer
      })
    ).toMatchObject({ allowed: false, reasonCode: 'visibility_denied' });

    expect(
      evaluateAnnouncementVisibility(content({ visibility: 'customer', roleAllowList: ['internal'] }), {
        authorization: customer
      })
    ).toMatchObject({ allowed: false, reasonCode: 'role_denied' });

    expect(
      evaluateAnnouncementVisibility(content({ visibility: 'partner', requiredGrants: { brands: ['OTHER'] } }), {
        authorization: partner
      })
    ).toMatchObject({ allowed: false, reasonCode: 'grant_denied' });
  });

  it('filters effective windows and never exposes sourceRef or actor ids in public DTOs', () => {
    const now = new Date('2026-05-30T08:00:00.000Z');
    const future = content({ startsAt: '2026-05-31T00:00:00.000Z' });
    const expired = content({ endsAt: '2026-05-30T07:59:59.000Z' });
    const dto = toPublicAnnouncementDto(
      content({
        sourceRef: {
          kind: 'phase_release_note',
          phase: 42,
          note: 'D:\\repo\\chip-agentx\\.workspace\\private-note.md'
        }
      })
    );
    const serialized = JSON.stringify(dto);

    expect(evaluateAnnouncementVisibility(future, { now })).toMatchObject({ allowed: false, reasonCode: 'not_started' });
    expect(evaluateAnnouncementVisibility(expired, { now })).toMatchObject({ allowed: false, reasonCode: 'expired' });
    expect(serialized).not.toContain('sourceRef');
    expect(serialized).not.toContain('createdBy');
    expect(serialized).not.toContain('updatedBy');
    expect(serialized).not.toContain('.workspace/private-note.md');
    expect(serialized).not.toContain('D:\\repo\\chip-agentx');
  });
});
