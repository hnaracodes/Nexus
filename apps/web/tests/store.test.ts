// client/tests/store.test.ts
import { describe, expect, it } from 'vitest';
import fixture from '../src/__fixtures__/events.json';
import { EMPTY_VIEW, project, reduce } from '../src/store.js';
import type { NexusEvent } from '@syncode/protocol/events';
import type { ServerFrame } from '@syncode/protocol/wire';

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

/**
 * External edits — a shell command, a `git checkout`, a formatter — reach the
 * client ONLY as a transient `workspace_changed` frame. Until now nothing
 * consumed it, so the pane silently showed stale content after any change the
 * agent did not make. Agent edits refresh through logged events, which is why
 * this survived phase 7 unnoticed.
 *
 * The state lands in RoomView beside `pendingDeltas`, `lastError` and
 * `errorCount` — all three are already transient, unlogged and unreplayed, so
 * this follows an established shape rather than inventing one.
 */
describe('workspace_changed', () => {
  const changed = (paths: string[]) =>
    ({ kind: 'workspace_changed', paths, truncated: false }) as ServerFrame;

  it('records the paths the watcher reported', () => {
    const view = reduce(EMPTY_VIEW, changed(['src/a.ts', 'README.md']));
    expect(view.externalChanges.paths).toEqual(['src/a.ts', 'README.md']);
  });

  it('advances a nonce on every frame, even when the same path changes again', () => {
    // The nonce is the point. A file edited repeatedly by a formatter reports
    // the identical path list each time, and comparing paths alone would treat
    // every change after the first as "nothing happened" — the same reasoning
    // `errorCount` already exists for.
    const once = reduce(EMPTY_VIEW, changed(['src/a.ts']));
    const twice = reduce(once, changed(['src/a.ts']));

    expect(twice.externalChanges.nonce).toBeGreaterThan(once.externalChanges.nonce);
    expect(once.externalChanges.nonce).toBeGreaterThan(EMPTY_VIEW.externalChanges.nonce);
  });

  it('leaves the logged view untouched — it is transient, not an event', () => {
    // No seq, so it must not move lastSeq or append to `events`; a replay must
    // not be able to reproduce it.
    const view = reduce(EMPTY_VIEW, changed(['src/a.ts']));
    expect(view.lastSeq).toBe(EMPTY_VIEW.lastSeq);
    expect(view.events).toEqual([]);
  });
});
