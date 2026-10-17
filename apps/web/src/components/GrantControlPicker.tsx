import type { RoomView } from '../store.js';
import { Avatar } from './Avatar.js';

/** A minimal participant picker for `⌘⇧G` — grant control without opening the roster. */
export function GrantControlPicker({
  open,
  participants,
  selfId,
  onGrant,
  onClose,
}: {
  open: boolean;
  participants: RoomView['participants'];
  selfId: string | null;
  onGrant: (participantId: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  if (!open) return null;
  const candidates = participants.filter((p) => p.participantId !== selfId && p.connected);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Grant control"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        className="w-full max-w-sm rounded border border-border bg-surface p-3 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
      >
        <h2 className="mb-2 text-sm font-semibold text-fg">Grant control to…</h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-fg-muted">No one else is here yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {candidates.map((p) => (
              <li key={p.participantId}>
                <button
                  type="button"
                  onClick={() => {
                    onGrant(p.participantId);
                    onClose();
                  }}
                  className="flex min-h-9 w-full items-center gap-2 px-2 text-left text-sm text-fg hover:bg-surface-2 focus-visible:bg-accent-dim focus-visible:outline-none"
                >
                  <Avatar participantId={p.participantId} displayName={p.displayName} size="sm" />
                  {p.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
