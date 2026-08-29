import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAutoRelease,
  claimIfVacant,
  grantControl,
  isDriver,
  releaseControl,
  requestControl,
  scheduleAutoRelease,
} from '../../src/server/driver.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';

let room: Room;

beforeEach(() => {
  __resetRooms();
  room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
  room.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
  room.participants.set('p_grace', { id: 'p_grace', displayName: 'Grace', connected: true });
});

describe('claimIfVacant', () => {
  it('grants the token when nobody holds it', () => {
    const events = claimIfVacant(room, 'p_ada', 'Ada');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'driver_granted', participantId: 'p_ada' });
    expect(room.driverId).toBe('p_ada');
  });

  it('is a no-op when someone already holds it', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(claimIfVacant(room, 'p_grace', 'Grace')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('isDriver', () => {
  it('is true only for the holder', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(isDriver(room, 'p_ada')).toBe(true);
    expect(isDriver(room, 'p_grace')).toBe(false);
    expect(isDriver(room, 'p_nobody')).toBe(false);
  });
});

describe('grantControl', () => {
  it('moves the token and emits release then grant', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = grantControl(room, 'p_ada', 'p_grace');
    expect(events.map((e) => e.type)).toEqual(['driver_released', 'driver_granted']);
    expect(room.driverId).toBe('p_grace');
  });

  it('refuses when the granter is not the driver', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(grantControl(room, 'p_grace', 'p_grace')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });

  it('refuses to grant to an unknown participant', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(grantControl(room, 'p_ada', 'p_ghost')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('releaseControl', () => {
  it('frees the token', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = releaseControl(room, 'p_ada', 'explicit');
    expect(events[0]).toMatchObject({ type: 'driver_released', reason: 'explicit' });
    expect(room.driverId).toBeNull();
  });

  it('ignores a release from a non-driver', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(releaseControl(room, 'p_grace', 'explicit')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('requestControl', () => {
  it('emits a request without moving the token', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = requestControl(room, 'p_grace', 'Grace');
    expect(events[0]).toMatchObject({ type: 'driver_requested', participantId: 'p_grace' });
    expect(room.driverId).toBe('p_ada');
  });

  it('claims directly when the token is vacant', () => {
    const events = requestControl(room, 'p_grace', 'Grace');
    expect(events.map((e) => e.type)).toEqual(['driver_granted']);
    expect(room.driverId).toBe('p_grace');
  });
});

describe('auto-release on disconnect', () => {
  it('frees the token after the grace period', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    const emitted: unknown[] = [];
    scheduleAutoRelease(room, 'p_ada', (events) => emitted.push(...events), 30_000);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(room.driverId).toBe('p_ada');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.driverId).toBeNull();
    expect(emitted[0]).toMatchObject({ type: 'driver_released', reason: 'disconnect' });
    vi.useRealTimers();
  });

  it('keeps the token when the driver returns inside the window', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    scheduleAutoRelease(room, 'p_ada', () => undefined, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    cancelAutoRelease(room, 'p_ada');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.driverId).toBe('p_ada');
    vi.useRealTimers();
  });

  it('does not release a token that moved on during the grace window', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    scheduleAutoRelease(room, 'p_ada', () => undefined, 30_000);
    grantControl(room, 'p_ada', 'p_grace');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.driverId).toBe('p_grace');
    vi.useRealTimers();
  });
});
