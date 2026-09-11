import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react';
import { LAYOUT } from '../design/tokens.js';
import type { AgentStatus } from '../agentStatus.js';
import { AgentActivity } from './AgentActivity.js';

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/**
 * Region D: the bottom panel, collapsible and resizable by drag. Holds the
 * agent transcript — `MessageList`, `PromptDock`, and everything around them
 * that used to sit in the 44%-width chat column (`App.tsx` composes the
 * actual content as `children`; this component owns only the chrome).
 *
 * This is explicitly NOT a terminal — CLAUDE.md §6 forbids a PTY as the
 * agent transport, and nothing about a resizable pane changes that; what
 * lives inside is the same structured event transcript the room always had.
 *
 * `height`/`onHeightChange` are controlled, like `FleetPane`'s
 * `focusedAgentId` — the caller (`App.tsx`) persists it across renders so a
 * resize survives whatever else re-renders the shell.
 */
export function Panel({
  open,
  onToggleOpen,
  height,
  onHeightChange,
  agentStatus,
  now,
  children,
}: {
  open: boolean;
  onToggleOpen: () => void;
  height: number;
  onHeightChange: (next: number) => void;
  agentStatus: AgentStatus;
  now: number;
  children: ReactNode;
}): JSX.Element {
  const dragState = useRef<{ startY: number; startHeight: number } | null>(null);

  // Attached to `window`, not the handle itself — a real drag routinely
  // carries the pointer off the 6px-tall handle strip, and a listener scoped
  // to the handle would stop tracking the moment that happens.
  useEffect(() => {
    function onMouseMove(event: MouseEvent): void {
      const drag = dragState.current;
      if (drag === null) return;
      const delta = drag.startY - event.clientY; // dragging UP grows the panel
      onHeightChange(clamp(drag.startHeight + delta, LAYOUT.panelMinHeight, LAYOUT.panelMaxHeight));
    }
    function onMouseUp(): void {
      dragState.current = null;
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startDrag(event: React.MouseEvent): void {
    if (!open) return;
    dragState.current = { startY: event.clientY, startHeight: height };
  }

  const ToggleIcon = open ? ChevronDown : ChevronUp;

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border bg-surface"
      style={{ height: open ? clamp(height, LAYOUT.panelMinHeight, LAYOUT.panelMaxHeight) : LAYOUT.panelCollapsedHeight }}
    >
      {open && (
        <div
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
          className="flex h-1.5 shrink-0 cursor-row-resize items-center justify-center hover:bg-surface-2"
        >
          <GripHorizontal size={12} className="text-fg-muted" aria-hidden="true" />
        </div>
      )}
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Transcript</span>
        <AgentActivity status={agentStatus} now={now} />
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          title={open ? 'Collapse panel (⌘J)' : 'Expand panel (⌘J)'}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ToggleIcon size={14} aria-hidden="true" />
        </button>
      </div>
      {open && <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">{children}</div>}
    </div>
  );
}
