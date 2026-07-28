import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isLoggedEvent } from '../../src/protocol/events.js';
import type { NexusEvent } from '../../src/protocol/events.js';

describe('protocol', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a well-formed envelope as a logged event', () => {
    const event: NexusEvent = {
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: 'room_abc',
      type: 'participant_joined',
      participantId: 'p_1',
      displayName: 'Ada',
    };
    expect(isLoggedEvent(event)).toBe(true);
  });

  it('rejects a frame with no seq as a logged event', () => {
    expect(isLoggedEvent({ type: 'assistant_delta', text: 'hi' })).toBe(false);
  });

  it('rejects seq below 1 — sequence numbers start at 1', () => {
    expect(isLoggedEvent({ seq: 0, ts: 'x', roomId: 'r', type: 'room_created' })).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'not_a_real_type' })).toBe(false);
  });
});
