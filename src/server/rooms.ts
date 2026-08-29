import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { GithubRepoRef } from '@nexus/protocol/events';

export interface Participant {
  id: string;
  displayName: string;
  connected: boolean;
}

export interface CreateRoomOptions {
  apiKey: string;
  cwd: string;
  repoUrl: string | null;
  /**
   * Pre-minted id. A caller that must prepare a per-room working directory
   * *before* the room exists (plan phase-3c clones into `work/<roomId>`) mints
   * the id with `mintRoomId()`, prepares the directory, then passes both here.
   * Without this, `cwd` — which is readonly and consumed by `startAgent` the
   * moment the room is attached — could only ever be the server's own checkout.
   */
  id?: string;
  /** Set when the room was created through the GitHub App flow (phase-6). */
  github?: GithubRepoRef | null;
}

/** What a room needs to come back after a restart. Deliberately no `apiKey`. */
export interface RestoreRoomOptions {
  id: string;
  token: string;
  cwd: string;
  repoUrl: string | null;
  createdAt: string;
  /** Continue the log's numbering. Restarting at 0 would re-issue sequence
   *  numbers that already exist on disk, which breaks I3. */
  lastSeq: number;
  /**
   * Unlike the API key, this SURVIVES a restart — and must, or the human
   * would have to re-authorize GitHub every time the process bounced. It is
   * safe to persist precisely because it holds no credential: every token is
   * minted fresh from the App private key at the moment it is needed.
   */
  github?: GithubRepoRef | null;
}

export interface Room {
  readonly id: string;
  readonly token: string;
  readonly cwd: string;
  readonly repoUrl: string | null;
  /**
   * Fixed at creation, like `cwd`. Attaching a repository afterwards would
   * mean either mutating a readonly field the agent has already read (I1) or
   * committing a second, contradictory `room_created` — which reconstruct()'s
   * first-match `events.find()` would keep believing the stale version of (I3).
   * So a room's GitHub binding is decided once and never changes.
   */
  readonly github: GithubRepoRef | null;
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

/** Mint an id without building the room, so a caller can name a per-room
 *  working directory before `createRoom` freezes `cwd`. */
export function mintRoomId(): string {
  return `room_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

interface RoomSeed {
  id: string;
  token: string;
  cwd: string;
  repoUrl: string | null;
  createdAt: string;
  lastSeq: number;
  github: GithubRepoRef | null;
}

/** One shape for both a fresh and a recovered room, so the two cannot drift. */
function buildRoom(seed: RoomSeed): Room {
  let seq = seed.lastSeq;
  const room: Room = {
    id: seed.id,
    token: seed.token,
    cwd: seed.cwd,
    repoUrl: seed.repoUrl,
    github: seed.github,
    createdAt: seed.createdAt,
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
      // Safe to expose: holds no credential, and the client shows which repo
      // the room is bound to.
      github: room.github,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      driverId: room.driverId,
    }),
  };
  return room;
}

export function createRoom(opts: CreateRoomOptions): Room {
  const room = buildRoom({
    id: opts.id ?? mintRoomId(),
    token: randomBytes(32).toString('hex'),
    cwd: opts.cwd,
    repoUrl: opts.repoUrl,
    createdAt: new Date().toISOString(),
    lastSeq: 0,
    github: opts.github ?? null,
  });
  apiKeys.set(room, opts.apiKey);
  rooms.set(room.id, room);
  return room;
}

/**
 * Re-register a room rebuilt from its durable sidecar after a restart (plan
 * phase-3a), under its ORIGINAL id and token so existing links keep working.
 * Without this the registry is empty after a restart, `authorize()` finds
 * nothing, and a "recovered" room can never actually be rejoined.
 *
 * Sets no API key on purpose: I4 forbids persisting one, so a recovered room
 * stays keyless until its creator re-supplies it through `attachApiKey`.
 */
export function restoreRoom(opts: RestoreRoomOptions): Room {
  const room = buildRoom({
    id: opts.id,
    token: opts.token,
    cwd: opts.cwd,
    repoUrl: opts.repoUrl,
    createdAt: opts.createdAt,
    lastSeq: opts.lastSeq,
    github: opts.github ?? null,
  });
  rooms.set(room.id, room);
  return room;
}

/** Supply the key a recovered room could not persist (I4). */
export function attachApiKey(room: Room, apiKey: string): void {
  apiKeys.set(room, apiKey);
}

/** A recovered room has no key until its creator returns. Callers use this to
 *  refuse work rather than throwing out of `getApiKey`. */
export function hasApiKey(room: Room): boolean {
  return apiKeys.has(room);
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

/** How many rooms are currently live. Used to cap unbounded room creation. */
export function roomCount(): number {
  return rooms.size;
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
