import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { JoinToasts } from '../JoinToasts.js';

/**
 * Replay must never be celebrated.
 *
 * JoinToasts already carried a guard for this, and its own comment describes
 * the failure exactly: "a burst of six toasts the moment you open a room that
 * has had six people through it." The guard adopted the whole history as
 * already-seen on its FIRST effect pass — which is correct only if the replay
 * has fully landed by then.
 *
 * It has not. Events arrive one socket frame at a time and `view.events` grows
 * across many renders, so the first effect sees a nearly-empty list, adopts
 * that as the high-water mark, and then greets every remaining replayed event
 * as a new arrival. Opening a room with a long history buried the entire UI
 * under a column of toasts.
 *
 * The real boundary is `view.replaying`, which the reducer flips to false on
 * `replay_complete` — the one frame that means "you now have the history".
 */

let seq = 0;
const joined = (displayName: string): NexusEvent =>
  ({
    seq: (seq += 1),
    type: 'participant_joined',
    participantId: `p_${displayName}`,
    displayName,
    ts: 0,
  }) as unknown as NexusEvent;

describe('JoinToasts', () => {
  it('greets nobody for a history that arrives in pieces while still replaying', () => {
    seq = 0;
    const history = [joined('Ada'), joined('Grace'), joined('Alan')];

    // The socket delivers replay incrementally: one event, then the rest —
    // all of it still `replaying`, because `replay_complete` has not arrived.
    const { rerender } = render(<JoinToasts events={history.slice(0, 1)} selfId={null} replaying />);
    rerender(<JoinToasts events={history} selfId={null} replaying />);
    // …and now it lands.
    rerender(<JoinToasts events={history} selfId={null} replaying={false} />);

    expect(screen.queryByText(/joined the room/)).toBeNull();
  });

  it('still greets someone who arrives after replay finished', () => {
    seq = 0;
    const history = [joined('Ada')];
    const { rerender } = render(<JoinToasts events={history} selfId={null} replaying />);
    rerender(<JoinToasts events={history} selfId={null} replaying={false} />);

    rerender(<JoinToasts events={[...history, joined('Grace')]} selfId={null} replaying={false} />);

    expect(screen.getByText('Grace')).toBeTruthy();
  });
});
