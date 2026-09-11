import { describe, expect, it } from 'vitest';
import {
  attachApiKey,
  authorize,
  createRoom,
  getRoom,
  hasApiKey,
  mintRoomId,
  restoreRoom,
} from '../../src/server/rooms.js';
import { MemorySink, attachRoom } from '../../src/server/ws.js';
import type { SynCodeEvent } from '@syncode/protocol/events';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

const STUB_AGENT = {
  runQuery: (() => ({
    async *[Symbol.asyncIterator]() {
      /* never emits */
    },
    interrupt: async () => undefined,
  })) as never,
};

function restored() {
  return restoreRoom({
    id: mintRoomId(),
    token: 'a'.repeat(64),
    cwd: '/work/room_a',
    repoUrl: null,
    createdAt: '2026-07-28T00:00:00.000Z',
    lastSeq: 42,
  });
}

describe('mintRoomId', () => {
  it('lets a caller name a workspace before the room freezes its cwd', () => {
    const id = mintRoomId();
    expect(id).toMatch(/^room_[0-9a-f]{16}$/);
    // The whole point: cwd is readonly and startAgent reads it the moment the
    // room attaches, so the directory has to be known before construction.
    const room = createRoom({ id, apiKey: KEY, cwd: `/work/${id}`, repoUrl: null });
    expect(room.id).toBe(id);
    expect(room.cwd).toBe(`/work/${id}`);
  });

  it('still mints its own id when the caller does not supply one', () => {
    const room = createRoom({ apiKey: KEY, cwd: '/tmp', repoUrl: null });
    expect(room.id).toMatch(/^room_[0-9a-f]{16}$/);
  });
});

describe('restoreRoom', () => {
  it('re-registers the room so its original link still authorizes', () => {
    const room = restored();
    // Without registration a "recovered" room can never be rejoined: the
    // upgrade handler calls authorize(), which only reads the registry.
    expect(getRoom(room.id)).toBe(room);
    expect(authorize(room.id, room.token)).toBe(room);
    expect(authorize(room.id, 'b'.repeat(64))).toBeUndefined();
  });

  it('continues the log’s numbering instead of restarting at zero (I3)', () => {
    const room = restored();
    expect(room.peekSeq()).toBe(42);
    // Restarting at 0 would re-issue sequence numbers that already exist on
    // disk, which silently makes the append-only log non-reconstructible.
    expect(room.nextSeq()).toBe(43);
  });

  it('comes back without an API key, and says so rather than lying (I4)', () => {
    const room = restored();
    expect(hasApiKey(room)).toBe(false);
    expect(() => room.getApiKey()).toThrow();

    attachApiKey(room, KEY);
    expect(hasApiKey(room)).toBe(true);
    expect(room.getApiKey()).toBe(KEY);
  });

  it('does not append a second room_created when the log already has one', () => {
    const room = restored();
    attachApiKey(room, KEY);

    // A room rebuilt from disk arrives with its history already populated.
    const sink = new MemorySink();
    sink.append({
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: room.id,
      type: 'room_created',
      cwd: room.cwd,
      repoUrl: null,
    } as SynCodeEvent);

    attachRoom(room, sink, STUB_AGENT);

    // The log is append-only, so a duplicate could never be removed later (I3).
    expect(sink.read().filter((event) => event.type === 'room_created')).toHaveLength(1);
  });

  it('still records room_created for a genuinely new room', () => {
    const room = createRoom({ apiKey: KEY, cwd: '/tmp', repoUrl: null });
    const sink = new MemorySink();
    attachRoom(room, sink, STUB_AGENT);
    expect(sink.read().filter((event) => event.type === 'room_created')).toHaveLength(1);
  });

  it('never serializes the key or the token', () => {
    const room = restored();
    attachApiKey(room, KEY);
    const serialized = JSON.stringify(room.toJSON());
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain(room.token);
  });
});
