import { describe, expect, it } from 'vitest';
import { extensionToLang, highlightCode } from '../highlighter.js';

describe('extensionToLang', () => {
  it('maps known extensions to a grammar id', () => {
    expect(extensionToLang('src/App.tsx')).toBe('tsx');
    expect(extensionToLang('README.md')).toBe('markdown');
  });

  it('returns null for an unknown extension', () => {
    expect(extensionToLang('data.bin')).toBeNull();
  });

  it('returns null for a path with no extension', () => {
    expect(extensionToLang('Makefile')).toBeNull();
  });
});

describe('highlightCode', () => {
  it('falls back to null (plain <pre>) for an unknown extension, without throwing', async () => {
    await expect(highlightCode('data.bin', 'anything')).resolves.toBeNull();
  });

  it('highlights a known-extension file into token lines', async () => {
    const lines = await highlightCode('a.json', '{\n  "x": 1\n}');
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(3);
    // Every token carries real text; re-joining recovers the source line.
    for (const [i, line] of lines!.entries()) {
      const joined = line.tokens.map((t) => t.text).join('');
      expect(joined).toBe('{\n  "x": 1\n}'.split('\n')[i]);
    }
  }, 20000);
});
