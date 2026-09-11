import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AgentId, GithubRepoRef, SynCodeEvent } from '@syncode/protocol/events';
import { openLog } from '../log/event-log.js';
import { projectFleet, reconstruct } from '../log/replay.js';
import { claimLocalPath } from './localHost.js';
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
  /**
   * The GitHub binding, when there is one (plan phase-6). Persisting this is
   * what makes "authorize once, ever" true across restarts — and it is safe
   * precisely because it is NOT a credential: an installation id is a public
   * identifier, and every token is re-minted from the App private key on
   * demand. Contrast `apiKey`, which is deliberately absent above.
   */
  github?: GithubRepoRef | null;
}

function metaPath(roomId: string, dataDir: string): string {
  return join(resolve(dataDir), 'rooms', `${roomId}.meta.json`);
}

export function writeRoomMeta(meta: RoomMeta, dataDir: string = DEFAULT_DATA_DIR): void {
  mkdirSync(join(resolve(dataDir), 'rooms'), { recursive: true });
  // Explicit field list — never spread a Room into this file. The cost of that
  // discipline is that adding a field to RoomMeta above does NOT add it here:
  // it compiles, typechecks, passes tests, and silently writes nothing. Any
  // new field must be added in both places, and proved with a write→read round
  // trip rather than an assertion about the type.
  const safe: RoomMeta = {
    roomId: meta.roomId,
    token: meta.token,
    cwd: meta.cwd,
    repoUrl: meta.repoUrl,
    createdAt: meta.createdAt,
    github: meta.github ?? null,
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

/**
 * How many of ONE room's agents recovery will resume automatically.
 *
 * Deliberately a fixed number, not `fleet.ts`'s measured, spawn-time cap (plan
 * D1: `os.totalmem()` / `os.freemem()` read at the moment a NEW agent is about
 * to start). Recovery runs once, unconditionally, at boot — often long before
 * anyone reconnects and the room is actually attached — so a memory reading
 * taken here would describe a machine state that may no longer hold by the
 * time it matters (the same "wrong moment" reasoning D3 uses for the approval
 * timeout: measure at the moment that is actually relevant, not the moment
 * that is merely convenient). What recovery CAN decide safely, once, is how
 * many of one room's agents get to keep calling themselves "still running"
 * going forward — a stable number here is more honest than a precise-looking
 * measurement of a moment that will already be stale by the time anyone acts
 * on it.
 */
export const DEFAULT_RECOVERY_AGENT_CAP = 6;

export function recoverRooms(
  dataDir: string = DEFAULT_DATA_DIR,
  maxAgentsPerRoom: number = DEFAULT_RECOVERY_AGENT_CAP,
): { roomId: string; lastSeq: number; needsApiKey: true; liveAgentIds: AgentId[] }[] {
  const recovered: { roomId: string; lastSeq: number; needsApiKey: true; liveAgentIds: AgentId[] }[] =
    [];
  for (const meta of readRoomMetas(dataDir)) {
    // One room's corrupt log or unsafe id must not take the rest of recovery
    // (and therefore server startup) down with it — mirrors the torn-write
    // tolerance in readRoomMetas above, just one level further in.
    try {
      const log = openLog(meta.roomId, dataDir);
      const events = log.read();
      const state = reconstruct(events);
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
        } as SynCodeEvent);
      }

      // The fleet's counterpart to the driver-token branch above, same shape:
      // never silently drop an agent the log says was running, and never
      // silently restore more than the room can actually hold — record the
      // decision in the log instead, so a log-only reader and what actually
      // gets re-attached later never disagree (I3). Unlike the driver seat,
      // resuming a live agent is NOT inherently wrong — attachAgent already
      // recreates the primary agent this way on every restart, agentId
      // included, and that has always been correct (I1) — so an agent within
      // the cap gets no synthetic event at all; it stays exactly as "still
      // running" as the log already said, and a later attach (ws.ts, on
      // demand) is a resumption, not a discrepancy. Only the agents THIS
      // room cannot resume need their fate written down now: recovery is the
      // one place a room's whole fleet is ever considered at once, so if this
      // is the moment that declines to bring an agent back, that decision has
      // to be on the record or nothing ever will be.
      const fleet = projectFleet(events);
      const live = fleet.filter((entry) => !entry.stopped);
      const resumed = live.slice(0, maxAgentsPerRoom);
      const overCap = live.slice(maxAgentsPerRoom);

      if (overCap.length > 0) {
        console.log(
          `room ${meta.roomId}: ${live.length} agents were running when the server stopped; ` +
            `only ${maxAgentsPerRoom} will resume. Not resuming: ${overCap
              .map((entry) => entry.agentId)
              .join(', ')}`,
        );
      }

      for (const entry of overCap) {
        lastSeq += 1;
        log.append({
          seq: lastSeq,
          ts: new Date().toISOString(),
          roomId: meta.roomId,
          type: 'agent_stopped',
          agentId: entry.agentId,
          reason: 'capacity_exceeded',
          participantId: null,
          stoppedByName: null,
        } as SynCodeEvent);
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
        // Carried back so a recovered room can still clone and publish
        // without asking the human to reconnect GitHub.
        github: meta.github ?? null,
      });

      // `claimedPaths` (localHost.ts) is the in-memory-only guard against
      // two live rooms sharing one `localPath`, and it starts every process
      // empty — including THIS one, restarting right now. Without this, a
      // restart silently drops that guard: the recovered room above is
      // still live and still owns `meta.cwd`, but nothing on the new
      // process's claim set says so, so a second `localPath` room at the
      // exact same folder would be wrongly accepted. Claimed by realpath,
      // like every other entry in the set (`validateLocalRoomPath` compares
      // realpaths), and best-effort: a folder deleted since the room was
      // created has nothing to claim, and that is not this loop's problem to
      // solve — the room's agent will surface a missing cwd on its own if it
      // is ever attached again. Applied to every recovered room, not only
      // ones the desktop shell happens to remember creating via `localPath`
      // — RoomMeta does not distinguish the two, and claiming an ordinary
      // cloned room's workdir is harmless: no real project folder a person
      // picks will ever collide with `NEXUS_WORKDIR/<roomId>`.
      try {
        claimLocalPath(realpathSync(meta.cwd));
      } catch {
        // cwd no longer exists on disk — nothing to claim.
      }

      recovered.push({
        roomId: meta.roomId,
        lastSeq,
        needsApiKey: true,
        liveAgentIds: resumed.map((entry) => entry.agentId),
      });
    } catch (error) {
      console.log(`failed to recover room ${meta.roomId}: ${error}`);
      continue;
    }
  }
  return recovered;
}
