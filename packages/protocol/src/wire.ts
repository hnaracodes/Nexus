import type { AgentId, AgentProvider, SynCodeEvent } from './events.js';
import { isAgentProvider } from './events.js';

export interface PresenceEntry {
  participantId: string;
  displayName: string;
  connected: boolean;
}

/** One person's cursor and selection inside one open document (phase 11). */
export interface DocPresenceEntry {
  participantId: string;
  displayName: string;
  /** Character offsets. `anchor === head` is a caret rather than a selection. */
  anchor: number;
  head: number;
}

/**
 * What one agent in the fleet is doing right now.
 *
 * `status` is deliberately a small closed vocabulary rather than free text: the
 * fleet view has to stay legible at twenty rows, and 'awaiting_approval' in
 * particular has to be findable at a glance — it is the state where the fleet is
 * blocked on a human, which is the whole governance problem phase 12 exists to
 * make survivable.
 */
export interface FleetEntry {
  agentId: AgentId;
  displayName: string;
  provider: AgentProvider;
  model: string | null;
  status: AgentStatus;
  /** How many of this agent's tool calls are waiting on the room to decide. */
  pendingApprovals: number;
  /** Queued prompts not yet delivered to this agent. */
  queuedPrompts: number;
}

export type AgentStatus = 'idle' | 'working' | 'awaiting_approval' | 'error' | 'stopped';

/**
 * Frames the server pushes to clients. `event` frames carry logged, sequenced
 * state. Every other frame is transient: no seq, never logged, never replayed.
 */
export type ServerFrame =
  | { kind: 'event'; event: SynCodeEvent }
  /**
   * `agentId` is not decoration. Streaming text is keyed by `messageId` in the
   * client's `pendingDeltas`, and with one agent per room that was sufficient.
   * With a fleet, two agents streaming at once produce two message ids that a
   * client has no way to route to two panes — the deltas would pile into one
   * transcript. Absent means the primary agent, matching every v1 client.
   */
  | { kind: 'assistant_delta'; messageId: string; text: string; agentId?: AgentId }
  /**
   * Sent once per socket, to that socket alone, at the end of replay.
   * `participantId` is how a client learns which roster entry is itself —
   * without it the UI cannot tell "you are driving" from "someone else is",
   * so Release Control and hand-over can never render (Day 2 acceptance
   * requires control to pass in both directions). It rides on this frame
   * rather than a new one because this is already the only per-socket,
   * non-broadcast frame the server sends.
   *
   * `resumeToken` is the secret that lets the next socket reclaim this same
   * `participantId` (see `resolveParticipantId`), so a refresh or a dropped
   * connection keeps the roster row and the driver token. It must never be
   * broadcast or logged: participant ids are public within a room, so the
   * token is the only thing distinguishing "me, returning" from "someone else
   * claiming to be me" — and without that distinction any member could
   * reconnect as the driver, bypassing I2 at the server.
   */
  | {
      kind: 'replay_complete';
      lastSeq: number;
      protocolVersion: number;
      participantId: string;
      resumeToken: string;
    }
  | { kind: 'presence'; participants: PresenceEntry[]; driverId: string | null }
  /**
   * Transient and deliberately UNLOGGED (phase 7). A raw filesystem-change
   * stream is not room history: logging it would bloat every room's JSONL with
   * node_modules churn and tell a replaying client nothing it cannot re-fetch.
   *
   * On `truncated`, `paths` is informational — the client discards it and
   * refetches the tree. The paths that fit are still sent rather than dropped
   * silently.
   */
  | { kind: 'workspace_changed'; paths: string[]; truncated: boolean }
  /**
   * One CRDT sync message for one open document (phase 11).
   *
   * Transient and NEVER logged, for exactly the reason `assistant_delta` is not:
   * this is the firehose, and the log carries the settled result instead
   * (`doc_snapshot` + `file_edited`). Sent only to sockets that have opened this
   * path, so a room with forty files does not broadcast forty streams to
   * everyone.
   *
   * `from` is the origin's participant id, or an agent id when an AGENT made the
   * edit — agents are CRDT peers here, not out-of-band disk writers, which is
   * what stops the agent's write racing the editor buffer. A client uses it to
   * ignore its own echo, and to attribute a cursor.
   */
  | { kind: 'doc_sync'; path: string; payload: string; from: string }
  /**
   * Where everyone's cursor is in one document. Transient like `presence`, and
   * for the same reason: it describes right now, not history.
   */
  | { kind: 'doc_presence'; path: string; entries: DocPresenceEntry[] }
  /**
   * Live fleet status (phase 12). The fleet's MEMBERSHIP is derivable from the
   * log (`agent_spawned` / `agent_stopped`); what is not derivable is what each
   * agent is doing this second, which is exactly the `connected` flag's role on
   * `PresenceEntry`. So this frame carries liveness, and the log carries truth.
   */
  | { kind: 'fleet'; agents: FleetEntry[] }
  | { kind: 'error'; message: string };

/** Frames a client may send. Anything else is dropped with an `error` frame. */
export type ClientFrame =
  /**
   * `agentId` names the agent this prompt is FOR. Omitted means the primary
   * agent, which is what every pre-phase-8b client sends. It is a routing hint
   * only — the server still stamps attribution itself, so naming an agent can
   * never be a way to forge who spoke (I2').
   */
  | { kind: 'prompt'; text: string; agentId?: AgentId }
  | { kind: 'request_control' }
  | { kind: 'grant_control'; toParticipantId: string }
  | { kind: 'release_control' }
  | {
      kind: 'permission_decision';
      requestId: string;
      decision: 'allow' | 'deny';
      reason?: string;
      /** Which agent's gate holds this request. Absent means the primary agent. */
      agentId?: AgentId;
    }
  /** `agentId` names which agent to stop. Absent stops the primary agent. */
  | { kind: 'interrupt'; agentId?: AgentId }
  /** `null` = use the account default. See the parse case for why not undefined. */
  | { kind: 'set_model'; model: string | null; agentId?: AgentId }
  /**
   * Subscribe this socket to one document's sync stream (phase 11). Without an
   * explicit subscription the server would have to broadcast every open
   * document to every socket, which is the difference between a room that scales
   * to a repository and one that scales to a handful of files.
   */
  | { kind: 'doc_open'; path: string }
  | { kind: 'doc_close'; path: string }
  /**
   * One CRDT sync message from this client.
   *
   * Deliberately NOT gated on the driver token. The driver token arbitrates who
   * steers the AGENT (I2'); editing is what everyone is here to do, and a
   * multiplayer editor where only one person may type is a screen share. The
   * governance boundary in v2 is the tool gate, not the keyboard.
   */
  | { kind: 'doc_sync'; path: string; payload: string }
  | { kind: 'doc_presence'; path: string; anchor: number; head: number }
  /**
   * Add an agent to the fleet (phase 12). The server decides the `agentId` — a
   * client-chosen id could collide with a live agent and merge two transcripts,
   * and could name an id a v1 log already used.
   *
   * `configName` names a SAVED configuration (phase 13); the config's contents
   * are never sent on this frame. A participant-supplied config is executable
   * input, so it is validated once where it is stored, not re-parsed from an
   * arbitrary socket message.
   */
  | {
      kind: 'spawn_agent';
      displayName: string;
      provider: AgentProvider;
      model: string | null;
      configName?: string;
    }
  | { kind: 'stop_agent'; agentId: AgentId }
  /** Launch a saved crew (phase 13). Named, never inlined, for the same reason. */
  | { kind: 'launch_crew'; crewName: string };

/**
 * Caps on the two client frames that carry unbounded content.
 *
 * A socket is an authenticated participant, but "authenticated" is not "trusted
 * with the server's heap" — a room is a shared security boundary among people
 * who trust each other, which is a statement about intent, not about a bug in
 * someone's client. Both limits sit well above any real CRDT sync message.
 */
export const MAX_DOC_PAYLOAD_CHARS = 1024 * 1024;
export const MAX_PATH_CHARS = 1024;

/**
 * Three-state on purpose: absent is legitimate (every v1 client), a string is
 * accepted, and anything else is a REJECT rather than a coercion. Routing a
 * prompt or an approval to the wrong agent because a malformed id was coerced
 * would be a steering failure, so the whole frame is refused — the same stance
 * `set_model` already takes on a malformed model.
 */
function readAgentId(value: unknown): { ok: true; agentId?: AgentId } | { ok: false } {
  // `null` is accepted as equivalent to absent, deliberately, because that is
  // already this file's convention: `set_model` documents null as the JSON-safe
  // spelling of "unspecified" since undefined does not survive JSON.stringify.
  // Rejecting it here would mean a client building a frame from a nullable
  // variable loses its prompt to "Unrecognized message." with no hint that
  // agentId was the problem.
  if (value === undefined || value === null) return { ok: true };
  if (typeof value === 'string' && value !== '') return { ok: true, agentId: value };
  return { ok: false };
}

/** A workspace-relative path, syntactically. The path JAIL lives server-side in
 *  `workspace.ts`, which resolves real paths — a wire-level check cannot see a
 *  symlink and must never be mistaken for one that can. This only bounds size
 *  and refuses shapes that are obviously not a relative path. */
function readPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '' || value.length > MAX_PATH_CHARS) return null;
  return value;
}

function readOffset(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  switch (frame['kind']) {
    case 'prompt': {
      if (typeof frame['text'] !== 'string' || frame['text'].trim().length === 0) return null;
      const agent = readAgentId(frame['agentId']);
      if (!agent.ok) return null;
      return {
        kind: 'prompt',
        text: frame['text'],
        ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }),
      };
    }
    case 'request_control':
      return { kind: 'request_control' };
    case 'release_control':
      return { kind: 'release_control' };
    case 'interrupt': {
      const agent = readAgentId(frame['agentId']);
      if (!agent.ok) return null;
      return { kind: 'interrupt', ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }) };
    }
    case 'set_model': {
      // Accept a string or an EXPLICIT null, and nothing else. `undefined` does
      // not survive JSON.stringify, so a client meaning "use the default" must
      // send null — an absent key is indistinguishable from a malformed frame
      // and is rejected rather than guessed at.
      if (typeof frame['model'] !== 'string' && frame['model'] !== null) return null;
      const agent = readAgentId(frame['agentId']);
      if (!agent.ok) return null;
      return {
        kind: 'set_model',
        model: frame['model'] as string | null,
        ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }),
      };
    }
    case 'grant_control':
      return typeof frame['toParticipantId'] === 'string'
        ? { kind: 'grant_control', toParticipantId: frame['toParticipantId'] }
        : null;
    case 'permission_decision': {
      if (
        typeof frame['requestId'] !== 'string' ||
        (frame['decision'] !== 'allow' && frame['decision'] !== 'deny')
      ) {
        return null;
      }
      const agent = readAgentId(frame['agentId']);
      if (!agent.ok) return null;
      return {
        kind: 'permission_decision',
        requestId: frame['requestId'],
        decision: frame['decision'],
        ...(typeof frame['reason'] === 'string' ? { reason: frame['reason'] } : {}),
        ...(agent.agentId === undefined ? {} : { agentId: agent.agentId }),
      };
    }
    case 'doc_open':
    case 'doc_close': {
      const path = readPath(frame['path']);
      return path === null ? null : { kind: frame['kind'] as 'doc_open' | 'doc_close', path };
    }
    case 'doc_sync': {
      const path = readPath(frame['path']);
      if (path === null) return null;
      const payload = frame['payload'];
      // Rejected rather than truncated. A truncated CRDT sync message is not a
      // smaller edit, it is a corrupt one, and applying it would poison the
      // document for everyone rather than dropping one person's keystroke.
      if (typeof payload !== 'string' || payload.length > MAX_DOC_PAYLOAD_CHARS) return null;
      return { kind: 'doc_sync', path, payload };
    }
    case 'doc_presence': {
      const path = readPath(frame['path']);
      const anchor = readOffset(frame['anchor']);
      const head = readOffset(frame['head']);
      if (path === null || anchor === null || head === null) return null;
      return { kind: 'doc_presence', path, anchor, head };
    }
    case 'spawn_agent': {
      const displayName = frame['displayName'];
      if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > 80) {
        return null;
      }
      if (!isAgentProvider(frame['provider'])) return null;
      if (typeof frame['model'] !== 'string' && frame['model'] !== null) return null;
      const configName = frame['configName'];
      if (configName !== undefined && typeof configName !== 'string') return null;
      return {
        kind: 'spawn_agent',
        displayName,
        provider: frame['provider'],
        model: frame['model'] as string | null,
        ...(typeof configName === 'string' ? { configName } : {}),
      };
    }
    case 'stop_agent': {
      const agent = readAgentId(frame['agentId']);
      // Unlike everywhere else in this file, absent is NOT acceptable here:
      // defaulting to the primary agent would turn a malformed frame into a
      // command that kills the room's main agent.
      if (!agent.ok || agent.agentId === undefined) return null;
      return { kind: 'stop_agent', agentId: agent.agentId };
    }
    case 'launch_crew': {
      const crewName = frame['crewName'];
      return typeof crewName === 'string' && crewName !== '' ? { kind: 'launch_crew', crewName } : null;
    }
    default:
      return null;
  }
}
