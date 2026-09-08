/**
 * 范围选择器单测 fixture：覆盖氛围灯 / 外饰灯 / ind 三类分组，
 * workspaceDir 使用相对路径占位（纯函数单测不需要目录真实存在）。
 */
import type { ChipCatalog } from '../../src/chips/index.js';

export const scopeOptionsCatalog: ChipCatalog = {
  knowledgeBaseRoot: './knowledge-bases',
  chips: [
    // ── 氛围灯 ──────────────────────────────────────────────────────────
    {
      id: 'E521.31',
      label: 'E521.31',
      description: 'ELMOS E521.31 氛围灯驱动芯片 datasheet markdown 工作区。',
      queryHint: '适用于 E521.31 寄存器、诊断、应用说明及 datasheet 问题。',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['Elmos 灯光', '氛围灯'],
      applicationTags: ['氛围灯'],
      documentIds: ['doc-e52131-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['E521.31 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/E521.31'
    },
    {
      id: 'E521.39',
      label: 'E521.39',
      description: 'ELMOS E521.39 氛围灯驱动芯片 datasheet markdown 工作区。',
      queryHint: '适用于 E521.39 寄存器、诊断、应用说明及 datasheet 问题。',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['Elmos 灯光', '氛围灯'],
      applicationTags: ['氛围灯'],
      documentIds: ['doc-e52139-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['E521.39 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/E521.39'
    },
    // ── 外饰灯 ──────────────────────────────────────────────────────────
    {
      id: 'E522.94',
      label: 'E522.94',
      description: 'ELMOS E522.94 外饰灯驱动芯片 datasheet markdown 工作区。',
      queryHint: '适用于 E522.94 寄存器、诊断、应用说明及 datasheet 问题。',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['Elmos 灯光', '外饰灯'],
      applicationTags: ['外饰灯'],
      documentIds: ['doc-e52294-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['E522.94 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/E522.94'
    },
    {
      id: 'E522.96',
      label: 'E522.96',
      description: 'ELMOS E522.96 外饰灯驱动芯片 datasheet markdown 工作区。',
      queryHint: '适用于 E522.96 寄存器、诊断、应用说明及 datasheet 问题。',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['Elmos 灯光', '外饰灯'],
      applicationTags: ['外饰灯'],
      documentIds: ['doc-e52296-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['E522.96 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/E522.96'
    },
    {
      id: 'E524.20',
      label: 'E524.20',
      description: 'ELMOS E524.20 外饰灯驱动芯片 datasheet markdown 工作区。',
      queryHint: '适用于 E524.20 寄存器、诊断、应用说明及 datasheet 问题。',
      brand: 'ELMOS',
      brandAliases: ['ELMOS Semiconductor'],
      productLines: ['Elmos 灯光', '外饰灯'],
      applicationTags: ['外饰灯'],
      documentIds: ['doc-e52420-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['E524.20 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/E524.20'
    },
    // ── ind（非灯光） ──────────────────────────────────────────────────
    {
      id: 'iND83216',
      label: 'iND83216',
      description: 'iND83216 工业传感芯片 datasheet markdown 工作区。',
      queryHint: '适用于 iND83216 寄存器、应用说明及 datasheet 问题。',
      brand: 'iND',
      brandAliases: undefined,
      productLines: ['工业传感'],
      applicationTags: ['工业传感'],
      documentIds: ['doc-ind83216-datasheet'],
      permissionTags: ['datasheet'],
      sourceLabels: ['iND83216 datasheet markdown'],
      workspaceDir: 'fixtures/datasheets/iND83216'
    }
  ]
};
