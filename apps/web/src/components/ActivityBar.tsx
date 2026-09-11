import type { LucideIcon } from 'lucide-react';

/** The four side-bar views a room can show, one at a time (region B). */
export type SideBarView = 'explorer' | 'fleet' | 'approvals' | 'changes';

export interface ActivityBarItem {
  id: SideBarView;
  /** Accessible name AND tooltip — the rail is icon-only, so this is the
   *  only text a screen reader (or a person hovering) ever gets. */
  label: string;
  Icon: LucideIcon;
  /** Shown as a small numeric badge when greater than zero. Omit (or 0) to
   *  show no badge at all — a badge reading "0" would be noise, not signal. */
  badge?: number;
}

/**
 * Region A: the icon rail. One button per side-bar view, `~48px` wide
 * (`w-12`, matching `LAYOUT.activityBarWidth` in `design/tokens.ts`).
 * Exactly one view is ever active, so this is the same
 * tablist/tab pattern `WorkspacePane`'s own tab row already used —
 * `aria-selected` plus a visible indicator, never colour alone (MASTER.md).
 *
 * Deliberately does not decide WHICH items exist (a solo room omitting
 * "Fleet", say) — that is `App.tsx`'s call, driven by room state. This
 * component only lays out whatever list it is handed.
 */
export function ActivityBar({
  items,
  activeView,
  onSelect,
}: {
  items: ActivityBarItem[];
  activeView: SideBarView | null;
  onSelect: (view: SideBarView) => void;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Side bar views"
      aria-orientation="vertical"
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2"
    >
      {items.map(({ id, label, Icon, badge }) => {
        const isActive = id === activeView;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={label}
            title={label}
            onClick={() => onSelect(id)}
            className={`relative flex h-11 w-11 items-center justify-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
              isActive
                ? 'border-l-2 border-accent bg-surface-2 text-fg'
                : 'border-l-2 border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <Icon size={18} aria-hidden={true} />
            {badge !== undefined && badge > 0 && (
              <span
                aria-label={`${badge} pending in ${label}`}
                className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-on-accent"
              >
                {badge > 99 ? '99+' : badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
