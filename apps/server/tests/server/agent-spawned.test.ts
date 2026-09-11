/**
 * Tests for the phase-10 wiring in `src/server/ws.ts`: `attachAgent`
 * constructs through `createRuntime` (`runtime/factory.ts`) instead of
 * calling `startAgent` directly, defaults to the `anthropic` provider so
 * every pre-phase-10 caller is unaffected, and logs `agent_spawned` so the
 * fleet is derivable from the log alone (I3) — but only the first time an
 * agent id is genuinely new, never on a recovery reattach.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSpawned, NexusEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const CWD = '/tmp/nexus-agent-spawned-fixture'; // never read: every stub agent below is silent

const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

afterEach(() => {
  __resetRuntimes();
});

function agentSpawnedEvents(events: NexusEvent[]): AgentSpawned[] {
  return events.filter((event): event is AgentSpawned => event.type === 'agent_spawned');
}

describe('attachAgent → createRuntime wiring', () => {
  it('logs agent_spawned for the primary agent with provider "anthropic" when none is named', () => {
    const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
    const sink = new MemorySink();
    attachRoom(room, sink, { runQuery: stubQuery });

    const spawned = agentSpawnedEvents(sink.read());
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      provider: 'anthropic',
      model: null,
      participantId: null,
      spawnedByName: null,
    });
    // The primary agent is never stamped with an agentId (see commitAs's own
    // comment) — absence IS what "primary agent" means on the wire (I3).
    expect(spawned[0]?.agentId).toBeUndefined();
  });

  it('does not log a second agent_spawned when a room with existing history is reattached (a restart, not a spawn)', () => {
    const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
    const sink = new MemorySink();
    // First attach — this process's first time seeing the room.
    attachRoom(room, sink, { runQuery: stubQuery });
    expect(agentSpawnedEvents(sink.read())).toHaveLength(1);

    // Simulate a restart: the in-memory runtime map is cleared (as it would
    // be by a fresh server process), but the log — a real durable log in
    // production — survives and is handed back unchanged.
    __resetRuntimes();
    attachRoom(room, sink, { runQuery: stubQuery });

    // Still exactly one. The log is append-only (I3): a second one here
    // would mean a room surviving N restarts accumulates N duplicates
    // forever.
    expect(agentSpawnedEvents(sink.read())).toHaveLength(1);
  });

  it('attaching a second, genuinely new agent id logs its own agent_spawned, stamped with its id', () => {
    const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
    const sink = new MemorySink();
    const runtime = attachRoom(room, sink, { runQuery: stubQuery });

    runtime.attachAgent('reviewer', { runQuery: stubQuery });

    const spawned = agentSpawnedEvents(sink.read());
    expect(spawned).toHaveLength(2);
    const reviewer = spawned.find((e) => e.agentId === 'reviewer');
    expect(reviewer).toBeDefined();
    expect(reviewer?.provider).toBe('anthropic');
  });

  it('an explicit provider argument is what agent_spawned records — absent one still means anthropic', () => {
    const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
    const sink = new MemorySink();
    const runtime = attachRoom(room, sink, { runQuery: stubQuery });

    // The primary agent's id is already taken by the first attach inside
    // `attachRoom` above (I1 — attaching an existing id returns the existing
    // handle rather than re-spawning), so this exercises a fresh id instead.
    runtime.attachAgent('second', { runQuery: stubQuery }, 'anthropic');

    const spawned = agentSpawnedEvents(sink.read()).find((e) => e.agentId === 'second');
    expect(spawned?.provider).toBe('anthropic');
  });

  it('re-attaching the SAME agent id in one process returns the existing handle and logs nothing new (I1)', () => {
    const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
    const sink = new MemorySink();
    const runtime = attachRoom(room, sink, { runQuery: stubQuery });

    const first = runtime.getAgent(PRIMARY_AGENT_ID);
    const again = runtime.attachAgent(PRIMARY_AGENT_ID, { runQuery: stubQuery });

    expect(again).toBe(first);
    expect(agentSpawnedEvents(sink.read())).toHaveLength(1);
  });
});
