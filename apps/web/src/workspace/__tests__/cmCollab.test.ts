import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientFrame, DocPresenceEntry, ServerFrame } from '@syncode/protocol/wire';
import type { DocSession } from '../docSession.js';
import { createDocSession } from '../docSession.js';
import { collabExtension, minimalReplace } from '../cmCollab.js';

/**
 * Phase 11: `cmCollab.ts` is what makes the editor pane collaborative rather
 * than merely writable. jsdom cannot lay out or measure a real DOM (no
 * `getBoundingClientRect`, no real caret rendering), so nothing here asserts
 * pixel position or visual caret placement — CodeMirror's decoration/DOM
 * construction still runs without layout, which is what makes the presence
 * decoration test below possible at all, but it proves the classed elements
 * exist, not that they land in the right screen position.
 */

// ---------------------------------------------------------------------------
// A hand-rolled DocSession double: full control over WHEN a "remote" change
// or presence update arrives, and a direct read on every localChange call's
// before/after text — needed to tell "one splice per ChangeSet range" apart
// from "one whole-document replace that happens to produce the same string",
// which are otherwise indistinguishable from a single edit's outcome alone.
// ---------------------------------------------------------------------------

interface RecordedLocalChange {
  path: string;
  before: string;
  after: string;
}

function makeFakeSession() {
  const texts = new Map<string, string>();
  const changeListeners = new Map<string, Set<(text: string, from: string) => void>>();
  const presenceListeners = new Map<string, Set<(entries: DocPresenceEntry[]) => void>>();
  const opened: string[] = [];
  const closed: string[] = [];
  const localChangeCalls: RecordedLocalChange[] = [];
  const cursorCalls: Array<{ path: string; anchor: number; head: number }> = [];

  const session: DocSession = {
    open(path) {
      opened.push(path);
    },
    close(path) {
      closed.push(path);
    },
    localChange(path, mutate) {
      const before = texts.get(path) ?? '';
      const view = {
        get text() {
          return texts.get(path) ?? '';
        },
        set text(value: string) {
          texts.set(path, value);
        },
      };
      mutate(view);
      const after = texts.get(path) ?? '';
      localChangeCalls.push({ path, before, after });
    },
    text(path) {
      return texts.has(path) ? texts.get(path)! : null;
    },
    onChange(path, cb) {
      let set = changeListeners.get(path);
      if (set === undefined) {
        set = new Set();
        changeListeners.set(path, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    onPresence(path, cb) {
      let set = presenceListeners.get(path);
      if (set === undefined) {
        set = new Set();
        presenceListeners.set(path, set);
      }
      set.add(cb);
      return () => set.delete(cb);
    },
    setCursor(path, anchor, head) {
      cursorCalls.push({ path, anchor, head });
    },
    handleFrame() {
      return false;
    },
    dispose() {},
  };

  return {
    session,
    opened,
    closed,
    localChangeCalls,
    cursorCalls,
    /** Simulates a `doc_sync` from another peer having already been merged
     *  and reported out via `onChange` — the only thing this module ever
     *  sees of a remote edit. */
    fireChange(path: string, text: string, from: string) {
      texts.set(path, text);
      for (const cb of changeListeners.get(path) ?? []) cb(text, from);
    },
    firePresence(path: string, entries: DocPresenceEntry[]) {
      for (const cb of presenceListeners.get(path) ?? []) cb(entries);
    },
  };
}

function makeView(doc: string, extensions: ReturnType<typeof collabExtension>): EditorView {
  return new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({ doc, extensions: [extensions] }),
  });
}

describe('minimalReplace', () => {
  it('returns null when nothing changed', () => {
    expect(minimalReplace('same', 'same')).toBeNull();
  });

  it('finds a pure insertion at the start as a zero-width splice', () => {
    expect(minimalReplace('hello world', 'XYhello world')).toEqual({ from: 0, to: 0, insert: 'XY' });
  });

  it('finds a pure insertion in the middle', () => {
    expect(minimalReplace('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
  });

  it('finds a deletion as an empty insert over the removed range', () => {
    expect(minimalReplace('hello brave world', 'hello world')).toEqual({ from: 6, to: 12, insert: '' });
  });

  it('finds a same-length replacement', () => {
    expect(minimalReplace('cat sat', 'cat bat')).toEqual({ from: 4, to: 5, insert: 'b' });
  });
});

describe('collabExtension', () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  it('opens the path on construction and closes it on destroy', () => {
    const fake = makeFakeSession();
    view = makeView('hello', collabExtension(fake.session, 'a.ts', 'me'));

    expect(fake.opened).toEqual(['a.ts']);
    expect(fake.closed).toEqual([]);

    view.destroy();
    view = null;
    expect(fake.closed).toEqual(['a.ts']);
  });

  it('sends a typed insertion as a targeted splice, not a whole-document replace', () => {
    const fake = makeFakeSession();
    view = makeView('hello world', collabExtension(fake.session, 'a.ts', 'me'));

    // Simulate typing "X" at position 5 (between "hello" and " world") —
    // this is what a real keystroke's transaction looks like: one range,
    // not a document-wide rebuild.
    view.dispatch({ changes: { from: 5, to: 5, insert: 'X' } });

    expect(fake.localChangeCalls).toHaveLength(1);
    const call = fake.localChangeCalls[0]!;
    // The falsifying assertion: a "whole document replace" implementation
    // would call localChange with `before` equal to whatever the SESSION
    // already held (here: '', since nothing has synced yet) — not the
    // view's actual 11-character pre-edit text. A per-range splice built
    // from the view's own text produces a `before` matching the view, and
    // an `after` that is the view's own text with only that one range
    // changed.
    expect(call.before).toBe('');
    expect(call.after).toBe('helloX world');
    expect(view.state.doc.toString()).toBe('helloX world');
  });

  it('emits one localChange call PER ChangeSet range for a multi-range transaction', () => {
    // This is the assertion that actually distinguishes "per-range splice"
    // from "one whole-document replace that happens to look the same for a
    // single edit": a transaction with two disjoint edit regions can only
    // produce two separate localChange calls if the implementation is
    // genuinely iterating `ChangeSet.iterChanges`, not diffing the whole
    // buffer once.
    const fake = makeFakeSession();
    view = makeView('aaaa bbbb cccc', collabExtension(fake.session, 'a.ts', 'me'));

    view.dispatch({
      changes: [
        { from: 0, to: 0, insert: '1' },
        { from: 14, to: 14, insert: '2' },
      ],
    });

    expect(fake.localChangeCalls).toHaveLength(2);
    expect(view.state.doc.toString()).toBe('1aaaa bbbb cccc2');
    // The final call's `after` must reflect BOTH edits, not just the second
    // one applied in isolation to a stale base.
    expect(fake.localChangeCalls[1]!.after).toBe('1aaaa bbbb cccc2');
  });

  it('applies a remote change to the view without producing an outbound localChange (no echo)', () => {
    const fake = makeFakeSession();
    view = makeView('hello', collabExtension(fake.session, 'a.ts', 'me'));

    fake.fireChange('a.ts', 'hello world', 'someone-else');

    expect(view.state.doc.toString()).toBe('hello world');
    expect(fake.localChangeCalls).toHaveLength(0);
  });

  it('preserves the local selection across a remote insertion made before the cursor', () => {
    const fake = makeFakeSession();
    view = makeView('hello world', collabExtension(fake.session, 'a.ts', 'me'));
    // Cursor right after "hello " (position 6), before the remote edit lands.
    view.dispatch({ selection: { anchor: 6, head: 6 } });
    expect(view.state.selection.main.head).toBe(6);

    // A remote peer prepends "XY" — entirely before the cursor.
    fake.fireChange('a.ts', 'XYhello world', 'someone-else');

    expect(view.state.doc.toString()).toBe('XYhello world');
    // The offset must move by the inserted length (2), not stay at 6 (which
    // would now sit one character into "hello" instead of after it) and not
    // collapse to some unrelated position the way a naive whole-document
    // replace's selection mapping would.
    expect(view.state.selection.main.anchor).toBe(8);
    expect(view.state.selection.main.head).toBe(8);
  });

  it('leaves a selection entirely after a remote deletion mapped back correctly', () => {
    const fake = makeFakeSession();
    view = makeView('hello brave world', collabExtension(fake.session, 'a.ts', 'me'));
    // Cursor at the end of the document.
    view.dispatch({ selection: { anchor: 17, head: 17 } });

    // Remote peer deletes "brave " (6 chars) from the middle.
    fake.fireChange('a.ts', 'hello world', 'someone-else');

    expect(view.state.doc.toString()).toBe('hello world');
    expect(view.state.selection.main.head).toBe(11); // 17 - 6
  });

  it('reports the local cursor via setCursor, throttled', () => {
    vi.useFakeTimers();
    try {
      const fake = makeFakeSession();
      view = makeView('hello world', collabExtension(fake.session, 'a.ts', 'me'));
      fake.cursorCalls.length = 0; // drop whatever the initial mount reported

      view.dispatch({ selection: { anchor: 1, head: 1 } });
      view.dispatch({ selection: { anchor: 2, head: 2 } });
      view.dispatch({ selection: { anchor: 3, head: 3 } });

      // The first call fires immediately (nothing throttling it yet); the
      // next two land inside the throttle window and must be coalesced.
      expect(fake.cursorCalls).toEqual([{ path: 'a.ts', anchor: 1, head: 1 }]);

      vi.advanceTimersByTime(200);

      // The trailing call carries the LAST position, not a dropped one.
      expect(fake.cursorCalls).toEqual([
        { path: 'a.ts', anchor: 1, head: 1 },
        { path: 'a.ts', anchor: 3, head: 3 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes this client\'s own id from the remote-cursor decoration layer', () => {
    const fake = makeFakeSession();
    view = makeView('hello world', collabExtension(fake.session, 'a.ts', 'me'));

    fake.firePresence('a.ts', [
      { participantId: 'me', displayName: 'Self', anchor: 0, head: 0 },
      { participantId: 'other', displayName: 'Priya', anchor: 6, head: 6 },
    ]);

    const html = view.dom.querySelector('.cm-content')?.innerHTML ?? '';
    expect(html).not.toContain('Self');
    expect(html).toContain('Priya');
  });

  it('draws a mark decoration for a non-empty remote selection', () => {
    const fake = makeFakeSession();
    view = makeView('hello world', collabExtension(fake.session, 'a.ts', 'me'));

    fake.firePresence('a.ts', [{ participantId: 'other', displayName: 'Priya', anchor: 0, head: 5 }]);

    expect(view.dom.querySelector('.nx-remote-selection')).not.toBeNull();
    expect(view.dom.querySelector('.nx-remote-caret-label')?.textContent).toBe('Priya');
  });
});

// ---------------------------------------------------------------------------
// One end-to-end test against the REAL DocSession/Automerge stack (the same
// `pump`-to-quiescence technique `docSession.test.ts` uses), proving the
// whole pipe genuinely works and not just that cmCollab calls the right mock
// methods: typing in one view reaches a second view's document via a live
// CRDT sync round trip.
// ---------------------------------------------------------------------------

interface Peer {
  id: string;
  session: DocSession;
  outbox: ClientFrame[];
  view: EditorView;
}

function makeRealPeer(id: string, doc: string): Peer {
  const outbox: ClientFrame[] = [];
  const session = createDocSession((frame) => outbox.push(frame), id);
  const view = makeView(doc, collabExtension(session, 'shared.ts', id));
  return { id, session, outbox, view };
}

function pump(peers: Peer[], maxRounds = 20): void {
  let rounds = 0;
  while (peers.some((p) => p.outbox.length > 0) && rounds < maxRounds) {
    rounds += 1;
    const batches = peers.map((p) => ({ from: p.id, frames: p.outbox.splice(0, p.outbox.length) }));
    for (const batch of batches) {
      for (const frame of batch.frames) {
        if (frame.kind !== 'doc_sync') continue;
        for (const other of peers) {
          if (other.id === batch.from) continue;
          const serverFrame: ServerFrame = { kind: 'doc_sync', path: frame.path, payload: frame.payload, from: batch.from };
          other.session.handleFrame(serverFrame);
        }
      }
    }
  }
}

describe('collabExtension against a real DocSession', () => {
  it('propagates a keystroke in one view to a second peer\'s view', () => {
    const a = makeRealPeer('participant-a', '');
    const b = makeRealPeer('participant-b', '');
    try {
      pump([a, b]); // settle the open-time handshake first

      a.view.dispatch({ changes: { from: 0, to: 0, insert: 'hello' } });
      pump([a, b]);

      expect(b.view.state.doc.toString()).toBe('hello');
      // And the reverse direction, appended rather than replaced:
      b.view.dispatch({ changes: { from: 5, to: 5, insert: ' world' } });
      pump([a, b]);

      expect(a.view.state.doc.toString()).toBe('hello world');
    } finally {
      a.view.destroy();
      b.view.destroy();
    }
  });
});
