import { describe, expect, it, vi } from 'vitest';
import { buildUrl, connect } from '../src/ws.js';
import type { WebSocketLike } from '../src/ws.js';
import type { RoomView } from '../src/store.js';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
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

function harness() {
  FakeSocket.instances = [];
  const views: RoomView[] = [];
  const statuses: string[] = [];
  const connection = connect({
    roomId: 'room_a',
    token: 'tok',
    displayName: 'Ada',
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
      data: JSON.stringify({ kind: 'replay_complete', lastSeq: 12, protocolVersion: 1 }),
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
