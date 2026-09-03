import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { GithubRepoRef } from '@nexus/protocol/events';
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
