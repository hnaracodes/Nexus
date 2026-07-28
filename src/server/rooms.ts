import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface Participant {
  id: string;
  displayName: string;
  connected: boolean;
}

export interface CreateRoomOptions {
  apiKey: string;
  cwd: string;
  repoUrl: string | null;
}

export interface Room {
  readonly id: string;
  readonly token: string;
  readonly cwd: string;
  readonly repoUrl: string | null;
  readonly createdAt: string;
  readonly participants: Map<string, Participant>;
  readonly sockets: Set<unknown>;
  driverId: string | null;
  nextSeq(): number;
  peekSeq(): number;
  /** Restore the counter after replaying a log (plan phase-3a). */
  setSeq(value: number): void;
  getApiKey(): string;
  toJSON(): Record<string, unknown>;
}

/** Keys live here, never on the room object itself. */
const apiKeys = new WeakMap<Room, string>();
const rooms = new Map<string, Room>();

export function createRoom(opts: CreateRoomOptions): Room {
  let seq = 0;
  const room: Room = {
    id: `room_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    token: randomBytes(32).toString('hex'),
    cwd: opts.cwd,
    repoUrl: opts.repoUrl,
    createdAt: new Date().toISOString(),
    participants: new Map(),
    sockets: new Set(),
    driverId: null,
    nextSeq: () => ++seq,
    peekSeq: () => seq,
    setSeq: (value: number) => {
      seq = value;
    },
    getApiKey: () => {
      const key = apiKeys.get(room);
      if (key === undefined) throw new Error(`room ${room.id} has no API key`);
      return key;
    },
    // Explicit allowlist. Never spread the room into a serialized shape.
    toJSON: () => ({
      id: room.id,
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      driverId: room.driverId,
    }),
  };
  apiKeys.set(room, opts.apiKey);
  rooms.set(room.id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

/** Constant-time comparison — the token is the only credential in the MVP. */
export function authorize(id: string, token: string): Room | undefined {
  const room = rooms.get(id);
  if (room === undefined) return undefined;
  const expected = Buffer.from(room.token, 'utf8');
  const supplied = Buffer.from(token, 'utf8');
  if (expected.length !== supplied.length) return undefined;
  return timingSafeEqual(expected, supplied) ? room : undefined;
}

/** Test-only. Never call from server code. */
export function __resetRooms(): void {
  rooms.clear();
}
