import * as Automerge from '@automerge/automerge';
import { decodeChangeBundle, encodeChangeBundle } from '@syncode/protocol/docsync';
import type { ClientFrame, DocPresenceEntry, ServerFrame } from '@syncode/protocol/wire';

/** The one shape every open document holds. Kept minimal on purpose: phase 11
 *  only needs plain-text collaborative editing, and a richer shape (blocks,
 *  marks) is a later phase's problem, not this one's. */
interface DocShape {
  text: string;
}

type ChangeListener = (text: string, from: string) => void;
type PresenceListener = (entries: DocPresenceEntry[]) => void;

interface PathEntry {
  doc: Automerge.Doc<DocShape>;
  /**
   * The heads this session has already handed to the server — everything at or
   * behind these is known to be over there, so `getChangesSince` against them
   * is exactly "what is new".
   *
   * Replaces an `Automerge.SyncState`. The official sync protocol earns its
   * keep between peers who might each hold history the other lacks; here the
   * server holds the one authoritative copy and relays to everyone, and the
   * two sides MUST agree on an envelope. They did not: this client spoke the
   * sync protocol while the server sent flat change bundles, both were fully
   * tested against themselves, and collaborative editing was broken across the
   * wire with every suite green. The format now lives in
   * `@syncode/protocol/docsync` so there is only one of it.
   */
  lastSentHeads: Automerge.Heads;
  /**
   * Whether `doc_open` has actually been sent for this path. Tracked
   * separately from "does an entry exist in `paths`" because `onChange` /
   * `onPresence` are allowed to subscribe before `open()` runs (see there) —
   * without this flag, that lazy creation would make a *second* `open()`
   * call think the path was already subscribed and silently skip sending
   * `doc_open` to the server.
   */
  opened: boolean;
  changeListeners: Set<ChangeListener>;
  presenceListeners: Set<PresenceListener>;
}

/**
 * Client-side half of phase 11's collaborative document layer: one Automerge
 * document and one sync state per open path, fed by `doc_sync` /
 * `doc_presence` frames and feeding them back out.
 *
 * Deliberately outside React state and the room reducer (`store.ts`'s
 * `doc_sync`/`doc_presence` cases document why): this is keystroke-rate, and
 * folding it into `RoomView` would re-render the transcript, the roster and
 * the approval queue on every character anyone types in any open file. This
 * session subscribes to the socket directly (via `handleFrame`, called
 * alongside — not instead of — the room reducer) and notifies only the
 * callbacks registered for the path that actually changed, the same way
 * `useWorkspace` keeps the REST file cache outside the log-derived view.
 */
export interface DocSession {
  open(path: string): void;
  close(path: string): void;
  localChange(path: string, mutate: (draft: DocShape) => void): void;
  text(path: string): string | null;
  onChange(path: string, cb: ChangeListener): () => void;
  onPresence(path: string, cb: PresenceListener): () => void;
  setCursor(path: string, anchor: number, head: number): void;
  /** Returns true when this frame was one of ours (`doc_sync` / `doc_presence`),
   *  regardless of whether it changed anything — so the caller (the room
   *  reducer's dispatch point) knows not to hand it to `reduce` as well, and
   *  so forward-compatible unknown frames still fall through untouched. */
  handleFrame(frame: ServerFrame): boolean;
  dispose(): void;
}

/**
 * @param send Puts one `ClientFrame` on the wire. Takes a plain function
 *   rather than the `Connection` from `ws.ts` so this is testable without a
 *   real (or fake) WebSocket — a spy plus `handleFrame` is the whole harness.
 * @param selfId This client's own participant id. A plain string rather than
 *   a live accessor: `ws.ts`'s resume-token mechanism keeps a participant id
 *   stable for the lifetime of an identity, and a doc session's lifetime
 *   never outlives the identity it was created for (a reconnect that hands
 *   back the SAME id doesn't need a new session; one that doesn't is a
 *   different room membership entirely). Needed at all so `handleFrame` can
 *   recognize — and drop — the server's echo of this client's own edits
 *   (REQUIREMENTS: "ignore your own echo").
 */
export function createDocSession(send: (frame: ClientFrame) => void, selfId: string): DocSession {
  const paths = new Map<string, PathEntry>();

  function ensure(path: string): PathEntry {
    let entry = paths.get(path);
    if (entry === undefined) {
      entry = {
        // `Automerge.init()`, NOT `Automerge.from({text: ''})`. This is load
        // bearing, not stylistic — verified by hand against a real
        // correctness bug: `from()` performs a `change()` on creation, so
        // two sessions that both call it independently (which is exactly
        // what happens here, since neither has talked to a peer yet) each
        // originate their OWN "text" key from an unrelated root. When their
        // histories later merge, Automerge treats that as two actors
        // concurrently writing the same map key — a last-writer-wins
        // conflict at the KEY level, resolved by an internal tie-break, not
        // a character-level text merge. In a race where one session edits
        // before ever hearing from the other, this made the edit vanish
        // outright on the other side roughly half the time (measured: 88 of
        // 200 trials). `init()` starts with no keys at all, so a session is
        // never the one who invents this path's content unless it is
        // genuinely the first to write to it (see `localChange`'s create-vs-
        // update branch) — every other case receives "text" as an ordinary
        // key addition via sync, with no competing origin to conflict with.
        doc: Automerge.init<DocShape>(),
        lastSentHeads: [],
        opened: false,
        changeListeners: new Set(),
        presenceListeners: new Set(),
      };
      paths.set(path, entry);
    }
    return entry;
  }

  /** Generate this path's next sync message against its one peer (the
   *  server relays it on; the automerge sync protocol only needs one
   *  `SyncState` per remote endpoint this side talks to directly) and send
   *  it — but only when there is actually something new to say. Most calls
   *  after the first couple of rounds produce `null`, and sending an empty
   *  sync message on every keystroke would defeat the point of a sync
   *  protocol over "just send the whole document". */
  function sync(path: string, entry: PathEntry): void {
    const changes = Automerge.getChangesSince(entry.doc, entry.lastSentHeads);
    // Nothing new to say. Common: every remote frame ends by calling this, and
    // a receive leaves nothing outstanding.
    if (changes.length === 0) return;
    entry.lastSentHeads = Automerge.getHeads(entry.doc);
    send({ kind: 'doc_sync', path, payload: encodeChangeBundle(changes) });
  }

  return {
    open(path) {
      const entry = ensure(path);
      if (entry.opened) return; // already subscribed — see PathEntry.opened
      entry.opened = true;
      send({ kind: 'doc_open', path });
      // Kick off the sync handshake immediately, matching automerge's own
      // documented usage (`initSyncState` then `generateSyncMessage` before
      // any message has been received). This matters even for a brand-new,
      // untouched document: a peer that already holds this path's content —
      // typically the server — will not proactively volunteer it. Verified
      // empirically: a peer with content that only ever generates messages
      // BLINDLY (never having received anything back) keeps producing
      // probes that never carry the actual changes; it only sends real
      // content once it has received something from the other side. Without
      // this call, two freshly opened sessions would deadlock — each
      // waiting for the other to speak first.
      sync(path, entry);
    },

    close(path) {
      // Deliberately `paths.get`, not `ensure`: closing a path nobody has
      // opened must not create one just to immediately release it.
      const entry = paths.get(path);
      if (entry === undefined) return;
      paths.delete(path);
      send({ kind: 'doc_close', path });
    },

    localChange(path, mutate) {
      // Requires the path to already be tracked. Editing a path this session
      // never opened (or has since closed) has nowhere to go on the wire —
      // there is no server-side subscription for it to ride — so it is a
      // no-op rather than silently opening one behind the caller's back.
      const entry = paths.get(path);
      if (entry === undefined) return;
      entry.doc = Automerge.change(entry.doc, (draft) => {
        // `mutate` receives a plain `{text}` shape and may reassign `.text`
        // wholesale (an editor hands over its whole current buffer, not a
        // diff). A raw `draft.text = value` inside `Automerge.change` is a
        // last-writer-wins register replace, NOT a character-level merge —
        // verified empirically: two concurrent whole-string assignments from
        // a shared base merge to whichever wins the tie-break, dropping the
        // other's edit entirely. Automerge's own `updateText` computes the
        // diff against the current value and applies it as splices, which is
        // what actually merges two people's edits instead of one clobbering
        // the other. It requires the key to already hold a string, though —
        // verified to throw ("path component referenced a nonexistent
        // object") on a document from `Automerge.init()` before anything has
        // ever written `text` — so the very first write for a path (no peer
        // has originated it yet) must be a plain create instead.
        //
        // This wrapper — a plain object closing over the real Automerge
        // proxy, rather than `draft` itself — is the seam that routes
        // `mutate`'s `draft.text = x` through `updateText` instead of a
        // plain property set. Redefining `text` on `draft` directly does not
        // work: Automerge's own proxy traps do not support accessor
        // properties, and a getter that reads `draft.text` after
        // overwriting `draft.text` with itself would recurse forever.
        const view: DocShape = {
          get text() {
            return readText(draft);
          },
          set text(value: string) {
            if ((draft as Partial<DocShape>).text === undefined) {
              draft.text = value;
            } else {
              Automerge.updateText(draft, ['text'], value);
            }
          },
        };
        mutate(view);
      });
      sync(path, entry);
    },

    text(path) {
      // Read-only: uses `paths.get`, never `ensure`, so a lookup never has
      // the side effect of allocating a document. `null` means "no tracked
      // document for this path" specifically (never opened, or since
      // closed) — distinct from `readText`'s `''`, which is a real, tracked,
      // just-not-yet-populated document (opened but nothing received or
      // written yet, since `Automerge.init()` starts with no `text` key at
      // all). Collapsing those into one `null` would make a freshly opened
      // path indistinguishable from one that was never opened.
      const entry = paths.get(path);
      return entry === undefined ? null : readText(entry.doc);
    },

    onChange(path, cb) {
      // `ensure`, not `paths.get`: a component is allowed to subscribe
      // before calling `open()` (or after `close()`, ahead of reopening)
      // without losing the callback — it just won't fire until the path is
      // actually open and a frame arrives. See PathEntry.opened for how this
      // stays safe against a later `open()` skipping its `doc_open` send.
      const entry = ensure(path);
      entry.changeListeners.add(cb);
      return () => entry.changeListeners.delete(cb);
    },

    onPresence(path, cb) {
      const entry = ensure(path);
      entry.presenceListeners.add(cb);
      return () => entry.presenceListeners.delete(cb);
    },

    setCursor(path, anchor, head) {
      send({ kind: 'doc_presence', path, anchor, head });
    },

    handleFrame(frame) {
      switch (frame.kind) {
        case 'doc_sync': {
          // Our own edit, echoed back by the server's fan-out to every
          // socket that has this path open (itself included). Re-applying
          // it would be harmless to the CRDT (automerge is idempotent), but
          // it is exactly what REQUIREMENTS calls out to skip, and skipping
          // it early avoids a spurious `onChange` firing for a change the
          // caller already knows about (it made it).
          if (frame.from === selfId) return true;
          // `paths.get`, not `ensure`: an inbound frame for a path this
          // session has since closed (or never opened) must not resurrect a
          // document. The server should not be sending it — this socket
          // told the server it closed the path — but a stale in-flight
          // frame from just before that `doc_close` landed is not a
          // hostile case, just a race, and dropping it silently is correct.
          const entry = paths.get(frame.path);
          if (entry === undefined) return true;
          const previousText = readText(entry.doc);
          const [nextDoc] = Automerge.applyChanges(
            entry.doc,
            decodeChangeBundle(frame.payload),
          );
          entry.doc = nextDoc;
          // The server sent us what it had, and it already holds everything we
          // had sent — so after applying, the two sides are level. Advancing
          // the mark here is what stops `sync()` below from immediately
          // shipping the remote changes straight back and feeding a loop.
          entry.lastSentHeads = Automerge.getHeads(entry.doc);
          // Only notify when the visible text actually moved. A sync
          // message can be pure bookkeeping (a bloom-filter probe that
          // turns out to describe state both sides already agree on), and
          // firing `onChange` for those would be a no-op re-render for
          // every subscriber, every round of the protocol.
          const nextText = readText(entry.doc);
          if (nextText !== previousText) {
            for (const cb of entry.changeListeners) cb(nextText, frame.from);
          }
          // The sync protocol is multi-round: receiving a message often
          // means there is now something new to say back (REQUIREMENTS:
          // "after every ... received one").
          sync(frame.path, entry);
          return true;
        }
        case 'doc_presence': {
          const entry = paths.get(frame.path);
          if (entry === undefined) return true;
          for (const cb of entry.presenceListeners) cb(frame.entries);
          return true;
        }
        default:
          // Not ours. Every other frame kind belongs to the room reducer;
          // returning false here (rather than swallowing) is what lets the
          // caller still dispatch it there.
          return false;
      }
    },

    dispose() {
      // No per-path `doc_close` sent here: `dispose` tears down the whole
      // session, which in practice happens because the socket underneath it
      // is already going away (unmount, room switch). Writing to a socket
      // mid-teardown buys nothing the server needs — it will see every
      // subscription vanish when the connection drops.
      paths.clear();
    },
  };
}

/**
 * `DocShape` types `text` as always present, but a document fresh out of
 * `Automerge.init()` genuinely has no keys at all until something writes to
 * it — the type describes the shape once populated, not the empty starting
 * state. Centralized here so every read site agrees on the same fallback
 * rather than each guessing `?? ''` independently.
 */
function readText(doc: Automerge.Doc<DocShape>): string {
  return (doc as Partial<DocShape>).text ?? '';
}

/**
 * `ServerFrame`/`ClientFrame`'s `doc_sync.payload` is a `string` (JSON has no
 * byte-array type); Automerge's sync messages are `Uint8Array`. Base64 is the
 * obvious bridge, and `btoa`/`atob` operate on binary strings (one JS char per
 * byte, not UTF-8), so bytes go through `String.fromCharCode`/`charCodeAt`
 * rather than a text encoder — both are available as real browser globals
 * (not a Node-only `Buffer` shim), and are also stable Node 22 globals, so
 * this file works unchanged in the browser bundle and under vitest/jsdom.
 */
