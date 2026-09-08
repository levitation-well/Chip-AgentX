/**
 * V14 单一事实源：文档↔芯片映射从资源目录派生。
 *
 * 权威来源是 resources.documents[].chipIds（反向派生成 chipId → documents），
 * 而非 chip.documentIds。此测试锁定纯函数 documentsForChip / deriveChipDocumentMap 的行为。
 */
import { describe, expect, it } from 'vitest';
import { parseResourceVisibilityCatalog } from '../src/security/index.js';
import {
  deriveChipDocumentMap,
  documentsForChip,
  filterWholeWorkspaceAuthorizedChipIds
} from '../src/scope/document-chip-map.js';

function makeCatalog() {
  return parseResourceVisibilityCatalog({
    documents: [
      {
        documentId: 'D1',
        label: 'Doc 1',
        visibility: 'customer',
        status: 'approved',
        chipIds: ['E521.31']
      },
      {
        documentId: 'D2',
        label: 'Doc 2',
        visibility: 'customer',
        status: 'approved',
        chipIds: ['E521.31', 'E521.39']
      }
    ],
    scopePresets: []
  });
}

describe('documentsForChip / deriveChipDocumentMap (V14)', () => {
  it('derives the documents attached to a chip from documents[].chipIds', () => {
    const catalog = makeCatalog();
    const forE52131 = documentsForChip(catalog, 'E521.31').map((doc) => doc.documentId);
    const forE52139 = documentsForChip(catalog, 'E521.39').map((doc) => doc.documentId);
    expect(forE52131).toEqual(['D1', 'D2']);
    expect(forE52139).toEqual(['D2']);
  });

  it('returns an empty list for a chip no document references', () => {
    const catalog = makeCatalog();
    expect(documentsForChip(catalog, 'UNKNOWN')).toEqual([]);
  });

  it('tolerates a null/undefined catalog without throwing', () => {
    expect(documentsForChip(null, 'E521.31')).toEqual([]);
    expect(documentsForChip(undefined, 'E521.31')).toEqual([]);
  });

  it('deriveChipDocumentMap indexes every referenced chip once, preserving catalog document order', () => {
    const catalog = makeCatalog();
    const map = deriveChipDocumentMap(catalog);
    expect([...map.keys()].sort()).toEqual(['E521.31', 'E521.39']);
    expect(map.get('E521.31')?.map((doc) => doc.documentId)).toEqual(['D1', 'D2']);
    expect(map.get('E521.39')?.map((doc) => doc.documentId)).toEqual(['D2']);
  });
});

describe('filterWholeWorkspaceAuthorizedChipIds', () => {
  it('fails closed when only some catalog documents for a chip are authorized', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-a-public', status: 'approved', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-a-draft', status: 'draft', visibility: 'customer', chipIds: ['A'] }
      ]
    });

    expect(filterWholeWorkspaceAuthorizedChipIds(catalog, ['A'], ['doc-a-public'])).toEqual([]);
  });

  it('keeps cataloged chips only when every registered document is authorized, while preserving uncataloged chips', () => {
    const catalog = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-a-1', status: 'approved', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-a-2', status: 'approved', visibility: 'customer', chipIds: ['A'] }
      ]
    });

    expect(filterWholeWorkspaceAuthorizedChipIds(catalog, ['A', 'B'], ['doc-a-1', 'doc-a-2'])).toEqual(['A', 'B']);
  });
});
