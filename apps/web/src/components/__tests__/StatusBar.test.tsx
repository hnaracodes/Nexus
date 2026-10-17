import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { StatusBar } from '../StatusBar.js';

const PARTICIPANTS = [
  { participantId: 'p_ada', displayName: 'Ada', connected: true },
  { participantId: 'p_grace', displayName: 'Grace', connected: true },
];

function renderBar(props: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  return render(
    <StatusBar
      events={[]}
      roomId="room_a"
      participants={PARTICIPANTS}
      driverId={null}
      agentCount={1}
      status="open"
      approvalCount={0}
      onOpenAgents={vi.fn()}
      onOpenApprovals={vi.fn()}
      {...props}
    />,
  );
}

describe('StatusBar', () => {
  it('names the current driver', () => {
    renderBar({ driverId: 'p_grace' });
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('says nobody is driving when the token is unclaimed', () => {
    renderBar();
    expect(screen.getByText(/no driver/i)).toBeInTheDocument();
  });

  it('shows the live agent count, and clicking it opens the Agents tab', () => {
    const onOpenAgents = vi.fn();
    renderBar({ agentCount: 3, onOpenAgents });
    fireEvent.click(screen.getByText(/3 agents/i));
    expect(onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('shows the connection status', () => {
    renderBar({ status: 'reconnecting' });
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('turns the connection item to the error colour whenever the socket is not open', () => {
    const { container, rerender } = renderBar({ status: 'open' });
    expect(container.querySelector('.bg-status-error')).toBeNull();
    rerender(
      <StatusBar
        events={[]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId={null}
        agentCount={1}
        status="closed"
        approvalCount={0}
        onOpenAgents={vi.fn()}
        onOpenApprovals={vi.fn()}
      />,
    );
    expect(container.querySelector('.bg-status-error')).not.toBeNull();
  });

  it('shows Ln/Col and the language label for the active file', () => {
    renderBar({ cursor: { line: 12, col: 5 }, language: 'TypeScript' });
    expect(screen.getByText('Ln 12, Col 5')).toBeInTheDocument();
    expect(screen.getByText('TypeScript')).toBeInTheDocument();
  });

  it('omits Ln/Col and language when no file is active', () => {
    renderBar({ cursor: null, language: null });
    expect(screen.queryByText(/Ln \d+/)).toBeNull();
    expect(screen.queryByText('TypeScript')).toBeNull();
  });

  it('the approvals item is a button that opens Approvals, alert-coloured when N > 0', () => {
    const onOpenApprovals = vi.fn();
    renderBar({ approvalCount: 2, onOpenApprovals });
    const button = screen.getByRole('button', { name: /2 pending approvals/i });
    expect(button.className).toContain('bg-status-alert');
    expect(button).toHaveTextContent('2');
    fireEvent.click(button);
    expect(onOpenApprovals).toHaveBeenCalledTimes(1);
  });

  it('with zero pending the approvals button is still there, not alert-coloured', () => {
    renderBar({ approvalCount: 0 });
    const button = screen.getByRole('button', { name: /0 pending approvals/i });
    expect(button.className).not.toContain('bg-status-alert');
  });

  it('shows the repo binding when the room is GitHub-backed', () => {
    const created = {
      type: 'room_created',
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      roomId: 'room_a',
      repoUrl: null,
      github: { owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
    } as unknown as SynCodeEvent;
    renderBar({ events: [created] });
    expect(screen.getByText('nexus/room_a')).toBeInTheDocument();
  });
});
