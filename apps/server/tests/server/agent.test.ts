import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import { startAgent, translate } from '../../src/server/agent.js';
import type { AgentDeps } from '../../src/server/agent.js';
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

/**
 * phase-7a: `translate()` is a pure exported function taking `unknown` — every
 * case here is a synthetic message, never a live SDK subprocess.
 */
describe('translate() — context usage and model telemetry', () => {
  function modelUsage(overrides: Partial<Record<string, number>> = {}) {
    return {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      webSearchRequests: 0,
      costUSD: 0.01,
      contextWindow: 200_000,
      ...overrides,
    };
  }

  it('emits agent_idle and one context_usage per model key on a result with modelUsage', () => {
    const events = translate({
      type: 'result',
      subtype: 'success',
      modelUsage: { 'claude-sonnet-5': modelUsage() },
    });

    expect(events).toEqual([
      {
        type: 'context_usage',
        model: 'claude-sonnet-5',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 10,
        cacheCreationInputTokens: 5,
        contextWindow: 200_000,
        compactedFromTokens: null,
      },
      { type: 'agent_idle' },
    ]);
  });

  it('still emits agent_idle alone when a result carries no modelUsage', () => {
    expect(translate({ type: 'result', subtype: 'success' })).toEqual([{ type: 'agent_idle' }]);
  });

  it('emits one context_usage entry per model when a turn used more than one', () => {
    const events = translate({
      type: 'result',
      subtype: 'error_during_execution',
      modelUsage: {
        'model-a': modelUsage({ inputTokens: 1 }),
        'model-b': modelUsage({ inputTokens: 2 }),
      },
    });
    const models = events
      .filter((e) => e.type === 'context_usage')
      .map((e) => (e as { model: string }).model)
      .sort();
    expect(models).toEqual(['model-a', 'model-b']);
    expect(events.filter((e) => e.type === 'agent_idle')).toHaveLength(1);
  });

  it('emits a context_usage carrying compactedFromTokens on a compact_boundary', () => {
    const events = translate({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: 12_345 },
    });
    expect(events).toEqual([
      {
        type: 'context_usage',
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 0,
        compactedFromTokens: 12_345,
      },
    ]);
  });

  it('never throws on a malformed or unexpected shape', () => {
    expect(() => translate(null)).not.toThrow();
    expect(() => translate('not an object')).not.toThrow();
    expect(() => translate({ type: 'result', modelUsage: 'not an object' })).not.toThrow();
    expect(() =>
      translate({ type: 'system', subtype: 'compact_boundary', compact_metadata: null }),
    ).not.toThrow();
    expect(() => translate({ type: 'system', subtype: 'init' })).not.toThrow();
  });
});

describe('setModel', () => {
  function harnessWithSetModel(setModel: (model?: string) => Promise<void>) {
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    const events: UnsequencedEvent[] = [];
    const handle = startAgent(room, (event) => events.push(event), {
      runQuery: (() => ({
        [Symbol.asyncIterator]: async function* () {
          await new Promise<never>(() => {
            /* session stays open for the room's life (I1) */
          });
        },
        interrupt: async () => undefined,
        setModel,
      })) as never,
    });
    return handle;
  }

  it('bridges null to undefined, matching the SDK setModel(model?: string) signature', async () => {
    let called = false;
    let received: string | undefined;
    const handle = harnessWithSetModel(async (model) => {
      called = true;
      received = model;
    });
    await handle.setModel(null);
    expect(called).toBe(true);
    expect(received).toBeUndefined();
  });

  it('passes a concrete model string straight through', async () => {
    let received: string | undefined;
    const handle = harnessWithSetModel(async (model) => {
      received = model;
    });
    await handle.setModel('claude-opus-4');
    expect(received).toBe('claude-opus-4');
  });
});

/**
 * Phase 17d — agents know their siblings exist. `AgentDeps.roster`, when
 * supplied, is called fresh at every turn boundary and its result is handed
 * straight to `turnGate.ts`'s `submit`/`onIdle`, so this suite proves the
 * WIRING: the text that actually reaches the SDK's prompt queue (what a real
 * `query()` would read) carries the preamble when a roster is wired, and is
 * untouched when it is not — the same "no roster, no behaviour change" bar
 * `turnGate.test.ts` proves for `render` in isolation.
 */
describe('sibling roster preamble (phase 17d)', () => {
  type CapturedMessage = { message: { content: string } };

  /** Captures the exact AsyncIterable handed to `runQuery` as `options.prompt`
   *  — the same queue a real `query()` reads from — so a test can read back
   *  precisely what `deliver()` pushed onto it. */
  function harnessCapturingPrompt(
    sessionFactory: () => {
      [Symbol.asyncIterator]: () => AsyncGenerator<unknown>;
      interrupt: () => Promise<void>;
    },
    deps: Partial<AgentDeps> = {},
  ) {
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    const events: UnsequencedEvent[] = [];
    let capturedPrompt: AsyncIterable<CapturedMessage> | undefined;
    const handle = startAgent(room, (event) => events.push(event), {
      runQuery: ((opts: { prompt: AsyncIterable<CapturedMessage> }) => {
        capturedPrompt = opts.prompt;
        return sessionFactory();
      }) as never,
      ...deps,
    });
    return {
      handle,
      events,
      nextDelivered: (() => {
        let iterator: AsyncIterator<CapturedMessage> | undefined;
        return async (): Promise<string> => {
          if (iterator === undefined) {
            if (capturedPrompt === undefined) throw new Error('runQuery was never called');
            iterator = capturedPrompt[Symbol.asyncIterator]();
          }
          const { value } = await iterator.next();
          return value.message.content;
        };
      })(),
    };
  }

  function neverEndingSession() {
    return {
      [Symbol.asyncIterator]: async function* () {
        await new Promise<never>(() => {
          /* session stays open for the room's life (I1) */
        });
      },
      interrupt: async () => undefined,
    };
  }

  it('delivers an unchanged prompt when no roster is wired — the existing behaviour', async () => {
    const h = harnessCapturingPrompt(neverEndingSession);
    h.handle.submit(prompt('hello'));
    expect(await h.nextDelivered()).toBe('[Ada]: hello');
  });

  it('delivers an unchanged prompt when roster() returns null — alone, even though wired', async () => {
    const h = harnessCapturingPrompt(neverEndingSession, { roster: () => null });
    h.handle.submit(prompt('hello'));
    expect(await h.nextDelivered()).toBe('[Ada]: hello');
  });

  it('prefixes the delivered prompt with whatever roster() returns', async () => {
    const h = harnessCapturingPrompt(neverEndingSession, {
      roster: () => ({
        selfDisplayName: 'Agent',
      selfAgentId: 'agent_agent0000000',
        others: [{ displayName: 'Beta', agentId: 'agent_beta00000000', provider: 'anthropic', status: 'idle' }],
      }),
    });
    h.handle.submit(prompt('hello'));
    const text = await h.nextDelivered();
    expect(text).toContain('You are Agent [agent_agent0000000].');
    expect(text).toContain('- Beta [agent_beta00000000] (anthropic, idle)');
    expect(text.endsWith('[Ada]: hello')).toBe(true);
  });

  it('calls roster() fresh for the SECOND delivery rather than reusing the first answer', async () => {
    let endTurn: () => void = () => undefined;
    const turnOver = new Promise<void>((resolve) => {
      endTurn = resolve;
    });
    let calls = 0;
    const h = harnessCapturingPrompt(
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
      {
        roster: () => {
          calls += 1;
          // Alone on the first delivery, joined by Beta by the second — a
          // spawn that happened mid-turn must show up on the NEXT turn
          // without restarting anything (I1: one query() for the room's
          // whole life).
          return calls === 1
            ? null
            : {
                selfDisplayName: 'Agent',
      selfAgentId: 'agent_agent0000000',
                others: [{ displayName: 'Beta', agentId: 'agent_beta00000000', provider: 'anthropic', status: 'working' }],
              };
        },
      },
    );

    h.handle.submit(prompt('first'));
    expect(await h.nextDelivered()).toBe('[Ada]: first');

    h.handle.submit(prompt('second', false));
    endTurn();
    const second = await h.nextDelivered();
    expect(second).toContain('You are Agent [agent_agent0000000].');
    expect(second).toContain('- Beta [agent_beta00000000] (anthropic, working)');
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
