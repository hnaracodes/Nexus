import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { ServerFrame } from '../../src/protocol/wire.js';
import type {
  NexusEvent,
  PromptBatchDelivered,
  PromptBatchDiscarded,
} from '../../src/protocol/events.js';

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
 * A stub session that never emits, so the agent stays mid-turn for the whole
 * test and every prompt after the first is buffered. `seen` records what the
 * SDK was actually handed, which is how we prove a discarded batch never
 * reached it — an assertion about events alone could not.
 */
function stubbedRoom() {
  const seen: string[] = [];
  const created = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: process.cwd(),
    repoUrl: null,
  });
  attachRoom(created, undefined, {
    runQuery: ((opts: { prompt: AsyncIterable<{ message: { content: string } }> }) => {
      void (async () => {
        for await (const message of opts.prompt) seen.push(message.message.content);
      })();
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise<never>(() => {
            /* the turn never ends */
          });
        },
        interrupt: async () => undefined,
      };
    }) as never,
  });
  return { room: created, seen };
}

const events = (frames: ServerFrame[]): NexusEvent[] =>
  frames.filter((f) => f.kind === 'event').map((f) => (f as { event: NexusEvent }).event);

const batches = (frames: ServerFrame[]): PromptBatchDelivered[] =>
  events(frames).filter((e): e is PromptBatchDelivered => e.type === 'prompt_batch_delivered');

const seqOf = (frames: ServerFrame[], text: string): number => {
  const found = events(frames).find((e) => e.type === 'user_prompt' && e.text === text);
  if (found === undefined) throw new Error(`no user_prompt logged for ${text}`);
  return found.seq;
};

describe('open floor — turn batching over real sockets', () => {
  it('delivers the first prompt into an idle room immediately, in its own batch', async () => {
    const { room, seen } = stubbedRoom();
    const ada = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'hello' }));
    await settle();

    expect(batches(ada.frames)).toHaveLength(1);
    expect(batches(ada.frames)[0]?.promptSeqs).toEqual([seqOf(ada.frames, 'hello')]);
    // Unchanged rendering for a lone prompt — the acceptance run depends on it.
    expect(seen).toEqual(['[Ada]: hello']);

    ada.socket.close();
  });

  it('coalesces two people typing during one turn into a single batch', async () => {
    const { room, seen } = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const bob = await connect(`${qs}&name=Bob`);
    await settle();

    // Ada's prompt opens a turn that never ends, so the next two are buffered.
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'occupy the turn' }));
    await settle();
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'add error handling' }));
    bob.socket.send(JSON.stringify({ kind: 'prompt', text: 'also update the README' }));
    await settle();

    // Both were logged — nobody was turned away.
    const texts = events(ada.frames)
      .filter((e) => e.type === 'user_prompt')
      .map((e) => e.text);
    expect(texts).toEqual(['occupy the turn', 'add error handling', 'also update the README']);

    // But only the first has been handed to the agent.
    expect(batches(ada.frames)).toHaveLength(1);
    expect(seen).toEqual(['[Ada]: occupy the turn']);

    ada.socket.close();
    bob.socket.close();
  });

  it('discards buffered prompts when someone hits stop, and they never reach the agent', async () => {
    const { room, seen } = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const bob = await connect(`${qs}&name=Bob`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'occupy the turn' }));
    await settle();
    bob.socket.send(JSON.stringify({ kind: 'prompt', text: 'queued behind it' }));
    await settle();

    bob.socket.send(JSON.stringify({ kind: 'interrupt' }));
    await settle();

    const discarded = events(ada.frames).filter(
      (e): e is PromptBatchDiscarded => e.type === 'prompt_batch_discarded',
    );
    expect(discarded).toHaveLength(1);
    expect(discarded[0]?.promptSeqs).toEqual([seqOf(ada.frames, 'queued behind it')]);
    expect(discarded[0]?.byDisplayName).toBe('Bob');

    // The point of the whole exercise: stop meant stop.
    expect(seen).toEqual(['[Ada]: occupy the turn']);
    // And the text survives in the log, so the client can offer a resend (I3).
    expect(events(ada.frames).some((e) => e.type === 'user_prompt' && e.text === 'queued behind it'))
      .toBe(true);

    ada.socket.close();
    bob.socket.close();
  });

  it('accepts a prompt again after a stop, without waiting for a turn boundary', async () => {
    const { room, seen } = stubbedRoom();
    const qs = `room=${room.id}&token=${room.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'occupy the turn' }));
    await settle();
    ada.socket.send(JSON.stringify({ kind: 'interrupt' }));
    await settle();
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'try again' }));
    await settle();

    expect(seen).toEqual(['[Ada]: occupy the turn', '[Ada]: try again']);

    ada.socket.close();
  });
});
