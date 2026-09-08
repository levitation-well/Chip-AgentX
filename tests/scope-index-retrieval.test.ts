import { describe, it, expect } from 'vitest';
import { buildScopeIndex, parseCandidateChipIds, reauthorizeCandidates } from '../src/scope/index-retrieval.js';
import type { ChipCatalog } from '../src/chips/types.js';

// ============================================================
// 测试夹具
// ============================================================

const mockCatalog: ChipCatalog = {
  knowledgeBaseRoot: '/data/chips',
  chips: [
    {
      id: 'chip-a',
      label: 'Chip Alpha',
      description: '高性能微控制器，适用于工业控制',
      brand: 'BrandX',
      productLines: ['Alpha Series', 'Pro Series'],
      applicationTags: ['motor-control', 'industrial'],
      workspaceDir: '/data/chips/chip-a'
    },
    {
      id: 'chip-b',
      label: 'Chip Beta',
      queryHint: '低功耗蓝牙 SoC',
      brand: 'BrandY',
      productLines: ['BLE Series'],
      applicationTags: ['ble', 'iot'],
      workspaceDir: '/data/chips/chip-b'
    },
    {
      id: 'chip-c',
      label: 'Chip Gamma',
      workspaceDir: '/data/chips/chip-c'
    }
  ]
};

// ============================================================
// buildScopeIndex
// ============================================================

describe('buildScopeIndex', () => {
  it('只返回授权的 chip 行，不含未授权 chip', () => {
    const rows = buildScopeIndex(mockCatalog, ['chip-a', 'chip-b']);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.chipId);
    expect(ids).toContain('chip-a');
    expect(ids).toContain('chip-b');
    expect(ids).not.toContain('chip-c');
  });

  it('chip-a 字段正确：label、brand、productLines、features、summary', () => {
    const rows = buildScopeIndex(mockCatalog, ['chip-a', 'chip-b']);
    const rowA = rows.find((r) => r.chipId === 'chip-a')!;
    expect(rowA.label).toBe('Chip Alpha');
    expect(rowA.brand).toBe('BrandX');
    expect(rowA.productLines).toEqual(['Alpha Series', 'Pro Series']);
    expect(rowA.features).toEqual(['motor-control', 'industrial']);
    expect(rowA.summary).toBe('高性能微控制器，适用于工业控制');
  });

  it('chip-b 无 description 时 summary 回退到 queryHint', () => {
    const rows = buildScopeIndex(mockCatalog, ['chip-a', 'chip-b']);
    const rowB = rows.find((r) => r.chipId === 'chip-b')!;
    expect(rowB.summary).toBe('低功耗蓝牙 SoC');
  });

  it('无 description 也无 queryHint 时 summary 回退到 label', () => {
    const rows = buildScopeIndex(mockCatalog, ['chip-c']);
    const rowC = rows.find((r) => r.chipId === 'chip-c')!;
    expect(rowC.summary).toBe('Chip Gamma');
  });

  it('allowedChipIds 为空时返回空数组', () => {
    const rows = buildScopeIndex(mockCatalog, []);
    expect(rows).toHaveLength(0);
  });

  it('summary 字段优先于 description 进入 INDEX', () => {
    const catalog: ChipCatalog = {
      knowledgeBaseRoot: '/data/chips',
      chips: [
        {
          id: 'chip-s',
          label: 'Chip S',
          summary: 'LED 开短路诊断；PWM 调光；UART-over-CAN',
          description: '外饰灯驱动芯片 datasheet 工作区',
          workspaceDir: '/data/chips/chip-s'
        }
      ]
    };
    const rows = buildScopeIndex(catalog, ['chip-s']);
    expect(rows[0]!.summary).toBe('LED 开短路诊断；PWM 调光；UART-over-CAN');
  });

  it('无 summary 时回退到 description（行为不变）', () => {
    const catalog: ChipCatalog = {
      knowledgeBaseRoot: '/data/chips',
      chips: [{ id: 'chip-d', label: 'Chip D', description: '仅 description', workspaceDir: '/d' }]
    };
    expect(buildScopeIndex(catalog, ['chip-d'])[0]!.summary).toBe('仅 description');
  });
});

// ============================================================
// parseCandidateChipIds
// ============================================================

describe('parseCandidateChipIds', () => {
  it('解析 ```json fence 内的 candidates 数组', () => {
    const text = '请选择候选芯片：\n```json\n{"candidates":[{"chipId":"chip-a","reason":"最佳匹配"},{"chipId":"chip-b","reason":"备选"}]}\n```\n';
    const result = parseCandidateChipIds(text);
    expect(result).toEqual(['chip-a', 'chip-b']);
  });

  it('解析不带语言标注的 ``` fence', () => {
    const text = '```\n{"candidates":[{"chipId":"chip-a"},{"chipId":"chip-b"}]}\n```';
    const result = parseCandidateChipIds(text);
    expect(result).toEqual(['chip-a', 'chip-b']);
  });

  it('解析裸 JSON 对象（无 fence）', () => {
    const text = '分析结果：{"candidates":[{"chipId":"chip-a"}]} 以上。';
    const result = parseCandidateChipIds(text);
    expect(result).toEqual(['chip-a']);
  });

  it('坏输入（无有效 JSON）返回空数组', () => {
    expect(parseCandidateChipIds('这不是 JSON')).toEqual([]);
    expect(parseCandidateChipIds('')).toEqual([]);
    expect(parseCandidateChipIds('{"invalid": true}')).toEqual([]);
  });

  it('重复的 chipId 去重', () => {
    const text = '```json\n{"candidates":[{"chipId":"chip-a"},{"chipId":"chip-a"},{"chipId":"chip-b"}]}\n```';
    const result = parseCandidateChipIds(text);
    expect(result).toEqual(['chip-a', 'chip-b']);
  });

  it('过滤空字符串 chipId', () => {
    const text = '```json\n{"candidates":[{"chipId":""},{"chipId":"chip-a"},{"chipId":"  "}]}\n```';
    const result = parseCandidateChipIds(text);
    expect(result).toEqual(['chip-a']);
  });
});

// ============================================================
// reauthorizeCandidates（关键安全断言）
// ============================================================

describe('reauthorizeCandidates', () => {
  it('越权候选 X 被剔除，只保留授权集合内的候选', () => {
    const result = reauthorizeCandidates(['chip-a', 'chip-x', 'chip-b'], ['chip-a', 'chip-b', 'chip-c']);
    expect(result.kept).toEqual(['chip-a', 'chip-b']);
    expect(result.dropped).toEqual(['chip-x']);
  });

  it('所有候选都在授权集内时 dropped 为空', () => {
    const result = reauthorizeCandidates(['chip-a', 'chip-b'], ['chip-a', 'chip-b', 'chip-c']);
    expect(result.kept).toEqual(['chip-a', 'chip-b']);
    expect(result.dropped).toHaveLength(0);
  });

  it('所有候选都不在授权集内时 kept 为空', () => {
    const result = reauthorizeCandidates(['chip-x', 'chip-y'], ['chip-a', 'chip-b']);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toEqual(['chip-x', 'chip-y']);
  });

  it('候选为空时返回空 kept 和 dropped', () => {
    const result = reauthorizeCandidates([], ['chip-a', 'chip-b']);
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });

  it('trim 后匹配：候选带空格时仍能正确鉴权', () => {
    const result = reauthorizeCandidates([' chip-a ', 'chip-b'], ['chip-a', 'chip-b']);
    expect(result.kept).toEqual(['chip-a', 'chip-b']);
    expect(result.dropped).toHaveLength(0);
  });

  it('去重：重复候选只保留一份', () => {
    const result = reauthorizeCandidates(['chip-a', 'chip-a', 'chip-b'], ['chip-a', 'chip-b', 'chip-c']);
    expect(result.kept).toEqual(['chip-a', 'chip-b']);
    expect(result.dropped).toHaveLength(0);
  });
});
