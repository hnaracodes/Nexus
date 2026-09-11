import type { AgentId, AgentProvider, NexusEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
import type { PresenceEntry } from '@syncode/protocol/wire';
import { projectPresence } from '../server/presence.js';

export interface ReconstructedRoom {
  roomId: string;
  cwd: string;
  repoUrl: string | null;
  lastSeq: number;
  participants: PresenceEntry[];
  driverId: string | null;
  /** Requests that were still open when the log ended. */
  pendingApprovalIds: string[];
}

/**
 * The restart-recovery path calls this to rebuild a room's state from disk.
 * The live resume path (`?since=`) does not need it: a room that's still
 * attached in memory never lost its state, so it replays raw logged events
 * directly rather than re-deriving them.
 */
export function reconstruct(events: NexusEvent[]): ReconstructedRoom | null {
  const created = events.find(
    (event): event is Extract<NexusEvent, { type: 'room_created' }> => event.type === 'room_created',
  );
  if (created === undefined) return null;

  const open = new Set<string>();
  for (const event of events) {
    if (event.type === 'permission_requested') open.add(event.requestId);
    if (event.type === 'permission_decided') open.delete(event.requestId);
  }

  const { participants, driverId } = projectPresence(events);
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);

  return {
    roomId: created.roomId,
    cwd: created.cwd,
    repoUrl: created.repoUrl,
    lastSeq,
    participants,
    driverId,
    pendingApprovalIds: [...open],
  };
}

/**
 * Which agents this room has, derived from the log alone (I3).
 *
 * Restart recovery needs to rebuild the roster without a second source of
 * truth, and a room's agents are only ever knowable from what they did. The
 * primary agent is always first and always present: every event that predates
 * agent ids means the primary agent, and a room with no agent activity at all
 * still has one attached.
 *
 * Note this reads events through `agentIdOf`, so it treats an absent agentId as
 * the primary agent rather than as a distinct nameless agent — which is what
 * every line on the production volume is.
 */
export function projectAgents(events: NexusEvent[]): AgentId[] {
  const seen = new Set<AgentId>([PRIMARY_AGENT_ID]);
  for (const event of events) {
    // Only agent-scoped events carry the field; the rest read as primary and
    // are harmlessly absorbed by the set.
    seen.add(agentIdOf(event as { agentId?: AgentId }));
  }
  return [...seen];
}

/**
 * One agent's full identity, as the log tells it (phase 12, plan D5).
 *
 * `projectAgents` above answers "which ids exist" by watching for occurrences
 * — enough for a v1/v2 room where every id was `PRIMARY_AGENT_ID` and the only
 * question was ever "one or none". It cannot answer what an id in a fleet
 * actually IS: which provider, which model, whose idea it was, whether it is
 * still running. `agent_spawned` / `agent_stopped` carry exactly that, and were
 * added for exactly this purpose (see their doc comments in the protocol) — so
 * this reads those two event types instead of inferring from occurrence.
 */
export interface FleetEntry {
  agentId: AgentId;
  provider: AgentProvider;
  model: string | null;
  displayName: string;
  /** Who spawned it. Both null for the primary agent, which the room starts
   *  itself rather than a participant asking for it. */
  spawnedByParticipantId: string | null;
  spawnedByName: string | null;
  /** True once a matching `agent_stopped` has been seen for this id. */
  stopped: boolean;
  /** The `reason` off that `agent_stopped`, or null while still running. */
  stopReason: string | null;
}

/**
 * The room's fleet, in full, derived from the log alone (I3) — the sibling
 * `projectAgents` was missing (plan phase-12 D5). Does NOT replace it:
 * `projectAgents`'s bare-id, occurrence-based contract is pinned by tests
 * against a real pre-v3 fixture and production logs depend on its exact
 * semantics, so it is left untouched. This is an addition, read independently.
 *
 * The primary agent is seeded before the log is even read, the same rule
 * `projectAgents` already applies: every pre-v3 log predates `agent_spawned`
 * entirely (including everything on the production volume), and I3 forbids
 * rewriting those lines to add one. Absence has to keep meaning "the primary
 * agent, on the only provider that existed then", not "no agent".
 *
 * Order matters here, unlike `projectAgents`'s bare Set: events are folded in
 * log order, so a later `agent_spawned` overwrites an earlier one for the same
 * id (harmless — D2 says ids are never reused, so this never actually fires in
 * a valid log) and an `agent_stopped` after its `agent_spawned` correctly ends
 * up `stopped: true`. A log with `agent_spawned` then `agent_stopped` for one
 * id must never be read as "still running" — that is precisely what recovery
 * needs to tell a stopped agent from a live one instead of blindly re-attaching
 * everything `projectAgents` ever saw an id for.
 */
export function projectFleet(events: NexusEvent[]): FleetEntry[] {
  const byId = new Map<AgentId, FleetEntry>();
  byId.set(PRIMARY_AGENT_ID, {
    agentId: PRIMARY_AGENT_ID,
    provider: 'anthropic',
    model: null,
    displayName: 'Agent',
    spawnedByParticipantId: null,
    spawnedByName: null,
    stopped: false,
    stopReason: null,
  });

  for (const event of events) {
    if (event.type === 'agent_spawned') {
      const agentId = agentIdOf(event);
      byId.set(agentId, {
        agentId,
        provider: event.provider,
        model: event.model,
        displayName: event.displayName,
        spawnedByParticipantId: event.participantId,
        spawnedByName: event.spawnedByName,
        stopped: false,
        stopReason: null,
      });
    } else if (event.type === 'agent_stopped') {
      const agentId = agentIdOf(event);
      const existing = byId.get(agentId);
      if (existing !== undefined) {
        byId.set(agentId, { ...existing, stopped: true, stopReason: event.reason });
      } else {
        // Not reachable from a valid log — every `agent_stopped` follows an
        // `agent_spawned` for the same id. Recorded rather than dropped, so
        // this function stays total over whatever it is handed instead of
        // silently losing an event a caller might still expect to see.
        byId.set(agentId, {
          agentId,
          provider: 'anthropic',
          model: null,
          displayName: agentId,
          spawnedByParticipantId: null,
          spawnedByName: null,
          stopped: true,
          stopReason: event.reason,
        });
      }
    }
  }

  return [...byId.values()];
}
