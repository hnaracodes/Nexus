/**
 * Phase 13 — launching a saved crew (`src/server/crews.ts`).
 *
 * Exercised against the REAL `attachRoom` (`ws.ts`), the REAL fleet manager
 * (`fleet.ts`) and the REAL config store (`configStore.ts`) — same harness
 * discipline as `fleet.test.ts`: a silent stub agent so nothing here needs a
 * live API key, and a real `attachRoom` so the `FleetRuntime`/`CrewRuntime`
 * structural subset is actually exercised, not just assumed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSpawned, CrewLaunched, NexusEvent } from '@syncode/protocol/events';
import { agentIdOf } from '@syncode/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';
import { saveConfig, saveCrew } from '../../src/server/configStore.js';
import { launchCrew, projectCrews } from '../../src/server/crews.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const CWD = '/tmp/nexus-crews-test-fixture'; // never read: the stub agent below never touches disk

const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

const BY = { participantId: 'p_ada', displayName: 'Ada' };

const attached: ReturnType<typeof attachRoom>[] = [];

function attach(): ReturnType<typeof attachRoom> {
  const room = createRoom({ apiKey: KEY, cwd: CWD, repoUrl: null });
  const runtime = attachRoom(room, new MemorySink(), { runQuery: stubQuery });
  attached.push(runtime);
  return runtime;
}

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nexus-crews-test-'));
});

afterEach(() => {
  // Same teardown as fleet.test.ts: settle every pending approval before
  // stopping, or a leaked 120s decision timer outlives the test.
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

function saveReviewerConfig(name = 'reviewer'): void {
  const result = saveConfig(
    {
      name,
      description: 'Reviews diffs and comments',
      prompt: 'You review code. Be terse.',
      tools: ['Read', 'Grep'],
    },
    dataDir,
  );
  if (!result.ok) throw new Error(`fixture setup failed: ${result.problems.join(' ')}`);
}

function saveThreeMemberCrew(crewName = 'trio'): void {
  const result = saveCrew(
    {
      name: crewName,
      members: [
        { configName: 'reviewer', displayName: 'Reviewer', provider: 'anthropic' },
        { configName: 'reviewer', displayName: 'Tester', provider: 'anthropic' },
        { configName: 'reviewer', displayName: 'Scribe', provider: 'anthropic' },
      ],
    },
    dataDir,
  );
  if (!result.ok) throw new Error(`fixture setup failed: ${result.problems.join(' ')}`);
}

function crewLaunchedEvents(events: NexusEvent[]): CrewLaunched[] {
  return events.filter((event): event is CrewLaunched => event.type === 'crew_launched');
}

function agentSpawnedEvents(events: NexusEvent[]): AgentSpawned[] {
  return events.filter((event): event is AgentSpawned => event.type === 'agent_spawned');
}

/** Excludes the primary agent's own bootstrap `agent_spawned` — `attachRoom`
 *  (ws.ts) attaches it, and its generic fallback logs one, before any test
 *  here touches a crew. Its `participantId` is always `null` (ws.ts); a real
 *  member spawn always names the human who launched the crew. */
function memberSpawnedEvents(events: NexusEvent[]): AgentSpawned[] {
  return agentSpawnedEvents(events).filter((event) => event.participantId !== null);
}

describe('launchCrew', () => {
  it('spawns 3 agents and emits exactly ONE crew_launched naming all 3', () => {
    saveReviewerConfig();
    saveThreeMemberCrew();
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentIds).toHaveLength(3);

    const launched = crewLaunchedEvents(runtime.sink.read());
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      crewId: result.crewId,
      crewName: 'trio',
      participantId: 'p_ada',
      displayName: 'Ada',
    });
    // Order-sensitive: launch order is the crew's own member order (configStore.ts).
    expect(launched[0]?.agentIds).toEqual(result.agentIds);

    // Every named id is a real, live agent — not a name invented after the
    // fact (I3: a log naming agents that were never spawned is
    // unreconstructible state).
    for (const agentId of result.agentIds) {
      expect(runtime.getAgent(agentId)).toBeDefined();
    }
  });

  it("carries each member's configName on its own agent_spawned", () => {
    saveReviewerConfig();
    saveThreeMemberCrew();
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spawned = agentSpawnedEvents(runtime.sink.read()).filter((event) =>
      result.agentIds.includes(agentIdOf(event)),
    );
    expect(spawned).toHaveLength(3);
    for (const event of spawned) {
      expect(event.configName).toBe('reviewer');
    }
  });

  // BLOCKED (reported to the orchestrator): `fleet.ts`'s `SpawnAgentArgs` has
  // no `crewId` field, and `spawnAgent`'s own `agent_spawned` commit is the
  // ONLY writer for a freshly minted id (its comment explains why — committing
  // first is what makes `attachAgent`'s generic fallback never fire). There is
  // no seam in fleet.ts today for crews.ts to make that same commit carry a
  // crewId, and the log is append-only (I3) — this file cannot patch the event
  // in after the fact. Fixing this needs `SpawnAgentArgs` to grow an optional
  // `crewId?: string`, threaded into the commit exactly like `configName` is.
  // Left as `.skip`, not deleted, so the gap stays visible in the suite rather
  // than silently passing on a weakened assertion.
  it.skip('carries the crewId on every member agent_spawned (blocked on fleet.ts SpawnAgentArgs)', () => {
    saveReviewerConfig();
    saveThreeMemberCrew();
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spawned = agentSpawnedEvents(runtime.sink.read()).filter((event) =>
      result.agentIds.includes(agentIdOf(event)),
    );
    for (const event of spawned) {
      expect(event.crewId).toBe(result.crewId);
    }
  });

  it('fails with an actionable message past the resource cap, and leaves no orphan agents running', () => {
    saveReviewerConfig();
    saveThreeMemberCrew(); // 3 members
    const runtime = attach();

    // Floor cap is 2 (fleet.ts's MIN_AGENT_CAP). The room's primary agent
    // already occupies one slot, so only ONE more agent can ever run — a
    // 3-member crew cannot fit, no matter the launch order.
    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir, totalMemBytes: 1 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/2/); // names the cap, same discipline as fleet.ts's own message
    expect(result.reason).toMatch(/1 of 3/); // names how many launched before the cap bit

    // Not a half-launch: whatever this call spawned, it also stopped. Only the
    // primary agent is left running.
    const stillRunning = [...runtime.agents.keys()].filter((id) => {
      const stoppedIds = runtime.sink
        .read()
        .filter((e) => e.type === 'agent_stopped')
        .map((e) => agentIdOf(e));
      return !stoppedIds.includes(id);
    });
    expect(stillRunning).toEqual(['primary']);

    // And no crew_launched was ever emitted for a crew that doesn't fully exist.
    expect(crewLaunchedEvents(runtime.sink.read())).toHaveLength(0);

    // The member(s) this call spawned-then-rolled-back DO carry a normal
    // spawned+stopped pair — that's an ordinary agent lifecycle, not a defect —
    // but nothing claims they were ever part of a launched crew.
    expect(memberSpawnedEvents(runtime.sink.read())).toHaveLength(1);
  });

  it('fails cleanly for a crew name that was never saved, without spawning anything', () => {
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'does-not-exist', by: BY, dataDir });

    expect(result.ok).toBe(false);
    expect(memberSpawnedEvents(runtime.sink.read())).toHaveLength(0);
  });

  it("fails cleanly when a member's config no longer resolves, before spawning any member", () => {
    // 'reviewer' config deliberately never saved.
    saveThreeMemberCrew();
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('reviewer');
    // All-or-nothing means "before spawning any member" — a config missing
    // for member 2 must not have let member 1 spawn and then orphan it.
    expect(memberSpawnedEvents(runtime.sink.read())).toHaveLength(0);
  });
});

describe('projectCrews — I3, no second source of truth', () => {
  it("reconstructs a launched crew's membership from the log alone", () => {
    saveReviewerConfig();
    saveThreeMemberCrew();
    const runtime = attach();

    const result = launchCrew({ runtime, crewName: 'trio', by: BY, dataDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Simulate a restart: nothing but the raw event array survives a process
    // bounce (this is exactly what `openLog`/replay.ts hands back on boot).
    // Round-tripping through JSON severs any object-identity shortcut a lazier
    // implementation might lean on.
    const replayed = JSON.parse(JSON.stringify(runtime.sink.read())) as NexusEvent[];

    const crews = projectCrews(replayed);
    expect(crews).toHaveLength(1);
    expect(crews[0]).toEqual({
      crewId: result.crewId,
      crewName: 'trio',
      agentIds: result.agentIds,
    });
  });

  it('returns nothing for a log with no crew_launched event', () => {
    const runtime = attach();
    expect(projectCrews(runtime.sink.read())).toEqual([]);
  });
});
