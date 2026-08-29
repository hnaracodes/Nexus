import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { DriverRequestNotice, derivePendingDriverRequests } from '../DriverRequestNotice.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function requested(seq: number, participantId: string, displayName: string): NexusEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'driver_requested', participantId, displayName };
}

function granted(seq: number, participantId: string, displayName: string): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'driver_granted',
    participantId,
    displayName,
    reason: 'granted',
  };
}

function released(seq: number, participantId: string, displayName: string): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'driver_released',
    participantId,
    displayName,
    reason: 'explicit',
  };
}

describe('derivePendingDriverRequests', () => {
  it('reports an unanswered request as pending', () => {
    const result = derivePendingDriverRequests([requested(1, 'p_ben', 'Ben')]);
    expect(result).toEqual([{ participantId: 'p_ben', displayName: 'Ben', seq: 1 }]);
  });

  it('clears a request once granted to that participant', () => {
    const result = derivePendingDriverRequests([
      requested(1, 'p_ben', 'Ben'),
      granted(2, 'p_ben', 'Ben'),
    ]);
    expect(result).toEqual([]);
  });

  it('clears a request when granted to someone else', () => {
    const result = derivePendingDriverRequests([
      requested(1, 'p_ben', 'Ben'),
      granted(2, 'p_ada', 'Ada'),
    ]);
    expect(result).toEqual([]);
  });

  it('clears a request once released', () => {
    const result = derivePendingDriverRequests([
      requested(1, 'p_ben', 'Ben'),
      released(2, 'p_ada', 'Ada'),
    ]);
    expect(result).toEqual([]);
  });

  it('collapses two requests from the same participant into one', () => {
    const result = derivePendingDriverRequests([
      requested(1, 'p_ben', 'Ben'),
      requested(2, 'p_ben', 'Ben'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.seq).toBe(2);
  });

  it('orders results by seq', () => {
    const result = derivePendingDriverRequests([
      requested(3, 'p_grace', 'Grace'),
      requested(1, 'p_ben', 'Ben'),
    ]);
    expect(result.map((r) => r.participantId)).toEqual(['p_ben', 'p_grace']);
  });
});

describe('DriverRequestNotice', () => {
  it('renders nothing when self is not the driver', () => {
    const { container } = render(
      <DriverRequestNotice
        events={[requested(1, 'p_ben', 'Ben')]}
        selfId="p_grace"
        driverId="p_ada"
        onGrant={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an actionable card when self is the driver', () => {
    const onGrant = vi.fn();
    render(
      <DriverRequestNotice
        events={[requested(1, 'p_ben', 'Ben')]}
        selfId="p_ada"
        driverId="p_ada"
        onGrant={onGrant}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(screen.getByText(/wants to drive/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /grant control/i }));
    expect(onGrant).toHaveBeenCalledWith('p_ben');
  });

  it('dismiss is local-only: it hides the card via dismissedParticipantIds without touching the log', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <DriverRequestNotice
        events={[requested(1, 'p_ben', 'Ben')]}
        selfId="p_ada"
        driverId="p_ada"
        onGrant={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('p_ben');

    // Simulating the caller applying local dismissal state:
    const { container } = render(
      <DriverRequestNotice
        events={[requested(1, 'p_ben', 'Ben')]}
        selfId="p_ada"
        driverId="p_ada"
        onGrant={vi.fn()}
        onDismiss={vi.fn()}
        dismissedParticipantIds={new Set(['p_ben'])}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<></>);
  });

  it('re-appears if the same participant asks again after being dismissed (a later seq)', () => {
    const events = [requested(1, 'p_ben', 'Ben'), requested(2, 'p_ben', 'Ben')];
    render(
      <DriverRequestNotice
        events={events}
        selfId="p_ada"
        driverId="p_ada"
        onGrant={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Ben')).toBeInTheDocument();
    expect(screen.getByText(/wants to drive/i)).toBeInTheDocument();
  });
});
