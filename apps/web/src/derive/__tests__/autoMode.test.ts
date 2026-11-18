import { describe, expect, it } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { deriveAutoMode } from '../autoMode.js';

const base = { ts: '2026-11-18T00:00:00.000Z', roomId: 'room_x' };

function changed(seq: number, enabled: boolean, displayName: string | null, reason: 'participant' | 'server_restart' = 'participant'): SynCodeEvent {
  return {
    ...base,
    seq,
    type: 'auto_mode_changed',
    enabled,
    participantId: displayName === null ? null : `p_${displayName.toLowerCase()}`,
    displayName,
    reason,
  };
}

describe('deriveAutoMode', () => {
  it('is off for a room that never touched it', () => {
    expect(deriveAutoMode([])).toBeNull();
  });

  it('names whoever switched it on most recently', () => {
    expect(deriveAutoMode([changed(1, true, 'Ada')])).toEqual({ participantId: 'p_ada', displayName: 'Ada' });
  });

  it('the last change wins, including a restart switching it off', () => {
    expect(deriveAutoMode([changed(1, true, 'Ada'), changed(2, false, 'Bob')])).toBeNull();
    expect(deriveAutoMode([changed(1, true, 'Ada'), changed(2, false, null, 'server_restart')])).toBeNull();
    expect(deriveAutoMode([changed(1, true, 'Ada'), changed(2, false, 'Ada'), changed(3, true, 'Bob')])).toEqual({
      participantId: 'p_bob',
      displayName: 'Bob',
    });
  });
});
