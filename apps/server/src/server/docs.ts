/**
 * The room-scoped collaborative document layer (plan phase-11).
 *
 * This module is the WRITE PATH for file content, not a convenience layer on
 * top of the filesystem. Any file open by anyone — human or agent — has a
 * CRDT document, and every edit merges through it; disk stays the source of
 * truth for everything else, and this layer flushes to it (debounced) and is
 * fed external changes back by the watcher (`reconcileExternal`). This is
 * what stops an agent's disk write from racing a human's editor buffer:
 * agents are CRDT peers here, not out-of-band disk writers, the same
 * distinction `doc_sync`'s `from` field draws in `packages/protocol/src/wire.ts`.
 *
 * How this satisfies I3 (see the module comment above `DocSnapshot` in
 * `packages/protocol/src/events.ts`): sync traffic is transient and unlogged,
 * the same way `assistant_delta` is. What the log carries is a periodically
 * compacted `doc_snapshot` plus a coarse `file_edited` per settled edit burst
 * — a document is reconstructible from its last snapshot forward, so the log
 * never becomes a keystroke firehose.
 *
 * ROOM-SCOPED, ALWAYS. The registry below keys by room id first and path
 * second (`Map<roomId, Map<path, DocState>>`), never a bare `Map<path, _>`.
 * A design review of this exact feature caught that a path-only map would let
 * two rooms that each happen to have a file at the same relative path (e.g.
 * both cloned the same starter repo, so both have `src/index.ts`) silently
 * share one CRDT document — editing in one room would appear in the other.
 * Every public entry point below resolves through `resolveWorkspacePath`
 * (the phase-7a jail) before touching a `DocState`, which incidentally is
 * also what keeps two rooms from colliding even if they shared a `Map`: the
 * jail is per-room, but relying on that alone was the exact mistake the
 * review caught, so the room id stays the outer key regardless.
 */

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import * as Automerge from '@automerge/automerge';
import type { UnsequencedEvent } from '@nexus/protocol/events';
import { MAX_SNAPSHOT_BYTES } from '@nexus/protocol/events';
import type { Room } from './rooms.js';
import { WorkspacePathError, readWorkspaceFile, resolveWorkspacePath } from './workspace.js';

/** Same convention as `agent.ts` and `publishTool.ts`: a narrow alias over the
 *  log's append function, so this module never needs to know about `seq`,
 *  `ts` or `roomId` — the room assigns those. In practice only `doc_snapshot`
 *  and `file_edited` ever pass through here; see the `doc_sync`-never-logged
 *  test in `docs.test.ts` for why that is verified rather than assumed. */
export type EmitFn = (event: UnsequencedEvent) => void;

/** The shape every document holds. A single text field rather than a bare
 *  string document because Automerge's own top-level document must be a map
 *  (`from()` requires `Record<string, unknown>`), and a named field leaves
 *  room for a future sibling (e.g. per-file metadata) without a migration. */
interface DocShape {
  text: string;
  /** Automerge's `from()` requires `T extends Record<string, unknown>` (it
   *  builds the initial document from a POJO), which needs a real index
   *  signature to satisfy structurally — a bare `{ text: string }` does not. */
  [key: string]: unknown;
}

/** Who produced a settled edit burst, in the shape `FileEdited` wants (never
 *  both a participant and an agent — see the type's own comment). `null`
 *  means "nobody attributable" (external reconciliation), which flush()
 *  reads as "don't log a file_edited for this settle". */
interface PendingAuthor {
  participantId: string | null;
  agentId?: string;
  displayName: string | null;
}

interface DocState {
  doc: Automerge.Doc<DocShape>;
  /** Participant or agent ids with this path currently open. */
  peers: Set<string>;
  /**
   * The heads that correspond to whatever the outside world — disk, and so
   * any agent that read the file the normal way — last legitimately saw.
   * `applyWholeFileChange` anchors `changeAt` here rather than at the doc's
   * live current heads: a whole-file write's `newText` was computed against
   * THIS state, not against whatever a concurrent peer has typed since, so
   * treating it as a change concurrent with those live edits (rather than a
   * plain diff against them) is what lets both survive. See the "does not
   * clobber a concurrent human edit" test — this is the central mechanism
   * the whole phase exists to prove.
   *
   * Updated to the doc's current heads on every successful flush, because
   * that is the moment disk actually catches up to this state.
   */
  knownHeads: string[];
  /** Exactly what flush() last wrote, so a byte-identical rewrite (guard 1)
   *  and a reconcileExternal echo of our own write (guard 2) are both a
   *  cheap string/hash comparison rather than a false write-then-detect loop. */
  lastFlushedText: string | null;
  lastFlushedHash: string | null;
  lastSnapshotAt: number;
  /** Sum of applied-change bytes since the last logged snapshot — the size
   *  half of "cadence AND size trigger, not per edit". */
  bytesSinceSnapshot: number;
  /** True between "a change landed" and "flush() wrote it out". Distinct from
   *  peer count: a peer who edits then instantly disconnects still needs
   *  their edit flushed, and an idle doc with peers but no changes needs no
   *  flush at all — this flag alone is the correct guard for both. */
  dirty: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pendingAuthor: PendingAuthor | null;
}

export interface DocRegistryOptions {
  /** How long to wait after the last change before writing to disk. */
  flushDebounceMs?: number;
  /** Snapshot at least this often while a document holds any unsnapshotted change. */
  snapshotIntervalMs?: number;
  /** Snapshot immediately once bytes changed since the last snapshot reach this many, regardless of cadence. */
  snapshotSizeTriggerBytes?: number;
  /** Injectable clock, so cadence tests do not need real timers. */
  now?: () => number;
  /**
   * Push a sync payload to every peer with `path` open, for a change that did
   * NOT originate from a single connected socket's request — an agent's edit,
   * or an external reconciliation. `applySync`'s own result already hands its
   * caller a `{ broadcast }` payload for that call's case, because that
   * caller (the WS layer) already knows which peer to exclude (`from`); the
   * two out-of-band cases here have no single origin socket to exclude, so
   * they go out through this callback instead. Optional because a registry
   * built for tests that only assert on the log has nothing to wire it to.
   */
  broadcastSync?: (room: Room, path: string, payloadBase64: string) => void;
}

export interface DocRegistry {
  /**
   * Open (creating on first use) the document at `path` for `peer`. Returns
   * the initial sync payload — every change the document has ever had — for
   * the caller to send to that peer's socket.
   *
   * DEVIATION FROM THE PLAN SHAPE: takes a `peer` id, where the original
   * sketch had `open(room, path)`. Without a peer id here there is no way to
   * count this peer against the "never flush a document with zero peers and
   * no changes" guard, nor to know later that `close(room, path, peer)`
   * refers to someone `open` actually added. `close`'s signature already
   * carried `peer`, so this makes the pair symmetric rather than inventing a
   * new asymmetry.
   */
  open(room: Room, path: string, peer: string): Promise<{ payload: string }>;
  /** Apply one incoming sync payload from `from`, merging it into the live
   *  document. Returns the payload to broadcast to every OTHER peer with this
   *  path open, or null when the incoming message changed nothing (a resend,
   *  or a peer catching the server up on history it already has). */
  applySync(
    room: Room,
    path: string,
    payloadBase64: string,
    from: string,
  ): Promise<{ broadcast: string | null }>;
  /** Peer bookkeeping only. Tolerant of an unknown path or peer — a client's
   *  `doc_close` racing a room teardown is not a caller error. */
  close(room: Room, path: string, peer: string): void;
  /** Apply an agent's whole-file write as a CRDT change, not a disk overwrite
   *  — see `applyWholeFileChange` for why this is what stops it clobbering a
   *  concurrent human edit. */
  applyAgentEdit(room: Room, path: string, agentId: string, newText: string): Promise<void>;
  /** Merge a change observed on disk (git checkout, another process, a
   *  restored backup) into the live document. A no-op when no document is
   *  tracking `path` — disk is already authoritative for a file nobody has
   *  open — or when `diskText` is exactly what this registry itself last
   *  flushed (guard 2: don't fight your own watcher). */
  reconcileExternal(room: Room, path: string, diskText: string): Promise<void>;
  /** Release every document and pending timer for a closed room. Without this
   *  a room's flush timers keep firing (and its documents keep memory live)
   *  forever after the room itself is gone. */
  disposeRoom(roomId: string): void;
}

const DEFAULT_FLUSH_DEBOUNCE_MS = 400;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 30_000;
const DEFAULT_SNAPSHOT_SIZE_TRIGGER_BYTES = 64 * 1024;

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function headsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((h, i) => h === sb[i]);
}

/**
 * Wire (and test) format for one sync payload: a JSON array of base64 Automerge
 * changes, itself base64-encoded so every payload in this module — the initial
 * one from `open()`, an incoming one to `applySync`, an outgoing broadcast —
 * is a single opaque string, matching what `ClientFrame`'s `doc_sync` and
 * `MAX_DOC_PAYLOAD_CHARS` already assume.
 *
 * Deliberately NOT the official Automerge sync protocol
 * (`generateSyncMessage`/`receiveSyncMessage` plus a `SyncState` kept per
 * peer pair). That protocol earns its keep between peers who might already
 * share most of a large document's history and cannot afford to resend it —
 * a real cost for a browser-to-browser mesh, but not for this room-scoped,
 * server-mediated layer, where every payload already fits comfortably under
 * `MAX_DOC_PAYLOAD_CHARS` and the server already holds the one authoritative
 * copy every peer is syncing against. A flat change bundle needs no per-peer
 * state machine to get wrong, and is exactly as correct: Automerge changes
 * merge the same way regardless of the envelope they arrive in.
 */
// Re-exported, not re-implemented. The definition moved to
// `@nexus/protocol/docsync` because the browser client had independently
// implemented a DIFFERENT format and neither side's tests crossed the
// boundary to notice. Keeping the names exported here means this module's
// existing tests and callers are unchanged.
import { decodeChangeBundle, encodeChangeBundle } from '@nexus/protocol/docsync';

export { decodeChangeBundle, encodeChangeBundle };

export function createDocRegistry(emit: EmitFn, options: DocRegistryOptions = {}): DocRegistry {
  const flushDebounceMs = options.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
  const snapshotIntervalMs = options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS;
  const snapshotSizeTriggerBytes = options.snapshotSizeTriggerBytes ?? DEFAULT_SNAPSHOT_SIZE_TRIGGER_BYTES;
  const now = options.now ?? (() => Date.now());
  const broadcastSync = options.broadcastSync;

  // Room id FIRST, always — see the module comment.
  const registry = new Map<string, Map<string, DocState>>();

  function docsFor(roomId: string): Map<string, DocState> {
    let m = registry.get(roomId);
    if (m === undefined) {
      m = new Map();
      registry.set(roomId, m);
    }
    return m;
  }

  /** Jail `path`, then canonicalise it to a root-relative, forward-slash key
   *  — the same normalisation `workspace.ts`'s `listTree` applies — so "a.ts"
   *  and "./a.ts" address one document. Throws `WorkspacePathError` for
   *  anything invalid, missing, or escaping the room's root. */
  function jailedKey(room: Room, path: string): { key: string; real: string } {
    const real = resolveWorkspacePath(room, path);
    const rootReal = resolveWorkspacePath(room, '.');
    return { key: relative(rootReal, real).split(sep).join('/'), real };
  }

  /** Look up a tracked document without creating one. Used by paths that must
   *  never conjure a CRDT document for a file nobody has opened. */
  function findExisting(room: Room, path: string): { key: string; state: DocState } | null {
    let key: string;
    try {
      ({ key } = jailedKey(room, path));
    } catch {
      return null;
    }
    const state = docsFor(room.id).get(key);
    return state === undefined ? null : { key, state };
  }

  function getOrCreate(room: Room, path: string): { key: string; state: DocState } {
    const { key } = jailedKey(room, path);
    const roomDocs = docsFor(room.id);
    const existing = roomDocs.get(key);
    if (existing !== undefined) return { key, state: existing };

    const read = readWorkspaceFile(room, key);
    if (read.kind !== 'text') {
      throw new WorkspacePathError('That file cannot be opened as a collaborative document.', 'invalid');
    }
    const doc = Automerge.from<DocShape>({ text: read.content });
    const state: DocState = {
      doc,
      peers: new Set(),
      knownHeads: Automerge.getHeads(doc),
      lastFlushedText: read.content,
      lastFlushedHash: hashOf(read.content),
      lastSnapshotAt: now(),
      bytesSinceSnapshot: 0,
      dirty: false,
      flushTimer: null,
      pendingAuthor: null,
    };
    roomDocs.set(key, state);
    return { key, state };
  }

  function scheduleFlush(room: Room, key: string, state: DocState): void {
    state.dirty = true;
    if (state.flushTimer !== null) return; // already pending — the debounce is doing its job
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      flush(room, key, state);
    }, flushDebounceMs);
  }

  function flush(room: Room, key: string, state: DocState): void {
    // Guard 1a: nothing pending means nothing to do, regardless of peer
    // count. This alone also covers "never flush an idle document with zero
    // peers": zero peers with an outstanding edit (someone typed then
    // instantly disconnected) SHOULD still flush so the edit is not lost,
    // and that is exactly the case this check does not skip.
    if (!state.dirty) return;

    let real: string;
    try {
      // Re-resolve through the jail every time — the doc may have been
      // opened long before this timer fired, and the path could since have
      // been deleted, moved, or replaced by a symlink.
      real = resolveWorkspacePath(room, key);
    } catch {
      state.dirty = false; // can't safely write; don't spin retrying a dead path
      return;
    }

    const currentText = state.doc.text;
    const currentHash = hashOf(currentText);
    if (currentHash === state.lastFlushedHash) {
      // Guard 1b: byte-identical to what we last wrote. Without this, a
      // change that round-trips to the same text (or a reconcileExternal
      // call whose merge happened to net out to nothing) would still pay for
      // a disk write, which would wake the watcher, which would call
      // reconcileExternal again — an idle room turning into a write loop.
      state.dirty = false;
      return;
    }

    writeFileSync(real, currentText, 'utf8');
    const author = state.pendingAuthor;
    const bytesDelta =
      Buffer.byteLength(currentText, 'utf8') - Buffer.byteLength(state.lastFlushedText ?? '', 'utf8');

    state.lastFlushedText = currentText;
    state.lastFlushedHash = currentHash;
    // Guard 2 half B: disk now reflects this state, so a whole-file write
    // computed against "what's on disk" from this point forward is
    // computed against exactly these heads.
    state.knownHeads = Automerge.getHeads(state.doc);
    state.dirty = false;
    state.pendingAuthor = null;

    // No attributable author (a pure external reconciliation settled with no
    // local edit riding along) logs no file_edited — there is no participant
    // or agent to credit, and FileEdited has no "unknown" author shape.
    if (author !== null) {
      emit({
        type: 'file_edited',
        path: key,
        participantId: author.participantId,
        displayName: author.displayName,
        bytesDelta,
        ...(author.agentId !== undefined ? { agentId: author.agentId } : {}),
      });
    }

    maybeSnapshot(room, key, state);
  }

  /**
   * Cadence AND size trigger, never per edit. `bytesSinceSnapshot` is the
   * size half; `lastSnapshotAt` is the cadence half. Called after every
   * flush rather than only on a fixed timer, so a document that never gets a
   * chance to sit idle (constant edits) still gets checked instead of never
   * crossing the cadence line because the check itself never ran.
   */
  function maybeSnapshot(room: Room, key: string, state: DocState): void {
    const nowMs = now();
    const dueByCadence = nowMs - state.lastSnapshotAt >= snapshotIntervalMs;
    const dueBySize = state.bytesSinceSnapshot >= snapshotSizeTriggerBytes;
    if (!dueByCadence && !dueBySize) return;

    // Always `save()`, never `saveIncremental()` — this is the field's
    // documented format (`packages/protocol/src/events.ts`: "base64 of the
    // CRDT's own binary save()"), and also the safe choice on its own merits:
    // measured 2026-09-06 in this repo, `saveIncremental()` on a freshly
    // loaded document returned MORE bytes than `save()` (496 vs 262) —
    // "incremental" is not a synonym for "smaller" once everything since
    // load counts as unsaved, so there is no size argument for deviating
    // from the documented format here. See docs.test.ts for the
    // reproduction.
    const bytes = Automerge.save(state.doc);
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      // A truncated CRDT binary is a corrupt document, not a smaller one, so
      // this is a skip-and-warn, never a truncate.
      console.warn(
        `[docs] refusing to log a ${bytes.byteLength}-byte snapshot for "${key}" in room ${room.id}: ` +
          `over MAX_SNAPSHOT_BYTES (${MAX_SNAPSHOT_BYTES}). This document will go without a snapshot ` +
          'until it shrinks or the room accepts the loss of history on restart.',
      );
      state.lastSnapshotAt = nowMs; // don't re-attempt on every subsequent edit
      return;
    }

    emit({
      type: 'doc_snapshot',
      path: key,
      snapshot: Buffer.from(bytes).toString('base64'),
      heads: Automerge.getHeads(state.doc),
    });
    state.lastSnapshotAt = nowMs;
    state.bytesSinceSnapshot = 0;
  }

  /**
   * Apply a whole-file replacement (`newContent`) as a change CONCURRENT with
   * whatever has happened to the live document since `state.knownHeads`,
   * rather than as a plain diff against the document's current text.
   *
   * The distinction is the entire phase's central claim. `newContent` was
   * computed by something that read the file the normal way — an agent's
   * `Write` tool, a git checkout — which means it is a modification of the
   * state as of `knownHeads`, not of whatever a concurrent peer has typed
   * into the live document since. Diffing straight against the live text
   * would compute a patch whose target is exactly `newContent`, which — if a
   * concurrent edit added text `newContent` has no way to know about — means
   * that patch necessarily deletes it again. `changeAt` instead grafts the
   * diff-from-knownHeads in as a branch concurrent with the intervening
   * edits; Automerge's own merge (character-identity-based, not index-based)
   * then combines both, because the two changes touch disjoint character
   * ranges by construction (an unrelated concurrent edit cannot get "in the
   * way" of a change anchored before it existed). See
   * "does not clobber a concurrent human edit" in docs.test.ts.
   */
  function applyWholeFileChange(
    room: Room,
    key: string,
    state: DocState,
    newContent: string,
    author: PendingAuthor | null,
  ): Uint8Array[] {
    const before = Automerge.getHeads(state.doc);
    const { newDoc } = Automerge.changeAt<DocShape>(state.doc, state.knownHeads, (d) => {
      Automerge.updateText(d, ['text'], newContent);
    });
    state.doc = newDoc;
    const after = Automerge.getHeads(newDoc);
    if (headsEqual(before, after)) return []; // newContent matched what was already there

    if (author !== null) state.pendingAuthor = author;
    const changes = Automerge.getChangesSince(newDoc, before);
    state.bytesSinceSnapshot += changes.reduce((n, c) => n + c.byteLength, 0);
    scheduleFlush(room, key, state);
    maybeSnapshot(room, key, state);
    return changes;
  }

  /** `from` is a participant id if the room recognises it as one; otherwise
   *  it is an agent id, per `doc_sync`'s own documented convention in
   *  `wire.ts`. The fleet's display-name mapping is not something this
   *  module has access to, so an agent-attributed edit's `displayName` is
   *  null — the same convention `FileEdited` already uses for a null
   *  `participantId`. */
  function attributionFor(room: Room, from: string): PendingAuthor {
    const participant = room.participants.get(from);
    if (participant !== undefined) {
      return { participantId: participant.id, displayName: participant.displayName };
    }
    return { participantId: null, agentId: from, displayName: null };
  }

  return {
    async open(room, path, peer) {
      const { key, state } = getOrCreate(room, path);
      state.peers.add(peer);
      return { payload: encodeChangeBundle(Automerge.getAllChanges(state.doc)) };
    },

    async applySync(room, path, payloadBase64, from) {
      const { key, state } = getOrCreate(room, path);
      const changes = decodeChangeBundle(payloadBase64);
      const before = Automerge.getHeads(state.doc);
      const [newDoc] = Automerge.applyChanges(state.doc, changes);
      state.doc = newDoc;
      const after = Automerge.getHeads(newDoc);
      if (headsEqual(before, after)) return { broadcast: null };

      state.pendingAuthor = attributionFor(room, from);
      const outgoing = Automerge.getChangesSince(newDoc, before);
      state.bytesSinceSnapshot += outgoing.reduce((n, c) => n + c.byteLength, 0);
      scheduleFlush(room, key, state);
      maybeSnapshot(room, key, state);
      return { broadcast: outgoing.length > 0 ? encodeChangeBundle(outgoing) : null };
    },

    close(room, path, peer) {
      const found = findExisting(room, path);
      found?.state.peers.delete(peer);
    },

    async applyAgentEdit(room, path, agentId, newText) {
      const { key, state } = getOrCreate(room, path);
      const changes = applyWholeFileChange(room, key, state, newText, {
        participantId: null,
        agentId,
        displayName: null,
      });
      if (changes.length > 0) broadcastSync?.(room, key, encodeChangeBundle(changes));
    },

    async reconcileExternal(room, path, diskText) {
      // No tracked document means nobody has this file open through the CRDT
      // layer — disk is already authoritative and there is nothing to merge
      // INTO, so this is a deliberate no-op rather than conjuring a document
      // for every file a `git pull` happens to touch.
      const found = findExisting(room, path);
      if (found === null) return;
      const { key, state } = found;

      // Guard 2: this is the watcher reporting our OWN last flush back to us.
      // Without this short-circuit, flush -> watcher notices -> reconcile ->
      // (no-op merge, but still) -> flush again is a loop that never settles.
      if (hashOf(diskText) === state.lastFlushedHash) return;

      const changes = applyWholeFileChange(room, key, state, diskText, null);
      if (changes.length > 0) broadcastSync?.(room, key, encodeChangeBundle(changes));
    },

    disposeRoom(roomId) {
      const roomDocs = registry.get(roomId);
      if (roomDocs === undefined) return;
      for (const state of roomDocs.values()) {
        if (state.flushTimer !== null) clearTimeout(state.flushTimer);
      }
      registry.delete(roomId);
    },
  };
}
