import { describe, expect, it } from 'vitest';
import { PartialJsonScanner } from '../../../src/server/live/partialJson.js';
import type { JsonPath, ScanEvent } from '../../../src/server/live/partialJson.js';

/** Rebuild every string and scalar the scanner reported, keyed by path. */
function collect(events: ScanEvent[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const key = (path: JsonPath) => JSON.stringify(path);
  for (const e of events) {
    if (e.type === 'string_start') out.set(key(e.path), '');
    if (e.type === 'string_append') out.set(key(e.path), (out.get(key(e.path)) as string) + e.text);
    if (e.type === 'scalar') out.set(key(e.path), e.value);
  }
  return out;
}

/** The same, from JSON.parse — the ground truth. */
function truth(value: unknown, path: JsonPath = [], out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((v, i) => truth(v, [...path, i], out));
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) truth(v, [...path, k], out);
  } else out.set(JSON.stringify(path), value);
  return out;
}

const INPUTS = [
  JSON.stringify({
    file_path: '/room/src/app.ts',
    old_string: 'const a = "x";\n\tif (a) {\\n}',
    new_string: 'const a = "café ☕ 😀";\r\n/* \\ done */',
    replace_all: false,
  }),
  JSON.stringify({
    file_path: '/room/a.ts',
    edits: [
      { old_string: 'one', new_string: 'two' },
      { old_string: 'three', new_string: 'four\nfive', replace_all: true },
    ],
  }),
  // Escapes the model actually emits, written by hand: \u escapes and a surrogate pair.
  '{"file_path":"/r/w.ts","content":"line1\\nl\\u00e9ne2 \\ud83d\\ude00 end","n":12.5e1,"z":null}',
];

describe('PartialJsonScanner', () => {
  for (const [n, input] of INPUTS.entries()) {
    const expected = truth(JSON.parse(input));

    it(`input ${n}: every two-chunk split reconstructs JSON.parse exactly`, () => {
      for (let i = 0; i <= input.length; i++) {
        const scanner = new PartialJsonScanner();
        const events = [...scanner.push(input.slice(0, i)), ...scanner.push(input.slice(i))];
        expect(scanner.failed).toBe(false);
        expect(collect(events)).toEqual(expected);
      }
    });

    it(`input ${n}: one character at a time reconstructs JSON.parse exactly`, () => {
      const scanner = new PartialJsonScanner();
      const events = [...input].flatMap((ch) => scanner.push(ch));
      expect(collect(events)).toEqual(expected);
    });
  }

  it('never emits half a surrogate pair, even split mid-escape', () => {
    const input = '{"content":"a\\ud83d\\ude00b"}';
    for (let i = 0; i <= input.length; i++) {
      const scanner = new PartialJsonScanner();
      const events = [...scanner.push(input.slice(0, i)), ...scanner.push(input.slice(i))];
      for (const e of events) {
        if (e.type !== 'string_append') continue;
        const last = e.text.charCodeAt(e.text.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it('announces a string before its text, so the path is known early', () => {
    const scanner = new PartialJsonScanner();
    const events = scanner.push('{"file_path":"/r/a');
    expect(events[0]).toEqual({ type: 'string_start', path: ['file_path'] });
    expect(events[1]).toEqual({ type: 'string_append', path: ['file_path'], text: '/r/a' });
    expect(scanner.push('.ts"')).toEqual([
      { type: 'string_append', path: ['file_path'], text: '.ts' },
      { type: 'string_end', path: ['file_path'] },
    ]);
  });

  it('stops quietly on malformed input and never throws', () => {
    const scanner = new PartialJsonScanner();
    expect(() => scanner.push('{"a": tru}')).not.toThrow();
    expect(scanner.failed).toBe(true);
    expect(scanner.push('{"b":"c"}')).toEqual([]);
    const bad = new PartialJsonScanner();
    bad.push('{"a":"\\q"}');
    expect(bad.failed).toBe(true);
  });
});
