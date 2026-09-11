// tests/log/fleet-replay.test.ts
//
// Phase 12 (the fleet) needs the roster to survive a restart with no second
// source of truth (I3): `agent_spawned` / `agent_stopped`, replayed in order,
// are the only place "which agents does this room have, and are they still
// running" can live. This file covers the pure projection (`projectFleet`,
// alongside the unchanged `projectAgents`) and the recovery-time decision
// that follows from it (`recoverRooms`'s resource cap).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import { openLog } from '../../src/log/event-log.js';
import { projectAgents, projectFleet } from '../../src/log/replay.js';
import { __resetRooms } from '../../src/server/rooms.js';
import { recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/protocol-v1-room.jsonl', import.meta.url));
const TOKEN = 'a'.repeat(64);

/** Build a minimal event list with seq/ts/roomId auto-filled, matching the
 *  helper already used in replay.test.ts. */
function log(...partials: Record<string, unknown>[]): SynCodeEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-09-06T00:00:00.000Z', roomId: 'room_fleet', ...p }) as SynCodeEvent,
  );
}

describe('projectFleet', () => {
  it('reports a spawned, unstopped agent as still running, with provider and model intact', () => {
    const fleet = projectFleet(
      log(
        { type: 'room_created', cwd: '/work', repoUrl: null },
        {
          type: 'agent_spawned',
          agentId: 'reviewer',
          provider: 'openai',
          model: 'gpt-5.1',
          displayName: 'Reviewer',
          participantId: 'p_ada',
          spawnedByName: 'Ada',
        },
      ),
    );
    const reviewer = fleet.find((entry) => entry.agentId === 'reviewer');
    expect(reviewer).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.1',
      displayName: 'Reviewer',
      spawnedByParticipantId: 'p_ada',
      spawnedByName: 'Ada',
      stopped: false,
      stopReason: null,
    });
  });

  it('marks an agent stopped once a matching agent_stopped follows its spawn — order matters', () => {
    const fleet = projectFleet(
      log(
        { type: 'room_created', cwd: '/work', repoUrl: null },
        {
          type: 'agent_spawned',
          agentId: 'reviewer',
          provider: 'anthropic',
          model: null,
          displayName: 'Reviewer',
          participantId: 'p_ada',
          spawnedByName: 'Ada',
        },
        {
          type: 'agent_stopped',
          agentId: 'reviewer',
          reason: 'stopped',
          participantId: 'p_ada',
          stoppedByName: 'Ada',
        },
      ),
    );
    const reviewer = fleet.find((entry) => entry.agentId === 'reviewer');
    // This is the landmine: a spawn followed by a stop must never be read as
    // "still running", or recovery would re-attach an agent the room already
    // retired (D2 — a stopped id is never reused, so it must never come back).
    expect(reviewer).toMatchObject({ stopped: true, stopReason: 'stopped' });
  });

  it('carries two independently-live agents with their own provider and model', () => {
    const fleet = projectFleet(
      log(
        { type: 'room_created', cwd: '/work', repoUrl: null },
        {
          type: 'agent_spawned',
          agentId: 'reviewer',
          provider: 'openai',
          model: 'gpt-5.1',
          displayName: 'Reviewer',
          participantId: 'p_ada',
          spawnedByName: 'Ada',
        },
        {
          type: 'agent_spawned',
          agentId: 'tester',
          provider: 'google',
          model: 'gemini-3-pro',
          displayName: 'Tester',
          participantId: 'p_ada',
          spawnedByName: 'Ada',
        },
      ),
    );
    const live = fleet.filter((entry) => !entry.stopped).map((entry) => entry.agentId);
    expect(live.sort()).toEqual([PRIMARY_AGENT_ID, 'reviewer', 'tester'].sort());
    expect(fleet.find((e) => e.agentId === 'reviewer')).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.1',
    });
    expect(fleet.find((e) => e.agentId === 'tester')).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro',
    });
  });

  it('reports exactly the primary agent, unstopped, for a log written before agents had ids', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SynCodeEvent);
    const fleet = projectFleet(events);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({
      agentId: PRIMARY_AGENT_ID,
      provider: 'anthropic',
      stopped: false,
    });
  });
});

describe('projectAgents is unchanged by the fleet projection', () => {
  it('still returns bare ids inferred from occurrence, including a stopped agent', () => {
    // projectAgents is occurrence-based and deliberately knows nothing about
    // stop state (see its own doc comment) — that contract is pinned by tests
    // against a real pre-v3 fixture and by production logs, and projectFleet
    // is an ADDITION beside it, not a replacement. A stopped agent's id must
    // still appear here: this function answers "which ids ever existed", not
    // "which are still running" — that second question is projectFleet's job.
    const events = log(
      { type: 'room_created', cwd: '/work', repoUrl: null },
      {
        type: 'agent_spawned',
        agentId: 'reviewer',
        provider: 'anthropic',
        model: null,
        displayName: 'Reviewer',
        participantId: 'p_ada',
        spawnedByName: 'Ada',
      },
      {
        type: 'agent_stopped',
        agentId: 'reviewer',
        reason: 'stopped',
        participantId: 'p_ada',
        stoppedByName: 'Ada',
      },
    );
    expect(projectAgents(events).sort()).toEqual([PRIMARY_AGENT_ID, 'reviewer'].sort());
  });

  it('reports exactly the primary agent for the real pre-v3 fixture, same as before', () => {
    const events = readFileSync(FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as SynCodeEvent);
    expect(projectAgents(events)).toEqual([PRIMARY_AGENT_ID]);
  });
});

describe('recoverRooms rebuilds the fleet from the log alone', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nexus-fleet-recover-'));
    __resetRooms();
  });

  function seedRoom(roomId: string, events: SynCodeEvent[]): void {
    writeRoomMeta(
      { roomId, token: TOKEN, cwd: '/work', repoUrl: null, createdAt: '2026-09-06T00:00:00.000Z' },
      dir,
    );
    const roomLog = openLog(roomId, dir);
    for (const event of events) roomLog.append(event);
  }

  it('recovers WITHOUT an agent that was spawned then stopped before the crash', () => {
    seedRoom('room_a', [
      { seq: 1, ts: '2026-09-06T00:00:00.000Z', roomId: 'room_a', type: 'room_created', cwd: '/work', repoUrl: null },
      {
        seq: 2,
        ts: '2026-09-06T00:00:01.000Z',
        roomId: 'room_a',
        type: 'agent_spawned',
        agentId: 'reviewer',
        provider: 'anthropic',
        model: null,
        displayName: 'Reviewer',
        participantId: 'p_ada',
        spawnedByName: 'Ada',
      },
      {
        seq: 3,
        ts: '2026-09-06T00:00:02.000Z',
        roomId: 'room_a',
        type: 'agent_stopped',
        agentId: 'reviewer',
        reason: 'stopped',
        participantId: 'p_ada',
        stoppedByName: 'Ada',
      },
    ] as SynCodeEvent[]);

    const [recovered] = recoverRooms(dir);
    expect(recovered?.liveAgentIds).toEqual([PRIMARY_AGENT_ID]);
  });

  it('recovers two live agents together, with provider and model intact', () => {
    seedRoom('room_b', [
      { seq: 1, ts: '2026-09-06T00:00:00.000Z', roomId: 'room_b', type: 'room_created', cwd: '/work', repoUrl: null },
      {
        seq: 2,
        ts: '2026-09-06T00:00:01.000Z',
        roomId: 'room_b',
        type: 'agent_spawned',
        agentId: 'reviewer',
        provider: 'openai',
        model: 'gpt-5.1',
        displayName: 'Reviewer',
        participantId: 'p_ada',
        spawnedByName: 'Ada',
      },
      {
        seq: 3,
        ts: '2026-09-06T00:00:02.000Z',
        roomId: 'room_b',
        type: 'agent_spawned',
        agentId: 'tester',
        provider: 'google',
        model: 'gemini-3-pro',
        displayName: 'Tester',
        participantId: 'p_ada',
        spawnedByName: 'Ada',
      },
    ] as SynCodeEvent[]);

    const [recovered] = recoverRooms(dir);
    expect(recovered?.liveAgentIds.sort()).toEqual([PRIMARY_AGENT_ID, 'reviewer', 'tester'].sort());

    // Re-reading the log (a fresh open, not the cached one recovery used)
    // proves the provider/model came from the LOG, not from an in-memory
    // shortcut that would vanish on a second restart.
    const fleet = projectFleet(openLog('room_b', dir).read());
    expect(fleet.find((e) => e.agentId === 'reviewer')).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.1',
      stopped: false,
    });
    expect(fleet.find((e) => e.agentId === 'tester')).toMatchObject({
      provider: 'google',
      model: 'gemini-3-pro',
      stopped: false,
    });
  });

  it('recovers exactly the primary agent for a genuine pre-v3 log on disk', () => {
    // Copy the real fixture's bytes verbatim rather than re-authoring them —
    // the point of this test is that a log that PREDATES agent ids entirely
    // still recovers correctly, and only a byte-for-byte copy of a real
    // capture proves that rather than a synthesized approximation of it.
    const roomId = 'room_802c12cbc2704971';
    mkdirSync(join(resolve(dir), 'rooms'), { recursive: true });
    writeFileSync(join(resolve(dir), 'rooms', `${roomId}.jsonl`), readFileSync(FIXTURE));
    writeRoomMeta(
      {
        roomId,
        token: TOKEN,
        cwd: '/tmp/nexus-fixture/work/room_802c12cbc2704971',
        repoUrl: null,
        createdAt: '2026-08-30T21:09:18.759Z',
      },
      dir,
    );

    const [recovered] = recoverRooms(dir);
    expect(recovered?.liveAgentIds).toEqual([PRIMARY_AGENT_ID]);
  });

  it('honours a resource cap on recovery: never silently drops an agent, and never silently exceeds it', () => {
    seedRoom('room_c', [
      { seq: 1, ts: '2026-09-06T00:00:00.000Z', roomId: 'room_c', type: 'room_created', cwd: '/work', repoUrl: null },
      ...(['reviewer', 'tester', 'scribe'] as const).map(
        (id, i) =>
          ({
            seq: i + 2,
            ts: `2026-09-06T00:00:0${i + 1}.000Z`,
            roomId: 'room_c',
            type: 'agent_spawned',
            agentId: id,
            provider: 'anthropic',
            model: null,
            displayName: id,
            participantId: 'p_ada',
            spawnedByName: 'Ada',
          }) as SynCodeEvent,
      ),
    ]);
    // room_c has 4 live agents (primary + 3). Cap it at 2.
    const [recovered] = recoverRooms(dir, 2);

    // Never silently exceeds the cap.
    expect(recovered?.liveAgentIds).toHaveLength(2);
    // The primary agent is never the one sacrificed — too much of the rest of
    // the system assumes it exists (`RoomRuntime.agent` throws without it).
    expect(recovered?.liveAgentIds).toContain(PRIMARY_AGENT_ID);

    // Never silently drops one either: every agent this recovery declined to
    // resume must be explicitly recorded as stopped in the log, not just
    // absent from the returned roster — the whole point of the driver_released
    // precedent this mirrors is that log-truth and live-truth must never
    // quietly diverge (I3).
    const fleetAfter = projectFleet(openLog('room_c', dir).read());
    const stillLive = fleetAfter.filter((e) => !e.stopped).map((e) => e.agentId);
    const nowStopped = fleetAfter.filter((e) => e.stopped);
    expect(stillLive.sort()).toEqual(recovered?.liveAgentIds.slice().sort());
    expect(nowStopped).toHaveLength(2);
    for (const entry of nowStopped) {
      expect(entry.stopReason).toBe('capacity_exceeded');
    }
    // Nothing vanished: every originally-live agent is accounted for as
    // either still live or explicitly stopped.
    expect(stillLive.length + nowStopped.length).toBe(4);
  });
});
