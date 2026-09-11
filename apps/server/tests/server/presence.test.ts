import { beforeEach, describe, expect, it } from 'vitest';
import { presenceFrame, projectPresence } from '../../src/server/presence.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { SynCodeEvent } from '@syncode/protocol/events';

beforeEach(() => __resetRooms());

const room = () =>
  createRoom({ apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key', cwd: '/tmp', repoUrl: null });

function log(...partials: Record<string, unknown>[]): SynCodeEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as SynCodeEvent,
  );
}

describe('presenceFrame', () => {
  it('snapshots the current roster and driver', () => {
    const r = room();
    r.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    r.participants.set('p_grace', { id: 'p_grace', displayName: 'Grace', connected: false });
    r.driverId = 'p_ada';

    const frame = presenceFrame(r) as {
      kind: string;
      participants: { displayName: string; connected: boolean }[];
      driverId: string | null;
    };
    expect(frame.kind).toBe('presence');
    expect(frame.driverId).toBe('p_ada');
    expect(frame.participants).toHaveLength(2);
    expect(frame.participants.find((p) => p.displayName === 'Grace')?.connected).toBe(false);
  });

  it('never leaks the room token or an API key (I4)', () => {
    const r = room();
    r.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    const serialized = JSON.stringify(presenceFrame(r));
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain(r.token);
  });
});

describe('projectPresence', () => {
  it('rebuilds the roster from the log alone (I3)', () => {
    const result = projectPresence(
      log(
        { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
        { type: 'participant_joined', participantId: 'p_grace', displayName: 'Grace' },
        { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
        { type: 'participant_left', participantId: 'p_grace', displayName: 'Grace' },
      ),
    );
    expect(result.driverId).toBe('p_ada');
    expect(result.participants.find((p) => p.participantId === 'p_ada')?.connected).toBe(true);
    expect(result.participants.find((p) => p.participantId === 'p_grace')?.connected).toBe(false);
  });

  it('clears the driver on release', () => {
    const result = projectPresence(
      log(
        { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
        { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
        {
          type: 'driver_released',
          participantId: 'p_ada',
          displayName: 'Ada',
          reason: 'disconnect',
        },
      ),
    );
    expect(result.driverId).toBeNull();
  });
});
