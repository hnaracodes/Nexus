import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
import { parseClientFrame } from '@syncode/protocol/wire';

/**
 * Phase 8b. The protocol learns to say WHICH agent did a thing, without
 * breaking the logs that predate the question.
 */

describe('agentIdOf', () => {
  it('reports the primary agent for an event written before agentId existed', () => {
    // Exactly the shape sitting in every production log today.
    const v1Event = {
      type: 'assistant_message',
      messageId: 'msg_01',
      text: 'hello',
      seq: 8,
      ts: '2026-08-30T21:09:25.759Z',
      roomId: 'room_802c12cbc2704971',
    } as AssistantMessage;

    expect(agentIdOf(v1Event)).toBe(PRIMARY_AGENT_ID);
  });
});

describe('parseClientFrame with agentId', () => {
  it('carries a prompt frame agentId through instead of dropping it', () => {
    const frame = parseClientFrame(
      JSON.stringify({ kind: 'prompt', text: 'run the tests', agentId: 'reviewer' }),
    );

    expect(frame).toEqual({ kind: 'prompt', text: 'run the tests', agentId: 'reviewer' });
  });

  it('rejects a prompt frame whose agentId is not a string, rather than coercing it', () => {
    // Routing a prompt to the wrong agent because a malformed id got coerced is
    // a steering failure, so the whole frame is refused — the same stance
    // `set_model` already takes on a malformed model.
    expect(parseClientFrame(JSON.stringify({ kind: 'prompt', text: 'hi', agentId: 7 }))).toBeNull();
  });

  it('still accepts a prompt frame with no agentId, which every v1 client sends', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'prompt', text: 'hi' }))).toEqual({
      kind: 'prompt',
      text: 'hi',
    });
  });

  it('carries agentId on a permission_decision, so a vote reaches the right gate', () => {
    const frame = parseClientFrame(
      JSON.stringify({
        kind: 'permission_decision',
        requestId: 'req_abc123',
        decision: 'deny',
        agentId: 'reviewer',
      }),
    );

    expect(frame).toEqual({
      kind: 'permission_decision',
      requestId: 'req_abc123',
      decision: 'deny',
      agentId: 'reviewer',
    });
  });
});
