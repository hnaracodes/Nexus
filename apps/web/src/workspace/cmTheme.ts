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
 * The mapping below is VS Code's Dark+ syntax palette expressed in Lezer's
 * vocabulary of tags. Every colour comes from `design/tokens.ts`.
 */
export const NEXUS_HIGHLIGHT_SPEC: readonly TagStyle[] = [
  { tag: tags.comment, color: COLORS.synComment },
  { tag: [tags.string, tags.special(tags.string)], color: COLORS.synString },
  { tag: tags.number, color: COLORS.synNumber },
  {
    tag: [tags.bool, tags.null, tags.atom, tags.keyword, tags.modifier, tags.definitionKeyword, tags.operatorKeyword],
    color: COLORS.synKeyword,
  },
  { tag: [tags.controlKeyword, tags.moduleKeyword], color: COLORS.synControl },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: COLORS.synFunction },
  { tag: [tags.typeName, tags.className, tags.namespace], color: COLORS.synType },
  // Identifiers are the most common token in any file. Dark+ paints them light
  // blue; the plain foreground made code read as grey prose.
  { tag: [tags.variableName, tags.propertyName, tags.attributeName], color: COLORS.synVariable },
  { tag: tags.constant(tags.variableName), color: COLORS.synConstant },
  { tag: tags.tagName, color: COLORS.synKeyword },
  { tag: tags.regexp, color: COLORS.synRegexp },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: COLORS.synOperator },
  { tag: tags.heading, color: COLORS.synKeyword, fontWeight: 'bold' },
  { tag: [tags.link, tags.url], color: COLORS.accentFg, textDecoration: 'underline' },
  { tag: tags.invalid, color: COLORS.danger },
];

export const nexusHighlightStyle = HighlightStyle.define([...NEXUS_HIGHLIGHT_SPEC]);

/**
 * Chrome around the text, VS Code Dark+. `{ dark: true }` is not cosmetic: it
 * tells CodeMirror to pick its dark defaults. Selectors for extensions the
 * layout installs (active line, bracket matching, drawSelection) are styled
 * here whether or not a given editor installs them.
 */
export const nexusEditorTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: COLORS.bg, color: COLORS.fg },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono), Menlo, Consolas, "SF Mono", monospace',
      lineHeight: '20px',
    },
    '.cm-content': { padding: '4px 0', caretColor: COLORS.synCursor },
    '.cm-gutters': {
      backgroundColor: COLORS.bg,
      border: 'none',
      color: COLORS.editorGutterFg,
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: COLORS.editorGutterActiveFg,
    },
    '.cm-activeLine': { backgroundColor: COLORS.editorLineHighlight },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: COLORS.synCursor },
    '.cm-selectionBackground': { backgroundColor: COLORS.selection },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: COLORS.selection,
    },
    '.cm-content ::selection': { backgroundColor: COLORS.selection },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: COLORS.editorBracketMatchBg,
      outline: `1px solid ${COLORS.editorBracketMatchBorder}`,
    },
    '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': {
      backgroundColor: 'transparent',
      color: COLORS.danger,
    },
    '.cm-tooltip': {
      backgroundColor: COLORS.surface,
      border: `1px solid ${COLORS.border}`,
      color: COLORS.fg,
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: COLORS.accentDim,
      color: COLORS.fg,
    },
    '.cm-panels': {
      backgroundColor: COLORS.surface,
      color: COLORS.fg,
      borderColor: COLORS.border,
    },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${COLORS.border}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${COLORS.border}` },
    '.cm-searchMatch': { backgroundColor: COLORS.accentDim },
  },
  { dark: true },
);
