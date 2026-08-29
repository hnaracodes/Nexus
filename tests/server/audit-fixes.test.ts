import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom, hasApiKey, mintRoomId, restoreRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import { grantControl } from '../../src/server/driver.js';
import { validateRepoUrl } from '../../src/server/create.js';
import { recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';
import { openLog } from '../../src/log/event-log.js';
import { reconstruct } from '../../src/log/replay.js';
import type { NexusEvent } from '@nexus/protocol/events';
import type { Room } from '../../src/server/rooms.js';

/**
 * Regressions found by the post-merge Phase 3 audit. Each of these shipped
 * green: the suite passed, typecheck passed, and the live acceptance run
 * passed, because none of them exercised the path in question.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

let port = 0;
let started: ReturnType<typeof createServer>;

beforeAll(async () => {
  started = createServer();
  await new Promise<void>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => {
      port = (started.server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
});

const STUB_AGENT = {
  runQuery: (() => ({
    async *[Symbol.asyncIterator]() {
      /* never emits */
    },
    interrupt: async () => undefined,
  })) as never,
};

describe('re-entry endpoint requires the room token', () => {
  function keylessRoom(): Room {
    return restoreRoom({
      id: mintRoomId(),
      token: 'd'.repeat(64),
      cwd: process.cwd(),
      repoUrl: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastSeq: 3,
    });
  }

  const postKey = (room: Room, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ apiKey: KEY }),
    });

  it('rejects a caller who knows only the room id (401)', async () => {
    // The room id is 64 bits and appears in every room URL. The token is 256
    // bits and is what "the link is the credential" actually means. Without
    // this check an outsider could attach THEIR key, and since attachRoom is
    // idempotent (I1) they would own the room's one live agent permanently.
    const room = keylessRoom();
    const response = await postKey(room, {});
    expect(response.status).toBe(401);
    expect(hasApiKey(room)).toBe(false);
  });

  it('rejects a wrong token without revealing anything (401)', async () => {
    const room = keylessRoom();
    const response = await postKey(room, { 'X-Nexus-Token': 'e'.repeat(64) });
    expect(response.status).toBe(401);
    expect(hasApiKey(room)).toBe(false);
  });

  it('accepts the real token and re-opens the room', async () => {
    const room = keylessRoom();
    const response = await postKey(room, { 'X-Nexus-Token': room.token });
    expect(response.status).toBe(200);
    expect(hasApiKey(room)).toBe(true);
  });

  it('still 404s an unknown room before asking for a token', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/room_nope/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(404);
  });
});

describe('repository URLs may not carry credentials', () => {
  it('rejects an embedded username and password', () => {
    // repoUrl is committed unredacted into room_created, broadcast to every
    // socket, and written to the meta sidecar. Redaction only ever matched
    // sk-ant-…, so a git PAT would sit in the durable log in clear text.
    const result = validateRepoUrl('https://user:ghp_secrettoken@github.com/example/repo.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('ghp_secrettoken');
  });

  it('rejects a bare token-as-username form', () => {
    expect(validateRepoUrl('https://ghp_secrettoken@github.com/example/repo.git').ok).toBe(false);
  });

  it('still accepts an ordinary https url', () => {
    expect(validateRepoUrl('https://github.com/example/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo.git',
    });
  });
});

describe('control cannot be handed to someone who has left', () => {
  it('refuses the grant and leaves the token where it was', () => {
    // Participants are never removed from the roster, only marked
    // disconnected, so a departed id stays a valid grant target forever.
    // Granting to them wedges the seat: their auto-release timer was armed
    // when their socket closed and has long since fired, so nothing frees it
    // and every prompt from anyone is rejected with "You are not driving."
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    room.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    room.participants.set('p_gone', { id: 'p_gone', displayName: 'Gone', connected: false });
    room.driverId = 'p_ada';

    expect(grantControl(room, 'p_ada', 'p_gone')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });

  it('still allows a grant to someone present', () => {
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    room.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    room.participants.set('p_grace', { id: 'p_grace', displayName: 'Grace', connected: true });
    room.driverId = 'p_ada';

    const events = grantControl(room, 'p_ada', 'p_grace');
    expect(events.map((e) => e.type)).toEqual(['driver_released', 'driver_granted']);
    expect(room.driverId).toBe('p_grace');
  });
});

describe('recovery records that the restart took the driver token', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-audit-'));
  });

  function seedWithDriver(roomId: string): void {
    writeRoomMeta(
      {
        roomId,
        token: 'a'.repeat(64),
        cwd: '/work',
        repoUrl: null,
        createdAt: '2026-07-28T00:00:00.000Z',
      },
      dir,
    );
    const log = openLog(roomId, dir);
    const base = { ts: '2026-07-28T00:00:00.000Z', roomId };
    log.append({ ...base, seq: 1, type: 'room_created', cwd: '/work', repoUrl: null } as NexusEvent);
    log.append({
      ...base,
      seq: 2,
      type: 'participant_joined',
      participantId: 'p_ada',
      displayName: 'Ada',
    } as NexusEvent);
    log.append({
      ...base,
      seq: 3,
      type: 'driver_granted',
      participantId: 'p_ada',
      displayName: 'Ada',
      reason: 'claimed',
    } as NexusEvent);
  }

  it('appends an explicit driver_released rather than silently dropping it (I3)', () => {
    seedWithDriver('room_drv');
    const recovered = recoverRooms(dir);
    expect(recovered).toHaveLength(1);

    const events = openLog('room_drv', dir).read();
    const released = events.filter((e) => e.type === 'driver_released');
    expect(released).toHaveLength(1);
    expect((released[0] as { reason: string }).reason).toBe('server_restart');
    expect((released[0] as { displayName: string }).displayName).toBe('Ada');

    // Live state and what the log reconstructs to must agree, or a log-only
    // reader sees a later uncontested driver_granted it cannot explain.
    expect(reconstruct(events)?.driverId).toBeNull();
  });

  it('continues the sequence numbering through that appended event', () => {
    seedWithDriver('room_seq');
    const recovered = recoverRooms(dir);
    expect(recovered[0]?.lastSeq).toBe(4);

    const seqs = openLog('room_seq', dir)
      .read()
      .map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('appends nothing when no driver was holding the token', () => {
    writeRoomMeta(
      {
        roomId: 'room_idle',
        token: 'a'.repeat(64),
        cwd: '/work',
        repoUrl: null,
        createdAt: '2026-07-28T00:00:00.000Z',
      },
      dir,
    );
    const log = openLog('room_idle', dir);
    log.append({
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: 'room_idle',
      type: 'room_created',
      cwd: '/work',
      repoUrl: null,
    } as NexusEvent);

    expect(recoverRooms(dir)[0]?.lastSeq).toBe(1);
    expect(openLog('room_idle', dir).read()).toHaveLength(1);
  });

  it('never writes key material while doing so (I4)', () => {
    seedWithDriver('room_i4');
    recoverRooms(dir);
    const raw = readFileSync(join(dir, 'rooms', 'room_i4.jsonl'), 'utf8');
    expect(raw).not.toContain('sk-ant');
  });
});

describe('the room the stub agent attaches to still behaves', () => {
  it('accepts a websocket after a valid re-key', async () => {
    const room = restoreRoom({
      id: mintRoomId(),
      token: 'f'.repeat(64),
      cwd: process.cwd(),
      repoUrl: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastSeq: 0,
    });

    const refused = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=Ada`,
    );
    expect(await new Promise((r) => refused.on('close', r))).toBe(4409);

    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Nexus-Token': room.token },
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(200);
    // Replace the real agent the endpoint just attached with a stub, so the
    // socket assertion below does not depend on a live SDK session.
    attachRoom(room, undefined, STUB_AGENT);

    const accepted = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=Ada`,
    );
    await new Promise((r) => accepted.on('open', r));
    accepted.close();
  });
});
