import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseResourceVisibilityCatalog, type EffectiveAuthorizationSummary } from '../src/security/index.js';
import { ScopeSessionDeniedError } from '../src/scope/query-runner.js';
import {
  buildScopeOptions,
  countChipScopeFiles,
  listAuthorizedChipIds,
  resolveDynamicScopeSelection
} from '../src/scope/scope-options.js';
import { scopeOptionsCatalog } from './fixtures/scope-options-catalog.js';

/**
 * V14 单一事实源：resources.documents[].chipIds 是 chipId -> document 权威映射；
 * 这里镜像 scopeOptionsCatalog 各芯片原有的 chip.documentIds，使既有断言（值不变）
 * 在改用目录派生后依旧成立，同时补一篇 draft 文档验证 V1 剔除未批准文档语义。
 */
const scopeOptionsResources = parseResourceVisibilityCatalog({
  documents: [
    {
      documentId: 'doc-e52131-datasheet',
      label: 'E521.31 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['E521.31']
    },
    {
      documentId: 'doc-e52139-datasheet',
      label: 'E521.39 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['E521.39']
    },
    {
      documentId: 'doc-e52294-datasheet',
      label: 'E522.94 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['E522.94']
    },
    {
      documentId: 'doc-e52296-datasheet',
      label: 'E522.96 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['E522.96']
    },
    {
      documentId: 'doc-e52420-datasheet',
      label: 'E524.20 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['E524.20']
    },
    {
      documentId: 'doc-ind83216-datasheet',
      label: 'iND83216 Datasheet',
      visibility: 'customer',
      status: 'approved',
      chipIds: ['iND83216']
    }
  ],
  scopePresets: []
});

const ALL_CHIP_IDS = ['E521.31', 'E521.39', 'E522.94', 'E522.96', 'E524.20', 'iND83216'];

function makeAuthorization(): EffectiveAuthorizationSummary {
  return {
    subject: { userId: 'user-1', username: 'tester', role: 'customer' },
    usable: true,
    reasonCode: 'allowed',
    safeMessage: 'ok',
    visibilityCeiling: 'customer',
    grants: {
      brands: [],
      productLines: [],
      chipIds: [],
      documentIds: [],
      scopePresetIds: [],
      modelIds: [],
      mcpTools: []
    },
    audit: {
      userId: 'user-1',
      role: 'customer',
      keyFingerprint: 'fp-test',
      reasonCode: 'allowed'
    }
  };
}

/**
 * 与 makeAuthorization() 相同，但额外持有 documentIds: ['*']（等价 internal/admin 模板的通配文档授权）。
 * 文档级授权是独立于 chipIds 的维度（见 tests/scope-resolver.test.ts 的 preset 路径同款设计），
 * 用于验证「已批准文档放行、未批准文档剔除」这条 V1 语义本身，而非被「未授予任何文档」整体挡住。
 */
function makeAuthorizationWithDocumentGrant(): EffectiveAuthorizationSummary {
  const base = makeAuthorization();
  return { ...base, grants: { ...base.grants, documentIds: ['*'] } };
}

describe('listAuthorizedChipIds', () => {
  it('filters chip ids by the predicate', () => {
    const authorized = new Set(['E521.39', 'E522.94']);
    const result = listAuthorizedChipIds(scopeOptionsCatalog, (chipId) => authorized.has(chipId));
    expect(result).toEqual(['E521.39', 'E522.94']);
  });

  it('returns empty when predicate denies everything', () => {
    const result = listAuthorizedChipIds(scopeOptionsCatalog, () => false);
    expect(result).toEqual([]);
  });
});

describe('countChipScopeFiles', () => {
  it('returns 0 for a non-existent directory without throwing', async () => {
    const missing = path.join(tmpdir(), 'scope-options-does-not-exist-xyz', 'nope');
    await expect(countChipScopeFiles(missing)).resolves.toBe(0);
  });
});

describe('buildScopeOptions', () => {
  it('derives product-line groups only for groups containing >=1 authorized chip', () => {
    const authorizedChipIds = ['E521.31', 'E521.39'];
    const options = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds,
      fileCountByChipId: new Map()
    });

    const ambient = options.group.productLines.find((group) => group.value === '氛围灯');
    expect(ambient).toBeDefined();
    expect(ambient?.chipIds).toEqual(['E521.31', 'E521.39']);
    expect(ambient?.label).toBe('氛围灯');
    expect(ambient?.dimension).toBe('productLine');

    // 工业传感分组的唯一芯片 iND83216 未授权 → 分组不出现
    const industrial = options.group.productLines.find((group) => group.value === '工业传感');
    expect(industrial).toBeUndefined();

    // single.chips 仅含已授权芯片
    expect(options.single.chips.map((chip) => chip.chipId)).toEqual(['E521.31', 'E521.39']);
  });

  it('lists brand groups derived from authorized chips only', () => {
    const authorizedChipIds = ['E521.31'];
    const options = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds,
      fileCountByChipId: new Map()
    });
    const brands = options.group.brands.map((group) => group.value);
    expect(brands).toContain('ELMOS');
    expect(brands).not.toContain('iND');
  });

  it('marks tooLarge false at fileCount=200 and true at fileCount=201 (boundary)', () => {
    // 氛围灯组 = E521.31 + E521.39。让两颗之和恰为 200 / 201。
    const at200 = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.31', 'E521.39'],
      fileCountByChipId: new Map([
        ['E521.31', 100],
        ['E521.39', 100]
      ])
    });
    const ambient200 = at200.group.productLines.find((group) => group.value === '氛围灯');
    expect(ambient200?.fileCount).toBe(200);
    expect(ambient200?.tooLarge).toBe(false);

    const at201 = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.31', 'E521.39'],
      fileCountByChipId: new Map([
        ['E521.31', 100],
        ['E521.39', 101]
      ])
    });
    const ambient201 = at201.group.productLines.find((group) => group.value === '氛围灯');
    expect(ambient201?.fileCount).toBe(201);
    expect(ambient201?.tooLarge).toBe(true);
  });

  it('respects a custom threshold for tooLarge', () => {
    const options = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.31', 'E521.39'],
      fileCountByChipId: new Map([
        ['E521.31', 5],
        ['E521.39', 6]
      ]),
      threshold: 10
    });
    const ambient = options.group.productLines.find((group) => group.value === '氛围灯');
    expect(ambient?.fileCount).toBe(11);
    expect(ambient?.tooLarge).toBe(true);
  });

  it('computes global aggregate over all authorized chips', () => {
    const options = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ALL_CHIP_IDS,
      fileCountByChipId: new Map(ALL_CHIP_IDS.map((id, index) => [id, index + 1])),
      threshold: 200
    });
    // 1+2+3+4+5+6 = 21
    expect(options.global.chipIds).toEqual(ALL_CHIP_IDS);
    expect(options.global.fileCount).toBe(21);
    expect(options.global.tooLarge).toBe(false);
  });

  it('uses 0 as default file count for chips missing from the map', () => {
    const options = buildScopeOptions({
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.31'],
      fileCountByChipId: new Map()
    });
    expect(options.single.chips[0]?.fileCount).toBe(0);
    expect(options.single.chips[0]?.productLines).toContain('氛围灯');
    expect(options.single.chips[0]?.brand).toBe('ELMOS');
  });
});

describe('resolveDynamicScopeSelection — zero overreach', () => {
  it('group selection intersects with authorizedChipIds (drops unauthorized sibling)', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.39'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
    });
    expect(selection.status).toBe('allowed');
    expect(selection.allowedChipIds).toEqual(['E521.39']);
    expect(selection.allowedChipIds).not.toContain('E521.31');
    // allowedChipIds ⊆ authorizedChipIds 永真
    for (const chipId of selection.allowedChipIds) {
      expect(['E521.39']).toContain(chipId);
    }
  });

  it('throws ScopeSessionDeniedError when the descriptor targets a fully unauthorized product line (cross-user overreach)', () => {
    expect(() =>
      resolveDynamicScopeSelection({
        authorization: makeAuthorization(),
        catalog: scopeOptionsCatalog,
        authorizedChipIds: ['E521.39'],
        descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '外饰灯' }] }
      })
    ).toThrow(ScopeSessionDeniedError);
  });

  it('throws ScopeSessionDeniedError for single mode without chipId', () => {
    expect(() =>
      resolveDynamicScopeSelection({
        authorization: makeAuthorization(),
        catalog: scopeOptionsCatalog,
        authorizedChipIds: ['E521.39'],
        descriptor: { mode: 'single' }
      })
    ).toThrow(ScopeSessionDeniedError);
  });

  it('throws ScopeSessionDeniedError when single chipId is not authorized', () => {
    expect(() =>
      resolveDynamicScopeSelection({
        authorization: makeAuthorization(),
        catalog: scopeOptionsCatalog,
        authorizedChipIds: ['E521.39'],
        descriptor: { mode: 'single', chipId: 'E522.94' }
      })
    ).toThrow(ScopeSessionDeniedError);
  });

  it('resolves single mode for an authorized chip', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.39'],
      descriptor: { mode: 'single', chipId: 'E521.39' }
    });
    expect(selection.status).toBe('allowed');
    expect(selection.allowedChipIds).toEqual(['E521.39']);
    expect(selection.scopePresetId).toBe('dynamic-single');
  });

  it('global mode resolves to all authorized chips', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ALL_CHIP_IDS,
      descriptor: { mode: 'global' }
    });
    expect(selection.status).toBe('allowed');
    expect(selection.allowedChipIds).toEqual(ALL_CHIP_IDS);
    expect(selection.scopePresetId).toBe('dynamic-global');
  });

  it('global mode still intersects (cannot exceed authorized subset)', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.39', 'E522.94'],
      descriptor: { mode: 'global' }
    });
    expect(selection.allowedChipIds).toEqual(['E521.39', 'E522.94']);
    // catalog 有 6 颗，但只授权 2 颗 → 只能拿到 2 颗
    expect(selection.allowedChipIds).not.toContain('iND83216');
  });

  it('derives allowedDocumentIds (deduped) from resources.documents[].chipIds, not chip.documentIds (V14)', () => {
    // 让 chip.documentIds（chips.json 侧）故意与目录（resources 侧）漂移，证明运行时读路径
    // 权威来源是目录派生映射，而不是逐字读 chip.documentIds。
    const driftedChipCatalog = {
      ...scopeOptionsCatalog,
      chips: scopeOptionsCatalog.chips.map((chip) =>
        chip.id === 'E521.31' ? { ...chip, documentIds: ['stale-legacy-doc-id'] } : chip
      )
    };
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorizationWithDocumentGrant(),
      catalog: driftedChipCatalog,
      resources: scopeOptionsResources,
      authorizedChipIds: ['E521.31', 'E521.39'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
    });
    // 目录派生结果（doc-e52131-datasheet / doc-e52139-datasheet），不是漂移后的 chip.documentIds。
    expect(selection.allowedDocumentIds).toEqual(['doc-e52131-datasheet', 'doc-e52139-datasheet']);
    expect(selection.allowedDocumentIds).not.toContain('stale-legacy-doc-id');
  });

  it('drops an unapproved (draft) document from allowedDocumentIds while keeping approved siblings (V1)', () => {
    // draft 文档也登记进 chip.documentIds（模拟现实：目录侧尚未批准，但曾一并同步进 chips.json），
    // 使得「不校验批准状态」的旧实现也会把它纳入，从而真正证伪 V1 剔除语义（而非巧合般不出现）。
    const chipCatalogWithDraftLinked = {
      ...scopeOptionsCatalog,
      chips: scopeOptionsCatalog.chips.map((chip) =>
        chip.id === 'E521.31' ? { ...chip, documentIds: [...(chip.documentIds ?? []), 'doc-e52131-draft-appendix'] } : chip
      )
    };
    const resourcesWithDraft = parseResourceVisibilityCatalog({
      documents: [
        {
          documentId: 'doc-e52131-datasheet',
          label: 'E521.31 Datasheet',
          visibility: 'customer',
          status: 'approved',
          chipIds: ['E521.31']
        },
        {
          documentId: 'doc-e52131-draft-appendix',
          label: 'E521.31 Draft Appendix',
          visibility: 'customer',
          status: 'draft',
          chipIds: ['E521.31']
        },
        {
          documentId: 'doc-e52139-datasheet',
          label: 'E521.39 Datasheet',
          visibility: 'customer',
          status: 'approved',
          chipIds: ['E521.39']
        }
      ],
      scopePresets: []
    });
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorizationWithDocumentGrant(),
      catalog: chipCatalogWithDraftLinked,
      resources: resourcesWithDraft,
      authorizedChipIds: ['E521.31', 'E521.39'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
    });
    expect(selection.allowedDocumentIds).toEqual(['doc-e52131-datasheet', 'doc-e52139-datasheet']);
    expect(selection.allowedDocumentIds).not.toContain('doc-e52131-draft-appendix');
    // chip 本身仍在授权集合内（只剔文档，不整体拒绝）
    expect(selection.allowedChipIds).toEqual(['E521.31', 'E521.39']);
  });

  it('produces a manifest-consumable ScopeSelectionAllowed shape', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorizationWithDocumentGrant(),
      catalog: scopeOptionsCatalog,
      resources: scopeOptionsResources,
      authorizedChipIds: ['E521.31', 'E521.39'],
      descriptor: { mode: 'group', groups: [{ dimension: 'productLine', value: '氛围灯' }] }
    });
    // filters 对齐 resolver 形态
    expect(selection.filters.productLines).toEqual(['氛围灯']);
    expect(selection.filters.brands).toEqual([]);
    expect(selection.filters.applications).toEqual([]);
    expect(selection.filters.chipIds).toEqual(['E521.31', 'E521.39']);
    expect(selection.filters.documentIds).toEqual(['doc-e52131-datasheet', 'doc-e52139-datasheet']);
    expect(selection.deniedReasons).toEqual([]);
    expect(selection.workspaceModeCandidate).toBe('pendingWorkspace');
    expect(selection.authorizationDecision.allowed).toBe(true);
    expect(selection.authorizationDecision.reasonCode).toBe('allowed');
    expect(selection.audit.reasonCode).toBe('allowed');
    expect(selection.audit.userId).toBe('user-1');
    expect(selection.audit.role).toBe('customer');
    expect(selection.audit.entryPoint).toBe('web');
    expect(selection.requiredGrantCounts.chipIds).toBe(2);
    // scopeId 安全化：dynamic-group + 安全化分组值
    expect(selection.scopeId).toMatch(/^dynamic-group/);
    expect(selection.scopeId).toMatch(/^[a-z0-9-]+$/);
  });

  it('resolves brand-dimension groups', () => {
    const selection = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog: scopeOptionsCatalog,
      authorizedChipIds: ['E521.31', 'E521.39', 'E522.94'],
      descriptor: { mode: 'group', groups: [{ dimension: 'brand', value: 'ELMOS' }] }
    });
    expect(selection.allowedChipIds).toEqual(['E521.31', 'E521.39', 'E522.94']);
    expect(selection.filters.brands).toEqual(['ELMOS']);
    expect(selection.filters.productLines).toEqual([]);
  });
});

describe('application dimension', () => {
  const catalog = scopeOptionsCatalog;
  const authorizedChipIds = ['E521.31', 'E521.39', 'E522.94', 'E522.96', 'E524.20', 'iND83216'];
  const fileCountByChipId = new Map<string, number>();

  it('buildScopeOptions aggregates application groups from applicationTags', () => {
    const options = buildScopeOptions({ catalog, authorizedChipIds, fileCountByChipId });
    const ambient = options.group.applications.find((a) => a.value === '氛围灯');
    expect(ambient).toBeTruthy();
    expect(ambient!.dimension).toBe('application');
    expect(ambient!.chipIds.length).toBeGreaterThan(0);
    // 氛围灯 = E521.31 + E521.39
    expect(ambient!.chipIds).toContain('E521.31');
    expect(ambient!.chipIds).toContain('E521.39');
    // 外饰灯与工业传感也应当存在
    const exterior = options.group.applications.find((a) => a.value === '外饰灯');
    expect(exterior).toBeTruthy();
    const industrial = options.group.applications.find((a) => a.value === '工业传感');
    expect(industrial).toBeTruthy();
  });

  it('buildScopeOptions omits application groups from unauthorized chips', () => {
    const options = buildScopeOptions({
      catalog,
      authorizedChipIds: ['E521.31', 'E521.39'], // 只授权氛围灯芯片
      fileCountByChipId
    });
    const ambient = options.group.applications.find((a) => a.value === '氛围灯');
    expect(ambient).toBeTruthy();
    // 外饰灯芯片未授权，外饰灯分组不应出现
    const exterior = options.group.applications.find((a) => a.value === '外饰灯');
    expect(exterior).toBeUndefined();
  });

  it('resolveDynamicScopeSelection resolves an application group', () => {
    const sel = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog,
      authorizedChipIds,
      descriptor: { mode: 'group', groups: [{ dimension: 'application', value: '氛围灯' }] }
    });
    expect(sel.allowedChipIds.length).toBeGreaterThan(0);
    expect(sel.allowedChipIds).toContain('E521.31');
    expect(sel.allowedChipIds).toContain('E521.39');
    expect(sel.filters.applications).toContain('氛围灯');
  });

  it('resolveDynamicScopeSelection application group still intersects with authorizedChipIds (zero overreach)', () => {
    const sel = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog,
      authorizedChipIds: ['E521.39'], // 只有一颗氛围灯授权
      descriptor: { mode: 'group', groups: [{ dimension: 'application', value: '氛围灯' }] }
    });
    // 氛围灯有两颗（E521.31 + E521.39），但只有 E521.39 授权
    expect(sel.allowedChipIds).toEqual(['E521.39']);
    expect(sel.allowedChipIds).not.toContain('E521.31');
    expect(sel.filters.applications).toContain('氛围灯');
  });

  it('createDynamicScopeId includes application in the scope token', () => {
    const sel = resolveDynamicScopeSelection({
      authorization: makeAuthorization(),
      catalog,
      authorizedChipIds,
      descriptor: { mode: 'group', groups: [{ dimension: 'application', value: '氛围灯' }] }
    });
    // scopeId 应以 dynamic-group 开头，且为合法小写字母数字连字符串
    expect(sel.scopeId).toMatch(/^dynamic-group/);
    expect(sel.scopeId).toMatch(/^[a-z0-9-]+$/);
  });
});
