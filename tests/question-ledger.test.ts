import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPersistencePaths, QuestionLedger, type QuestionRecord } from '../src/persistence/index.js';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentx-question-ledger-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createLedger(root: string, now = '2026-05-08T01:00:00.000Z'): QuestionLedger {
  return new QuestionLedger({
    dataDir: root,
    now: () => now
  });
}

function question(overrides: Partial<QuestionRecord> = {}): Omit<QuestionRecord, 'questionId' | 'createdAt'> &
  Partial<Pick<QuestionRecord, 'questionId' | 'createdAt'>> {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    userId: 'user-1',
    username: 'alice',
    role: 'internal',
    chipId: 'E521.39',
    text: 'How should I inspect the datasheet?',
    source: 'web',
    ...overrides
  };
}

describe('QuestionLedger append', () => {
  it('appends a question record', async () => {
    const root = await tempDir();
    const paths = createPersistencePaths(root);
    const ledger = createLedger(root);

    const record = await ledger.appendQuestion(
      question({
        questionId: 'question-1',
        createdAt: '2026-05-08T01:01:00.000Z'
      })
    );

    expect(record).toEqual({
      questionId: 'question-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      userId: 'user-1',
      username: 'alice',
      role: 'internal',
      chipId: 'E521.39',
      text: 'How should I inspect the datasheet?',
      createdAt: '2026-05-08T01:01:00.000Z',
      source: 'web'
    });
    await expect(readFile(paths.questionsFile, 'utf8')).resolves.toContain('"questionId":"question-1"');
  });

  it('generates a questionId and createdAt when omitted', async () => {
    const root = await tempDir();
    const ledger = createLedger(root);

    const record = await ledger.appendQuestion(question());

    expect(record.questionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(record.createdAt).toBe('2026-05-08T01:00:00.000Z');
  });
});

describe('QuestionLedger query', () => {
  it('returns newest questions first', async () => {
    const root = await tempDir();
    const ledger = createLedger(root);
    await ledger.appendQuestion(
      question({
        questionId: 'old',
        text: 'old question',
        createdAt: '2026-05-08T01:00:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'new',
        text: 'new question',
        createdAt: '2026-05-08T02:00:00.000Z'
      })
    );

    const result = await ledger.queryQuestions();

    expect(result).toMatchObject({ total: 2, offset: 0, limit: 100 });
    expect(result.items.map((item) => item.questionId)).toEqual(['new', 'old']);
  });

  it('filters by userId chipId and keyword', async () => {
    const root = await tempDir();
    const ledger = createLedger(root);
    await ledger.appendQuestion(
      question({
        questionId: 'match',
        userId: 'user-1',
        chipId: 'E521.39',
        text: 'Find power pins in the datasheet',
        createdAt: '2026-05-08T01:00:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'wrong-user',
        userId: 'user-2',
        chipId: 'E521.39',
        text: 'Find power pins in the datasheet',
        createdAt: '2026-05-08T01:01:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'wrong-chip',
        userId: 'user-1',
        chipId: 'RISC-V',
        text: 'Find power pins in the datasheet',
        createdAt: '2026-05-08T01:02:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'wrong-keyword',
        userId: 'user-1',
        chipId: 'E521.39',
        text: 'List package options',
        createdAt: '2026-05-08T01:03:00.000Z'
      })
    );

    const result = await ledger.queryQuestions({
      userId: 'user-1',
      chipId: 'E521.39',
      keyword: 'POWER'
    });

    expect(result.total).toBe(1);
    expect(result.items).toEqual([expect.objectContaining({ questionId: 'match' })]);
  });

  it('filters by username role and createdAt range', async () => {
    const root = await tempDir();
    const ledger = createLedger(root);
    await ledger.appendQuestion(
      question({
        questionId: 'too-old',
        username: 'alice',
        role: 'internal',
        createdAt: '2026-05-08T00:59:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'match',
        username: 'alice',
        role: 'internal',
        createdAt: '2026-05-08T01:30:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'wrong-role',
        username: 'alice',
        role: 'customer',
        createdAt: '2026-05-08T01:45:00.000Z'
      })
    );
    await ledger.appendQuestion(
      question({
        questionId: 'too-new',
        username: 'alice',
        role: 'internal',
        createdAt: '2026-05-08T03:00:00.000Z'
      })
    );

    const result = await ledger.queryQuestions({
      username: 'alice',
      role: 'internal',
      from: '2026-05-08T01:00:00.000Z',
      to: '2026-05-08T02:00:00.000Z'
    });

    expect(result.items.map((item) => item.questionId)).toEqual(['match']);
  });

  it('supports offset and caps limit at 500', async () => {
    const root = await tempDir();
    const ledger = createLedger(root);
    for (let i = 0; i < 3; i += 1) {
      await ledger.appendQuestion(
        question({
          questionId: `question-${i}`,
          createdAt: `2026-05-08T01:0${i}:00.000Z`
        })
      );
    }

    const result = await ledger.queryQuestions({ offset: 1, limit: 999 });

    expect(result).toMatchObject({ total: 3, offset: 1, limit: 500 });
    expect(result.items.map((item) => item.questionId)).toEqual(['question-1', 'question-0']);
  });
});
