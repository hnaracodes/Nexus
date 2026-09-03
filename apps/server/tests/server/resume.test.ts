import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { ServerFrame } from '@nexus/protocol/wire';

let port = 0;
let started: ReturnType<typeof createServer>;

beforeAll(async () => {
  started = createServer();
  await new Promise<void>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => {
      port = (started.server.address() as { port: number }).port;
      resolve();
    });
  });
});
afterAll(() => started.server.close());

const settle = () => new Promise((r) => setTimeout(r, 80));

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const seqs = (frames: ServerFrame[]) =>
  frames.filter((f) => f.kind === 'event').map((f) => (f as { event: { seq: number } }).event.seq);

// Pre-attach with a stubbed runQuery so the upgrade handler finds this
// runtime instead of starting a real one. Without the stub every test in this
// file spawns an actual Agent SDK subprocess against a fake key — slow, noisy,
// and flaky. Copy the pattern from `stubbedRoom()` in tests/server/ws.test.ts.
const room = () => {
  const created = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: process.cwd(),
    repoUrl: null,
  });
  attachRoom(created, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
    })) as never,
  });
  return created;
};

describe('resume-from-sequence-number', () => {
  it('replays the whole log when since is absent', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    await settle();
    expect(Math.min(...seqs(a.frames))).toBe(1);
    a.socket.close();
  });

  it('replays only events after since', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    await settle();
    const high = Math.max(...seqs(a.frames));

    const b = await connect(`room=${r.id}&token=${r.token}&name=Grace&since=${high}`);
    await settle();
    expect(seqs(b.frames).every((s) => s > high)).toBe(true);
    expect(b.frames.some((f) => f.kind === 'replay_complete')).toBe(true);

    a.socket.close();
    b.socket.close();
  });
});
