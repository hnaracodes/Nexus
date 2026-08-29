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

/**
 * Pre-attach with a stubbed runQuery so the upgrade handler finds this runtime
 * instead of starting a real one. Without the stub each test spawns an actual
 * Agent SDK subprocess against a fake key — slow, noisy and flaky. Copy the
 * pattern from `stubbedRoom()` in tests/server/ws.test.ts. Note the stub must
 * expose `interrupt`, since that is what this plan exercises.
 */
function stubbedRoom() {
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
}

describe('global interrupt', () => {
  it('accepts an interrupt from a non-driver and logs who sent it', async () => {
    const r = stubbedRoom();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    // Ada takes the driver token.
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'go' }));
    await settle();

    // Grace — explicitly NOT the driver — hits stop.
    grace.socket.send(JSON.stringify({ kind: 'interrupt' }));
    await settle();

    const interrupts = ada.frames.filter(
      (f) => f.kind === 'event' && f.event.type === 'interrupted',
    );
    expect(interrupts).toHaveLength(1);
    expect((interrupts[0] as { event: { displayName: string } }).event.displayName).toBe('Grace');

    ada.socket.close();
    grace.socket.close();
  });

  it('never leaks the raw rejection into the committed agent_error message', async () => {
    const POISON = 'sk-ant-api03-LEAKED-key-should-never-reach-the-log';
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
        interrupt: async () => {
          throw new Error(POISON);
        },
      })) as never,
    });

    const qs = `room=${created.id}&token=${created.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'interrupt' }));
    await settle();

    const errors = ada.frames.filter((f) => f.kind === 'event' && f.event.type === 'agent_error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { event: { message: string } }).event.message).toBe(
      'Could not stop the agent — the session may have already ended.',
    );
    expect(ada.frames.some((f) => JSON.stringify(f).includes(POISON))).toBe(false);

    ada.socket.close();
  });
});
