import type { SynCodeEvent } from '@syncode/protocol/events';
import type { PresenceEntry, ServerFrame } from '@syncode/protocol/wire';
import type { Room } from './rooms.js';

/** Transient snapshot. Never logged, never assigned a seq. */
export function presenceFrame(room: Room): ServerFrame {
  return {
    kind: 'presence',
    participants: [...room.participants.values()].map((p) => ({
      participantId: p.id,
      displayName: p.displayName,
      connected: p.connected,
    })),
    driverId: room.driverId,
  };
}

/** Rebuild the roster from a log slice. The log is authoritative (I3). */
export function projectPresence(events: SynCodeEvent[]): {
  participants: PresenceEntry[];
  driverId: string | null;
} {
  const byId = new Map<string, PresenceEntry>();
  let driverId: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'participant_joined':
        byId.set(event.participantId, {
          participantId: event.participantId,
          displayName: event.displayName,
          connected: true,
        });
        break;
      case 'participant_left': {
        const existing = byId.get(event.participantId);
        if (existing !== undefined) existing.connected = false;
        break;
      }
      case 'driver_granted':
        driverId = event.participantId;
        break;
      case 'driver_released':
        if (driverId === event.participantId) driverId = null;
        break;
      default:
        break;
    }
  }

  return { participants: [...byId.values()], driverId };
}
