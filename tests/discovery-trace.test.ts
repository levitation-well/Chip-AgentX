import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DISCOVERY_TRACE_HARD_LINE_CAP,
  DiscoveryTraceStore,
  recordScopeTrace
} from '../src/observability/discovery-trace.js';
import { SessionManager } from '../src/session-manager.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeStore(opts?: { maxEvents?: number }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-discovery-trace-'));
  dirs.push(dataDir);
  return new DiscoveryTraceStore({ dataDir, maxEvents: opts?.maxEvents });
}

async function makeStoreWithPath(opts?: { maxEvents?: number }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agentx-discovery-trace-'));
  dirs.push(dataDir);
  const store = new DiscoveryTraceStore({ dataDir, maxEvents: opts?.maxEvents });
  return { store, filePath: path.join(dataDir, 'discovery-traces.jsonl') };
}

async function countLines(filePath: string): Promise<number> {
  const raw = await readFile(filePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return raw.split(/\r?\n/).filter((line) => line.length > 0).length;
}

describe('DiscoveryTraceStore', () => {
  it('records a cc.launch event and lists it back redacted', async () => {
    const store = await makeStore();
    await store.record({
      sessionId: 's1',
      stage: 'cc.launch',
      detail: {
        permissionMode: 'default',
        allowedTools: ['Read'],
        denyReadRoots: ['E:/kb'],
        cwd: 'E:/kb/.tmp/x'
      }
    });

    const events = await store.list();
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.stage).toBe('cc.launch');
    expect(event.status).toBe('ok');
    expect(event.sessionId).toBe('s1');
    expect(event.traceId).toBe('s1');
    expect(typeof event.ts).toBe('string');
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
    expect(event.detail.permissionMode).toBe('default');
    expect(event.detail.allowedTools).toContain('Read');

    // Absolute paths must be redacted before persistence/logging.
    const serialized = JSON.stringify(event.detail);
    expect(serialized).not.toContain('E:/kb');
    expect(serialized).not.toContain('E:\\kb');
    expect(serialized).toContain('[REDACTED_PATH]');
  });

  it('records an error event with a non-zero exit code and filters by sessionId', async () => {
    const store = await makeStore();
    await store.record({ sessionId: 's1', stage: 'cc.launch', detail: { permissionMode: 'default' } });
    await store.record({ sessionId: 's2', stage: 'cc.launch', detail: { permissionMode: 'default' } });
    await store.record({ sessionId: 's2', stage: 'error', status: 'error', detail: { exitCode: 1 } });

    const s2 = await store.list({ sessionId: 's2' });
    expect(s2).toHaveLength(2);
    const error = s2.find((event) => event.stage === 'error');
    expect(error).toBeDefined();
    expect(error?.status).toBe('error');
    expect(error?.detail.exitCode).toBe(1);
    expect(error?.traceId).toBe('s2');

    const s1 = await store.list({ sessionId: 's1' });
    expect(s1).toHaveLength(1);
    expect(s1[0].stage).toBe('cc.launch');
  });

  it('honours traceId override so cc.launch and error share a trace', async () => {
    const store = await makeStore();
    await store.record({ traceId: 't-1', sessionId: 's1', stage: 'cc.launch', detail: {} });
    await store.record({ traceId: 't-1', sessionId: 's1', stage: 'error', status: 'error', detail: { exitCode: 2 } });

    const events = await store.list({ sessionId: 's1' });
    expect(events.map((event) => event.traceId)).toEqual(['t-1', 't-1']);
  });

  it('caps stored/returned events via maxEvents', async () => {
    const store = await makeStore({ maxEvents: 5 });
    for (let i = 0; i < 20; i += 1) {
      await store.record({ sessionId: `s${i}`, stage: 'cc.launch', detail: { i } });
    }

    const events = await store.list();
    expect(events.length).toBeLessThanOrEqual(5);
    // Most recent events are retained.
    expect(events.some((event) => event.sessionId === 's19')).toBe(true);
    expect(events.some((event) => event.sessionId === 's0')).toBe(false);
  });

  it('limit option truncates the returned slice to the most recent N', async () => {
    const store = await makeStore();
    for (let i = 0; i < 6; i += 1) {
      await store.record({ sessionId: `s${i}`, stage: 'cc.launch', detail: { i } });
    }

    const events = await store.list({ limit: 2 });
    expect(events).toHaveLength(2);
    expect(events.some((event) => event.sessionId === 's5')).toBe(true);
  });

  // Codex review fix (V10 followup): list({ sessionId }) 曾先按全局 maxEvents 尾窗口收窄
  // 再过滤 sessionId，导致老会话的 cc.stage1 事件被之后其它会话产生的事件顶出窗口后
  // 「查无此阶段」，即便该会话仍在窗口内因近期事件出现在列表里（对应
  // sessionHasStage1 把两步会话误判为「全局」这个 bug）。这里用远大于 maxEvents 的写入量
  // 复现：先写目标 session 的 cc.stage1，再写足量其它 session 的事件把它挤出小窗口，
  // 断言按 sessionId 查询仍能读到该事件。
  it('list({ sessionId }) still finds an old event after many other sessions push it out of the maxEvents window', async () => {
    const store = await makeStore({ maxEvents: 5 });

    await store.record({ sessionId: 'target-session', stage: 'cc.stage1', detail: {} });

    // 写入远超 maxEvents（5）的其它会话事件，若 sessionId 过滤发生在尾窗口收窄之后，
    // target-session 的 cc.stage1 会被顶出窗口而查不到。
    for (let i = 0; i < 50; i += 1) {
      await store.record({ sessionId: `other-${i}`, stage: 'cc.launch', detail: { i } });
    }
    // target-session 仍因近期事件（如 cc.stage2）出现在全局列表里，
    // 对应审查描述的「该会话仍因近期 cc.stage2/error 出现在列表里」场景。
    await store.record({ sessionId: 'target-session', stage: 'cc.stage2', detail: {} });

    const events = await store.list({ sessionId: 'target-session' });
    expect(events.some((event) => event.stage === 'cc.stage1')).toBe(true);
    expect(events.some((event) => event.stage === 'cc.stage2')).toBe(true);
  });

  // V10: 有界读取 + retention —— 写入远超硬顶的行数后，list() 仍只处理有界数据，
  // 且落盘文件本身被自剪到硬顶以内（不再无界增长）。
  // 只超出硬顶一个自剪检查间隔（TRIM_CHECK_INTERVAL），既足以触发自剪，又避免测试写入量过大、
  // 在并行跑全量测试时因 CPU 争抢而超时。
  it('self-trims the backing file once line count exceeds the hard cap', async () => {
    const { store, filePath } = await makeStoreWithPath({ maxEvents: 5 });
    const totalWrites = DISCOVERY_TRACE_HARD_LINE_CAP + 200;
    for (let i = 0; i < totalWrites; i += 1) {
      await store.record({ sessionId: `s${i}`, stage: 'cc.launch', detail: { i } });
    }

    const lineCount = await countLines(filePath);
    expect(lineCount).toBeLessThanOrEqual(DISCOVERY_TRACE_HARD_LINE_CAP);

    // 最近写入的事件仍可读到（未被误剪掉尾部）。
    const events = await store.list();
    expect(events.some((event) => event.sessionId === `s${totalWrites - 1}`)).toBe(true);
  }, 60000);

  it('list() bounds reads via a tail read instead of parsing the whole file', async () => {
    const { store, filePath } = await makeStoreWithPath({ maxEvents: 5 });
    const totalWrites = DISCOVERY_TRACE_HARD_LINE_CAP + 200;
    for (let i = 0; i < totalWrites; i += 1) {
      await store.record({ sessionId: `s${i}`, stage: 'cc.launch', detail: { i } });
    }

    // 文件已自剪到硬顶以内；list() 按 maxEvents 截断，不应因整文件读取而拿到全部行。
    const lineCount = await countLines(filePath);
    const events = await store.list();
    expect(events.length).toBeLessThanOrEqual(5);
    expect(events.length).toBeLessThan(lineCount);
    // 保留的是最近写入的事件（尾部），不是最旧的。
    expect(events.every((event) => Number(event.sessionId.slice(1)) >= totalWrites - 5)).toBe(true);
  }, 60000);

  // M2 Task 3: scope.resolve / scope.materialize 阶段
  it('records scope.resolve event and lists it back', async () => {
    const store = await makeStore();
    await store.record({
      sessionId: 's1',
      stage: 'scope.resolve',
      detail: { scopePresetId: 'p1', scopeId: 'sc1', fileCount: 3 }
    });

    const events = await store.list({ sessionId: 's1' });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.stage).toBe('scope.resolve');
    expect(event.status).toBe('ok');
    expect(event.sessionId).toBe('s1');
    expect(event.traceId).toBe('s1');
    expect(event.detail.scopePresetId).toBe('p1');
    expect(event.detail.scopeId).toBe('sc1');
    expect(event.detail.fileCount).toBe(3);
  });

  it('records scope.materialize event and lists it back', async () => {
    const store = await makeStore();
    await store.record({
      sessionId: 's2',
      stage: 'scope.materialize',
      detail: { scopeId: 'sc2', fileCount: 5 }
    });

    const events = await store.list({ sessionId: 's2' });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.stage).toBe('scope.materialize');
    expect(event.status).toBe('ok');
    expect(event.detail.scopeId).toBe('sc2');
    expect(event.detail.fileCount).toBe(5);
  });

  it('scope.resolve detail: absolute paths in fields are redacted', async () => {
    const store = await makeStore();
    await store.record({
      sessionId: 's3',
      stage: 'scope.resolve',
      // 模拟误传了含路径的字段（应被 redactDebugValue 清理）
      detail: { scopePresetId: 'p1', scopeId: 'sc1', fileCount: 2, cwd: 'E:/kb/.tmp/scope-abc' }
    });

    const events = await store.list({ sessionId: 's3' });
    const serialized = JSON.stringify(events[0].detail);
    expect(serialized).not.toContain('E:/kb');
    expect(serialized).toContain('[REDACTED_PATH]');
    // 安全字段不受影响
    expect(events[0].detail.scopePresetId).toBe('p1');
    expect(events[0].detail.fileCount).toBe(2);
  });

  it('scope.resolve and scope.materialize share the same traceId via sessionId', async () => {
    const store = await makeStore();
    await store.record({
      sessionId: 's4',
      stage: 'scope.resolve',
      detail: { scopePresetId: 'p2', scopeId: 'sc3', fileCount: 4 }
    });
    await store.record({
      sessionId: 's4',
      stage: 'scope.materialize',
      detail: { scopeId: 'sc3', fileCount: 4 }
    });

    const events = await store.list({ sessionId: 's4' });
    expect(events).toHaveLength(2);
    // 两条 traceId 默认都等于 sessionId
    expect(events[0].traceId).toBe('s4');
    expect(events[1].traceId).toBe('s4');
    expect(events[0].stage).toBe('scope.resolve');
    expect(events[1].stage).toBe('scope.materialize');
  });
});

describe('recordScopeTrace helper', () => {
  it('records scope.resolve and scope.materialize from a PreparedScopeSession-like object', async () => {
    const store = await makeStore();
    const fakeScopeSession = {
      scopePresetId: 'preset-x',
      safeSummary: {
        scopeId: 'scope-abc',
        scopePresetId: 'preset-x',
        fileCount: 7,
        allowedChipCount: 2,
        allowedDocumentCount: 3,
        deniedCount: 0,
        mode: 'copy' as const,
        labels: [],
        usedSources: [],
        sourceCitationSummary: { total: 0, bySource: [] },
        shards: []
      }
    };

    await recordScopeTrace(store, 'session-99', fakeScopeSession as Parameters<typeof recordScopeTrace>[2]);

    const events = await store.list({ sessionId: 'session-99' });
    expect(events).toHaveLength(2);

    const resolveEvent = events.find((event) => event.stage === 'scope.resolve');
    const materializeEvent = events.find((event) => event.stage === 'scope.materialize');

    expect(resolveEvent).toBeDefined();
    expect(resolveEvent?.status).toBe('ok');
    expect(resolveEvent?.traceId).toBe('session-99');
    expect(resolveEvent?.detail.scopePresetId).toBe('preset-x');
    expect(resolveEvent?.detail.scopeId).toBe('scope-abc');
    expect(resolveEvent?.detail.fileCount).toBe(7);

    expect(materializeEvent).toBeDefined();
    expect(materializeEvent?.status).toBe('ok');
    expect(materializeEvent?.traceId).toBe('session-99');
    expect(materializeEvent?.detail.scopeId).toBe('scope-abc');
    expect(materializeEvent?.detail.fileCount).toBe(7);
  });
});

describe('SessionManager launch event', () => {
  it('emits launch with hardening flags when spawning a hardened claude-code session', async () => {
    const manager = new SessionManager({ exitOnLastSession: false });
    const launchHandler = vi.fn();
    manager.on('launch', launchHandler);

    const session = await manager.spawn({
      agentType: 'claude-code',
      sessionMode: 'oneshot',
      cwd: 'E:/kb/.tmp/chip-1',
      task: 'hello',
      permissionMode: 'default',
      allowedTools: ['Read'],
      denyReadRoots: ['E:/kb']
    });

    try {
      expect(launchHandler).toHaveBeenCalledTimes(1);
      const [sessionId, detail] = launchHandler.mock.calls[0];
      expect(sessionId).toBe(session.id);
      expect(detail.permissionMode).toBe('default');
      expect(detail.allowedTools).toEqual(['Read']);
      expect(detail.denyReadRoots).toEqual(['E:/kb']);
      expect(detail.cwd).toBe('E:/kb/.tmp/chip-1');
    } finally {
      manager.destroy();
    }
  });

  it('does not emit launch for non-hardened sessions', async () => {
    const manager = new SessionManager({ exitOnLastSession: false });
    const launchHandler = vi.fn();
    manager.on('launch', launchHandler);

    await manager.spawn({
      agentType: 'claude-code',
      sessionMode: 'oneshot',
      cwd: 'E:/kb/.tmp/chip-2',
      task: 'hello'
    });

    try {
      expect(launchHandler).not.toHaveBeenCalled();
    } finally {
      manager.destroy();
    }
  });
});
