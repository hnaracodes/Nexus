import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, UnsequencedEvent } from '@syncode/protocol/events';
import { createApprovalQueue } from '../../src/server/approvalQueue.js';
import type { ApprovalQueue } from '../../src/server/approvalQueue.js';
import { createPermissionGate } from '../../src/server/permissions.js';
import type { RequestVisibility } from '../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';

/**
 * The exact wiring a room does in production: one queue shared by every
 * agent's gate, each gate's `visibility` bound to a fixed `agentId`. Tests
 * below use this instead of hand-rolling the seam, so a change here would
 * also flag a real integration break.
 */
function visibilityFor(queue: ApprovalQueue, agentId: AgentId): RequestVisibility {
  return {
    admit: (requestId, toolName, surface) => queue.admit(agentId, requestId, toolName, surface),
    release: (requestId) => queue.release(requestId),
  };
}

let room: Room;
let events: UnsequencedEvent[];

beforeEach(() => {
  __resetRooms();
  events = [];
  room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
});

const requested = () => events.filter((e) => e.type === 'permission_requested');
const decided = () => events.filter((e) => e.type === 'permission_decided');

describe('createApprovalQueue — ordering and capacity, standalone', () => {
  it('admits immediately while the visible set has room', async () => {
    const queue = createApprovalQueue({ capacity: 2 });
    let admittedA = false;
    let admittedB = false;
    queue.admit('a1', 'req_a', 'Bash', () => {
      admittedA = true;
    });
    queue.admit('a1', 'req_b', 'Bash', () => {
      admittedB = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(admittedA).toBe(true);
    expect(admittedB).toBe(true);
    expect(queue.visible().map((t) => t.requestId)).toEqual(['req_a', 'req_b']);
    expect(queue.queuedCount()).toBe(0);
  });

  it('queues beyond capacity and promotes exactly one ticket on release, oldest first', async () => {
    const queue = createApprovalQueue({ capacity: 1 });
    queue.admit('a1', 'req_1', 'Bash', () => {});
    let admitted2 = false;
    let admitted3 = false;
    queue.admit('a1', 'req_2', 'Bash', () => {
      admitted2 = true;
    });
    queue.admit('a1', 'req_3', 'Bash', () => {
      admitted3 = true;
    });
    await Promise.resolve();

    expect(queue.visible().map((t) => t.requestId)).toEqual(['req_1']);
    expect(queue.queuedCount()).toBe(2);
    expect(admitted2).toBe(false);
    expect(admitted3).toBe(false);

    queue.release('req_1');
    await Promise.resolve();

    // Exactly one promotion, and it is the OLDEST waiting ticket (req_2, not
    // req_3) — a "right assertion at the wrong moment" trap would pass this
    // even if promotion picked the wrong ticket, so both are checked.
    expect(admitted2).toBe(true);
    expect(admitted3).toBe(false);
    expect(queue.visible().map((t) => t.requestId)).toEqual(['req_2']);
    expect(queue.queuedCount()).toBe(1);
  });

  it('releasing a still-queued ticket removes it without promoting anything', async () => {
    const queue = createApprovalQueue({ capacity: 1 });
    queue.admit('a1', 'req_1', 'Bash', () => {});
    let admitted2 = false;
    queue.admit('a1', 'req_2', 'Bash', () => {
      admitted2 = true;
    });
    await Promise.resolve();
    expect(queue.queuedCount()).toBe(1);

    // req_2 never surfaced (e.g. its agent was interrupted while queued).
    queue.release('req_2');
    await Promise.resolve();

    expect(admitted2).toBe(false);
    expect(queue.queuedCount()).toBe(0);
    // The visible slot req_1 holds is untouched — nothing was freed, so
    // nothing should have been promoted into it.
    expect(queue.visible().map((t) => t.requestId)).toEqual(['req_1']);
  });

  it('release on an unknown request id is a safe no-op', () => {
    const queue = createApprovalQueue({ capacity: 2 });
    expect(() => queue.release('req_never_existed')).not.toThrow();
    expect(queue.visible()).toEqual([]);
    expect(queue.queuedCount()).toBe(0);
  });

  it('never drops a ticket regardless of how far over capacity the queue runs', async () => {
    const queue = createApprovalQueue({ capacity: 2 });
    const ids = Array.from({ length: 10 }, (_, i) => `req_${i}`);
    const admittedOrder: string[] = [];
    for (const id of ids) {
      queue.admit('a1', id, 'Bash', () => admittedOrder.push(id));
    }
    await Promise.resolve();
    expect(admittedOrder).toEqual(['req_0', 'req_1']);
    expect(queue.queuedCount()).toBe(8);

    // Drain by always releasing whatever is currently visible, exactly as
    // the gate would once each request settles.
    while (queue.visible().length > 0) {
      for (const ticket of queue.visible()) queue.release(ticket.requestId);
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }

    expect(admittedOrder.sort()).toEqual([...ids].sort());
    expect(queue.queuedCount()).toBe(0);
  });

  it('orders deterministically by admission-call order (the seq the plan asks for)', async () => {
    const queue = createApprovalQueue({ capacity: 5 });
    queue.admit('a1', 'req_x', 'Bash', () => {});
    queue.admit('a2', 'req_y', 'Write', () => {});
    queue.admit('a1', 'req_z', 'Bash', () => {});
    await Promise.resolve();

    const seqs = queue.visible().map((t) => t.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(queue.visible().map((t) => t.requestId)).toEqual(['req_x', 'req_y', 'req_z']);
  });

  it('rejects a nonsensical capacity rather than silently accepting one', () => {
    expect(() => createApprovalQueue({ capacity: 0 })).toThrow();
  });
});

describe('D3 — the visibility clock starts at surface time, not at creation', () => {
  it('a queued-but-not-surfaced request does not time out, even long past the full timeout', async () => {
    vi.useFakeTimers();
    try {
      const queue = createApprovalQueue({ capacity: 1 });
      // Occupy the sole visible slot directly, through the queue rather than
      // through a gate, so it carries no timer of its own and is never
      // released during this test. That isolates the property under test:
      // if this occupant were instead a gated request that timed out on its
      // own 120s clock, releasing its slot would PROMOTE the request below
      // and confound "queued never ticks" with "a visible request expired
      // and freed a slot" — two different, both-correct behaviours.
      queue.admit('occupier', 'req_occupier', 'Noop', () => {});

      const gate = createPermissionGate(room, (e) => events.push(e), {
        timeoutMs: 120_000,
        visibility: visibilityFor(queue, 'a1'),
      });

      let settled = false;
      const pending = gate.request('Bash', { command: 'rm -rf /' }).then((d) => {
        settled = true;
        return d;
      });
      await Promise.resolve();

      // Never surfaced at all — no card, and the log has no record of it.
      expect(requested()).toHaveLength(0);
      expect(queue.queuedCount()).toBe(1);
      // Yet still tracked by the gate — see the "unaffected" describe block
      // below for why that distinction matters for a fleet's pending count.
      expect(gate.pendingIds()).toHaveLength(1);

      // Advance well past the 120s timeout that would apply to a VISIBLE
      // request — 2.5x it. This is the whole point of the phase: queued
      // means off the clock entirely, however long it stays queued.
      await vi.advanceTimersByTimeAsync(300_000);

      expect(settled).toBe(false);
      expect(decided()).toHaveLength(0);
      expect(requested()).toHaveLength(0);

      // Free the slot and confirm it was merely queued, not stuck: it
      // surfaces the moment a slot opens, with its clock only starting now.
      queue.release('req_occupier');
      await Promise.resolve();
      expect(requested()).toHaveLength(1);
      expect(requested()[0]).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf /' } });
      void pending; // settled in a later test's own timeline pattern, not here
    } finally {
      vi.useRealTimers();
    }
  });

  it('a surfaced request survives just under its own timeout and denies just over it — the clock restarts at surface time, not at creation', async () => {
    vi.useFakeTimers();
    try {
      const queue = createApprovalQueue({ capacity: 1 });
      const gate = createPermissionGate(room, (e) => events.push(e), {
        timeoutMs: 120_000,
        visibility: visibilityFor(queue, 'a1'),
      });

      const first = gate.request('Bash', { command: 'first' });
      await Promise.resolve();
      const second = gate.request('Bash', { command: 'second' });
      await Promise.resolve();
      expect(requested()).toHaveLength(1); // only `first` is visible so far

      // Let a long time pass while `second` sits queued — if a future
      // regression armed its clock at CREATION instead of at surfacing, this
      // alone would already have denied it by the time it surfaces below.
      await vi.advanceTimersByTimeAsync(100_000);

      // Free the slot: `second` surfaces now, at t=100_000.
      gate.resolve(gate.pendingIds()[0] as string, {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      });
      await first;
      await Promise.resolve();

      expect(requested()).toHaveLength(2);
      expect(requested()[1]).toMatchObject({ toolName: 'Bash', input: { command: 'second' } });

      // Just under 120s since IT surfaced (total elapsed since creation is
      // already ~219s, which would already have denied it under the old,
      // creation-time clock — proving the fix, not just restating it).
      await vi.advanceTimersByTimeAsync(119_000);
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      await Promise.resolve();
      expect(secondSettled).toBe(false);

      // Now cross 120s since surfacing.
      await vi.advanceTimersByTimeAsync(2_000);
      const decision = await second;
      expect(decision.via).toBe('timeout');
      expect(decision.decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('D4 — one decision per tool use, never batched, across agents', () => {
  it('two agents asking for the same tool with the same input produce two independent decisions', async () => {
    const queue = createApprovalQueue({ capacity: 5 });
    const gateA = createPermissionGate(room, (e) => events.push(e), {
      visibility: visibilityFor(queue, 'agent_a'),
    });
    const gateB = createPermissionGate(room, (e) => events.push(e), {
      visibility: visibilityFor(queue, 'agent_b'),
    });

    const pendingA = gateA.request('Bash', { command: 'rm -rf /' });
    const pendingB = gateB.request('Bash', { command: 'rm -rf /' });
    await Promise.resolve();
    await Promise.resolve();

    expect(requested()).toHaveLength(2);
    const idA = gateA.pendingIds()[0] as string;
    const idB = gateB.pendingIds()[0] as string;
    expect(idA).not.toBe(idB);

    gateA.resolve(idA, {
      decision: 'allow',
      participantId: 'p_ada',
      displayName: 'Ada',
      via: 'first_response',
      reason: null,
    });
    gateB.resolve(idB, {
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason: 'not on my agent',
    });

    const [decisionA, decisionB] = await Promise.all([pendingA, pendingB]);
    expect(decisionA.decision).toBe('allow');
    expect(decisionB.decision).toBe('deny');
    expect(decided()).toHaveLength(2);
  });
});

describe('permissions.ts default visibility — unaffected by the D3 seam', () => {
  it('every pending request from `pendingIds()` counts a still-queued request too', async () => {
    const queue = createApprovalQueue({ capacity: 1 });
    const gate = createPermissionGate(room, (e) => events.push(e), {
      visibility: visibilityFor(queue, 'a1'),
    });
    void gate.request('Bash', { command: 'first' });
    await Promise.resolve();
    void gate.request('Bash', { command: 'second' });
    await Promise.resolve();

    // Only one is visible (one `permission_requested`), but the gate itself
    // must still know about both — this is what a fleet's per-agent pending
    // count is built from.
    expect(requested()).toHaveLength(1);
    expect(gate.pendingIds()).toHaveLength(2);
  });
});
