import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { ServerFrame } from '../../src/protocol/wire.js';

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

const promptTexts = (frames: ServerFrame[]) =>
  frames
    .filter((f) => f.kind === 'event' && f.event.type === 'user_prompt')
    .map((f) => (f as { event: { text: string } }).event.text);

const room = () =>
  createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: process.cwd(),
    repoUrl: null,
  });

describe('I2 — server-side driver enforcement', () => {
  it('rejects a raw prompt frame from a non-driver', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'from the driver' }));
    await settle();

    // The exact frame a browser console would send.
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'from a non-driver' }));
    await settle();

    const texts = promptTexts(ada.frames);
    expect(texts).toContain('from the driver');
    expect(texts).not.toContain('from a non-driver');
    expect(grace.frames.some((f) => f.kind === 'error')).toBe(true);

    ada.socket.close();
    grace.socket.close();
  });

  it('accepts the same frame once control is released', async () => {
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
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'now allowed' }));
    await settle();

    expect(promptTexts(ada.frames)).toContain('now allowed');

    ada.socket.close();
    grace.socket.close();
  });
});
