import type { NexusEvent } from './events.js';

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
  | { kind: 'replay_complete'; lastSeq: number; protocolVersion: number }
  | { kind: 'presence'; participants: PresenceEntry[]; driverId: string | null }
  | { kind: 'error'; message: string };

/** Frames a client may send. Anything else is dropped with an `error` frame. */
export type ClientFrame =
  | { kind: 'prompt'; text: string }
  | { kind: 'request_control' }
  | { kind: 'grant_control'; toParticipantId: string }
  | { kind: 'release_control' }
  | { kind: 'permission_decision'; requestId: string; decision: 'allow' | 'deny'; reason?: string }
  | { kind: 'interrupt' };

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
    case 'prompt':
      return typeof frame['text'] === 'string' && frame['text'].trim().length > 0
        ? { kind: 'prompt', text: frame['text'] }
        : null;
    case 'request_control':
      return { kind: 'request_control' };
    case 'release_control':
      return { kind: 'release_control' };
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'grant_control':
      return typeof frame['toParticipantId'] === 'string'
        ? { kind: 'grant_control', toParticipantId: frame['toParticipantId'] }
        : null;
    case 'permission_decision':
      return typeof frame['requestId'] === 'string' &&
        (frame['decision'] === 'allow' || frame['decision'] === 'deny')
        ? {
            kind: 'permission_decision',
            requestId: frame['requestId'],
            decision: frame['decision'],
            ...(typeof frame['reason'] === 'string' ? { reason: frame['reason'] } : {}),
          }
        : null;
    default:
      return null;
  }
}
