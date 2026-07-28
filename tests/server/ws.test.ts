import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
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

/**
 * A room whose agent never reaches the network. attachRoom is called up front
 * with a stubbed runQuery; the upgrade handler then finds this runtime instead
 * of starting a real one (Invariant I1 — one agent per room).
 */
function stubbedRoom() {
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

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const eventSeqs = (frames: ServerFrame[]) =>
  frames.filter((f) => f.kind === 'event').map((f) => (f as { event: { seq: number } }).event.seq);

describe('websocket attach', () => {
  it('closes a connection with a bad token using code 4401', async () => {
    const room = stubbedRoom();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.id}&token=nope&name=Ada`);
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4401);
  });

  it('broadcasts participant_joined to every attached socket', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const a = await connect(`${qs}&name=Ada`);
    await settle();
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    const names = a.frames
      .filter((f) => f.kind === 'event' && f.event.type === 'participant_joined')
      .map((f) => (f as { event: { displayName: string } }).event.displayName);
    expect(names).toContain('Ada');
    expect(names).toContain('Grace');
    expect(b.frames.some((f) => f.kind === 'replay_complete')).toBe(true);

    a.socket.close();
    b.socket.close();
  });

  it('replays history to a late joiner before the live stream', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const a = await connect(`${qs}&name=Ada`);
    await settle();
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    // Grace was not connected when the room was created, but sees it replayed.
    expect(b.frames.some((f) => f.kind === 'event' && f.event.type === 'room_created')).toBe(true);

    const replayIndex = b.frames.findIndex((f) => f.kind === 'replay_complete');
    const ownJoinIndex = b.frames.findIndex(
      (f) =>
        f.kind === 'event' &&
        f.event.type === 'participant_joined' &&
        (f.event as { displayName: string }).displayName === 'Grace',
    );
    expect(replayIndex).toBeGreaterThanOrEqual(0);
    expect(ownJoinIndex).toBeGreaterThan(replayIndex);

    a.socket.close();
    b.socket.close();
  });

  it('assigns strictly increasing, unique sequence numbers', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const a = await connect(`${qs}&name=Ada`);
    await settle();
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    const seqs = eventSeqs(a.frames);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);

    a.socket.close();
    b.socket.close();
  });

  it('never puts the API key in any frame (I4)', async () => {
    const room = stubbedRoom();
    const a = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();
    expect(JSON.stringify(a.frames)).not.toContain('sk-ant');
    a.socket.close();
  });

  it('answers an unrecognized client frame with an error frame', async () => {
    const room = stubbedRoom();
    const a = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();
    a.socket.send('not json at all');
    await settle();
    expect(a.frames.some((f) => f.kind === 'error')).toBe(true);
    a.socket.close();
  });

  it('broadcasts a prompt from one client to every client', async () => {
    const room = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const a = await connect(`${qs}&name=Ada`);
    await settle();
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    a.socket.send(JSON.stringify({ kind: 'prompt', text: 'hello room' }));
    await settle();

    for (const side of [a, b]) {
      const prompts = side.frames
        .filter((f) => f.kind === 'event' && f.event.type === 'user_prompt')
        .map((f) => (f as { event: { text: string; displayName: string } }).event);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.text).toBe('hello room');
      expect(prompts[0]?.displayName).toBe('Ada');
    }

    a.socket.close();
    b.socket.close();
  });
});

describe('http api', () => {
  it('answers the health check', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('rejects room creation without a console key, without echoing input', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'hunter2' }),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain('hunter2');
  });

  it('requires the room token on the lookup route', async () => {
    const room = stubbedRoom();
    const unauthorized = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}`);
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}`, {
      headers: { 'X-Nexus-Token': room.token },
    });
    expect(authorized.status).toBe(200);
    const payload = JSON.stringify(await authorized.json());
    expect(payload).not.toContain('sk-ant');
    expect(payload).not.toContain(room.token);
  });
});
