import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetAllRooms,
  forgetRoom,
  readRecentRooms,
  rememberRoom,
} from '../../rooms.js';
import type { RecentRoom } from '../../rooms.js';

function room(overrides: Partial<RecentRoom> = {}): RecentRoom {
  return {
    roomId: 'room_a',
    token: 'tok_a',
    displayName: 'Ada',
    label: 'nexus',
    lastSeenAt: 1_000,
    ...overrides,
  };
}

describe('rooms', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a remembered room', () => {
    rememberRoom(room());
    expect(readRecentRooms()).toEqual([room()]);
  });

  it('upserts by roomId rather than duplicating', () => {
    rememberRoom(room({ lastSeenAt: 1_000 }));
    rememberRoom(room({ lastSeenAt: 2_000, displayName: 'Ada2' }));
    const rooms = readRecentRooms();
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.displayName).toBe('Ada2');
  });

  it('orders newest-first by lastSeenAt', () => {
    rememberRoom(room({ roomId: 'room_a', lastSeenAt: 1_000 }));
    rememberRoom(room({ roomId: 'room_b', lastSeenAt: 3_000 }));
    rememberRoom(room({ roomId: 'room_c', lastSeenAt: 2_000 }));
    expect(readRecentRooms().map((r) => r.roomId)).toEqual(['room_b', 'room_c', 'room_a']);
  });

  it('caps at 10 rooms and evicts the oldest', () => {
    for (let i = 0; i < 12; i++) {
      rememberRoom(room({ roomId: `room_${i}`, lastSeenAt: i }));
    }
    const rooms = readRecentRooms();
    expect(rooms).toHaveLength(10);
    const ids = rooms.map((r) => r.roomId);
    expect(ids).not.toContain('room_0');
    expect(ids).not.toContain('room_1');
    expect(rooms[0]?.roomId).toBe('room_11');
  });

  it('forgetRoom removes one entry and leaves the rest', () => {
    rememberRoom(room({ roomId: 'room_a' }));
    rememberRoom(room({ roomId: 'room_b' }));
    forgetRoom('room_a');
    expect(readRecentRooms().map((r) => r.roomId)).toEqual(['room_b']);
  });

  it('forgetAllRooms clears every stored room', () => {
    rememberRoom(room({ roomId: 'room_a' }));
    rememberRoom(room({ roomId: 'room_b' }));
    forgetAllRooms();
    expect(readRecentRooms()).toEqual([]);
  });

  it('treats corrupt JSON as no history rather than throwing', () => {
    localStorage.setItem('nexus:rooms', '{not json');
    expect(() => readRecentRooms()).not.toThrow();
    expect(readRecentRooms()).toEqual([]);
  });

  it('degrades to no history when localStorage.getItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => readRecentRooms()).not.toThrow();
    expect(readRecentRooms()).toEqual([]);
    spy.mockRestore();
  });

  it('does not throw when localStorage.setItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => rememberRoom(room())).not.toThrow();
    spy.mockRestore();
  });
});
