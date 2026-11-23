import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GithubRepoRef } from '@syncode/protocol/events';
import { RoomHeader, type RoomHeaderProps } from '../RoomHeader.js';

const BINDING: GithubRepoRef = {
  installationId: 150824702,
  owner: 'hnaracodes',
  repo: 'MCPHaven',
  defaultBranch: 'main',
};

function renderHeader(overrides: Partial<RoomHeaderProps> = {}) {
  const props: RoomHeaderProps = {
    roomLabel: 'room_466',
    roomLink: 'http://localhost:8099/?room=r&token=t',
    participants: [],
    driverId: null,
    selfId: null,
    agentStatus: { state: 'idle' },
    now: 0,
    github: null,
    onRequestControl: () => {},
    onReleaseControl: () => {},
    onGrantControl: () => {},
    onOpenSwitcher: () => {},
    onOpenCheatsheet: () => {},
    autoMode: null,
    onSetAutoMode: () => {},
    auxOpen: true,
    onToggleAux: () => {},
    ...overrides,
  };
  return render(<RoomHeader {...props} />);
}

describe('RoomHeader GitHub binding', () => {
  it('names the repository a publish would go to', () => {
    renderHeader({ github: BINDING });
    expect(screen.getByText('hnaracodes/MCPHaven')).toBeInTheDocument();
  });

  it('links to the repository on github.com', () => {
    renderHeader({ github: BINDING });
    const link = screen.getByRole('link', { name: /hnaracodes\/MCPHaven/ });
    expect(link).toHaveAttribute('href', 'https://github.com/hnaracodes/MCPHaven');
  });

  /**
   * The room token lives in the room URL's query string. Any outbound
   * navigation would hand it to the destination via `Referer` without this —
   * the same reason the server sets `Referrer-Policy: no-referrer`.
   */
  it('does not leak the room link to GitHub through the referrer or opener', () => {
    renderHeader({ github: BINDING });
    const link = screen.getByRole('link', { name: /hnaracodes\/MCPHaven/ });
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('shows no repository chip for a room with no GitHub binding', () => {
    renderHeader({ github: null });
    expect(screen.queryByRole('link', { name: /github/i })).toBeNull();
    expect(screen.queryByText(/\//)).toBeNull();
  });
});

describe('RoomHeader auto mode switch (phase 19a)', () => {
  it('is an accessible switch that reads off by default', () => {
    renderHeader();
    const toggle = screen.getByRole('switch', { name: /auto mode/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('reads on, and names who switched it on, while auto mode is on', () => {
    renderHeader({ autoMode: { participantId: 'p_ada', displayName: 'Ada' } });
    const toggle = screen.getByRole('switch', { name: /auto mode/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('title', expect.stringMatching(/ada/i));
  });

  it('asks for the opposite of the current state when clicked', () => {
    const onSetAutoMode = vi.fn();
    const { unmount } = renderHeader({ onSetAutoMode });
    fireEvent.click(screen.getByRole('switch', { name: /auto mode/i }));
    expect(onSetAutoMode).toHaveBeenLastCalledWith(true);
    unmount();

    renderHeader({ onSetAutoMode, autoMode: { participantId: 'p_ada', displayName: 'Ada' } });
    fireEvent.click(screen.getByRole('switch', { name: /auto mode/i }));
    expect(onSetAutoMode).toHaveBeenLastCalledWith(false);
  });
});

describe('RoomHeader agent bar toggle', () => {
  it('reopens a closed agent bar by mouse', () => {
    const onToggleAux = vi.fn();
    renderHeader({ auxOpen: false, onToggleAux });
    const button = screen.getByRole('button', { name: /agent bar/i });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onToggleAux).toHaveBeenCalledTimes(1);
  });

  it('surfaces pending approvals on the toggle only while the bar is closed', () => {
    const { unmount } = renderHeader({ auxOpen: false, pendingApprovals: 2 });
    expect(screen.getByLabelText('2 pending in Approvals')).toBeInTheDocument();
    unmount();
    renderHeader({ auxOpen: true, pendingApprovals: 2 });
    expect(screen.queryByLabelText('2 pending in Approvals')).toBeNull();
  });

  it('reflects an open bar', () => {
    renderHeader({ auxOpen: true });
    expect(screen.getByRole('button', { name: /agent bar/i })).toHaveAttribute('aria-pressed', 'true');
  });
});
