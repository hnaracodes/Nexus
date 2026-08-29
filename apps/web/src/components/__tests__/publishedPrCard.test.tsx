import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PublishedPrCard, type PublishedPrCardProps } from '../PublishedPr.js';
import type { PublishedPr } from '../../publishedPr.js';

const PR: PublishedPr = {
  prUrl: 'https://github.com/hnaracodes/MCPHaven/pull/42',
  prNumber: 42,
  branch: 'nexus/room_fixture',
  filesChanged: 3,
  created: true,
  seq: 5,
  approvedBy: 'p_grace',
};

function renderCard(overrides: Partial<PublishedPrCardProps> = {}) {
  const openWindow = vi.fn(() => ({}) as Window);
  const props: PublishedPrCardProps = {
    pr: PR,
    selfId: 'p_grace',
    replaying: false,
    openWindow,
    ...overrides,
  };
  const utils = render(<PublishedPrCard {...props} />);
  return { ...utils, openWindow: props.openWindow as ReturnType<typeof vi.fn> };
}

describe('PublishedPrCard', () => {
  it('renders nothing before anything has been published', () => {
    const { container } = renderCard({ pr: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('offers a link to the pull request', () => {
    renderCard();
    const link = screen.getByRole('link', { name: /pull request #42/i });
    expect(link).toHaveAttribute('href', PR.prUrl);
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  it('distinguishes an updated pull request from a newly opened one', () => {
    renderCard({ pr: { ...PR, created: false } });
    expect(screen.getByText(/updated/i)).toBeInTheDocument();
  });

  it('opens the pull request for whoever approved it', () => {
    const { openWindow } = renderCard({ selfId: 'p_grace' });
    expect(openWindow).toHaveBeenCalledWith(PR.prUrl);
  });

  it('does not open a tab on the screens of everyone else in the room', () => {
    const { openWindow } = renderCard({ selfId: 'p_ada' });
    expect(openWindow).not.toHaveBeenCalled();
  });

  /**
   * Joining a room replays its whole history. Without this guard every late
   * joiner would have a tab thrown open for a pull request published before
   * they arrived — possibly days earlier.
   */
  it('does not open a tab while replaying history', () => {
    const { openWindow } = renderCard({ replaying: true });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens the tab once, not on every re-render', () => {
    const openWindow = vi.fn(() => ({}) as Window);
    const props: PublishedPrCardProps = {
      pr: PR,
      selfId: 'p_grace',
      replaying: false,
      openWindow,
    };
    const { rerender } = render(<PublishedPrCard {...props} />);
    rerender(<PublishedPrCard {...props} />);
    rerender(<PublishedPrCard {...props} />);
    expect(openWindow).toHaveBeenCalledTimes(1);
  });

  /**
   * A popup blocker returns null. The card is the fallback, so it must still
   * be on screen — this is the whole reason auto-open is not the only path.
   */
  it('still shows the link when the popup was blocked', () => {
    renderCard({ openWindow: vi.fn(() => null) });
    expect(screen.getByRole('link', { name: /pull request #42/i })).toBeInTheDocument();
  });
});
