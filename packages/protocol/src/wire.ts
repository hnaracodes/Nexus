import type { AgentId, NexusEvent } from './events.js';

export interface PresenceEntry {
  participantId: string;
  displayName: string;
  connected: boolean;
}

/**
 * Frames the server pushes to clients. `event` frames carry logged, sequenced
 * state. Every other frame is transient: no seq, never logged, never replayed.
 */
export type ServerFrame =
  | { kind: 'event'; event: NexusEvent }
  | { kind: 'assistant_delta'; messageId: string; text: string }
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
  | { kind: 'interrupt' }
  /** `null` = use the account default. See the parse case for why not undefined. */
  | { kind: 'set_model'; model: string | null };

/**
 * Three-state on purpose: absent is legitimate (every v1 client), a string is
 * accepted, and anything else is a REJECT rather than a coercion. Routing a
 * prompt or an approval to the wrong agent because a malformed id was coerced
 * would be a steering failure, so the whole frame is refused — the same stance
 * `set_model` already takes on a malformed model.
 */
function readAgentId(value: unknown): { ok: true; agentId?: AgentId } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (typeof value === 'string' && value !== '') return { ok: true, agentId: value };
  return { ok: false };
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
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'set_model':
      // Accept a string or an EXPLICIT null, and nothing else. `undefined` does
      // not survive JSON.stringify, so a client meaning "use the default" must
      // send null — an absent key is indistinguishable from a malformed frame
      // and is rejected rather than guessed at.
      return typeof frame['model'] === 'string' || frame['model'] === null
        ? { kind: 'set_model', model: frame['model'] as string | null }
        : null;
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
    default:
      return null;
  }
}
