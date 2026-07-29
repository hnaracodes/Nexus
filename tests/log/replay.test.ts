// tests/log/replay.test.ts
import { describe, expect, it } from 'vitest';
import { reconstruct } from '../../src/log/replay.js';
import type { NexusEvent } from '../../src/protocol/events.js';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

const full = log(
  { type: 'room_created', cwd: '/work', repoUrl: null },
  { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
  { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
  { type: 'user_prompt', participantId: 'p_ada', displayName: 'Ada', text: 'go' },
  { type: 'permission_requested', requestId: 'req_1', toolName: 'Bash', input: {}, expiresAt: 1 },
);

describe('reconstruct', () => {
  it('rebuilds identity, sequence, roster and driver from the log alone', () => {
    const room = reconstruct(full);
    expect(room).not.toBeNull();
    expect(room?.roomId).toBe('room_a');
    expect(room?.cwd).toBe('/work');
    expect(room?.lastSeq).toBe(5);
    expect(room?.driverId).toBe('p_ada');
    expect(room?.participants).toHaveLength(1);
  });

  it('reports approvals that were never decided', () => {
    expect(reconstruct(full)?.pendingApprovalIds).toEqual(['req_1']);
  });

  it('clears an approval once decided', () => {
    const decided: NexusEvent[] = [
      ...full,
      {
        seq: 6,
        ts: '2026-07-28T00:00:05.000Z',
        roomId: 'room_a',
        type: 'permission_decided',
        requestId: 'req_1',
        toolName: 'Bash',
        decision: 'deny',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      } as NexusEvent,
    ];
    expect(reconstruct(decided)?.pendingApprovalIds).toEqual([]);
  });

  it('returns null for a log with no room_created', () => {
    expect(reconstruct(log({ type: 'agent_idle' }))).toBeNull();
  });

  it('is deterministic — the same log always yields the same state', () => {
    expect(reconstruct(full)).toEqual(reconstruct([...full]));
  });
});
