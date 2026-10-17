import { Hand } from 'lucide-react';
import type { PresenceEntry } from '@syncode/protocol/wire';
import { Avatar } from './Avatar.js';
import type { PendingDriverRequest } from './DriverRequestNotice.js';

export function Roster({
  participants,
  driverId,
  selfId,
  pendingDriverRequests = [],
  onRequestControl,
  onGrantControl,
  onReleaseControl,
}: {
  participants: PresenceEntry[];
  driverId: string | null;
  selfId: string | null;
  /** Derived from the log via `derivePendingDriverRequests` (I3). */
  pendingDriverRequests?: PendingDriverRequest[];
  onRequestControl?: () => void;
  onGrantControl?: (participantId: string) => void;
  onReleaseControl?: () => void;
}): JSX.Element {
  const iAmDriving = driverId !== null && driverId === selfId;
  const pendingByParticipant = new Map(pendingDriverRequests.map((r) => [r.participantId, r]));

  return (
    <div className="flex items-center gap-2">
      <ul className="flex items-center gap-2">
        {participants.map((p) => {
          const isDriver = p.participantId === driverId;
          const isSelf = p.participantId === selfId;
          const pending = pendingByParticipant.get(p.participantId);

          return (
            <li
              key={p.participantId}
              className={`flex min-h-6 items-center gap-1.5 rounded px-1.5 text-xs ${
                p.connected ? 'text-fg' : 'text-fg-muted'
              }`}
              title={p.connected ? p.displayName : `${p.displayName} — disconnected (30s grace period)`}
            >
              <Avatar
                participantId={p.participantId}
                displayName={p.displayName}
                size="sm"
                isDriver={isDriver}
                connected={p.connected}
              />
              <span>{p.displayName}</span>
              {isDriver && (
                <span data-testid={`driver-${p.participantId}`} className="sr-only">
                  driving
                </span>
              )}
              {pending && (
                <span
                  className="inline-flex items-center gap-1 text-fg-muted"
                  title={isSelf ? 'Waiting for control…' : `${p.displayName} is asking for control`}
                >
                  <Hand size={14} strokeWidth={2} aria-hidden="true" />
                  <span className="text-xs">
                    {isSelf ? 'Waiting for control…' : 'Asking to drive'}
                  </span>
                </span>
              )}
              {iAmDriving && !isSelf && p.connected && (
                <button
                  type="button"
                  onClick={() => onGrantControl?.(p.participantId)}
                  className="ml-1 min-h-6 rounded px-1.5 text-xs text-accent-fg underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  give control
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {iAmDriving ? (
        <button
          type="button"
          onClick={onReleaseControl}
          className="min-h-6 rounded border border-border px-2 text-xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Release control
        </button>
      ) : (
        <button
          type="button"
          onClick={onRequestControl}
          className="min-h-6 rounded border border-border px-2 text-xs text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          Request control
        </button>
      )}
    </div>
  );
}
