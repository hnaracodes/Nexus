import { describe, expect, it } from 'vitest';
import { createTerminalHub } from '../terminalHub.js';

function sink() {
  const writes: Array<{ data: string; reset: boolean }> = [];
  const exits: Array<number | null> = [];
  return {
    writes,
    exits,
    write: (data: string, reset: boolean) => void writes.push({ data, reset }),
    exited: (code: number | null) => void exits.push(code),
  };
}

describe('terminal hub (phase 19b)', () => {
  it('routes a terminal’s output to its own view only, and claims those frames', () => {
    const hub = createTerminalHub();
    const a = sink();
    const b = sink();
    hub.subscribe('term_a', a);
    hub.subscribe('term_b', b);

    expect(hub.handleFrame({ kind: 'term_output', termId: 'term_a', data: 'hi' })).toBe(true);
    expect(a.writes).toEqual([{ data: 'hi', reset: false }]);
    expect(b.writes).toEqual([]);
  });

  it('a snapshot resets the view before writing, so a re-attach never doubles the history', () => {
    const hub = createTerminalHub();
    const a = sink();
    hub.subscribe('term_a', a);
    hub.handleFrame({ kind: 'term_snapshot', termId: 'term_a', data: 'history' });
    expect(a.writes).toEqual([{ data: 'history', reset: true }]);
  });

  it('tells the view when the shell exits, and stops after unsubscribe', () => {
    const hub = createTerminalHub();
    const a = sink();
    const unsubscribe = hub.subscribe('term_a', a);
    hub.handleFrame({ kind: 'term_exit', termId: 'term_a', exitCode: 0 });
    expect(a.exits).toEqual([0]);

    unsubscribe();
    hub.handleFrame({ kind: 'term_output', termId: 'term_a', data: 'late' });
    expect(a.writes).toEqual([]);
  });

  it('leaves every other frame for the room reducer', () => {
    const hub = createTerminalHub();
    expect(hub.handleFrame({ kind: 'presence', participants: [], driverId: null })).toBe(false);
    expect(hub.handleFrame({ kind: 'terminals', enabled: true, canManage: false, list: [] })).toBe(false);
  });
});
