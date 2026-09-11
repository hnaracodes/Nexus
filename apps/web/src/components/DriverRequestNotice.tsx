import { Hand } from 'lucide-react';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { Avatar } from './Avatar.js';

export interface PendingDriverRequest {
  participantId: string;
  displayName: string;
  seq: number;
}

/**
 * Derived from the log alone (I3). A request is pending when a
 * `driver_requested` for a participant has no later `driver_granted` (to
 * anyone) and no later `driver_released`. A grant to a *different*
 * participant also clears it — the question was answered, just not in their
 * favour. Two requests from the same participant collapse to one (the most
 * recent), ordered by seq.
 */
export function derivePendingDriverRequests(events: SynCodeEvent[]): PendingDriverRequest[] {
  const pending = new Map<string, PendingDriverRequest>();

  for (const event of events) {
    if (event.type === 'driver_requested') {
      pending.set(event.participantId, {
        participantId: event.participantId,
        displayName: event.displayName,
        seq: event.seq,
      });
    } else if (event.type === 'driver_granted' || event.type === 'driver_released') {
      // Any grant or release answers every outstanding request, not just the
      // one for the participant it names — the question of who drives next
      // has been settled either way.
      pending.clear();
    }
  }

  return [...pending.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Renders only the actionable card for the current driver. Everyone else's
 * view — the quiet `Hand` icon on the requester's roster row, and "Waiting
 * for control…" on the requester's own row — is rendered inline by
 * `Roster.tsx`, driven from the same `derivePendingDriverRequests` output.
 */
export function DriverRequestNotice({
  events,
  selfId,
  driverId,
  onGrant,
  onDismiss,
  dismissedParticipantIds = new Set(),
}: {
  events: SynCodeEvent[];
  selfId: string | null;
  driverId: string | null;
  onGrant: (participantId: string) => void;
  onDismiss: (participantId: string) => void;
  /** Local-only UI state (never logged) — which requests this viewer dismissed. */
  dismissedParticipantIds?: Set<string>;
}): JSX.Element | null {
  const iAmDriving = driverId !== null && driverId === selfId;
  if (!iAmDriving) return null;

  const requests = derivePendingDriverRequests(events).filter(
    (r) => r.participantId !== selfId && !dismissedParticipantIds.has(r.participantId),
  );
  if (requests.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {requests.map((request) => (
        <div
          key={request.participantId}
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg border border-warn bg-surface p-3 text-sm text-fg"
        >
          <Avatar participantId={request.participantId} displayName={request.displayName} size="sm" />
          <Hand size={16} strokeWidth={2} className="text-warn" aria-hidden="true" />
          <span className="flex-1">
            <strong>{request.displayName}</strong> wants to drive
          </span>
          <button
            type="button"
            onClick={() => onGrant(request.participantId)}
            className="min-h-11 rounded bg-accent px-3 py-2 text-xs font-medium text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Grant control
          </button>
          <button
            type="button"
            onClick={() => onDismiss(request.participantId)}
            className="min-h-11 rounded border border-border px-3 py-2 text-xs text-fg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
