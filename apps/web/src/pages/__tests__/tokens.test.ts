// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { COLORS, AVATAR_HUES } from '../../design/tokens.js';

import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const tailwind = readFileSync(new URL("../../../tailwind.config.js", import.meta.url), "utf8");

const kebab = (key: string): string => key.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`);

/** COLORS-only keys: no CSS variable, no Tailwind entry. */
const isCodeMirrorOnly = (key: string): boolean => key.startsWith('syn') || key.startsWith('editor');

const NEW_TOKENS = [
  'accentFg', 'accentHover', 'activity', 'activityFg', 'activityFgActive', 'titlebar',
  'tabStrip', 'tabInactive', 'tabActive', 'status', 'statusFg', 'statusAlert',
  'statusError', 'input', 'selection',
] as const;

const SYN_KEYS = [
  'synKeyword', 'synControl', 'synString', 'synComment', 'synNumber', 'synType',
  'synFunction', 'synVariable', 'synConstant', 'synRegexp', 'synOperator', 'synCursor',
  'editorLineHighlight', 'editorGutterFg', 'editorGutterActiveFg',
  'editorBracketMatchBg', 'editorBracketMatchBorder',
] as const;

const LEGACY_TOKENS = [
  'bg', 'surface', 'surface2', 'muted', 'border', 'borderStrong', 'fg', 'fgMuted',
  'accent', 'accentDim', 'onAccent', 'success', 'lime', 'nexus', 'accent2', 'accent3',
  'warn', 'danger', 'info',
] as const;

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('design tokens', () => {
  it('keeps every pre-existing token name', () => {
    for (const key of LEGACY_TOKENS) expect(COLORS).toHaveProperty(key);
  });

  it('adds every phase-18b shell and syntax token', () => {
    for (const key of [...NEW_TOKENS, ...SYN_KEYS]) expect(COLORS).toHaveProperty(key);
  });

  it('uses 6-digit hex everywhere, 8-digit only for editor* alpha keys', () => {
    for (const [key, value] of Object.entries(COLORS)) {
      if (key.startsWith('editor') && /^#[0-9A-F]{8}$/i.test(value)) continue;
      expect(value, key).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });

  it('offers enough distinct avatar hues that a small room has no collision', () => {
    expect(AVATAR_HUES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(AVATAR_HUES).size).toBe(AVATAR_HUES.length);
  });
});

describe('token drift guard (tokens.ts vs index.css vs tailwind.config.js)', () => {
  const cssKeys = Object.keys(COLORS).filter((k) => !isCodeMirrorOnly(k));

  it.each(cssKeys)('%s has a CSS triplet equal to its hex and a Tailwind entry', (key) => {
    const name = kebab(key);
    const match = css.match(new RegExp(`--${name}:\\s*(\\d+) (\\d+) (\\d+);`));
    expect(match, `--${name} triplet missing from index.css`).not.toBeNull();
    const triplet = [Number(match![1]), Number(match![2]), Number(match![3])];
    expect(triplet, `--${name} drifted from COLORS.${key}`).toEqual(channels(COLORS[key as keyof typeof COLORS]));
    expect(tailwind, `tailwind entry for ${name}`).toContain(`rgb(var(--${name}) / <alpha-value>)`);
  });

  it('does not leak CodeMirror-only keys into CSS variables', () => {
    for (const key of Object.keys(COLORS).filter(isCodeMirrorOnly)) {
      expect(css).not.toContain(`--${kebab(key)}:`);
    }
  });
});

describe('WCAG contrast (pure JS ratios, not a rendered check)', () => {
  const C = COLORS;
  const textPairs: Array<[string, string, string]> = [
    ['fg/bg', C.fg, C.bg],
    ['fgMuted/surface', C.fgMuted, C.surface],
    ['fgMuted/bg', C.fgMuted, C.bg],
    ['accentFg/bg', C.accentFg, C.bg],
    ['accentFg/surface', C.accentFg, C.surface],
    ['onAccent/accent', C.onAccent, C.accent],
    ['statusFg/status', C.statusFg, C.status],
    ['statusFg/statusAlert', C.statusFg, C.statusAlert],
    ['statusFg/statusError', C.statusFg, C.statusError],
    ['danger/bg', C.danger, C.bg],
    ['warn/bg', C.warn, C.bg],
    ['activityFgActive/activity', C.activityFgActive, C.activity],
  ];

  it.each(textPairs)('%s is at least 4.5:1', (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('borderStrong on bg is at least 3:1', () => {
    expect(contrast(C.borderStrong, C.bg)).toBeGreaterThanOrEqual(3);
  });
});

describe('pages use tokens, never raw colour literals', () => {
  // Every page source as text. The cinematic intro is a self-contained
  // black-stage film with its own SVG literals, so it is allow-listed.
  const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const files = Object.entries(sources).filter(
    ([path]) => !path.includes('__tests__') && !path.endsWith('CinematicIntro.tsx'),
  );

  it('actually scanned the page sources', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it('has no #RRGGBB or rgb( literal outside the allow-list', () => {
    const offenders = files
      .filter(([, src]) => /#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b(?![\w-])|rgba?\(/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('never styles TEXT with the accent fill colour (3.6:1 on bg)', () => {
    const offenders = files
      .filter(([, src]) => /(?<![\w-])(?:[a-z-]+:)?text-accent(?![\w-])/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

