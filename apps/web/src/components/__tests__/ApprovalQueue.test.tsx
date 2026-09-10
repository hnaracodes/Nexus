import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalQueue,
  groupApprovalsByAgent,
  type FleetApprovalRequest,
} from '../ApprovalQueue.js';

/**
 * `expiresAt: null` is the encoding for "queued, not yet on the clock" (D3,
 * phase-12 plan) — the approval queue itself decides which requests are
 * visible, and only a visible request's timer has actually started. Building
 * fixtures with an explicit `expiresAt` on every entry, rather than letting a
 * default sneak in, keeps every test honest about which case it exercises.
 */
function visibleRequest(overrides: Partial<FleetApprovalRequest> = {}): FleetApprovalRequest {
  return {
    requestId: 'req_1',
    agentId: 'agent_a',
    agentName: 'Agent A',
    toolName: 'Bash',
    input: { command: 'rm -rf /' },
    expiresAt: 1_000_000 + 60_000,
    ...overrides,
  };
}

function queuedRequest(overrides: Partial<FleetApprovalRequest> = {}): FleetApprovalRequest {
  return {
    requestId: 'req_queued',
    agentId: 'agent_a',
    agentName: 'Agent A',
    toolName: 'Bash',
    input: { command: 'echo hi' },
    expiresAt: null,
    ...overrides,
  };
}

describe('groupApprovalsByAgent', () => {
  it('groups requests by agentId, preserving first-seen (oldest) order', () => {
    const groups = groupApprovalsByAgent([
      visibleRequest({ requestId: 'r1', agentId: 'agent_b', agentName: 'Agent B' }),
      visibleRequest({ requestId: 'r2', agentId: 'agent_a', agentName: 'Agent A' }),
      visibleRequest({ requestId: 'r3', agentId: 'agent_b', agentName: 'Agent B' }),
    ]);
    expect(groups.map((g) => g.agentId)).toEqual(['agent_b', 'agent_a']);
    expect(groups[0]?.visible.map((r) => r.requestId)).toEqual(['r1', 'r3']);
  });

  it('separates visible requests from queued ones and counts the queued', () => {
    const groups = groupApprovalsByAgent([
      visibleRequest({ requestId: 'r1' }),
      queuedRequest({ requestId: 'r2' }),
      queuedRequest({ requestId: 'r3' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.visible.map((r) => r.requestId)).toEqual(['r1']);
    expect(groups[0]?.queuedCount).toBe(2);
  });

  it('an agent with nothing visible yet still gets a group, all queued', () => {
    const groups = groupApprovalsByAgent([queuedRequest({ requestId: 'r1' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.visible).toEqual([]);
    expect(groups[0]?.queuedCount).toBe(1);
  });
});

describe('ApprovalQueue', () => {
  it('renders nothing when there are no requests', () => {
    const { container } = render(
      <ApprovalQueue requests={[]} now={1_000_000} onDecide={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the visible requests, each naming its agent', () => {
    render(
      <ApprovalQueue
        requests={[
          visibleRequest({ requestId: 'r1', agentId: 'agent_a', agentName: 'Agent A' }),
          visibleRequest({ requestId: 'r2', agentId: 'agent_b', agentName: 'Agent B' }),
        ]}
        now={1_000_000}
        onDecide={vi.fn()}
      />,
    );
    const cardA = screen.getByTestId('approval-card-r1');
    const cardB = screen.getByTestId('approval-card-r2');
    expect(within(cardA).getByText('Agent A')).toBeInTheDocument();
    expect(within(cardB).getByText('Agent B')).toBeInTheDocument();
    // Each card also still carries the underlying single-agent card's own
    // content (ApprovalPrompt is composed, not reimplemented).
    expect(within(cardA).getByRole('group', { name: /Bash/i })).toBeInTheDocument();
  });

  it('shows how many are queued behind, and does not render them as cards', () => {
    render(
      <ApprovalQueue
        requests={[
          visibleRequest({ requestId: 'r1', toolName: 'Bash' }),
          queuedRequest({ requestId: 'r2', toolName: 'QueuedToolTwo' }),
          queuedRequest({ requestId: 'r3', toolName: 'QueuedToolThree' }),
        ]}
        now={1_000_000}
        onDecide={vi.fn()}
      />,
    );
    // One visible card only.
    expect(screen.getAllByTestId(/^approval-card-/)).toHaveLength(1);
    // The two behind it are represented as a count, not as their own cards.
    expect(screen.getByText(/2 more queued/i)).toBeInTheDocument();
    expect(screen.queryByText('QueuedToolTwo')).not.toBeInTheDocument();
    expect(screen.queryByText('QueuedToolThree')).not.toBeInTheDocument();
  });

  it('approving one calls onDecide with THAT requestId and agentId, and no other', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalQueue
        requests={[
          visibleRequest({ requestId: 'r1', agentId: 'agent_a', agentName: 'Agent A' }),
          visibleRequest({ requestId: 'r2', agentId: 'agent_b', agentName: 'Agent B' }),
        ]}
        now={1_000_000}
        onDecide={onDecide}
      />,
    );
    const cardA = screen.getByTestId('approval-card-r1');
    fireEvent.click(within(cardA).getByRole('button', { name: /^approve$/i }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('r1', 'agent_a', 'allow', undefined);
  });

  it('denying one calls onDecide with that request’s own agentId', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalQueue
        requests={[visibleRequest({ requestId: 'r1', agentId: 'agent_a', agentName: 'Agent A' })]}
        now={1_000_000}
        onDecide={onDecide}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(onDecide).toHaveBeenCalledWith('r1', 'agent_a', 'deny', undefined);
  });

  it('renders two requests for the same tool from different agents as two separate decisions', () => {
    const onDecide = vi.fn();
    render(
      <ApprovalQueue
        requests={[
          visibleRequest({ requestId: 'r1', agentId: 'agent_a', agentName: 'Agent A', toolName: 'Bash' }),
          visibleRequest({ requestId: 'r2', agentId: 'agent_b', agentName: 'Agent B', toolName: 'Bash' }),
        ]}
        now={1_000_000}
        onDecide={onDecide}
      />,
    );
    // Two distinct cards, not one collapsed into the other (D4).
    expect(screen.getAllByRole('group', { name: /Bash/i })).toHaveLength(2);

    const cardB = screen.getByTestId('approval-card-r2');
    fireEvent.click(within(cardB).getByRole('button', { name: /^approve$/i }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith('r2', 'agent_b', 'allow', undefined);
  });

  it('a queued (not yet visible) request shows no countdown', () => {
    render(
      <ApprovalQueue
        requests={[queuedRequest({ requestId: 'r1', agentId: 'agent_a', agentName: 'Agent A' })]}
        now={1_000_000}
        onDecide={vi.fn()}
      />,
    );
    // No card, hence no seconds-remaining text and no decide buttons — a
    // queued request has not started its clock and must not look like it has.
    expect(screen.queryByTestId('approval-card-r1')).not.toBeInTheDocument();
    expect(screen.queryByText(/s to decide/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    // But the human still learns it exists — it's on the count, not dropped.
    expect(screen.getByText(/1 more queued/i)).toBeInTheDocument();
  });

  it('a visible request still shows its honest countdown', () => {
    render(
      <ApprovalQueue
        requests={[visibleRequest({ requestId: 'r1', expiresAt: 1_000_000 + 45_000 })]}
        now={1_000_000}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText(/45s to decide/)).toBeInTheDocument();
  });
});
