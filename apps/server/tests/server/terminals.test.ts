import { describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { ServerFrame } from '@syncode/protocol/wire';
import {
  MAX_TERMINALS_PER_ROOM,
  SCROLLBACK_CHARS,
  TYPED_QUIET_MS,
  createTerminalRoom,
} from '../../src/server/terminals.js';
import type { PtyFactory, PtyProcess } from '../../src/server/terminals.js';

/** A fake PTY the test drives by hand: what was written, sized, killed. */
interface FakePty extends PtyProcess {
  written: string[];
  sizes: Array<[number, number]>;
  killed: boolean;
  emitData(data: string): void;
  emitExit(exitCode: number | null): void;
  spawnedWith: { cwd: string; cols: number; rows: number };
}

function harness(opts: { now?: () => number } = {}) {
  const ptys: FakePty[] = [];
  const factory: PtyFactory = (spawnedWith) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (exit: { exitCode: number | null }) => void = () => undefined;
    const pty: FakePty = {
      written: [],
      sizes: [],
      killed: false,
      spawnedWith,
      onData: (l) => void (onData = l),
      onExit: (l) => void (onExit = l),
      write: (d) => void pty.written.push(d),
      resize: (c, r) => void pty.sizes.push([c, r]),
      kill: () => {
        pty.killed = true;
      },
      emitData: (d) => onData(d),
      emitExit: (code) => onExit({ exitCode: code }),
    };
    ptys.push(pty);
    return pty;
  };
  const events: UnsequencedEvent[] = [];
  const sent: Array<{ socket: string; frame: ServerFrame }> = [];
  let changes = 0;
  const terminals = createTerminalRoom({
    cwd: '/room',
    factory,
    commit: (event) => void events.push(event),
    send: (socket, frame) => void sent.push({ socket: socket as string, frame }),
    onListChanged: () => void (changes += 1),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  const to = (socket: string) => sent.filter((s) => s.socket === socket).map((s) => s.frame);
  return { terminals, ptys, events, to, changes: () => changes };
}

const ADA = { participantId: 'p_ada', displayName: 'Ada' };
const BOB = { participantId: 'p_bob', displayName: 'Bob' };

const opened = (h: ReturnType<typeof harness>, by = ADA): string => {
  const result = h.terminals.open(by, 100, 30);
  if (!result.ok) throw new Error(result.reason);
  return result.termId;
};

describe('terminal room (phase 19b)', () => {
  it('opens a shell in the room folder at the opener size, logged and listed', () => {
    const h = harness();
    const termId = opened(h);

    expect(h.ptys[0]?.spawnedWith).toEqual({ cwd: '/room', cols: 100, rows: 30 });
    expect(h.events).toEqual([{ type: 'terminal_opened', termId, ...ADA }]);
    expect(h.terminals.list()).toEqual([{ termId, title: 'Terminal 1', openedBy: 'Ada', lastTypedBy: null }]);
    expect(h.changes()).toBe(1);
  });

  it('sends output only to sockets attached to that terminal', () => {
    const h = harness();
    const termId = opened(h);
    h.terminals.attach('sock_a', termId);

    h.ptys[0]?.emitData('hello\r\n');

    expect(h.to('sock_a')).toContainEqual({ kind: 'term_output', termId, data: 'hello\r\n' });
    expect(h.to('sock_b')).toEqual([]);
  });

  it('a late attacher gets the scrollback, capped at the newest SCROLLBACK_CHARS', () => {
    const h = harness();
    const termId = opened(h);
    h.ptys[0]?.emitData('a'.repeat(SCROLLBACK_CHARS));
    h.ptys[0]?.emitData('TAIL');

    h.terminals.attach('sock_late', termId);

    const snapshot = h.to('sock_late').find((f) => f.kind === 'term_snapshot') as { data: string } | undefined;
    expect(snapshot?.data.length).toBe(SCROLLBACK_CHARS);
    expect(snapshot?.data.endsWith('TAIL')).toBe(true);
  });

  it('writes input to the shell; attributes the first keystroke, not every one', () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    const termId = opened(h);

    h.terminals.input(BOB, termId, 'l');
    h.terminals.input(BOB, termId, 's\r');
    expect(h.ptys[0]?.written).toEqual(['l', 's\r']);
    const typed = () => h.events.filter((e) => e.type === 'terminal_typed');
    expect(typed()).toEqual([{ type: 'terminal_typed', termId, ...BOB }]);
    expect(h.terminals.list()[0]?.lastTypedBy).toBe('Bob');

    // Someone else typing is a new attribution.
    h.terminals.input(ADA, termId, 'x');
    expect(typed()).toHaveLength(2);

    // Bob again, after going quiet long enough: a fresh entry.
    clock += TYPED_QUIET_MS + 1;
    h.terminals.input(BOB, termId, 'pwd\r');
    expect(typed()).toHaveLength(3);
  });

  it('never puts keystrokes or output in the log', () => {
    const h = harness();
    const termId = opened(h);
    h.terminals.input(ADA, termId, 'hunter2\r');
    h.ptys[0]?.emitData('SECRET-OUTPUT');
    expect(JSON.stringify(h.events)).not.toContain('hunter2');
    expect(JSON.stringify(h.events)).not.toContain('SECRET-OUTPUT');
  });

  it('whoever types or resizes most recently sets the size', () => {
    const h = harness();
    const termId = opened(h);
    expect(h.terminals.resize(termId, 80, 24)).toBe(true);
    expect(h.ptys[0]?.sizes).toEqual([[80, 24]]);
  });

  it('closing kills the shell and logs who closed it, once', () => {
    const h = harness();
    const termId = opened(h);
    h.terminals.attach('sock_a', termId);

    expect(h.terminals.close(BOB, termId)).toBe(true);
    h.ptys[0]?.emitExit(0); // the kill's own exit must not log a second close

    expect(h.ptys[0]?.killed).toBe(true);
    const closes = h.events.filter((e) => e.type === 'terminal_closed');
    expect(closes).toEqual([
      { type: 'terminal_closed', termId, ...BOB, exitCode: null, reason: 'closed' },
    ]);
    expect(h.terminals.list()).toEqual([]);
  });

  it('a shell that exits on its own is logged as exited and its viewers told', () => {
    const h = harness();
    const termId = opened(h);
    h.terminals.attach('sock_a', termId);

    h.ptys[0]?.emitExit(3);

    expect(h.to('sock_a')).toContainEqual({ kind: 'term_exit', termId, exitCode: 3 });
    expect(h.events.at(-1)).toEqual({
      type: 'terminal_closed',
      termId,
      participantId: null,
      displayName: null,
      exitCode: 3,
      reason: 'exited',
    });
    expect(h.terminals.input(ADA, termId, 'x')).toBe(false);
  });

  it('switching access off closes every terminal and refuses new ones; switching is idempotent', () => {
    const h = harness();
    const first = opened(h);
    opened(h, BOB);

    expect(h.terminals.setEnabled(ADA, false)).toBe(true);
    expect(h.terminals.setEnabled(ADA, false)).toBe(false);

    expect(h.ptys.every((p) => p.killed)).toBe(true);
    expect(h.events.filter((e) => e.type === 'terminal_closed').map((e) => (e as { reason: string }).reason)).toEqual([
      'access_disabled',
      'access_disabled',
    ]);
    expect(h.events.filter((e) => e.type === 'terminal_access_changed')).toEqual([
      { type: 'terminal_access_changed', enabled: false, ...ADA },
    ]);
    expect(h.terminals.open(ADA, 80, 24)).toMatchObject({ ok: false });
    expect(h.terminals.input(ADA, first, 'x')).toBe(false);
  });

  it(`refuses more than ${MAX_TERMINALS_PER_ROOM} terminals in one room`, () => {
    const h = harness();
    for (let i = 0; i < MAX_TERMINALS_PER_ROOM; i += 1) opened(h);
    expect(h.terminals.open(ADA, 80, 24)).toMatchObject({ ok: false });
  });

  it('closeAll kills everything without logging (the process is going away)', () => {
    const h = harness();
    opened(h);
    const before = h.events.length;
    h.terminals.closeAll();
    expect(h.ptys[0]?.killed).toBe(true);
    expect(h.events.length).toBe(before);
  });
});
