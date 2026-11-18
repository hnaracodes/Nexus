import { useEffect, useRef, useState } from 'react';
import { Plus, TerminalSquare, X } from 'lucide-react';
import type { ClientFrame } from '@syncode/protocol/wire';
import type { RoomView } from '../store.js';
import type { TerminalHub } from './terminalHub.js';
import { XtermView } from './XtermView.js';

/**
 * The TERMINAL tab of the bottom panel (phase 19b). Only shown in a room this
 * server can run terminals for — a desktop-hosted room.
 *
 * Every terminal here is SHARED: anyone in the room sees it and anyone can type
 * into it, by the user's decision. Nothing about that is softened in the UI —
 * the tab strip says who typed last, and the host's switch is right here.
 */
export function TerminalPanel({
  terminals,
  hub,
  send,
}: {
  terminals: RoomView['terminals'];
  hub: TerminalHub;
  send: (frame: ClientFrame) => void;
}): JSX.Element {
  const { enabled, canManage, list } = terminals;
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Set when THIS client opened one, so the new tab is selected when it lands. */
  const awaitingOpen = useRef(list.length);

  useEffect(() => {
    if (list.length > awaitingOpen.current) {
      setActiveId(list.at(-1)?.termId ?? null);
    }
    awaitingOpen.current = list.length;
  }, [list]);

  const active = list.find((t) => t.termId === activeId) ?? list[0] ?? null;

  const open = (): void => {
    awaitingOpen.current = list.length; // the effect above selects what lands
    send({ kind: 'term_open', cols: 80, rows: 24 }); // XtermView fits it on attach
  };

  const hostSwitch = canManage ? (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Allow terminals"
      title={
        enabled
          ? 'Everyone in this room can open terminals and run commands on this computer. Click to turn off (closes every terminal).'
          : 'Terminals are off for this room. Click to allow them.'
      }
      onClick={() => send({ kind: 'set_terminal_access', enabled: !enabled })}
      className={`ml-auto flex h-6 shrink-0 items-center rounded border px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
        enabled ? 'border-border text-fg-muted hover:text-fg' : 'border-accent text-fg'
      }`}
    >
      {enabled ? 'Terminals: on' : 'Terminals: off'}
    </button>
  ) : null;

  if (!enabled) {
    return (
      <div className="flex h-full items-start gap-3 p-3 text-xs text-fg-muted">
        <p>The host has switched terminals off for this room.</p>
        {hostSwitch}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {list.map((t) => {
            const isActive = t.termId === active?.termId;
            return (
              <span
                key={t.termId}
                className={`flex h-6 shrink-0 items-center rounded text-xs ${isActive ? 'bg-surface-2 text-fg' : 'text-fg-muted hover:text-fg'}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  title={`Opened by ${t.openedBy}`}
                  onClick={() => setActiveId(t.termId)}
                  className="flex h-6 items-center gap-1 pl-2 pr-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  <TerminalSquare size={12} aria-hidden="true" />
                  {t.title}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${t.title}`}
                  onClick={() => send({ kind: 'term_close', termId: t.termId })}
                  className="flex h-6 w-5 items-center justify-center rounded hover:bg-surface focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
        <button
          type="button"
          onClick={open}
          aria-label="New terminal"
          title="New terminal (everyone in the room can see and type in it)"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Plus size={14} aria-hidden="true" />
        </button>
        {active?.lastTypedBy != null && (
          <span className="shrink-0 truncate pl-2 text-xs text-fg-muted">last typed by {active.lastTypedBy}</span>
        )}
        {hostSwitch}
      </div>
      {active === null ? (
        <div className="flex flex-1 items-center justify-center p-3 text-xs text-fg-muted">
          <p>No terminals open. Use + to open one. Everyone in the room will see it and can type in it.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <XtermView key={active.termId} termId={active.termId} hub={hub} send={send} />
        </div>
      )}
    </div>
  );
}
