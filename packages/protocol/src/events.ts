/**
 * The SynCode event protocol. This file is a frozen contract: every module and
 * both sides of the wire import from it. Adding a member to SynCodeEvent is a
 * protocol change, not a feature change.
 */

/**
 * 3 since the v2 studio work, when a room learned to hold a *fleet* of agents
 * from more than one provider, and to hold documents that several people edit
 * at once.
 *
 * Still purely additive, and still for the same reason: every field added since
 * v1 is optional, so every JSONL line already on disk — including production's —
 * replays unchanged. I3 forbids rewriting them, so backward compatibility is not
 * a courtesy here, it is the only legal option.
 *
 * Nothing branches on this number. It is a signal to a future client, not a
 * gate.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Which model provider is answering for an agent.
 *
 * Ratified 2026-09-06: Anthropic first (shipped), OpenAI second, Google third.
 * Three, not two, on purpose — an interface designed against two providers
 * acquires the first one's assumptions permanently, and the three tool-call
 * surfaces differ in ways that only show up when all three are in view at once.
 *
 * Stored on `agent_spawned` rather than derived, because "what was this agent
 * actually running" must survive a restart and a replay (I3), and the runtime
 * that knew the answer is gone by then.
 */
export type AgentProvider = 'anthropic' | 'openai' | 'google';

/** The providers, as data, so a validator and a UI cannot drift from the type. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = ['anthropic', 'openai', 'google'];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Which agent an event belongs to.
 *
 * A room may host more than one agent from phase 8b onward, so an event that
 * describes agent activity has to say which one. `PRIMARY_AGENT_ID` is the id a
 * single-agent room uses, and — load-bearing — it is what an event with no
 * `agentId` MEANS. Every JSONL line written before this field existed is such
 * an event, including the ones on the production volume, and I3 forbids
 * rewriting them. So absence is not "unknown"; it is "the primary agent".
 */
export type AgentId = string;
export const PRIMARY_AGENT_ID: AgentId = 'primary';

/**
 * Mixed into the events that describe an agent doing something, as opposed to
 * a person doing something (`participant_joined`) or the room itself changing
 * (`driver_granted`). Deliberately NOT on `EventEnvelope`: an agent id on
 * `participant_left` would be meaningless, and putting it there would imply
 * per-agent driver semantics, which is a phase-12 decision nobody has taken.
 */
export interface AgentScoped {
  /**
   * OPTIONAL is load-bearing, the same way `UserPrompt.wasDriver` is. Logs on
   * disk predate this field and `src/log/replay.ts` must keep reconstructing
   * them. Read it through `agentIdOf()` rather than directly, so the default
   * lives in exactly one place.
   */
  agentId?: AgentId;
}

/**
 * The agent an event belongs to, defaulting absence to the primary agent.
 *
 * Defaulting happens HERE, at the point of use, and never by materialising the
 * field into the stored object. A materialised default could be written back to
 * disk, which would quietly rewrite history and make a v1 log indistinguishable
 * from a v2 one (I3).
 */
export function agentIdOf(event: AgentScoped): AgentId {
  return event.agentId ?? PRIMARY_AGENT_ID;
}

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
  /**
   * Set only when the participant signed in with GitHub (phase 13). OPTIONAL is
   * load-bearing for the usual reason — every log already on disk lacks it — and
   * for a second one: a guest who joined by link has no account and never will,
   * and that is a supported way to be in a room, not a degraded one. Absence
   * means "joined by link", never "we failed to look them up".
   *
   * A login is a public handle, so it is safe in a shareable log. Nothing
   * derived from a token is stored here (I4).
   */
  githubLogin?: string;
  avatarUrl?: string;
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
export interface AssistantMessage extends EventEnvelope, AgentScoped {
  type: 'assistant_message';
  messageId: string;
  text: string;
  /**
   * The tool call that spawned the agent producing this event, or null when it
   * came from the top-level agent. Mirrors the SDK's own `parent_tool_use_id`.
   *
   * This is what makes a subagent VISIBLE (phase 13) rather than a black box:
   * the transcript nests its activity under the call that created it, instead
   * of interleaving it with the parent's at the same level. Optional, because
   * logs predate it and because a provider with no subagent concept never sets
   * it — absent means "top level".
   */
  parentToolUseId?: string | null;
}

export interface ToolStart extends EventEnvelope, AgentScoped {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** Already redacted at the log boundary. */
  input: unknown;
  /**
   * The tool call that spawned the agent producing this event, or null when it
   * came from the top-level agent. Mirrors the SDK's own `parent_tool_use_id`.
   *
   * This is what makes a subagent VISIBLE (phase 13) rather than a black box:
   * the transcript nests its activity under the call that created it, instead
   * of interleaving it with the parent's at the same level. Optional, because
   * logs predate it and because a provider with no subagent concept never sets
   * it — absent means "top level".
   */
  parentToolUseId?: string | null;
}

export interface ToolResult extends EventEnvelope, AgentScoped {
  type: 'tool_result';
  toolUseId: string;
  toolName: string;
  isError: boolean;
  /** Truncated to 4000 characters at the log boundary. */
  output: string;
  /**
   * The tool call that spawned the agent producing this event, or null when it
   * came from the top-level agent. Mirrors the SDK's own `parent_tool_use_id`.
   *
   * This is what makes a subagent VISIBLE (phase 13) rather than a black box:
   * the transcript nests its activity under the call that created it, instead
   * of interleaving it with the parent's at the same level. Optional, because
   * logs predate it and because a provider with no subagent concept never sets
   * it — absent means "top level".
   */
  parentToolUseId?: string | null;
}

export interface AgentError extends EventEnvelope, AgentScoped {
  type: 'agent_error';
  message: string;
}

export interface AgentIdle extends EventEnvelope, AgentScoped {
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

export interface PermissionRequested extends EventEnvelope, AgentScoped {
  type: 'permission_requested';
  requestId: string;
  toolName: string;
  input: unknown;
  /** Epoch milliseconds after which the request auto-denies. */
  expiresAt: number;
}

export interface PermissionDecided extends EventEnvelope, AgentScoped {
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

export interface Interrupted extends EventEnvelope, AgentScoped {
  type: 'interrupted';
  participantId: string;
  displayName: string;
}

/**
 * One turn's worth of prompts handed to the agent together. `promptSeqs` names
 * the `user_prompt` events in this batch, so "what is still queued" is derivable
 * from the log alone (I3) without a second source of truth.
 */
export interface PromptBatchDelivered extends EventEnvelope, AgentScoped {
  type: 'prompt_batch_delivered';
  promptSeqs: number[];
  /** Who held the token at flush time — may differ from submit time. */
  driverId: string | null;
}

/** Prompts dropped because someone interrupted before they were delivered. */
export interface PromptBatchDiscarded extends EventEnvelope, AgentScoped {
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
export interface GithubPublished extends EventEnvelope, AgentScoped {
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
export interface ModelChanged extends EventEnvelope, AgentScoped {
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
export interface ContextUsage extends EventEnvelope, AgentScoped {
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

/* -------------------------------------------------------------------------
 * The fleet (phase 12) and its providers (phase 10).
 * ---------------------------------------------------------------------- */

/**
 * An agent joined the room's fleet.
 *
 * Logged, and load-bearing that it is. Before this event a room's roster was
 * *inferred* from which `agentId`s happened to appear on other events
 * (`projectAgents` in the server's replay module) — which can tell you an agent
 * existed but not what it was: not its provider, not its model, not the name a
 * human gave it, not who started it. At one agent that gap was invisible because
 * the answer was always "the room's Claude session". At twenty it is the roster.
 *
 * So the fleet is now derivable from the log alone (I3) with no second source of
 * truth, and it survives a restart for the same reason the driver token does.
 */
export interface AgentSpawned extends EventEnvelope, AgentScoped {
  type: 'agent_spawned';
  provider: AgentProvider;
  /** null means the provider's account default. Same convention as ModelChanged. */
  model: string | null;
  /** What the room calls this agent. Chosen by a human, so it is not an id. */
  displayName: string;
  /** Who spawned it. null for the primary agent, which the room starts itself. */
  participantId: string | null;
  spawnedByName: string | null;
  /** Which saved configuration produced it, when one did (phase 13). */
  configName?: string;
  /** Set when this agent was launched as part of a crew (phase 13). */
  crewId?: string;
}

/**
 * An agent left the fleet. Terminal for that `agentId` — ids are never reused,
 * because a reused id would make one transcript out of two agents' work.
 */
export interface AgentStopped extends EventEnvelope, AgentScoped {
  type: 'agent_stopped';
  /** 'stopped' | 'completed' | 'error' | 'room_closed' */
  reason: string;
  participantId: string | null;
  stoppedByName: string | null;
  /** Present when `reason` is 'error'. Redacted at the log boundary like any string. */
  message?: string;
}

/**
 * Several agents launched together from a saved crew template (phase 13).
 * Logged so "what did this room actually run" is answerable after the fact,
 * and so a crew can be reconstructed from a transcript someone shared.
 */
export interface CrewLaunched extends EventEnvelope {
  type: 'crew_launched';
  crewId: string;
  crewName: string;
  agentIds: AgentId[];
  participantId: string;
  displayName: string;
}

/* -------------------------------------------------------------------------
 * Collaborative documents (phase 11).
 *
 * The shape here answers a contradiction the v2 design had to resolve. Logging
 * every CRDT sync frame would turn each room's JSONL into a keystroke firehose;
 * logging none of them would put authoritative document state OUTSIDE the log,
 * which I3 forbids. The repo had already solved this exact shape once, one layer
 * down: `assistant_delta` is transient and unlogged, and the completed
 * `assistant_message` IS logged. The same split applies here — sync frames are
 * transient `ServerFrame`s, and what the log carries is a periodic compacted
 * snapshot plus a coarse semantic record of who changed what.
 * ---------------------------------------------------------------------- */

/**
 * A compacted snapshot of one document's CRDT state.
 *
 * This is what makes a document reconstructible from the log alone. Written on a
 * cadence and size trigger rather than per edit, so the log stays a history of
 * the room rather than a transcript of typing.
 *
 * `snapshot` is base64 of the CRDT's own binary `save()`. Standard base64 shares
 * no characters with any credential prefix the redactor looks for, so it passes
 * through `redactEvent` untouched — but note the corollary: **a secret typed
 * into a file and snapshotted here is NOT redacted**, because it is inside an
 * opaque binary by then. That is a property of committing secrets to a shared
 * workspace, not a new hole, and it is why `MAX_SNAPSHOT_BYTES` exists to keep
 * the blast radius of a mistake bounded rather than unbounded.
 */
export interface DocSnapshot extends EventEnvelope {
  type: 'doc_snapshot';
  /** Workspace-relative and already jailed. Never absolute, never escaping root. */
  path: string;
  /** base64 of the CRDT binary save(). */
  snapshot: string;
  /** The CRDT heads this snapshot represents, so a peer can tell if it is behind. */
  heads: string[];
}

/**
 * Someone — a person or an agent — changed a file.
 *
 * Coarse and semantic on purpose: one event per settled edit burst, not per
 * keystroke. This is the row a human reads in the transcript ("Ana edited
 * src/app.ts"), and the join key between the document layer and the event log.
 *
 * Exactly one of `participantId` / `agentId` is set in practice: an edit has one
 * author, and which KIND of author matters — an agent's write is governed, a
 * human's is not. Both are optional rather than a discriminated union because
 * `agentId` lives on `AgentScoped`, which every agent-scoped event already
 * shares, and splitting it would mean two events for one fact.
 */
export interface FileEdited extends EventEnvelope, AgentScoped {
  type: 'file_edited';
  path: string;
  /** Null when the author was an agent. */
  participantId: string | null;
  displayName: string | null;
  /** Signed. Negative for a deletion. Enough to render "+42 −7" without the content. */
  bytesDelta: number;
}

/** A snapshot larger than this is split or skipped rather than logged whole. */
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

export type SynCodeEvent =
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
  | ContextUsage
  | AgentSpawned
  | AgentStopped
  | CrewLaunched
  | DocSnapshot
  | FileEdited;

export type SynCodeEventType = SynCodeEvent['type'];

/** An event minus the fields the room assigns. What callers hand to the log. */
export type UnsequencedEvent = {
  [K in SynCodeEvent as K['type']]: Omit<K, 'seq' | 'ts' | 'roomId'>;
}[SynCodeEventType];

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
  'agent_spawned',
  'agent_stopped',
  'crew_launched',
  'doc_snapshot',
  'file_edited',
]);

/**
 * The event types that survive a reload, as data.
 *
 * Exported so tests can assert set EQUALITY against it rather than a hard-coded
 * count — a count silently keeps passing when a member is added, which is the
 * exact failure this set already warns about one comment above.
 */
export function loggedEventTypes(): readonly string[] {
  return [...LOGGED_TYPES];
}

export function isLoggedEvent(value: unknown): value is SynCodeEvent {
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
