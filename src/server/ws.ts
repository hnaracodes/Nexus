import { randomUUID } from 'node:crypto';
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
  };

  runtime.agent = startAgent(room, (event) => runtime.commit(event), deps);
  runtimes.set(room.id, runtime);
  runtime.commit({ type: 'room_created', cwd: room.cwd, repoUrl: room.repoUrl });
  return runtime;
}

export function getRuntime(roomId: string): RoomRuntime | undefined {
  return runtimes.get(roomId);
}

export function newParticipantId(): string {
  return `p_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/** Test-only. Never call from server code. */
export function __resetRuntimes(): void {
  runtimes.clear();
}
