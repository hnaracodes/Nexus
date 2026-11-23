import { StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range, Text } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, PluginValue, ViewUpdate } from '@codemirror/view';

/**
 * Phase 21 — the agent's in-progress edit, drawn as a "ghost" proposal that
 * types itself out in the editor.
 *
 * The ghost is a DECORATION ONLY. It never enters `state.doc`, so it cannot be
 * saved, cannot reach the CRDT, and cannot be copied out as document text
 * (`user-select: none`): unapproved code must not enter the buffer until the
 * room's gate lets the tool run, and then it arrives the ordinary way (disk ->
 * watcher -> `reconcileExternal`). Everything the editor shows for a ghost is
 * recomputed from `(ghosts, doc)`, never patched, so a human typing while the
 * agent streams can only ever make the ghost re-locate or go "unplaced" —
 * never land in a wrong place.
 *
 * This module deliberately imports nothing from the app (store, derive, wire):
 * `EditorGhost` is the editor's own input shape, and `derive/ghosts.ts` maps
 * the room's state onto it.
 *
 * Block widgets cannot come from a ViewPlugin in CodeMirror, so the state
 * lives in a StateField. The typing animation is a ViewPlugin that only
 * schedules frames while some hunk is still catching up, and dispatches a
 * `step` effect per frame; `stepGhostAnimation` is the same step without the
 * scheduler, which is what tests drive.
 */

export type EditorGhostPhase = 'typing' | 'waiting' | 'applying' | 'landed' | 'denied';

export interface EditorGhost {
  id: string;
  agentName: string;
  /** 0-360. The caret and name label use `hsl(hue 55% 45%)`, exactly like a remote human's caret. */
  hue: number;
  phase: EditorGhostPhase;
  mode: 'replace' | 'write';
  hunks: { old: string; new: string; oldDone: boolean }[];
  replaceAll: boolean;
  /** Scroll the ghost into view as it grows. Only the ghost being followed sets this. */
  follow: boolean;
}

/** `hsl(h s l)` is what `cmCollab.ts`'s remote caret uses; a ghost reads as a sibling of it. */
function agentColor(hue: number): string {
  return `hsl(${hue} 55% 45%)`;
}

/**
 * One animation frame's worth of typing: the gap closes by a sixth (at least
 * one character), so it is smooth when close and catches up fast when behind.
 */
export function typingStep(shown: number, target: number): number {
  if (target <= shown) return target;
  return Math.min(target, shown + Math.max(1, Math.ceil((target - shown) / 6)));
}

/**
 * Where an `old` string sits in the document: its first exact occurrence.
 * `null` when it matches nowhere, or is empty (nothing to anchor on).
 * `ambiguous` when a second occurrence exists — the tool will refuse such an
 * edit without `replace_all`, so the ghost must say so rather than pretend.
 *
 * While the agent is still typing `old` (`oldDone` false), `old` holds only
 * the prefix received so far, and the prefix is matched exactly like a whole
 * string; the flag is part of the contract so callers state which they mean.
 */
export function locateHunk(
  doc: string,
  old: string,
  oldDone: boolean,
): { from: number; to: number; ambiguous: boolean } | null {
  void oldDone;
  if (old.length === 0) return null;
  const from = doc.indexOf(old);
  if (from < 0) return null;
  return { from, to: from + old.length, ambiguous: doc.indexOf(old, from + 1) >= 0 };
}

// ---------------------------------------------------------------------------
// Layout: where each ghost goes in the CURRENT document
// ---------------------------------------------------------------------------

interface BlockSpec {
  /** Index into `ghost.hunks` whose `new` text this block shows. */
  hunk: number;
  pos: number;
  side: -1 | 1;
  ambiguous: boolean;
}

interface GhostLayout {
  /** Located `old` ranges: struck through. */
  oldMarks: { from: number; to: number }[];
  /** After landing, the freshly arrived text found in the doc: highlighted. */
  landedMarks: { from: number; to: number }[];
  blocks: BlockSpec[];
  /** A chip-only (or placeholder) widget at the top of the doc. */
  topChip: 'unplaced' | 'pending' | 'landed' | null;
  /** Write mode: dim every line of the doc the file is about to be replaced by. */
  dim: boolean;
  /** Write mode, landed: flash every line. */
  flash: boolean;
}

function layoutGhost(doc: Text, docText: string, ghost: EditorGhost): GhostLayout {
  const layout: GhostLayout = {
    oldMarks: [],
    landedMarks: [],
    blocks: [],
    topChip: null,
    dim: false,
    flash: false,
  };

  if (ghost.mode === 'write') {
    const target = ghost.hunks[0]?.new ?? '';
    // Landed and the doc already holds the file the agent wrote: nothing is
    // proposed any more, just a brief flash over the real text.
    if (ghost.phase === 'landed' && target.length > 0 && docText === target) {
      layout.flash = true;
      return layout;
    }
    layout.dim = ghost.phase !== 'denied';
    layout.blocks.push({ hunk: 0, pos: 0, side: -1, ambiguous: false });
    return layout;
  }

  let unplaced = false;
  ghost.hunks.forEach((hunk, index) => {
    // The agent has not typed this hunk's `old` yet: nothing to anchor on,
    // and nothing is wrong either — do not cry "not found" for the first
    // hundred milliseconds of every edit.
    if (hunk.old.length === 0 && !hunk.oldDone) return;
    const found = locateHunk(docText, hunk.old, hunk.oldDone);
    if (found !== null) {
      layout.oldMarks.push({ from: found.from, to: found.to });
      // Below the last line the old range touches (a range ending in "\n"
      // ends at the next line's start, but occupies the previous line).
      // Anchored BEFORE the next line (side -1), not after this one: a block
      // widget after a line's end shares that line's gutter cell, so the line
      // number slid down beside the ghost and the line itself had none (seen
      // in a real browser). Only when the old text runs to the end of the
      // file is there no next line to sit before.
      const lastLine = doc.lineAt(Math.max(found.from, found.to - 1));
      const below = lastLine.number < doc.lines ? doc.line(lastLine.number + 1) : null;
      layout.blocks.push({
        hunk: index,
        pos: below === null ? lastLine.to : below.from,
        side: below === null ? 1 : -1,
        ambiguous: found.ambiguous && hunk.oldDone && !ghost.replaceAll,
      });
      return;
    }
    if (ghost.phase === 'landed') {
      // The edit applied and the doc has caught up, so `old` is gone by
      // design. Highlight the text that arrived instead of crying "not found".
      const landed = locateHunk(docText, hunk.new, true);
      if (landed !== null) layout.landedMarks.push({ from: landed.from, to: landed.to });
      return;
    }
    unplaced = true;
  });

  if (unplaced) layout.topChip = 'unplaced';
  else if (layout.blocks.length === 0 && layout.landedMarks.length === 0) {
    layout.topChip = ghost.phase === 'landed' ? 'landed' : 'pending';
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

function phaseLabel(ghost: { agentName: string; phase: EditorGhostPhase }): string {
  switch (ghost.phase) {
    case 'typing':
      return `${ghost.agentName} is typing…`;
    case 'waiting':
      return 'Waiting for approval';
    case 'applying':
      return 'Applying…';
    case 'landed':
      return 'Landed';
    case 'denied':
      return 'Denied';
  }
}

interface BlockProps {
  ghostId: string;
  agentName: string;
  hue: number;
  phase: EditorGhostPhase;
  chip: string;
  /** `null`: a chip-only widget (nothing typed to show). */
  text: string | null;
  caret: boolean;
}

/**
 * The block widget: phase chip plus the proposed text, in the editor's own
 * font, with the agent's caret and name at the end of what has been typed so
 * far. The text lives in `.cm-agent-ghost-new` alone so that its `textContent`
 * is exactly the typed text (the chip and the name label are siblings).
 */
class GhostBlockWidget extends WidgetType {
  private readonly lineCount: number;

  constructor(private readonly props: BlockProps) {
    super();
    this.lineCount = props.text === null ? 0 : props.text.split('\n').length;
  }

  override eq(other: WidgetType): boolean {
    if (!(other instanceof GhostBlockWidget)) return false;
    const a = this.props;
    const b = other.props;
    return (
      a.ghostId === b.ghostId &&
      a.agentName === b.agentName &&
      a.hue === b.hue &&
      a.phase === b.phase &&
      a.chip === b.chip &&
      a.text === b.text &&
      a.caret === b.caret
    );
  }

  override get estimatedHeight(): number {
    return this.lineCount * 20 + 24;
  }

  toDOM(): HTMLElement {
    const { ghostId, hue, phase, chip, text, caret, agentName } = this.props;
    const root = document.createElement('div');
    root.className = `cm-agent-ghost cm-agent-ghost-block cm-agent-ghost-${phase}`;
    root.dataset['ghostId'] = ghostId;
    root.dataset['phase'] = phase;
    root.dataset['hue'] = String(hue);
    root.setAttribute('contenteditable', 'false');
    root.setAttribute('style', `border-left: 2px solid ${agentColor(hue)}`);

    const chipEl = document.createElement('span');
    chipEl.className = 'cm-agent-ghost-chip';
    chipEl.textContent = chip;
    root.appendChild(chipEl);

    if (text !== null) {
      const pre = document.createElement('pre');
      pre.className = 'cm-agent-ghost-text';
      const typed = document.createElement('span');
      typed.className = 'cm-agent-ghost-new';
      typed.textContent = text;
      pre.appendChild(typed);
      if (caret) pre.appendChild(caretElement(agentName, hue));
      root.appendChild(pre);
    }
    return root;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Same shape and label treatment as `cmCollab.ts`'s `RemoteCaretWidget`. */
function caretElement(agentName: string, hue: number): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'cm-agent-ghost-caret';
  caret.dataset['hue'] = String(hue);
  caret.setAttribute('style', `border-left: 2px solid ${agentColor(hue)}`);
  const label = document.createElement('span');
  label.className = 'cm-agent-ghost-caret-label';
  label.setAttribute('style', `background-color: ${agentColor(hue)}`);
  label.textContent = agentName;
  caret.appendChild(label);
  return caret;
}

/** A small inline tag ("Landed") at the end of freshly arrived text. */
class TagWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly hue: number,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof TagWidget && other.text === this.text && other.hue === this.hue;
  }

  toDOM(): HTMLElement {
    const tag = document.createElement('span');
    tag.className = 'cm-agent-ghost-tag';
    tag.setAttribute('style', `background-color: ${agentColor(this.hue)}`);
    tag.textContent = this.text;
    return tag;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Never cut a surrogate pair in half: a lone half renders as a replacement glyph. */
function visiblePrefix(full: string, shown: number): string {
  if (shown >= full.length) return full;
  if (shown <= 0) return '';
  const last = full.charCodeAt(shown - 1);
  return last >= 0xd800 && last <= 0xdbff ? full.slice(0, shown - 1) : full.slice(0, shown);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const setGhosts = StateEffect.define<EditorGhost[]>();
/** One animation frame. Private: callers go through `stepGhostAnimation`. */
const stepFrame = StateEffect.define<null>();

interface GhostState {
  ghosts: readonly EditorGhost[];
  /** Characters of each hunk's `new` text shown so far, keyed `"<ghostId>:<hunk>"`. */
  shown: ReadonlyMap<string, number>;
  layouts: ReadonlyMap<string, GhostLayout>;
  /** Write-mode line decorations. Rebuilt only when the doc or ghosts change (one per line). */
  lines: DecorationSet;
  /** Marks and widgets. Rebuilt every animation frame (a handful of ranges). */
  deco: DecorationSet;
  /** Some hunk's shown length is still short of its received length. */
  behind: boolean;
  /** Ghost ids whose shown text grew in the last frame. */
  grew: ReadonlySet<string>;
}

const EMPTY_STATE: GhostState = {
  ghosts: [],
  shown: new Map(),
  layouts: new Map(),
  lines: Decoration.none,
  deco: Decoration.none,
  behind: false,
  grew: new Set(),
};

const hunkKey = (ghostId: string, hunk: number): string => `${ghostId}:${hunk}`;

function sameGhosts(a: readonly EditorGhost[], b: readonly EditorGhost[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.agentName !== y.agentName ||
      x.hue !== y.hue ||
      x.phase !== y.phase ||
      x.mode !== y.mode ||
      x.replaceAll !== y.replaceAll ||
      x.follow !== y.follow ||
      x.hunks.length !== y.hunks.length
    ) {
      return false;
    }
    for (let h = 0; h < x.hunks.length; h++) {
      const p = x.hunks[h]!;
      const q = y.hunks[h]!;
      if (p.old !== q.old || p.new !== q.new || p.oldDone !== q.oldDone) return false;
    }
  }
  return true;
}

function isBehind(ghosts: readonly EditorGhost[], shown: ReadonlyMap<string, number>): boolean {
  for (const ghost of ghosts) {
    for (let i = 0; i < ghost.hunks.length; i++) {
      if ((shown.get(hunkKey(ghost.id, i)) ?? 0) < ghost.hunks[i]!.new.length) return true;
    }
  }
  return false;
}

function computeLayouts(
  doc: Text,
  ghosts: readonly EditorGhost[],
): { layouts: Map<string, GhostLayout>; lines: DecorationSet } {
  const layouts = new Map<string, GhostLayout>();
  const lines: Range<Decoration>[] = [];
  if (ghosts.length === 0) return { layouts, lines: Decoration.none };
  const docText = doc.toString();
  for (const ghost of ghosts) {
    const layout = layoutGhost(doc, docText, ghost);
    layouts.set(ghost.id, layout);
    const cls = layout.dim ? 'cm-agent-ghost-dim' : layout.flash ? 'cm-agent-ghost-landed-line' : null;
    if (cls !== null) {
      const deco = Decoration.line({ class: cls });
      for (let n = 1; n <= doc.lines; n++) lines.push(deco.range(doc.line(n).from));
    }
  }
  return { layouts, lines: Decoration.set(lines, true) };
}

function buildDeco(
  ghosts: readonly EditorGhost[],
  layouts: ReadonlyMap<string, GhostLayout>,
  shown: ReadonlyMap<string, number>,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const ghost of ghosts) {
    const layout = layouts.get(ghost.id);
    if (layout === undefined) continue;
    const denied = ghost.phase === 'denied';
    const activeHunk = ghost.mode === 'write' ? 0 : ghost.hunks.length - 1;
    const typing = ghost.phase === 'typing';

    for (const mark of layout.oldMarks) {
      ranges.push(
        Decoration.mark({
          class: denied ? 'cm-agent-ghost-old cm-agent-ghost-old-denied' : 'cm-agent-ghost-old',
        }).range(mark.from, mark.to),
      );
    }
    for (const mark of layout.landedMarks) {
      ranges.push(Decoration.mark({ class: 'cm-agent-ghost-landed-mark' }).range(mark.from, mark.to));
      ranges.push(Decoration.widget({ widget: new TagWidget('Landed', ghost.hue), side: 1 }).range(mark.to));
    }
    for (const block of layout.blocks) {
      const full = ghost.hunks[block.hunk]?.new ?? '';
      const text = visiblePrefix(full, shown.get(hunkKey(ghost.id, block.hunk)) ?? 0);
      const note = block.ambiguous ? ' (text appears more than once)' : '';
      ranges.push(
        Decoration.widget({
          widget: new GhostBlockWidget({
            ghostId: ghost.id,
            agentName: ghost.agentName,
            hue: ghost.hue,
            phase: ghost.phase,
            chip: phaseLabel(ghost) + note,
            text,
            caret: typing && block.hunk === activeHunk,
          }),
          block: true,
          side: block.side,
        }).range(block.pos),
      );
    }
    if (layout.topChip !== null) {
      const unplaced = layout.topChip === 'unplaced';
      ranges.push(
        Decoration.widget({
          widget: new GhostBlockWidget({
            ghostId: ghost.id,
            agentName: ghost.agentName,
            hue: ghost.hue,
            phase: ghost.phase,
            chip: unplaced ? `${ghost.agentName} is editing text not found here` : phaseLabel(ghost),
            // 'pending' is the placeholder before the agent has typed anything
            // placeable: the chip and the caret, no text yet.
            text: layout.topChip === 'pending' && typing ? '' : null,
            caret: layout.topChip === 'pending' && typing,
          }),
          block: true,
          side: -1,
        }).range(0),
      );
    }
  }
  return Decoration.set(ranges, true);
}

const ghostField = StateField.define<GhostState>({
  create: () => EMPTY_STATE,

  update(value, tr) {
    let ghosts = value.ghosts;
    let shown = value.shown;
    let ghostsChanged = false;

    for (const effect of tr.effects) {
      if (!effect.is(setGhosts)) continue;
      if (sameGhosts(ghosts, effect.value)) continue;
      ghosts = effect.value;
      ghostsChanged = true;
      // Keep the animation position of every hunk that is still there; new
      // ones start from nothing, and one whose text shrank snaps back to it.
      const next = new Map<string, number>();
      for (const ghost of ghosts) {
        ghost.hunks.forEach((hunk, i) => {
          const key = hunkKey(ghost.id, i);
          next.set(key, Math.min(value.shown.get(key) ?? 0, hunk.new.length));
        });
      }
      shown = next;
    }

    let layouts = value.layouts;
    let lines = value.lines;
    if (ghostsChanged || (tr.docChanged && ghosts.length > 0)) {
      ({ layouts, lines } = computeLayouts(tr.newDoc, ghosts));
    }

    let grew: ReadonlySet<string> = EMPTY_STATE.grew;
    let stepped = false;
    if (tr.effects.some((effect) => effect.is(stepFrame))) {
      const next = new Map(shown);
      const grown = new Set<string>();
      for (const ghost of ghosts) {
        ghost.hunks.forEach((hunk, i) => {
          const key = hunkKey(ghost.id, i);
          const before = next.get(key) ?? 0;
          const after = typingStep(before, hunk.new.length);
          if (after !== before) {
            next.set(key, after);
            if (after > before) grown.add(ghost.id);
            stepped = true;
          }
        });
      }
      if (stepped) {
        shown = next;
        grew = grown;
      }
    }

    if (!ghostsChanged && !stepped && layouts === value.layouts) return value;

    return {
      ghosts,
      shown,
      layouts,
      lines,
      deco: buildDeco(ghosts, layouts, shown),
      behind: isBehind(ghosts, shown),
      grew,
    };
  },

  provide: (field) => [
    EditorView.decorations.from(field, (state) => state.lines),
    EditorView.decorations.from(field, (state) => state.deco),
  ],
});

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

/** Schedules one callback for the next frame; returns a cancel function. */
export type FrameScheduler = (callback: () => void) => () => void;

const browserScheduler: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 16);
  return () => clearTimeout(id);
};

/**
 * Whether the view's ghosts still have typing to catch up on. The plugin
 * schedules frames only while this is true: there is no idle animation loop.
 */
export function ghostsNeedFrames(view: EditorView): boolean {
  return view.state.field(ghostField, false)?.behind ?? false;
}

/**
 * Advances every ghost one animation frame and reports whether another is
 * needed. This is the plugin's frame body without the scheduler, so tests (and
 * anything else that wants to settle the animation) can drive it directly.
 * Follow ghosts that grew are kept in view.
 */
export function stepGhostAnimation(view: EditorView): boolean {
  if (!ghostsNeedFrames(view)) return false;
  view.dispatch({ effects: stepFrame.of(null) });
  const state = view.state.field(ghostField);
  const scrolls: StateEffect<unknown>[] = [];
  for (const ghost of state.ghosts) {
    if (!ghost.follow || !state.grew.has(ghost.id)) continue;
    if (widgetElements(view, ghost.id).length > 0) {
      keepWidgetEndVisible(view, ghost.id);
      continue;
    }
    // Not drawn: it is outside CodeMirror's rendered viewport, so there is no
    // box to measure. Scroll its anchor position into view; the next frame
    // finds the widget and fits its end.
    const layout = state.layouts.get(ghost.id);
    const anchor = layout?.blocks[layout.blocks.length - 1];
    scrolls.push(EditorView.scrollIntoView(anchor?.pos ?? 0, { y: 'nearest' }));
  }
  if (scrolls.length > 0) view.dispatch({ effects: scrolls });
  return view.state.field(ghostField).behind;
}

function widgetElements(view: EditorView, ghostId: string): HTMLElement[] {
  return [...view.dom.querySelectorAll<HTMLElement>('.cm-agent-ghost-block')].filter(
    (el) => el.dataset['ghostId'] === ghostId,
  );
}

/**
 * Scrolls so the END of the ghost's text (where the agent is typing) is
 * visible. A position-based scroll cannot do this: the widget hangs below its
 * anchor line and is as tall as what has been typed, and for a widget taller
 * than the editor the end and the anchor line cannot both be in view; the end
 * is the one that matters while following.
 */
function keepWidgetEndVisible(view: EditorView, ghostId: string): void {
  view.requestMeasure<number>({
    key: `agent-ghost-follow:${ghostId}`,
    read(v) {
      const last = widgetElements(v, ghostId).pop();
      if (last === undefined) return 0;
      const edge = 8;
      const bottom = last.getBoundingClientRect().bottom;
      const scroller = v.scrollDOM.getBoundingClientRect();
      return bottom > scroller.bottom - edge || bottom < scroller.top ? bottom - (scroller.bottom - edge) : 0;
    },
    write(delta, v) {
      if (delta !== 0) v.scrollDOM.scrollTop += delta;
    },
  });
}

class AnimationPlugin implements PluginValue {
  private cancel: (() => void) | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly schedule: FrameScheduler,
  ) {
    this.ensure();
  }

  update(_update: ViewUpdate): void {
    this.ensure();
  }

  private ensure(): void {
    if (this.cancel !== null || !ghostsNeedFrames(this.view)) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      // The dispatch inside re-enters `update`, which schedules the next frame
      // only if one is still needed.
      stepGhostAnimation(this.view);
    });
  }

  destroy(): void {
    this.cancel?.();
    this.cancel = null;
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * Styled with the room's CSS variables (`index.css` keeps them as raw RGB
 * channels so an alpha can be appended): no raw hex here, and the agent's own
 * colour comes from its hue exactly as a remote caret's does.
 */
const ghostTheme = EditorView.baseTheme({
  '.cm-agent-ghost-old': {
    textDecoration: 'line-through',
    textDecorationColor: 'rgb(var(--danger))',
    backgroundColor: 'rgb(var(--danger) / 0.16)',
  },
  '.cm-agent-ghost-old-denied': { animation: 'cm-agent-ghost-unstrike 2s ease-out forwards' },
  '.cm-agent-ghost-dim': { opacity: '0.45' },
  '.cm-agent-ghost-block': {
    position: 'relative',
    boxSizing: 'border-box',
    // Padding, never margin: CodeMirror measures a block widget's own box, so a
    // margin is invisible to it and the line-number gutter drifts out of step.
    padding: '2px 0',
    backgroundColor: 'rgb(var(--success) / 0.12)',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    cursor: 'default',
  },
  '.cm-agent-ghost-chip': {
    position: 'absolute',
    top: '2px',
    right: '8px',
    padding: '0 6px',
    fontFamily: 'var(--font-sans)',
    fontSize: '10px',
    lineHeight: '16px',
    color: 'rgb(var(--fg-muted))',
    backgroundColor: 'rgb(var(--surface))',
    border: '1px solid rgb(var(--border))',
    borderRadius: '8px',
    whiteSpace: 'nowrap',
  },
  '.cm-agent-ghost-text': {
    margin: '0',
    padding: '0 90px 0 8px',
    font: 'inherit',
    whiteSpace: 'pre',
    overflowX: 'auto',
    minHeight: '20px',
  },
  '.cm-agent-ghost-caret': {
    display: 'inline-block',
    height: '1.2em',
    verticalAlign: 'text-bottom',
    marginLeft: '-1px',
    animation: 'cm-agent-ghost-blink 1s step-end infinite',
  },
  '.cm-agent-ghost-caret-label': {
    display: 'inline-block',
    marginLeft: '2px',
    padding: '0 4px',
    fontFamily: 'var(--font-sans)',
    fontSize: '10px',
    lineHeight: '14px',
    verticalAlign: 'top',
    color: 'rgb(var(--on-accent))',
    borderRadius: '2px',
  },
  '.cm-agent-ghost-tag': {
    display: 'inline-block',
    marginLeft: '6px',
    padding: '0 4px',
    fontFamily: 'var(--font-sans)',
    fontSize: '10px',
    lineHeight: '14px',
    color: 'rgb(var(--on-accent))',
    borderRadius: '2px',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-agent-ghost-landed': { animation: 'cm-agent-ghost-land 1.5s ease-out' },
  '.cm-agent-ghost-landed-mark, .cm-agent-ghost-landed-line': {
    animation: 'cm-agent-ghost-land 1.5s ease-out forwards',
  },
  '.cm-agent-ghost-denied': {
    animation: 'cm-agent-ghost-fade 2s ease-out forwards',
    pointerEvents: 'none',
  },
  '@keyframes cm-agent-ghost-blink': { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0' } },
  '@keyframes cm-agent-ghost-fade': { from: { opacity: '1' }, to: { opacity: '0' } },
  '@keyframes cm-agent-ghost-land': {
    from: { backgroundColor: 'rgb(var(--success) / 0.4)' },
    to: { backgroundColor: 'rgb(var(--success) / 0)' },
  },
  '@keyframes cm-agent-ghost-unstrike': {
    from: { textDecorationColor: 'rgb(var(--danger))', backgroundColor: 'rgb(var(--danger) / 0.16)' },
    to: { textDecorationColor: 'rgb(var(--danger) / 0)', backgroundColor: 'rgb(var(--danger) / 0)' },
  },
});

export interface AgentGhostOptions {
  /** Injected frame scheduler; defaults to `requestAnimationFrame`. */
  schedule?: FrameScheduler;
}

/**
 * Always installed by `CodeEditor`; with no ghosts it holds an empty state, and
 * its only cost per transaction is one field lookup. Drive it with
 * `view.dispatch({ effects: setGhosts.of(ghosts) })`.
 */
export function agentGhostExtension(options: AgentGhostOptions = {}): Extension {
  const schedule = options.schedule ?? browserScheduler;
  return [
    ghostField,
    ViewPlugin.define((view) => new AnimationPlugin(view, schedule)),
    ghostTheme,
  ];
}
