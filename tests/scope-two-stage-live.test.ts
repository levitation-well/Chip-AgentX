/**
 * tests/scope-two-stage-live.test.ts
 * TDD: 两阶段真实 deps 工厂 + large 档协调器的单元测试。
 * 规则：
 *   - 不跑真实 claude；adapter 用最小假实现注入。
 *   - 真实临时 dataDir + 真实假 catalog（2 chip 源目录真实存在，各放 1 个 .md）。
 *   - allowed=['A','B','C']，catalog 含 chip A、B；CC stage1 输出含 A、X（越权）、B。
 *   - 断言：usedChipIds=['A','B']，droppedChipIds=['X']；trace 四阶段调用；
 *          .md 文件 copy 进 cwd/<chipId>/。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// ---- 被测模块 ----
import { createLiveTwoStageDeps, runScopeQueryLarge } from '../src/scope/index.js';
import type { TwoStageDeps } from '../src/scope/index.js';

// ---- 类型（仅做 stub 的形状参考） ----
import type { ClaudeCodeConversationAdapter } from '../src/adapters/child-adapter.js';
import type { AdapterState } from '../src/types.js';
import { parseResourceVisibilityCatalog } from '../src/security/index.js';

// ============================================================
// 工具函数
// ============================================================

/** 创建临时目录，afterEach 中注册清理 */
function makeTmpDir(): { dirRef: { value: string }; register: (cleanup: () => Promise<void>) => void } {
  const cleanups: Array<() => Promise<void>> = [];
  return {
    dirRef: { value: '' },
    register: (fn) => cleanups.push(fn),
  };
}

// ============================================================
// 最小假 adapter 工厂
// ============================================================

/**
 * 构造一个假的 ClaudeCodeConversationAdapter。
 * spawn 时异步推送预设的 stage1 数据，write 时推送 stage2 数据。
 */
function makeFakeAdapter(opts: {
  stage1Output: string;
  stage2Output: string;
}): ClaudeCodeConversationAdapter {
  const dataHandlers: Array<(d: string) => void> = [];
  const exitHandlers: Array<(code: number, sig: string) => void> = [];
  const stateHandlers: Array<(s: AdapterState) => void> = [];

  let spawnCount = 0;
  let writeCount = 0;

  function emitTurnEnd(output: string) {
    // 先推送数据
    dataHandlers.forEach((h) => h(output));
    // 再推送 idle 状态
    stateHandlers.forEach((h) =>
      h({ turnState: 'idle', turnCount: spawnCount + writeCount, claudeSessionId: 'fake-session' })
    );
  }

  return {
    spawn(_cwd: string, _env: Record<string, string>, _cols: number, _rows: number, _task: string) {
      spawnCount += 1;
      // 异步推送 stage1 输出 + idle 状态
      setImmediate(() => emitTurnEnd(opts.stage1Output));
    },
    write(_data: string) {
      writeCount += 1;
      // 异步推送 stage2 输出 + idle 状态
      setImmediate(() => emitTurnEnd(opts.stage2Output));
    },
    onData(handler: (d: string) => void) {
      dataHandlers.push(handler);
    },
    onExit(handler: (code: number, sig: string) => void) {
      exitHandlers.push(handler);
    },
    onState(handler: (s: AdapterState) => void) {
      stateHandlers.push(handler);
    },
    removeDataHandler(handler: (d: string) => void) {
      const i = dataHandlers.indexOf(handler);
      if (i > -1) dataHandlers.splice(i, 1);
    },
    removeExitHandler(handler: (code: number, sig: string) => void) {
      const i = exitHandlers.indexOf(handler);
      if (i > -1) exitHandlers.splice(i, 1);
    },
    removeStateHandler(handler: (s: AdapterState) => void) {
      const i = stateHandlers.indexOf(handler);
      if (i > -1) stateHandlers.splice(i, 1);
    },
    kill() {},
    get pid() {
      return undefined;
    },
    get turnState() {
      return 'idle' as const;
    },
    get turnCount() {
      return spawnCount + writeCount;
    },
    claudeSessionId: 'fake-session',
    resumeFirstTurn: false,
  } as unknown as ClaudeCodeConversationAdapter;
}

// ============================================================
// 测试套件
// ============================================================

describe('createLiveTwoStageDeps', () => {
  let tmpDataDir: string;
  let tmpKbRoot: string;
  let chipADir: string;
  let chipBDir: string;

  afterEach(async () => {
    if (tmpDataDir) {
      await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tmpKbRoot) {
      await rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  async function setup() {
    tmpDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-datadir-'));
    tmpKbRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-kb-'));

    // 创建 chip A 和 chip B 源目录，各放 1 个 .md
    chipADir = path.join(tmpKbRoot, 'chip-a-src');
    chipBDir = path.join(tmpKbRoot, 'chip-b-src');
    await mkdir(chipADir, { recursive: true });
    await mkdir(chipBDir, { recursive: true });
    await writeFile(path.join(chipADir, 'datasheet-a.md'), '# Chip A Datasheet\n特性：超低功耗\n');
    await writeFile(path.join(chipBDir, 'datasheet-b.md'), '# Chip B Datasheet\n特性：高速接口\n');

    return {
      catalog: {
        knowledgeBaseRoot: tmpKbRoot,
        chips: [
          {
            id: 'A',
            label: 'Chip A',
            description: 'Chip A 的描述',
            workspaceDir: chipADir,
          },
          {
            id: 'B',
            label: 'Chip B',
            description: 'Chip B 的描述',
            workspaceDir: chipBDir,
          },
        ],
      },
      dataDir: tmpDataDir,
      knowledgeBaseRoot: tmpKbRoot,
    };
  }

  // ----------------------------------------------------------
  // 单测 A：materializeIndex 写 INDEX.json
  // ----------------------------------------------------------
  it('materializeIndex 在 dataDir/scope-workspaces/ 下创建带 INDEX.json 的目录', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const fakeAdapter = makeFakeAdapter({ stage1Output: '', stage2Output: '' });

    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      adapterFactory: () => fakeAdapter,
    });

    const rows = [{ chipId: 'A', label: 'Chip A', summary: '描述 A' }];
    const ws = await deps.materializeIndex(rows);

    try {
      // 目录路径在 dataDir/scope-workspaces/ 下
      expect(ws.cwd).toContain('scope-workspaces');
      expect(ws.cwd).toContain('index-');

      // INDEX.json 内容正确
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(path.join(ws.cwd, 'INDEX.json'), 'utf8');
      const parsed = JSON.parse(content) as unknown[];
      expect(parsed).toEqual(rows);
    } finally {
      await ws.cleanup();
    }
  });

  // ----------------------------------------------------------
  // 单测 B：copyCandidateFullText 真实 fs copy 计数
  // ----------------------------------------------------------
  it('copyCandidateFullText 把 .md 文件 copy 进 cwd/<chipId>/ 并返回文件数', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const fakeAdapter = makeFakeAdapter({ stage1Output: '', stage2Output: '' });

    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      adapterFactory: () => fakeAdapter,
    });

    // 先建一个目标工作区目录
    const ws = await deps.materializeIndex([{ chipId: 'A', label: 'Chip A', summary: '描述 A' }]);

    try {
      const result = await deps.copyCandidateFullText(ws.cwd, ['A', 'B'], []);

      // 两个 chip 各 1 个 .md = 2 个文件
      expect(result).toMatchObject({
        count: 2,
        files: [
          { chipId: 'A', path: 'A/datasheet-a.md' },
          { chipId: 'B', path: 'B/datasheet-b.md' }
        ]
      });
      expect(result.files.every((file) => typeof file.size === 'number')).toBe(true);

      // 确认文件真的被 copy 进去了
      const filesA = await readdir(path.join(ws.cwd, 'A'));
      expect(filesA).toContain('datasheet-a.md');

      const filesB = await readdir(path.join(ws.cwd, 'B'));
      expect(filesB).toContain('datasheet-b.md');
    } finally {
      await ws.cleanup();
    }
  });

  it('aborts candidate copying before exceeding the configured file budget', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      maxCopiedFiles: 1,
      adapterFactory: () => makeFakeAdapter({ stage1Output: '', stage2Output: '' })
    });
    const ws = await deps.materializeIndex([{ chipId: 'A', label: 'Chip A', summary: '描述 A' }]);
    try {
      await expect(deps.copyCandidateFullText(ws.cwd, ['A', 'B'], []))
        .rejects.toThrow('copy budget exceeded');
    } finally {
      await ws.cleanup();
    }
  });

  it('copyCandidateFullText skips a cataloged chip when the current document snapshot is incomplete', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const resources = parseResourceVisibilityCatalog({
      documents: [
        { documentId: 'doc-a-1', status: 'approved', visibility: 'customer', chipIds: ['A'] },
        { documentId: 'doc-a-2', status: 'approved', visibility: 'customer', chipIds: ['A'] }
      ]
    });
    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      getResourceCatalog: () => resources,
      adapterFactory: () => makeFakeAdapter({ stage1Output: '', stage2Output: '' })
    });
    const ws = await deps.materializeIndex([{ chipId: 'A', label: 'Chip A', summary: 'A' }]);

    try {
      await expect(deps.copyCandidateFullText(ws.cwd, ['A'], ['doc-a-1'])).resolves.toEqual({ count: 0, files: [] });
    } finally {
      await ws.cleanup();
    }
  });

  it('passes two-stage hardening and model role as trusted direct spawn options', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const fakeAdapter = makeFakeAdapter({ stage1Output: 'stage 1 answer', stage2Output: '' });
    const spawnSpy = vi.spyOn(fakeAdapter, 'spawn');
    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      claudeModelRole: 'sonnet',
      adapterFactory: () => fakeAdapter
    });
    const ws = await deps.materializeIndex([{ chipId: 'A', label: 'Chip A', summary: 'A' }]);

    try {
      await deps.runCcTurn({ workspaceCwd: ws.cwd, prompt: 'find candidates', resume: false });

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as unknown[];
      expect(call[1]).toEqual({});
      expect(call[5]).toEqual({
        claudeModelRole: 'sonnet',
        permissionMode: 'default',
        allowedTools: ['Read', 'Grep'],
        denyReadRoots: [path.resolve(knowledgeBaseRoot)]
      });
    } finally {
      await ws.cleanup();
    }
  });

  it('kills the live adapter and rejects the active turn when the large-scope signal is aborted', async () => {
    const { catalog, dataDir, knowledgeBaseRoot } = await setup();
    const controller = new AbortController();
    const fakeAdapter = makeFakeAdapter({ stage1Output: '', stage2Output: '' });
    const spawnSpy = vi.spyOn(fakeAdapter, 'spawn').mockImplementation(() => {});
    const killSpy = vi.spyOn(fakeAdapter, 'kill');
    const deps = createLiveTwoStageDeps({
      catalog,
      dataDir,
      knowledgeBaseRoot,
      signal: controller.signal,
      adapterFactory: () => fakeAdapter
    });
    const ws = await deps.materializeIndex([{ chipId: 'A', label: 'Chip A', summary: 'A' }]);
    const turn = deps.runCcTurn({ workspaceCwd: ws.cwd, prompt: 'stage1', resume: false });

    await vi.waitFor(() => expect(spawnSpy).toHaveBeenCalledTimes(1));
    controller.abort(new Error('test cancellation'));

    await expect(turn).rejects.toThrow('test cancellation');
    expect(killSpy).toHaveBeenCalledTimes(1);
    await ws.cleanup();
  });
});

// ============================================================
// 主集成测试套件
// ============================================================

describe('runScopeQueryLarge', () => {
  let tmpDataDir: string;
  let tmpKbRoot: string;

  afterEach(async () => {
    if (tmpDataDir) {
      await rm(tmpDataDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tmpKbRoot) {
      await rm(tmpKbRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('完整两阶段：index→stage1→二次鉴权→copy kept→stage2；越权 X 被剔除；trace 四阶段都被调用；copy 落磁盘', async () => {
    // ---- 建立真实 fs 环境 ----
    tmpDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-datadir-'));
    tmpKbRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-kb-'));

    const chipADir = path.join(tmpKbRoot, 'chip-a-src');
    const chipBDir = path.join(tmpKbRoot, 'chip-b-src');
    await mkdir(chipADir, { recursive: true });
    await mkdir(chipBDir, { recursive: true });
    await writeFile(path.join(chipADir, 'datasheet-a.md'), '# Chip A Datasheet\n');
    await writeFile(path.join(chipBDir, 'datasheet-b.md'), '# Chip B Datasheet\n');

    const catalog = {
      knowledgeBaseRoot: tmpKbRoot,
      chips: [
        { id: 'A', label: 'Chip A', description: 'Chip A 描述', workspaceDir: chipADir },
        { id: 'B', label: 'Chip B', description: 'Chip B 描述', workspaceDir: chipBDir },
      ],
    };

    // ---- Stage1 CC 输出（含越权 X）----
    const stage1Output = `好的，根据 INDEX 分析，以下芯片与问题相关：

\`\`\`json
{"candidates":[{"chipId":"A","reason":"特性匹配"},{"chipId":"X","reason":"可能相关（越权）"},{"chipId":"B","reason":"接口匹配"}]}
\`\`\`
`;

    // ---- Stage2 CC 输出 ----
    const stage2Output = `根据芯片 A 和 B 的 datasheet，回答如下：

Chip A 特性：超低功耗；Chip B 特性：高速接口。

参考来源：
- A: datasheet-a.md § 特性
- B: datasheet-b.md § 接口规格
`;

    let capturedStage2Cwd: string | undefined;

    // 拦截 write 记录 workspaceCwd
    const fakeAdapter = makeFakeAdapter({ stage1Output, stage2Output });
    const originalWrite = fakeAdapter.write.bind(fakeAdapter);
    // 我们无法直接拦截 write 参数 cwd（cwd 在 runCcTurn 内处理），
    // 通过 onTrace ws.copy 阶段后，cwd 已确定；此处跳过单独拦截。

    // ---- trace 记录 ----
    const traceLog: Array<{ stage: string; detail: Record<string, unknown> }> = [];

    // ---- 执行 ----
    const result = await runScopeQueryLarge({
      catalog,
      dataDir: tmpDataDir,
      knowledgeBaseRoot: tmpKbRoot,
      allowedChipIds: ['A', 'B', 'C'],   // X 不在白名单
      question: '请问这些芯片的功耗规格是什么？',
      onTrace: (stage, detail) => {
        traceLog.push({ stage, detail });
      },
      adapterFactory: () => fakeAdapter,
    });

    // ---- 核心断言 ----

    // 1. 越权 X 被剔除
    expect(result.usedChipIds).toEqual(['A', 'B']);
    expect(result.droppedChipIds).toEqual(['X']);

    // 2. answer 是 stage2 输出
    expect(result.answer).toContain('Chip A');
    expect(result.answer).toContain('Chip B');

    // 3. trace 四阶段都被调用（顺序：cc.stage1, auth.recheck, ws.copy, cc.stage2）
    const stages = traceLog.map((t) => t.stage);
    expect(stages).toContain('cc.stage1');
    expect(stages).toContain('auth.recheck');
    expect(stages).toContain('ws.copy');
    expect(stages).toContain('cc.stage2');
    // 确认顺序
    const idx = (s: string) => stages.indexOf(s);
    expect(idx('cc.stage1')).toBeLessThan(idx('auth.recheck'));
    expect(idx('auth.recheck')).toBeLessThan(idx('ws.copy'));
    expect(idx('ws.copy')).toBeLessThan(idx('cc.stage2'));

    // 4. trace 摘要数值合理
    const authTrace = traceLog.find((t) => t.stage === 'auth.recheck')!;
    expect(authTrace.detail['kept']).toBe(2);
    expect(authTrace.detail['dropped']).toBe(1);

    const copyTrace = traceLog.find((t) => t.stage === 'ws.copy')!;
    expect(copyTrace.detail['chips']).toBe(2);
    expect(copyTrace.detail['files']).toBe(2);   // A 和 B 各 1 个 .md

    // 5. 需要验证 copy 落磁盘——从 ws.copy trace 拿不到 cwd，
    //    我们通过 cleanupAll 前扫描 dataDir/scope-workspaces/ 来验证
    const { readdir: readdirFn, stat: statFn } = await import('node:fs/promises');
    const scopeWsRoot = path.join(tmpDataDir, 'scope-workspaces');
    let foundDirs: string[] = [];
    try {
      foundDirs = await readdirFn(scopeWsRoot);
    } catch {
      // 目录不存在则 foundDirs 为空
    }

    // 至少有一个 index- 目录
    const indexDirs = foundDirs.filter((d) => d.startsWith('index-'));
    expect(indexDirs.length).toBeGreaterThanOrEqual(1);

    // 在这些目录中找到含 A/ 和 B/ 子目录的那个
    let chipAFound = false;
    let chipBFound = false;
    for (const dir of indexDirs) {
      const fullDir = path.join(scopeWsRoot, dir);
      try {
        const entries = await readdirFn(fullDir);
        if (entries.includes('A')) chipAFound = true;
        if (entries.includes('B')) chipBFound = true;
      } catch {
        // ignore
      }
    }

    expect(chipAFound).toBe(true);
    expect(chipBFound).toBe(true);

    // 6. cleanup 不报错
    await expect(result.cleanup()).resolves.not.toThrow();
  });

  // ----------------------------------------------------------
  // 边界：stage1 输出为空候选时短路（T18-c）
  // ----------------------------------------------------------
  it('stage1 无候选时短路：返回中性答案、不触发 ws.copy/cc.stage2、cleanup 不报错', async () => {
    tmpDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-datadir-'));
    tmpKbRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-kb-'));

    const chipADir = path.join(tmpKbRoot, 'chip-a-src');
    await mkdir(chipADir, { recursive: true });
    await writeFile(path.join(chipADir, 'datasheet-a.md'), '# Chip A\n');

    const catalog = {
      knowledgeBaseRoot: tmpKbRoot,
      chips: [{ id: 'A', label: 'Chip A', workspaceDir: chipADir }],
    };

    const stage1NoCandidates = '```json\n{"candidates":[]}\n```';
    // stage2Output 不会被调用（短路），但 fakeAdapter 仍需一个值
    const fakeAdapter = makeFakeAdapter({
      stage1Output: stage1NoCandidates,
      stage2Output: '不应被调用',
    });

    const traceLog: Array<{ stage: string; detail: Record<string, unknown> }> = [];

    const result = await runScopeQueryLarge({
      catalog,
      dataDir: tmpDataDir,
      knowledgeBaseRoot: tmpKbRoot,
      allowedChipIds: ['A'],
      question: '没有相关芯片的问题',
      onTrace: (stage, detail) => traceLog.push({ stage, detail }),
      adapterFactory: () => fakeAdapter,
    });

    // 短路：返回中性答案
    expect(result.answer).toBe('该范围内未发现匹配芯片。');
    expect(result.usedChipIds).toEqual([]);
    expect(result.droppedChipIds).toEqual([]);

    // ws.copy 和 cc.stage2 都不应出现（短路在 auth.recheck 之后即返回）
    const stages = traceLog.map((t) => t.stage);
    expect(stages).not.toContain('ws.copy');
    expect(stages).not.toContain('cc.stage2');
    // auth.recheck 应已触发（短路前最后一个 trace）
    expect(stages).toContain('auth.recheck');

    // cleanup 不报错
    await expect(result.cleanup()).resolves.not.toThrow();
  });

  it('re-resolves document grants after stage1 and drops the chip before copy when a document is revoked', async () => {
    tmpDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-datadir-'));
    tmpKbRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-kb-'));
    const chipADir = path.join(tmpKbRoot, 'chip-a-src');
    await mkdir(chipADir, { recursive: true });
    await writeFile(path.join(chipADir, 'datasheet-a.md'), '# Chip A\n');
    const catalog = {
      knowledgeBaseRoot: tmpKbRoot,
      chips: [{ id: 'A', label: 'Chip A', workspaceDir: chipADir }]
    };
    const resources = parseResourceVisibilityCatalog({
      documents: [{ documentId: 'doc-a', status: 'approved', visibility: 'public', chipIds: ['A'] }]
    });
    const fakeAdapter = makeFakeAdapter({
      stage1Output: '```json\n{"candidates":[{"chipId":"A"}]}\n```',
      stage2Output: 'must not run'
    });
    const traceLog: Array<{ stage: string; detail: Record<string, unknown> }> = [];

    const result = await runScopeQueryLarge({
      catalog,
      dataDir: tmpDataDir,
      knowledgeBaseRoot: tmpKbRoot,
      allowedChipIds: ['A'],
      allowedDocumentIds: ['doc-a'],
      getResourceCatalog: () => resources,
      reauthorize: async () => ({ allowedChipIds: ['A'], allowedDocumentIds: [] }),
      question: 'A?',
      onTrace: (stage, detail) => traceLog.push({ stage, detail }),
      adapterFactory: () => fakeAdapter
    });

    expect(result.usedChipIds).toEqual([]);
    expect(result.droppedChipIds).toEqual(['A']);
    expect(traceLog.map((entry) => entry.stage)).not.toContain('ws.copy');
    await result.cleanup();
  });

  it('materializes a large-scope chat upload into the index workspace and uses the rewritten question in both stages', async () => {
    tmpDataDir = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-datadir-'));
    tmpKbRoot = await mkdtemp(path.join(os.tmpdir(), 'agentx-test-kb-'));
    const chipADir = path.join(tmpKbRoot, 'chip-a-src');
    await mkdir(chipADir, { recursive: true });
    await writeFile(path.join(chipADir, 'datasheet-a.md'), '# Chip A\n');
    const catalog = {
      knowledgeBaseRoot: tmpKbRoot,
      chips: [{ id: 'A', label: 'Chip A', workspaceDir: chipADir }]
    };
    const userId = 'user-1';
    const uploadId = crypto.randomUUID();
    const storedName = `${uploadId}.png`;
    const uploadDir = path.join(tmpDataDir, 'chat-uploads', userId, uploadId);
    await mkdir(uploadDir, { recursive: true });
    await writeFile(path.join(uploadDir, storedName), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(uploadDir, 'meta.json'), JSON.stringify({ readToken: 'token-1' }));
    const question = `Read ![scope image](/api/chat-uploads/${uploadId}/${storedName}?token=token-1)`;
    const fakeAdapter = makeFakeAdapter({
      stage1Output: '```json\n{"candidates":[{"chipId":"A"}]}\n```',
      stage2Output: 'answer'
    });
    const spawnSpy = vi.spyOn(fakeAdapter, 'spawn');
    const writeSpy = vi.spyOn(fakeAdapter, 'write');

    const result = await runScopeQueryLarge({
      catalog,
      dataDir: tmpDataDir,
      knowledgeBaseRoot: tmpKbRoot,
      allowedChipIds: ['A'],
      question,
      userId,
      adapterFactory: () => fakeAdapter
    });

    const expectedLocalPath = `./chat-images/${storedName}`;
    expect(spawnSpy.mock.calls[0]?.[4]).toContain(expectedLocalPath);
    expect(writeSpy.mock.calls[0]?.[0]).toContain(expectedLocalPath);
    expect(spawnSpy.mock.calls[0]?.[4]).not.toContain('/api/chat-uploads/');
    const workspaces = await readdir(path.join(tmpDataDir, 'scope-workspaces'));
    const indexDir = workspaces.find((entry) => entry.startsWith('index-'))!;
    await expect(readdir(path.join(tmpDataDir, 'scope-workspaces', indexDir, 'chat-images'))).resolves.toContain(storedName);
    await result.cleanup();
  });
});
