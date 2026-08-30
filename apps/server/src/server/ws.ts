import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { AgentId, NexusEvent, UnsequencedEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID } from '@nexus/protocol/events';
import type { ServerFrame } from '@nexus/protocol/wire';
import { createSink } from '../log/index.js';
import { redactEvent } from '../log/redact.js';
import type { AgentDeps, AgentHandle } from './agent.js';
import type { Decision } from './permissions.js';
import { startAgent } from './agent.js';
import type { Room } from './rooms.js';
import type { WorkspaceWatcherHandle } from './watcher.js';
import { startWorkspaceWatcher } from './watcher.js';

/** Implemented durably by `src/log/` (plan phase-1a). */
export interface EventSink {
  append(event: NexusEvent): void;
  read(): NexusEvent[];
}

/**
 * Non-durable sink, kept for tests that must not touch the filesystem. Never
 * the default: state that exists only in memory is lost on restart, which I3
 * forbids.
 */
export class MemorySink implements EventSink {
  #events: NexusEvent[] = [];
  append(event: NexusEvent): void {
    this.#events.push(event);
  }
  read(): NexusEvent[] {
    return this.#events;
  }
}

export interface RoomRuntime {
  room: Room;
  /**
   * The primary agent.
   *
   * Deliberately kept after phase 8b rather than removed. Three room-level
   * operations still reach for it — `listModels`, `set_model` and `interrupt` —
   * and each raises a question that belongs to phase 12, not here: does Stop
   * stop every agent or one, and is a model a property of the room or of an
   * agent? Answering those now, with no fleet to validate against, would be
   * guessing. Prompts and permission decisions ARE routed per agent, because
   * for those the right answer is already knowable.
   */
  readonly agent: AgentHandle;
  /**
   * Every agent attached to this room. One entry until phase 12; the map is
   * what lets there be more without reshaping the runtime again.
   */
  agents: Map<AgentId, AgentHandle>;
  /** Undefined for an unknown id — deliberately NOT a fallback to the primary
   *  agent, since silently steering the wrong agent is worse than failing. */
  getAgent(agentId?: AgentId): AgentHandle | undefined;
  /**
   * I1, re-scoped per agent: attaching an id that already exists returns the
   * existing handle rather than starting a second session for it. N agents may
   * coexist; a given agent is never re-instantiated, so no viewer and no second
   * attach can fork its context window.
   */
  attachAgent(agentId: AgentId, deps?: AgentDeps): AgentHandle;
  /**
   * Stored so a future teardown path has something to close. There is no
   * room-teardown mechanism in this codebase today (`runtimes` only grows;
   * `__resetRuntimes()` is test-only) — this does not invent one, it just
   * avoids leaving the handle stranded nowhere if one is ever added.
   */
  workspaceWatcher: WorkspaceWatcherHandle;
  sink: EventSink;
  broadcast(frame: ServerFrame): void;
  /** Seal an unsequenced event: assign seq + ts, append to the sink, broadcast. */
  commit(event: UnsequencedEvent): NexusEvent;
  /** `commit`, attributed to a specific agent. See the implementation for why
   *  the primary agent is deliberately left unstamped. */
  commitAs(agentId: AgentId, event: UnsequencedEvent): NexusEvent;
  /**
   * Settle a pending approval on the agent that actually holds it.
   *
   * Request ids are minted per gate, so with more than one agent a bare id is
   * ambiguous. When the client names an agent, ONLY that agent's gate is tried;
   * a mismatch returns false rather than falling through, because settling a
   * different agent's tool call with a vote cast on this one is an unauthorised
   * approval, not a routing inconvenience. When no agent is named — every
   * pre-phase-8b client — the gates are searched, which is safe because ids are
   * random and unique in practice.
   */
  resolvePermission(requestId: string, decision: Decision, agentId?: AgentId): boolean;
  addSocket(socket: WebSocket, participantId: string): void;
  removeSocket(socket: WebSocket): void;
  socketCount(): number;
  /**
   * How many open sockets currently share one identity. Once a reconnecting
   * client can reclaim its id, two tabs legitimately hold the same one, and
   * closing either must not be mistaken for the person leaving.
   */
  participantSocketCount(participantId: string): number;
}

const runtimes = new Map<string, RoomRuntime>();

export function attachRoom(
  room: Room,
  sink: EventSink = createSink(room.id),
  deps: AgentDeps = {},
): RoomRuntime {
  const existing = runtimes.get(room.id);
  if (existing !== undefined) return existing; // I1: never a second agent.

  const sockets = new Map<WebSocket, string>();

  const agents = new Map<AgentId, AgentHandle>();

  const runtime: RoomRuntime = {
    room,
    sink,
    agents,
    get agent(): AgentHandle {
      return agents.get(PRIMARY_AGENT_ID) as AgentHandle;
    },
    getAgent(agentId: AgentId = PRIMARY_AGENT_ID): AgentHandle | undefined {
      return agents.get(agentId);
    },
    attachAgent(agentId: AgentId, agentDeps: AgentDeps = {}): AgentHandle {
      const already = agents.get(agentId);
      if (already !== undefined) return already; // I1, per agent.
      const handle = startAgent(room, (event) => runtime.commitAs(agentId, event), {
        readEvents: () => sink.read(),
        ...deps,
        ...agentDeps,
      });
      agents.set(agentId, handle);
      return handle;
    },
    workspaceWatcher: undefined as unknown as WorkspaceWatcherHandle,
    broadcast(frame: ServerFrame): void {
      const payload = JSON.stringify(frame);
      for (const socket of sockets.keys()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    commit(event: UnsequencedEvent): NexusEvent {
      return runtime.commitAs(PRIMARY_AGENT_ID, event);
    },
    commitAs(agentId: AgentId, event: UnsequencedEvent): NexusEvent {
      // Redact ONCE, here, and use that single object for all three
      // destinations. Previously the sink redacted into a new object while the
      // broadcast — and the return value — still carried the original, so a
      // secret was scrubbed from disk and sent verbatim to every attached
      // browser in the same call. Replay looked clean, which is exactly why no
      // replay-based test ever caught it (I4).
      //
      // The sink redacts again. That is deliberate: redaction is idempotent
      // (`[REDACTED]` contains no pattern, and slicing twice is a no-op), and
      // keeping it there preserves the write-boundary guarantee for callers
      // that reach the log directly, such as recovery.ts.
      // The primary agent is deliberately left UNSTAMPED. `agentIdOf()` already
      // reads an absent agentId as the primary agent, so stamping it would add
      // a field to every event in every single-agent room for no information
      // gain — and would make new logs gratuitously different from the v1 logs
      // already on the production volume. Zero log churn until a room actually
      // has a second agent.
      const sealed = redactEvent({
        ...event,
        ...(agentId === PRIMARY_AGENT_ID ? {} : { agentId }),
        seq: room.nextSeq(),
        ts: new Date().toISOString(),
        roomId: room.id,
      } as NexusEvent);
      sink.append(sealed);
      runtime.broadcast({ kind: 'event', event: sealed });
      return sealed;
    },
    resolvePermission(requestId: string, decision: Decision, agentId?: AgentId): boolean {
      if (agentId !== undefined) {
        return agents.get(agentId)?.gate.resolve(requestId, decision) ?? false;
      }
      for (const handle of agents.values()) {
        if (handle.gate.resolve(requestId, decision)) return true;
      }
      return false;
    },
    addSocket(socket: WebSocket, participantId: string): void {
      sockets.set(socket, participantId);
      room.sockets.add(socket);
    },
    removeSocket(socket: WebSocket): void {
      sockets.delete(socket);
      room.sockets.delete(socket);
    },
    socketCount(): number {
      return sockets.size;
    },
    participantSocketCount(participantId: string): number {
      let count = 0;
      for (const id of sockets.values()) if (id === participantId) count += 1;
      return count;
    },
  };

  // `readEvents` is threaded in here because this is the only place that holds
  // the sink. The publish tool uses it to find the room's own last published
  // commit from the log rather than from memory (I3) — which is what lets a
  // restarted room keep publishing to the same pull request.
  runtime.attachAgent(PRIMARY_AGENT_ID);
  // Lives inside this memoized gate for the same reason the agent does: the
  // `existing !== undefined` early return above is what guarantees a room
  // cannot accumulate N watchers (I1's one-resource discipline, applied to a
  // second resource). `workspace_changed` is transient and unlogged — see the
  // comment on `ServerFrame` in `packages/protocol/src/wire.ts` — so it goes straight
  // to broadcast() and nowhere near commit().
  runtime.workspaceWatcher = startWorkspaceWatcher(room, (paths, truncated) => {
    runtime.broadcast({ kind: 'workspace_changed', paths, truncated });
  });
  runtimes.set(room.id, runtime);
  // A room recovered from disk (plan phase-3a) already has `room_created` in
  // its log. Committing a second one on every re-key would permanently pollute
  // the history — the log is append-only, so a duplicate can never be removed.
  if (!sink.read().some((event) => event.type === 'room_created')) {
    runtime.commit({
      type: 'room_created',
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      github: room.github,
    });
  }
  return runtime;
}

export function getRuntime(roomId: string): RoomRuntime | undefined {
  return runtimes.get(roomId);
}

export function newParticipantId(): string {
  return `p_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Shape of ids this server mints. A reclaim attempt must match it. */
const PARTICIPANT_ID_PATTERN = /^p_[0-9a-f]{12}$/;

/**
 * Secrets that let a returning socket prove it is the same participant.
 * Per room, never logged, never broadcast, never persisted — losing them on
 * restart is correct, because a recovered room's roster is empty anyway.
 */
const resumeTokens = new WeakMap<Room, Map<string, string>>();

function tokensFor(room: Room): Map<string, string> {
  const existing = resumeTokens.get(room);
  if (existing !== undefined) return existing;
  const created = new Map<string, string>();
  resumeTokens.set(room, created);
  return created;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Decide who an incoming socket is.
 *
 * A reconnecting client may offer back the id it was given plus the resume
 * token that came with it. All three must line up — the id must still be on
 * the roster, the token must match, and the display name must be the same one
 * that id already belongs to. Anything else — absent, malformed, unknown, bad
 * token, different name — mints a fresh identity, which is exactly the old
 * behaviour.
 *
 * The token matters: participant ids are broadcast to the whole room inside
 * `participant_joined`, so honouring a bare id would let any member reconnect
 * as the current driver and inherit the token. That is an I2 bypass at the
 * server, which is the one place I2 is supposed to hold. Identity is therefore
 * a capability you hold, not a name you can read off the log.
 *
 * The name matters for a subtler reason, found by opening two tabs in one
 * browser: tabs share localStorage, so the second person to open a room link
 * on a shared machine offers back the first person's stored identity holding a
 * perfectly valid token. The token proves "same browser storage", not "same
 * person" — without this check the two collapse into one roster row whose name
 * flips between them, and the second inherits the first's driver token.
 */
export function resolveParticipantId(
  room: Room,
  requestedId: string | null,
  resumeToken: string | null,
  displayName: string,
): { participantId: string; resumeToken: string } {
  const tokens = tokensFor(room);

  if (
    requestedId !== null &&
    resumeToken !== null &&
    PARTICIPANT_ID_PATTERN.test(requestedId) &&
    room.participants.get(requestedId)?.displayName === displayName
  ) {
    const expected = tokens.get(requestedId);
    if (expected !== undefined && safeEqual(expected, resumeToken)) {
      return { participantId: requestedId, resumeToken: expected };
    }
  }

  const participantId = newParticipantId();
  const issued = randomBytes(32).toString('hex');
  tokens.set(participantId, issued);
  return { participantId, resumeToken: issued };
}

/** Test-only. Never call from server code. */
export function __resetRuntimes(): void {
  runtimes.clear();
}
