import { describe, expect, it } from 'vitest';
import { fileKind, languageLabel } from '../fileKinds.js';

describe('fileKind', () => {
  it('classifies markdown, images and everything else', () => {
    expect(fileKind('README.md')).toBe('markdown');
    expect(fileKind('docs/a.MARKDOWN')).toBe('markdown');
    expect(fileKind('img/logo.PNG')).toBe('image');
    expect(fileKind('a.jpeg')).toBe('image');
    expect(fileKind('src/a.ts')).toBe('code');
    expect(fileKind('Makefile')).toBe('code');
  });

  it('keeps SVG as text (opens in the editor, never as an <img>)', () => {
    expect(fileKind('icon.svg')).toBe('code');
  });

  it('ignores dots in directory names and treats dotfiles as code', () => {
    expect(fileKind('v1.png/readme')).toBe('code');
    expect(fileKind('.png')).toBe('code');
  });
});

describe('languageLabel', () => {
  it('names known languages and falls back to Plain Text', () => {
    expect(languageLabel('a.ts')).toBe('TypeScript');
    expect(languageLabel('a.tsx')).toBe('TypeScript React');
    expect(languageLabel('README.md')).toBe('Markdown');
    expect(languageLabel('data.unknownext')).toBe('Plain Text');
    expect(languageLabel('LICENSE')).toBe('Plain Text');
  });
});
