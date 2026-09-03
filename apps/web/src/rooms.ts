const STORAGE_KEY = 'nexus:rooms';
const MAX_ROOMS = 10;

/**
 * A room this browser has previously joined, kept only so the room switcher
 * can offer "recent rooms" without a server-side account system. This
 * persists a full room access token in `localStorage` — a real credential,
 * not a preference. See the switcher's Forget / Forget all controls and
 * footer disclosure, which exist specifically because of this file.
 */
export interface RecentRoom {
  roomId: string;
  token: string;
  displayName: string;
  /** Repo name if known, else a short room id — whatever labels the room in the UI. */
  label: string;
  lastSeenAt: number;
}

function isRecentRoom(value: unknown): value is RecentRoom {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.roomId === 'string' &&
    typeof candidate.token === 'string' &&
    typeof candidate.displayName === 'string' &&
    typeof candidate.label === 'string' &&
    typeof candidate.lastSeenAt === 'number'
  );
}

/**
 * Every access wrapped in try/catch, exactly as `ws.ts`'s identity storage
 * does: private mode, disabled storage and corrupt JSON all degrade to "no
 * history", never to a thrown error the user has to see.
 */
function readAll(): RecentRoom[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentRoom);
  } catch {
    return [];
  }
}

function writeAll(rooms: RecentRoom[]): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(rooms));
  } catch {
    // Storage unavailable or over quota: the switcher just has no history
    // this session. Never surface this to the user.
  }
}

/** Newest first. */
export function readRecentRooms(): RecentRoom[] {
  return readAll().sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Upserts by `roomId`; keeps at most the 10 most recently seen rooms. */
export function rememberRoom(room: RecentRoom): void {
  const rest = readAll().filter((existing) => existing.roomId !== room.roomId);
  const merged = [...rest, room].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  writeAll(merged.slice(0, MAX_ROOMS));
}

export function forgetRoom(roomId: string): void {
  writeAll(readAll().filter((room) => room.roomId !== roomId));
}

export function forgetAllRooms(): void {
  writeAll([]);
}
