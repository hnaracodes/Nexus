import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NexusEvent } from '../protocol/events.js';
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
    // One room's corrupt log or unsafe id must not take the rest of recovery
    // (and therefore server startup) down with it — mirrors the torn-write
    // tolerance in readRoomMetas above, just one level further in.
    try {
      const log = openLog(meta.roomId, dataDir);
      const state = reconstruct(log.read());
      if (state === null) {
        // Reachable in normal operation: the sidecar is written before the
        // first room_created is committed, so a crash between the two leaves
        // a link nobody can honour. Say so rather than skipping in silence.
        console.log(`skipping room ${meta.roomId}: its log has no room_created event`);
        continue;
      }

      let lastSeq = state.lastSeq;

      // The log says someone still held the token when the process died, but
      // their socket is gone and nothing will ever auto-release it — the
      // grace timer is only ever armed by a socket closing. Restoring the
      // driver would wedge the seat permanently; dropping it silently would
      // make live state disagree with what the log reconstructs to, and leave
      // a later uncontested driver_granted that a log-only reader cannot
      // explain. So record the transition explicitly instead (I3).
      if (state.driverId !== null) {
        const holder = state.participants.find((p) => p.participantId === state.driverId);
        lastSeq += 1;
        log.append({
          seq: lastSeq,
          ts: new Date().toISOString(),
          roomId: meta.roomId,
          type: 'driver_released',
          participantId: state.driverId,
          displayName: holder?.displayName ?? state.driverId,
          reason: 'server_restart',
        } as NexusEvent);
      }

      // Put the room back in the live registry under its ORIGINAL id and
      // token, or the recovery is cosmetic: authorize() only reads that
      // registry, so the original link would still be refused and nobody
      // could rejoin. lastSeq continues the log's numbering — restarting at
      // 0 re-issues sequence numbers that already exist on disk and breaks
      // I3.
      restoreRoom({
        id: meta.roomId,
        token: meta.token,
        cwd: meta.cwd,
        repoUrl: meta.repoUrl,
        createdAt: meta.createdAt,
        lastSeq,
      });
      recovered.push({ roomId: meta.roomId, lastSeq, needsApiKey: true });
    } catch (error) {
      console.log(`failed to recover room ${meta.roomId}: ${error}`);
      continue;
    }
  }
  return recovered;
}
