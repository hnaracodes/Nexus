import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

/**
 * Every component in this app is tested in isolation, but until now nothing
 * rendered the live room view through App.tsx — so every wire BETWEEN those
 * components was unverified. A mutation test on phase-3d's dismiss handler
 * survived for exactly that reason. These tests exercise the wiring itself.
 */

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    /* the component's cleanup calls this */
  }
}

/** Push a server frame at the app the way the socket would. */
function deliver(frame: unknown): void {
  act(() => {
    FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
  });
}

const identify = (participantId = 'p_self') =>
  deliver({
    kind: 'replay_complete',
    lastSeq: 0,
    protocolVersion: 1,
    participantId,
    resumeToken: 'r_self',
  });

let seq = 0;
const event = (body: Record<string, unknown>) => {
  seq += 1;
  return { kind: 'event', event: { seq, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...body } };
};

beforeEach(() => {
  seq = 0;
  FakeSocket.last = null;
  localStorage.clear();
  window.history.pushState({}, '', '/?room=room_a&token=tok&name=Ada');
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('App — the live room view', () => {
  it('connects and renders the room rather than the landing page', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    expect(FakeSocket.last?.url).toContain('room=room_a');
    expect(screen.queryByText(/open a nexus room/i)).not.toBeInTheDocument();
  });

  it('shows a server error, dismisses it, and shows it AGAIN when it repeats', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('You are not driving.')).not.toBeInTheDocument();

    // The whole point of counting rather than comparing text: a non-driver
    // hits this same message repeatedly, and it must not stay swallowed.
    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();
  });

  it('dismisses a BURST of errors with one click, not one click each', () => {
    // Dismissing one-at-a-time cannot tell `dismissed = errorCount` apart from
    // `dismissed + 1` — both land on the same number every step. Only a burst
    // separates them, and a burst is realistic: a non-driver mashing send
    // produces several errors before anyone reaches for the dismiss button.
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver({ kind: 'error', message: 'You are not driving.' });
    deliver({ kind: 'error', message: 'You are not driving.' });
    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('You are not driving.')).not.toBeInTheDocument();
  });

  it('sends an interrupt frame when anyone presses stop', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(FakeSocket.last?.sent).toContain('{"kind":"interrupt"}');
  });

  it('surfaces an interrupt someone else performed', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver(event({ type: 'interrupted', participantId: 'p_grace', displayName: 'Grace' }));
    expect(screen.getByText(/grace/i)).toBeInTheDocument();
  });

  it('renders the roster from presence frames', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify('p_ada');

    deliver({
      kind: 'presence',
      participants: [
        { participantId: 'p_ada', displayName: 'Ada', connected: true },
        { participantId: 'p_grace', displayName: 'Grace', connected: true },
      ],
      driverId: 'p_ada',
    });

    // The roster now renders twice by design — a compact avatar row in the
    // header (RoomHeader) and the full list with driver controls in the side
    // rail (SideRail) — so this asserts presence, not uniqueness.
    expect(screen.getAllByText(/ada/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/grace/i).length).toBeGreaterThan(0);
  });

  it('renders a pending approval and sends the decision', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver(
      event({
        type: 'permission_requested',
        requestId: 'req_1',
        toolName: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
        expiresAt: Date.now() + 120_000,
      }),
    );

    // The room must be able to see WHAT it is approving.
    expect(screen.getByText(/bash/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    const decision = FakeSocket.last?.sent.find((s) => s.includes('permission_decision'));
    expect(decision).toBeDefined();
    expect(decision).toContain('req_1');
    expect(decision).toContain('deny');
  });
});

describe('App — a malformed link', () => {
  it('renders a malformed-link page when the link carries no room', () => {
    // Under the phase-5a router, "/" with no room/token never reaches App —
    // Router sends it to the marketing landing page instead. App only
    // renders this branch for a room link missing at least one half.
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByText(/this room link is incomplete/i)).toBeInTheDocument();
  });
});
