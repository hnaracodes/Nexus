/**
 * The fleet manager (phase 12).
 *
 * Owns POLICY only — who may spawn an agent, how many may run at once, what an
 * agent's status looks like from the outside. The mechanism it builds on
 * (`RoomRuntime.attachAgent`, I1's per-agent enforcement point) already exists
 * in `ws.ts` and is not rebuilt here.
 *
 * This module never imports `ws.ts`. `FleetRuntime` below names, structurally,
 * exactly the slice of `RoomRuntime` this file calls — a real `RoomRuntime`
 * satisfies it with no adapter, but the dependency points the other way:
 * `ws.ts` (the integrator) reaches for this module, never the reverse. Doing
 * it with a real import of `RoomRuntime` would make `ws.ts` <-> `fleet.ts` a
 * cycle the moment `ws.ts` calls back into this file.
 */
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import type { AgentId, AgentProvider, NexusEvent, UnsequencedEvent } from '@nexus/protocol/events';
import { agentIdOf } from '@nexus/protocol/events';
import type { AgentStatus, FleetEntry } from '@nexus/protocol/wire';
import { projectAgents } from '../log/replay.js';
import type { AgentDeps, AgentHandle, Interrupter } from './agent.js';

/**
 * The subset of `RoomRuntime` (`ws.ts`) this module actually calls, declared
 * locally rather than imported — see the module comment above. Every member's
 * signature is copied verbatim from `ws.ts` so a real `RoomRuntime` is
 * assignable here with zero glue code.
 */
export interface FleetRuntime {
  readonly agents: ReadonlyMap<AgentId, AgentHandle>;
  getAgent(agentId?: AgentId): AgentHandle | undefined;
  attachAgent(agentId: AgentId, deps?: AgentDeps, provider?: AgentProvider): AgentHandle;
  commitAs(agentId: AgentId, event: UnsequencedEvent): NexusEvent;
  sink: { read(): NexusEvent[] };
}

/* -------------------------------------------------------------------------
 * D1 — the RESOURCE cap. Measured, not guessed, and NOT the governance cap.
 *
 * The v2 design guessed ~1 GiB/session and proposed a fixed cap of 4. Measured
 * 2026-09-01: ~187 MB MARGINAL per concurrent session (69 MB baseline, 1188 MB
 * at six), and the marginal cost FALLS with count — a fixed cap of 4 would idle
 * most of a 16 GB machine. So the cap is derived from live memory, with a floor
 * (a resource-starved host should still host the primary agent plus one more —
 * one agent is not a fleet) and a ceiling (a sanity backstop against a runaway
 * spawn loop on a huge box, deliberately far above any number a human could
 * supervise, so it is never mistaken for the GOVERNANCE cap on how many agents
 * may be simultaneously blocked on a person — that cap belongs to the approval
 * queue (phase-12-fleet.md D1/D3), not here).
 * ---------------------------------------------------------------------- */

const BYTES_PER_AGENT = 200 * 1024 * 1024; // ~187 MB measured, rounded up for headroom
const MIN_AGENT_CAP = 2;
const MAX_AGENT_CAP = 64;

/** Exported so a caller (or a test) can see what the machine allows without
 *  going through `canSpawn`'s running-count check. */
export function computeResourceCap(totalMemBytes: number): number {
  const byMemory = Math.floor(totalMemBytes / BYTES_PER_AGENT);
  return Math.min(MAX_AGENT_CAP, Math.max(MIN_AGENT_CAP, byMemory));
}

/** Ids with a logged `agent_stopped` — retired, but still occupying a slot in
 *  `runtime.agents` because nothing in `ws.ts` removes a stopped handle from
 *  the map (there is no room-teardown path for a single agent, only the whole
 *  room — see `RoomRuntime.workspaceWatcher`'s own comment for the same gap).
 *  So "how many agents are running" is the map size MINUS this set, not the
 *  map size alone. */
function stoppedAgentIds(runtime: FleetRuntime): Set<AgentId> {
  const stopped = new Set<AgentId>();
  for (const event of runtime.sink.read()) {
    if (event.type === 'agent_stopped') stopped.add(agentIdOf(event));
  }
  return stopped;
}

export interface CanSpawnOptions {
  /** Overrides `os.totalmem()`. Test seam only — the cap must never depend on
   *  the memory of whatever machine happens to run the suite. */
  totalMemBytes?: number;
}

export type CanSpawnResult = { ok: true } | { ok: false; reason: string };

export function canSpawn(runtime: FleetRuntime, options: CanSpawnOptions = {}): CanSpawnResult {
  const cap = computeResourceCap(options.totalMemBytes ?? totalmem());
  const stopped = stoppedAgentIds(runtime);
  const running = [...runtime.agents.keys()].filter((id) => !stopped.has(id)).length;
  if (running >= cap) {
    return {
      ok: false,
      reason:
        `This machine can run about ${cap} agent${cap === 1 ? '' : 's'} at once ` +
        `(estimated from available memory), and ${running} ${running === 1 ? 'is' : 'are'} already running. ` +
        'Stop one before starting another.',
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------
 * D2 — ids are minted server-side and never reused.
 *
 * `spawn_agent` carries no id on the wire (packages/protocol/src/wire.ts) on
 * purpose: a client-chosen id could collide with a live agent and merge two
 * agents' work into one transcript. "Never reused" means never reused for the
 * ROOM'S LIFETIME, not just while the original is running — `projectAgents`
 * reads the whole log, so a ago-stopped agent's id is exactly as retired as a
 * live one's.
 * ---------------------------------------------------------------------- */

function defaultNextId(): AgentId {
  return `agent_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function mintAgentId(runtime: FleetRuntime, nextId: () => AgentId): AgentId {
  const everUsed = new Set(projectAgents(runtime.sink.read()));
  let candidate = nextId();
  // A real random id practically never loops more than once; this loop is
  // what makes that a guarantee rather than a hope, and what a test can prove
  // without waiting on astronomical odds — see fleet.test.ts's injected
  // `nextId` seam below.
  while (everUsed.has(candidate) || runtime.agents.has(candidate)) {
    candidate = nextId();
  }
  return candidate;
}

export interface SpawnAgentArgs {
  runtime: FleetRuntime;
  displayName: string;
  provider: AgentProvider;
  model: string | null;
  /** Who asked for this agent. Always a person — the primary agent is started
   *  by the room itself and never goes through this function. */
  by: Interrupter;
  /** Which saved configuration produced it (phase 13). Never inlined here — see
   *  wire.ts's `spawn_agent` comment on why a config's contents never ride the
   *  socket frame that requests it. */
  configName?: string;
  /** Threaded straight through to `attachAgent` — a test's stub `runQuery` (or
   *  the OpenAI/Gemini equivalents), never anything provider-specific decided
   *  in this file. */
  deps?: AgentDeps;
  /** Test seam for `canSpawn`'s resource check. */
  totalMemBytes?: number;
  /** Test seam for id minting. Defaults to a fresh random id per call. */
  nextId?: () => AgentId;
}

export type SpawnAgentResult = { ok: true; agentId: AgentId } | { ok: false; reason: string };

export function spawnAgent(args: SpawnAgentArgs): SpawnAgentResult {
  // Conditionally spread rather than `{ totalMemBytes: args.totalMemBytes }`:
  // with `exactOptionalPropertyTypes` (tsconfig.json), an optional field typed
  // `number` may not be explicitly set to `undefined`, which a bare object
  // literal would do whenever the caller omitted it.
  const cap = canSpawn(
    args.runtime,
    args.totalMemBytes === undefined ? {} : { totalMemBytes: args.totalMemBytes },
  );
  if (!cap.ok) return cap;

  const agentId = mintAgentId(args.runtime, args.nextId ?? defaultNextId);

  // Logged with the CALLER's real metadata before `attachAgent` runs.
  // `attachAgent` (ws.ts) auto-logs a generic `agent_spawned` itself the first
  // time it sees a brand-new id — `displayName: agentId`, `participantId:
  // null` — because that path also has to cover the primary agent at room
  // creation and a restart's reattachment, neither of which has a human
  // spawner to name. Committing the real event FIRST means `attachAgent`'s own
  // "has this id ever appeared in the log" check (ws.ts) already reads true, so
  // its generic fallback never fires and this id gets exactly one
  // `agent_spawned`, carrying the display name a person actually chose.
  args.runtime.commitAs(agentId, {
    type: 'agent_spawned',
    provider: args.provider,
    model: args.model,
    displayName: args.displayName,
    participantId: args.by.participantId,
    spawnedByName: args.by.displayName,
    ...(args.configName === undefined ? {} : { configName: args.configName }),
  });

  args.runtime.attachAgent(agentId, args.deps, args.provider);

  return { ok: true, agentId };
}

/* -------------------------------------------------------------------------
 * Stopping an agent.
 * ---------------------------------------------------------------------- */

export interface StopAgentArgs {
  runtime: FleetRuntime;
  agentId: AgentId;
  by: Interrupter;
}

export type StopAgentResult = { ok: true } | { ok: false; reason: string };

export function stopAgent(args: StopAgentArgs): StopAgentResult {
  const { runtime, agentId, by } = args;
  const handle = runtime.getAgent(agentId);
  if (handle === undefined) {
    return { ok: false, reason: `No agent "${agentId}" is running in this room.` };
  }
  if (stoppedAgentIds(runtime).has(agentId)) {
    return { ok: false, reason: `Agent "${agentId}" was already stopped.` };
  }

  // Settle every approval this agent still holds BEFORE tearing down its
  // runtime. `permissions.ts`'s gate settles a pending request when its
  // `signal` aborts, but `AgentRuntime.stop()` is not proof that happens for
  // every provider — Claude's own `stop()` (agent.ts) only closes the prompt
  // queue feeding `query()`; it does not abort the signal `canUseTool`/the
  // `PreToolUse` hook were given, which is owned by the SDK's own session
  // lifecycle, not by this call. Settling explicitly here means a pending
  // approval never outlives its agent regardless of what a given provider's
  // `stop()` does or does not cascade into (landmine C, phase-12-fleet.md).
  for (const requestId of handle.gate.pendingIds()) {
    handle.gate.resolve(requestId, {
      decision: 'deny',
      participantId: null,
      displayName: null,
      via: 'aborted',
      reason: 'The agent was stopped before the room decided.',
    });
  }

  handle.stop();

  runtime.commitAs(agentId, {
    type: 'agent_stopped',
    reason: 'stopped',
    participantId: by.participantId,
    stoppedByName: by.displayName,
  });

  return { ok: true };
}

/* -------------------------------------------------------------------------
 * D5 — fleet snapshot. Membership + metadata come from the log (I3); whether
 * an agent is mid-turn does not (that's exactly the role `connected` plays on
 * `PresenceEntry`), so status blends a live read (`gate.pendingIds()`) with the
 * log's own coarse phase markers.
 * ---------------------------------------------------------------------- */

interface AgentMeta {
  displayName: string;
  provider: AgentProvider;
  model: string | null;
}

/** The metadata half of the roster: what `agent_spawned` (and any later
 *  `model_changed`) said about each id. Deliberately NOT `projectAgents`
 *  (log/replay.ts) — that function returns bare ids by design (see its own
 *  doc comment) and is pinned by tests on pre-v3 logs; this is a fleet.ts-local
 *  read of the same log for the richer fields phase 12 needs, not a change to
 *  that function's contract. */
function projectAgentMeta(events: NexusEvent[]): Map<AgentId, AgentMeta> {
  const meta = new Map<AgentId, AgentMeta>();
  for (const event of events) {
    if (event.type === 'agent_spawned') {
      meta.set(agentIdOf(event), {
        displayName: event.displayName,
        provider: event.provider,
        model: event.model,
      });
      continue;
    }
    if (event.type === 'model_changed') {
      const id = agentIdOf(event);
      const existing = meta.get(id);
      if (existing !== undefined) meta.set(id, { ...existing, model: event.model });
    }
  }
  return meta;
}

/**
 * The coarse phase implied by an agent's own logged lifecycle events, in
 * order. `awaiting_approval` is NOT decided here — it overrides this in
 * `fleetSnapshot` from the LIVE gate, per the module comment above, since a
 * pending approval is exactly the kind of right-now state the log cannot
 * reconstruct on its own.
 */
function lifecyclePhase(agentId: AgentId, events: NexusEvent[]): 'idle' | 'working' | 'error' {
  let phase: 'idle' | 'working' | 'error' = 'idle';
  for (const event of events) {
    if (agentIdOf(event as { agentId?: AgentId }) !== agentId) continue;
    switch (event.type) {
      case 'agent_spawned':
      case 'agent_idle':
        phase = 'idle';
        break;
      case 'prompt_batch_delivered':
        phase = 'working';
        break;
      case 'agent_error':
        phase = 'error';
        break;
      default:
        break; // tool_start / tool_result / assistant_message don't change the coarse phase
    }
  }
  return phase;
}

export function fleetSnapshot(runtime: FleetRuntime): FleetEntry[] {
  const events = runtime.sink.read();
  const meta = projectAgentMeta(events);
  const stopped = stoppedAgentIds(runtime);

  const entries: FleetEntry[] = [];
  for (const [agentId, handle] of runtime.agents) {
    const info = meta.get(agentId) ?? { displayName: agentId, provider: 'anthropic' as AgentProvider, model: null };
    const isStopped = stopped.has(agentId);
    const pendingApprovals = isStopped ? 0 : handle.gate.pendingIds().length;

    let status: AgentStatus;
    if (isStopped) status = 'stopped';
    else if (pendingApprovals > 0) status = 'awaiting_approval';
    else status = lifecyclePhase(agentId, events);

    entries.push({
      agentId,
      displayName: info.displayName,
      provider: info.provider,
      model: info.model,
      status,
      pendingApprovals,
      // NOT derivable from what's exposed today. `UserPrompt` (events.ts) is
      // not `AgentScoped` — the log has no record of which agent a queued
      // prompt is FOR, only `spawn_agent`'s wire-level `agentId` routing hint,
      // which is never persisted onto the event. `agent.ts`'s `TurnGate` holds
      // the live buffer that WOULD answer this, but it is internal to
      // `startAgent`/`createRuntime` and not exposed on `AgentRuntime`. Reported
      // as a real gap (see the session report) rather than guessed at with a
      // number that would look authoritative and be wrong.
      queuedPrompts: 0,
    });
  }
  return entries;
}
