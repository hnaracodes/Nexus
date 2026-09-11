import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerFrame } from '@nexus/protocol/wire';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom, getRuntime } from '../../src/server/ws.js';
import { spawnAgent } from '../../src/server/fleet.js';

/**
 * A client that joins a room already holding a fleet must be TOLD about it.
 *
 * `broadcastFleet()` is called when the fleet CHANGES — spawn, stop, model
 * switch, crew run — and nowhere else. A socket that connects afterwards
 * receives events, `replay_complete` and `presence`, and then nothing about
 * the fleet until somebody happens to change it. Presence is pushed on join;
 * the fleet is not, and that asymmetry is the bug.
 *
 * Found by opening the room in a browser: a room holding eight live agents
 * showed "1 agent" in the status bar and no fleet view at all. Every test
 * passed, because every test that asserts on a fleet frame first does
 * something that triggers one.
 *
 * The fleet frame is deliberately transient and unlogged ("liveness, never
 * membership" — see `broadcastFleet`'s own comment), which is exactly why it
 * cannot be recovered from the replay this socket just received. Transient
 * state has to be handed to a joiner explicitly, the way presence already is.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const BY = { participantId: 'p_000000000000', displayName: 'Ada' };

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

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 80));

describe('a joining client learns the fleet it is joining', () => {
  it('sends a fleet frame on join, listing every live agent', async () => {
    const room = stubbedRoom();
    const runtime = getRuntime(room.id);
    if (runtime === undefined) throw new Error('no runtime');

    // Two extra agents, spawned BEFORE anyone connects — so the only way this
    // client can know about them is if the join itself tells it.
    for (const displayName of ['Alpha', 'Beta']) {
      const result = spawnAgent({ runtime, displayName, provider: 'anthropic', model: null, by: BY });
      if (!result.ok) throw new Error(`spawn failed: ${result.reason}`);
    }

    const client = await connect(`room=${room.id}&token=${room.token}&name=Late&since=0`);
    await settle();
    client.socket.close();

    const fleet = client.frames.find((f) => f.kind === 'fleet');
    expect(fleet).toBeDefined();
    if (fleet?.kind !== 'fleet') throw new Error('unreachable');
    expect(fleet.agents.map((a) => a.displayName).sort()).toEqual(['Agent', 'Alpha', 'Beta']);
  });

  it('still sends one for a room with only the primary agent, so the count is never guessed', async () => {
    const room = stubbedRoom();
    const client = await connect(`room=${room.id}&token=${room.token}&name=Solo&since=0`);
    await settle();
    client.socket.close();

    const fleet = client.frames.find((f) => f.kind === 'fleet');
    expect(fleet).toBeDefined();
    if (fleet?.kind !== 'fleet') throw new Error('unreachable');
    expect(fleet.agents).toHaveLength(1);
  });
});
