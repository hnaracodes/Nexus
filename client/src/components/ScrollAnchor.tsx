import { ArrowDown } from 'lucide-react';

/**
 * The "Jump to latest" pill. Purely presentational — `MessageList` owns the
 * scroll-position tracking and decides when `newCount` is non-zero. Rendering
 * nothing when there is nothing new keeps this component silent rather than
 * an empty pill sitting in the layout.
 */
export function ScrollAnchor({
  newCount,
  onJump,
}: {
  newCount: number;
  onJump: () => void;
}): JSX.Element | null {
  if (newCount <= 0) return null;

  return (
    <div className="pointer-events-none sticky bottom-2 flex justify-center">
      <button
        type="button"
        onClick={onJump}
        className="pointer-events-auto flex min-h-[44px] items-center gap-2 rounded-full border border-accent bg-surface-2 px-4 py-2 text-sm font-medium text-fg shadow-[0_8px_24px_rgb(0_0_0_/_0.4)] focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <ArrowDown size={16} aria-hidden="true" />
        Jump to latest{newCount > 1 ? ` (${newCount})` : ''}
      </button>
    </div>
  );
}
