import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { PRIMARY_AGENT_ID, isLoggedEvent, loggedEventTypes } from '@nexus/protocol/events';
import { projectAgents, reconstruct } from '../../src/log/replay.js';

/**
 * The safety net for the phase-8b `agentId` migration.
 *
 * These are CHARACTERIZATION tests, not TDD tests: they pass the moment they are
 * written, because their job is to pin down behaviour that already works so the
 * migration cannot change it silently. The TDD tests for the new behaviour live
 * in `agent-id.test.ts`.
 *
 * ABOUT THE FIXTURE, stated precisely because an earlier version of this comment
 * overstated it and a reviewer was right to call that out.
 *
 * It is SEEDED from a real protocol-v1 log — a room was created against a
 * running server before any v2 protocol change existed, and its room id, cwd,
 * participant id and timestamp format come from that capture. But that real log
 * contained only two events, so the remaining 22 were HAND-AUTHORED to cover all
 * 20 members of `LOGGED_TYPES`. The tidy ids (`msg_01`, `req_abc123`) and the
 * exactly-one-second spacing are the tell.
 *
 * What that means for how much this proves: it demonstrates the migration
 * survives every event SHAPE the protocol declares, which is the property worth
 * pinning. It does NOT prove the migration survives whatever is actually on the
 * production volume, because a synthesized fixture can only contain shapes its
 * author thought of. Replaying a genuine production log remains an open item.
 *
 * What it does prove rests on the union being exhaustively covered — hence the
 * set-equality test below, which fails if a 21st event type is ever added.
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
    // Set EQUALITY, not cardinality. Asserting `size === 20` was a property of
    // the fixture rather than of the protocol: it kept passing if a 21st type
    // were added to LOGGED_TYPES, and even passed for a fixture that omitted a
    // real type while including a bogus one. Now adding a type to the union
    // fails here until the fixture covers it.
    const seen = [...new Set(readFixture().map((event) => event.type))].sort();
    expect(seen).toEqual([...loggedEventTypes()].sort());
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
