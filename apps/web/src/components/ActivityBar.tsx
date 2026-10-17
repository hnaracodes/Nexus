import type { LucideIcon } from 'lucide-react';

/** The side-bar views of the LEFT bar (region B): everything about files. */
export type SideBarView = 'explorer' | 'search' | 'changes';

export interface ActivityBarItem<Id extends string = SideBarView> {
  id: Id;
  /** Accessible name AND tooltip — the rail is icon-only, so this is the
   *  only text a screen reader (or a person hovering) ever gets. */
  label: string;
  Icon: LucideIcon;
  /** Shown as a small numeric badge when greater than zero. Omit (or 0) to
   *  show no badge at all — a badge reading "0" would be noise, not signal. */
  badge?: number;
}

/**
 * A button on the bar that is NOT a view: it does something (the right bar's
 * "Agents" opens an editor tab) and reflects state with `aria-pressed`, never
 * `aria-selected`, so it can never be mistaken for the view switcher.
 */
export interface ActivityBarAction {
  id: string;
  label: string;
  Icon: LucideIcon;
  active: boolean;
  onClick: () => void;
}

/**
 * The 48px icon rail — VS Code's activity bar. `side="left"` is the primary
 * bar (files), `side="right"` the secondary one (agents); only the active
 * indicator edge and the accessible name differ. Exactly one view is ever
 * active, so this is a tablist: `aria-selected` plus a visible indicator,
 * never colour alone.
 *
 * Deliberately does not decide WHICH items exist — `App.tsx` does, from room
 * state. The badge stays visible even when the region it belongs to is
 * collapsed, because the rail is never collapsed.
 */
export function ActivityBar<Id extends string = SideBarView>({
  items,
  activeView,
  onSelect,
  side = 'left',
  ariaLabel,
  actions = [],
}: {
  items: ActivityBarItem<Id>[];
  activeView: Id | null;
  onSelect: (view: Id) => void;
  side?: 'left' | 'right';
  ariaLabel?: string;
  actions?: ActivityBarAction[];
}): JSX.Element {
  const edge = side === 'left' ? 'border-l-2' : 'border-r-2';
  const outerEdge = side === 'left' ? 'border-r' : 'border-l';

  function buttonClass(isActive: boolean): string {
    return `relative flex h-12 w-12 items-center justify-center ${edge} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
      isActive
        ? 'border-fg bg-transparent text-activity-fg-active'
        : 'border-transparent text-activity-fg hover:text-activity-fg-active'
    }`;
  }

  return (
    <div
      data-side={side}
      className={`flex w-12 shrink-0 flex-col items-center justify-between ${outerEdge} border-border bg-activity`}
    >
      <div
        role="tablist"
        aria-label={ariaLabel ?? (side === 'left' ? 'Side bar views' : 'Agent bar views')}
        aria-orientation="vertical"
        className="flex flex-col items-center"
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
              className={buttonClass(isActive)}
            >
              <Icon size={24} strokeWidth={1.5} aria-hidden={true} />
              {badge !== undefined && badge > 0 && (
                <span
                  aria-label={`${badge} pending in ${label}`}
                  className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-on-accent"
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {actions.length > 0 && (
        <div role="group" aria-label="Actions" className="flex flex-col items-center">
          {actions.map(({ id, label, Icon, active, onClick }) => (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              aria-label={label}
              title={label}
              onClick={onClick}
              className={buttonClass(active)}
            >
              <Icon size={24} strokeWidth={1.5} aria-hidden={true} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
