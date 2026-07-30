import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsequencedEvent } from '../../src/protocol/events.js';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

beforeEach(() => __resetRooms());

function harness(runQuery: unknown, idleTimeoutMs: number) {
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  const events: UnsequencedEvent[] = [];
  const handle = startAgent(room, (event) => events.push(event), {
    runQuery: runQuery as never,
    idleTimeoutMs,
  });
  return { handle, events };
}

/** phase-4: submit() takes an attributed PendingPrompt, not a bare string. */
let nextSeq = 1;
beforeEach(() => {
  nextSeq = 1;
});
function prompt(text: string, wasDriver = true) {
  return { seq: nextSeq++, displayName: 'Ada', text, wasDriver };
}

const STOPPER = { participantId: 'p_000000000000', displayName: 'Ada' };

/**
 * A session that produces nothing, ever. This is closer to how an invalid API
 * key actually fails (see issues.md session 2, #10) than a session that
 * throws: the SDK does not always surface a dead subprocess as a thrown
 * error, so the loop can simply receive nothing forever.
 */
function deadSession() {
  return {
    [Symbol.asyncIterator]: async function* () {
      await new Promise<never>(() => {
        /* never resolves */
      });
    },
    interrupt: async () => undefined,
  };
}

describe('idle watchdog', () => {
  it('emits agent_error if no result arrives before the timeout', async () => {
    vi.useFakeTimers();
    const h = harness(() => deadSession(), 1_000);

    h.handle.submit(prompt('hello'));
    await vi.advanceTimersByTimeAsync(1_000);

    const error = h.events.find((e) => e.type === 'agent_error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toMatch(/no response/i);
    vi.useRealTimers();
  });

  it('does not emit agent_error once a result arrives before the timeout', async () => {
    vi.useFakeTimers();
    let resolveResult: () => void = () => undefined;
    const resultGate = new Promise<void>((resolve) => {
      resolveResult = resolve;
    });

    const h = harness(
      () => ({
        [Symbol.asyncIterator]: async function* () {
          await resultGate;
          yield { type: 'result' };
          await new Promise<never>(() => {
            /* session stays open for the room's life (I1) */
          });
        },
        interrupt: async () => undefined,
      }),
      1_000,
    );

    h.handle.submit(prompt('hello'));
    resolveResult();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.events.some((e) => e.type === 'agent_error')).toBe(false);
    expect(h.events.some((e) => e.type === 'agent_idle')).toBe(true);
    vi.useRealTimers();
  });

  it('does not arm a second, redundant timer while one submission is still outstanding', async () => {
    vi.useFakeTimers();
    const h = harness(() => deadSession(), 1_000);

    h.handle.submit(prompt('first'));
    await vi.advanceTimersByTimeAsync(500);
    h.handle.submit(prompt('second')); // buffered behind the running turn
    await vi.advanceTimersByTimeAsync(500);

    const errors = h.events.filter((e) => e.type === 'agent_error');
    expect(errors).toHaveLength(1);
    vi.useRealTimers();
  });

  it('clears the watchdog on interrupt so a stale timer cannot fire later', async () => {
    vi.useFakeTimers();
    const h = harness(() => deadSession(), 1_000);

    h.handle.submit(prompt('hello'));
    await h.handle.interrupt(STOPPER);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.events.some((e) => e.type === 'agent_error')).toBe(false);
    vi.useRealTimers();
  });
});

describe('phase-4 turn batching', () => {
  const delivered = (events: UnsequencedEvent[]) =>
    events.filter(
      (e): e is Extract<UnsequencedEvent, { type: 'prompt_batch_delivered' }> =>
        e.type === 'prompt_batch_delivered',
    );

  it('delivers the first prompt into an idle room immediately, alone', () => {
    const h = harness(() => deadSession(), 60_000);
    h.handle.submit(prompt('go'));

    expect(delivered(h.events).map((e) => e.promptSeqs)).toEqual([[1]]);
  });

  it('holds prompts arriving mid-turn — nothing reaches the SDK until idle', () => {
    const h = harness(() => deadSession(), 60_000);
    h.handle.submit(prompt('first'));
    h.handle.submit(prompt('second', false));
    h.handle.submit(prompt('third', false));

    // Still exactly one delivery: the session never emitted `result`.
    expect(delivered(h.events)).toHaveLength(1);
  });

  it('releases everything buffered as one batch when the turn ends', async () => {
    let endTurn: () => void = () => undefined;
    const turnOver = new Promise<void>((resolve) => {
      endTurn = resolve;
    });
    const h = harness(
      () => ({
        [Symbol.asyncIterator]: async function* () {
          await turnOver;
          yield { type: 'result' };
          await new Promise<never>(() => {
            /* session stays open (I1) */
          });
        },
        interrupt: async () => undefined,
      }),
      60_000,
    );

    h.handle.submit(prompt('first'));
    h.handle.submit(prompt('second', false));
    h.handle.submit(prompt('third', false));
    endTurn();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(delivered(h.events).map((e) => e.promptSeqs)).toEqual([[1], [2, 3]]);
  });

  it('discards buffered prompts on interrupt and names who stopped it', async () => {
    const h = harness(() => deadSession(), 60_000);
    h.handle.submit(prompt('running'));
    h.handle.submit(prompt('queued', false));

    await h.handle.interrupt(STOPPER);

    const discarded = h.events.filter((e) => e.type === 'prompt_batch_discarded');
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ promptSeqs: [2], byDisplayName: 'Ada' });
    // And the discarded prompt was never handed to the agent.
    expect(delivered(h.events).map((e) => e.promptSeqs)).toEqual([[1]]);
  });

  it('logs no discard event when the buffer was already empty', async () => {
    const h = harness(() => deadSession(), 60_000);
    h.handle.submit(prompt('running'));

    await h.handle.interrupt(STOPPER);

    expect(h.events.some((e) => e.type === 'prompt_batch_discarded')).toBe(false);
  });
});
