import type { AgentId, NexusEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';
import type { PresenceEntry } from '@nexus/protocol/wire';
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
