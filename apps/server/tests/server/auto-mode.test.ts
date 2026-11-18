import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { ServerFrame } from '@syncode/protocol/wire';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom, getRuntime } from '../../src/server/ws.js';
import { recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';
import { openLog } from '../../src/log/event-log.js';
import { reconstruct } from '../../src/log/replay.js';

/**
 * Phase 19a, end to end over real sockets: the switch is a frame any
 * participant may send, the server is what flips the room, the log is what
 * everyone learns it from, and a card already waiting is settled the moment
 * auto mode goes on.
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

function stubbedRoom(): Room {
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  attachRoom(room, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* never emits */
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
    })) as never,
  });
  return room;
}

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
}

function connect(room: Room, name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=${name}`,
    );
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

function events(client: Client, type: SynCodeEvent['type']): SynCodeEvent[] {
  return client.frames
    .filter((f): f is Extract<ServerFrame, { kind: 'event' }> => f.kind === 'event')
    .map((f) => f.event)
    .filter((e) => e.type === type);
}

/** Poll for a condition instead of sleeping a fixed time (CLAUDE.md flake lesson). */
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const send = (client: Client, frame: unknown): void => client.socket.send(JSON.stringify(frame));

describe('auto mode over the wire (phase 19a)', () => {
  it('any participant can switch it on; everyone sees who did; a repeat is a no-op', async () => {
    const room = stubbedRoom();
    const ada = await connect(room, 'Ada');
    const bob = await connect(room, 'Bob');
    await until(() => events(ada, 'participant_joined').length >= 2, 'both joins');

    // Bob is NOT the driver — nobody is. The user's decision: anyone may.
    send(bob, { kind: 'set_auto_mode', enabled: true });
    await until(() => events(ada, 'auto_mode_changed').length === 1, 'Ada to see the switch');

    expect(events(ada, 'auto_mode_changed')[0]).toMatchObject({
      enabled: true,
      displayName: 'Bob',
      reason: 'participant',
    });
    expect(room.autoMode).toMatchObject({ displayName: 'Bob' });

    // Already on: nothing new is committed.
    send(ada, { kind: 'set_auto_mode', enabled: true });
    send(ada, { kind: 'set_auto_mode', enabled: false });
    await until(() => events(bob, 'auto_mode_changed').length === 2, 'the switch-off');
    const changes = events(bob, 'auto_mode_changed');
    expect(changes.map((e) => (e as { enabled: boolean }).enabled)).toEqual([true, false]);
    expect(changes[1]).toMatchObject({ displayName: 'Ada' });
    expect(room.autoMode).toBeNull();

    ada.socket.close();
    bob.socket.close();
  });

  it('switching it on settles a card that is already waiting, as an auto_mode allow', async () => {
    const room = stubbedRoom();
    const ada = await connect(room, 'Ada');
    await until(() => events(ada, 'participant_joined').length >= 1, 'join');

    const agent = getRuntime(room.id)?.getAgent();
    if (agent === undefined) throw new Error('no primary agent');
    const decision = agent.gate.request('Bash', { command: 'npm test' });
    await until(() => events(ada, 'permission_requested').length === 1, 'the card');

    send(ada, { kind: 'set_auto_mode', enabled: true });

    await expect(decision).resolves.toMatchObject({ decision: 'allow', via: 'auto_mode', displayName: 'Ada' });
    await until(() => events(ada, 'permission_decided').length === 1, 'the decision to be logged');
    expect(events(ada, 'permission_decided')[0]).toMatchObject({ via: 'auto_mode', displayName: 'Ada' });
    expect(agent.gate.pendingIds()).toEqual([]);

    ada.socket.close();
  });
});

describe('auto mode across a restart (phase 19a)', () => {
  function seed(dir: string, roomId: string, enabledLast: boolean): void {
    writeRoomMeta(
      { roomId, token: 'b'.repeat(64), cwd: '/work', repoUrl: null, createdAt: '2026-11-18T00:00:00.000Z' },
      dir,
    );
    const log = openLog(roomId, dir);
    const base = { ts: '2026-11-18T00:00:00.000Z', roomId };
    log.append({ ...base, seq: 1, type: 'room_created', cwd: '/work', repoUrl: null } as SynCodeEvent);
    log.append({ ...base, seq: 2, type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' } as SynCodeEvent);
    log.append({
      ...base, seq: 3, type: 'auto_mode_changed', enabled: true,
      participantId: 'p_ada', displayName: 'Ada', reason: 'participant',
    } as SynCodeEvent);
    if (!enabledLast) {
      log.append({
        ...base, seq: 4, type: 'auto_mode_changed', enabled: false,
        participantId: 'p_ada', displayName: 'Ada', reason: 'participant',
      } as SynCodeEvent);
    }
  }

  it('reconstructs who has auto mode on from the log alone (I3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncode-auto-'));
    seed(dir, 'room_auto_rc', true);
    expect(reconstruct(openLog('room_auto_rc', dir).read())?.autoMode).toEqual({
      participantId: 'p_ada',
      displayName: 'Ada',
    });
  });

  it('a restart switches it off and writes down why, so log and live state agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncode-auto-'));
    seed(dir, 'room_auto_on', true);
    recoverRooms(dir);

    const events = openLog('room_auto_on', dir).read();
    const changes = events.filter((e) => e.type === 'auto_mode_changed');
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      enabled: false,
      reason: 'server_restart',
      participantId: null,
      displayName: null,
      seq: 4,
    });
    expect(reconstruct(events)?.autoMode).toBeNull();
  });

  it('writes nothing when the log already ends with it off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncode-auto-'));
    seed(dir, 'room_auto_off', false);
    recoverRooms(dir);
    const events = openLog('room_auto_off', dir).read();
    expect(events.filter((e) => e.type === 'auto_mode_changed')).toHaveLength(2);
  });
});
