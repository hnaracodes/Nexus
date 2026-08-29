// client/tests/store.test.ts
import { describe, expect, it } from 'vitest';
import fixture from '../src/__fixtures__/events.json';
import { EMPTY_VIEW, project, reduce } from '../src/store.js';
import type { NexusEvent } from '@nexus/protocol/events';
import type { ServerFrame } from '@nexus/protocol/wire';

const events = fixture as unknown as NexusEvent[];
const frames: ServerFrame[] = events.map((event) => ({ kind: 'event', event }));

describe('reduce', () => {
  it('projects the fixture into an ordered message list', () => {
    const view = project(frames);
    expect(view.messages.map((m) => m.kind)).toEqual([
      'system',
      'system',
      'system',
      'user',
      'tool',
      'assistant',
      'system',
      'system',
    ]);
    expect(view.lastSeq).toBe(9);
  });

  it('attributes the user prompt to its sender', () => {
    const message = project(frames).messages.find((m) => m.kind === 'user');
    expect(message?.author).toBe('Ada');
    expect(message?.text).toBe('list the files');
  });

  it('folds tool_result into the tool_start message rather than adding a row', () => {
    const tools = project(frames).messages.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.text).toContain('src/index.ts');
  });

  it('tracks presence — Grace joined then left', () => {
    const view = project(frames);
    expect(view.participants.find((p) => p.displayName === 'Ada')?.connected).toBe(true);
    expect(view.participants.find((p) => p.displayName === 'Grace')?.connected).toBe(false);
  });

  it('renders a delta and its completed message as one message, not two', () => {
    let view = EMPTY_VIEW;
    view = reduce(view, { kind: 'assistant_delta', messageId: 'msg_9', text: 'Hel' });
    view = reduce(view, { kind: 'assistant_delta', messageId: 'msg_9', text: 'lo' });
    expect(view.pendingDeltas['msg_9']).toBe('Hello');
    expect(view.messages).toHaveLength(0);

    view = reduce(view, {
      kind: 'event',
      event: {
        seq: 1,
        ts: '2026-07-28T00:00:09.000Z',
        roomId: 'room_fixture',
        type: 'assistant_message',
        messageId: 'msg_9',
        text: 'Hello there',
      } as NexusEvent,
    });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.text).toBe('Hello there');
    expect(view.pendingDeltas['msg_9']).toBeUndefined();
  });

  it('is idempotent — replaying an already-seen seq changes nothing', () => {
    const once = project(frames);
    const twice = project([...frames, ...frames]);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.lastSeq).toBe(once.lastSeq);
  });

  it('clears the replaying flag on replay_complete', () => {
    const view = project([
      ...frames,
      {
        kind: 'replay_complete',
        lastSeq: 9,
        protocolVersion: 1,
        participantId: 'p_self',
        resumeToken: 'r_self',
      },
    ]);
    expect(view.replaying).toBe(false);
  });

  it('learns its own participant id from replay_complete', () => {
    expect(EMPTY_VIEW.selfId).toBeNull();
    const view = project([
      ...frames,
      {
        kind: 'replay_complete',
        lastSeq: 9,
        protocolVersion: 1,
        participantId: 'p_self',
        resumeToken: 'r_self',
      },
    ]);
    // Without this the UI cannot tell "you are driving" from "someone else is".
    expect(view.selfId).toBe('p_self');
  });

  it('adopts a fresh participant id after a reconnect', () => {
    const view = project([
      {
        kind: 'replay_complete',
        lastSeq: 0,
        protocolVersion: 1,
        participantId: 'p_first',
        resumeToken: 'r_first',
      },
      {
        kind: 'replay_complete',
        lastSeq: 0,
        protocolVersion: 1,
        participantId: 'p_second',
        resumeToken: 'r_second',
      },
    ]);
    expect(view.selfId).toBe('p_second');
  });

  it('retains every raw event in order for log-derived features', () => {
    const view = project(frames);
    expect(view.events.map((e) => e.seq)).toEqual(
      frames.filter((f) => f.kind === 'event').map((f) => (f as { event: NexusEvent }).event.seq),
    );
  });

  it('does not retain a duplicate raw event on replay (I3 idempotence)', () => {
    const once = project(frames);
    const twice = project([...frames, ...frames]);
    expect(twice.events).toEqual(once.events);
  });
});

describe('transient error frames', () => {
  it('surfaces the message instead of discarding it', () => {
    const view = project([{ kind: 'error', message: 'You are not driving.' }]);
    expect(view.lastError).toBe('You are not driving.');
    expect(view.errorCount).toBe(1);
  });

  it('counts repeats, so a dismissed banner can come back', () => {
    // "You are not driving" is the most common error in the product, and a
    // non-driver hits it repeatedly. Comparing message text alone would
    // swallow every repeat after the first dismissal.
    const view = project([
      { kind: 'error', message: 'You are not driving.' },
      { kind: 'error', message: 'You are not driving.' },
    ]);
    expect(view.errorCount).toBe(2);
  });

  it('is not a logged event — it never enters the replayable event list', () => {
    const view = project([{ kind: 'error', message: 'nope' }]);
    expect(view.events).toHaveLength(0);
    expect(view.lastSeq).toBe(0);
  });
});
