/**
 * What a workspace path is, for deciding HOW to show it: as editable text, as
 * rendered Markdown beside the text, or as an image. Purely extension-based —
 * the server's own text/binary decision still wins when a file is read.
 */
export type FileKind = 'markdown' | 'image' | 'code';

const MARKDOWN = new Set(['md', 'markdown', 'mdx']);
// SVG is deliberately NOT an image here: it is XML text and opens in the
// editor, which is what a code editor does with it (and it avoids rendering
// attacker-controlled SVG as an <img> from a room's working tree).
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif']);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function fileKind(path: string): FileKind {
  const ext = extensionOf(path);
  if (MARKDOWN.has(ext)) return 'markdown';
  if (IMAGE.has(ext)) return 'image';
  return 'code';
}

const LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  tsx: 'TypeScript React',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JavaScript React',
  json: 'JSON',
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'Markdown',
  py: 'Python',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  htm: 'HTML',
  yml: 'YAML',
  yaml: 'YAML',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  c: 'C',
  h: 'C',
  cpp: 'C++',
  hpp: 'C++',
  sh: 'Shell Script',
  bash: 'Shell Script',
  zsh: 'Shell Script',
  sql: 'SQL',
  toml: 'TOML',
  xml: 'XML',
  svg: 'XML',
  txt: 'Plain Text',
};

/** The status-bar language label for a path. Unknown extensions are honestly "Plain Text". */
export function languageLabel(path: string): string {
  return LANGUAGE_LABELS[extensionOf(path)] ?? 'Plain Text';
}
