import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, isLoggedEvent } from '@nexus/protocol/events';
import { projectAgents, reconstruct } from '../../src/log/replay.js';

/**
 * The safety net for the phase-8b `agentId` migration.
 *
 * These are CHARACTERIZATION tests, not TDD tests: they pass the moment they are
 * written, because their job is to pin down behaviour that already works so the
 * migration cannot change it silently. The TDD tests for the new behaviour live
 * in `agent-id.test.ts`.
 *
 * The fixture is a real protocol-v1 room log — every one of the 20 members of
 * `LOGGED_TYPES`, captured from a running server before any v2 protocol change
 * existed, with no `agentId` anywhere. It stands in for the logs already on disk
 * on the production volume, which I3 forbids mutating and which must keep
 * replaying forever.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/protocol-v1-room.jsonl', import.meta.url));

function readFixture(): NexusEvent[] {
  return readFileSync(FIXTURE, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as NexusEvent);
}

describe('protocol v1 logs on disk', () => {
  it('is a genuine v1 fixture: no event carries an agentId', () => {
    // If this ever fails, the fixture has been "helpfully" migrated and stops
    // testing the thing it exists to test.
    const raw = readFileSync(FIXTURE, 'utf8');
    expect(raw).not.toContain('agentId');
  });

  it('covers every logged event type, so the migration cannot miss one', () => {
    const seen = new Set(readFixture().map((event) => event.type));
    expect(seen.size).toBe(20);
  });

  it('is still accepted in full by isLoggedEvent', () => {
    // isLoggedEvent gates what survives a reload. A v1 line it rejects is a
    // line silently dropped from a restarted room's history — an I3 violation
    // that no in-memory test would catch.
    for (const event of readFixture()) {
      expect(isLoggedEvent(event), `rejected: ${event.type}`).toBe(true);
    }
  });

  it('reconstructs to exactly the same room state as before the migration', () => {
    const room = reconstruct(readFixture());

    expect(room).not.toBeNull();
    expect(room?.roomId).toBe('room_802c12cbc2704971');
    expect(room?.cwd).toBe('/tmp/nexus-fixture/work/room_802c12cbc2704971');
    expect(room?.repoUrl).toBeNull();
    expect(room?.lastSeq).toBe(24);

    // smoke joined then left; guest joined and stayed. Presence is log-derived,
    // so this pins projectPresence's behaviour through the migration too.
    expect(room?.participants.map((p) => p.participantId).sort()).toEqual([
      'p_9f9d2a056281',
      'p_d0643c37cc4c',
    ]);
    expect(room?.participants.find((p) => p.participantId === 'p_d0643c37cc4c')?.connected).toBe(
      false,
    );

    // The token was granted to smoke, released, then granted to guest.
    expect(room?.driverId).toBe('p_9f9d2a056281');

    // req_abc123 was requested AND decided, so nothing is left open.
    expect(room?.pendingApprovalIds).toEqual([]);
  });
});

describe('the agent roster is derivable from the log alone (I3)', () => {
  it('reports exactly the primary agent for a log written before agents had ids', () => {
    // Restart recovery must be able to rebuild "which agents does this room
    // have" without a second source of truth. For every log on the production
    // volume the answer is the primary agent, and it has to stay that way.
    expect(projectAgents(readFixture())).toEqual([PRIMARY_AGENT_ID]);
  });

  it('reports every distinct agent once, primary first, for a multi-agent log', () => {
    const events = [
      ...readFixture(),
      { type: 'agent_idle', agentId: 'reviewer', seq: 25, ts: '2026-08-30T21:10:00.000Z', roomId: 'room_802c12cbc2704971' },
      { type: 'agent_idle', agentId: 'reviewer', seq: 26, ts: '2026-08-30T21:10:01.000Z', roomId: 'room_802c12cbc2704971' },
      { type: 'agent_idle', agentId: 'tester', seq: 27, ts: '2026-08-30T21:10:02.000Z', roomId: 'room_802c12cbc2704971' },
    ] as NexusEvent[];

    expect(projectAgents(events)).toEqual([PRIMARY_AGENT_ID, 'reviewer', 'tester']);
  });
});
