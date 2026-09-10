import { describe, expect, it } from 'vitest';
import { withExternalChanges } from '../externalChanges.js';

describe('withExternalChanges', () => {
  it('raises the freshness token for a path the watcher reported', () => {
    // The whole point: a file cached at token 3 must compare as stale after an
    // external edit, using the comparison useWorkspace already performs.
    const merged = withExternalChanges(new Map([['a.ts', 3]]), { paths: ['a.ts'], nonce: 1 });
    expect(merged.get('a.ts')).toBeGreaterThan(3);
  });

  it('raises it again on a second change to the same path', () => {
    // A formatter rewriting one file reports the identical path list every time.
    // If the token stopped moving, the second change would render as no change.
    const first = withExternalChanges(new Map([['a.ts', 0]]), { paths: ['a.ts'], nonce: 1 });
    const second = withExternalChanges(new Map([['a.ts', 0]]), { paths: ['a.ts'], nonce: 2 });
    expect(second.get('a.ts')!).toBeGreaterThan(first.get('a.ts')!);
  });

  it('tracks a path with no logged edits at all', () => {
    // An externally-created file has no entry in the log-derived map. It must
    // still become visible rather than being skipped for lack of a seq.
    const merged = withExternalChanges(new Map(), { paths: ['new.ts'], nonce: 1 });
    expect(merged.get('new.ts')).toBeGreaterThan(0);
  });

  it('leaves untouched paths exactly as they were', () => {
    const merged = withExternalChanges(new Map([['a.ts', 5], ['b.ts', 9]]), {
      paths: ['a.ts'],
      nonce: 1,
    });
    expect(merged.get('b.ts')).toBe(9);
  });

  it('does not mutate the map it was given', () => {
    // useWorkspace holds the log-derived map in a ref across renders; mutating
    // it would corrupt the baseline every later comparison is made against.
    const source = new Map([['a.ts', 1]]);
    withExternalChanges(source, { paths: ['a.ts'], nonce: 7 });
    expect(source.get('a.ts')).toBe(1);
  });
});
