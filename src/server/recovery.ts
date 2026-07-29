import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openLog } from '../log/event-log.js';
import { reconstruct } from '../log/replay.js';
import { restoreRoom } from './rooms.js';

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';

/**
 * Non-secret room metadata. There is deliberately no apiKey field: a recovered
 * room prompts its creator for the key again (I4). Adding one here would put a
 * live credential on a persistent volume.
 */
export interface RoomMeta {
  roomId: string;
  token: string;
  cwd: string;
  repoUrl: string | null;
  createdAt: string;
}

function metaPath(roomId: string, dataDir: string): string {
  return join(resolve(dataDir), 'rooms', `${roomId}.meta.json`);
}

export function writeRoomMeta(meta: RoomMeta, dataDir: string = DEFAULT_DATA_DIR): void {
  mkdirSync(join(resolve(dataDir), 'rooms'), { recursive: true });
  // Explicit field list — never spread a Room into this file.
  const safe: RoomMeta = {
    roomId: meta.roomId,
    token: meta.token,
    cwd: meta.cwd,
    repoUrl: meta.repoUrl,
    createdAt: meta.createdAt,
  };
  writeFileSync(metaPath(meta.roomId, dataDir), JSON.stringify(safe), 'utf8');
}

export function readRoomMetas(dataDir: string = DEFAULT_DATA_DIR): RoomMeta[] {
  const dir = join(resolve(dataDir), 'rooms');
  if (!existsSync(dir)) return [];
  const metas: RoomMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      metas.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as RoomMeta);
    } catch {
      continue; // A torn write is skipped, not fatal.
    }
  }
  return metas;
}

export function recoverRooms(
  dataDir: string = DEFAULT_DATA_DIR,
): { roomId: string; lastSeq: number; needsApiKey: true }[] {
  const recovered: { roomId: string; lastSeq: number; needsApiKey: true }[] = [];
  for (const meta of readRoomMetas(dataDir)) {
    const state = reconstruct(openLog(meta.roomId, dataDir).read());
    if (state === null) continue;
    // Put the room back in the live registry under its ORIGINAL id and token,
    // or the recovery is cosmetic: authorize() only reads that registry, so
    // the original link would still be refused and nobody could rejoin.
    // lastSeq continues the log's numbering — restarting at 0 re-issues
    // sequence numbers that already exist on disk and breaks I3.
    restoreRoom({
      id: meta.roomId,
      token: meta.token,
      cwd: meta.cwd,
      repoUrl: meta.repoUrl,
      createdAt: meta.createdAt,
      lastSeq: state.lastSeq,
    });
    recovered.push({ roomId: meta.roomId, lastSeq: state.lastSeq, needsApiKey: true });
  }
  return recovered;
}
