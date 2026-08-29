import { createHighlighterCore } from 'shiki/core';
import type { HighlighterCore, LanguageInput } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { COLORS } from '../design/tokens.js';

/**
 * Individual dynamic grammar imports — never the root `shiki` barrel, which
 * pulls every grammar it bundles. This module is itself only ever reached via
 * a dynamic `import()` from `CodeViewer.tsx`, so a room that never opens the
 * Files tab pays zero Shiki bytes, and each grammar below is its own chunk on
 * top of that.
 */
const GRAMMAR_LOADERS: Record<string, () => LanguageInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  python: () => import('shiki/langs/python.mjs'),
};

const EXTENSION_TO_LANG: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  css: 'css',
  html: 'html',
  htm: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
};

const THEME_NAME = 'nexus-dark';

/**
 * Built inline from `design/tokens.ts`'s `COLORS` rather than a bundled
 * theme — one source of colour truth, and the room is dark-only (`index.css`
 * already documents this).
 */
const nexusTheme = {
  name: THEME_NAME,
  type: 'dark' as const,
  colors: {
    'editor.background': COLORS.bg,
    'editor.foreground': COLORS.fg,
  },
  tokenColors: [
    { settings: { background: COLORS.bg, foreground: COLORS.fg } },
    { scope: ['comment'], settings: { foreground: COLORS.fgMuted, fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'string.template'], settings: { foreground: COLORS.accent3 } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: COLORS.accent2 } },
    { scope: ['keyword', 'storage.type', 'storage.modifier', 'keyword.control'], settings: { foreground: COLORS.info } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: COLORS.warn } },
    { scope: ['entity.name.tag', 'entity.name.type', 'entity.name.class'], settings: { foreground: COLORS.accent } },
    { scope: ['variable', 'variable.parameter', 'variable.other'], settings: { foreground: COLORS.fg } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: COLORS.fgMuted } },
    { scope: ['invalid'], settings: { foreground: COLORS.danger } },
  ],
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();

/** Module singleton — created on first call, not at import time. */
function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise === null) {
    highlighterPromise = createHighlighterCore({
      themes: [nexusTheme],
      langs: [],
      engine: createOnigurumaEngine(import('shiki/wasm')),
    });
  }
  return highlighterPromise;
}

/** `null` for an extension with no mapped grammar. */
export function extensionToLang(filePath: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  if (match === null) return null;
  return EXTENSION_TO_LANG[match[1]!.toLowerCase()] ?? null;
}

export interface HighlightToken {
  text: string;
  /** A hex colour string, or `null` for the theme's default foreground. */
  color: string | null;
}

export interface HighlightedLine {
  tokens: HighlightToken[];
}

/**
 * `null` means "no grammar for this extension" — the caller falls back to a
 * plain `<pre>`. Never throws: a grammar load failure or a highlighter
 * internal error also falls back to plain text rather than breaking the
 * viewer.
 */
export async function highlightCode(filePath: string, code: string): Promise<HighlightedLine[] | null> {
  const lang = extensionToLang(filePath);
  if (lang === null) return null;
  const loadGrammar = GRAMMAR_LOADERS[lang];
  if (loadGrammar === undefined) return null;

  try {
    const highlighter = await getHighlighter();
    if (!loadedLangs.has(lang)) {
      await highlighter.loadLanguage(loadGrammar());
      loadedLangs.add(lang);
    }
    const tokenLines = highlighter.codeToTokensBase(code, { lang, theme: THEME_NAME });
    return tokenLines.map((line) => ({
      tokens: line.map((token) => ({ text: token.content, color: token.color ?? null })),
    }));
  } catch {
    return null;
  }
}
