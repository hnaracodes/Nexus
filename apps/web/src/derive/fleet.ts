import type { AgentId, AgentProvider, NexusEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';

/**
 * Pure derivations over the event log for the fleet (phase 12) — zero React,
 * zero store import, following `workspaceFiles.ts` exactly. `store.ts`'s flat
 * `messages` array stays the primary agent's alias (phase 8b decision,
 * CLAUDE.md §5 I1) and forty-odd tests read it; nothing here changes that.
 * These functions read the same `events` array `store.ts` already keeps on
 * `RoomView.events` and re-derive a per-agent view beside it, never instead
 * of it.
 */

/**
 * A room-transcript row. Deliberately duplicated from `store.ts`'s `Message`
 * rather than imported — this module must stay independent of the reducer, the
 * same rule `workspaceFiles.ts` already follows. Keep the two shapes in sync by
 * hand; a mismatch would only matter at the one call site that hands a
 * `deriveAgentTranscripts` result to something expecting `store.ts`'s type, and
 * TypeScript's structural typing catches that for free.
 */
export interface Message {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  author: string | null;
  text: string;
  seq: number;
  /** `=== true` only — optional means "unknown", never "false". Mirrors
   *  `UserPrompt.wasDriver` and `store.ts`'s identical field. */
  wasDriver?: boolean;
}

/**
 * One agent's identity, as the log tells it (plan phase-12 D5's client-side
 * sibling). Mirrors `apps/server/src/log/replay.ts#FleetEntry` field-for-field
 * — that module is server-internal (`apps/server/src/log/`) and this is
 * `apps/web`, so the shape is re-derived here rather than imported across the
 * app boundary. Named `AgentDescriptor`, not `FleetEntry`, to avoid colliding
 * with `@nexus/protocol/wire`'s `FleetEntry`, which is the LIVE transient
 * status (idle/working/awaiting_approval) this type deliberately omits: that
 * is presence, not history, and only the server can say it (I3 — liveness is
 * not in the log).
 */
export interface AgentDescriptor {
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

/** One in-flight streaming assistant message, keyed by its `messageId`. */
export interface PendingDelta {
  /** From the `assistant_delta` frame. Absence there already defaults to
   *  `PRIMARY_AGENT_ID` at the point the frame is read — see the note on
   *  `routeDeltas` below for why that default must be applied BEFORE this
   *  type is populated, not inside this module. */
  agentId: AgentId;
  text: string;
}

function ensure<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = make();
    map.set(key, value);
  }
  return value;
}

/**
 * Every message an agent produced or was addressed to, split by agent and kept
 * in seq order — the fleet's per-agent equivalent of `store.ts`'s flat
 * `messages`. Room-wide events (someone joined, the driver changed, the room
 * itself opened) carry no `agentId` at all — they are not any one agent's
 * doing — so they are broadcast into every transcript known so far, the same
 * way they already appear unconditionally in `store.ts`'s single flat list.
 * That is what makes a pre-v3 log, which only ever has the primary agent,
 * come out identical to today's `view.messages`: broadcasting to "every known
 * agent" broadcasts to just the primary, because that is the only entry
 * `knownAgents` ever holds.
 *
 * A `user_prompt` is a harder case: the logged event carries no `agentId` at
 * all (a prompt is typed by a person, not scoped to an agent the way a tool
 * call is), so which agent's pane should show it is only knowable once a
 * `prompt_batch_delivered` names which agent actually received it. Until that
 * happens — still queued — it belongs to no transcript yet, which matches the
 * queue UI's job, not the transcript's. Once delivered, it lands ONLY in that
 * agent's transcript. A pre-v3 log never names a non-primary agent on
 * `prompt_batch_delivered` (it predates the field entirely), so every such
 * prompt falls back to the primary agent, exactly as it must for `agentIdOf`'s
 * "absence means primary, never unknown" rule to hold here too.
 */
export function deriveAgentTranscripts(events: NexusEvent[]): Map<AgentId, Message[]> {
  const byAgent = new Map<AgentId, Message[]>();
  const knownAgents = new Set<AgentId>([PRIMARY_AGENT_ID]);

  // promptSeq -> the agent that actually received it. A SEPARATE pass over the
  // whole log, done BEFORE the main loop below, because a `prompt_batch_delivered`
  // always logs AFTER the `user_prompt`(s) it names (a prompt is submitted, then
  // later flushed in a batch) — a single forward pass would still be looking at
  // an empty map when it reached the prompt, defaulting every one of them to
  // primary regardless of who actually received it.
  const deliveredTo = new Map<number, AgentId>();
  for (const event of events) {
    if (event.type === 'prompt_batch_delivered') {
      const agentId = agentIdOf(event);
      for (const promptSeq of event.promptSeqs) deliveredTo.set(promptSeq, agentId);
    }
  }

  ensure(byAgent, PRIMARY_AGENT_ID, () => []);

  const pushTo = (agentId: AgentId, message: Message): void => {
    ensure(byAgent, agentId, () => []).push(message);
  };
  const broadcast = (message: Message): void => {
    for (const agentId of knownAgents) pushTo(agentId, message);
  };

  for (const event of events) {
    switch (event.type) {
      case 'agent_spawned': {
        const agentId = agentIdOf(event);
        knownAgents.add(agentId);
        ensure(byAgent, agentId, () => []);
        break;
      }

      case 'prompt_batch_delivered':
        // Already folded into `deliveredTo` in the pre-pass above, and produces
        // no message of its own in store.ts's applyEvent either.
        break;

      case 'user_prompt':
        pushTo(deliveredTo.get(event.seq) ?? PRIMARY_AGENT_ID, {
          id: `e${event.seq}`,
          kind: 'user',
          author: event.displayName,
          text: event.text,
          seq: event.seq,
          ...(event.wasDriver === true ? { wasDriver: true } : {}),
        });
        break;

      case 'assistant_message':
        pushTo(agentIdOf(event), {
          id: event.messageId,
          kind: 'assistant',
          author: null,
          text: event.text,
          seq: event.seq,
        });
        break;

      case 'tool_start':
        pushTo(agentIdOf(event), {
          id: event.toolUseId,
          kind: 'tool',
          author: null,
          text: `${event.toolName} ${JSON.stringify(event.input)}`,
          seq: event.seq,
        });
        break;

      case 'tool_result': {
        // Fold into the matching tool_start row, scoped to this agent's own
        // list — never a cross-agent id search, so two agents that happen to
        // reuse a toolUseId (they never legitimately do, but nothing on the
        // wire prevents a malformed one) can't fold into each other.
        const list = ensure(byAgent, agentIdOf(event), () => []);
        const index = list.findIndex((message) => message.id === event.toolUseId);
        if (index !== -1) {
          list[index] = { ...list[index]!, text: `${list[index]!.text}\n→ ${event.output}` };
        }
        break;
      }

      case 'participant_joined':
        broadcast({
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} joined`,
          seq: event.seq,
        });
        break;

      case 'participant_left':
        broadcast({
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} left`,
          seq: event.seq,
        });
        break;

      case 'driver_granted':
        broadcast({
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} is now driving`,
          seq: event.seq,
        });
        break;

      case 'driver_released':
        broadcast({
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} released control`,
          seq: event.seq,
        });
        break;

      case 'room_created':
        broadcast({
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text:
            event.github == null
              ? `Room opened in ${event.cwd}`
              : `Room opened on ${event.github.owner}/${event.github.repo} (${event.github.defaultBranch})`,
          seq: event.seq,
        });
        break;

      case 'github_published':
        pushTo(agentIdOf(event), {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text:
            `${event.created ? 'Opened' : 'Updated'} pull request #${event.prNumber} ` +
            `— ${event.filesChanged} file${event.filesChanged === 1 ? '' : 's'} changed: ${event.prUrl}`,
          seq: event.seq,
        });
        break;

      case 'agent_error':
        pushTo(agentIdOf(event), {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: event.message,
          seq: event.seq,
        });
        break;

      case 'agent_idle':
        pushTo(agentIdOf(event), {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: 'Agent idle',
          seq: event.seq,
        });
        break;

      case 'prompt_batch_discarded':
        pushTo(agentIdOf(event), {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text:
            `${event.byDisplayName} stopped the agent — ` +
            `${event.promptSeqs.length} queued prompt${event.promptSeqs.length === 1 ? '' : 's'} ` +
            'were not sent.',
          seq: event.seq,
        });
        break;

      default:
        // Every other type (agent_stopped, permission_*, driver_requested,
        // model_changed, context_usage, crew_launched, doc_snapshot,
        // file_edited) renders nowhere in `store.ts`'s transcript either —
        // matched here for parity, not omitted by oversight.
        break;
    }
  }

  return byAgent;
}

/**
 * The room's fleet, as the log tells it. Field-for-field identical to
 * `apps/server/src/log/replay.ts#projectFleet` — see that function's doc
 * comment for why the primary agent is seeded before the log is even read
 * (every pre-v3 log, including production's, predates `agent_spawned`
 * entirely) and why later events overwrite earlier ones for the same id.
 */
export function deriveFleetRoster(events: NexusEvent[]): AgentDescriptor[] {
  const byId = new Map<AgentId, AgentDescriptor>();
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
      byId.set(agentId, {
        ...(existing ?? {
          agentId,
          provider: 'anthropic',
          model: null,
          displayName: agentId,
          spawnedByParticipantId: null,
          spawnedByName: null,
          stopped: false,
          stopReason: null,
        }),
        stopped: true,
        stopReason: event.reason,
      });
    }
  }

  return [...byId.values()];
}

/**
 * Splits in-flight streaming text apart by agent — landmine 2 (plan phase-12,
 * this task): `store.ts`'s `pendingDeltas` is keyed by `messageId` ALONE, and
 * two agents streaming at once produce two distinct message ids with nothing
 * on `Record<string, string>` saying which agent either one belongs to. There
 * is no logged event to recover that from either — a still-streaming message
 * has no `assistant_message` yet, so `events` cannot answer "whose delta is
 * this" the way it can for a settled `tool_start`/`tool_result` pair.
 *
 * So the caller must carry the `assistant_delta` frame's `agentId` (defaulting
 * absence to `PRIMARY_AGENT_ID`, same as everywhere else) alongside each
 * pending delta's text — see `PendingDelta` above. `events` is still taken
 * here, not for routing, but so every agent in the roster gets an entry even
 * with nothing currently streaming (an empty `{}` rather than a missing map
 * key), which is what lets a fleet view iterate the roster and read this map
 * without a fallback at every call site.
 *
 * BLOCKED on a file this task does not own: `RoomView.pendingDeltas` in
 * `apps/web/src/store.ts` is currently `Record<string, string>` and the
 * `assistant_delta` case in `reduce()` accumulates only `frame.text`, dropping
 * `frame.agentId` entirely. Wiring this function in requires changing that
 * field's type to `Record<string, PendingDelta>` (or equivalent) and updating
 * the `assistant_delta` case to store `frame.agentId ?? PRIMARY_AGENT_ID`
 * alongside the accumulated text. Reported, not made — `store.ts` belongs to
 * the integrator.
 */
export function routeDeltas(
  pendingDeltas: Record<string, PendingDelta>,
  events: NexusEvent[],
): Map<AgentId, Record<string, string>> {
  const result = new Map<AgentId, Record<string, string>>();
  for (const agent of deriveFleetRoster(events)) {
    result.set(agent.agentId, {});
  }
  for (const [messageId, delta] of Object.entries(pendingDeltas)) {
    const bucket = result.get(delta.agentId) ?? {};
    bucket[messageId] = delta.text;
    result.set(delta.agentId, bucket);
  }
  return result;
}
