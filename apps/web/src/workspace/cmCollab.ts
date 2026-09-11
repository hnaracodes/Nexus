import { Annotation, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, PluginValue, ViewUpdate } from '@codemirror/view';
import type { DocPresenceEntry } from '@syncode/protocol/wire';
import { avatarFor } from '../identity.js';
import type { DocSession } from './docSession.js';

/**
 * Binds one CodeMirror 6 `EditorView` to one open path on a `DocSession`
 * (phase 11): local keystrokes become CRDT splices, the CRDT's text becomes
 * view transactions, and remote cursors become a decoration layer. Everything
 * lives inside a single `ViewPlugin` because the view's own lifecycle — one
 * instance per open file, per `CodeEditor.tsx`'s `key={path}` — is exactly
 * the lifecycle a `doc_open`/`doc_close` pair needs: the plugin opens on
 * construction and closes on `destroy()`, which CodeMirror calls whenever
 * `EditorView.destroy()` runs (file switch or unmount).
 */

/**
 * Tags a transaction as applying content that came FROM the session (a
 * `doc_sync`-derived remote edit), not from the user typing. Without this,
 * `update()` cannot tell its own dispatched transaction apart from a real
 * keystroke and would feed the just-received text straight back into
 * `session.localChange` — a self-inflicted echo. Automerge would no-op the
 * resulting change (it already has this content), so the failure mode isn't
 * corruption, but every remote edit would round-trip a wasted sync message
 * back at the peer that just sent it, and worse: `update()` would then
 * process the RESULTING doc-changed update as *another* local edit needing
 * the same annotation check, and so on for every downstream reaction — the
 * kind of feedback loop that hangs a tab rather than fails loudly.
 */
const remoteOrigin = Annotation.define<true>();

/** Coalesces `session.setCursor` calls so a held-down arrow key doesn't put
 *  one `doc_presence` frame on the wire per repeat event. Trailing-edge: the
 *  LAST position always wins and is never dropped, only delayed. */
const CURSOR_THROTTLE_MS = 80;

interface CollabArg {
  session: DocSession;
  path: string;
  /** Used only to exclude this client's own entry from the remote-cursor
   *  decoration layer — never sent anywhere. See `buildDecorations`. */
  selfId: string;
}

class CollabPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;

  private readonly view: EditorView;
  private readonly session: DocSession;
  private readonly path: string;
  private readonly selfId: string;
  private readonly unsubscribeChange: () => void;
  private readonly unsubscribePresence: () => void;
  private readonly reportCursor: ReturnType<typeof throttle>;
  /** The last position reported to the session, so `update()` only calls
   *  `setCursor` when the caret actually moved — a doc-changed update fires
   *  on every keystroke regardless of whether the selection went anywhere. */
  private lastAnchor = -1;
  private lastHead = -1;

  constructor(view: EditorView, { session, path, selfId }: CollabArg) {
    this.view = view;
    this.session = session;
    this.path = path;
    this.selfId = selfId;
    this.reportCursor = throttle((anchor: number, head: number) => session.setCursor(path, anchor, head), CURSOR_THROTTLE_MS);

    session.open(path);
    this.unsubscribeChange = session.onChange(path, (text) => this.applyRemote(text));
    this.unsubscribePresence = session.onPresence(path, (entries) => this.applyPresence(entries));
  }

  update(update: ViewUpdate): void {
    // Remote-cursor decorations are positions in THIS document; if the doc
    // just changed (local or remote — both move them) they must move too, or
    // a caret drawn at "column 12" stays at column 12 after a line above it
    // is deleted, now pointing at the wrong character entirely.
    this.decorations = this.decorations.map(update.changes);

    if (update.docChanged) {
      const isRemoteEcho = update.transactions.some((tr) => tr.annotation(remoteOrigin) === true);
      if (!isRemoteEcho) this.emitLocalSplices(update);
    }

    const sel = update.state.selection.main;
    if (sel.anchor !== this.lastAnchor || sel.head !== this.lastHead) {
      this.lastAnchor = sel.anchor;
      this.lastHead = sel.head;
      this.reportCursor.call(sel.anchor, sel.head);
    }
  }

  destroy(): void {
    this.unsubscribeChange();
    this.unsubscribePresence();
    this.reportCursor.cancel();
    this.session.close(this.path);
  }

  /**
   * Turns this update's `ChangeSet` into one `session.localChange` call PER
   * changed range, each a targeted splice — never one call handing over
   * `view.state.doc.toString()` as a blind whole-document replacement. That
   * distinction is the entire point of routing edits through a CRDT: a
   * whole-document replace makes Automerge diff the full buffer against
   * whatever the CRDT currently holds, which for two people typing in
   * different parts of the same file at the same moment turns every
   * keystroke into an apparent conflict over the same "text" value instead
   * of two independent, non-overlapping splices.
   *
   * Ranges come from `iterChanges` in ORIGINAL-document order and are
   * applied right-to-left. `fromA`/`toA` are offsets into the document as it
   * was BEFORE this transaction; editing the rightmost range first means
   * every range still to be processed lies entirely to its left, so its
   * offsets are never invalidated by a length change further right. Reusing
   * `before` (this view's own pre-transaction text) — never re-reading
   * `draft.text` from the session — is what makes the very first edit on a
   * freshly opened, not-yet-synced path safe: `docSession.localChange`
   * treats a path's first-ever write as a plain create (see its own
   * comment), so handing it "the file as this view already shows it, plus
   * this one edit" is exactly the content that first write should become,
   * regardless of whether the CRDT has caught up to this view yet.
   */
  private emitLocalSplices(update: ViewUpdate): void {
    const ranges: Array<{ fromA: number; toA: number; insert: string }> = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      ranges.push({ fromA, toA, insert: inserted.toString() });
    });

    let acc = update.startState.doc.toString();
    for (let i = ranges.length - 1; i >= 0; i--) {
      const { fromA, toA, insert } = ranges[i]!;
      acc = acc.slice(0, fromA) + insert + acc.slice(toA);
      const text = acc;
      this.session.localChange(this.path, (draft) => {
        draft.text = text;
      });
    }
  }

  /**
   * Applies the session's new joined text as a targeted splice, tagged so
   * `update()` above does not loop it straight back out. No explicit
   * `selection` is set on the dispatched spec — `Transaction.newSelection`
   * (see `@codemirror/state`) maps an unset selection through the change by
   * default, which is what lets a remote edit shift this view's OWN cursor
   * by the right amount instead of leaving it at a now-wrong raw offset (or
   * a naive whole-doc replace collapsing it to one end of the document).
   */
  private applyRemote(text: string): void {
    const current = this.view.state.doc.toString();
    const change = minimalReplace(current, text);
    if (change === null) return; // sync round-trip that changed nothing visible
    this.view.dispatch({ changes: change, annotations: remoteOrigin.of(true) });
  }

  private applyPresence(entries: readonly DocPresenceEntry[]): void {
    this.decorations = buildDecorations(entries, this.selfId, this.view.state.doc.length);
    // Decorations are read from this plugin's own field on every update, so
    // any dispatch — even one with no changes and no selection — is enough
    // to make CodeMirror re-render with the freshly rebuilt set.
    this.view.dispatch({});
  }
}

const collabViewPlugin = ViewPlugin.fromClass(CollabPlugin, {
  decorations: (plugin) => plugin.decorations,
});

/** The extension `CodeEditor.tsx` adds to a view's config when it has both a
 *  `DocSession` and a path to edit. See the module doc above for what it does. */
export function collabExtension(session: DocSession, path: string, selfId: string): Extension {
  return collabViewPlugin.of({ session, path, selfId });
}

/**
 * The smallest single-region diff between two full-text snapshots.
 *
 * `docSession.onChange` only ever hands this module the RESULT of a remote
 * edit as one joined string — Automerge's sync protocol is a CRDT merge, not
 * "here is the op that produced this," so there is no operation to replay.
 * Turning the result back into a `{from, to, insert}` splice (rather than
 * `{from: 0, to: current.length, insert: text}`) is what lets the dispatched
 * transaction leave everything outside the changed region alone and lets
 * CodeMirror's default selection-mapping put the local cursor in the right
 * place instead of at whichever end of the document a whole-doc replace
 * would collapse it to.
 *
 * A common-prefix / common-suffix scan finds exactly one contiguous hunk. It
 * is not a general multi-hunk diff — two edits landing in unrelated parts of
 * the same incoming snapshot collapse into one hunk spanning both — but it
 * is exact for the overwhelmingly common case (one person's one edit), and
 * the failure mode of "one hunk larger than strictly necessary" is a bigger
 * selection jump for anyone editing near BOTH changed regions at once, never
 * lost or corrupted text.
 */
export function minimalReplace(oldText: string, newText: string): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null;
  const maxCommon = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < maxCommon && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > prefix && newEnd > prefix && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { from: prefix, to: oldEnd, insert: newText.slice(prefix, newEnd) };
}

/**
 * One coloured caret + name per remote participant, one translucent mark per
 * non-empty remote selection. Hue comes from `avatarFor` (`identity.ts`),
 * which sources it from `AVATAR_HUES` in `design/tokens.ts` — the same
 * function that colours a participant's avatar and roster row elsewhere in
 * the room, so a remote cursor is recognizably the same person's colour
 * without this module inventing a second palette.
 *
 * `selfId` is excluded outright: `session.onPresence` reports every open
 * participant on this path, including this client, and drawing your own
 * caret as a "remote" one would double it up against the real browser caret
 * sitting on top of it.
 */
function buildDecorations(entries: readonly DocPresenceEntry[], selfId: string, docLength: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const entry of entries) {
    if (entry.participantId === selfId) continue;
    const { hue } = avatarFor(entry.participantId, entry.displayName);
    const lo = clamp(Math.min(entry.anchor, entry.head), 0, docLength);
    const hi = clamp(Math.max(entry.anchor, entry.head), 0, docLength);
    if (lo !== hi) {
      ranges.push(
        Decoration.mark({
          class: 'nx-remote-selection',
          attributes: { style: `background-color: hsl(${hue} 55% 45% / 0.35)` },
        }).range(lo, hi),
      );
    }
    const caretPos = clamp(entry.head, 0, docLength);
    ranges.push(Decoration.widget({ widget: new RemoteCaretWidget(entry.displayName, hue), side: 1 }).range(caretPos));
  }
  // `sort: true` — entries arrive in whatever order the server enumerated
  // participants, not in document-position order, and `Decoration.set`
  // requires sorted ranges.
  return Decoration.set(ranges, true);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

class RemoteCaretWidget extends WidgetType {
  constructor(
    private readonly displayName: string,
    private readonly hue: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof RemoteCaretWidget && other.displayName === this.displayName && other.hue === this.hue;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'nx-remote-caret';
    caret.style.borderLeft = `2px solid hsl(${this.hue} 55% 45%)`;
    const label = document.createElement('span');
    label.className = 'nx-remote-caret-label';
    label.style.backgroundColor = `hsl(${this.hue} 55% 45%)`;
    label.textContent = this.displayName;
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

interface Throttled {
  call(anchor: number, head: number): void;
  cancel(): void;
}

/** Trailing-edge throttle: a call inside the window is remembered and fires
 *  once the window elapses, so the LAST position is always eventually sent —
 *  never silently dropped, only ever delayed by at most `intervalMs`. */
function throttle(fn: (anchor: number, head: number) => void, intervalMs: number): Throttled {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { anchor: number; head: number } | null = null;

  return {
    call(anchor, head) {
      const now = Date.now();
      const elapsed = now - last;
      if (elapsed >= intervalMs) {
        last = now;
        fn(anchor, head);
        return;
      }
      pending = { anchor, head };
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          if (pending !== null) {
            fn(pending.anchor, pending.head);
            pending = null;
          }
        }, intervalMs - elapsed);
      }
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
