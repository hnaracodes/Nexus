import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { Room } from './rooms.js';
import { readEnv } from './env.js';

export const GRACE_MS = 30_000;

/**
 * Read at call time, not at module load, so a test can shorten the window and
 * actually observe the timer firing. Without that, a test can only assert the
 * token is still held *immediately* after a reconnect — which stays true even
 * if the cancel is broken, because the timer has not fired yet.
 */
function graceMs(): number {
  const configured = Number(readEnv('DRIVER_GRACE_MS'));
  return Number.isFinite(configured) && configured > 0 ? configured : GRACE_MS;
}

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
  // Participants are never removed from the roster, only marked disconnected,
  // so a long-departed id stays a valid grant target forever. Handing them the
  // token wedges the seat permanently: the auto-release timer is only ever
  // armed by that participant's own socket closing, which already happened, so
  // nothing frees it and every prompt from anyone is rejected with "You are
  // not driving."
  if (!to.connected) return [];

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
  delayMs: number = graceMs(),
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
