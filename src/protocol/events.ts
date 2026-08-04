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

/**
 * A room's GitHub binding (plan phase-6). Defined HERE, in the protocol, and
 * imported by `src/server/github.ts` — not the other way round. The client
 * renders this, so the shape has to live at the layer both sides already
 * import, or it would be duplicated and drift.
 *
 * Non-secret by construction: an installation id is a public identifier, and
 * every token minted from it is short-lived and derived server-side. This is
 * exactly why one authorize click can survive a restart.
 */
export interface GithubRepoRef {
  installationId: number;
  owner: string;
  repo: string;
  defaultBranch: string;
}

export interface RoomCreated extends EventEnvelope {
  type: 'room_created';
  /** Never the API key. Never the room token. */
  cwd: string;
  repoUrl: string | null;
  /**
   * Set when the room was created through the GitHub App connect flow.
   * OPTIONAL is load-bearing, the same way `UserPrompt.wasDriver` is: JSONL
   * logs already on disk predate this field and `src/log/replay.ts` must keep
   * reconstructing them. Absent means "not GitHub-backed".
   */
  github?: GithubRepoRef | null;
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
  /**
   * Whether the sender held the driver token at submit time. OPTIONAL is
   * load-bearing: JSONL logs already on disk predate this field, and
   * src/log/replay.ts must keep reconstructing them. Absent means "unknown",
   * NOT false. Derived server-side from room.driverId — never read off the
   * client frame, which a participant could forge (I2').
   */
  wasDriver?: boolean;
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

/**
 * One turn's worth of prompts handed to the agent together. `promptSeqs` names
 * the `user_prompt` events in this batch, so "what is still queued" is derivable
 * from the log alone (I3) without a second source of truth.
 */
export interface PromptBatchDelivered extends EventEnvelope {
  type: 'prompt_batch_delivered';
  promptSeqs: number[];
  /** Who held the token at flush time — may differ from submit time. */
  driverId: string | null;
}

/** Prompts dropped because someone interrupted before they were delivered. */
export interface PromptBatchDiscarded extends EventEnvelope {
  type: 'prompt_batch_discarded';
  promptSeqs: number[];
  byParticipantId: string;
  byDisplayName: string;
}

/**
 * The room's work reached GitHub as a pull request (plan phase-6). Carries no
 * credential: every field here is public once the PR exists. Logged so "what
 * did this room actually ship" is answerable from the log alone (I3).
 */
export interface GithubPublished extends EventEnvelope {
  type: 'github_published';
  prUrl: string;
  prNumber: number;
  branch: string;
  commitSha: string;
  filesChanged: number;
  /** False when an existing PR for this room's branch was updated instead. */
  created: boolean;
}

/** Who switched the room's model, and to what. Room history, so it is logged. */
export interface ModelChanged extends EventEnvelope {
  type: 'model_changed';
  participantId: string;
  displayName: string;
  /**
   * `null` means "the account default". The SDK's `setModel(model?: string)`
   * spells that `undefined`, but `undefined` does not survive JSON.stringify,
   * so the wire and the log both use `null` and the server bridges the two.
   */
  model: string | null;
}

/**
 * Context-window telemetry for the bar in the prompt dock.
 *
 * Field names deliberately mirror the SDK's own `ModelUsage`
 * (`coreTypes.d.ts:8-16`) so `translate()` is a near-identity copy rather than
 * a renaming exercise that can silently drop precision.
 *
 * `ModelUsage` also carries `webSearchRequests` and `costUSD`; both are omitted
 * on purpose. Logging per-turn dollar cost would make room spend part of the
 * permanent, shareable transcript, and that is a product decision nobody has
 * taken. Do not add it just because the field exists upstream.
 */
export interface ContextUsage extends EventEnvelope {
  type: 'context_usage';
  /** Null on a compact_boundary, which carries no model field. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  /** Set only by a compact_boundary: tokens in play before compaction. */
  compactedFromTokens: number | null;
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
  | Interrupted
  | PromptBatchDelivered
  | PromptBatchDiscarded
  | GithubPublished
  | ModelChanged
  | ContextUsage;

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
  // Adding a union member is not enough: isLoggedEvent() gates what survives a
  // reload, so a type missing from this set is written to the JSONL and then
  // silently dropped when the log is read back — the batch history would exist
  // on disk but vanish on restart.
  'prompt_batch_delivered',
  'prompt_batch_discarded',
  'github_published',
  'model_changed',
  'context_usage',
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
