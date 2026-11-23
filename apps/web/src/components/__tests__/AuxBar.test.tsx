import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentId } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import { AuxBar } from '../AuxBar.js';
import type { AuxBarProps } from '../AuxBar.js';

function Thrower(): never {
  throw new Error('chat exploded');
}

function baseProps(overrides: Partial<AuxBarProps> = {}): AuxBarProps {
  return {
    view: 'chat',
    onViewChange: vi.fn(),
    chat: <p>chat content</p>,
    fleetAgents: [],
    focusedAgentId: null,
    onFocusAgent: vi.fn(),
    onSpawnAgent: vi.fn(),
    onStopAgent: vi.fn(),
    hasFleet: false,
    fleetApprovals: [],
    singleApprovals: [],
    now: 0,
    onDecideFleet: vi.fn(),
    onDecideSingle: vi.fn(),
    ...overrides,
  };
}

describe('AuxBar', () => {
  it('renders exactly the chosen view', () => {
    const { rerender } = render(<AuxBar {...baseProps({ view: 'chat' })} />);
    expect(screen.getByText('chat content')).toBeInTheDocument();
    expect(screen.queryByText(/no pending approvals/i)).toBeNull();

    rerender(<AuxBar {...baseProps({ view: 'approvals' })} />);
    expect(screen.queryByText('chat content')).toBeNull();
    expect(screen.getByText(/no pending approvals/i)).toBeInTheDocument();
  });

  it('shows the fleet in the fleet view', () => {
    const agents: FleetEntry[] = [
      {
        agentId: 'agent_1' as AgentId,
        displayName: 'Reviewer',
        provider: 'anthropic',
        model: null,
        status: 'idle',
        pendingApprovals: 0,
        queuedPrompts: 0,
      },
    ];
    render(<AuxBar {...baseProps({ view: 'fleet', fleetAgents: agents, hasFleet: true })} />);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  it('shows single-agent approval cards when there is no fleet', () => {
    render(
      <AuxBar
        {...baseProps({
          view: 'approvals',
          singleApprovals: [{ requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, expiresAt: 60_000 }],
        })}
      />,
    );
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });
});

describe('a crashing aux view is contained to that view', () => {
  it('shows a fallback for the view that threw', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<AuxBar {...baseProps({ view: 'chat', chat: <Thrower /> })} />);
      expect(screen.getByRole('alert')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('still renders Approvals after Chat has crashed (boundary keyed by view)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { rerender } = render(<AuxBar {...baseProps({ view: 'chat', chat: <Thrower /> })} />);
      expect(screen.getByRole('alert')).toBeTruthy();

      rerender(
        <AuxBar
          {...baseProps({
            view: 'approvals',
            chat: <Thrower />,
            singleApprovals: [{ requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, expiresAt: 60_000 }],
          })}
        />,
      );
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText('Bash')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it('a crash in Approvals says nothing has been approved, not that approvals are fine', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(
        <AuxBar
          {...baseProps({
            view: 'approvals',
            // A malformed request makes the approval card throw during render.
            singleApprovals: [{ requestId: 'req_x', toolName: 'Bash', input: undefined, expiresAt: Number.NaN }] as never,
            hasFleet: true,
            fleetApprovals: null as never,
          })}
        />,
      );
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.getByText(/nothing has been approved/i)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('AuxBar header tabs (no right activity bar)', () => {
  const approval = { requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, expiresAt: 60_000 };

  it('shows Chat and Approvals tabs, selecting the current view', () => {
    render(<AuxBar {...baseProps({ view: 'approvals' })} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Chat', 'Approvals']);
    expect(screen.getByRole('tab', { name: /approvals/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'false');
  });

  it('one click on Approvals asks the shell to switch view', () => {
    const onViewChange = vi.fn();
    render(<AuxBar {...baseProps({ onViewChange })} />);
    fireEvent.click(screen.getByRole('tab', { name: /approvals/i }));
    expect(onViewChange).toHaveBeenCalledWith('approvals');
  });

  it('badges Approvals with the pending count, solo room', () => {
    render(<AuxBar {...baseProps({ singleApprovals: [approval] })} />);
    const tab = screen.getByRole('tab', { name: /approvals/i });
    expect(within(tab).getByText('1')).toBeInTheDocument();
  });

  it('no badge when nothing is pending', () => {
    render(<AuxBar {...baseProps()} />);
    const tab = screen.getByRole('tab', { name: /approvals/i });
    expect(tab.textContent).toBe('Approvals');
  });

  it('shows a Fleet tab with its count only when the room has a fleet', () => {
    const agents = [1, 2].map((n) => ({
      agentId: `agent_${n}` as AgentId, displayName: `A${n}`, provider: 'anthropic', model: null,
      status: 'idle', pendingApprovals: 0, queuedPrompts: 0,
    })) as FleetEntry[];
    const { rerender } = render(<AuxBar {...baseProps()} />);
    expect(screen.queryByRole('tab', { name: /fleet/i })).toBeNull();
    rerender(<AuxBar {...baseProps({ hasFleet: true, fleetAgents: agents })} />);
    const tab = screen.getByRole('tab', { name: /fleet/i });
    expect(within(tab).getByText('2')).toBeInTheDocument();
  });
});
