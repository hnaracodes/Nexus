import { describe, expect, it } from 'vitest';
import { isLoggedEvent } from '@syncode/protocol/events';
import { MAX_TERM_INPUT_CHARS, parseClientFrame } from '@syncode/protocol/wire';

const parse = (frame: unknown) => parseClientFrame(JSON.stringify(frame));

describe('terminal frames (phase 19b)', () => {
  it('logs the four terminal events, so a restart can still read them (I3)', () => {
    for (const type of ['terminal_opened', 'terminal_closed', 'terminal_typed', 'terminal_access_changed']) {
      expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type }), type).toBe(true);
    }
  });

  it('parses term_open with a sane size, and refuses a nonsense one', () => {
    expect(parse({ kind: 'term_open', cols: 120, rows: 30 })).toEqual({ kind: 'term_open', cols: 120, rows: 30 });
    expect(parse({ kind: 'term_open', cols: 0, rows: 30 })).toBeNull();
    expect(parse({ kind: 'term_open', cols: 120.5, rows: 30 })).toBeNull();
    expect(parse({ kind: 'term_open', cols: 100_000, rows: 30 })).toBeNull();
    expect(parse({ kind: 'term_open', cols: '120', rows: 30 })).toBeNull();
  });

  it('parses term_attach, term_close and term_resize against a terminal id', () => {
    expect(parse({ kind: 'term_attach', termId: 'term_abc' })).toEqual({ kind: 'term_attach', termId: 'term_abc' });
    expect(parse({ kind: 'term_close', termId: 'term_abc' })).toEqual({ kind: 'term_close', termId: 'term_abc' });
    expect(parse({ kind: 'term_resize', termId: 'term_abc', cols: 80, rows: 24 })).toEqual({
      kind: 'term_resize',
      termId: 'term_abc',
      cols: 80,
      rows: 24,
    });
    expect(parse({ kind: 'term_attach', termId: '' })).toBeNull();
    expect(parse({ kind: 'term_close' })).toBeNull();
  });

  it('parses term_input, and refuses input past the cap rather than truncating it', () => {
    expect(parse({ kind: 'term_input', termId: 'term_abc', data: 'ls\r' })).toEqual({
      kind: 'term_input',
      termId: 'term_abc',
      data: 'ls\r',
    });
    // Truncating would run a DIFFERENT command than the one typed.
    expect(parse({ kind: 'term_input', termId: 'term_abc', data: 'x'.repeat(MAX_TERM_INPUT_CHARS + 1) })).toBeNull();
    expect(parse({ kind: 'term_input', termId: 'term_abc', data: 5 })).toBeNull();
  });

  it('parses set_terminal_access with a real boolean only', () => {
    expect(parse({ kind: 'set_terminal_access', enabled: false })).toEqual({
      kind: 'set_terminal_access',
      enabled: false,
    });
    expect(parse({ kind: 'set_terminal_access', enabled: 'false' })).toBeNull();
  });
});
