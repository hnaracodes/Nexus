import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';

export const GRACE_MS = 30_000;

/** Grace timers, keyed per room so the module holds no global mutable state. */
const timers = new WeakMap<Room, Map<string, ReturnType<typeof setTimeout>>>();

function timersFor(room: Room): Map<string, ReturnType<typeof setTimeout>> {
  const existing = timers.get(room);
  if (existing !== undefined) return existing;
  const created = new Map<string, ReturnType<typeof setTimeout>>();
  timers.set(room, created);
  return created;
}

export function isDriver(room: Room, participantId: string): boolean {
  return room.driverId !== null && room.driverId === participantId;
}

export function claimIfVacant(
  room: Room,
  participantId: string,
  displayName: string,
): UnsequencedEvent[] {
  if (room.driverId !== null) return [];
  room.driverId = participantId;
  return [{ type: 'driver_granted', participantId, displayName, reason: 'claimed' }];
}

export function requestControl(
  room: Room,
  participantId: string,
  displayName: string,
): UnsequencedEvent[] {
  if (room.driverId === null) {
    room.driverId = participantId;
    return [{ type: 'driver_granted', participantId, displayName, reason: 'claimed' }];
  }
  return [{ type: 'driver_requested', participantId, displayName }];
}

export function grantControl(room: Room, fromId: string, toId: string): UnsequencedEvent[] {
  if (!isDriver(room, fromId)) return [];
  const from = room.participants.get(fromId);
  const to = room.participants.get(toId);
  if (from === undefined || to === undefined) return [];

  room.driverId = toId;
  return [
    {
      type: 'driver_released',
      participantId: fromId,
      displayName: from.displayName,
      reason: 'granted_away',
    },
    { type: 'driver_granted', participantId: toId, displayName: to.displayName, reason: 'granted' },
  ];
}

export function releaseControl(
  room: Room,
  participantId: string,
  reason: string,
): UnsequencedEvent[] {
  if (!isDriver(room, participantId)) return [];
  const participant = room.participants.get(participantId);
  room.driverId = null;
  return [
    {
      type: 'driver_released',
      participantId,
      displayName: participant?.displayName ?? participantId,
      reason,
    },
  ];
}

/**
 * Free the token if the driver has not reconnected within the grace period.
 * Without this, one closed laptop bricks the room for everyone else.
 */
export function scheduleAutoRelease(
  room: Room,
  participantId: string,
  emit: (events: UnsequencedEvent[]) => void,
  delayMs: number = GRACE_MS,
): void {
  cancelAutoRelease(room, participantId);
  const timer = setTimeout(() => {
    timersFor(room).delete(participantId);
    // The token may have moved on while we waited — check before releasing.
    if (!isDriver(room, participantId)) return;
    emit(releaseControl(room, participantId, 'disconnect'));
  }, delayMs);
  timersFor(room).set(participantId, timer);
}

export function cancelAutoRelease(room: Room, participantId: string): void {
  const map = timersFor(room);
  const timer = map.get(participantId);
  if (timer === undefined) return;
  clearTimeout(timer);
  map.delete(participantId);
}
