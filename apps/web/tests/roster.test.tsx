import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Roster } from '../src/components/Roster.js';

const participants = [
  { participantId: 'p_ada', displayName: 'Ada', connected: true },
  { participantId: 'p_grace', displayName: 'Grace', connected: false },
];

describe('Roster', () => {
  it('lists everyone and marks the driver', () => {
    render(<Roster participants={participants} driverId="p_ada" selfId="p_grace" />);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByTestId('driver-p_ada')).toBeInTheDocument();
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
});
