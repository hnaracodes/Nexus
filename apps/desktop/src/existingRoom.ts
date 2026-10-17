import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Find the room that already owns a folder, so "Open a folder" can take the
 * host back to it instead of refusing.
 *
 * Reported live: "now i cant create rooms for my folders". Every folder the
 * user owned — three projects — already had a room from an earlier attempt.
 * The server (correctly) refuses a second room on one directory, and on every
 * launch recovery re-claims each folder for its old room, so the app answered
 * "That folder is already open in another room." for ALL of them, with nothing
 * to click that led back to the room it was talking about. A desktop editor's
 * "open folder" is idempotent: doing it twice puts you where you were.
 *
 * This reads the HOST'S OWN data directory, in the main process, rather than
 * adding a server endpoint that hands out room tokens. A room's token is its
 * credential (CLAUDE.md §11) and already sits in plaintext in these sidecars,
 * readable by the same user who is running this app; teaching the server to
 * return one in response to a folder path would be a new door for no gain.
 *
 * Pure over an injected filesystem, like `launcher.ts` and `hostGuard.ts`,
 * because `main.ts` imports `electron` and cannot be unit-tested.
 */

export interface ExistingRoomFs {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  realpathSync(path: string): string;
}

export interface ExistingRoom {
  roomId: string;
  token: string;
}

interface Sidecar {
  roomId: string;
  token: string;
  cwd: string;
  createdAt: string;
}

const REAL_FS: ExistingRoomFs = { readdirSync, readFileSync, realpathSync };

/** Realpath when the path exists; the raw string when it does not — a folder
 *  that was moved or deleted since the room was made must still compare, if
 *  only as text, rather than throwing out of the whole lookup. */
function canonical(path: string, fs: ExistingRoomFs): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** macOS and Windows filesystems are case-insensitive by default, so a pick
 *  spelled in another case IS the same folder there; on Linux two folders can
 *  legitimately differ only by case and folding would merge them. */
function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (a === b) return true;
  return (platform === 'darwin' || platform === 'win32') && a.toLowerCase() === b.toLowerCase();
}

function parseSidecar(raw: string): Sidecar | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // A torn write (a crash mid-save) is skipped, never fatal — the same
    // tolerance `readRoomMetas` has on the server side.
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const { roomId, token, cwd, createdAt } = v;
  if (typeof roomId !== 'string' || roomId === '') return undefined;
  // No token means nobody can enter that room, so returning it would send the
  // host to a door with no key — better to fall through and make a fresh one.
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof cwd !== 'string' || cwd === '') return undefined;
  return { roomId, token, cwd, createdAt: typeof createdAt === 'string' ? createdAt : '' };
}

export function findRoomForFolder(
  dataDir: string,
  folder: string,
  opts: { fs?: ExistingRoomFs; platform?: NodeJS.Platform } = {},
): ExistingRoom | undefined {
  const fs = opts.fs ?? REAL_FS;
  const platform = opts.platform ?? process.platform;

  let names: string[];
  try {
    names = fs.readdirSync(join(dataDir, 'rooms'));
  } catch {
    return undefined; // fresh install: nothing has ever been created
  }

  // The server stores the REALPATH of whatever was picked, so the pick is
  // resolved the same way before comparing — a symlinked folder would never
  // match its target's stored path otherwise.
  const wanted = canonical(folder, fs);

  let best: Sidecar | undefined;
  for (const name of names) {
    if (!name.endsWith('.meta.json')) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(join(dataDir, 'rooms', name), 'utf8');
    } catch {
      continue;
    }
    const sidecar = parseSidecar(raw);
    if (sidecar === undefined) continue;
    if (!sameFolder(canonical(sidecar.cwd, fs), wanted, platform)) continue;
    // Old data can hold more than one room for a folder (the one-room-per-path
    // guard is in-memory and only came later); the newest is the live one.
    if (best === undefined || sidecar.createdAt > best.createdAt) best = sidecar;
  }

  return best === undefined ? undefined : { roomId: best.roomId, token: best.token };
}
