import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { NEXUS_HIGHLIGHT_SPEC, nexusEditorTheme } from '../cmTheme.js';
import { COLORS } from '../../design/tokens.js';

/**
 * Guards the legibility and the Dark+ identity of the editor's syntax colours.
 *
 * Phase 11a shipped CodeMirror with `defaultHighlightStyle`, which is
 * CodeMirror's LIGHT-theme palette. The room is dark-only, so variable and
 * property names rendered in a near-black navy on a near-black background —
 * effectively invisible. All five component tests passed, because jsdom asserts
 * structure and cannot assert contrast; a real browser showed it in one
 * screenshot.
 *
 * These assertions are about the STYLE SPEC rather than rendered DOM on purpose.
 * CodeMirror only applies highlight classes once the language parser has run,
 * and grammars load asynchronously here, so a DOM-level assertion would be
 * flaky in exactly the way that teaches people to ignore a failing test.
 */

const colorValues = new Set<string>(Object.values(COLORS));

/** The entry covering a tag, or undefined — mirrors how CodeMirror resolves. */
const specFor = (tag: unknown) =>
  NEXUS_HIGHLIGHT_SPEC.find((entry) =>
    Array.isArray(entry.tag) ? entry.tag.includes(tag as never) : entry.tag === tag,
  );

describe('the editor highlight style (Dark+)', () => {
  it('paints identifiers light blue (synVariable), no longer the plain foreground', () => {
    expect(specFor(tags.variableName)?.color).toBe(COLORS.synVariable);
    expect(specFor(tags.propertyName)?.color).toBe(COLORS.synVariable);
    expect(specFor(tags.attributeName)?.color).toBe(COLORS.synVariable);
  });

  it('maps the Dark+ syntax roles', () => {
    expect(specFor(tags.keyword)?.color).toBe(COLORS.synKeyword);
    expect(specFor(tags.controlKeyword)?.color).toBe(COLORS.synControl);
    expect(specFor(tags.moduleKeyword)?.color).toBe(COLORS.synControl);
    expect(specFor(tags.string)?.color).toBe(COLORS.synString);
    expect(specFor(tags.comment)?.color).toBe(COLORS.synComment);
    expect(specFor(tags.number)?.color).toBe(COLORS.synNumber);
    expect(specFor(tags.typeName)?.color).toBe(COLORS.synType);
    expect(specFor(tags.className)?.color).toBe(COLORS.synType);
    expect(specFor(tags.function(tags.variableName))?.color).toBe(COLORS.synFunction);
    expect(specFor(tags.constant(tags.variableName))?.color).toBe(COLORS.synConstant);
    expect(specFor(tags.tagName)?.color).toBe(COLORS.synKeyword);
    expect(specFor(tags.regexp)?.color).toBe(COLORS.synRegexp);
    expect(specFor(tags.operator)?.color).toBe(COLORS.synOperator);
    expect(specFor(tags.link)?.color).toBe(COLORS.accentFg);
    expect(specFor(tags.invalid)?.color).toBe(COLORS.danger);
  });

  it('draws every colour from the design tokens, never a literal hex', () => {
    // design-system/nexus/MASTER.md: components never write raw hex. A syntax
    // palette is the easiest place for that rule to quietly rot.
    for (const entry of NEXUS_HIGHLIGHT_SPEC) {
      expect(colorValues, `${String(entry.tag)} uses a colour outside tokens.ts`).toContain(
        entry.color,
      );
    }
  });

  it('does not italicise comments (Dark+ draws them upright)', () => {
    expect(specFor(tags.comment)?.fontStyle).toBeUndefined();
  });

  it('bolds headings', () => {
    expect(specFor(tags.heading)?.fontWeight).toBe('bold');
  });
});

describe('the editor chrome theme', () => {
  /** CodeMirror injects the theme as a <style> sheet once a view mounts. */
  function themeCss(): string {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: 'x', extensions: [nexusEditorTheme] }),
      parent,
    });
    const css = Array.from(document.querySelectorAll('style'))
      .map((s) => s.textContent ?? '')
      .join('\n');
    view.destroy();
    parent.remove();
    return css;
  }

  it('is a dark theme', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: '', extensions: [nexusEditorTheme] }),
      parent,
    });
    expect(view.dom.classList.toString()).toMatch(/cm-/);
    // `dark: true` makes the state's darkTheme facet true.
    expect(view.state.facet(EditorView.darkTheme)).toBe(true);
    view.destroy();
    parent.remove();
  });

  it('declares rules for every Dark+ editor selector', () => {
    const css = themeCss();
    for (const selector of [
      '.cm-activeLine',
      '.cm-activeLineGutter',
      '.cm-matchingBracket',
      '.cm-selectionBackground',
      '.cm-cursor',
      '.cm-gutters',
    ]) {
      expect(css, `no rule for ${selector}`).toContain(selector);
    }
  });

  it('uses the editor background and the Dark+ cursor colour', () => {
    const css = themeCss().toLowerCase();
    expect(css).toContain(COLORS.bg.toLowerCase());
    expect(css).toContain(COLORS.synCursor.toLowerCase());
  });
});
