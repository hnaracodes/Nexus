import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RoomSwitcher } from '../RoomSwitcher.js';
import type { RecentRoom } from '../../rooms.js';

const rooms: RecentRoom[] = [
  { roomId: 'room_a', token: 't_a', displayName: 'Ada', label: 'nexus', lastSeenAt: 3_000 },
  { roomId: 'room_b', token: 't_b', displayName: 'Bob', label: 'other-repo', lastSeenAt: 2_000 },
  { roomId: 'room_c', token: 't_c', displayName: 'Cy', label: 'third-repo', lastSeenAt: 1_000 },
];

function setup(overrides: Partial<{
  rooms: RecentRoom[];
  currentRoomId: string | null;
}> = {}) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const onForget = vi.fn();
  const onForgetAll = vi.fn();
  render(
    <RoomSwitcher
      open
      onClose={onClose}
      rooms={overrides.rooms ?? rooms}
      currentRoomId={overrides.currentRoomId ?? 'room_a'}
      onNavigate={onNavigate}
      onForget={onForget}
      onForgetAll={onForgetAll}
    />,
  );
  return { onClose, onNavigate, onForget, onForgetAll };
}

describe('RoomSwitcher', () => {
  it('does not offer the current room as a navigation target', () => {
    setup();
    expect(screen.queryByRole('option', { name: /nexus/i })).toBeNull();
    expect(screen.getByRole('option', { name: /other-repo/i })).toBeInTheDocument();
  });

  it('filters as you type', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/filter rooms/i), { target: { value: 'third' } });
    expect(screen.queryByRole('option', { name: /other-repo/i })).toBeNull();
    expect(screen.getByRole('option', { name: /third-repo/i })).toBeInTheDocument();
  });

  it('moves the highlight with arrow keys and wraps around', () => {
    setup();
    const dialog = screen.getByRole('dialog');
    // Starts on the first result (other-repo); Up wraps to the last item (New room).
    fireEvent.keyDown(dialog, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /new room/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('navigates to the highlighted room on Enter', () => {
    const { onNavigate, onClose } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledWith(rooms[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const { onClose } = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the trigger element after closing', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <RoomSwitcher
        open
        onClose={vi.fn()}
        rooms={rooms}
        currentRoomId="room_a"
        onNavigate={vi.fn()}
        onForget={vi.fn()}
        onForgetAll={vi.fn()}
      />,
    );
    rerender(
      <RoomSwitcher
        open={false}
        onClose={vi.fn()}
        rooms={rooms}
        currentRoomId="room_a"
        onNavigate={vi.fn()}
        onForget={vi.fn()}
        onForgetAll={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('links "New room" to /new with the shortcut hint visible', () => {
    setup();
    const newRoom = screen.getByRole('option', { name: /new room/i });
    expect(newRoom).toHaveAttribute('href', '/new');
  });

  it('shows the local-storage warning footer', () => {
    setup();
    expect(
      screen.getByText(/stored on this device only\. anyone using this browser can open these rooms\./i),
    ).toBeInTheDocument();
  });

  it('forgets a single room without triggering navigation', () => {
    const { onForget, onNavigate } = setup();
    fireEvent.click(screen.getByRole('button', { name: /forget other-repo/i }));
    expect(onForget).toHaveBeenCalledWith('room_b');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('forgets all rooms via the footer control', () => {
    const { onForgetAll } = setup();
    fireEvent.click(screen.getByRole('button', { name: /^forget all$/i }));
    expect(onForgetAll).toHaveBeenCalledTimes(1);
  });

  it('hides the forget-all control when there is no history to forget', () => {
    setup({ rooms: [] });
    expect(screen.queryByRole('button', { name: /^forget all$/i })).toBeNull();
  });
});
