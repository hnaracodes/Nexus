/**
 * Phase 12 — the fleet manager (`src/server/fleet.ts`).
 *
 * Exercised against the REAL `attachRoom` (`ws.ts`) with a silent stub agent —
 * the same harness `agent-registry.test.ts` and `agent-spawned.test.ts` use.
 * `FleetRuntime` (fleet.ts) is declared locally as a structural subset of
 * `RoomRuntime`; running these tests against the real thing is partly what
 * proves that subset is actually satisfied, not just assumed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';
import type { AgentSpawned, NexusEvent } from '@nexus/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';
import {
  buildRosterView,
  canSpawn,
  computeResourceCap,
  fleetSnapshot,
  spawnAgent,
  stopAgent,
} from '../../src/server/fleet.js';
import { createTurnGate } from '../../src/server/turnGate.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const CWD = '/tmp/nexus-fleet-test-fixture'; // never read: the stub agent below never touches disk

/** Same silent stub `agent-registry.test.ts` / `agent-spawned.test.ts` use —
 *  no messages, no tool calls, until a test drives a gate directly. */
const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

const BY = { participantId: 'p_ada', displayName: 'Ada' };

/** Every runtime a test attaches, so teardown can settle and stop everything
 *  it started — mirrors agent-registry.test.ts's own teardown, and for the
 *  same reason: an unsettled request is a live 120s timer per test. */
const attached: ReturnType<typeof attachRoom>[] = [];

function attach(): ReturnType<typeof attachRoom> {
  const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
  const runtime = attachRoom(room, new MemorySink(), { runQuery: stubQuery });
  attached.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of attached) {
    for (const handle of runtime.agents.values()) {
      for (const id of handle.gate.pendingIds()) {
        handle.gate.resolve(id, {
          decision: 'deny',
          participantId: null,
          displayName: null,
          via: 'timeout',
          reason: 'test teardown',
        });
      }
      handle.stop();
    }
    runtime.workspaceWatcher.close();
  }
  attached.length = 0;
  __resetRuntimes();
});

function agentSpawnedEvents(events: NexusEvent[]): AgentSpawned[] {
  return events.filter((event): event is AgentSpawned => event.type === 'agent_spawned');
}

describe('spawnAgent', () => {
  it('mints two distinct agent ids for two agents with the same display name', () => {
    const runtime = attach();

    const first = spawnAgent({ runtime, displayName: 'Reviewer', provider: 'anthropic', model: null, by: BY });
    const second = spawnAgent({ runtime, displayName: 'Reviewer', provider: 'anthropic', model: null, by: BY });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.agentId).not.toBe(second.agentId);
  });

  it("logs agent_spawned with the caller's real metadata, not attachAgent's generic fallback", () => {
    const runtime = attach();

    const result = spawnAgent({
      runtime,
      displayName: 'Refactor bot',
      provider: 'anthropic',
      model: 'claude-opus-5',
      by: BY,
      configName: 'reviewer-config',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spawned = agentSpawnedEvents(runtime.sink.read()).filter(
      (event) => agentIdOf(event) === result.agentId,
    );
    // Exactly one: attachAgent's own "first ever event for this id" auto-emit
    // (ws.ts) must have seen this id as already-known — from the commit
    // spawnAgent makes BEFORE calling attachAgent — and skipped its generic
    // fallback. Two would mean this id got double-logged, an I3 violation.
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      displayName: 'Refactor bot',
      provider: 'anthropic',
      model: 'claude-opus-5',
      participantId: 'p_ada',
      spawnedByName: 'Ada',
      configName: 'reviewer-config',
    });
  });

  it("never hands out a stopped agent's id again", () => {
    const runtime = attach();
    // First offers 'agent_dup' twice, then 'agent_fresh'. The real id
    // generator is a random UUID and collisions are astronomically unlikely —
    // this proves the RETIREMENT CHECK actually rejects a reused id, rather
    // than merely trusting randomness never to repeat.
    const ids = ['agent_dup', 'agent_dup', 'agent_fresh'];
    const nextId = () => ids.shift() ?? 'agent_overflow';

    const first = spawnAgent({
      runtime,
      displayName: 'A',
      provider: 'anthropic',
      model: null,
      by: BY,
      nextId,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.agentId).toBe('agent_dup');

    expect(stopAgent({ runtime, agentId: first.agentId, by: BY })).toEqual({ ok: true });

    // The generator offers 'agent_dup' again first. mintAgentId must reject it
    // — the log already has an agent_spawned for it, retired for the room's
    // lifetime, not merely "not currently live" — and fall through.
    const second = spawnAgent({
      runtime,
      displayName: 'B',
      provider: 'anthropic',
      model: null,
      by: BY,
      nextId,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.agentId).toBe('agent_fresh');
    expect(second.agentId).not.toBe(first.agentId);
  });

  it('refuses to spawn past the resource cap without minting or logging anything', () => {
    const runtime = attach();
    const tiny = { totalMemBytes: 1 }; // forces the floor cap (2) regardless of the test host's real memory

    const filler = spawnAgent({ runtime, displayName: 'Filler', provider: 'anthropic', model: null, by: BY, ...tiny });
    expect(filler.ok).toBe(true); // primary + Filler == the floor cap, still allowed

    const refused = spawnAgent({
      runtime,
      displayName: 'One too many',
      provider: 'anthropic',
      model: null,
      by: BY,
      ...tiny,
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toMatch(/2/);
    expect(refused.reason.toLowerCase()).toContain('stop one');

    // Only the primary and Filler were ever logged — the refused attempt left
    // no trace (no wasted id, no orphaned agent_spawned).
    expect(agentSpawnedEvents(runtime.sink.read())).toHaveLength(2);
  });
});

describe('canSpawn', () => {
  it('reports ok while comfortably under the measured cap', () => {
    const runtime = attach();
    expect(canSpawn(runtime, { totalMemBytes: 16 * 1024 * 1024 * 1024 })).toEqual({ ok: true });
  });

  it('refuses past the resource cap, with a reason a human can act on', () => {
    const runtime = attach();
    // Bypass spawnAgent to attach a second agent directly, putting the room at
    // exactly the floor cap (primary + this one == 2, computeResourceCap(1)).
    runtime.attachAgent('extra', { runQuery: stubQuery });
    expect(computeResourceCap(1)).toBe(2);

    const result = canSpawn(runtime, { totalMemBytes: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/2/); // names the cap so a human knows the number, not just "no"
    expect(result.reason.toLowerCase()).toContain('stop one'); // and what to do about it
  });
});

describe('stopAgent', () => {
  it('settles a pending approval rather than leaking it', async () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Runner', provider: 'anthropic', model: null, by: BY });
    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;

    const handle = runtime.getAgent(spawned.agentId);
    expect(handle).toBeDefined();
    if (handle === undefined) return;

    // Not awaited: the promise staying unsettled IS what a suspended tool call
    // looks like. `Promise`'s executor runs synchronously, so the request is
    // already registered on the gate the instant this call returns.
    const pending = handle.gate.request('Bash', { command: 'rm -rf /' });
    expect(handle.gate.pendingIds()).toHaveLength(1);

    const result = stopAgent({ runtime, agentId: spawned.agentId, by: BY });

    expect(result).toEqual({ ok: true });
    expect(handle.gate.pendingIds()).toHaveLength(0); // not leaked

    const decision = await pending; // must resolve, not hang forever
    expect(decision.decision).toBe('deny');
  });

  it('reports failure for an agent that does not exist, without throwing', () => {
    const runtime = attach();
    expect(stopAgent({ runtime, agentId: 'no-such-agent', by: BY }).ok).toBe(false);
  });

  it('reports failure for an agent already stopped, rather than double-logging agent_stopped', () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Twice', provider: 'anthropic', model: null, by: BY });
    if (!spawned.ok) throw new Error('setup failed');

    expect(stopAgent({ runtime, agentId: spawned.agentId, by: BY })).toEqual({ ok: true });
    expect(stopAgent({ runtime, agentId: spawned.agentId, by: BY }).ok).toBe(false);

    const stoppedEvents = runtime.sink.read().filter((event) => event.type === 'agent_stopped');
    expect(stoppedEvents).toHaveLength(1); // the log is append-only (I3); a bad second call must not add a second one
  });
});

describe('fleetSnapshot', () => {
  it('reports awaiting_approval — findable at a glance — for an agent with a pending request', () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Watcher', provider: 'anthropic', model: null, by: BY });
    if (!spawned.ok) throw new Error('setup failed');
    const handle = runtime.getAgent(spawned.agentId);
    if (handle === undefined) throw new Error('agent missing after spawnAgent');

    void handle.gate.request('Bash', { command: 'rm -rf /' });

    const entry = fleetSnapshot(runtime).find((e) => e.agentId === spawned.agentId);
    expect(entry?.status).toBe('awaiting_approval');
    expect(entry?.pendingApprovals).toBe(1);

    // Settle so this test doesn't leak a live 120s timer past its own end.
    const requestId = handle.gate.pendingIds()[0];
    if (requestId !== undefined) {
      handle.gate.resolve(requestId, {
        decision: 'deny',
        participantId: null,
        displayName: null,
        via: 'timeout',
        reason: 'test cleanup',
      });
    }
  });

  it('reports stopped for a stopped agent, with no pending approvals or queued prompts', () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Gone', provider: 'anthropic', model: null, by: BY });
    if (!spawned.ok) throw new Error('setup failed');

    stopAgent({ runtime, agentId: spawned.agentId, by: BY });

    const entry = fleetSnapshot(runtime).find((e) => e.agentId === spawned.agentId);
    expect(entry?.status).toBe('stopped');
    expect(entry?.pendingApprovals).toBe(0);
    expect(entry?.queuedPrompts).toBe(0);
  });

  it('reports idle for the primary agent in a fresh room', () => {
    const runtime = attach();
    const entry = fleetSnapshot(runtime).find((e) => e.agentId === PRIMARY_AGENT_ID);
    expect(entry?.status).toBe('idle');
    expect(entry?.displayName).toBe('Agent');
  });
});

describe('I1 — an agent already attached is never re-instantiated', () => {
  it('attachAgent on an id spawnAgent already attached returns the SAME handle', () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Once', provider: 'anthropic', model: null, by: BY });
    if (!spawned.ok) throw new Error('setup failed');

    const first = runtime.getAgent(spawned.agentId);
    const again = runtime.attachAgent(spawned.agentId, { runQuery: stubQuery });

    expect(again).toBe(first);
    expect([...runtime.agents.keys()].filter((id) => id === spawned.agentId)).toHaveLength(1);
  });
});

/**
 * Phase 17d — agents know their siblings exist. `buildRosterView` is the
 * production `Roster` (turnGate.ts) for one agent, built from the SAME
 * `fleetSnapshot` a human's fleet panel reads — exercised here against the
 * REAL `attachRoom`, the same way the rest of this file proves `FleetRuntime`
 * is genuinely satisfied by `RoomRuntime`, not just assumed.
 */
describe('buildRosterView', () => {
  it('returns null for the primary agent alone in a fresh room — no roster, no preamble', () => {
    const runtime = attach();
    expect(buildRosterView(runtime, PRIMARY_AGENT_ID)).toBeNull();
  });

  it('returns null again once a spawned second agent is stopped — back to alone', () => {
    const runtime = attach();
    const spawned = spawnAgent({ runtime, displayName: 'Temp', provider: 'anthropic', model: null, by: BY });
    if (!spawned.ok) throw new Error('setup failed');
    expect(buildRosterView(runtime, PRIMARY_AGENT_ID)).not.toBeNull();

    stopAgent({ runtime, agentId: spawned.agentId, by: BY });
    expect(buildRosterView(runtime, PRIMARY_AGENT_ID)).toBeNull();
  });

  it("names the RECIPIENT correctly — same fleet, opposite self, from each side", () => {
    const runtime = attach();
    const alpha = spawnAgent({ runtime, displayName: 'Alpha', provider: 'anthropic', model: null, by: BY });
    const beta = spawnAgent({ runtime, displayName: 'Beta', provider: 'anthropic', model: null, by: BY });
    if (!alpha.ok || !beta.ok) throw new Error('setup failed');

    const alphaView = buildRosterView(runtime, alpha.agentId);
    const betaView = buildRosterView(runtime, beta.agentId);

    expect(alphaView?.selfDisplayName).toBe('Alpha');
    expect(alphaView?.others.map((o) => o.displayName).sort()).toEqual(['Agent', 'Beta']);

    expect(betaView?.selfDisplayName).toBe('Beta');
    expect(betaView?.others.map((o) => o.displayName).sort()).toEqual(['Agent', 'Alpha']);

    // And rendered through the SAME turnGate.ts render() a real turn uses:
    // Alpha's turn must say it is Alpha, Beta's must say it is Beta, from the
    // one identical fleet.
    const alphaText = createTurnGate().submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      alphaView,
    )?.text;
    const betaText = createTurnGate().submit(
      { seq: 1, displayName: 'Ada', text: 'go', wasDriver: true },
      betaView,
    )?.text;

    expect(alphaText).toContain(`You are Alpha [${alpha.agentId}].`);
    expect(alphaText).toContain(`- Beta [${beta.agentId}] (anthropic, idle)`);
    expect(betaText).toContain(`You are Beta [${beta.agentId}].`);
    expect(betaText).toContain(`- Alpha [${alpha.agentId}] (anthropic, idle)`);
  });
});
