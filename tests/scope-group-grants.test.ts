/**
 * TDD 测试：chipIdsForGroupGrants 纯函数
 *
 * 把品牌（brand）/ 产品线（productLine）授权展开成它们授权到的芯片 id 集合。
 * 纯函数、无副作用；'*' 通配匹配全部；去重并保持 catalog 顺序。
 *
 * 覆盖场景：
 * 1. 单个品牌值匹配
 * 2. 产品线数组求交（chip 的 productLines 与授权 productLines 任一相交即命中）
 * 3. 品牌与产品线并集（任一维度命中即纳入）
 * 4. '*' 匹配全部芯片
 * 5. 空授权 → []
 * 6. 有授权但无命中 → []
 * 7. 去重并保持 catalog 顺序
 */
import { describe, expect, it } from 'vitest';
import type { ChipCatalog } from '../src/chips/index.js';
import { chipIdsForGroupGrants } from '../src/scope/group-grants.js';

// 小型内联 catalog：每个 chip 带 brand + productLines
const CATALOG: ChipCatalog = {
  knowledgeBaseRoot: '/tmp/kb',
  chips: [
    { id: 'X1', label: 'X1', brand: 'ELMOS', productLines: ['灯光'], workspaceDir: 'x1' },
    { id: 'X2', label: 'X2', brand: 'ELMOS', productLines: ['灯光', '氛围灯'], workspaceDir: 'x2' },
    { id: 'Y', label: 'Y', brand: 'OTHER', productLines: ['传感'], workspaceDir: 'y' }
  ]
};

describe('chipIdsForGroupGrants', () => {
  it('按单个品牌值匹配命中的芯片', () => {
    expect(chipIdsForGroupGrants({ brands: ['OTHER'] }, CATALOG)).toEqual(['Y']);
  });

  it('按产品线求交（chip.productLines 与授权 productLines 任一相交即命中）', () => {
    expect(chipIdsForGroupGrants({ productLines: ['灯光'] }, CATALOG)).toEqual(['X1', 'X2']);
  });

  it('品牌与产品线并集：任一维度命中即纳入', () => {
    // 品牌 OTHER 命中 Y；产品线 灯光 命中 X1/X2 → 并集 X1,X2,Y（catalog 顺序）
    expect(chipIdsForGroupGrants({ brands: ['OTHER'], productLines: ['灯光'] }, CATALOG)).toEqual([
      'X1',
      'X2',
      'Y'
    ]);
  });

  it("品牌维度 '*' 匹配全部芯片", () => {
    expect(chipIdsForGroupGrants({ brands: ['*'] }, CATALOG)).toEqual(['X1', 'X2', 'Y']);
  });

  it("产品线维度 '*' 匹配全部芯片", () => {
    expect(chipIdsForGroupGrants({ productLines: ['*'] }, CATALOG)).toEqual(['X1', 'X2', 'Y']);
  });

  it('空授权 → 返回空数组', () => {
    expect(chipIdsForGroupGrants({}, CATALOG)).toEqual([]);
    expect(chipIdsForGroupGrants({ brands: [], productLines: [] }, CATALOG)).toEqual([]);
  });

  it('有授权但无命中 → 返回空数组', () => {
    expect(chipIdsForGroupGrants({ brands: ['NOPE'], productLines: ['NONE'] }, CATALOG)).toEqual([]);
  });

  it('去重并保持 catalog 顺序（重复授权值不产生重复芯片）', () => {
    // 灯光 + 氛围灯 都命中 X2，但 X2 只应出现一次
    expect(chipIdsForGroupGrants({ productLines: ['灯光', '氛围灯'] }, CATALOG)).toEqual(['X1', 'X2']);
  });
});
