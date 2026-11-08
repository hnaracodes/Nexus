import type { ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { PANEL, clamp } from '../layout/dimensions.js';
import { ResizeHandle } from './ResizeHandle.js';

/** The bottom panel's tabs. */
export type PanelTab = 'output' | 'diff';

const TAB_LABELS: Record<PanelTab, string> = {
  output: 'Output',
  diff: 'Diff',
};

const TAB_ORDER: PanelTab[] = ['output', 'diff'];

/**
 * Region D: the VS Code bottom panel — tabbed (OUTPUT, DIFF), collapsible and
 * resizable by drag. It lives under the editor column only, never under the
 * right-hand aux bar, and it is NOT where approvals live: `⌘J` collapses it, and
 * a governance surface must never be one keystroke from hidden.
 *
 * This is explicitly NOT a terminal — CLAUDE.md §6 forbids a PTY as the agent
 * transport. OUTPUT is the structured tool-call log the room already has.
 *
 * `height`/`onHeightChange` are controlled so a resize survives whatever else
 * re-renders the shell. Collapsed, the header stays (`PANEL.collapsed`), so the
 * control to reopen it is always reachable.
 */
export function Panel({
  open,
  onToggleOpen,
  height,
  onHeightChange,
  activeTab,
  onTabChange,
  children,
}: {
  open: boolean;
  onToggleOpen: () => void;
  height: number;
  onHeightChange: (next: number) => void;
  activeTab: PanelTab;
  onTabChange: (tab: PanelTab) => void;
  /** The active tab's content. */
  children: ReactNode;
}): JSX.Element {
  const ToggleIcon = open ? ChevronDown : ChevronUp;
  const clamped = clamp(height, PANEL.min, PANEL.max);

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border bg-bg"
      style={{ height: open ? clamped : PANEL.collapsed }}
    >
      {open && (
        <ResizeHandle
          label="Resize panel"
          orientation="horizontal"
          value={clamped}
          min={PANEL.min}
          max={PANEL.max}
          invert
          onChange={onHeightChange}
        />
      )}
      <div className="flex h-[35px] shrink-0 items-center gap-1 px-4">
        <div role="tablist" aria-label="Panel views" className="flex h-full items-stretch gap-4">
          {TAB_ORDER.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => onTabChange(tab)}
                className={`border-b px-0 text-[11px] uppercase tracking-wide focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                  isActive
                    ? 'border-b-accent text-fg'
                    : 'border-b-transparent text-fg-muted hover:text-fg'
                }`}
              >
                {TAB_LABELS[tab]}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          title={open ? 'Collapse panel (⌘J)' : 'Expand panel (⌘J)'}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <ToggleIcon size={14} aria-hidden="true" />
        </button>
      </div>
      {open && (
        <div role="tabpanel" aria-label={TAB_LABELS[activeTab]} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {children}
        </div>
      )}
    </div>
  );
}
