import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { attachApiKey, createRoom, mintRoomId, restoreRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom, getRuntime } from '../../src/server/ws.js';
import { projectPresence } from '../../src/server/presence.js';
import type { ServerFrame } from '../../src/protocol/wire.js';

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
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
    })) as never,
  });
  return room;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
}

function connect(qs: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

/** The per-socket identity the server handed this client. */
function identityOf(client: Client): { participantId: string; resumeToken: string } {
  const frame = client.frames.find((f) => f.kind === 'replay_complete');
  if (frame === undefined || frame.kind !== 'replay_complete') {
    throw new Error('no replay_complete frame');
  }
  return { participantId: frame.participantId, resumeToken: frame.resumeToken };
}

async function closeAndSettle(client: Client): Promise<void> {
  client.socket.close();
  await settle();
}

function loggedEvents(room: Room) {
  return getRuntime(room.id)?.sink.read() ?? [];
}

describe('stable participant identity', () => {
  it('reclaims the same id when the socket presents its resume token', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const first = await connect(`${qs}&name=Ada`);
    await settle();
    const ada = identityOf(first);
    await closeAndSettle(first);

    const second = await connect(
      `${qs}&name=Ada&participant=${ada.participantId}&resume=${ada.resumeToken}`,
    );
    await settle();

    expect(identityOf(second).participantId).toBe(ada.participantId);
    await closeAndSettle(second);
  });

  it('refuses to hand over an identity to a socket without the resume token (I2)', async () => {
    // Participant ids are broadcast to the whole room inside participant_joined,
    // so anyone can read the driver's id off the log. If a bare id were enough
    // to reclaim an identity, any member could reconnect as the driver and take
    // the token — an I2 bypass at the server, which is the one place I2 holds.
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const driver = await connect(`${qs}&name=Ada`);
    await settle();
    driver.socket.send(JSON.stringify({ kind: 'prompt', text: 'go' }));
    await settle();

    const ada = identityOf(driver);
    expect(room.driverId).toBe(ada.participantId);

    // Grace can see Ada's id in her own replayed log — no privileged access.
    const impostor = await connect(`${qs}&name=Grace&participant=${ada.participantId}`);
    await settle();

    expect(identityOf(impostor).participantId).not.toBe(ada.participantId);
    expect(room.driverId).toBe(ada.participantId);

    await closeAndSettle(impostor);
    await closeAndSettle(driver);
  });

  it('mints a fresh id when the resume token is wrong or the id is malformed', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const first = await connect(`${qs}&name=Ada`);
    await settle();
    const ada = identityOf(first);
    await closeAndSettle(first);

    const wrongToken = await connect(
      `${qs}&name=Ada&participant=${ada.participantId}&resume=${'0'.repeat(64)}`,
    );
    await settle();
    expect(identityOf(wrongToken).participantId).not.toBe(ada.participantId);
    await closeAndSettle(wrongToken);

    const malformed = await connect(`${qs}&name=Ada&participant=../../etc&resume=whatever`);
    await settle();
    expect(identityOf(malformed).participantId).toMatch(/^p_[0-9a-f]{12}$/);
    await closeAndSettle(malformed);
  });

  it('does not grow a second roster row when the same person returns', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const first = await connect(`${qs}&name=Ada`);
    await settle();
    const ada = identityOf(first);
    await closeAndSettle(first);

    const second = await connect(
      `${qs}&name=Ada&participant=${ada.participantId}&resume=${ada.resumeToken}`,
    );
    await settle();

    // The roster is projected from the log (I3), so this is the real check.
    const { participants } = projectPresence(loggedEvents(room));
    expect(participants).toHaveLength(1);
    expect(participants[0]?.participantId).toBe(ada.participantId);
    expect(participants[0]?.connected).toBe(true);

    await closeAndSettle(second);
  });

  it('lets a reconnecting driver keep the token inside the grace period', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const first = await connect(`${qs}&name=Ada`);
    await settle();
    first.socket.send(JSON.stringify({ kind: 'prompt', text: 'go' }));
    await settle();
    const ada = identityOf(first);
    expect(room.driverId).toBe(ada.participantId);

    await closeAndSettle(first);
    // Still theirs — the token is held for the grace period, not dropped.
    expect(room.driverId).toBe(ada.participantId);

    const second = await connect(
      `${qs}&name=Ada&participant=${ada.participantId}&resume=${ada.resumeToken}`,
    );
    await settle();

    // Before stable identity this cancel was a no-op: the returning socket had
    // a brand-new id, so it never matched the timer armed under the old one.
    expect(room.driverId).toBe(ada.participantId);
    expect(loggedEvents(room).some((event) => event.type === 'driver_released')).toBe(false);

    await closeAndSettle(second);
  });

  it('treats two tabs as one person until the last one closes', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const tabOne = await connect(`${qs}&name=Ada`);
    await settle();
    const ada = identityOf(tabOne);

    const tabTwo = await connect(
      `${qs}&name=Ada&participant=${ada.participantId}&resume=${ada.resumeToken}`,
    );
    await settle();
    expect(identityOf(tabTwo).participantId).toBe(ada.participantId);

    await closeAndSettle(tabOne);

    // One tab closing is not the person leaving.
    expect(room.participants.get(ada.participantId)?.connected).toBe(true);
    expect(loggedEvents(room).filter((event) => event.type === 'participant_left')).toHaveLength(0);

    await closeAndSettle(tabTwo);
    expect(room.participants.get(ada.participantId)?.connected).toBe(false);
    expect(loggedEvents(room).filter((event) => event.type === 'participant_left')).toHaveLength(1);
  });

  it('refuses a recovered room that has no key yet, instead of attaching a doomed agent', async () => {
    // I4 forbids persisting the key, so a room rebuilt from disk comes back
    // keyless. Attaching an agent anyway would throw on the first prompt and
    // leave the room looking alive but permanently mute.
    const room = restoreRoom({
      id: mintRoomId(),
      token: 'c'.repeat(64),
      cwd: process.cwd(),
      repoUrl: null,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastSeq: 5,
    });

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=Ada`,
    );
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4409);

    // Once the creator returns with a key, the same link works again.
    attachApiKey(room, KEY);
    attachRoom(room, undefined, {
      runQuery: (() => ({
        async *[Symbol.asyncIterator]() {
          /* the stub agent never emits */
        },
        interrupt: async () => undefined,
      })) as never,
    });
    const rejoined = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();
    expect(identityOf(rejoined).participantId).toMatch(/^p_/);
    await closeAndSettle(rejoined);
  });

  it('never broadcasts a resume token to anyone else', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;

    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    const adaToken = identityOf(ada).resumeToken;
    expect(JSON.stringify(grace.frames)).not.toContain(adaToken);
    // And it never reaches the durable log either.
    expect(JSON.stringify(loggedEvents(room))).not.toContain(adaToken);

    await closeAndSettle(grace);
    await closeAndSettle(ada);
  });
});
