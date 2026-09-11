import { describe, expect, it, vi } from 'vitest';
import * as Automerge from '@automerge/automerge';
import { decodeChangeBundle, encodeChangeBundle } from '@syncode/protocol/docsync';
import type { ClientFrame } from '@syncode/protocol/wire';
import { createDocSession } from '../docSession.js';

/**
 * THE TEST THAT WAS MISSING, and whose absence let phase 11 ship broken.
 *
 * The server encoded a flat bundle of Automerge changes; this client spoke
 * Automerge's official sync protocol. Both sides were internally coherent,
 * carefully argued in their own comments, and fully tested — and they could
 * not talk to each other, because every existing test spoke only to its own
 * side of the wire. Collaborative editing was green on both ends and broken in
 * the middle.
 *
 * So this file deliberately does NOT use the client's own encoder for the
 * inbound direction. It builds a payload the way the SERVER does, feeds it in,
 * and then takes what the client sends and applies it the way the SERVER
 * would. A test that used the client's codec in both directions would pass
 * against exactly the bug this exists to catch.
 */

const PATH = 'src/app.ts';

/** What `DocRegistry.open()` hands a freshly subscribed socket. */
function serverInitialPayload(text: string): { payload: string; doc: Automerge.Doc<{ text: string }> } {
  const doc = Automerge.from({ text });
  return { payload: encodeChangeBundle(Automerge.getAllChanges(doc)), doc };
}

function session() {
  const sent: ClientFrame[] = [];
  const s = createDocSession((frame) => sent.push(frame), 'p_me');
  return { s, sent };
}

describe('the client and the server agree on the doc_sync wire format', () => {
  it('applies a server-shaped payload', () => {
    const { s, sent } = session();
    const { payload } = serverInitialPayload('hello world');

    s.open(PATH);
    s.handleFrame({ kind: 'doc_sync', path: PATH, payload, from: 'server' });

    expect(s.text(PATH)).toBe('hello world');
    expect(sent.some((f) => f.kind === 'doc_open')).toBe(true);
  });

  it('emits a payload the server can decode and apply', () => {
    const { s, sent } = session();
    const { payload, doc } = serverInitialPayload('hello');
    s.open(PATH);
    s.handleFrame({ kind: 'doc_sync', path: PATH, payload, from: 'server' });

    s.localChange(PATH, (draft) => {
      draft.text = 'hello there';
    });

    const outbound = sent.filter((f): f is Extract<ClientFrame, { kind: 'doc_sync' }> => f.kind === 'doc_sync');
    expect(outbound.length).toBeGreaterThan(0);

    // Apply on a SERVER-side replica, using the server's own decoder.
    let serverDoc = doc;
    for (const frame of outbound) {
      const [next] = Automerge.applyChanges(serverDoc, decodeChangeBundle(frame.payload));
      serverDoc = next;
    }
    expect(serverDoc.text).toBe('hello there');
  });

  it('ignores its own echo', () => {
    // The server fans an edit out to every OTHER subscriber, but a reconnect or
    // a relay can still return one. Re-applying your own change is harmless in
    // a CRDT; re-emitting it is not, because it feeds a loop.
    const { s, sent } = session();
    const { payload } = serverInitialPayload('x');
    s.open(PATH);
    s.handleFrame({ kind: 'doc_sync', path: PATH, payload, from: 'server' });
    const before = sent.length;
    s.handleFrame({ kind: 'doc_sync', path: PATH, payload, from: 'p_me' });
    expect(sent.length).toBe(before);
  });
});
