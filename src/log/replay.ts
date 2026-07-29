import type { NexusEvent } from '../protocol/events.js';
import type { PresenceEntry } from '../protocol/wire.js';
import { projectPresence } from '../server/presence.js';

export interface ReconstructedRoom {
  roomId: string;
  cwd: string;
  repoUrl: string | null;
  lastSeq: number;
  participants: PresenceEntry[];
  driverId: string | null;
  /** Requests that were still open when the log ended. */
  pendingApprovalIds: string[];
}

/**
 * The single reconstruction function. Both the resume path and the restart
 * path call this, so a rejoined view and a recovered view cannot disagree (I3).
 */
export function reconstruct(events: NexusEvent[]): ReconstructedRoom | null {
  const created = events.find(
    (event): event is Extract<NexusEvent, { type: 'room_created' }> => event.type === 'room_created',
  );
  if (created === undefined) return null;

  const open = new Set<string>();
  for (const event of events) {
    if (event.type === 'permission_requested') open.add(event.requestId);
    if (event.type === 'permission_decided') open.delete(event.requestId);
  }

  const { participants, driverId } = projectPresence(events);
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);

  return {
    roomId: created.roomId,
    cwd: created.cwd,
    repoUrl: created.repoUrl,
    lastSeq,
    participants,
    driverId,
    pendingApprovalIds: [...open],
  };
}
