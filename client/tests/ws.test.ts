import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildUrl, connect } from '../src/ws.js';
import type { WebSocketLike } from '../src/ws.js';
import type { RoomView } from '../src/store.js';

// jsdom keeps one localStorage for the whole file, and connect() now persists
// an identity into it. Without this, a stored id leaks into later tests and
// they start depending on execution order.
beforeEach(() => localStorage.clear());

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
}

function harness(displayName = 'Ada') {
  FakeSocket.instances = [];
  const views: RoomView[] = [];
  const statuses: string[] = [];
  const connection = connect({
    roomId: 'room_a',
    token: 'tok',
    displayName,
    baseUrl: 'ws://test',
    onView: (v) => views.push(v),
    onStatus: (s) => statuses.push(s),
    socketFactory: (url) => new FakeSocket(url),
  });
  return { connection, views, statuses, sockets: FakeSocket.instances };
}

describe('buildUrl', () => {
  it('puts the room, token, name and since in the query string', () => {
    const url = buildUrl({
      baseUrl: 'ws://test',
      roomId: 'room_a',
      token: 'tok',
      displayName: 'Ada Lovelace',
      since: 7,
    });
    expect(url).toBe('ws://test/ws?room=room_a&token=tok&name=Ada+Lovelace&since=7');
  });

  it('never carries an API key', () => {
    const url = buildUrl({ baseUrl: 'ws://test', roomId: 'r', token: 't', displayName: 'n', since: 0 });
    expect(url).not.toContain('sk-ant');
    expect(url).not.toContain('apiKey');
  });
});

describe('connect', () => {
  it('reports connecting then open', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('folds incoming frames through the reducer', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({
      data: JSON.stringify({
        kind: 'event',
        event: {
          seq: 1,
          ts: '2026-07-28T00:00:00.000Z',
          roomId: 'room_a',
          type: 'user_prompt',
          participantId: 'p_ada',
          displayName: 'Ada',
          text: 'hi',
        },
      }),
    });
    expect(h.views.at(-1)?.messages.at(-1)?.text).toBe('hi');
  });

  it('reconnects after an unexpected close and resumes from lastSeq', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({
      data: JSON.stringify({
        kind: 'replay_complete',
        lastSeq: 12,
        protocolVersion: 1,
        participantId: 'p_self',
        resumeToken: 'r_self',
      }),
    });
    h.sockets[0]?.onclose?.();
    expect(h.statuses).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.url).toContain('since=12');
    vi.useRealTimers();
  });

  it('does not reconnect after an explicit close', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.connection.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });

  it('does not reconnect if closed explicitly during a pending backoff window', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    // Unexpected close: schedules a reconnect after a backoff delay.
    h.sockets[0]?.onclose?.();
    expect(h.statuses.at(-1)).toBe('reconnecting');

    // Explicit close arrives before the pending reconnect timer fires. A
    // real WebSocket that is already closed does not re-fire onclose, so
    // this must not rely on the onclose handler to reach 'closed' or to
    // cancel the pending timer.
    h.connection.close();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });

  it('serializes outgoing frames as JSON', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.connection.send({ kind: 'prompt', text: 'go' });
    expect(h.sockets[0]?.sent[0]).toBe('{"kind":"prompt","text":"go"}');
  });
});

const replayComplete = (participantId: string, resumeToken: string, lastSeq = 3) =>
  JSON.stringify({ kind: 'replay_complete', lastSeq, protocolVersion: 1, participantId, resumeToken });

describe('identity across reconnects', () => {
  it('offers its id and resume token back on the next connection', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({ data: replayComplete('p_ada', 'r_secret') });
    h.sockets[0]?.onclose?.();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets[1]?.url).toContain('participant=p_ada');
    expect(h.sockets[1]?.url).toContain('resume=r_secret');
    vi.useRealTimers();
  });

  it('survives a full page reload by reading storage, not memory', () => {
    const first = harness();
    first.sockets[0]?.onopen?.();
    first.sockets[0]?.onmessage?.({ data: replayComplete('p_ada', 'r_secret') });

    // A reload: a brand-new connect() with an empty in-memory view.
    const reloaded = harness();
    expect(reloaded.sockets[0]?.url).toContain('participant=p_ada');
    expect(reloaded.sockets[0]?.url).toContain('resume=r_secret');
  });

  it('sends neither parameter before the server has issued an identity', () => {
    const h = harness();
    expect(h.sockets[0]?.url).not.toContain('participant=');
    expect(h.sockets[0]?.url).not.toContain('resume=');
  });

  it('adopts the server’s answer when it declines the reclaim', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({ data: replayComplete('p_ada', 'r_secret') });
    h.sockets[0]?.onclose?.();
    await vi.advanceTimersByTimeAsync(5_000);

    // The server minted a fresh identity instead of honouring the reclaim.
    h.sockets[1]?.onopen?.();
    h.sockets[1]?.onmessage?.({ data: replayComplete('p_new', 'r_new') });
    h.sockets[1]?.onclose?.();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.sockets[2]?.url).toContain('participant=p_new');
    expect(h.sockets[2]?.url).toContain('resume=r_new');
    vi.useRealTimers();
  });

  it('stops retrying when the server refuses the connection outright', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    // 4401 (bad token) and 4409 (recovered room, no key) never heal by
    // retrying — backoff would just hammer the server forever.
    h.sockets[0]?.onclose?.({ code: 4401 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });

  it('still reconnects after an ordinary network close', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets).toHaveLength(2);
    vi.useRealTimers();
  });

  it('never puts a resume token in storage under a shared key', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({ data: replayComplete('p_ada', 'r_secret') });
    // Scoped per room AND per name, so neither two rooms nor two people in
    // one browser can collide.
    expect(localStorage.getItem('nexus:identity:room_a:Ada')).toContain('r_secret');
    expect(localStorage.getItem('nexus:identity:room_b:Ada')).toBeNull();
  });

  it('does not hand one person’s identity to another in the same browser', () => {
    // Found by opening two tabs against one room: tabs share localStorage, so
    // the second person offered back the first person's identity with a valid
    // token and the server honoured it — two people collapsed into one roster
    // row whose name flipped between them.
    const ada = harness('Ada');
    ada.sockets[0]?.onopen?.();
    ada.sockets[0]?.onmessage?.({ data: replayComplete('p_ada', 'r_ada') });

    const grace = harness('Grace');
    expect(grace.sockets[0]?.url).not.toContain('participant=p_ada');
    expect(grace.sockets[0]?.url).not.toContain('resume=r_ada');
    expect(grace.sockets[0]?.url).not.toContain('participant=');
  });
});
