/**
 * Phase 19b — the shared terminal, per room. Read docs/plans/phase-19b-terminal.md.
 *
 * WHAT THIS IS NOT: the agent's transport. CLAUDE.md §6 is explicit that a
 * terminal, if one ever exists, is a separate stream for HUMAN shell use and
 * must never become how the agent works. Nothing here is reachable from an
 * agent runtime, and no agent tool writes to a terminal.
 *
 * WHERE IT EXISTS: only where something hands this module a `PtyFactory`.
 * The desktop shell does (it bundles node-pty); the hosted server never does,
 * so on the public site a terminal cannot be opened even by misconfiguration.
 * That is a property of construction, not of a flag someone could flip: a
 * shell on the hosted machine would reach every room's files and, through
 * /proc/<pid>/environ, the deployment's GitHub App key (CLAUDE.md §11).
 *
 * WHAT IS LOGGED: who opened, typed in, and closed which terminal — never the
 * keystrokes and never the output. A keystroke can be a password typed at a
 * prompt; output is a firehose, exactly like `doc_sync`, and can echo secrets.
 *
 * The sandbox does NOT apply here and cannot: a shell can reach anything the
 * host's account can. That is what "anyone in the room can type" means, and
 * the desktop's LAN-share consent text says so to the host in plain words.
 */
import { randomUUID } from 'node:crypto';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { ServerFrame, TerminalEntry } from '@syncode/protocol/wire';

/** The slice of a PTY this module uses. node-pty's IPty satisfies it. */
export interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { exitCode: number | null }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/**
 * Spawns the host's shell. Supplied by the desktop shell; absent on a hosted
 * server, which is what makes terminals desktop-only by construction.
 */
export type PtyFactory = (options: { cwd: string; cols: number; rows: number }) => PtyProcess;

export interface TerminalPeer {
  participantId: string;
  displayName: string;
}

/** Recent output kept per terminal for a late attacher. */
export const SCROLLBACK_CHARS = 256 * 1024;
/** A person's typing is attributed again only after this much quiet. */
export const TYPED_QUIET_MS = 60_000;
export const MAX_TERMINALS_PER_ROOM = 8;

export interface TerminalRoomDeps {
  cwd: string;
  factory: PtyFactory;
  /** Append to the room's log (and broadcast it). */
  commit(event: UnsequencedEvent): void;
  /** Send one frame to one socket. Sockets are opaque here. */
  send(socket: unknown, frame: ServerFrame): void;
  /** The list or the access switch changed; the caller re-sends `terminals`. */
  onListChanged(): void;
  now?: () => number;
}

export interface TerminalRoom {
  readonly enabled: boolean;
  open(by: TerminalPeer, cols: number, rows: number): { ok: true; termId: string } | { ok: false; reason: string };
  attach(socket: unknown, termId: string): boolean;
  detachSocket(socket: unknown): void;
  input(by: TerminalPeer, termId: string, data: string): boolean;
  resize(termId: string, cols: number, rows: number): boolean;
  close(by: TerminalPeer, termId: string): boolean;
  /** Returns whether anything changed. Switching off closes every terminal. */
  setEnabled(by: TerminalPeer, enabled: boolean): boolean;
  list(): TerminalEntry[];
  /** Kill every shell without logging — the process itself is going away. */
  closeAll(): void;
}

interface Terminal {
  termId: string;
  title: string;
  openedBy: string;
  pty: PtyProcess;
  scrollback: string;
  subscribers: Set<unknown>;
  lastTypedBy: string | null;
  /** participantId -> when they last typed, for attribution throttling. */
  lastTypedAt: Map<string, number>;
}

export function createTerminalRoom(deps: TerminalRoomDeps): TerminalRoom {
  const now = deps.now ?? Date.now;
  const terminals = new Map<string, Terminal>();
  let enabled = true;
  let opened = 0;

  function entry(termId: string): Terminal | undefined {
    return enabled ? terminals.get(termId) : undefined;
  }

  /** Remove first, then kill: a kill's own exit callback must find nothing to log. */
  function remove(terminal: Terminal, exitCode: number | null): void {
    terminals.delete(terminal.termId);
    for (const socket of terminal.subscribers) {
      deps.send(socket, { kind: 'term_exit', termId: terminal.termId, exitCode });
    }
  }

  function closeWithLog(terminal: Terminal, by: TerminalPeer | null, reason: 'closed' | 'access_disabled'): void {
    remove(terminal, null);
    terminal.pty.kill();
    deps.commit({
      type: 'terminal_closed',
      termId: terminal.termId,
      participantId: by?.participantId ?? null,
      displayName: by?.displayName ?? null,
      exitCode: null,
      reason,
    });
  }

  return {
    get enabled() {
      return enabled;
    },

    open(by, cols, rows) {
      if (!enabled) return { ok: false, reason: 'The host has switched terminals off for this room.' };
      if (terminals.size >= MAX_TERMINALS_PER_ROOM) {
        return { ok: false, reason: `A room can have at most ${MAX_TERMINALS_PER_ROOM} terminals open.` };
      }
      const termId = `term_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const pty = deps.factory({ cwd: deps.cwd, cols, rows });
      opened += 1;
      const terminal: Terminal = {
        termId,
        title: `Terminal ${opened}`,
        openedBy: by.displayName,
        pty,
        scrollback: '',
        subscribers: new Set(),
        lastTypedBy: null,
        lastTypedAt: new Map(),
      };
      terminals.set(termId, terminal);

      pty.onData((data) => {
        if (terminals.get(termId) !== terminal) return;
        const next = terminal.scrollback + data;
        terminal.scrollback = next.length > SCROLLBACK_CHARS ? next.slice(-SCROLLBACK_CHARS) : next;
        for (const socket of terminal.subscribers) deps.send(socket, { kind: 'term_output', termId, data });
      });
      pty.onExit(({ exitCode }) => {
        // Already removed means someone closed it (or access went off) and
        // that close is already on the record.
        if (terminals.get(termId) !== terminal) return;
        remove(terminal, exitCode);
        deps.commit({
          type: 'terminal_closed',
          termId,
          participantId: null,
          displayName: null,
          exitCode,
          reason: 'exited',
        });
        deps.onListChanged();
      });

      deps.commit({ type: 'terminal_opened', termId, participantId: by.participantId, displayName: by.displayName });
      deps.onListChanged();
      return { ok: true, termId };
    },

    attach(socket, termId) {
      const terminal = entry(termId);
      if (terminal === undefined) return false;
      terminal.subscribers.add(socket);
      deps.send(socket, { kind: 'term_snapshot', termId, data: terminal.scrollback });
      return true;
    },

    detachSocket(socket) {
      for (const terminal of terminals.values()) terminal.subscribers.delete(socket);
    },

    input(by, termId, data) {
      const terminal = entry(termId);
      if (terminal === undefined) return false;
      terminal.pty.write(data);

      const at = now();
      const last = terminal.lastTypedAt.get(by.participantId);
      terminal.lastTypedAt.set(by.participantId, at);
      if (last === undefined || at - last > TYPED_QUIET_MS) {
        deps.commit({ type: 'terminal_typed', termId, participantId: by.participantId, displayName: by.displayName });
      }
      if (terminal.lastTypedBy !== by.displayName) {
        terminal.lastTypedBy = by.displayName;
        deps.onListChanged();
      }
      return true;
    },

    resize(termId, cols, rows) {
      const terminal = entry(termId);
      if (terminal === undefined) return false;
      terminal.pty.resize(cols, rows);
      return true;
    },

    close(by, termId) {
      const terminal = entry(termId);
      if (terminal === undefined) return false;
      closeWithLog(terminal, by, 'closed');
      deps.onListChanged();
      return true;
    },

    setEnabled(by, next) {
      if (next === enabled) return false;
      enabled = next;
      // Cause before effect in the log: the switch, then what it closed.
      deps.commit({ type: 'terminal_access_changed', enabled: next, ...by });
      if (!next) {
        for (const terminal of [...terminals.values()]) closeWithLog(terminal, null, 'access_disabled');
      }
      deps.onListChanged();
      return true;
    },

    list() {
      return [...terminals.values()].map((t) => ({
        termId: t.termId,
        title: t.title,
        openedBy: t.openedBy,
        lastTypedBy: t.lastTypedBy,
      }));
    },

    closeAll() {
      for (const terminal of [...terminals.values()]) {
        terminals.delete(terminal.termId);
        terminal.pty.kill();
      }
    },
  };
}
