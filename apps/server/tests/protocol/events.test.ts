import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isLoggedEvent } from '@nexus/protocol/events';
import type { NexusEvent } from '@nexus/protocol/events';
import { parseClientFrame } from '@nexus/protocol/wire';

describe('protocol', () => {
  it('pins the protocol version', () => {
    // 3 since the v2 studio work: a room may hold a fleet of agents from three
    // providers, and documents several people edit at once. Still additive —
    // every field added since v1 is optional and every log on disk replays — so
    // this is a signal to future clients rather than a compatibility break.
    expect(PROTOCOL_VERSION).toBe(3);
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

  // --- phase 7 ---
  // These two cases are a regression test for the two-edit trap itself: a type
  // added to the NexusEvent union but NOT to the runtime LOGGED_TYPES set is
  // written to the JSONL happily and then silently dropped on read-back, so the
  // history exists on disk and vanishes on restart (I3). This bit phase 4.
  it('treats model_changed as a logged event', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'model_changed' })).toBe(true);
  });

  it('treats context_usage as a logged event', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'context_usage' })).toBe(true);
  });
});

describe('parseClientFrame — set_model (phase 7)', () => {
  it('parses a model id', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'set_model', model: 'claude-sonnet-5' }))).toEqual(
      { kind: 'set_model', model: 'claude-sonnet-5' },
    );
  });

  // null is the wire spelling of "use the account default". It must round-trip,
  // because `undefined` does not survive JSON.stringify — a client sending
  // undefined produces an absent key, indistinguishable from a malformed frame.
  it('parses an explicit null as "use the default model"', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'set_model', model: null }))).toEqual({
      kind: 'set_model',
      model: null,
    });
  });

  it('rejects an absent model rather than guessing', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'set_model' }))).toBeNull();
  });

  it('rejects a non-string, non-null model', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'set_model', model: 5 }))).toBeNull();
  });
});
