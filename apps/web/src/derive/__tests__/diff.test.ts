import { describe, expect, it } from 'vitest';
import { anchorEdit, diffLines } from '../diff.js';

describe('diffLines', () => {
  it('renders identical inputs as all context', () => {
    const hunk = diffLines('a\nb\nc', 'a\nb\nc');
    expect(hunk.lines.every((l) => l.kind === 'context')).toBe(true);
    expect(hunk.addCount).toBe(0);
    expect(hunk.removeCount).toBe(0);
  });

  it('renders a pure insertion', () => {
    const hunk = diffLines('a\nc', 'a\nb\nc');
    expect(hunk.lines.map((l) => l.kind)).toEqual(['context', 'add', 'context']);
    expect(hunk.addCount).toBe(1);
    expect(hunk.removeCount).toBe(0);
  });

  it('renders a pure deletion', () => {
    const hunk = diffLines('a\nb\nc', 'a\nc');
    expect(hunk.lines.map((l) => l.kind)).toEqual(['context', 'remove', 'context']);
    expect(hunk.addCount).toBe(0);
    expect(hunk.removeCount).toBe(1);
  });

  it('renders a replacement as a remove and an add', () => {
    const hunk = diffLines('x', 'y');
    expect(hunk.addCount).toBe(1);
    expect(hunk.removeCount).toBe(1);
    expect(hunk.lines.some((l) => l.kind === 'remove' && l.text === 'x')).toBe(true);
    expect(hunk.lines.some((l) => l.kind === 'add' && l.text === 'y')).toBe(true);
  });

  it('renders empty-to-nonempty as pure additions, not an empty phantom line', () => {
    const hunk = diffLines('', 'a\nb');
    expect(hunk.lines).toHaveLength(2);
    expect(hunk.lines.every((l) => l.kind === 'add')).toBe(true);
    expect(hunk.addCount).toBe(2);
  });

  it('numbers context lines on both sides and add/remove lines on one side only', () => {
    const hunk = diffLines('a\nb', 'a\nc');
    const remove = hunk.lines.find((l) => l.kind === 'remove')!;
    const add = hunk.lines.find((l) => l.kind === 'add')!;
    expect(remove.newLineNo).toBeNull();
    expect(add.oldLineNo).toBeNull();
  });
});

describe('anchorEdit', () => {
  const file = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'].join('\n');

  it('anchors a fragment that occurs exactly once, with real line numbers', () => {
    const result = anchorEdit(file, '  return 1;', '  return 42;');
    expect(result.contextUnavailable).toBe(false);
    if (!result.contextUnavailable) {
      expect(result.startOldLine).toBe(1); // windowed with 3 lines of context, clamped to file start
      const removed = result.hunk.lines.find((l) => l.kind === 'remove');
      const added = result.hunk.lines.find((l) => l.kind === 'add');
      expect(removed?.text).toBe('  return 1;');
      expect(removed?.oldLineNo).toBe(2);
      expect(added?.text).toBe('  return 42;');
    }
  });

  it('reports contextUnavailable with reason not_cached when no file version is known', () => {
    const result = anchorEdit(null, '  return 1;', '  return 42;');
    expect(result).toEqual({ contextUnavailable: true, reason: 'not_cached' });
  });

  it('reports contextUnavailable with reason zero_occurrences on a stale cache', () => {
    const result = anchorEdit(file, 'this text does not appear', 'replacement');
    expect(result).toEqual({ contextUnavailable: true, reason: 'zero_occurrences' });
  });

  it('reports contextUnavailable with reason multiple_occurrences', () => {
    // '}' (the closing brace) occurs twice in this fixture.
    const repeated = anchorEdit(file, '}', 'X');
    expect(repeated).toEqual({ contextUnavailable: true, reason: 'multiple_occurrences' });
  });

  it('never fabricates a line number when context is unavailable', () => {
    const result = anchorEdit(null, 'x', 'y');
    expect(result.contextUnavailable).toBe(true);
    expect('startOldLine' in result).toBe(false);
  });
});
