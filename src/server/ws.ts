import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { NexusEvent, UnsequencedEvent } from '../protocol/events.js';
import type { ServerFrame } from '../protocol/wire.js';
import { createSink } from '../log/index.js';
import type { AgentDeps, AgentHandle } from './agent.js';
import { startAgent } from './agent.js';
import type { Room } from './rooms.js';

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
  agent: AgentHandle;
  sink: EventSink;
  broadcast(frame: ServerFrame): void;
  /** Seal an unsequenced event: assign seq + ts, append to the sink, broadcast. */
  commit(event: UnsequencedEvent): NexusEvent;
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

  const runtime: RoomRuntime = {
    room,
    sink,
    agent: undefined as unknown as AgentHandle,
    broadcast(frame: ServerFrame): void {
      const payload = JSON.stringify(frame);
      for (const socket of sockets.keys()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    commit(event: UnsequencedEvent): NexusEvent {
      const sealed = {
        ...event,
        seq: room.nextSeq(),
        ts: new Date().toISOString(),
        roomId: room.id,
      } as NexusEvent;
      sink.append(sealed);
      runtime.broadcast({ kind: 'event', event: sealed });
      return sealed;
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

  runtime.agent = startAgent(room, (event) => runtime.commit(event), deps);
  runtimes.set(room.id, runtime);
  // A room recovered from disk (plan phase-3a) already has `room_created` in
  // its log. Committing a second one on every re-key would permanently pollute
  // the history — the log is append-only, so a duplicate can never be removed.
  if (!sink.read().some((event) => event.type === 'room_created')) {
    runtime.commit({ type: 'room_created', cwd: room.cwd, repoUrl: room.repoUrl });
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
 * token that came with it. Both must match, and the id must still be on the
 * roster. Anything else — absent, malformed, unknown, or a bad token — mints a
 * fresh identity, which is exactly the old behaviour.
 *
 * The token matters: participant ids are broadcast to the whole room inside
 * `participant_joined`, so honouring a bare id would let any member reconnect
 * as the current driver and inherit the token. That is an I2 bypass at the
 * server, which is the one place I2 is supposed to hold. Identity is therefore
 * a capability you hold, not a name you can read off the log.
 */
export function resolveParticipantId(
  room: Room,
  requestedId: string | null,
  resumeToken: string | null,
): { participantId: string; resumeToken: string } {
  const tokens = tokensFor(room);

  if (
    requestedId !== null &&
    resumeToken !== null &&
    PARTICIPANT_ID_PATTERN.test(requestedId) &&
    room.participants.has(requestedId)
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
