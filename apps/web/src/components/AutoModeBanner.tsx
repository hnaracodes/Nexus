import { Zap } from 'lucide-react';
import type { AutoModeState } from '../derive/autoMode.js';

export interface AutoModeBannerProps {
  autoMode: AutoModeState | null;
  onTurnOff: () => void;
}

/**
 * The room-wide notice that auto mode is on (phase 19a). Deliberately a
 * persistent banner, not a toast: while it is on, nothing an agent does waits
 * for a vote, and everyone in the room — not just whoever flipped the switch —
 * has to be able to see that at a glance and undo it in one click. Anyone may
 * turn it off, the same as anyone may turn it on.
 */
export function AutoModeBanner({ autoMode, onTurnOff }: AutoModeBannerProps): JSX.Element | null {
  if (autoMode === null) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-accent/40 bg-accent/10 px-3 py-1 text-xs text-fg"
    >
      <Zap size={14} className="shrink-0 text-accent-fg" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Auto mode is on</span>
        <span className="text-fg-muted">
          {' '}
          · agent edits and commands run without a vote · turned on by {autoMode.displayName}
        </span>
      </span>
      <button
        type="button"
        onClick={onTurnOff}
        className="min-h-6 shrink-0 rounded border border-border px-2 text-xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        Turn off
      </button>
    </div>
  );
}
