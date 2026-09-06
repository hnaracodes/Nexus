import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentProvider, UnsequencedEvent } from '@nexus/protocol/events';
import { __resetRooms, createRoom } from '../../../src/server/rooms.js';
import type { Room } from '../../../src/server/rooms.js';
import { createRuntime } from '../../../src/server/runtime/factory.js';
import type { AgentRuntime } from '../../../src/server/runtime/types.js';

/**
 * One obviously-fake key per provider, matching the convention every other
 * runtime test in this repo already uses (`agent.ts`'s conformance test,
 * `gemini.test.ts`) — a value with each provider's rough shape but never a
 * real credential.
 */
const ANTHROPIC_KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const GOOGLE_KEY = 'AIzaSyTESTONLY0000000000000000000000000';
const OPENAI_KEY = 'sk-test-TESTONLY-not-a-real-key-000000000000';

function room(apiKey: string): Room {
  return createRoom({
    apiKey,
    cwd: mkdtempSync(join(tmpdir(), 'nexus-factory-')),
    repoUrl: null,
  });
}

/**
 * Same stub `agent.ts`'s own conformance test uses: an empty async-iterable
 * session, so `startAgent`'s read loop exits immediately with no real network
 * call and no dangling subprocess. Cast `as never` for the same reason that
 * file does — the installed SDK's `query()` return type is a large streaming
 * object this fake only needs to structurally cover the four members
 * `startAgent` actually calls.
 */
const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

/** The runtime-shape assertion every provider arm must pass, factored out so
 *  the three "assigns to AgentRuntime" cases below cannot drift apart. */
function expectRuntimeShape(runtime: AgentRuntime): void {
  for (const member of ['submit', 'interrupt', 'stop', 'setModel', 'listModels'] as const) {
    expect(typeof runtime[member], `${member} is missing`).toBe('function');
  }
  expect(runtime.gate, 'the gate is not exposed').toBeDefined();
  expect(typeof runtime.gate.request).toBe('function');
}

beforeEach(() => {
  __resetRooms();
});

describe('createRuntime', () => {
  it('dispatches "anthropic" to a runtime assignable to AgentRuntime with no cast', () => {
    // The load-bearing line for this arm: no `as AgentRuntime`, no wrapper.
    const runtime: AgentRuntime = createRuntime({
      provider: 'anthropic',
      room: room(ANTHROPIC_KEY),
      emit: () => undefined,
      deps: { runQuery: stubQuery },
    });
    expectRuntimeShape(runtime);
    runtime.stop();
  });

  it('dispatches "openai" to a runtime assignable to AgentRuntime with no cast', () => {
    // No `deps.openai.client` override needed: `startOpenAiAgent`'s default
    // client construction (`new OpenAI({ apiKey })`) makes no network call by
    // itself — only `responses.create` would, and this test never calls
    // `submit`, so it is never reached.
    const runtime: AgentRuntime = createRuntime({
      provider: 'openai',
      room: room(OPENAI_KEY),
      emit: () => undefined,
    });
    expectRuntimeShape(runtime);
    runtime.stop();
  });

  it('dispatches "google" to a runtime assignable to AgentRuntime with no cast', () => {
    // Same reasoning as the "openai" case above, for `new GoogleGenAI(...)`.
    const runtime: AgentRuntime = createRuntime({
      provider: 'google',
      room: room(GOOGLE_KEY),
      emit: () => undefined,
    });
    expectRuntimeShape(runtime);
    runtime.stop();
  });

  it('throws a clear error for an unknown provider rather than defaulting to Claude', () => {
    // Simulates a malformed persisted value: something that reached this
    // function typed as `AgentProvider` (e.g. cast off disk or off the wire)
    // without actually being one. Defaulting to Claude here would mean a room
    // that believes it is running OpenAI is actually spending an Anthropic
    // key — a billing lie and an attribution lie — so this must throw, not
    // silently fall through the switch.
    const bogus = 'mistral' as unknown as AgentProvider;
    expect(() =>
      createRuntime({ provider: bogus, room: room(ANTHROPIC_KEY), emit: () => undefined }),
    ).toThrow(/mistral/);
  });

  it('forwards the live room, not a snapshot: a driverId set AFTER construction reaches the next delivered batch', () => {
    const events: UnsequencedEvent[] = [];
    const theRoom = room(ANTHROPIC_KEY);
    const runtime = createRuntime({
      provider: 'anthropic',
      room: theRoom,
      emit: (event) => events.push(event),
      deps: { runQuery: stubQuery },
    });

    // Mutated AFTER createRuntime returns. If `createRuntime` (or the
    // provider function underneath it) had captured `room.driverId` at
    // construction instead of forwarding the live `room` object, this
    // mutation would never reach `deliver()` and I2′'s driver-precedence rule
    // would silently read a stale token on every future turn.
    theRoom.driverId = 'p_bob';

    runtime.submit({ seq: 1, displayName: 'Bob', text: 'hello', wasDriver: true });

    const delivered = events.find((event) => event.type === 'prompt_batch_delivered');
    expect(delivered).toBeDefined();
    expect((delivered as { driverId: string | null }).driverId).toBe('p_bob');

    runtime.stop();
  });
});
