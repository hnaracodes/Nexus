import { HighlightStyle } from '@codemirror/language';
import type { TagStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { COLORS } from '../design/tokens.js';

/**
 * The editor's syntax palette, and why it is hand-built rather than imported.
 *
 * CodeMirror ships `defaultHighlightStyle`, which is a LIGHT-theme palette. The
 * room is dark-only (`index.css` says so), so using it rendered every variable
 * and property name in a near-black navy on a near-black background — legible
 * in no sense of the word. It shipped through five green component tests,
 * because jsdom can assert structure but not contrast.
 *
 * The role→colour mapping below is carried over verbatim from the Shiki
 * `nexusTheme` this replaces, so the pane looks the same after the engine swap
 * as before it. That theme was itself built from `design/tokens.ts` — the same
 * single source of colour truth — and the mapping is merely re-expressed in
 * Lezer's vocabulary of tags rather than TextMate's vocabulary of scopes.
 */
export const NEXUS_HIGHLIGHT_SPEC: readonly TagStyle[] = [
  { tag: tags.comment, color: COLORS.fgMuted, fontStyle: 'italic' },
  { tag: [tags.string, tags.special(tags.string)], color: COLORS.accent3 },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: COLORS.accent2 },
  {
    tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.modifier, tags.definitionKeyword],
    color: COLORS.info,
  },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: COLORS.warn },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: COLORS.accent },
  // The regression this module exists to fix. Identifiers are the most common
  // token in any file, so they take the plain foreground rather than a colour.
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: COLORS.fg },
  { tag: [tags.punctuation, tags.bracket, tags.operator], color: COLORS.fgMuted },
  { tag: tags.invalid, color: COLORS.danger },
];

export const nexusHighlightStyle = HighlightStyle.define([...NEXUS_HIGHLIGHT_SPEC]);

/**
 * Chrome around the text. `{ dark: true }` is not cosmetic — it tells
 * CodeMirror to pick its dark defaults for selection, the cursor and the
 * active-line background, none of which the spec above covers.
 */
export const nexusEditorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: COLORS.fg },
    '.cm-scroller': { fontFamily: 'inherit', lineHeight: '20px' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      border: 'none',
      color: COLORS.fgMuted,
    },
    '.cm-cursor': { borderLeftColor: COLORS.accent },
    '.cm-activeLine': { backgroundColor: 'transparent' },
  },
  { dark: true },
);
