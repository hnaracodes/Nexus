import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    shareLink: { url: 'https://a.example/?room=r&token=t', scope: 'public' },
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

describe('RoomHeader share link (phase 20)', () => {
  const writeText = vi.fn(async (_text: string) => {});
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function copy(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^copy/i }));
    });
  }

  it('copies exactly the link it was given', async () => {
    renderHeader({ shareLink: { url: 'https://r.example/?room=r&token=t', scope: 'web' } });
    await copy();
    expect(writeText).toHaveBeenCalledWith('https://r.example/?room=r&token=t');
    expect(writeText.mock.calls[0]![0]).not.toContain('name=');
  });

  it('says what each link reaches', () => {
    const { unmount } = renderHeader({ shareLink: { url: 'u', scope: 'web' } });
    expect(screen.getByRole('button', { name: /anyone with it can join from anywhere/ })).toBeInTheDocument();
    unmount();
    const lan = renderHeader({ shareLink: { url: 'u', scope: 'lan' } });
    expect(screen.getByRole('button', { name: /from your local network/ })).toBeInTheDocument();
    lan.unmount();
    renderHeader({ shareLink: { url: 'u', scope: 'local' } });
    expect(screen.getByTitle(/only on this computer.*Share on the Web/)).toBeInTheDocument();
  });

  it('shows the Shared on the web indicator only for a web link', () => {
    for (const scope of ['lan', 'local', 'public'] as const) {
      const r = renderHeader({ shareLink: { url: 'u', scope } });
      expect(screen.queryByText('Shared on the web')).toBeNull();
      r.unmount();
    }
    renderHeader({ shareLink: { url: 'u', scope: 'web' } });
    expect(screen.getByText('Shared on the web')).toBeInTheDocument();
    expect(screen.getByTitle(/anyone with the link can join.*Room menu/)).toBeInTheDocument();
  });

  it('shows the only-on-this-computer notice after copying in local scope, and then it goes away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    renderHeader({ shareLink: { url: 'http://127.0.0.1:1/?room=r&token=t', scope: 'local' } });
    expect(screen.queryByText(/only works on this computer/)).toBeNull();
    await copy();
    expect(screen.getByText(/only works on this computer.*Share on the Web/)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(9000);
    });
    expect(screen.queryByText(/only works on this computer/)).toBeNull();
  });

  it.each(['web', 'lan', 'public'] as const)('shows no local notice after copying in %s scope', async (scope) => {
    renderHeader({ shareLink: { url: 'u', scope } });
    await copy();
    expect(writeText).toHaveBeenCalled();
    expect(screen.queryByText(/only works on this computer/)).toBeNull();
  });
});
