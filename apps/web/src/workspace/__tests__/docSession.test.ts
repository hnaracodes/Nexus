import { describe, expect, it, vi } from 'vitest';
import type { ClientFrame, ServerFrame } from '@nexus/protocol/wire';
import type { DocSession } from '../docSession.js';
import { createDocSession } from '../docSession.js';

interface Peer {
  id: string;
  session: DocSession;
  outbox: ClientFrame[];
}

function makePeer(id: string): Peer {
  const outbox: ClientFrame[] = [];
  const session = createDocSession((frame) => outbox.push(frame), id);
  return { id, session, outbox };
}

/**
 * Bounces every peer's queued outbound `doc_sync` frames to every other
 * peer's `handleFrame`, stamping each with the sending peer's id, and
 * repeats until nobody has anything left to say.
 *
 * Automerge's sync protocol needs more than one round trip even for a
 * single, uncontested change: the side holding the content only attaches it
 * once it has heard from the other side at least once (verified by hand —
 * a peer that only ever generates messages blindly keeps producing probes
 * that never carry the actual change), and bloom-filter false positives can
 * cost an extra round beyond that on top, non-deterministically since actor
 * ids are random. A fixed hop count would make these tests flaky; pumping
 * to quiescence (capped, so a real protocol bug hangs the test loudly
 * instead of forever) is the only non-flaky way to assert on the outcome of
 * a cross-session exchange.
 */
function pump(peers: Peer[], maxRounds = 20): number {
  let rounds = 0;
  while (peers.some((p) => p.outbox.length > 0) && rounds < maxRounds) {
    rounds += 1;
    const batches = peers.map((p) => ({ from: p.id, frames: p.outbox.splice(0, p.outbox.length) }));
    for (const batch of batches) {
      for (const frame of batch.frames) {
        if (frame.kind !== 'doc_sync') continue;
        for (const other of peers) {
          if (other.id === batch.from) continue;
          other.session.handleFrame({ kind: 'doc_sync', path: frame.path, payload: frame.payload, from: batch.from });
        }
      }
    }
  }
  return rounds;
}

describe('docSession', () => {
  it('produces an outbound doc_sync frame on a local change', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');

    session.open('a.ts');
    send.mockClear(); // drop open()'s doc_open + initial sync probe; only the edit's frame matters here

    session.localChange('a.ts', (draft) => {
      draft.text = 'hello';
    });

    const syncFrames = send.mock.calls.map((call) => call[0]).filter((f) => f.kind === 'doc_sync');
    expect(syncFrames.length).toBeGreaterThan(0);
    expect(syncFrames[0]).toMatchObject({ kind: 'doc_sync', path: 'a.ts' });
    expect(session.text('a.ts')).toBe('hello');
  });

  it('applies an inbound doc_sync from another peer and fires onChange', () => {
    const a = makePeer('participant-a');
    const b = makePeer('participant-b');
    a.session.open('a.ts');
    b.session.open('a.ts');
    pump([a, b]); // settle the open-time handshake first — see the note on `pump`

    const onChange = vi.fn<(text: string, from: string) => void>();
    b.session.onChange('a.ts', onChange);

    a.session.localChange('a.ts', (draft) => {
      draft.text = 'hello world';
    });
    pump([a, b]);

    expect(b.session.text('a.ts')).toBe('hello world');
    expect(onChange).toHaveBeenCalledWith('hello world', 'participant-a');
  });

  it('ignores an inbound doc_sync whose from is this client itself', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');
    session.open('a.ts');
    session.localChange('a.ts', (draft) => {
      draft.text = 'hello';
    });

    const onChange = vi.fn<(text: string, from: string) => void>();
    session.onChange('a.ts', onChange);

    // A frame claiming to originate from this same client — e.g. the
    // server's own echo of what we just sent — must be a no-op. The payload
    // is garbage on purpose: reaching Automerge with it would throw, so a
    // clean pass here also proves the echo check happens before decoding.
    const echo: ServerFrame = { kind: 'doc_sync', path: 'a.ts', payload: 'garbage-should-not-matter', from: 'me' };
    const consumed = session.handleFrame(echo);

    expect(consumed).toBe(true);
    expect(session.text('a.ts')).toBe('hello');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('converges two sessions to the same text after concurrent edits, genuinely merging both', () => {
    const a = makePeer('A');
    const b = makePeer('B');
    a.session.open('a.ts');
    b.session.open('a.ts');
    // Establish a shared baseline BOTH sides agree on before editing
    // concurrently — otherwise "concurrent edits" would actually mean
    // "concurrently originating the path's content for the first time",
    // which Automerge resolves as a last-writer-wins key conflict, not a
    // text merge (see `ensure`'s comment on why `docSession` starts every
    // path from `Automerge.init()` instead of `Automerge.from(...)`).
    a.session.localChange('a.ts', (draft) => {
      draft.text = 'hello';
    });
    pump([a, b]);
    expect(b.session.text('a.ts')).toBe('hello');

    // Concurrent: each edits its own view of "hello" before seeing the
    // other's change — one appends, the other prepends, so a genuine
    // character-level merge (not one side clobbering the other) is the only
    // way both land on the same combined string.
    a.session.localChange('a.ts', (draft) => {
      draft.text = 'hello world';
    });
    b.session.localChange('a.ts', (draft) => {
      draft.text = 'say hello';
    });

    const rounds = pump([a, b]);

    expect(rounds).toBeLessThan(20); // sanity: it actually quiesced, not hit the cap
    expect(a.session.text('a.ts')).toBe(b.session.text('a.ts'));
    expect(a.session.text('a.ts')).toBe('say hello world');
  });

  it('delivers a local edit made before the peer has ever replied (no deadlock on a fast typist)', () => {
    // Regression test for a real bug caught while building this: editing
    // immediately after `open()`, before the sync handshake's first round
    // trip completes, used to lose the edit entirely on the other side —
    // not intermittently, but reliably close to half the time (88/200 in
    // the reproduction), because both sides independently originated the
    // "text" key from `Automerge.from()`. A user who starts typing the
    // instant a file opens is not an edge case; it is `open()` immediately
    // followed by a keystroke, which is exactly what this drives.
    const a = makePeer('A');
    const b = makePeer('B');
    a.session.open('a.ts');
    b.session.open('a.ts');
    a.session.localChange('a.ts', (draft) => {
      draft.text = 'hello world';
    });
    // No pre-pump: B has not been heard from at all before A's edit lands.

    pump([a, b]);

    expect(b.session.text('a.ts')).toBe('hello world');
  });

  it('releases the document on close and does not resurrect it on a later inbound frame', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');
    session.open('a.ts');
    session.localChange('a.ts', (draft) => {
      draft.text = 'hello';
    });
    expect(session.text('a.ts')).toBe('hello');

    session.close('a.ts');
    expect(session.text('a.ts')).toBeNull();

    const laterFrame: ServerFrame = {
      kind: 'doc_sync',
      path: 'a.ts',
      payload: 'irrelevant-should-be-dropped',
      from: 'someone-else',
    };
    // Malformed base64 would throw if this frame were actually applied —
    // the point of this assertion is that handleFrame drops it before ever
    // reaching Automerge, since the path has no tracked document any more.
    expect(() => session.handleFrame(laterFrame)).not.toThrow();
    expect(session.text('a.ts')).toBeNull();
  });

  it('sends doc_close and stops tracking on close, and opening twice does not double-subscribe', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');

    session.open('a.ts');
    session.open('a.ts'); // second open must not re-send doc_open or create a second document
    const opens = send.mock.calls.map((c) => c[0]).filter((f) => f.kind === 'doc_open');
    expect(opens).toHaveLength(1);

    session.close('a.ts');
    const closes = send.mock.calls.map((c) => c[0]).filter((f) => f.kind === 'doc_close');
    expect(closes).toEqual([{ kind: 'doc_close', path: 'a.ts' }]);
  });

  it('returns false from handleFrame for a frame kind it does not own', () => {
    const session = createDocSession(vi.fn(), 'me');
    const notOurs: ServerFrame = { kind: 'presence', participants: [], driverId: null };
    expect(session.handleFrame(notOurs)).toBe(false);
  });

  it('routes doc_presence frames to onPresence subscribers for the right path', () => {
    const session = createDocSession(vi.fn(), 'me');
    session.open('a.ts');
    const cb = vi.fn();
    session.onPresence('a.ts', cb);

    const entries = [{ participantId: 'p1', displayName: 'Ada', anchor: 3, head: 5 }];
    const consumed = session.handleFrame({ kind: 'doc_presence', path: 'a.ts', entries });

    expect(consumed).toBe(true);
    expect(cb).toHaveBeenCalledWith(entries);
  });

  it('sends a doc_presence frame from setCursor', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');
    session.setCursor('a.ts', 2, 4);
    expect(send).toHaveBeenCalledWith({ kind: 'doc_presence', path: 'a.ts', anchor: 2, head: 4 });
  });

  it('lets onChange unsubscribe without affecting other subscribers', () => {
    const a = makePeer('participant-a');
    const b = makePeer('participant-b');
    a.session.open('a.ts');
    b.session.open('a.ts');
    pump([a, b]);
    a.outbox.length = 0;
    b.outbox.length = 0;

    const kept = vi.fn();
    const removed = vi.fn();
    b.session.onChange('a.ts', kept);
    const off = b.session.onChange('a.ts', removed);
    off();

    a.session.localChange('a.ts', (draft) => {
      draft.text = 'hi';
    });
    pump([a, b]);

    expect(kept).toHaveBeenCalledWith('hi', 'participant-a');
    expect(removed).not.toHaveBeenCalled();
  });

  it('does not create two documents or two subscriptions when opened twice, even interleaved with onChange', () => {
    const send = vi.fn<(frame: ClientFrame) => void>();
    const session = createDocSession(send, 'me');

    // Subscribing before open() must not stop open() from actually sending
    // doc_open — a lazily-created entry from onChange looks the same as one
    // from open() unless the two are tracked separately.
    session.onChange('a.ts', vi.fn());
    session.open('a.ts');
    session.open('a.ts');

    const opens = send.mock.calls.map((c) => c[0]).filter((f) => f.kind === 'doc_open');
    expect(opens).toHaveLength(1);
  });
});
