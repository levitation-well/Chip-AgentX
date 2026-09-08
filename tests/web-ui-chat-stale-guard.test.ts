/**
 * P1-5 / R-4 (multi-agent audit): when the user rapidly switches between chat
 * sessions, a late `refreshLog` response from the previous session must NOT
 * overwrite the messages of the newly active session. We assert this end-to-end
 * by extracting the real `refreshLog` from public/chat.js and replaying the
 * race in a controlled harness.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

function readPublicFile(name: string): string {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

/** Extract a function (incl. async prefix) by name with balanced braces. */
function extractFunctionSource(js: string, name: string): string {
  let start = js.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found in chat.js`);
  if (js.slice(start - 6, start) === 'async ') {
    start -= 6;
  }
  const parenStart = js.indexOf('(', start);
  let parenDepth = 0;
  let afterParams = -1;
  for (let index = parenStart; index < js.length; index += 1) {
    const char = js[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        afterParams = index + 1;
        break;
      }
    }
  }
  if (afterParams === -1) throw new Error(`${name} params not closed`);
  const bodyStart = js.indexOf('{', afterParams);
  let depth = 0;
  for (let index = bodyStart; index < js.length; index += 1) {
    const char = js[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return js.slice(start, index + 1);
  }
  throw new Error(`${name} body not closed`);
}

/** Build a minimal harness around refreshLog that lets us swap in fetch responses on demand. */
function loadRefreshLogHarness() {
  const js = readPublicFile('chat.js');
  const refreshLogSrc = extractFunctionSource(js, 'refreshLog');

  const setMessages = vi.fn();
  const updateSessionState = vi.fn();
  const authFetch = vi.fn();
  // P1-5 / R-4 cares only about the call to setMessages (or its absence);
  // we mock formatPayloadMessages so we don't need to wire up renderMessageContent,
  // stripVisibleFingerprintMarker, etc.
  const formatPayloadMessages = vi.fn().mockImplementation((payload: any) => {
    const sid = payload?.sessionId ?? 'unknown';
    return (payload?.messages ?? []).map((m: any) => ({
      id: 'm',
      role: m.role,
      text: m.text,
      sessionId: sid
    }));
  });

  const state = {
    activeSessionId: null as string | null,
    activeSessionGeneration: 0,
    messageRevision: 0,
    messages: [] as unknown[]
  };

  let clientCounter = 0;
  const harness = new Function(
    'state',
    'activeSession',
    'setMessages',
    'window',
    'formatPayloadMessages',
    'nextClientId',
    'isCurrentSessionGeneration',
    'refreshRunningLog',
    'sessionStateValue',
    'updateSessionState',
    `${refreshLogSrc}\nreturn refreshLog;`
  )(
    state,
    () => ({ id: state.activeSessionId }),
    setMessages,
    { AgentXAuth: { authFetch } },
    formatPayloadMessages,
    () => `client-${++clientCounter}`,
    (sessionId: string, generation: number) => sessionId === state.activeSessionId
      && generation === state.activeSessionGeneration,
    vi.fn(),
    (session: any) => session?.turnState || session?.status || '',
    updateSessionState
  );

  return { refreshLog: harness as () => Promise<void>, state, setMessages, authFetch, formatPayloadMessages, updateSessionState };
}

describe('chat.refreshLog stale-response guard (P1-5 / R-4 multi-agent audit)', () => {
  it('drops a late response from a previously selected session', async () => {
    const { refreshLog, state, setMessages, authFetch } = loadRefreshLogHarness();

    // User selects session A.
    state.activeSessionId = 'A';
    state.activeSessionGeneration = 1;
    const pendingA = new Promise<Response>((resolve) => {
      authFetch.mockImplementationOnce((url: string) => {
        expect(url).toBe('/sessions/A/history');
        // Defer the resolve so we can switch sessions before A responds.
        return new Promise<Response>((r) => {
          setTimeout(() => {
            resolve(
              new Response(
                JSON.stringify({
                  sessionId: 'A',
                  messages: [{ role: 'assistant', text: 'A result' }]
                })
              ) as unknown as Response
            );
            r(new Response(JSON.stringify({ messages: [] })) as unknown as Response);
          }, 10);
        });
      });
    });

    // Kick off refreshLog for A; do NOT await yet.
    const refreshAPromise = refreshLog();

    // User quickly switches to session B before A responds.
    state.activeSessionId = 'B';
    state.activeSessionGeneration = 2;

    // The A response resolves now.
    await pendingA;
    await refreshAPromise;

    // setMessages must NOT have been called for A.
    expect(setMessages).not.toHaveBeenCalled();
  });

  it('applies a response when the session is still active at resolve time', async () => {
    const { refreshLog, state, setMessages, authFetch, updateSessionState } = loadRefreshLogHarness();

    state.activeSessionId = 'A';
    state.activeSessionGeneration = 1;
    authFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          sessionId: 'A',
          turnState: 'running',
          messages: [{ role: 'assistant', text: 'A result' }]
        })
      ) as unknown as Response
    );

    await refreshLog();
    expect(updateSessionState).toHaveBeenCalledWith('A', 'running');
    expect(setMessages).toHaveBeenCalledTimes(1);
    const call = setMessages.mock.calls[0];
    expect(call[0]).toEqual([
      expect.objectContaining({ sessionId: 'A', text: 'A result' })
    ]);
  });

  it('drops an A response after an A -> B -> A switch changed the selection generation', async () => {
    const { refreshLog, state, setMessages, authFetch } = loadRefreshLogHarness();
    let resolveA!: (response: Response) => void;

    state.activeSessionId = 'A';
    state.activeSessionGeneration = 1;
    authFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveA = resolve;
    }));
    const staleA = refreshLog();

    state.activeSessionId = 'B';
    state.activeSessionGeneration = 2;
    state.activeSessionId = 'A';
    state.activeSessionGeneration = 3;
    resolveA(new Response(JSON.stringify({
      messages: [{ role: 'assistant', text: 'stale A result' }]
    })) as unknown as Response);
    await staleA;

    expect(setMessages).not.toHaveBeenCalled();
  });

  it('refreshRunningLog passes targetSessionId to formatPayloadMessages (F5)', async () => {
    // F5 (multi-agent audit round 2): refreshRunningLog must thread
    // targetSessionId through to formatPayloadMessages so a late response
    // can't be tagged with the new activeSessionId.
    const js = readPublicFile('chat.js');
    const fnSrc = extractFunctionSource(js, 'refreshRunningLog');
    expect(fnSrc).toContain('const targetSessionId = sessionId');
    expect(fnSrc).toContain('isCurrentSessionGeneration(targetSessionId, expectedGeneration)');
    expect(fnSrc).toContain(
      'setMessages(formatPayloadMessages(payload, { sessionId: targetSessionId }))'
    );
  });
});
