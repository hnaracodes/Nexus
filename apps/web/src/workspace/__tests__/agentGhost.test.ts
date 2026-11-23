import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentGhostExtension,
  ghostsNeedFrames,
  locateHunk,
  setGhosts,
  stepGhostAnimation,
  typingStep,
} from '../agentGhost.js';
import type { EditorGhost, FrameScheduler } from '../agentGhost.js';

/**
 * Phase 21: the agent's in-progress edit as a decoration-only "ghost". jsdom
 * has no layout, so none of this proves pixel placement; it proves what the
 * DOM contains, that the document never changes, and that the animation steps
 * exactly where the step function says (Review Focus 1, 4 and 5).
 */

function ghost(over: Partial<EditorGhost> = {}): EditorGhost {
  return {
    id: 'g1',
    agentName: 'Claude',
    hue: 210,
    phase: 'typing',
    mode: 'replace',
    hunks: [{ old: 'return 1;', new: 'return 2;', oldDone: true }],
    replaceAll: false,
    follow: false,
    ...over,
  };
}

/** A scheduler the test drives by hand: no real requestAnimationFrame involved. */
function manualScheduler() {
  const queue: Array<() => void> = [];
  let scheduled = 0;
  const schedule: FrameScheduler = (callback) => {
    scheduled++;
    queue.push(callback);
    return () => {
      const at = queue.indexOf(callback);
      if (at >= 0) queue.splice(at, 1);
    };
  };
  return {
    schedule,
    get scheduled() {
      return scheduled;
    },
    get pending() {
      return queue.length;
    },
    /** Runs the next queued frame callback. */
    runNext() {
      queue.shift()?.();
    },
  };
}

const views: EditorView[] = [];

function makeView(doc: string, schedule: FrameScheduler = manualScheduler().schedule): EditorView {
  const view = new EditorView({
    parent: document.createElement('div'),
    state: EditorState.create({ doc, extensions: [agentGhostExtension({ schedule })] }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length > 0) views.pop()?.destroy();
});

/** Steps until the animation is idle; returns how many frames it took. */
function settle(view: EditorView): number {
  let frames = 0;
  while (stepGhostAnimation(view)) {
    frames++;
    if (frames > 10_000) throw new Error('ghost animation never settled');
  }
  return frames + 1;
}

const setAll = (view: EditorView, ghosts: EditorGhost[]): void => view.dispatch({ effects: setGhosts.of(ghosts) });
const blocks = (view: EditorView): HTMLElement[] => [...view.dom.querySelectorAll<HTMLElement>('.cm-agent-ghost-block')];
const typed = (el: Element): string => el.querySelector('.cm-agent-ghost-new')?.textContent ?? '';
const chip = (el: Element): string => el.querySelector('.cm-agent-ghost-chip')?.textContent ?? '';
const marks = (view: EditorView): HTMLElement[] => [...view.dom.querySelectorAll<HTMLElement>('.cm-agent-ghost-old')];
const lineIndexOf = (view: EditorView, el: Element): number =>
  [...view.dom.querySelectorAll('.cm-line')].indexOf(el.closest('.cm-line') as Element);

const DOC = ['function add(a, b) {', '  return 1;', '}', ''].join('\n');

describe('typingStep', () => {
  it('closes a sixth of the gap per frame, at least one character', () => {
    expect(typingStep(0, 100)).toBe(17);
    expect(typingStep(17, 100)).toBe(17 + Math.ceil(83 / 6));
    expect(typingStep(0, 3)).toBe(1);
  });

  it('never overshoots and does not move once caught up', () => {
    expect(typingStep(99, 100)).toBe(100);
    expect(typingStep(100, 100)).toBe(100);
    // The received text can shrink (the logged input replaces the live text).
    expect(typingStep(100, 40)).toBe(40);
  });

  it('always reaches the target', () => {
    let shown = 0;
    for (let i = 0; i < 1000 && shown < 5000; i++) shown = typingStep(shown, 5000);
    expect(shown).toBe(5000);
  });
});

describe('locateHunk', () => {
  const doc = 'alpha beta\ngamma delta\n';

  it('finds the exact text', () => {
    expect(locateHunk(doc, 'gamma delta', true)).toEqual({ from: 11, to: 22, ambiguous: false });
  });

  it('matches the prefix typed so far while old is still streaming', () => {
    expect(locateHunk(doc, 'gamma d', false)).toEqual({ from: 11, to: 18, ambiguous: false });
    expect(locateHunk(doc, 'gamma x', false)).toBeNull();
  });

  it('reports a second occurrence as ambiguous and places at the first', () => {
    expect(locateHunk('x = 1;\nx = 1;\n', 'x = 1;', true)).toEqual({ from: 0, to: 6, ambiguous: true });
  });

  it('is null when the text matches nowhere', () => {
    expect(locateHunk(doc, 'omega', true)).toBeNull();
  });

  it('is null for an empty old (nothing to anchor on), streaming or not', () => {
    expect(locateHunk(doc, '', true)).toBeNull();
    expect(locateHunk(doc, '', false)).toBeNull();
  });
});

describe('agentGhostExtension — replace mode', () => {
  it('marks the old range, shows the new text in a widget, and never touches the doc', () => {
    const view = makeView(DOC);
    setAll(view, [ghost()]);
    settle(view);

    const marked = marks(view);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toBe('return 1;');

    const [widget] = blocks(view);
    expect(widget).toBeDefined();
    expect(typed(widget!)).toBe('return 2;');
    // The widget sits directly after the line the old text is on.
    expect(widget!.previousElementSibling?.classList.contains('cm-line')).toBe(true);
    expect(widget!.previousElementSibling).toBe(marked[0]!.closest('.cm-line'));

    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('types the text in over several frames, a prefix each time', () => {
    const full = 'x'.repeat(100);
    const view = makeView(DOC);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: full, oldDone: true }] })]);

    // Nothing has been typed before the first frame.
    expect(typed(blocks(view)[0]!)).toBe('');
    expect(stepGhostAnimation(view)).toBe(true);
    expect(typed(blocks(view)[0]!)).toBe(full.slice(0, typingStep(0, 100)));
    expect(typed(blocks(view)[0]!).length).toBe(17);

    expect(settle(view)).toBeGreaterThan(1);
    expect(typed(blocks(view)[0]!)).toBe(full);
    expect(ghostsNeedFrames(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('animates text that arrives all at once (a late joiner) instead of snapping it in', () => {
    const full = 'line of code\n'.repeat(60);
    const view = makeView(DOC);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: full, oldDone: true }] })]);

    stepGhostAnimation(view);
    const afterOne = typed(blocks(view)[0]!);
    expect(afterOne.length).toBeGreaterThan(0);
    expect(afterOne.length).toBeLessThan(full.length);
    expect(full.startsWith(afterOne)).toBe(true);
    settle(view);
    expect(typed(blocks(view)[0]!)).toBe(full);
  });

  it('keeps what is already typed when more text arrives', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'return ', oldDone: true }] })]);
    settle(view);
    expect(typed(blocks(view)[0]!)).toBe('return ');

    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'return 2 + 40;', oldDone: true }] })]);
    // The first frame starts from the 7 characters already shown, not from 0.
    expect(typed(blocks(view)[0]!)).toBe('return ');
    stepGhostAnimation(view);
    expect(typed(blocks(view)[0]!).length).toBeGreaterThan(7);
    settle(view);
    expect(typed(blocks(view)[0]!)).toBe('return 2 + 40;');
  });

  it('follows the prefix of old while it is still streaming', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ hunks: [{ old: 'retu', new: '', oldDone: false }] })]);
    expect(marks(view).map((m) => m.textContent)).toEqual(['retu']);
    expect(view.dom.textContent).not.toContain('not found');

    setAll(view, [ghost({ hunks: [{ old: 'return 1', new: '', oldDone: false }] })]);
    expect(marks(view).map((m) => m.textContent)).toEqual(['return 1']);
    // A prefix that matches nothing yet is unplaced, not a wrong position.
    setAll(view, [ghost({ hunks: [{ old: 'return 9', new: '', oldDone: false }] })]);
    expect(marks(view)).toHaveLength(0);
    expect(chip(blocks(view)[0]!)).toBe('Claude is editing text not found here');
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('does not cry "not found" before the agent has typed any of old', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ hunks: [] })]);
    const [placeholder] = blocks(view);
    expect(chip(placeholder!)).toBe('Claude is typing…');
    expect(placeholder!.querySelector('.cm-agent-ghost-caret')).not.toBeNull();
    expect(view.dom.textContent).not.toContain('not found');

    setAll(view, [ghost({ hunks: [{ old: '', new: '', oldDone: false }] })]);
    expect(chip(blocks(view)[0]!)).toBe('Claude is typing…');
  });

  it('relocates after a human edit', () => {
    const view = makeView(DOC);
    setAll(view, [ghost()]);
    settle(view);
    expect(lineIndexOf(view, marks(view)[0]!)).toBe(1);

    // A human adds two lines above while the agent is still proposing.
    view.dispatch({ changes: { from: 0, insert: '// header\n// more\n' } });
    expect(view.state.doc.toString()).toBe(`// header\n// more\n${DOC}`);

    const marked = marks(view);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.textContent).toBe('return 1;');
    expect(lineIndexOf(view, marked[0]!)).toBe(3);
    // ...and the widget moved with it, still straight after that line.
    const [widget] = blocks(view);
    expect(typed(widget!)).toBe('return 2;');
    expect(widget!.previousElementSibling).toBe(marked[0]!.closest('.cm-line'));
  });

  it('stays correct when a human types inside the line the old text is on', () => {
    const view = makeView('const a = 1;\nreturn 1; // keep\nconst b = 2;\n');
    setAll(view, [ghost()]);
    settle(view);
    view.dispatch({ changes: { from: 0, insert: '/* x */ ' } });
    expect(marks(view)[0]!.textContent).toBe('return 1;');
    expect(lineIndexOf(view, marks(view)[0]!)).toBe(1);
  });

  it('is unplaced when the old text is gone', () => {
    const view = makeView(DOC);
    setAll(view, [ghost()]);
    settle(view);
    expect(marks(view)).toHaveLength(1);

    const from = DOC.indexOf('return 1;');
    view.dispatch({ changes: { from, to: from + 'return 1;'.length, insert: 'return 7;' } });

    expect(marks(view)).toHaveLength(0);
    const found = blocks(view);
    expect(found).toHaveLength(1);
    expect(chip(found[0]!)).toBe('Claude is editing text not found here');
    // The unplaced chip is only a chip: the proposal text is not drawn at a wrong position.
    expect(found[0]!.querySelector('.cm-agent-ghost-new')).toBeNull();
    // It sits at the top of the document.
    expect(view.dom.querySelector('.cm-content')!.firstElementChild).toBe(found[0]);
    expect(view.state.doc.toString()).toBe(DOC.replace('return 1;', 'return 7;'));
  });

  it('places at the first occurrence and says so when the old text appears twice', () => {
    const doc = 'x = 1;\nx = 1;\n';
    const view = makeView(doc);
    setAll(view, [ghost({ hunks: [{ old: 'x = 1;', new: 'x = 2;', oldDone: true }] })]);
    settle(view);

    const marked = marks(view);
    expect(marked).toHaveLength(1);
    expect(lineIndexOf(view, marked[0]!)).toBe(0);
    expect(chip(blocks(view)[0]!)).toBe('Claude is typing… (text appears more than once)');
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('does not flag duplicates when the agent asked to replace all', () => {
    const view = makeView('x = 1;\nx = 1;\n');
    setAll(view, [ghost({ replaceAll: true, hunks: [{ old: 'x = 1;', new: 'x = 2;', oldDone: true }] })]);
    expect(chip(blocks(view)[0]!)).not.toContain('more than once');
  });

  it('does not flag a still-streaming prefix as ambiguous', () => {
    const view = makeView('x = 1;\nx = 1;\n');
    setAll(view, [ghost({ hunks: [{ old: 'x =', new: '', oldDone: false }] })]);
    expect(chip(blocks(view)[0]!)).not.toContain('more than once');
  });

  it('renders every hunk of a multi-edit, each after its own range', () => {
    const doc = 'one\ntwo\nthree\n';
    const view = makeView(doc);
    setAll(view, [
      ghost({
        hunks: [
          { old: 'one', new: '1', oldDone: true },
          { old: 'three', new: '3', oldDone: true },
        ],
      }),
    ]);
    settle(view);
    expect(marks(view).map((m) => m.textContent)).toEqual(['one', 'three']);
    expect(blocks(view).map(typed)).toEqual(['1', '3']);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('shows one unplaced chip when only some hunks can be found', () => {
    const view = makeView('one\ntwo\n');
    setAll(view, [
      ghost({
        hunks: [
          { old: 'one', new: '1', oldDone: true },
          { old: 'missing', new: 'm', oldDone: true },
        ],
      }),
    ]);
    settle(view);
    expect(marks(view).map((m) => m.textContent)).toEqual(['one']);
    const chips = blocks(view).map(chip);
    expect(chips.filter((c) => c.includes('not found here'))).toHaveLength(1);
  });

  it('places the widget after the last line of a multi-line old range', () => {
    const doc = 'a\nb\nc\nd\n';
    const view = makeView(doc);
    setAll(view, [ghost({ hunks: [{ old: 'b\nc\n', new: 'B\nC\n', oldDone: true }] })]);
    settle(view);
    const [widget] = blocks(view);
    expect(typed(widget!)).toBe('B\nC\n');
    // Range ends with a newline, so the last line it occupies is "c", not "d".
    expect(widget!.previousElementSibling?.textContent).toBe('c');
  });

  it('keeps a surrogate pair whole while typing', () => {
    const view = makeView(DOC);
    const full = 'a😀b😀c😀d';
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: full, oldDone: true }] })]);
    for (let guard = 0; guard < 50; guard++) {
      const text = typed(blocks(view)[0]!);
      expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
      if (!stepGhostAnimation(view)) break;
    }
    expect(typed(blocks(view)[0]!)).toBe(full);
  });
});

describe('agentGhostExtension — phases', () => {
  const cases: Array<[EditorGhost['phase'], string]> = [
    ['typing', 'Claude is typing…'],
    ['waiting', 'Waiting for approval'],
    ['applying', 'Applying…'],
    ['landed', 'Landed'],
    ['denied', 'Denied'],
  ];

  it.each(cases)('phase %s shows the chip "%s" while the old text is still in the doc', (phase, label) => {
    const view = makeView(DOC);
    setAll(view, [ghost({ phase })]);
    settle(view);
    const [widget] = blocks(view);
    expect(chip(widget!)).toBe(label);
    expect(widget!.dataset['phase']).toBe(phase);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('shows the agent caret and name only while typing', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ phase: 'typing' })]);
    settle(view);
    const caret = blocks(view)[0]!.querySelector('.cm-agent-ghost-caret');
    expect(caret).not.toBeNull();
    expect(caret!.querySelector('.cm-agent-ghost-caret-label')!.textContent).toBe('Claude');
    // The label is not part of the typed text.
    expect(typed(blocks(view)[0]!)).toBe('return 2;');

    setAll(view, [ghost({ phase: 'waiting' })]);
    expect(blocks(view)[0]!.querySelector('.cm-agent-ghost-caret')).toBeNull();
  });

  it('puts the caret on the last hunk only', () => {
    const view = makeView('one\ntwo\n');
    setAll(view, [
      ghost({
        hunks: [
          { old: 'one', new: '1', oldDone: true },
          { old: 'two', new: '2', oldDone: true },
        ],
      }),
    ]);
    settle(view);
    const [first, second] = blocks(view);
    expect(first!.querySelector('.cm-agent-ghost-caret')).toBeNull();
    expect(second!.querySelector('.cm-agent-ghost-caret')).not.toBeNull();
  });

  it('highlights the text that arrived once the old text is gone after landing (no "not found")', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ phase: 'landed' })]);
    settle(view);
    // The edit applied: the doc now holds the new text and not the old.
    const from = DOC.indexOf('return 1;');
    view.dispatch({ changes: { from, to: from + 9, insert: 'return 2;' } });

    expect(view.dom.textContent).not.toContain('not found');
    expect(marks(view)).toHaveLength(0);
    expect(blocks(view)).toHaveLength(0);
    const landed = view.dom.querySelector('.cm-agent-ghost-landed-mark');
    expect(landed?.textContent).toBe('return 2;');
    expect(view.dom.querySelector('.cm-agent-ghost-tag')?.textContent).toBe('Landed');
  });

  it('falls back to a plain "Landed" chip when neither old nor new can be found', () => {
    const view = makeView('something else entirely\n');
    setAll(view, [ghost({ phase: 'landed' })]);
    expect(blocks(view).map(chip)).toEqual(['Landed']);
  });

  it('fades a denied ghost (class carries the animation) and drops the strike-through promptly', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ phase: 'denied' })]);
    settle(view);
    expect(blocks(view)[0]!.classList.contains('cm-agent-ghost-denied')).toBe(true);
    expect(marks(view)[0]!.classList.contains('cm-agent-ghost-old-denied')).toBe(true);
  });

  it('ships the keyframes the animations name', () => {
    makeView(DOC);
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    for (const name of ['cm-agent-ghost-fade', 'cm-agent-ghost-land', 'cm-agent-ghost-blink']) {
      expect(css).toContain(name);
    }
    // The ghost is not selectable as document text.
    expect(css).toMatch(/\.cm-agent-ghost-block[^{]*\{[^}]*user-select:\s*none/);
  });
});

describe('agentGhostExtension — write mode', () => {
  it('dims the whole doc and shows the new file contents in a block at the top', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ mode: 'write', hunks: [{ old: '', new: 'export const x = 1;\n', oldDone: true }] })]);
    settle(view);

    const lines = [...view.dom.querySelectorAll('.cm-line')];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.classList.contains('cm-agent-ghost-dim'))).toBe(true);
    const [widget] = blocks(view);
    expect(typed(widget!)).toBe('export const x = 1;\n');
    expect(view.dom.querySelector('.cm-content')!.firstElementChild).toBe(widget);
    expect(marks(view)).toHaveLength(0);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('writes into an empty document (a proposed new file) without changing it', () => {
    const view = makeView('');
    setAll(view, [ghost({ mode: 'write', hunks: [{ old: '', new: 'hello\nworld', oldDone: true }] })]);
    settle(view);
    expect(typed(blocks(view)[0]!)).toBe('hello\nworld');
    expect(view.state.doc.toString()).toBe('');
  });

  it('stops dimming once the proposal is denied or has landed', () => {
    const hunks = [{ old: '', new: 'fresh\n', oldDone: true }];
    const view = makeView(DOC);
    setAll(view, [ghost({ mode: 'write', phase: 'denied', hunks })]);
    expect(view.dom.querySelector('.cm-agent-ghost-dim')).toBeNull();

    // Landed and the doc already holds the file: no widget, a brief flash.
    const landedView = makeView('fresh\n');
    setAll(landedView, [ghost({ mode: 'write', phase: 'landed', hunks })]);
    expect(blocks(landedView)).toHaveLength(0);
    expect(landedView.dom.querySelector('.cm-agent-ghost-dim')).toBeNull();
    expect(landedView.dom.querySelector('.cm-agent-ghost-landed-line')).not.toBeNull();
  });
});

describe('agentGhostExtension — several ghosts and teardown', () => {
  it('two ghosts: two widgets, two colours, independent animation', () => {
    const doc = 'alpha\nbeta\ngamma\n';
    const view = makeView(doc);
    const long = 'y'.repeat(120);
    setAll(view, [
      ghost({ id: 'a', agentName: 'Planner', hue: 52, hunks: [{ old: 'alpha', new: 'A', oldDone: true }] }),
      ghost({ id: 'b', agentName: 'Coder', hue: 262, hunks: [{ old: 'gamma', new: long, oldDone: true }] }),
    ]);

    const found = blocks(view);
    expect(found).toHaveLength(2);
    const [a, b] = found as [HTMLElement, HTMLElement];
    expect(a.dataset['ghostId']).toBe('a');
    expect(b.dataset['ghostId']).toBe('b');
    expect(a.getAttribute('style')).toContain('hsl(52 55% 45%)');
    expect(b.getAttribute('style')).toContain('hsl(262 55% 45%)');
    expect(a.getAttribute('style')).not.toBe(b.getAttribute('style'));
    const carets = [...view.dom.querySelectorAll<HTMLElement>('.cm-agent-ghost-caret')];
    expect(carets.map((c) => c.getAttribute('style'))).toEqual([
      'border-left: 2px solid hsl(52 55% 45%)',
      'border-left: 2px solid hsl(262 55% 45%)',
    ]);
    expect(carets.map((c) => c.textContent)).toEqual(['Planner', 'Coder']);

    // One frame later the short one is already done while the long one is not.
    stepGhostAnimation(view);
    expect(typed(blocks(view)[0]!)).toBe('A');
    expect(typed(blocks(view)[1]!).length).toBeLessThan(long.length);
    settle(view);
    expect(typed(blocks(view)[1]!)).toBe(long);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('setGhosts([]) removes every mark, widget, dimming and tag', () => {
    const view = makeView(DOC);
    setAll(view, [
      ghost({ id: 'a' }),
      ghost({ id: 'w', mode: 'write', hunks: [{ old: '', new: 'new file', oldDone: true }] }),
      ghost({ id: 'u', hunks: [{ old: 'nowhere', new: 'x', oldDone: true }] }),
    ]);
    settle(view);
    expect(view.dom.querySelectorAll('.cm-agent-ghost-block').length).toBeGreaterThan(0);

    setAll(view, []);
    expect(view.dom.querySelector('[class*="cm-agent-ghost"]')).toBeNull();
    expect(ghostsNeedFrames(view)).toBe(false);
    expect(stepGhostAnimation(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('drops one ghost and keeps the other', () => {
    const view = makeView('p\nq\n');
    setAll(view, [
      ghost({ id: 'a', hunks: [{ old: 'p', new: 'P', oldDone: true }] }),
      ghost({ id: 'b', hunks: [{ old: 'q', new: 'Q', oldDone: true }] }),
    ]);
    settle(view);
    setAll(view, [ghost({ id: 'b', hunks: [{ old: 'q', new: 'Q', oldDone: true }] })]);
    expect(blocks(view).map((w) => w.dataset['ghostId'])).toEqual(['b']);
    expect(marks(view).map((m) => m.textContent)).toEqual(['q']);
  });

  it('ignores a re-send of identical ghosts and does not restart their animation', () => {
    const view = makeView(DOC);
    const full = 'z'.repeat(60);
    const make = (): EditorGhost => ghost({ hunks: [{ old: 'return 1;', new: full, oldDone: true }] });
    setAll(view, [make()]);
    stepGhostAnimation(view);
    const midway = typed(blocks(view)[0]!);
    expect(midway.length).toBeGreaterThan(0);
    // The parent re-derives ghosts on every tick: same content, new objects.
    setAll(view, [make()]);
    expect(typed(blocks(view)[0]!)).toBe(midway);
  });

  it('leaves the editor with no ghost state when none were ever set', () => {
    const view = makeView(DOC);
    expect(view.dom.querySelector('[class*="cm-agent-ghost"]')).toBeNull();
    expect(ghostsNeedFrames(view)).toBe(false);
    expect(stepGhostAnimation(view)).toBe(false);
  });
});

describe('animation scheduling', () => {
  it('schedules no frame while idle, and none once everything has caught up', () => {
    const driver = manualScheduler();
    const view = makeView(DOC, driver.schedule);
    expect(driver.scheduled).toBe(0);

    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'x'.repeat(100), oldDone: true }] })]);
    expect(driver.pending).toBe(1);

    let frames = 0;
    while (driver.pending > 0) {
      driver.runNext();
      frames++;
      expect(frames).toBeLessThan(200);
    }
    expect(typed(blocks(view)[0]!)).toBe('x'.repeat(100));
    // The loop ended by itself: nothing is scheduled, and nothing ever will be.
    const scheduledAtRest = driver.scheduled;
    expect(driver.pending).toBe(0);
    view.dispatch({ changes: { from: 0, insert: '// human\n' } });
    expect(driver.scheduled).toBe(scheduledAtRest);
  });

  it('an unchanged ghost set after settling does not restart the loop', () => {
    const driver = manualScheduler();
    const view = makeView(DOC, driver.schedule);
    setAll(view, [ghost()]);
    while (driver.pending > 0) driver.runNext();
    const scheduledAtRest = driver.scheduled;
    setAll(view, [ghost()]);
    expect(driver.pending).toBe(0);
    expect(driver.scheduled).toBe(scheduledAtRest);
  });

  it('cancels its pending frame when the view is destroyed', () => {
    const driver = manualScheduler();
    const view = makeView(DOC, driver.schedule);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'x'.repeat(100), oldDone: true }] })]);
    expect(driver.pending).toBe(1);
    view.destroy();
    expect(driver.pending).toBe(0);
  });

  it('keeps animating when more text arrives mid-run, and stops again', () => {
    const driver = manualScheduler();
    const view = makeView(DOC, driver.schedule);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'ab', oldDone: true }] })]);
    while (driver.pending > 0) driver.runNext();
    expect(typed(blocks(view)[0]!)).toBe('ab');

    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'abcdefgh', oldDone: true }] })]);
    expect(driver.pending).toBe(1);
    while (driver.pending > 0) driver.runNext();
    expect(typed(blocks(view)[0]!)).toBe('abcdefgh');
  });

  it('runs on the real requestAnimationFrame by default', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: DOC, extensions: [agentGhostExtension()] }),
    });
    views.push(view);
    setAll(view, [ghost({ hunks: [{ old: 'return 1;', new: 'return 2 + 3;', oldDone: true }] })]);
    await vi.waitFor(() => expect(typed(blocks(view)[0]!)).toBe('return 2 + 3;'), { timeout: 2000 });
    host.remove();
  });
});

describe('follow', () => {
  /** Every effect dispatched through the view, so scroll requests are visible. */
  function recordDispatches(view: EditorView): Array<{ value: unknown }> {
    const effects: Array<{ value: unknown }> = [];
    const original = view.dispatch.bind(view) as (...args: unknown[]) => void;
    vi.spyOn(view, 'dispatch').mockImplementation(((...args: unknown[]) => {
      const spec = args[0] as { effects?: unknown } | undefined;
      const list = spec?.effects === undefined ? [] : Array.isArray(spec.effects) ? spec.effects : [spec.effects];
      for (const effect of list as Array<{ value: unknown }>) effects.push(effect);
      original(...args);
    }) as never);
    return effects;
  }
  /** `EditorView.scrollIntoView` effects: their value is a scroll target carrying `yMargin`. */
  const scrolls = (effects: Array<{ value: unknown }>): Array<{ y: string }> =>
    effects
      .map((e) => e.value as { y?: string; yMargin?: number } | null)
      .filter((v): v is { y: string } => typeof v === 'object' && v !== null && 'yMargin' in v);
  /** Keys of the measure requests the follow logic asks for. */
  function recordMeasures(view: EditorView): string[] {
    const keys: string[] = [];
    const original = view.requestMeasure.bind(view) as (request?: { key?: unknown }) => void;
    vi.spyOn(view, 'requestMeasure').mockImplementation(((request?: { key?: unknown }) => {
      if (typeof request?.key === 'string' && request.key.startsWith('agent-ghost-follow:')) keys.push(request.key);
      original(request);
    }) as never);
    return keys;
  }
  const grow = { old: 'return 1;', new: 'x'.repeat(100), oldDone: true };

  it('keeps a followed ghost visible as it grows, by fitting the end of its drawn widget', () => {
    const view = makeView(DOC);
    const measures = recordMeasures(view);
    const effects = recordDispatches(view);
    setAll(view, [ghost({ id: 'tool_1', follow: true, hunks: [grow] })]);
    settle(view);
    expect(measures.length).toBeGreaterThan(0);
    expect(new Set(measures)).toEqual(new Set(['agent-ghost-follow:tool_1']));
    // The widget is drawn, so no position scroll is needed (and none would fit
    // a widget taller than the editor).
    expect(scrolls(effects)).toHaveLength(0);
  });

  it('scrolls the anchor into view when the followed widget is outside the rendered viewport', () => {
    const doc = Array.from({ length: 4000 }, (_, i) => `const row${i} = ${i};`).join('\n');
    const view = makeView(doc);
    const effects = recordDispatches(view);
    setAll(view, [ghost({ follow: true, hunks: [{ old: 'const row3900 = 3900;', new: 'y'.repeat(60), oldDone: true }] })]);
    // Precondition, stated loudly: CodeMirror has not drawn the widget at all.
    expect(blocks(view)).toHaveLength(0);
    stepGhostAnimation(view);
    const requested = scrolls(effects);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.y).toBe('nearest');
  });

  it('does nothing for a ghost that is not being followed', () => {
    const view = makeView(DOC);
    const measures = recordMeasures(view);
    const effects = recordDispatches(view);
    setAll(view, [ghost({ follow: false, hunks: [grow] })]);
    settle(view);
    expect(measures).toHaveLength(0);
    expect(scrolls(effects)).toHaveLength(0);
  });

  it('stops following a ghost that has caught up while another is still typing', () => {
    const view = makeView('alpha\nbeta\n');
    setAll(view, [
      ghost({ id: 'done', follow: true, hunks: [{ old: 'alpha', new: 'A', oldDone: true }] }),
      ghost({ id: 'busy', follow: false, hunks: [{ old: 'beta', new: 'y'.repeat(200), oldDone: true }] }),
    ]);
    expect(stepGhostAnimation(view)).toBe(true); // "done" finishes its single character here
    const measures = recordMeasures(view);
    expect(settle(view)).toBeGreaterThan(1);
    expect(measures).toHaveLength(0);
  });

  it('does nothing once the followed ghost has stopped growing', () => {
    const view = makeView(DOC);
    setAll(view, [ghost({ follow: true })]);
    settle(view);
    const measures = recordMeasures(view);
    const effects = recordDispatches(view);
    expect(stepGhostAnimation(view)).toBe(false);
    expect(measures).toHaveLength(0);
    expect(scrolls(effects)).toHaveLength(0);
  });
});
