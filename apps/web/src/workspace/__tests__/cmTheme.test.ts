import { describe, expect, it } from 'vitest';
import { tags } from '@lezer/highlight';
import { NEXUS_HIGHLIGHT_SPEC } from '../cmTheme.js';
import { COLORS } from '../../design/tokens.js';

/**
 * Guards the legibility of the editor's syntax colours.
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

const colorValues = new Set(Object.values(COLORS));

/** The entry covering a tag, or undefined — mirrors how CodeMirror resolves. */
const specFor = (tag: unknown) =>
  NEXUS_HIGHLIGHT_SPEC.find((entry) =>
    Array.isArray(entry.tag) ? entry.tag.includes(tag as never) : entry.tag === tag,
  );

describe('the editor highlight style', () => {
  it('renders variable names in the foreground colour, not a light-theme navy', () => {
    // The exact regression: `decision`, `participantId`, `threshold` and every
    // other identifier were unreadable.
    expect(specFor(tags.variableName)?.color).toBe(COLORS.fg);
  });

  it('renders property names legibly too', () => {
    // Interface members — `decision:`, `via:` — take this tag, and were the
    // worst-affected in the shipped screenshot.
    expect(specFor(tags.propertyName)?.color).toBe(COLORS.fg);
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

  it('keeps comments muted and italic, matching the Shiki theme it replaces', () => {
    // DiffViewer still renders through Shiki's nexusTheme. Two visibly different
    // palettes in one pane would read as a bug.
    const comment = specFor(tags.comment);
    expect(comment?.color).toBe(COLORS.fgMuted);
    expect(comment?.fontStyle).toBe('italic');
  });
});
