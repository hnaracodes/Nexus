import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinGate, readStoredName, storeName } from '../JoinGate.js';
import { JoinToasts, deriveJoinsAfter } from '../JoinToasts.js';
import type { NexusEvent } from '@nexus/protocol/events';

const joined = (seq: number, displayName: string): NexusEvent => ({
  seq,
  ts: '2026-08-03T00:00:00.000Z',
  roomId: 'room_a',
  type: 'participant_joined',
  participantId: `p_${seq}`,
  displayName,
});

beforeEach(() => {
  localStorage.clear();
});

describe('JoinGate', () => {
  it('will not submit an empty or whitespace-only name', () => {
    const onJoin = vi.fn();
    render(<JoinGate roomLabel="room_ab" onJoin={onJoin} />);
    const submit = screen.getByRole('button', { name: /join room/i });

    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '   ' } });
    expect(submit).toBeDisabled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('trims the name before handing it over', () => {
    const onJoin = vi.fn();
    render(<JoinGate roomLabel="room_ab" onJoin={onJoin} />);
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '  Ada  ' } });
    fireEvent.click(screen.getByRole('button', { name: /join room/i }));
    expect(onJoin).toHaveBeenCalledWith('Ada');
  });

  it('states the shared-trust warning before anyone is inside the room', () => {
    render(<JoinGate roomLabel="room_ab" onJoin={vi.fn()} />);
    expect(screen.getByText(/only join rooms from people you trust/i)).toBeInTheDocument();
  });

  it('round-trips a stored name and treats a blank one as absent', () => {
    expect(readStoredName('room_a')).toBeNull();
    storeName('room_a', 'Grace');
    expect(readStoredName('room_a')).toBe('Grace');
    storeName('room_b', '   ');
    expect(readStoredName('room_b')).toBeNull();
  });

  it('keeps names per room, so one room does not name you in another', () => {
    storeName('room_a', 'Ada');
    expect(readStoredName('room_b')).toBeNull();
  });
});

describe('deriveJoinsAfter', () => {
  it('returns only joins above the high-water mark', () => {
    const events = [joined(1, 'Ada'), joined(2, 'Grace'), joined(3, 'Linus')];
    expect(deriveJoinsAfter(events, 1).map((w) => w.name)).toEqual(['Grace', 'Linus']);
  });

  it('ignores non-join events', () => {
    const events: NexusEvent[] = [
      joined(1, 'Ada'),
      { seq: 2, ts: 't', roomId: 'room_a', type: 'agent_idle' },
    ];
    expect(deriveJoinsAfter(events, 0)).toHaveLength(1);
  });
});

describe('JoinToasts', () => {
  it('celebrates nothing on the first render, however long the replayed history', () => {
    // The whole log replays on every connect. Without a high-water mark, opening
    // a room that six people have passed through fires six toasts at once — and
    // fires them again on every reconnect.
    render(<JoinToasts events={[joined(1, 'Ada'), joined(2, 'Grace')]} selfId="p_9" replaying={false} />);
    expect(screen.queryByText(/joined the room/i)).not.toBeInTheDocument();
  });

  it('waves in someone who arrives after the first render', () => {
    const { rerender } = render(<JoinToasts events={[joined(1, 'Ada')]} selfId="p_9" replaying={false} />);
    rerender(<JoinToasts events={[joined(1, 'Ada'), joined(2, 'Grace')]} selfId="p_9" replaying={false} />);
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('does not wave at you when the new arrival is you', () => {
    const { rerender } = render(<JoinToasts events={[joined(1, 'Ada')]} selfId="2" replaying={false} />);
    rerender(<JoinToasts events={[joined(1, 'Ada'), joined(2, 'Me')]} selfId="2" replaying={false} />);
    expect(screen.queryByText('Me')).not.toBeInTheDocument();
  });

  it('announces politely rather than interrupting', () => {
    const { rerender, container } = render(<JoinToasts events={[joined(1, 'Ada')]} selfId="p_9" replaying={false} />);
    rerender(<JoinToasts events={[joined(1, 'Ada'), joined(2, 'Grace')]} selfId="p_9" replaying={false} />);
    expect(container.querySelector('[aria-live]')).toHaveAttribute('aria-live', 'polite');
  });
});
