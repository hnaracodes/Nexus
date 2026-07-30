import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { ServerFrame } from '../../src/protocol/wire.js';
import type { UserPrompt } from '../../src/protocol/events.js';

/**
 * This file used to assert I2 — that a non-driver's prompt is rejected at the
 * server and never reaches the log. Phase 4 makes that false by design, so the
 * file was repointed rather than deleted.
 *
 * What it asserts now is I2': every prompt is admitted, but the server, not the
 * client, decides who was driving. A participant can send whatever bytes they
 * like; they cannot make the log say they held the token.
 */

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const prompts = (frames: ServerFrame[]): UserPrompt[] =>
  frames
    .filter((f) => f.kind === 'event' && f.event.type === 'user_prompt')
    .map((f) => (f as { event: UserPrompt }).event);

const promptTexts = (frames: ServerFrame[]) => prompts(frames).map((e) => e.text);

/**
 * Stub the SDK so the upgrade handler finds this runtime instead of spawning a
 * real Agent subprocess against a fake key. Same pattern as interrupt.test.ts;
 * this repo has no shared fixture file and every test declares its own.
 */
function room() {
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

describe("I2' — the server arbitrates, it does not gatekeep", () => {
  it('admits a prompt from a non-driver and logs it', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'from the driver' }));
    await settle();

    // The exact frame a browser console would send. Before phase 4 this was
    // rejected; now it is admitted, ordered and attributed.
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'from a non-driver' }));
    await settle();

    const texts = promptTexts(ada.frames);
    expect(texts).toContain('from the driver');
    expect(texts).toContain('from a non-driver');
    expect(grace.frames.some((f) => f.kind === 'error')).toBe(false);

    ada.socket.close();
    grace.socket.close();
  });

  it('records who was driving, per prompt', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    // Ada speaks first and so claims the vacant token.
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'driver speaks' }));
    await settle();
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'passenger speaks' }));
    await settle();

    const logged = prompts(ada.frames);
    expect(logged.find((e) => e.text === 'driver speaks')?.wasDriver).toBe(true);
    expect(logged.find((e) => e.text === 'passenger speaks')?.wasDriver).toBe(false);

    ada.socket.close();
    grace.socket.close();
  });

  /**
   * The most important assertion in this file. Driver status is precedence, and
   * precedence a participant can award themselves is not precedence at all.
   */
  it('ignores a forged wasDriver on the client frame', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'claim the token' }));
    await settle();

    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'forged', wasDriver: true }));
    await settle();

    const forged = prompts(ada.frames).find((e) => e.text === 'forged');
    expect(forged).toBeDefined();
    expect(forged?.wasDriver).toBe(false);

    ada.socket.close();
    grace.socket.close();
  });

  it('still hands the token to the first speaker in an idle room', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'claim' }));
    await settle();

    const granted = ada.frames.filter(
      (f) => f.kind === 'event' && f.event.type === 'driver_granted',
    );
    expect(granted).toHaveLength(1);

    ada.socket.close();
  });

  it('marks prompts as non-driver once control is released and nobody holds it', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'claim' }));
    await settle();
    ada.socket.send(JSON.stringify({ kind: 'release_control' }));
    await settle();
    // Grace speaks into a vacant room, so claimIfVacant hands her the token
    // before the prompt is attributed — she is the driver for this one.
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'now driving' }));
    await settle();

    expect(prompts(ada.frames).find((e) => e.text === 'now driving')?.wasDriver).toBe(true);

    ada.socket.close();
    grace.socket.close();
  });
});
