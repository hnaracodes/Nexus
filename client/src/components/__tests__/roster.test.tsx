import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Roster } from '../Roster.js';

const participants = [
  { participantId: 'p_ada', displayName: 'Ada', connected: true },
  { participantId: 'p_grace', displayName: 'Grace', connected: false },
];

describe('Roster', () => {
  it('lists everyone and marks the driver with a Crown, no emoji anywhere', () => {
    const { container } = render(
      <Roster participants={participants} driverId="p_ada" selfId="p_grace" />,
    );
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    // Crown renders as an inline SVG (lucide-react), not an emoji character.
    expect(container.querySelector('svg')).not.toBeNull();

    const emojiPattern = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    expect(emojiPattern.test(container.textContent ?? '')).toBe(false);
  });

  it('offers Request Control when someone else is driving', () => {
    const onRequestControl = vi.fn();
    render(
      <Roster
        participants={participants}
        driverId="p_ada"
        selfId="p_grace"
        onRequestControl={onRequestControl}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /request control/i }));
    expect(onRequestControl).toHaveBeenCalled();
  });

  it('offers Release Control when you are driving', () => {
    const onReleaseControl = vi.fn();
    render(
      <Roster
        participants={participants}
        driverId="p_grace"
        selfId="p_grace"
        onReleaseControl={onReleaseControl}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /release control/i }));
    expect(onReleaseControl).toHaveBeenCalled();
  });

  it('renders a display name as text, never as markup', () => {
    render(
      <Roster
        participants={[
          { participantId: 'p_x', displayName: '<img src=x onerror=1>', connected: true },
        ]}
        driverId={null}
        selfId="p_x"
      />,
    );
    expect(screen.getByText('<img src=x onerror=1>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('dims a disconnected participant and explains the grace period', () => {
    render(<Roster participants={participants} driverId={null} selfId="p_ada" />);
    const graceItem = screen.getByText('Grace').closest('li');
    expect(graceItem).not.toBeNull();
    expect(graceItem?.getAttribute('title')).toMatch(/disconnected/i);
    expect(graceItem?.getAttribute('title')).toMatch(/grace period/i);
  });

  it('offers "give control" only when self is driving and only for connected others', () => {
    render(
      <Roster
        participants={participants}
        driverId="p_ada"
        selfId="p_ada"
        onGrantControl={vi.fn()}
      />,
    );
    // Grace is disconnected, so no "give control" for her.
    expect(screen.queryByText('give control')).toBeNull();
  });

  it('shows "give control" for a connected non-self participant when self is driving', () => {
    const connectedOnly = [
      { participantId: 'p_ada', displayName: 'Ada', connected: true },
      { participantId: 'p_ben', displayName: 'Ben', connected: true },
    ];
    const onGrantControl = vi.fn();
    render(
      <Roster
        participants={connectedOnly}
        driverId="p_ada"
        selfId="p_ada"
        onGrantControl={onGrantControl}
      />,
    );
    fireEvent.click(screen.getByText('give control'));
    expect(onGrantControl).toHaveBeenCalledWith('p_ben');
  });

  it('shows a quiet Hand indicator for a pending driver request on that row', () => {
    render(
      <Roster
        participants={participants}
        driverId="p_ada"
        selfId="p_ada"
        pendingDriverRequests={[{ participantId: 'p_grace', displayName: 'Grace', seq: 5 }]}
      />,
    );
    expect(screen.getByText(/asking to drive/i)).toBeInTheDocument();
  });

  it("shows the requester's own row as waiting for control", () => {
    render(
      <Roster
        participants={participants}
        driverId="p_ada"
        selfId="p_grace"
        pendingDriverRequests={[{ participantId: 'p_grace', displayName: 'Grace', seq: 5 }]}
      />,
    );
    expect(screen.getByText(/waiting for control/i)).toBeInTheDocument();
  });
});
