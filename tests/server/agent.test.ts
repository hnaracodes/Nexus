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

    h.handle.submit('hello');
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

    h.handle.submit('hello');
    resolveResult();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.events.some((e) => e.type === 'agent_error')).toBe(false);
    expect(h.events.some((e) => e.type === 'agent_idle')).toBe(true);
    vi.useRealTimers();
  });

  it('does not arm a second, redundant timer while one submission is still outstanding', async () => {
    vi.useFakeTimers();
    const h = harness(() => deadSession(), 1_000);

    h.handle.submit('first');
    await vi.advanceTimersByTimeAsync(500);
    h.handle.submit('second'); // outstanding watchdog already covers this
    await vi.advanceTimersByTimeAsync(500);

    const errors = h.events.filter((e) => e.type === 'agent_error');
    expect(errors).toHaveLength(1);
    vi.useRealTimers();
  });

  it('clears the watchdog on interrupt so a stale timer cannot fire later', async () => {
    vi.useFakeTimers();
    const h = harness(() => deadSession(), 1_000);

    h.handle.submit('hello');
    await h.handle.interrupt();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.events.some((e) => e.type === 'agent_error')).toBe(false);
    vi.useRealTimers();
  });
});
