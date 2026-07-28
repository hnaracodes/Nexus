/**
 * The Nexus event protocol. This file is a frozen contract: every module and
 * both sides of the wire import from it. Adding a member to NexusEvent is a
 * protocol change, not a feature change.
 */

export const PROTOCOL_VERSION = 1;

/** Fields every logged event carries. Assigned once, never mutated (I3). */
export interface EventEnvelope {
  /** Monotonic per room, starting at 1. Assigned by the room, not the client. */
  seq: number;
  /** ISO 8601 with milliseconds. */
  ts: string;
  roomId: string;
}

export interface RoomCreated extends EventEnvelope {
  type: 'room_created';
  /** Never the API key. Never the room token. */
  cwd: string;
  repoUrl: string | null;
}

export interface ParticipantJoined extends EventEnvelope {
  type: 'participant_joined';
  participantId: string;
  displayName: string;
}

export interface ParticipantLeft extends EventEnvelope {
  type: 'participant_left';
  participantId: string;
  displayName: string;
}

export interface UserPrompt extends EventEnvelope {
  type: 'user_prompt';
  participantId: string;
  displayName: string;
  /** The raw text the human typed, without the attribution prefix. */
  text: string;
}

/** A completed assistant message. Deltas are never logged — see wire.ts. */
export interface AssistantMessage extends EventEnvelope {
  type: 'assistant_message';
  messageId: string;
  text: string;
}

export interface ToolStart extends EventEnvelope {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** Already redacted at the log boundary. */
  input: unknown;
}

export interface ToolResult extends EventEnvelope {
  type: 'tool_result';
  toolUseId: string;
  toolName: string;
  isError: boolean;
  /** Truncated to 4000 characters at the log boundary. */
  output: string;
}

export interface AgentError extends EventEnvelope {
  type: 'agent_error';
  message: string;
}

export interface AgentIdle extends EventEnvelope {
  type: 'agent_idle';
}

/**
 * Members below are produced by later phases. They are declared here, in the
 * one contracts file, so no feature branch has to widen this union.
 */

export interface DriverGranted extends EventEnvelope {
  type: 'driver_granted';
  participantId: string;
  displayName: string;
  /** 'creator' | 'granted' | 'auto_release' | 'claimed' */
  reason: string;
}

export interface DriverReleased extends EventEnvelope {
  type: 'driver_released';
  participantId: string;
  displayName: string;
  /** 'explicit' | 'disconnect' | 'granted_away' */
  reason: string;
}

export interface DriverRequested extends EventEnvelope {
  type: 'driver_requested';
  participantId: string;
  displayName: string;
}

export interface PermissionRequested extends EventEnvelope {
  type: 'permission_requested';
  requestId: string;
  toolName: string;
  input: unknown;
  /** Epoch milliseconds after which the request auto-denies. */
  expiresAt: number;
}

export interface PermissionDecided extends EventEnvelope {
  type: 'permission_decided';
  requestId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  /** null when the decision came from the auto-approve list or a timeout. */
  participantId: string | null;
  displayName: string | null;
  /** 'first_response' | 'auto_approved' | 'timeout' */
  via: string;
  reason: string | null;
}

export interface Interrupted extends EventEnvelope {
  type: 'interrupted';
  participantId: string;
  displayName: string;
}

export type NexusEvent =
  | RoomCreated
  | ParticipantJoined
  | ParticipantLeft
  | UserPrompt
  | AssistantMessage
  | ToolStart
  | ToolResult
  | AgentError
  | AgentIdle
  | DriverGranted
  | DriverReleased
  | DriverRequested
  | PermissionRequested
  | PermissionDecided
  | Interrupted;

export type NexusEventType = NexusEvent['type'];

/** An event minus the fields the room assigns. What callers hand to the log. */
export type UnsequencedEvent = {
  [K in NexusEvent as K['type']]: Omit<K, 'seq' | 'ts' | 'roomId'>;
}[NexusEventType];

const LOGGED_TYPES = new Set<string>([
  'room_created',
  'participant_joined',
  'participant_left',
  'user_prompt',
  'assistant_message',
  'tool_start',
  'tool_result',
  'agent_error',
  'agent_idle',
  'driver_granted',
  'driver_released',
  'driver_requested',
  'permission_requested',
  'permission_decided',
  'interrupted',
]);

export function isLoggedEvent(value: unknown): value is NexusEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['seq'] === 'number' &&
    Number.isInteger(e['seq']) &&
    e['seq'] >= 1 &&
    typeof e['ts'] === 'string' &&
    typeof e['roomId'] === 'string' &&
    typeof e['type'] === 'string' &&
    LOGGED_TYPES.has(e['type'])
  );
}
