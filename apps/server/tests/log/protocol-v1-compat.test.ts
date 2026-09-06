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
 * contained only two events, so the rest were HAND-AUTHORED to cover every
 * member of `LOGGED_TYPES` that existed at v1. The tidy ids (`msg_01`,
 * `req_abc123`) and the exactly-one-second spacing are the tell.
 *
 * What that means for how much this proves: it demonstrates the migration
 * survives every event SHAPE the protocol declares, which is the property worth
 * pinning. It does NOT prove the migration survives whatever is actually on the
 * production volume, because a synthesized fixture can only contain shapes its
 * author thought of. Replaying a genuine production log remains an open item.
 *
 * COVERAGE AFTER PROTOCOL v3, and why it is now split in two.
 *
 * v3 added five logged types that a v1 log cannot contain by construction —
 * fleet membership and collaborative documents did not exist. Adding them to
 * this fixture would have been the easy way to keep the set-equality test green,
 * and it would have destroyed the fixture's only real property: that it is a
 * GENUINE v1 log. The first test in this file exists to catch exactly that kind
 * of helpful edit.
 *
 * So the two guarantees, which used to ride on one fixture, are now separate:
 * this file stays v1-genuine, `V3_ONLY_EVENTS` below carries the shapes v1 could
 * never have, and the coverage test asserts their UNION equals the protocol.
 * Neither can be satisfied by weakening the other.
 */

const FIXTURE = fileURLToPath(new URL('../fixtures/protocol-v1-room.jsonl', import.meta.url));

/**
 * The v3-only logged shapes, hand-authored, in the same style as the fixture.
 *
 * These carry `agentId` where the protocol says they may, precisely because a v1
 * log never could — keeping them here rather than in the fixture is what lets
 * the "no event carries an agentId" assertion above stay meaningful.
 */
const V3_ONLY_EVENTS: NexusEvent[] = [
  {
    type: 'agent_spawned',
    agentId: 'reviewer',
    provider: 'openai',
    model: 'gpt-5.1',
    displayName: 'Reviewer',
    participantId: 'p_9f9d2a056281',
    spawnedByName: 'smoke',
    seq: 25,
    ts: '2026-09-06T12:00:00.000Z',
    roomId: 'room_802c12cbc2704971',
  },
  {
    type: 'agent_stopped',
    agentId: 'reviewer',
    reason: 'stopped',
    participantId: 'p_9f9d2a056281',
    stoppedByName: 'smoke',
    seq: 26,
    ts: '2026-09-06T12:00:01.000Z',
    roomId: 'room_802c12cbc2704971',
  },
  {
    type: 'crew_launched',
    crewId: 'crew_01',
    crewName: 'review-and-test',
    agentIds: ['reviewer', 'tester'],
    participantId: 'p_9f9d2a056281',
    displayName: 'smoke',
    seq: 27,
    ts: '2026-09-06T12:00:02.000Z',
    roomId: 'room_802c12cbc2704971',
  },
  {
    type: 'doc_snapshot',
    path: 'src/app.ts',
    snapshot: 'AAAA',
    heads: ['50b50eaa397144e9b8d9c3024c20868e86254bf0c21ab546073af2c0f49c8523'],
    seq: 28,
    ts: '2026-09-06T12:00:03.000Z',
    roomId: 'room_802c12cbc2704971',
  },
  {
    type: 'file_edited',
    path: 'src/app.ts',
    participantId: 'p_9f9d2a056281',
    displayName: 'smoke',
    bytesDelta: 42,
    seq: 29,
    ts: '2026-09-06T12:00:04.000Z',
    roomId: 'room_802c12cbc2704971',
  },
];

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
    // Set EQUALITY, not cardinality. Asserting a count was a property of the
    // fixture rather than of the protocol: it kept passing when a new type was
    // added to LOGGED_TYPES, and even passed for a fixture that omitted a real
    // type while including a bogus one. Now adding a type to the union fails
    // here until something covers it.
    const seen = [
      ...new Set([...readFixture(), ...V3_ONLY_EVENTS].map((event) => event.type)),
    ].sort();
    expect(seen).toEqual([...loggedEventTypes()].sort());
  });

  it('adds nothing to the v1 fixture that v1 could have written', () => {
    // The two halves must stay disjoint. If a v3-only shape ever appears in the
    // fixture too, the coverage test above would still pass while the fixture
    // silently stopped being a v1 log — the exact failure the split exists to
    // prevent, and one that no other assertion here would notice.
    const v1Types = new Set(readFixture().map((event) => event.type));
    for (const event of V3_ONLY_EVENTS) {
      expect(v1Types.has(event.type), `${event.type} leaked into the v1 fixture`).toBe(false);
    }
  });

  it('accepts every v3-only shape through isLoggedEvent', () => {
    // Same guarantee the fixture gets: a type declared in the union but rejected
    // here is written to disk and then silently dropped on reload (I3).
    for (const event of V3_ONLY_EVENTS) {
      expect(isLoggedEvent(event), `rejected: ${event.type}`).toBe(true);
    }
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
