import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openLog } from '../../src/log/event-log.js';
import { readRoomMetas, recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';
import { __resetRooms, authorize, getRoom } from '../../src/server/rooms.js';
import type { NexusEvent } from '../../src/protocol/events.js';

const TOKEN = 'a'.repeat(64);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-recover-'));
  __resetRooms();
});

function seed(roomId: string): void {
  writeRoomMeta(
    {
      roomId,
      token: TOKEN,
      cwd: '/work',
      repoUrl: null,
      createdAt: '2026-07-28T00:00:00.000Z',
    },
    dir,
  );
  const log = openLog(roomId, dir);
  log.append({
    seq: 1,
    ts: '2026-07-28T00:00:00.000Z',
    roomId,
    type: 'room_created',
    cwd: '/work',
    repoUrl: null,
  } as NexusEvent);
  log.append({
    seq: 2,
    ts: '2026-07-28T00:00:01.000Z',
    roomId,
    type: 'participant_joined',
    participantId: 'p_ada',
    displayName: 'Ada',
  } as NexusEvent);
}

describe('recovery', () => {
  it('rebuilds rooms from disk with their last sequence number', () => {
    seed('room_a');
    const recovered = recoverRooms(dir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ roomId: 'room_a', lastSeq: 2, needsApiKey: true });
  });

  it('never persists an API key (I4)', () => {
    seed('room_a');
    const raw = readFileSync(join(dir, 'rooms', 'room_a.meta.json'), 'utf8');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-ant');
    expect(Object.keys(readRoomMetas(dir)[0] ?? {})).not.toContain('apiKey');
  });

  it('returns nothing when the data directory is empty', () => {
    expect(recoverRooms(dir)).toEqual([]);
  });

  it('actually re-registers the room so its original link still works, at the log’s last seq', () => {
    seed('room_a');
    recoverRooms(dir);

    // authorize() is the only thing the WS upgrade handler calls to accept a
    // room link. If recoverRooms() only wrote metadata and never called
    // restoreRoom, the live registry would still be empty here and this
    // would return undefined forever — a "recovered" room nobody can rejoin.
    const room = authorize('room_a', TOKEN);
    expect(room).toBeTruthy();

    // The sequence counter must resume from the log, not restart at 0 — an
    // in-memory counter that starts at 0 while the log already has events up
    // to seq 2 would re-issue sequence numbers that already exist on disk,
    // breaking I3.
    expect(getRoom('room_a')?.peekSeq()).toBe(2);
  });
});
